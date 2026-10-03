# Mobile experience improvements

The Android companion now uses the desktop tab title as its primary workspace identity. Folder paths remain searchable. Renames update open detail headers, and terminals closed on desktop become read-only on mobile.

## Commands and conversations

- The `/` picker searches command names and descriptions. `/model` and `/effort` offer the actual choices reported by the selected desktop agent, including the current selection.
- Choosing an option fills the composer. Sending remains an explicit action.
- A command button makes the picker discoverable. Replacing an existing draft requires an explicit choice.
- The picker grows to fit its contents, with a bounded scrolling region. Transcript updates preserve its rows and scroll position.
- Conversation cards show the desktop tab name, agent/model, status, and latest response preview.
- A latest-message button returns to the bottom after scrolling up. Incoming content does not force the reader back down.

## Finding work

- Search tabs by title, folder, branch, or agent. Search conversations by tab, terminal, agent, or model.
- Filter conversations to requests needing attention or unread responses.
- Empty views offer a useful action: clear search, show all conversations, connect a desktop, or sync.
- List differences are calculated off the UI thread. Rapidly clearing a search cancels any pending filtered result.
- Typography, contrast, card details, and input controls use the existing dark surfaces and desktop colors.

## Synchronization

Foreground refreshes are coalesced. Each paired desktop has its own timestamp baseline, so different desktop clocks cannot prematurely finish or indefinitely delay another desktop's refresh. Baselines are captured after cached state has loaded. Superseded requests cannot stop a newer refresh indicator.

Returning connectivity triggers refresh and relay recovery. Foreground recovery fetches delayed push payloads promptly without resending user input. Offline state retains conversations and drafts; refresh failures include a concrete retry action.

The command options are an additive protocol field. Older snapshots still load, but guided model/effort choices require an updated desktop.

## Design reference

Applied the principles discussed in [The Reason Why Some Apps Feel Expensive, But Most Don't](https://www.youtube.com/watch?v=SAxKK5fbjbc): anticipate the next action, make transitions purposeful, maintain consistency, provide useful empty states, and explain recovery from errors. The reference was reviewed through its English transcript.

## Verification

Unit coverage includes command filtering and argument choices, JSON compatibility, cross-desktop refresh baselines, workspace filters, and desktop snapshot generation. Android instrumentation covers search/filter interactions, desktop titles, command selection, picker stability during updates, closed-terminal handling, notifications, history, and optimistic sending.

Instrumentation uses local fixture snapshots and a non-routable loopback relay endpoint. It does not replace a physical phone-to-desktop test against the production relay.
