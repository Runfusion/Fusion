---
"@runfusion/fusion": patch
---

summary: Mobile back now reliably dismisses the open task detail, including right after closing and reopening it.
category: fix
dev: Hardens useNavigationHistory against close-reopen races and history/stack desync so popstate (and the fusion:native-back event) deterministically dismisses every task-detail surface.
