//! End-to-end encrypted delivery of agent completions to Duckweed Companion.
//!
//! Firebase and the relay only receive opaque AES-GCM envelopes. Pairing puts
//! the encryption secret on the phone through the QR code and keeps desktop
//! credentials in the operating-system credential store.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DEFAULT_RELAY_URL: &str =
    "https://duckweed-notification-relay.idealmusic18.workers.dev";
const KEYRING_SERVICE: &str = "dev.slop.duckweed.mobile";
const PAIRING_LIFETIME_MS: i64 = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES: usize = 180_000;
const MAX_PREVIEW_BYTES: usize = 960;

static FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
    pub kind: String,
    pub response: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainMessage<'a> {
    version: u8,
    id: &'a str,
    sent_at: i64,
    agent: &'a str,
    project: &'a str,
    kind: &'a str,
    response: Option<&'a str>,
    duration_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
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
    preview: &'a EncryptedEnvelope,
    payload: &'a EncryptedEnvelope,
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

fn client() -> Result<Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .user_agent(concat!("Duckweed/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())
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

fn status_blocking(app: &AppHandle) -> Result<MobileStatus, String> {
    let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let path = state_path(app)?;
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
        client()?
            .post(format!("{relay}/v1/pairings"))
            .json(&CreatePairing {
                pair_id: &pair_id,
                registration_token_hash: &sha256(&registration_token),
                send_token_hash: &sha256(&send_token),
                expires_at,
            })
            .send()
            .map_err(|error| format!("could not reach notification relay: {error}"))?,
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
        client()?
            .get(format!("{relay}/v1/pairings/{}", pending.id))
            .bearer_auth(&secret.send_token)
            .send()
            .map_err(|error| format!("could not reach notification relay: {error}"))?,
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
    let _guard = FILE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let path = state_path(app)?;
    let mut state = read_state(&path);
    if let Ok(secret) = load_secret(id) {
        let _ = client().and_then(|http| {
            checked(
                http.delete(format!("{}/v1/pairings/{id}", relay_url()))
                    .bearer_auth(secret.send_token)
                    .send()
                    .map_err(|error| error.to_string())?,
            )?;
            Ok(http)
        });
    }
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
    let preview_response = response
        .as_deref()
        .map(|value| truncate_utf8(value, MAX_PREVIEW_BYTES));
    let preview_plain = serde_json::to_vec(&PlainMessage {
        version: 1,
        id: message_id,
        sent_at,
        agent: &agent,
        project: &project,
        kind,
        response: preview_response.as_deref(),
        duration_ms: message.duration_ms,
    })
    .map_err(|error| error.to_string())?;
    let full_plain = serde_json::to_vec(&PlainMessage {
        version: 1,
        id: message_id,
        sent_at,
        agent: &agent,
        project: &project,
        kind,
        response: response.as_deref(),
        duration_ms: message.duration_ms,
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
        client()?
            .post(format!("{relay}/v1/pairings/{}/messages", device.id))
            .bearer_auth(secret.send_token)
            .json(&SendMessage {
                message_id,
                sent_at,
                preview: &preview,
                payload: &payload,
            })
            .send()
            .map_err(|error| format!("could not send mobile notification: {error}"))?,
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
pub async fn mobile_send_test(app: AppHandle) -> Result<SendResult, String> {
    blocking(move || {
        send_blocking(
            &app,
            CompletionMessage {
                agent: "Duckweed".into(),
                project: "Mobile notifications".into(),
                kind: "completed".into(),
                response: Some(
                    "Pairing works. Future agent responses will appear here securely.".into(),
                ),
                duration_ms: None,
            },
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{encrypt, encrypt_with_nonce, pairing_proof, truncate_utf8};

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
}
