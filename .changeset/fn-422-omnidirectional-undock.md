---
"@runfusion/fusion": patch
---

summary: Undock a docked window by dragging it in any direction, not only downwards.
category: fix
dev: `shouldDetachSnappedWindow` in `floatingWindowGeometry.ts` replaces the 24px downward guard in `FloatingWindow`'s drag handler and reuses `FLOATING_WINDOW_DRAG_THRESHOLD_PX`; `FLOATING_WINDOW_DETACH_PX` remains only as `resolveDetachedRect`'s re-anchor offset.
