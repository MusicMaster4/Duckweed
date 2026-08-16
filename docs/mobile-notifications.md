# Mobile notifications

Duckweed can notify an Android phone when a coding agent finishes or needs
attention. The desktop app and phone pair through a short-lived QR code. No
Duckweed account is required.

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
- Desktop secrets use the operating system credential store. Android secrets
  and response history are encrypted with a non-exportable Android Keystore key.

Removing a phone in Duckweed invalidates its sender-side route. Disconnecting
inside the companion invalidates its receive token and clears local secrets.

## User flow

1. In Duckweed desktop, open **Settings > Agents > Mobile notifications** and
   choose **Download APK**. Scan the download QR code with the Android phone.
2. Install the APK, open the companion, and choose **Connections**.
3. Back on the desktop, choose **Pair a phone**, then scan its QR code in the
   companion.
4. Allow notifications when Android asks.
5. Use **Send test** to verify delivery.

The same companion can pair with either desktop channel. Its own update feed is
fixed by the APK that was installed: stable builds only pull stable updates and
beta builds only pull beta updates. Open **Updates** in the companion to check,
download, verify, and install a newer APK. Android always shows its native
installation confirmation.

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
