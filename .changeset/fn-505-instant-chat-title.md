---
"@runfusion/fusion": patch
---

summary: Name a new conversation from your first message before the assistant starts replying.
category: fix
dev: `ChatManager.sendMessage` now awaits `applyProvisionalSessionTitle` (new pure helper `packages/dashboard/src/chat-title.ts`) before any model work on all three paths — model loop, CLI-agent runner, and the `mentions` dispatch, which previously returned before the title was ever scheduled and left those conversations unnamed. `scheduleSessionTitleGeneration` stays detached and now writes the refined title through a compare-and-set against the provisional one, so a manual rename wins; its dead "retry with truncated fallback" branch is removed since the truncated title is written up front.
