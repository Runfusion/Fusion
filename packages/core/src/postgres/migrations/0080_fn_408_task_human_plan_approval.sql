/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 persists the per-card human plan decision (armed flag plus the operator decision, message,
plan fingerprint, and review-episode identity). Deliberately a NEW column: the retired FN-234
`require_plan_approval` values must never arm this feature, so historical rows stay NULL.
*/
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS human_plan_approval jsonb;
