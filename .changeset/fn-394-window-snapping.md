---
"@runfusion/fusion": minor
---

summary: Every dashboard dialog is now a window: snap it to a half or the work area, and it always opens at its usual size.
category: feature
dev: FN-394 adds `floatingWindowGeometry.ts` (snap/cascade/restore maths), a `left-nav` window-manager landmark, and a per-instance pristine-window cascade cohort. `persistGeometryKey`/`cascadeOffsetIndex` are accepted but ignored: no window reads or writes durable geometry any more, and the task/Chat z-band was merged into the single shared window stack. The previously static dashboard dialogs (confirmation, provider sign-in, agent creation, secrets, missions, workflow creation and prompt expansion, usage, pricing table, and the view-owned confirmations) are hosted by the same `FloatingWindow` through one shared `floating-window--dialog` class; blocking semantics, close guards, and mobile sheets are unchanged.
