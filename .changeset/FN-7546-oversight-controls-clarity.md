---
"@runfusion/fusion": patch
---

summary: Clarify task-detail oversight Nudge/Explain controls: visible label, disabled reason, always-openable Explain panel.
category: fix
dev: TaskDetailModal now renders a `detail-oversight-controls-label` group label and `detail-overseer-nudge-disabled-reason` helper text (both gated by the existing oversight-cluster visibility condition); Explain no longer disables on `!canExplainOverseer` since it is read-only. Nudge's `canNudgeOverseer` gate and Stop's confirm dialog are unchanged.
