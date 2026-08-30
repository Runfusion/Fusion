/* FNXC:TaskHistory 2026-08-28-02:23: Upgraded projects need the append-only implementation report ledger before task hydration or step completion can use it. */
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS step_reports jsonb DEFAULT '[]'::jsonb;
