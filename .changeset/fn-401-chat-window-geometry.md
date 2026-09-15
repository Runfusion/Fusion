---
"@runfusion/fusion": patch
---

summary: Chat windows open at the task-window size, and snapping follows the window edge.
category: fix
dev: Adds `FLOATING_WINDOW_TASK_STANDARD_WIDTH/HEIGHT` and `detectSnapZoneForRect` in `floatingWindowGeometry.ts`, replacing the pointer-band `detectSnapZone`; the snap preview is portaled to `document.body` with a `nextSnapPreviewZ()` claim.
