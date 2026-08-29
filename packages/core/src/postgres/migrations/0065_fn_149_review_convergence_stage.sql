-- FN-149 durable bounded review-convergence state.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS review_convergence_stage integer DEFAULT 0;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS review_convergence_escalation_count integer DEFAULT 0;
