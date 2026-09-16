---
"@runfusion/fusion": patch
---

summary: Tasks always open in a movable window; pick Definition, Chat, or Activity as the default tab.
category: breaking
dev: Removes the project settings `openTasksInRightSidebar` and `openMobileTasksInPopup` — the floating task window is now the unconditional route for board cards, board-card `changes`/`retries`/`workflow` chips, and List row/card opens, with the main panel kept only as the phone-drawer fallback. Replaces the boolean `taskDetailChatFirst` with the enumerated `taskDetailDefaultTab` (`"definition" | "chat" | "activity"`, default `"activity"`), which now carries both the landing tab of an open with no explicit tab and the head order of the Activity / Chat / Definition tab trio. A persisted `taskDetailChatFirst: true` with no `taskDetailDefaultTab` is read as `"chat"`; that fallback is read-only, the legacy key is never written back, and no migration touches any of the three removed keys. `rightSidebarEnabled` and the right dock's own `openTaskInDock`/`closeDockTask` tools are unchanged.
