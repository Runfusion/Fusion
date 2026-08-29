ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS declared_symbols jsonb NOT NULL DEFAULT '[]'::jsonb;
