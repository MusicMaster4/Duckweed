# Contributing to Duckweed

Thanks for taking the time to contribute. Bug reports, design feedback,
documentation improvements, and code changes are all welcome.

Duckweed uses `testing` as its integration branch and `main` as its stable
release branch. Most contributions should start from `testing` and return to
`testing` through a pull request.

## Before you start

For a small bug fix or documentation improvement, feel free to open a pull
request directly. For a large feature, architectural change, or new dependency,
open an issue first so the approach can be discussed before substantial work is
done.

Keep each contribution focused on one problem. Unrelated fixes should be sent as
separate pull requests.

## Development setup

Duckweed requires:

- [Bun](https://bun.sh/)
- [Rust](https://www.rust-lang.org/tools/install/)
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for
  your operating system

Install the project and start the application:

```bash
git clone https://github.com/YOUR-USERNAME/Duckweed.git
cd Duckweed
git remote add upstream https://github.com/MusicMaster4/Duckweed.git
bun install
bun run app
```

Use `bun run app:watch` when you need the Rust backend to rebuild during
development.

## Create a branch

Update your local copy of `testing`, then create a branch from it:

```bash
git fetch upstream
git switch -c feature/short-description upstream/testing
```

Use a short, descriptive branch name. Common prefixes include:

- `feature/` for new behavior
- `fix/` for bug fixes
- `docs/` for documentation
- `refactor/` for internal restructuring
- `test/` for test-only changes

Do not base a normal contribution on `main`. The `main` branch is reserved for
stable releases.

## Make and test your changes

Follow the existing code style and keep user-facing text in English. Avoid
committing generated installers, build output, local settings, credentials, or
unrelated formatting changes.

Run the automated checks before submitting a pull request:

```bash
bun run typecheck
bun test
```

If you changed Rust code, also run:

```bash
cd src-tauri
cargo check
```

For changes that affect the packaged application, build it locally when
possible:

```bash
bun run app:build
```

Test the behavior you changed in the application. Visual changes should be
checked at different window sizes and with representative terminal content.

## Open a pull request

Push your branch to your fork:

```bash
git push -u origin feature/short-description
```

Open a pull request with `testing` as the base branch. Pull requests should not
normally target `main`.

In the pull request:

- Explain the problem and the solution.
- Describe how you tested the change.
- Link related issues.
- Include screenshots or a short recording for visible UI changes.
- Call out migrations, new dependencies, security implications, and known
  limitations.

Draft pull requests are welcome when you want early feedback. Mark the pull
request ready for review once the implementation and relevant checks are
complete.

GitHub Actions may require maintainer approval before CI runs for a first-time
contributor. Maintainers review workflow changes before granting that approval.

## Review and merge process

Every pull request must pass the available CI checks and address review
feedback before it is merged. Maintainers may ask for additional tests or split
a large change into smaller pull requests.

The normal release path is:

1. A code contribution is merged into `testing`.
2. The release workflow builds and publishes a beta release.
3. The beta is tested in real use.
4. A promotion pull request is opened from `testing` to `main`.
5. The promotion is merged and the release workflow publishes the stable
   release.

Individual contribution pull requests may be squash-merged into `testing`.
Promotion pull requests from `testing` to `main` should use a merge commit so
the branches retain their shared history.

Merging application changes into either release branch has an external effect:

- A merge into `testing` publishes a beta.
- A merge into `main` publishes a stable release.

Documentation-only changes and other paths ignored by the release workflow do
not publish a new release.

Release promotion is handled by maintainers. Contributors do not need to open a
second pull request to `main` for their individual change.

## Hotfixes

An urgent fix for a problem already in the stable release may branch from
`main` and target `main`, but coordinate with a maintainer first. After the
stable fix is released, the same change must be merged or backported into
`testing` so the branches do not regress.

## Licensing

Duckweed is distributed under the
[Duckweed Source-Available License 1.0](LICENSE.md). By submitting a
contribution, you agree that it may be distributed under the project's license.
