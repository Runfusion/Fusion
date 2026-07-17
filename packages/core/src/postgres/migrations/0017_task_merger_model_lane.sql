-- FNXC:Settings-MergerModel 2026-07-16-12:00: existing project task rows need independent merger pair and thinking overrides.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS merger_model_provider text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS merger_model_id text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS merger_thinking_level text;
