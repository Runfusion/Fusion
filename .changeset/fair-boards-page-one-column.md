---
"@runfusion/fusion": patch
---

summary: Mobile board swipes from the first or last column now advance one column instead of two.
category: fix
dev: `scrollLeftToCenterColumn` clamps to the scroller's reachable range so edge columns (narrower than the phone viewport) count as centered; `commitDirectionalPage` also clamps its mid-transit origin against the gesture-start column so drag travel can never be counted twice.
