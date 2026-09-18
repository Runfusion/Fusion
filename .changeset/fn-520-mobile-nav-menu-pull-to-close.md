---
"@runfusion/fusion": patch
---

summary: Close the mobile navigation list by pulling it down from the top, like a drawer.
category: fix
dev: `MobileNavBar` now calls the shared `useDrawerDismissGesture` with `menuSurfaceRef` as its panel and `dismissMore` as its dismissal, and qualifies every `.mobile-more-item` row with `listRowGestureAttributes()`. A scrolled surface keeps native scrolling; the chevron and injected shell-connection content stay unqualified.
