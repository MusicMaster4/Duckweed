# Performance audit

Date: 2026-10-09. Audited baseline: `5070dcbacebea673fae1f607afd9c0255df02981`.

Six parallel agents reviewed the terminal frontend, agent presentation, filesystem/Git/usage backend, process/protocol runtime, peripheral services, and Android/mobile/relay. The coordinating agent reviewed application scheduling, persistence, tools, and mobile snapshot generation, integrated the changes, and ran the full desktop validation.

The changes reduce unnecessary work, allocations, native threads, and resource retention while preserving existing interaction, transcript content, terminal bytes, colors, and synchronization contracts. No CSS, layout, assets, feature switches, or history limits were changed. Desktop production CSS files retained their exact baseline build hashes (`App-hTd7VhcN.css` and `index-CrdWaOca.css`). This is style preservation evidence; it does not substitute for an exhaustive interactive visual comparison of every screen.

## Implemented changes

| Area | Problem | Change and preservation checks |
| --- | --- | --- |
| Git | One OS thread per changed file; duplicated diff bodies | At most eight line-count workers, preserving file order and binary/missing-file rules. Parsed hunks move into the result. Existing real-repository diff tests pass. |
| Explorer and search | Repeated lowercase allocations, prefix rescans, result clones, and a two-pipe Git deadlock | Cache sorting keys, count UTF-16 match columns incrementally, stop superseded searches sooner, move results, and feed Git stdin while draining stdout. Unicode columns and 8,000 ignored names are covered. |
| Usage and sessions | Large temporary index serialization and metadata calls inside sorting | Stream the index through a buffered writer with the same atomic replacement, read timestamps once per session file, and clone only the selected shell. |
| Terminal transport | Byte arrays serialized to JSON and full batches cloned; large buffers retained in recycling | Send actual raw binary Tauri responses, move output batches, and recycle only read-sized chunks. Tests assert exact binary bytes and bounded recycler capacity. |
| Terminal frontend | Regex/span work on plain output, repeated block pruning, linear pointer lookup, retained callbacks/timers | Add equivalent processing fast paths, prune only after marker disposal, use binary lookup, and clear closed-session resources. Palette, split-frame markers, real xterm trims, and late delivery are covered. |
| Agent presentation | Repeated subagent projection and context churn on every stream delta | Weak caches preserve immutable summaries, rosters, and settled groups. Separate activity membership from clocks, stabilize callbacks, and avoid redundant state updates. Tests cover cache invalidation and benchmark output matches baseline structurally. |
| Agent runtime | Duplicate JSON parsing and whole transcript-delta allocations | Parse shared Codex frames once and consume complete log lines with a reusable buffer. Partial offsets and intact large lines are covered. |
| CLI capture | Waiting for exit before draining stdout/stderr can fill pipes and time out | Drain both pipes while a cancellable watchdog supplies the existing deadline. Tests cover 256 KiB on each pipe and timeout cleanup. |
| Ports | Spawning netstat repeatedly; repeated process-table ancestry passes | Read native Windows IPv4/IPv6 TCP tables with CLI fallback, and traverse an indexed ownership graph. Tests verify real sockets, address/port/PID decoding, nested roots, and cycles. |
| Background services | Discord wakes every 250 ms while waiting; mobile delay creates a sleeping thread per message | Park/unpark Discord until its unchanged deadline or stop. Use cancellable async mobile timers and start blocking network work only when due. Cancellation and replacement races are tested. |
| Mobile workspace | Expensive projections without a paired recipient and quadratic Unicode truncation | Skip projections until paired, react to native pairing/removal changes across windows/processes, and truncate in linear time. Native ticks retain the 1.2-second cadence when paired. 51,486 comparisons matched baseline text output. |
| Relay | Inline inbox materializes 100 large ciphertext rows although only eight are returned | Fetch nine rows for eight deliveries plus `hasMore`; id-only requests fetch no ciphertext. Response limits, priority, expiry, and boundary behavior are tested. |
| Android | Repeated per-message SQL work/decryption and SQLite helpers left open | Read routing metadata once, skip unchanged updates, decrypt active notification candidates, query the needed workspace, and close helpers on success and failure. Unit tests pass; new device tests compile. |

Other reviewed paths already use bounded streaming, lazy loading, cached catalogs, or action-triggered work. They were left intact where no safe, evidence-backed improvement was identified.

## Measurements

These measurements cover particular algorithms or data-materialization paths on this Windows machine. They are not whole-application CPU/RAM percentages. Timing depends on workload and concurrent machine load.

| Workload | Before | After |
| --- | --- | --- |
| Git line count, 500 files, median of seven warm paired runs | 37.674 ms, 500 workers | 12.861 ms, at most eight workers |
| Session file sorting on a shuffled 500-file fixture | 9,956 metadata calls | 500 metadata calls, same order |
| Agent projections, 250 historical delegated turns and 200 updates, three-sample median | 1,637.9 ms | 46.1 ms |
| Terminal token highlighting, 1,000 reads with 20 log lines per read | 842.14 ms | 616.41 ms |
| Highlight-disabled path, 50,000 reads | 84.69 ms | 5.77 ms |
| Plain frame dispatch, 100,000 reads of 640 bytes | 43.94 ms | 5.89 ms |
| Synthetic complete-line reader, 64 MiB input, temporary heap excluding input | 64 MiB, 80 ms | 8.5 KiB, 29 ms |
| Windows TCP table acquisition, median of 20 samples | 34.746 ms, IPv4 netstat | 0.235 ms, native IPv4/IPv6 |
| Local SQLite inline results, 100 maximum-size ciphertexts | 32,024,757 allocated bytes | 2,882,430 allocated bytes |
| UTF-8 prefix truncation, 140,000-byte mixed text to a 16,000-byte budget, median of 15 paired runs | 366.408 ms | 0.025 ms |
| UTF-8 tail truncation, same fixture | 384.093 ms | 0.202 ms |

The agent benchmark reused all 49,750 settled group references and 199/199 unchanged fleet/roster arrays. Weak keys permit collection when their transcript items are released. The UTF-8 benchmark also checks malformed UTF-16 and every integer byte boundary for deterministic random text.

Reproducible comparison scripts:

```powershell
bun scripts/benchmark-agent-projections.ts --baseline 5070dcbacebea673fae1f607afd9c0255df02981
bun scripts/benchmark-mobile-utf8.ts
```

## Validation

| Check | Result |
| --- | --- |
| `bun test` | 1,223 passed, zero failed, 94 files |
| `bun run typecheck` | Passed |
| `bun run build` | Passed |
| `bun run build:mobile` | Passed |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 263 passed, zero failed, 11 ignored |
| Relay `npm test` | Nine passed |
| Relay `npm run build` | TypeScript and Wrangler deployment dry run passed |
| Android `:app:testDebugUnitTest` | 70 passed across 17 suites |
| Android `:app:compileDebugAndroidTestKotlin` | Passed, including new storage regression tests |
| `git diff --check` | Passed |

Desktop test logs are in `artifacts/performance-frontend-tests.log` and `artifacts/performance-rust-tests.log`. Android unit results are in `android/app/build/reports/tests/testDebugUnitTest/index.html`.

Device instrumentation was not executed because the existing Android emulator is offline. The Rust ignored cases include isolated child-process fixtures and opt-in environment/internet integrations; passing results above do not count them. The initial baseline had a WebSocket-stop failure that passed both targeted reruns and the final full suite without increasing its timeout. Native backend checks were run on Windows; macOS and Linux need their normal CI builds. No exhaustive live-app interaction or end-to-end phone/relay session was recorded, and no whole-process working-set or CPU percentage is claimed.

Concurrent pricing, Codex adapter, usage-index migration, audit-document, and CLIProxy integration edits from other work were preserved. They are not attributed to this performance task, although consolidated checks ran against the shared working tree.

## Remaining opportunities

Codex usage parsing deliberately replays changed rollouts to recover billing/model/cumulative context. Incremental continuation would require a persisted state migration with fork/archive deduplication coverage. The agent recovery checkpoint still serializes full snapshots at its existing cadence. Both paths are correctness-sensitive and were kept intact.

The desktop bundle still emits Vite's existing large-chunk warning. Changing code loading and introducing virtualization could reduce startup or very-long-transcript costs, but would need separate interactive validation for lazy-load boundaries, selection, scrolling, and recovery. No feature, output, or history was removed to meet a resource target.
