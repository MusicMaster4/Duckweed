# Video setup

Reference: [Theo's walkthrough](https://youtu.be/D8PikZ1KhUo).

The walkthrough combines a central subscription proxy, several accounts, stable conversation routing, quota-aware account selection and Codex WebSocket transport. It also covers parallel agents, worktrees, review and test passes, and a private fleet that can keep working while a laptop sleeps. Its custom management dashboard is a private fork.

This PC now has a local proxy, separate provider logins, automatic quota collection, weekly-reset account priorities, session affinity and WebSocket-enabled Codex credentials. The replacement panel provides account addition, quota bars and reset countdowns. Claude and Codex were tested using the protocols Duckweed launches; Grok and Antigravity also returned live completions.

The shared endpoint is bound to this PC. A remote fleet, Tailscale access, additional purchased accounts and the creator's private dashboard were not installed. Subscription quotas and model availability follow each provider's account. Prices and throughput mentioned in the video are not guarantees for this setup.

## November UI reference

Reference: [Nobody Is Competing With Anthropic](https://www.youtube.com/watch?v=yh5IAUow4Hc&t=1470s). The supplied timestamp at 26:17 is in the subscription discussion; the management interface is visible around 24:30 and the pool charts around 25:13. The user also supplied a direct screenshot of the chart view.

Visible features reproduced in the installed native manager: compact black sidebar, provider ledger with quota columns and reset countdowns, aggregate pool balance, next reset time and gain, per-account refresh and native manual resets, card layout, search and sort, recorded versus projected pool curves, current-time marker, burn rate, depletion estimates, hover details and plan-weight normalization. The existing native quota-window calendar, configuration and other management pages remain available. Account-name hiding addresses the recording-mode problem discussed around 38:08.

This is an implementation of the observable interface and behavior. The creator's private fork and its private historical data are not available. Local historical data begins at installation, future recovery is an estimate, and no subscription resets or purchases were performed during validation.
