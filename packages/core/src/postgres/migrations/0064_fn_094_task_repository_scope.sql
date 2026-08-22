-- FNXC:RepositoryScope 2026-08-20-23:07: Persist explicit workspace task intent independently of acquired checkout metadata.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS repository_scope jsonb;
