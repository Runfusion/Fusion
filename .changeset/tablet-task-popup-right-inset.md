---
"@runfusion/fusion": patch
---

summary: Remove the dead space on the right edge of the task pop-up on landscape tablets.
category: fix
dev: The `.floating-window__body` resize-handle clearance gutter was width-gated to 769-1024px; a new `@media (pointer: coarse)` block zeroes it (and hides the resize handles) for `.floating-window--task-detail` at any width, covering iPad Air/Pro landscape at 1180-1366 CSS px.
