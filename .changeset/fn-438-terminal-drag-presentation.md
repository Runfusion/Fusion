---
"@runfusion/fusion": patch
---

summary: Switch the terminal between pinned and detached by dragging it; the toggle button is gone.
category: fix
dev: Removes the `terminal-popout-toggle` header button and its CSS. The pinned `.terminal-header` now arms `handlePinnedDetachPointerDown` with FloatingWindow's interactive-element filter and the shared `FLOATING_WINDOW_DRAG_THRESHOLD_PX`, and re-pinning is decided from a new optional `FloatingWindow` prop `onDragGestureEnd` (validated `moved`/`snapMode`/clamped rect/bounds) instead of a capture-phase document listener that measured stale DOM geometry.
