/* FNXC:ExternalBlock 2026-08-28-03:48: Upgraded projects need the structured external-obstacle freeze before task hydration or recovery can inspect it. */
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS external_block jsonb;
