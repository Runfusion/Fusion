---
"@runfusion/fusion": patch
---

summary: Fix the Planning "Add comment to selection" button sitting below the fold in the Planning window.
category: fix
dev: The modal branch moved inside `FloatingWindow` (2026-07-26) but `PlanningModeModal.css` still sized the sheet as a full-viewport sheet; `min-height: 100dvh` beat `max-height: 100%`, so it overflowed its shorter host body. Scoped override under `.floating-window`.
