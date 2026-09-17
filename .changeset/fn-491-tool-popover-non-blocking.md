---
"@runfusion/fusion": patch
---

summary: Desktop Chat, Activity, Notes and Usage panels no longer freeze scrolling or clicking on the board.
category: fix
dev: Removes the `.dashboard-tool-popover__backdrop` and `.usage-popover-backdrop` full-screen panes (elements plus CSS rules) and moves outside-click dismissal to the shared `useOutsidePointerDismiss` hook, which listens for a bubble-phase document `pointerdown` and marks inside events by event identity.
