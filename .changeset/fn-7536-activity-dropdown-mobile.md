---
"@runfusion/fusion": patch
---

summary: Fix task-detail Activity view dropdown not opening reliably on mobile.
category: fix
dev: Guards the Activity menu's window resize/orientationchange/scroll close-listener with the same opening-tap timing guard already used for visualViewport, and exempts scroll events originating in the `.detail-tabs` scroller, so a same-gesture mobile tap echo (Android/iOS, fixed modal or `.floating-window--task-detail` popup) no longer closes the menu the instant it opens.
