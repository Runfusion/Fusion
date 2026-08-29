CREATE INDEX IF NOT EXISTS "idxTasksProjectSourceAgentId"
  ON project.tasks USING btree ("project_id", "source_agent_id")
  WHERE "source_agent_id" IS NOT NULL;
