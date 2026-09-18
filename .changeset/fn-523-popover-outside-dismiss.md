---
"@runfusion/fusion": patch
---

summary: Popovers now close on any outside press, including when you start dragging another window.
category: fix
dev: `useOutsidePointerDismiss` adds a `document` capture listener that defers its decision to a `setTimeout(0)` turn, guarded by event identity against the existing bubble path, so a press whose propagation is stopped before `document` (FloatingWindow header drag/resize, `useModalResizePersist` handle) is still decided exactly once. `FloatingWindow` additionally claims `engagedGestureZ()` (live ceiling + 7, never published into `--fusion-max-z`, never incrementing the shared counter) for the exact duration of a captured-pointer gesture.
