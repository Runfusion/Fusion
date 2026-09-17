---
"@runfusion/fusion": patch
---

summary: Show the workflow selector only on Board and List, and move List into the footer More menu.
category: fix
dev: Header renders `#header-workflow-slot` only when `view` is `board`/`list` (both mobile and tablet/desktop producers) and no longer renders the standalone `header-list-view-btn`; `buildDashboardNavigationEntries` adds an overflow `list` destination (`desktop-nav-list`) and `LeftSidebarNav` restores `sidebar-nav-list` after Board. Graph, Planning, and Missions keep publishing their workflow selection through the portal consumers without rendering a control.
