---
"@runfusion/fusion": patch
---

summary: Move the room thinking-effort control from the room header into the composer Brain icon next to attach.
category: fix
dev: Rooms now reuse ChatThinkingLevelControl in level-only mode (showTargetSection={false}); header <select> and its CSS/shell removed. Persistence via rooms.updateRoomSettings({ thinkingLevel }) unchanged.
