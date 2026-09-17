/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 persists the per-card human DELIVERY lock: the armed flag and its generation, the operator
decision with its resolved destination (`merge` / `create-pr`), the candidate identity the decision
was made against, the dispatch receipt (including a created PR link), and an accepted rejection with
its correction-remediation state.

Deliberately a NEW column rather than a reuse of `auto_merge` or `human_plan_approval`: a historically
disabled auto-merge must never arm this lock, and arming the lock must never re-enable auto-merge for
the automatic lanes. Historical rows stay NULL, which means "no per-card delivery requirement" and
preserves every existing merge policy byte-for-byte.
*/
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS human_merge_approval jsonb;
