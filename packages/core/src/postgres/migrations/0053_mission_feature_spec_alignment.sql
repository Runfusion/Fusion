-- FNXC:SpecLockMissionAlignment 2026-08-10-16:17: persist the deterministic task drift projection independently of mission delivery state, so production reconciliation does not discard divergence.
ALTER TABLE project.mission_features
  ADD COLUMN IF NOT EXISTS spec_alignment text;
