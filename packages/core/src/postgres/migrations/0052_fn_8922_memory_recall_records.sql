/* FNXC:MemoryRecall 2026-08-10-11:03: Exact hashes are a last-resort backstop; near-duplicate safety is provided by appendRecall's advisory lock. */
CREATE TABLE IF NOT EXISTS project.memory_recall_records (
 project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), id text NOT NULL,
 kind text NOT NULL, content text NOT NULL, content_hash text NOT NULL, source jsonb NOT NULL,
 tags jsonb NOT NULL DEFAULT '[]'::jsonb, graph_node_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at text NOT NULL, updated_at text NOT NULL,
 PRIMARY KEY (project_id, id),
 CONSTRAINT memory_recall_records_project_kind_hash_key UNIQUE (project_id, kind, content_hash),
 CONSTRAINT memory_recall_records_kind_check CHECK (kind IN ('decision','preference','solution'))
);
CREATE INDEX IF NOT EXISTS "idxMemoryRecallRecordsKindCreated" ON project.memory_recall_records(project_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS "idxMemoryRecallRecordsCreated" ON project.memory_recall_records(project_id, created_at DESC);
ALTER TABLE project.memory_recall_records ENABLE ROW LEVEL SECURITY; ALTER TABLE project.memory_recall_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.memory_recall_records;
CREATE POLICY fusion_project_isolation ON project.memory_recall_records USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true)) WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.memory_recall_records;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.memory_recall_records FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
