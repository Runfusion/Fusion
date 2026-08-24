---
"@runfusion/fusion": patch
---

summary: The mobile project switcher and header overflow menu now scroll internally when their lists are long.
category: fix
dev: Capped .mobile-project-switch-dropdown and .mobile-overflow-menu to max-height: min(480px, calc(100vh - 120px)) with overflow-y: auto and overscroll-behavior: contain, matching the desktop project selector.
