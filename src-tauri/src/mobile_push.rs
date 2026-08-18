//! End-to-end encrypted delivery of agent completions to Duckweed Companion.
//!
//! Firebase and the relay only receive opaque AES-GCM envelopes. Pairing puts
//! the encryption secret on the phone through the QR code and keeps desktop
//! credentials in the operating-system credential store.

use std::error::Error as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DEFAULT_RELAY_URL: &str = "https://duckweed-notification-relay.idealmusic18.workers.dev";
const KEYRING_SERVICE: &str = "dev.slop.duckweed.mobile";
const PAIRING_LIFETIME_MS: i64 = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES: usize = 180_000;
const MAX_PREVIEW_CIPHERTEXT: usize = 3_000;
// Keep the plaintext below the relay's 320,000-character base64url ciphertext
// limit, with room for AES-GCM overhead and the JSON request envelope.
const MAX_WORKSPACE_PLAINTEXT_BYTES: usize = 225_000;

static FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDevice {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub id: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    #[serde(default)]
    devices: Vec<MobileDevice>,
    pending: Option<PendingPairing>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileStatus {
    pub relay_url: String,
    pub devices: Vec<MobileDevice>,
    pub pending: Option<PendingPairing>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStart {
    pub id: String,
    pub qr_payload: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSecret {
    master_key: String,
    send_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QrPayload<'a> {
    version: u8,
    relay_url: &'a str,
    pair_id: &'a str,
    registration_token: &'a str,
    secret: &'a str,
    expires_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatePairing<'a> {
    pair_id: &'a str,
    registration_token_hash: &'a str,
    send_token_hash: &'a str,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDevice {
    id: String,
    name: String,
    proof: String,
    paired_at: i64,
}

#[derive(Debug, Deserialize)]
struct PairingPoll {
    device: Option<RemoteDevice>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionMessage {
    pub agent: String,
    pub project: String,
    pub project_id: Option<String>,
    pub terminal_id: Option<String>,
    pub terminal_title: Option<String>,
    pub kind: String,
    pub response: Option<String>,
    pub duration_ms: Option<u64>,
    pub sound_cue: Option<u8>,
    pub unread_on_desktop: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainMessage<'a> {
    version: u8,
    id: &'a str,
    sent_at: i64,
    agent: &'a str,
    project: &'a str,
    project_id: Option<&'a str>,
    terminal_id: Option<&'a str>,
    terminal_title: Option<&'a str>,
    kind: &'a str,
    response: Option<&'a str>,
    duration_ms: Option<u64>,
    sound_cue: Option<u8>,
    unread_on_desktop: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTerminal {
    pub id: String,
    pub title: String,
    pub shell: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub status: String,
    #[serde(default = "default_terminal_mode")]
    pub mode: String,
    #[serde(default)]
    pub terminal_columns: Option<u16>,
    #[serde(default)]
    pub terminal_rows: Option<u16>,
    #[serde(default)]
    pub unread_on_desktop: bool,
    #[serde(default)]
    pub commands: Vec<WorkspaceSlashCommand>,
    #[serde(default)]
    pub activity: Vec<WorkspaceAgentActivity>,
    #[serde(default)]
    pub conversation: Vec<WorkspaceConversationMessage>,
    pub permission: Option<WorkspacePermission>,
    #[serde(default)]
    pub terminal_output: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSlashCommand {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAgentActivity {
    pub id: String,
    pub at: i64,
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    pub status: String,
}

fn default_terminal_mode() -> String {
    "terminal".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePermissionOption {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePermission {
    pub id: String,
    pub title: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub options: Vec<WorkspacePermissionOption>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConversationMessage {
    pub id: String,
    pub sent_at: i64,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub streaming: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    pub terminals: Vec<WorkspaceTerminal>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub projects: Vec<WorkspaceProject>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainWorkspace<'a> {
    version: u8,
    id: &'a str,
    sent_at: i64,
    kind: &'static str,
    projects: &'a [WorkspaceProject],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainPresence<'a> {
    version: u8,
    id: &'a str,
    sent_at: i64,
    pair_id: &'a str,
    kind: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlainRemoteCommand {
    version: u8,
    id: String,
    kind: String,
    #[serde(default)]
    terminal_id: Option<String>,
    project_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    permission_id: Option<String>,
    #[serde(default)]
    option_id: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    images: Vec<RemoteImageAttachment>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImageAttachment {
    id: String,
    name: String,
    mime_type: String,
    data_url: String,
    size: usize,
}

impl RemoteImageAttachment {
    fn is_valid(&self) -> bool {
        matches!(
            self.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) && self
            .data_url
            .starts_with(&format!("data:{};base64,", self.mime_type))
            && self.data_url.len() <= 180_000
            && self.size <= 115 * 1024
            && !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
    }
}

impl PlainRemoteCommand {
    fn is_valid(&self) -> bool {
        match self.kind.as_str() {
            "refresh" => true,
            "create_terminal" => self
                .project_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            "close_terminal" => self
                .terminal_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            "input" => {
                self.terminal_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                    && (self
                        .text
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
                        || !self.images.is_empty())
                    && self.images.len() <= 1
                    && self.images.iter().all(RemoteImageAttachment::is_valid)
            }
            "approval" => {
                self.terminal_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                    && self
                        .permission_id
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
                    && self
                        .option_id
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
            }
            _ => false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommand {
    pub device_id: String,
    pub command_id: String,
    pub kind: String,
    pub terminal_id: Option<String>,
    pub project_id: Option<String>,
    pub text: Option<String>,
    pub permission_id: Option<String>,
    pub option_id: Option<String>,
    pub agent: Option<String>,
    pub images: Vec<RemoteImageAttachment>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedEnvelope {
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendMessage<'a> {
    message_id: &'a str,
    sent_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    collapse_key: Option<&'a str>,
    preview: &'a EncryptedEnvelope,
    payload: &'a EncryptedEnvelope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandEnvelope {
    command_id: String,
    payload: EncryptedEnvelope,
}

#[derive(Debug, Deserialize)]
struct RemoteCommandList {
    commands: Vec<RemoteCommandEnvelope>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub sent: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn relay_url() -> String {
    std::env::var("DUCKWEED_RELAY_URL")
        .ok()
        .filter(|value| value.starts_with("https://") || value.starts_with("http://127.0.0.1"))
        .or_else(|| {
            option_env!("DUCKWEED_RELAY_URL")
                .filter(|value| value.starts_with("https://"))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| DEFAULT_RELAY_URL.into())
        .trim_end_matches('/')
        .to_string()
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn sha256(input: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(input.as_bytes()))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("mobile-notifications.json"))
        .map_err(|error| error.to_string())
}

fn read_state(path: &Path) -> StoredState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(path: &Path, state: &StoredState) -> Result<(), String> {
    let parent = path.parent().ok_or("mobile settings path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|error| error.to_string())
}

fn save_secret(id: &str, secret: &DeviceSecret) -> Result<(), String> {
    let raw = serde_json::to_string(secret).map_err(|error| error.to_string())?;
    keyring_entry(id)?
        .set_password(&raw)
        .map_err(|error| format!("could not store mobile credential: {error}"))
}

fn load_secret(id: &str) -> Result<DeviceSecret, String> {
    let raw = keyring_entry(id)?
        .get_password()
        .map_err(|error| format!("could not read mobile credential: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn remove_secret(id: &str) {
    if let Ok(entry) = keyring_entry(id) {
        let _ = entry.delete_credential();
    }
}

fn client() -> Result<&'static Client, String> {
    HTTP_CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            Client::builder()
                .user_agent(concat!("Duckweed/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .pool_idle_timeout(Duration::from_secs(60))
                .pool_max_idle_per_host(4)
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn send_request(request: RequestBuilder) -> Result<Response, reqwest::Error> {
    let mut attempt = request;
    for retry_delay in [Some(150), Some(500), None] {
        let retry = attempt.try_clone();
        match attempt.send() {
            Ok(response) => return Ok(response),
            Err(error) if error.is_connect() && retry_delay.is_some() && retry.is_some() => {
                std::thread::sleep(Duration::from_millis(retry_delay.unwrap_or_default()));
                attempt = retry.expect("retryable request was cloned");
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the final request attempt always returns")
}

fn request_error(context: &str, error: &reqwest::Error) -> String {
    let mut detail = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !detail.ends_with(&cause_text) {
            detail.push_str(": ");
            detail.push_str(&cause_text);
        }
        source = cause.source();
    }
    format!("{context}: {detail}")
}

fn checked(response: Response) -> Result<Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let detail = response.text().unwrap_or_default();
    Err(if detail.trim().is_empty() {
        format!("notification relay returned {status}")
    } else {
        format!("notification relay returned {status}: {}", detail.trim())
    })
}

fn pairing_is_gone(status: StatusCode) -> bool {
    matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE)
}

fn secret_bytes(secret: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(secret)
        .map_err(|_| "mobile encryption key is invalid".to_string())
}

fn encryption_key(secret: &str, pair_id: &str) -> Result<[u8; 32], String> {
    let input = secret_bytes(secret)?;
    let hkdf = Hkdf::<Sha256>::new(Some(pair_id.as_bytes()), &input);
    let mut key = [0u8; 32];
    hkdf.expand(b"duckweed/mobile/encryption/v1", &mut key)
        .map_err(|_| "could not derive mobile encryption key".to_string())?;
    Ok(key)
}

fn pairing_proof(
    secret: &str,
    pair_id: &str,
    device_id: &str,
    name: &str,
) -> Result<String, String> {
    let key = secret_bytes(secret)?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key)
        .map_err(|_| "could not verify paired device".to_string())?;
    mac.update(format!("{pair_id}\n{device_id}\n{name}").as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn encrypt(
    secret: &str,
    pair_id: &str,
    message_id: &str,
    kind: &str,
    plaintext: &[u8],
) -> Result<EncryptedEnvelope, String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    encrypt_with_nonce(secret, pair_id, message_id, kind, plaintext, nonce)
}

fn encrypt_with_nonce(
    secret: &str,
    pair_id: &str,
    message_id: &str,
    kind: &str,
    plaintext: &[u8],
    nonce: [u8; 12],
) -> Result<EncryptedEnvelope, String> {
    let key = encryption_key(secret, pair_id)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| error.to_string())?;
    let aad = format!("v1\n{pair_id}\n{message_id}\n{kind}");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "could not encrypt mobile notification".to_string())?;
    Ok(EncryptedEnvelope {
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

fn decrypt(
    secret: &str,
    pair_id: &str,
    message_id: &str,
    kind: &str,
    envelope: &EncryptedEnvelope,
) -> Result<Vec<u8>, String> {
    let key = encryption_key(secret, pair_id)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| error.to_string())?;
    let nonce = URL_SAFE_NO_PAD
        .decode(&envelope.nonce)
        .map_err(|_| "remote command nonce is invalid".to_string())?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| "remote command ciphertext is invalid".to_string())?;
    if nonce.len() != 12 {
        return Err("remote command nonce is invalid".into());
    }
    let aad = format!("v1\n{pair_id}\n{message_id}\n{kind}");
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "could not decrypt remote command".to_string())
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit.saturating_sub('…'.len_utf8()).min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn encrypted_ciphertext_len(plaintext_len: usize) -> usize {
    let ciphertext_len = plaintext_len + 16;
    (ciphertext_len / 3) * 4
        + match ciphertext_len % 3 {
            0 => 0,
            1 => 2,
            _ => 3,
        }
}

fn bounded_preview_plaintext(
    message_id: &str,
    sent_at: i64,
    agent: &str,
    project: &str,
    kind: &str,
    response: Option<&str>,
    duration_ms: Option<u64>,
    sound_cue: Option<u8>,
    unread_on_desktop: bool,
) -> Result<Vec<u8>, String> {
    let serialize = |preview_response: Option<&str>| {
        serde_json::to_vec(&PlainMessage {
            version: 1,
            id: message_id,
            sent_at,
            agent,
            project,
            project_id: None,
            terminal_id: None,
            terminal_title: None,
            kind,
            response: preview_response,
            duration_ms,
            sound_cue,
            unread_on_desktop,
        })
        .map_err(|error| error.to_string())
    };
    let fits = |plain: &[u8]| encrypted_ciphertext_len(plain.len()) <= MAX_PREVIEW_CIPHERTEXT;
    let Some(response) = response else {
        let plain = serialize(None)?;
        return fits(&plain)
            .then_some(plain)
            .ok_or_else(|| "mobile notification metadata exceeds the preview limit".to_string());
    };

    let full = serialize(Some(response))?;
    if fits(&full) {
        return Ok(full);
    }

    let without_response = serialize(None)?;
    if !fits(&without_response) {
        return Err("mobile notification metadata exceeds the preview limit".into());
    }

    let mut boundaries = vec![0];
    boundaries.extend(
        response
            .char_indices()
            .map(|(index, _)| index)
            .filter(|index| *index > 0),
    );
    let mut low = 0usize;
    let mut high = boundaries.len();
    let mut best = without_response;
    while low < high {
        let middle = low + (high - low) / 2;
        let candidate = format!("{}…", &response[..boundaries[middle]]);
        let plain = serialize(Some(&candidate))?;
        if fits(&plain) {
            best = plain;
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    Ok(best)
}

fn status_blocking(app: &AppHandle) -> Result<MobileStatus, String> {
    let path = state_path(app)?;
    let state = {
        let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let mut state = read_state(&path);
        if state
            .pending
            .as_ref()
            .is_some_and(|pairing| pairing.expires_at <= now_ms())
        {
            if let Some(expired) = state.pending.take() {
                remove_secret(&expired.id);
            }
            save_state(&path, &state)?;
        }
        state
    };

    // Status is intentionally local. A background health check must never
    // destroy a pairing: credential stores, networks, and relay deployments
    // can all fail transiently. Only the explicit remove command may erase a
    // paired device and its credential.
    Ok(MobileStatus {
        relay_url: relay_url(),
        devices: state.devices,
        pending: state.pending,
    })
}

fn pair_start_blocking(app: &AppHandle) -> Result<PairingStart, String> {
    let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let path = state_path(app)?;
    let mut state = read_state(&path);
    if let Some(previous) = state.pending.take() {
        remove_secret(&previous.id);
    }

    let pair_id = Uuid::new_v4().to_string();
    let registration_token = random_secret()?;
    let send_token = random_secret()?;
    let master_key = random_secret()?;
    let expires_at = now_ms() + PAIRING_LIFETIME_MS;
    let relay = relay_url();

    checked(
        send_request(
            client()?
                .post(format!("{relay}/v1/pairings"))
                .json(&CreatePairing {
                    pair_id: &pair_id,
                    registration_token_hash: &sha256(&registration_token),
                    send_token_hash: &sha256(&send_token),
                    expires_at,
                }),
        )
        .map_err(|error| request_error("could not reach notification relay", &error))?,
    )?;

    save_secret(
        &pair_id,
        &DeviceSecret {
            master_key: master_key.clone(),
            send_token,
        },
    )?;
    state.pending = Some(PendingPairing {
        id: pair_id.clone(),
        expires_at,
    });
    save_state(&path, &state)?;

    let qr_payload = serde_json::to_string(&QrPayload {
        version: 1,
        relay_url: &relay,
        pair_id: &pair_id,
        registration_token: &registration_token,
        secret: &master_key,
        expires_at,
    })
    .map_err(|error| error.to_string())?;
    Ok(PairingStart {
        id: pair_id,
        qr_payload,
        expires_at,
    })
}

fn pair_poll_blocking(app: &AppHandle) -> Result<MobileStatus, String> {
    let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let path = state_path(app)?;
    let mut state = read_state(&path);
    let Some(pending) = state.pending.clone() else {
        return Ok(MobileStatus {
            relay_url: relay_url(),
            devices: state.devices,
            pending: None,
        });
    };
    if pending.expires_at <= now_ms() {
        state.pending = None;
        remove_secret(&pending.id);
        save_state(&path, &state)?;
        return Err("pairing code expired".into());
    }
    let secret = load_secret(&pending.id)?;
    let relay = relay_url();
    let poll: PairingPoll = checked(
        send_request(
            client()?
                .get(format!("{relay}/v1/pairings/{}", pending.id))
                .bearer_auth(&secret.send_token),
        )
        .map_err(|error| request_error("could not reach notification relay", &error))?,
    )?
    .json()
    .map_err(|error| error.to_string())?;

    if let Some(remote) = poll.device {
        let expected = pairing_proof(&secret.master_key, &pending.id, &remote.id, &remote.name)?;
        if expected != remote.proof {
            return Err("the paired phone did not prove possession of the QR secret".into());
        }
        state.devices.retain(|device| device.id != pending.id);
        state.devices.push(MobileDevice {
            id: pending.id,
            name: remote.name,
            paired_at: remote.paired_at,
        });
        state.pending = None;
        save_state(&path, &state)?;
    }

    Ok(MobileStatus {
        relay_url: relay,
        devices: state.devices,
        pending: state.pending,
    })
}

fn remove_device_blocking(app: &AppHandle, id: &str) -> Result<MobileStatus, String> {
    let path = state_path(app)?;
    // Local removal is authoritative and idempotent. If the phone already
    // deleted the relay row, the sender credential necessarily returns 401.
    // A missing keyring item must not leave an undeletable row in Settings.
    if let Ok(secret) = load_secret(id) {
        let _ = send_request(
            client()?
                .delete(format!("{}/v1/pairings/{id}", relay_url()))
                .bearer_auth(secret.send_token),
        );
    }
    let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let mut state = read_state(&path);
    state.devices.retain(|device| device.id != id);
    if state
        .pending
        .as_ref()
        .is_some_and(|pending| pending.id == id)
    {
        state.pending = None;
    }
    remove_secret(id);
    save_state(&path, &state)?;
    Ok(MobileStatus {
        relay_url: relay_url(),
        devices: state.devices,
        pending: state.pending,
    })
}

fn send_to_device(
    device: &MobileDevice,
    message: &CompletionMessage,
    sent_at: i64,
    message_id: &str,
) -> Result<(), String> {
    let secret = load_secret(&device.id)?;
    let agent = if message.agent.trim().is_empty() {
        "Agent".to_string()
    } else {
        truncate_utf8(message.agent.trim(), 80)
    };
    let project = if message.project.trim().is_empty() {
        "Duckweed".to_string()
    } else {
        truncate_utf8(message.project.trim(), 200)
    };
    let kind = if message.kind == "attention" {
        "attention"
    } else {
        "completed"
    };
    let response = message
        .response
        .as_deref()
        .map(|value| truncate_utf8(value, MAX_RESPONSE_BYTES));
    let preview_plain = bounded_preview_plaintext(
        message_id,
        sent_at,
        &agent,
        &project,
        kind,
        response.as_deref(),
        message.duration_ms,
        message.sound_cue,
        message.unread_on_desktop,
    )?;
    let full_plain = serde_json::to_vec(&PlainMessage {
        version: 1,
        id: message_id,
        sent_at,
        agent: &agent,
        project: &project,
        project_id: message.project_id.as_deref(),
        terminal_id: message.terminal_id.as_deref(),
        terminal_title: message.terminal_title.as_deref(),
        kind,
        response: response.as_deref(),
        duration_ms: message.duration_ms,
        sound_cue: message.sound_cue.filter(|cue| *cue < 6),
        unread_on_desktop: message.unread_on_desktop,
    })
    .map_err(|error| error.to_string())?;
    let preview = encrypt(
        &secret.master_key,
        &device.id,
        message_id,
        "preview",
        &preview_plain,
    )?;
    let payload = encrypt(
        &secret.master_key,
        &device.id,
        message_id,
        "payload",
        &full_plain,
    )?;
    let relay = relay_url();
    checked(
        send_request(
            client()?
                .post(format!("{relay}/v1/pairings/{}/messages", device.id))
                .bearer_auth(secret.send_token)
                .json(&SendMessage {
                    message_id,
                    sent_at,
                    collapse_key: None,
                    preview: &preview,
                    payload: &payload,
                }),
        )
        .map_err(|error| request_error("could not send mobile notification", &error))?,
    )?;
    Ok(())
}

fn send_workspace_to_device(
    device: &MobileDevice,
    snapshot: &WorkspaceSnapshot,
    sent_at: i64,
    message_id: &str,
) -> Result<(), String> {
    let secret = load_secret(&device.id)?;
    let preview_plain = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "id": message_id,
        "sentAt": sent_at,
        "kind": "workspace",
    }))
    .map_err(|error| error.to_string())?;
    let full_plain = serde_json::to_vec(&PlainWorkspace {
        version: 1,
        id: message_id,
        sent_at,
        kind: "workspace",
        projects: &snapshot.projects,
    })
    .map_err(|error| error.to_string())?;
    if full_plain.len() > MAX_WORKSPACE_PLAINTEXT_BYTES {
        return Err(format!(
            "mobile workspace exceeds the encrypted payload limit ({} bytes)",
            full_plain.len()
        ));
    }
    let preview = encrypt(
        &secret.master_key,
        &device.id,
        message_id,
        "preview",
        &preview_plain,
    )?;
    let payload = encrypt(
        &secret.master_key,
        &device.id,
        message_id,
        "payload",
        &full_plain,
    )?;
    checked(
        send_request(
            client()?
                .post(format!(
                    "{}/v1/pairings/{}/messages",
                    relay_url(),
                    device.id
                ))
                .bearer_auth(secret.send_token)
                .json(&SendMessage {
                    message_id,
                    sent_at,
                    collapse_key: None,
                    preview: &preview,
                    payload: &payload,
                }),
        )
        .map_err(|error| request_error("could not send mobile workspace", &error))?,
    )?;
    Ok(())
}

fn send_presence_to_device(device: &MobileDevice, sent_at: i64) -> Result<(), String> {
    let secret = load_secret(&device.id)?;
    // Reusing one id makes the relay replace an unacknowledged heartbeat, so
    // an offline phone keeps only the latest presence payload.
    let message_id = &device.id;
    let plain = serde_json::to_vec(&PlainPresence {
        version: 1,
        id: message_id,
        sent_at,
        pair_id: &device.id,
        kind: "presence",
    })
    .map_err(|error| error.to_string())?;
    let preview = encrypt(
        &secret.master_key,
        &device.id,
        message_id,
        "preview",
        &plain,
    )?;
    let payload = encrypt(
        &secret.master_key,
        &device.id,
        message_id,
        "payload",
        &plain,
    )?;
    checked(
        send_request(
            client()?
                .post(format!(
                    "{}/v1/pairings/{}/messages",
                    relay_url(),
                    device.id
                ))
                .bearer_auth(secret.send_token)
                .json(&SendMessage {
                    message_id,
                    sent_at,
                    collapse_key: Some(message_id),
                    preview: &preview,
                    payload: &payload,
                }),
        )
        .map_err(|error| request_error("could not send mobile presence", &error))?,
    )?;
    Ok(())
}

fn workspace_blocking(app: &AppHandle, snapshot: WorkspaceSnapshot) -> Result<SendResult, String> {
    let state = {
        let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        read_state(&state_path(app)?)
    };
    let sent_at = now_ms();
    let message_id = Uuid::new_v4().to_string();
    let mut result = SendResult {
        sent: 0,
        failed: 0,
        errors: Vec::new(),
    };
    for device in &state.devices {
        match send_workspace_to_device(device, &snapshot, sent_at, &message_id) {
            Ok(()) => result.sent += 1,
            Err(error) => {
                result.failed += 1;
                result.errors.push(format!("{}: {error}", device.name));
            }
        }
    }
    Ok(result)
}

fn presence_blocking(app: &AppHandle) -> Result<SendResult, String> {
    let state = {
        let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        read_state(&state_path(app)?)
    };
    let sent_at = now_ms();
    let mut result = SendResult {
        sent: 0,
        failed: 0,
        errors: Vec::new(),
    };
    for device in &state.devices {
        match send_presence_to_device(device, sent_at) {
            Ok(()) => result.sent += 1,
            Err(error) => {
                result.failed += 1;
                result.errors.push(format!("{}: {error}", device.name));
            }
        }
    }
    Ok(result)
}

fn poll_commands_blocking(app: &AppHandle) -> Result<Vec<RemoteCommand>, String> {
    let state = {
        let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        read_state(&state_path(app)?)
    };
    let mut commands = Vec::new();
    for device in &state.devices {
        // A temporary keyring failure must not turn into an implicit unpair.
        // Sending and polling can recover as soon as the credential store does.
        let Ok(secret) = load_secret(&device.id) else {
            continue;
        };
        let response = send_request(
            client()?
                .get(format!(
                    "{}/v1/pairings/{}/commands",
                    relay_url(),
                    device.id
                ))
                .bearer_auth(&secret.send_token),
        )
        .map_err(|error| request_error("could not poll mobile commands", &error))?;
        if pairing_is_gone(response.status()) {
            // The phone may have removed the relay row, or the relay may be
            // between deployments. Keep the local credential until the user
            // explicitly removes the device from Settings.
            continue;
        }
        let list: RemoteCommandList = checked(response)?
            .json()
            .map_err(|error| error.to_string())?;
        for remote in list.commands {
            let plain = decrypt(
                &secret.master_key,
                &device.id,
                &remote.command_id,
                "command",
                &remote.payload,
            )?;
            let command: PlainRemoteCommand =
                serde_json::from_slice(&plain).map_err(|error| error.to_string())?;
            if command.version != 1 || command.id != remote.command_id {
                continue;
            }
            if !command.is_valid() {
                continue;
            }
            commands.push(RemoteCommand {
                device_id: device.id.clone(),
                command_id: remote.command_id,
                kind: command.kind,
                terminal_id: command.terminal_id,
                project_id: command.project_id,
                text: command.text,
                permission_id: command.permission_id,
                option_id: command.option_id,
                agent: command.agent,
                images: command.images,
            });
        }
    }
    Ok(commands)
}

fn ack_command_blocking(device_id: &str, command_id: &str) -> Result<(), String> {
    let secret = load_secret(device_id)?;
    checked(
        send_request(
            client()?
                .delete(format!(
                    "{}/v1/pairings/{device_id}/commands/{command_id}",
                    relay_url()
                ))
                .bearer_auth(secret.send_token),
        )
        .map_err(|error| request_error("could not acknowledge mobile command", &error))?,
    )?;
    Ok(())
}

fn send_blocking(app: &AppHandle, message: CompletionMessage) -> Result<SendResult, String> {
    let state = {
        let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        read_state(&state_path(app)?)
    };
    let sent_at = now_ms();
    let message_id = Uuid::new_v4().to_string();
    let mut result = SendResult {
        sent: 0,
        failed: 0,
        errors: Vec::new(),
    };
    for device in &state.devices {
        match send_to_device(device, &message, sent_at, &message_id) {
            Ok(()) => result.sent += 1,
            Err(error) => {
                result.failed += 1;
                result.errors.push(format!("{}: {error}", device.name));
            }
        }
    }
    Ok(result)
}

async fn blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn mobile_status(app: AppHandle) -> Result<MobileStatus, String> {
    blocking(move || status_blocking(&app)).await
}

#[tauri::command]
pub async fn mobile_pair_start(app: AppHandle) -> Result<PairingStart, String> {
    blocking(move || pair_start_blocking(&app)).await
}

#[tauri::command]
pub async fn mobile_pair_poll(app: AppHandle) -> Result<MobileStatus, String> {
    blocking(move || pair_poll_blocking(&app)).await
}

#[tauri::command]
pub async fn mobile_device_remove(app: AppHandle, id: String) -> Result<MobileStatus, String> {
    blocking(move || remove_device_blocking(&app, &id)).await
}

#[tauri::command]
pub async fn mobile_send_completion(
    app: AppHandle,
    message: CompletionMessage,
) -> Result<SendResult, String> {
    blocking(move || send_blocking(&app, message)).await
}

#[tauri::command]
pub async fn mobile_send_workspace(
    app: AppHandle,
    snapshot: WorkspaceSnapshot,
) -> Result<SendResult, String> {
    blocking(move || workspace_blocking(&app, snapshot)).await
}

#[tauri::command]
pub async fn mobile_send_presence(app: AppHandle) -> Result<SendResult, String> {
    blocking(move || presence_blocking(&app)).await
}

#[tauri::command]
pub async fn mobile_poll_commands(app: AppHandle) -> Result<Vec<RemoteCommand>, String> {
    blocking(move || poll_commands_blocking(&app)).await
}

#[tauri::command]
pub async fn mobile_ack_command(device_id: String, command_id: String) -> Result<(), String> {
    blocking(move || ack_command_blocking(&device_id, &command_id)).await
}

#[tauri::command]
pub async fn mobile_send_test(app: AppHandle) -> Result<SendResult, String> {
    blocking(move || {
        send_blocking(
            &app,
            CompletionMessage {
                agent: "Duckweed".into(),
                project: "Mobile notifications".into(),
                project_id: None,
                terminal_id: None,
                terminal_title: None,
                kind: "completed".into(),
                response: Some(
                    "Pairing works. Future agent responses will appear here securely.".into(),
                ),
                duration_ms: None,
                sound_cue: None,
                unread_on_desktop: true,
            },
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_preview_plaintext, client, decrypt, encrypt, encrypt_with_nonce,
        encrypted_ciphertext_len, pairing_is_gone, pairing_proof, truncate_utf8,
        PlainRemoteCommand, MAX_PREVIEW_CIPHERTEXT, MAX_WORKSPACE_PLAINTEXT_BYTES,
    };

    #[test]
    fn mobile_requests_reuse_one_connection_pool() {
        assert!(std::ptr::eq(client().unwrap(), client().unwrap()));
    }

    #[test]
    fn pairing_proof_binds_the_phone_identity() {
        let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let proof = pairing_proof(secret, "pair", "phone", "Pixel").unwrap();
        assert_ne!(
            proof,
            pairing_proof(secret, "pair", "other", "Pixel").unwrap()
        );
    }

    #[test]
    fn encrypted_envelopes_use_fresh_nonces() {
        let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let first = encrypt(secret, "pair", "message", "payload", b"hello").unwrap();
        let second = encrypt(secret, "pair", "message", "payload", b"hello").unwrap();
        assert_ne!(first.nonce, second.nonce);
        assert_ne!(first.ciphertext, second.ciphertext);
    }

    #[test]
    fn encrypted_remote_commands_round_trip() {
        let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let pair = "pair";
        let id = "00000000-0000-4000-8000-000000000001";
        let plain = br#"{"version":1,"kind":"input","text":"continue"}"#;
        let envelope = encrypt(secret, pair, id, "command", plain).unwrap();
        assert_eq!(
            decrypt(secret, pair, id, "command", &envelope).unwrap(),
            plain
        );
    }

    #[test]
    fn refresh_commands_do_not_require_terminal_input() {
        let command: PlainRemoteCommand = serde_json::from_str(
            r#"{"version":1,"id":"00000000-0000-4000-8000-000000000001","kind":"refresh"}"#,
        )
        .unwrap();
        assert_eq!(command.kind, "refresh");
        assert!(command.terminal_id.is_none());
        assert!(command.text.is_none());
        assert!(command.is_valid());
    }

    #[test]
    fn approval_commands_require_the_exact_pending_decision_identity() {
        let valid: PlainRemoteCommand = serde_json::from_str(
            r#"{"version":1,"id":"00000000-0000-4000-8000-000000000001","kind":"approval","terminalId":"term-1","permissionId":"permission-1","optionId":"allow-once"}"#,
        )
        .unwrap();
        assert!(valid.is_valid());

        let missing_option: PlainRemoteCommand = serde_json::from_str(
            r#"{"version":1,"id":"00000000-0000-4000-8000-000000000001","kind":"approval","terminalId":"term-1","permissionId":"permission-1"}"#,
        )
        .unwrap();
        assert!(!missing_option.is_valid());
    }

    #[test]
    fn image_commands_require_a_bounded_supported_data_url() {
        let valid: PlainRemoteCommand = serde_json::from_str(
            r#"{"version":1,"id":"00000000-0000-4000-8000-000000000001","kind":"input","terminalId":"term-1","text":"","images":[{"id":"image-1","name":"shot.png","mimeType":"image/png","dataUrl":"data:image/png;base64,AA","size":1}]}"#,
        )
        .unwrap();
        assert!(valid.is_valid());

        let unsupported: PlainRemoteCommand = serde_json::from_str(
            r#"{"version":1,"id":"00000000-0000-4000-8000-000000000001","kind":"input","terminalId":"term-1","images":[{"id":"image-1","name":"shot.svg","mimeType":"image/svg+xml","dataUrl":"data:image/svg+xml;base64,AA","size":1}]}"#,
        )
        .unwrap();
        assert!(!unsupported.is_valid());
    }

    #[test]
    fn only_explicit_removal_may_prune_a_local_pairing() {
        // 401 can mean a credential-store mismatch or another recoverable
        // authentication problem. Only an explicit missing/expired row is
        // authoritative enough to erase local pairing state.
        assert!(!pairing_is_gone(reqwest::StatusCode::UNAUTHORIZED));
        assert!(pairing_is_gone(reqwest::StatusCode::NOT_FOUND));
        assert!(pairing_is_gone(reqwest::StatusCode::GONE));
        assert!(!pairing_is_gone(reqwest::StatusCode::SERVICE_UNAVAILABLE));
    }

    #[test]
    fn encryption_matches_the_android_test_vector() {
        let envelope = encrypt_with_nonce(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "pair-vector",
            "00000000-0000-4000-8000-000000000001",
            "payload",
            br#"{"version":1,"project":"Duckweed"}"#,
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        )
        .unwrap();
        assert_eq!(envelope.nonce, "AAECAwQFBgcICQoL");
        assert_eq!(
            envelope.ciphertext,
            "-THbvBtozACwNq8TVDZDL57l0-PY1uxSEq8aEX34X-nJx7giYUPOy-twOsawTfB1QcQ"
        );
    }

    #[test]
    fn response_limits_are_unicode_safe() {
        assert_eq!(truncate_utf8("abcdef", 5), "ab…");
        assert_eq!(truncate_utf8("🦆ponds", 8), "🦆p…");
        assert!(truncate_utf8("🦆ponds", 8).len() <= 8);
    }

    #[test]
    fn preview_limit_includes_json_escaping_and_encryption_encoding() {
        let response = "\u{0000}".repeat(960);
        let plain = bounded_preview_plaintext(
            "00000000-0000-4000-8000-000000000001",
            1_700_000_000_000,
            "Codex",
            "Duckweed",
            "completed",
            Some(&response),
            Some(42),
            Some(3),
            true,
        )
        .unwrap();
        let decoded: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        let preview_response = decoded["response"].as_str().unwrap();
        assert_eq!(decoded["unreadOnDesktop"], true);
        let envelope = encrypt(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "pair",
            "00000000-0000-4000-8000-000000000001",
            "preview",
            &plain,
        )
        .unwrap();

        assert!(preview_response.len() < response.len());
        assert_eq!(
            envelope.ciphertext.len(),
            encrypted_ciphertext_len(plain.len())
        );
        assert!(envelope.ciphertext.len() <= MAX_PREVIEW_CIPHERTEXT);
    }

    #[test]
    fn workspace_plaintext_budget_stays_inside_the_relay_ciphertext_limit() {
        assert!(encrypted_ciphertext_len(MAX_WORKSPACE_PLAINTEXT_BYTES) <= 320_000);
    }
}
