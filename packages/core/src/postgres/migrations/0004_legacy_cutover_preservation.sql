/*
FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
Retired company-board, project-auth, and task-reviewer records remain queryable after SQLite cutover. Project-partition every key and relationship because embedded PostgreSQL is shared, and apply this as an independent version so targets that already recorded 0000 still receive the preservation tables before retrying migration.
*/
CREATE TABLE IF NOT EXISTS project.boards (
  project_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  workflow_id text NOT NULL,
  ordering integer NOT NULL DEFAULT 0,
  require_plan_approval integer NOT NULL DEFAULT 0,
  lfg_mode integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS "idxLegacyBoardsProjectOrdering" ON project.boards(project_id, ordering);

CREATE TABLE IF NOT EXISTS project.project_auth_users (
  project_id text NOT NULL,
  id text NOT NULL,
  email text NOT NULL,
  display_name text,
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthUsersEmail" ON project.project_auth_users(project_id, email);

CREATE TABLE IF NOT EXISTS project.project_auth_memberships (
  project_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id) REFERENCES project.project_auth_users(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthMembershipsUser" ON project.project_auth_memberships(project_id, user_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthMembershipsRole" ON project.project_auth_memberships(project_id, role);

CREATE TABLE IF NOT EXISTS project.project_auth_providers (
  project_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  metadata text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id) REFERENCES project.project_auth_users(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "idxLegacyProjectAuthProvidersIdentity" ON project.project_auth_providers(project_id, provider, provider_user_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthProvidersUser" ON project.project_auth_providers(project_id, user_id);

CREATE TABLE IF NOT EXISTS project.project_auth_sessions (
  project_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  membership_id text NOT NULL,
  session_token text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id) REFERENCES project.project_auth_users(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, membership_id) REFERENCES project.project_auth_memberships(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsToken" ON project.project_auth_sessions(project_id, session_token);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsUser" ON project.project_auth_sessions(project_id, user_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsMembership" ON project.project_auth_sessions(project_id, membership_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsExpiry" ON project.project_auth_sessions(project_id, expires_at);

CREATE TABLE IF NOT EXISTS project.task_reviewer_runs (
  project_id text NOT NULL,
  id text NOT NULL,
  task_id text NOT NULL,
  board_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  summary text,
  failure_reasons text,
  reviewer_agent_id text,
  rework_round integer NOT NULL DEFAULT 0,
  started_at text NOT NULL,
  completed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  invalidated_at text,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS "idxLegacyTaskReviewerRunsTask" ON project.task_reviewer_runs(project_id, task_id);
CREATE INDEX IF NOT EXISTS "idxLegacyTaskReviewerRunsStatus" ON project.task_reviewer_runs(project_id, status);
