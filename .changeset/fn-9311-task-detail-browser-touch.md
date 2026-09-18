---
"@runfusion/fusion": patch
---

summary: Keep tablet task windows responsive to touch resize gestures.
category: fix
dev: Reserves a shared geometry inset for tablet touch viewports so FloatingWindow's corner/edge resize handles stay inside the visible viewport at tablet touch widths, and memoizes the resolved minimum window size so callers passing an inline `minSize` object no longer invalidate geometry-dependent effects on every render.
