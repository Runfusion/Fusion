---
"@runfusion/fusion": patch
---

summary: Returning to Board from Planning or Missions no longer shifts the board or leaves an empty band.
category: fix
dev: `useHeaderWorkflowSlot` resolves `#header-workflow-slot` in the layout phase, so a reactivated keep-alive view never paints Board's inline `.board-workflow-toolbar` fallback. Bounded retry, late-replacement observation and the genuinely-absent-slot fallback are unchanged.
