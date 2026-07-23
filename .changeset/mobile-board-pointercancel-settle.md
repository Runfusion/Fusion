---
"@runfusion/fusion": patch
---

summary: Fix mobile board snapping after interrupted swipes, flings, and vertical card scrolling.
category: fix
dev: useColumnScrollSnap now ignores pointercancel while the touch stream is live, settles to nearest-with-min-progress (resolveSettleTargetIndex), requires horizontal-dominant finger travel for pan intent, and lets a gesture begun mid-transit settle to plain nearest so a corrective drag wins.
