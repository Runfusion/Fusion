---
"@runfusion/fusion": patch
---

summary: Task header "..." menu now stays inside the task window and scrolls instead of overflowing it.
category: fix
dev: Task Detail measures its host shell while the header overflow menu is open and publishes `--detail-actions-menu-max-height` (80% of the shell height) on the anchor; the base and mobile `.detail-actions-menu` rules consume it with the previous viewport bound as fallback.
