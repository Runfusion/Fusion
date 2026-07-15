---
"@runfusion/fusion": patch
---

summary: Grok CLI failures now show the actual error instead of an empty chat message.
category: fix
dev: `GrokRuntimeAdapter` surfaces every silent-failure path as visible `onText` text plus an assistant message and `state.errorMessage`, instead of resolving into a blank bubble. Covers session-create failure (`describeCreateFailure`, which returns a dead session), prompt failure (`describePromptFailure`), a dead/disposed session with no ACP connection on a follow-up turn, and a turn ending with a non-`end_turn` stopReason and no assistant text. A turn with genuinely empty assistant text stays silent. Resolve-never-reject is preserved so chat/executor always receive a well-formed turn. Fixes the root cause behind the FN-7779 "No message" placeholder.
