ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS proposal_claim_id text;
CREATE UNIQUE INDEX IF NOT EXISTS "uqTasksProjectProposalClaimId"
  ON project.tasks (project_id, proposal_claim_id)
  WHERE proposal_claim_id IS NOT NULL;
