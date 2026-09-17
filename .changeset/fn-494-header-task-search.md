---
"@runfusion/fusion": patch
---

summary: Header search results now scroll, and picking a task clears the field and opens the task.
category: fix
dev: `TaskSearchInput.selectTask` always closes the panel, calls `onSearchChange("")` and forwards the task; the `onSearchChange(task.id)` fallback is removed and both floating `Header` hosts now pass `onSelectTask`. The popover no longer cancels `mousedown` inside `.task-search-results-scroll`, ignores capture-phase `scroll` events originating in the panel, adds `overscroll-behavior: contain` / `touch-action: pan-y`, and supports ArrowDown/ArrowUp between result cards.
