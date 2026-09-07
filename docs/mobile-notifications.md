# Mobile notifications

Duckweed can notify an Android phone when a coding agent finishes or needs
attention, and the companion can send a follow-up back to any open terminal.
The desktop app and phone pair through a short-lived QR code. No Duckweed
account is required.

## Privacy model

- The QR code contains a random pairing secret and one-time registration token.
- The desktop encrypts the notification preview and full response locally with
  AES-256-GCM. Keys are derived with HKDF-SHA256 and every message uses fresh
  nonces.
- Cloudflare D1 receives only opaque ciphertext, routing identifiers, token
  hashes, and an FCM delivery token. Cloudflare cannot read the project, agent,
  or response.
- Firebase Cloud Messaging receives the encrypted preview and routing
  identifiers. It does not receive the plaintext project, agent, or response.
- The Android companion decrypts the preview before showing the agent and
  project. Its lock-screen public version is intentionally generic.
- The phone fetches the encrypted full response, decrypts it locally, saves it
  in the companion history, and removes it from the relay after acknowledgement.
  Unclaimed messages expire after seven days.
- Open project and terminal metadata is delivered as a separate encrypted
  workspace snapshot. It includes a compact history of user messages and
  settled final responses, but never live agent output, tool output, or exposed
  reasoning. A pending approval includes only its title, detail, command, and
  available decision labels. The phone also shows the terminal state, such as
  `Thinking`, `Needs attention`, or `Ready`.
- Replies and terminal commands are encrypted on the phone with the same paired
  secret. The relay stores only their opaque ciphertext until the desktop polls,
  decrypts, applies, and acknowledges them.
- Approval decisions use that same encrypted queue. The desktop applies a
  decision only when its permission and option identifiers still match the
  currently pending approval.
- Desktop secrets use the operating system credential store. Android secrets
  and response history are encrypted with a non-exportable Android Keystore key.

Removing a phone in Duckweed invalidates its sender-side route. Disconnecting
inside the companion invalidates its receive token and clears local secrets.
The desktop reconciles that removal automatically, and removing an already
disconnected phone from desktop Settings always clears its local row.

## User flow

1. In Duckweed desktop, open **Settings > Agents > Mobile notifications** and
   choose **Download APK**. Scan the download QR code with the Android phone.
2. Install the APK, open the companion, and choose **Connections**.
3. Back on the desktop, choose **Pair a phone**, then scan its QR code in the
   companion.
4. Allow notifications when Android asks.
5. Use **Send test** to verify delivery.

The **Notifications** switch at the top of **Activity** controls Android
alerts without disabling the encrypted response history. Responses received
while alerts are off are still saved, but they are never replayed as alerts
when notifications are enabled again. **Activity** shows the newest response
from each currently open agent, up to 50 agents. A new response uses the same
red outline as an unread desktop terminal and loses it when its conversation is
opened. Completion and attention notifications also include **Mark as read**.
Using it clears the conversation on the phone immediately and sends an
encrypted read receipt through the relay, which removes the red unread marker
from the matching desktop terminal. If the phone is temporarily offline, the
companion keeps the receipt locally and retries it when connectivity returns.
Opening the notification or conversation performs the same synchronized read.
For a completion outside the visible desktop pane, Duckweed waits 30 seconds
before sending the phone notification. If the red unread outline is cleared
during that interval, no notification is sent. Activity in a different pane
does not clear the notification.
For a completion in the selected pane, Duckweed waits one minute and sends the
notification only if there has been no focused app interaction since the
completion. Focusing Duckweed, hovering while its window is active, switching
tabs or panes, typing, clicking, or scrolling all count as activity. Both grace
periods run in the native desktop process, so minimizing Duckweed or putting its
WebView in the background does not suspend mobile delivery. The Android
companion also suppresses and marks as read a completion for the conversation
currently visible on the phone.

The main companion navigation contains **Activity**, **Projects**, and
**Conversations**. Connection management, sync health, and updates live in
**Settings**. The header reports whether a desktop heartbeat is current, and
Settings shows the last sync time with a manual retry action. Tapping a response
or conversation opens its terminal. Tapping a project opens its current terminal
cards. Every path leads to the same compact conversation view, which keeps
submitted messages and final responses while replacing in-progress output with
**Agent is thinking**. When an agent is blocked on an approval, the phone shows
the exact encrypted choices and can send the selected decision back securely.
Attention notifications also expose **Approve** and **Reject** when the pending
request offers one-time versions of those decisions. Supported Android versions
require the device to be unlocked before either action is delivered, and the
companion revalidates the current permission and option identifiers before
sending it.
Sending `codex`, `claude`, or another installed agent command to an idle terminal
starts it through the desktop in the same way as a local terminal submission.
Conversation drafts are encrypted locally and survive navigation or an app
restart. Agent conversations accept one PNG, JPEG, GIF, or WebP image per
message; large images are resized on the phone before the complete prompt is
encrypted. Outgoing bubbles distinguish sending, relay acceptance, desktop
receipt, and failure. A failed bubble can be tapped to retry with the same
idempotent command identity.
The desktop republishes the encrypted workspace periodically and whenever its
terminal state changes. Pull down on **Responses** or **Projects** to request an
immediate refresh from a running paired desktop.

Completion notifications use the same six bundled Duckweed cues as the desktop.
The desktop selects one cue for the completion and includes only its numeric cue
identifier inside the encrypted payload, so Android plays the exact same cue.

The same companion can pair with either desktop channel. Its own update feed is
fixed by the APK that was installed: stable builds only pull stable updates and
beta builds only pull beta updates. Open **Updates** in the companion to check,
download, verify, and install a newer APK. Android always shows its native
installation confirmation.

### Pairing continuity across updates

Normal in-place updates do not require pairing the phone again. The Android
package identity stays fixed, so Android retains the encrypted pairing in app
storage and its non-exportable Keystore key. On launch, the updated companion
also refreshes its Firebase delivery token for every retained desktop pairing.

Desktop updates keep the same application identifier, app-data location, and
operating-system credential-store service, so the device list and sender keys
survive an update there as well. Pairing is lost only when the user disconnects
or removes the device, clears app data, uninstalls the companion, or installs a
build with a different package identity or signing key.

## Free infrastructure

The production design uses two free services:

- Firebase Spark provides only Firebase Cloud Messaging for Android push
  delivery. FCM is a no-cost Firebase product and does not require a billing
  account.
- Cloudflare Workers and D1 provide the HTTPS relay and temporary encrypted
  storage on the Workers Free plan.

No Firebase Functions, Firestore, Cloud Run, or Blaze billing account is used.
If a Cloudflare free quota is exhausted, requests fail until the quota resets
instead of creating usage charges. Current limits are documented in the
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
pages.

## Firebase Spark setup

The existing Firebase project is `duckweed-notify-jubarte-202608`.

1. Keep the project on the no-cost Spark plan.
2. Register the Android package `dev.slop.duckweed.companion`.
3. Download `google-services.json` and keep it out of Git.
4. Enable the Firebase Cloud Messaging HTTP v1 API.
5. Create a dedicated Google service account with only the Firebase Cloud
   Messaging API Admin role.
6. Generate one JSON key for that restricted account. Store the full JSON as
   the GitHub secret `FCM_SERVICE_ACCOUNT_JSON` and never commit it.

The Cloudflare Worker uses that restricted credential only to obtain short-lived
OAuth tokens and submit encrypted data messages to FCM. The credential cannot
decrypt Duckweed messages.

## Cloudflare setup

Use a Workers Free account. A payment method is not required.

1. Install dependencies and authenticate Wrangler:

   ```bash
   cd relay
   npm ci
   npx wrangler login
   ```

2. Create the free D1 database:

   ```bash
   npx wrangler d1 create duckweed-notification-relay
   ```

3. Save the returned UUID as the GitHub repository variable
   `CLOUDFLARE_D1_DATABASE_ID`.
4. Create a Cloudflare API token restricted to the selected account, with only
   Workers Scripts Edit and D1 Edit permissions. Save it as the GitHub secret
   `CLOUDFLARE_API_TOKEN`.
5. Save the account ID as the GitHub variable `CLOUDFLARE_ACCOUNT_ID`.
6. Run the **Deploy notification relay** GitHub Actions workflow. It tests the
   Worker, applies D1 migrations, uploads the FCM credential as an encrypted
   Worker secret, and deploys the relay.
7. Save the resulting endpoint as the repository variable
   `DUCKWEED_RELAY_URL`. This deployment uses
   `https://duckweed-notification-relay.idealmusic18.workers.dev`.

The committed `wrangler.jsonc` contains a zero UUID for local builds. The deploy
workflow generates an ignored config with the real D1 UUID so account-specific
identifiers are not required in source control.

## GitHub configuration

Set these Actions secrets before publishing:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account-scoped Worker and D1 deployment access |
| `FCM_SERVICE_ACCOUNT_JSON` | Restricted FCM sender credential |
| `FIREBASE_ANDROID_GOOGLE_SERVICES_JSON` | Base64-encoded Android Firebase configuration |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded Android release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Release keystore password |
| `ANDROID_KEY_ALIAS` | Release key alias |
| `ANDROID_KEY_PASSWORD` | Release key password |

Set these repository variables:

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the free Worker and D1 database |
| `CLOUDFLARE_D1_DATABASE_ID` | Production D1 database binding |
| `DUCKWEED_RELAY_URL` | Production `workers.dev` relay endpoint |

The release workflow compiles the relay URL into official desktop builds. The
CI workflow always builds a debug APK. It uses
`android/app/google-services.example.json` only when the real Firebase secret
is unavailable, so pull requests can verify compilation without production
credentials. Release builds require the real configuration and signing secrets.

## Relay development

Run the production Worker code against a local D1 database:

```bash
cd relay
npm ci
npm test
npm run build
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

Tests run inside the Cloudflare Workers runtime with an isolated local D1
database. They cover pairing, authorization, long encrypted payloads, push
delivery, acknowledgement, provider failure cleanup, and rate limiting.

## Android development

Android Studio can open the `android` directory directly. The command-line
build requires JDK 17, Android SDK 36, and Gradle 8.13:

```bash
gradle -p android :app:testDebugUnitTest :app:assembleDebug
```

Use `-PduckweedChannel=testing` to build a companion that follows the beta
update feed. The default is `stable`.

The debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`.
