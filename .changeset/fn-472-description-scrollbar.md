---
"@runfusion/fusion": patch
---

summary: Task detail description now shows a visible scrollbar whenever its text overflows.
category: fix
dev: `.detail-definition-description-body` in `TaskDetailModal.css` paints its own track/thumb via token `color-mix(...)` and reserves `scrollbar-gutter: stable`; width stays inherited from the global scrollbar theme.
