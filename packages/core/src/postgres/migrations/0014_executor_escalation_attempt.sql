-- FNXC:ExecutorEscalation 2026-07-16-21:00: Persist the single-shot escalation latch so executor restarts cannot repeat a costly alternate model/node attempt.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS executor_escalation_attempted integer DEFAULT 0;
