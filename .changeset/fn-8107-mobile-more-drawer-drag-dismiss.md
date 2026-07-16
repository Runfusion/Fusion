---
"@runfusion/fusion": patch
---

summary: Mobile "More" navigation drawer now closes with a swipe-down gesture.
category: fix
dev: Adds touch drag-to-dismiss to `.mobile-more-sheet` in MobileNavBar; dismiss engages only when the sheet is scrolled to top or dragged by the handle so interior scrolling is preserved.
