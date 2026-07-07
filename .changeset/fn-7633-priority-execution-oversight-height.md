---
"@runfusion/fusion": patch
---

summary: Align Priority and Execution-mode control heights with the Oversight dropdown in task detail.
category: fix
dev: `.detail-priority-chip`, `.detail-execution-mode-toggle`, and `.detail-oversight-menu-trigger` in TaskDetailModal.css now all pin an explicit `height` (not just `min-height`) from the shared `--detail-priority-control-min-height` token, so none can outgrow or undershoot the others regardless of flex stretch behavior; extends the FN-7585/FN-7618 shared-token pattern.
