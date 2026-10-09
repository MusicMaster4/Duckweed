# Mobile experience

The Android companion opens Conversations first. Tabs keep their desktop titles, and folder paths remain searchable. Leaving a conversation, switching tabs, or opening another page dismisses the keyboard and preserves the draft.

## Shared agent interface

Android bundles the desktop React timeline for Codex, Claude, Grok, Cursor, and OpenCode. Thinking, tool calls, plans, goals, subagent details, and provider animations use the same components and normalized session state as desktop. The native header, approvals, questions, composer, and image attachments surround that timeline.

The renderer loads packaged assets through WebViewAssetLoader, blocks network requests and navigation, and receives JSON data without pairing credentials or a JavaScript native bridge. If the WebView renderer fails, the native transcript remains available. Connectivity changes pause the live state and disable unavailable controls.

Incoming updates preserve scroll position. Jump to latest follows new content again. Outgoing messages appear immediately, with delivery status and a retry action if sending fails.

## Agent controls

- Model and thinking effort selectors show the actual choices reported by the desktop provider and apply them to that desktop session.
- Stop interrupts the current agent turn.
- Conversation actions include history, resume, a new conversation, and closing the terminal. History availability follows the desktop provider; Cursor currently has no saved-session browser.
- History responses carry their request ID so an earlier response cannot populate a newer request.
- Scheduling supports 5, 15, or 30 minutes, a custom date and time, or completion of another working agent on the same desktop. Confirmed schedules appear above the composer and can be cancelled.
- Scheduling uses the desktop draft and delivery mechanism. Duckweed must remain open on desktop for delivery, including when its window is minimized.
- The slash-command picker continues to search names and descriptions, preserve its rows during updates, and offer real model and effort choices.

## Finding work

Search tabs by title, folder, branch, or agent. Search conversations by tab, terminal, agent, or model. Filter conversations to requests needing attention or unread responses. Empty views offer clear search, show all conversations, connect a desktop, or sync.

List differences are calculated off the UI thread. Clearing a query cancels a pending filtered result. Renames update detail headers, and terminals closed on desktop become read-only on mobile. Conversations and Tabs both support pull to refresh.

## Synchronization

The companion uses the encrypted Cloudflare relay. Tailscale connectivity does not bypass this transport.

Workspace snapshots and presence messages replace older state in the relay instead of building a stale queue. Completions remain independently recoverable. Authenticated payloads survive Firebase push failures, and the Worker starts the push in the background after storing the payload. Push delivery is a wake-up hint rather than a prerequisite for synchronization.

Foreground recovery downloads up to eight encrypted payloads in one request, prioritizing the latest workspace. The open conversation is checked every second; other pages every three seconds. Each paired desktop recovers independently. Android announces stored updates before acknowledging them, so a slow acknowledgement cannot hide new content. Timestamp-qualified acknowledgements protect newer heartbeat revisions that reuse the same message ID.

Opening a conversation requests its focused snapshot immediately, including while another refresh is pending. Focused agents receive up to 125 KB of normalized transcript data; background agents receive up to 10 KB. The total workspace budget is 220 KB. Old tool output, diffs, and background history yield space first. The phone retains already received rich items as the bounded tail advances; it does not download an unlimited historical transcript.

Desktop publication coalesces streaming changes, uses native sync ticks while minimized, and sends to paired phones concurrently. Desktop command polling also runs per device so one pairing's error does not discard commands recovered for another.

Expired relay deliveries are removed every 15 minutes and before deployment migrations, preserving active pairings and unexpired deliveries.

Refresh requests keep per-desktop timestamp baselines. Returning connectivity triggers relay recovery without resending user input. Offline state retains conversations and drafts and provides an explicit retry action.

The protocol additions are optional. Older snapshots still load with the native timeline; shared rendering and the new controls require an updated desktop and Android app.

## Verification

Coverage includes transcript byte budgets, provider structure and streaming IDs, encrypted command validation, relay collapse and stale acknowledgement behavior, Firebase failure recovery, JSON compatibility, cross-desktop refresh baselines, and workspace filters.

Android instrumentation checks all five bundled provider renderers and streamed updates, Conversations as the initial page, keyboard dismissal, search and filters, slash choices, closed-terminal handling, notifications, history, and optimistic sending. APK builds include the renderer assets.

Instrumentation uses emulator fixtures and a non-routable loopback relay endpoint. It does not measure physical phone-to-desktop latency against the production relay.
