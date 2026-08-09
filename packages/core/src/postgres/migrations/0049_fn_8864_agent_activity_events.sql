-- FNXC:AgentActivityStream 2026-08-09-09:09: a counter row, unlike a SEQUENCE, rolls back with an aborted outbox write and therefore preserves commit-order cursor semantics.
CREATE TABLE IF NOT EXISTS project.agent_activity_events (
 project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), seq bigint NOT NULL, event_id text NOT NULL,
 agent_id text NOT NULL, agent_attribution text NOT NULL, task_id text, type text NOT NULL, from_agent_id text, to_agent_id text,
 summary text NOT NULL, occurred_at text NOT NULL, created_at text NOT NULL, metadata jsonb,
 PRIMARY KEY (project_id, seq), UNIQUE (project_id, event_id),
 CONSTRAINT agent_activity_events_type_check CHECK (type IN ('task:started','task:handed-off','task:completed','agent:state-changed','workflow:gate-passed','workflow:gate-failed','approval:requested')),
 CONSTRAINT agent_activity_events_attribution_check CHECK (agent_attribution IN ('agent','lane','actor'))
);
CREATE INDEX IF NOT EXISTS "idxAgentActivityEventsSeq" ON project.agent_activity_events(project_id, seq DESC);
CREATE INDEX IF NOT EXISTS "idxAgentActivityEventsAgentSeq" ON project.agent_activity_events(project_id, agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS "idxAgentActivityEventsTaskSeq" ON project.agent_activity_events(project_id, task_id, seq DESC);
CREATE INDEX IF NOT EXISTS "idxAgentActivityEventsTypeSeq" ON project.agent_activity_events(project_id, type, seq DESC);
ALTER TABLE project.agent_activity_events ENABLE ROW LEVEL SECURITY; ALTER TABLE project.agent_activity_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.agent_activity_events;
CREATE POLICY fusion_project_isolation ON project.agent_activity_events USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true)) WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.agent_activity_events;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.agent_activity_events FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
CREATE TABLE IF NOT EXISTS project.agent_activity_event_seq (project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), last_seq bigint NOT NULL DEFAULT 0, PRIMARY KEY (project_id));
ALTER TABLE project.agent_activity_event_seq ENABLE ROW LEVEL SECURITY; ALTER TABLE project.agent_activity_event_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.agent_activity_event_seq;
CREATE POLICY fusion_project_isolation ON project.agent_activity_event_seq USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true)) WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.agent_activity_event_seq;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.agent_activity_event_seq FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
