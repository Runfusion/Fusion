---
"@runfusion/fusion": patch
---

summary: Task-detail Priority dropdown now matches the Oversight dropdown's size, border, and typography.
category: fix
dev: Removed the Priority-only forced select/option uppercase, added a neutral chip background scoped to `.detail-priority-chip.card-priority-badge--normal` for the untinted `normal` level, and reused the FN-7585 shared `--btn-border-width`/`--border`/`--detail-control-border-radius`/`--detail-priority-control-min-height` tokens so both dropdowns render as one control style across desktop and the mobile oversight-overflow surface.
