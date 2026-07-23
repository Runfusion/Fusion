---
"@runfusion/fusion": patch
---

summary: Fix mobile board column snapping for mid-screen rests, fling overshoot, and false swipes.
category: fix
dev: useColumnScrollSnap now ignores pointercancel while the touch stream is live, settles to nearest-with-min-progress (resolveSettleTargetIndex), requires horizontal-dominant finger travel for pan intent, and lets a gesture begun mid-transit settle to plain nearest so a corrective drag wins.
