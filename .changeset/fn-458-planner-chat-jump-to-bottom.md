---
"@runfusion/fusion": patch
---

summary: Task modal chat now offers a Latest button to return to the newest message.
category: fix
dev: Adds `task-planner-chat-jump-to-bottom` in TaskPlannerChatTab, rendered as a sibling of the virtualized scroller inside a new `.task-planner-chat-transcript-viewport`; the click commands `useVirtualizedList.scrollToBottom()` then the existing fenced `anchorTranscriptToBottom` so tail following is re-armed. Reuses the `taskChat.jumpToLatestMessage` / `taskChat.latest` keys.
