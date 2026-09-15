# Usage cost audit

Reviewed on September 10, 2026. Duckweed estimates the API value of tokens in local agent logs. These figures do not measure subscription payments or remaining plan credits.

## Reference comparison

The review compared Duckweed's parsers and aggregation with [ccusage](https://github.com/ccusage/ccusage/tree/556b6ee0e6dd1eb92be5813ce3f9d47de0576f79), including its Codex parser, Gemini session normalization, and [cost modes](https://ccusage.com/guide/cost-modes). This was a source-level comparison and fixture validation, not a claim that the two CLIs produced identical account-wide reports.

The normalized token total remains `input + output + reasoning + cache_read + cache_write`. All five buckets are disjoint. One-hour cache writes are a subset of `cache_write`, never another contribution to the total.

For requests without a reported cost, multiply each bucket by its model rate and divide by one million. Reasoning uses the output rate. Apply context and service-tier conditions per request before aggregating. When a request has a reported cost, preserve it, including an explicit zero. This follows ccusage's per-entry `auto` approach.

## Corrections

| Case | Previous behavior | Corrected behavior |
| --- | --- | --- |
| Mixed reported and estimated costs | A reported cost could replace the entire bucket's estimate | Keep the two kinds of requests separate through daily compaction |
| Codex service tier | Ignored `thread_settings_applied`; model-only contexts cleared the tier | Apply recorded tier changes in order and preserve them during append scans |
| Codex cumulative-only usage | Discarded events without `last_token_usage` | Calculate component deltas from cumulative counters, ignoring repeated snapshots |
| Gemini cache | Always treated cached tokens as additional input | Use the recorded total to distinguish inclusive input from already-exclusive input |
| Gemini long context | Always used short-context rates | Apply the 200,000-input-token threshold for supported Pro models per request |
| Claude cache | Charged all writes at the five-minute rate | Use the recorded one-hour breakdown at twice the input rate |
| Claude reported costs and Fast | Ignored recorded cost and speed | Preserve `costUSD` and recognize supported Fast models |
| Sonnet 5 | $3 input / $15 output | $2 input / $10 output per million tokens |
| Fable/Mythos 5.1 | Missing specific cached-input rates | $0.25 per million cached tokens, with dotted and hyphenated model names supported |
| GPT-5.1-Codex Mini | Inherited GPT-5.1's $1.25 / $10 | $0.25 input / $2 output per million tokens |
| Legacy codex-mini-latest cache | $0.15 per million tokens | $0.375, as specified in its [model pricing](https://developers.openai.com/api/docs/models/codex-mini-latest) |
| Kimi logs in Anthropic format | Subtracted cache from already-exclusive input | Preserve fresh input separately from cache |
| Old copied histories | Forgot duplicate identities after 30 days | Retain identities for the lifetime of the indexed file |
| Deleted or rewritten history owners | A surviving copy could remain suppressed | Rebuild affected source data so surviving records are counted once |

The index version is now 3. The next scan in the updated app rebuilds older indexes from source logs. Unchanged subsequent scans still reuse the index. Rewritten sources can require a broader rescan to preserve duplicate ownership correctly.

## Validation

Regression fixtures cover the corrections above, including append scans, warm scans, index reload, old archives, compaction, explicit zero costs, and agreement between model/day/overall totals. Examples:

- Three Sonnet 5 calls with reported costs of $7, no cost, and $0 produce $19 when each has one million input and output tokens.
- A Gemini record with 1,000 inclusive input, 800 cached, 100 output, and 50 thinking tokens produces 1,150 total tokens and $0.00185 at Gemini 2.5 Pro short-context rates. The equivalent exclusive-input record produces the same result.
- One million Sonnet 5 input tokens, one million output tokens, and one million cache-write tokens split 40% five-minute / 60% one-hour produce three million tokens and $15.40.

A read-only check of 998 locally recorded Codex calls in session files created on September 10 found no cost change from the tier-handling correction alone. The core Codex input/cache/reasoning separation was already correct. That sample does not establish the effect of every correction on the full history.

Validated with `cargo test --manifest-path src-tauri/Cargo.toml usage:: -- --quiet` (74 passed, 2 intentionally ignored), TypeScript checking, and the usage/chart frontend tests (31 passed).

## Interpretation and limits

Rates are built-in list-price estimates, with user overrides; they are not an invoice reconciliation or a historical tariff database. Separate tool fees, taxes, regional premiums, negotiated rates, and subscription credits are not reconstructed. Unknown models remain flagged as unpriced. Missing service tiers use standard rates instead of applying today's configuration to old usage. Incomplete logs cannot recover missing calls. Fork histories with rewritten event identities are not covered by the exact-event duplicate guarantee.

Official references: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [GPT-5.1-Codex Mini](https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
