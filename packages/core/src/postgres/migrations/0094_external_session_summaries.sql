/*
FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A):
AI summaries of a remote agent session, built as a NEW Fusion capability. This is deliberately not a parity
claim: the AgentPulse watcher that nominally produced summaries ran 817 times and left zero durable output, so
there is nothing here to reproduce (see docs/agentpulse-used-feature-inventory.md).

One current summary per session. A summary is only meaningful alongside WHAT IT COVERED, so the covered turn
range is stored with it: a summary of the first three turns of a nine-turn session is stale, not wrong, and the
reader can only tell the difference if coverage is recorded. Staleness is derived at read time by comparing
this coverage with the session's current turns, never stored, because a stored flag is wrong the instant the
next turn is ingested.

`summary` is nullable only for a session whose FIRST attempt failed. A later failure must never null it: the
previous summary plus "this failed at T" is strictly more useful than an empty pane during an inference outage,
so failure writes touch only the failure columns.
*/
CREATE TABLE IF NOT EXISTS project.external_session_summaries (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  session_id text NOT NULL,
  summary text,
  provider text,
  model text,
  -- Coverage of the stored summary: highest turn ordinal read, and how many turns went into it.
  through_ordinal bigint,
  turn_count bigint,
  generated_at text,
  status text NOT NULL,
  failure text,
  attempted_at text NOT NULL,
  PRIMARY KEY (project_id, session_id),
  FOREIGN KEY (project_id, session_id) REFERENCES project.external_sessions(project_id, id) ON DELETE CASCADE,
  CONSTRAINT external_session_summary_status CHECK (status IN ('ready', 'failed')),
  CONSTRAINT external_session_summary_ready_has_text CHECK (status <> 'ready' OR summary IS NOT NULL)
);
ALTER TABLE project.external_session_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_session_summaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_session_summaries;
CREATE POLICY fusion_project_isolation ON project.external_session_summaries
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_session_summaries;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_session_summaries
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
