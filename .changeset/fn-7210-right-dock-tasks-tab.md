---
"@runfusion/fusion": minor
---

summary: Add a Tasks tab to the right sidebar that shows the last-viewed task or a clickable task list.
category: feature
dev: New `tasks` overflow-view registry entry + `DockTaskList` empty state. The FN-7169 dock-task overlay is re-anchored to the Tasks tab; the task snapshot now persists across tab switches and clears on back/close or surface teardown. Default dock view stays `files`.
