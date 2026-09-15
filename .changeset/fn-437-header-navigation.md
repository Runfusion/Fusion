---
"@runfusion/fusion": patch
---

summary: Mobile header drops List, Notes and Activity; desktop header gains a New Task button.
category: fix
dev: On mobile the Header no longer renders `header-list-view-btn` (both producers), `header-activity-panel-btn` or `header-notes-panel-btn`; the footer navigation menu (`mobile-more-item-list`/`-notes`/`-activity`) is their single owner. The mobile Notes tool host is removed — the `NotesDrawer` bridge (`mobile-drawer-notes`) and its `App` branch are deleted in favour of the full-screen `NotesView` already hosted by `MainContentDrawer` from the footer menu entry — and the breakpoint-switch cleanup effect now closes an orphaned `notes` panel as well as `activity`. On desktop the shared `ViewActionButton kind="create"` (`mobile-header-new-task`) renders for every view, including `list`, where `ListView` keeps its own workflow-aware button.
