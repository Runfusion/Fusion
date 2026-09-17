/* FNXC:ExternalSessions 2026-09-17-04:00: External observations are project-isolated metadata, never task lifecycle rows. */
CREATE TABLE IF NOT EXISTS project.external_session_hosts (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  host_id text NOT NULL,
  collector_version text NOT NULL,
  last_heartbeat_at text,
  PRIMARY KEY (project_id, host_id)
);
CREATE TABLE IF NOT EXISTS project.external_session_streams (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  host_id text NOT NULL,
  stream_id text NOT NULL,
  acknowledged_sequence bigint NOT NULL DEFAULT 0,
  last_event_id text,
  last_event_digest text,
  acknowledged_at text,
  PRIMARY KEY (project_id, host_id, stream_id),
  FOREIGN KEY (project_id, host_id) REFERENCES project.external_session_hosts(project_id, host_id) ON DELETE CASCADE,
  CONSTRAINT external_session_stream_sequence CHECK (acknowledged_sequence BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS project.external_sessions (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  id text NOT NULL,
  host_id text NOT NULL,
  provider text NOT NULL,
  native_session_id text NOT NULL,
  origin text NOT NULL DEFAULT 'observed',
  revision bigint NOT NULL,
  observation jsonb NOT NULL,
  observation_digest text NOT NULL,
  received_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  CONSTRAINT external_sessions_native_identity UNIQUE (project_id, host_id, provider, native_session_id),
  FOREIGN KEY (project_id, host_id) REFERENCES project.external_session_hosts(project_id, host_id) ON DELETE CASCADE,
  CONSTRAINT external_sessions_observed_origin CHECK (origin = 'observed'),
  CONSTRAINT external_sessions_revision CHECK (revision BETWEEN 1 AND 9007199254740991)
);
/*
FNXC:ExternalSessions 2026-09-18-00:00: Repair missing columns on restored schemas even when the ledger survives.
Required identity, revision and acknowledgement data cannot be invented for populated tables: missing required
values fail startup transactionally and require a supported restore. Nullable display/receipt columns are additive.
*/
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS project_id text NOT NULL;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS host_id text NOT NULL;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS collector_version text NOT NULL;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS last_heartbeat_at text;
ALTER TABLE project.external_session_hosts ALTER COLUMN project_id SET DEFAULT current_setting('fusion.project_id', true);
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS project_id text NOT NULL;
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS host_id text NOT NULL;
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS stream_id text NOT NULL;
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS acknowledged_sequence bigint NOT NULL;
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS last_event_id text;
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS last_event_digest text;
ALTER TABLE project.external_session_streams ADD COLUMN IF NOT EXISTS acknowledged_at text;
ALTER TABLE project.external_session_streams ALTER COLUMN project_id SET DEFAULT current_setting('fusion.project_id', true);
ALTER TABLE project.external_session_streams ALTER COLUMN acknowledged_sequence SET DEFAULT 0;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS project_id text NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS id text NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS host_id text NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS provider text NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS native_session_id text NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'observed';
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS revision bigint NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS observation jsonb NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS observation_digest text NOT NULL;
ALTER TABLE project.external_sessions ADD COLUMN IF NOT EXISTS received_at text NOT NULL;
ALTER TABLE project.external_sessions ALTER COLUMN project_id SET DEFAULT current_setting('fusion.project_id', true);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_hosts'::regclass AND conname = 'external_session_hosts_pkey') THEN
    ALTER TABLE project.external_session_hosts ADD CONSTRAINT external_session_hosts_pkey PRIMARY KEY (project_id, host_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_streams'::regclass AND conname = 'external_session_streams_pkey') THEN
    ALTER TABLE project.external_session_streams ADD CONSTRAINT external_session_streams_pkey PRIMARY KEY (project_id, host_id, stream_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_streams'::regclass AND conname = 'external_session_streams_project_id_host_id_fkey') THEN
    ALTER TABLE project.external_session_streams ADD CONSTRAINT external_session_streams_project_id_host_id_fkey FOREIGN KEY (project_id, host_id) REFERENCES project.external_session_hosts(project_id, host_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_streams'::regclass AND conname = 'external_session_stream_sequence') THEN
    ALTER TABLE project.external_session_streams ADD CONSTRAINT external_session_stream_sequence CHECK (acknowledged_sequence BETWEEN 0 AND 9007199254740991);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_sessions'::regclass AND conname = 'external_sessions_pkey') THEN
    ALTER TABLE project.external_sessions ADD CONSTRAINT external_sessions_pkey PRIMARY KEY (project_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_sessions'::regclass AND conname = 'external_sessions_native_identity') THEN
    ALTER TABLE project.external_sessions ADD CONSTRAINT external_sessions_native_identity UNIQUE (project_id, host_id, provider, native_session_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_sessions'::regclass AND conname = 'external_sessions_project_id_host_id_fkey') THEN
    ALTER TABLE project.external_sessions ADD CONSTRAINT external_sessions_project_id_host_id_fkey FOREIGN KEY (project_id, host_id) REFERENCES project.external_session_hosts(project_id, host_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_sessions'::regclass AND conname = 'external_sessions_observed_origin') THEN
    ALTER TABLE project.external_sessions ADD CONSTRAINT external_sessions_observed_origin CHECK (origin = 'observed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_sessions'::regclass AND conname = 'external_sessions_revision') THEN
    ALTER TABLE project.external_sessions ADD CONSTRAINT external_sessions_revision CHECK (revision BETWEEN 1 AND 9007199254740991);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "idxExternalSessionsRecent" ON project.external_sessions(project_id, received_at, id);
ALTER TABLE project.external_session_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_session_hosts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_session_hosts;
CREATE POLICY fusion_project_isolation ON project.external_session_hosts
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_session_hosts;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_session_hosts
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
ALTER TABLE project.external_session_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_session_streams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_session_streams;
CREATE POLICY fusion_project_isolation ON project.external_session_streams
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_session_streams;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_session_streams
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
ALTER TABLE project.external_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_sessions;
CREATE POLICY fusion_project_isolation ON project.external_sessions
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_sessions;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_sessions
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
