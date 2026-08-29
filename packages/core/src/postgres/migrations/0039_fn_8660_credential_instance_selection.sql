/*
FNXC:CredentialInstanceSelection 2026-08-01-05:53:
Task credential-instance companions are persisted-but-inert in this slice. The project-partitioned
`tasks` table owns model overrides, so upgrades must add these nullable columns in the same schema.
*/
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS credential_instance_id text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS validator_credential_instance_id text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS planning_credential_instance_id text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS merger_credential_instance_id text;
