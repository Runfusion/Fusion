-- FNXC:AIMergeReviewReconciliation 2026-08-20-21:56: FN-090 stores reconciliation state as one project-scoped task column rather than reconstructing blockers from task-log prose.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS ai_merge_review_reconciliation text;
