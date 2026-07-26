# Releases and updates

Duckweed ships from two branches, on two update channels that never see each
other's releases.

| Branch    | Channel  | Version              | GitHub release | Who gets it                     |
| --------- | -------- | -------------------- | -------------- | ------------------------------- |
| `main`    | stable   | `1.0.4`              | Latest         | Everyone on a stable install    |
| `testing` | beta     | `1.0.4-testing.2`    | Pre-release    | Everyone on a beta install      |

Every push to one of those two branches builds a Windows installer, tags it, and
publishes it. No other branch publishes anything — the channel is derived from
the branch name and the run stops if the branch is not one of these two.

## One-time setup

The updater only installs updates that are signed with the project's key, so the
repository needs two secrets before the first release.

1. Generate a key pair (once, ever — losing it means shipped installs can no
   longer be updated):

   ```bash
   bun run tauri signer generate -w duckweed-updater.key
   ```

   Keep `duckweed-updater.key` out of the repository. The matching public key is
   already committed in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`;
   if you generate a new pair, replace it there.

2. Add the secrets in **Settings → Secrets and variables → Actions**:

   | Secret                               | Value                                              |
   | ------------------------------------ | -------------------------------------------------- |
   | `TAURI_SIGNING_PRIVATE_KEY`          | the whole contents of `duckweed-updater.key`        |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you chose (leave empty if you set none) |

3. In **Settings → Actions → General**, make sure workflows have
   *Read and write permissions* so the release job can push tags and create
   releases.

That is all. The first push to `main` or `testing` after that publishes a release.

## Version numbers

Versions are `major.minor.patch` and roll like an odometer:

- patch fills `0..99`, then carries: `1.0.99` → `1.1.0`
- minor fills `0..99`, then carries: `1.99.99` → `2.0.0`
- major is unbounded

Both channels count from the newest **stable** tag. A beta is the next stable
version plus a counter:

```
main:     v1.0.3 ───────────────────────────────────► v1.0.4 ──────────► v1.0.5
testing:         └─► v1.0.4-testing.1 ─► …-testing.2 ─┘  └─► v1.0.5-testing.1
```

Publishing `v1.0.4` from `main` restarts the beta counter, because the betas now
work toward `v1.0.5`.

Two ways to steer it:

- **A bigger jump for one release**: run the workflow by hand
  (Actions → Release → Run workflow) and pick `minor` or `major`.
- **An exact number**: set it in `package.json` on the release branch, higher
  than the newest stable tag. That run uses it as-is (`2.5.0` on `testing`
  becomes `2.5.0-testing.1`).

Preview what the next release would be called, without publishing:

```bash
bun run version:next -- --channel testing
```

## What a release run does

1. **Resolve version** (`scripts/release-version.mjs`) — reads every tag, works
   out the next version for the branch's channel, pushes the tag, and opens a
   **draft** release. Drafts are invisible to the updater, so a half-finished
   release can never be handed to an app.
2. **Build** (Windows runner) — stamps the version into `package.json`,
   `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, compiles in this channel's
   update endpoint (`scripts/apply-version.mjs`), runs the typecheck and tests,
   builds and signs the NSIS installer, then writes `latest.json`
   (`scripts/updater-manifest.mjs`) and uploads everything to the release.
3. **Publish** — flips the draft off. Stable becomes the repository's *Latest*;
   beta stays a *Pre-release* and is explicitly never marked latest. The
   permanent `channel-testing` release then receives the new beta manifest and
   a copy of its installer under the fixed name `duckweed-beta-setup.exe`.

Nothing is committed back to the branch: the version lives in the tags, and the
stamped files only exist inside the build.

## How the two channels stay apart

Each build is compiled with exactly **one** update endpoint:

| Channel | Endpoint                                                        |
| ------- | --------------------------------------------------------------- |
| stable  | `…/releases/latest/download/latest.json`                          |
| beta    | `…/releases/download/channel-testing/latest.json`                 |

GitHub's `/releases/latest` resolves to the newest release that is **not** a
prerelease, and every beta is a prerelease — so a stable install cannot reach a
beta even in principle. Beta installs read a manifest that only beta runs ever
write, and which is itself attached to a prerelease so it stays out of the stable
lookup.

The same permanent beta release also carries
`duckweed-beta-setup.exe`. This gives the README a stable download URL for the
newest beta even though GitHub has no `/releases/latest` equivalent for
pre-releases.

On top of that, the app checks the channel of any update it is offered
(`src/lib/update.ts`) and refuses one from the other channel. Both locks are
covered by tests.

**Switching channels** is done by installing the other build by hand: use the
fixed beta installer link or the latest stable release. It overwrites the
existing install and from then on the app follows that channel.

## Installing and updating without administrator rights

The installer is built with NSIS `installMode: currentUser`: Duckweed installs
into `%LOCALAPPDATA%\Duckweed` for the current user only. That means:

- no UAC prompt when installing, and none for any later update;
- the updater downloads the new installer, runs it in passive mode (a progress
  bar, no questions), and the installer restarts the app.

So it is genuinely install-once: after the first install, updates are a click in
the app. The trade-off is that Duckweed is installed per user, not for everyone
on the machine.

Windows SmartScreen may still warn on the *first* install, because the installer
is not code-signed (that needs a paid certificate). Signing the installer is a
separate concern from the update signature, which is always verified.

## Checking for updates in the app

- click the version chip at the right of the status bar, or
- open the command palette (`Ctrl+Shift+P`) → **Check for updates**.

The chip shows the running version and, on a beta build, a `beta` marker. A quiet
check runs a few seconds after launch: it never interrupts, it only lights the
chip up when there is something to install. Failures of that quiet check
(offline, no release yet, running from `tauri dev`) are ignored — a check you
started yourself always reports what happened.

## Testing the pipeline

```bash
bun test          # version arithmetic, channel isolation, workflow rules
bun run typecheck
```

`scripts/version.test.mjs` covers the odometer and channel rules,
`scripts/release-scripts.test.mjs` the stamping and manifest building,
`scripts/update-check.test.mjs` the app's refusal to cross channels (with the
Tauri plugins mocked), and `scripts/workflows.test.mjs` reads the workflow YAML
to assert that only `main` and `testing` release, that betas are never marked
latest, and that the endpoint the app reads is the one the workflow writes.

To try a real build without publishing anything: Actions → Release → Run
workflow, **uncheck "Publish a release"**. It builds the installer and attaches
it as a run artifact, with no tag and no release.

Locally:

```bash
bun scripts/apply-version.mjs --version 1.0.0-testing.1   # stamp a beta version
bun run app:build                                          # build the installer
bun scripts/updater-manifest.mjs --version 1.0.0-testing.1 # build latest.json
git checkout package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
```

Signing locally needs the private key in the environment:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat duckweed-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

## Troubleshooting

**"The workflow ran but no release appeared."** Check the *Resolve version* job:
it fails on purpose when the branch is not `main` or `testing`.

**"Update check failed."** Before the first release of a channel there is no
manifest to read, so the endpoint 404s. It resolves itself with the first
published release on that channel.

**"The app says it is up to date but a newer version exists."** Check which
channel the newer version is on — that is the system working. The status bar chip
shows the channel the running build follows.

**"Signature verification failed."** The build was signed with a key that does
not match `plugins.updater.pubkey`. Re-add `TAURI_SIGNING_PRIVATE_KEY`, or commit
the public key that matches the private one in use.
