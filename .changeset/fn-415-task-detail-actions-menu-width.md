---
"@runfusion/fusion": patch
---

summary: Task header "..." menu is now wide enough to show each option on a single line.
category: fix
dev: Widens the `.detail-actions-menu` family in `TaskDetailModal.css` with token-based min/max width plus `white-space: nowrap` and ellipsis truncation on items and notes.
