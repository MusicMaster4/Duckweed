# Video setup

Reference: [Theo's walkthrough](https://youtu.be/D8PikZ1KhUo).

The walkthrough combines a central subscription proxy, several accounts, stable conversation routing, quota-aware account selection and Codex WebSocket transport. It also covers parallel agents, worktrees, review and test passes, and a private fleet that can keep working while a laptop sleeps. Its custom management dashboard is a private fork.

This PC now has a local proxy, separate provider logins, automatic quota collection, weekly-reset account priorities, session affinity and WebSocket-enabled Codex credentials. The replacement panel provides account addition, quota bars and reset countdowns. Claude and Codex were tested using the protocols Duckweed launches; Grok and Antigravity also returned live completions.

The shared endpoint is bound to this PC. A remote fleet, Tailscale access, additional purchased accounts and the creator's private dashboard were not installed. Subscription quotas and model availability follow each provider's account. Prices and throughput mentioned in the video are not guarantees for this setup.
