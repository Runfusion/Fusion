---
"@runfusion/fusion": minor
---

summary: Archiving is no longer offered in Missions, Planning, or Chat; those lists show active items only.
category: breaking
dev: Removes the Chat archived toggle, per-row Restore button and `chat-context-archive` menu entry; the Planning `Show archived` filter, its `.planning-sidebar-filter` container and the per-row archive/unarchive button (the session list now requests `includeArchived: false` and filters archived rows defensively); and the Missions `Show archived` filter with its `.mission-list__filters` container, while the mission status selector only renders a disabled `archived` option for a mission that is already archived. Orphaned CSS (`.chat-archived-toggle`, `.chat-archived-toggle--active`, `.planning-sidebar-filter`, `.planning-sidebar-toggle-archived-link`, `.planning-sidebar-item-archive`, `.planning-sidebar-item.archived`, `.mission-list__filters`) is deleted. The data layer is untouched: `useChat.archiveSession` still backs ComposeChatPanel's draft-session cleanup, and the `archiveAiSession`/`unarchiveAiSession` APIs and server routes are unchanged, so previously archived rows remain stored but are no longer listed or restorable from these screens.
