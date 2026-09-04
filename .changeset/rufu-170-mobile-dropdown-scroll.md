---
"@runfusion/fusion": patch
---

summary: The mobile project switcher and header overflow menu now scroll internally when their lists are long.
category: fix
dev: Capped .mobile-project-switch-dropdown and .mobile-overflow-menu with tokenized --dropdown-max-height / --dropdown-viewport-gutter, 100svh then 100dvh (never 100vh), overflow-y: auto, and overscroll-behavior: contain.
