-- FNXC:PostgresSchema 2026-06-24-03:30:
-- Fresh Drizzle migration baseline. This is the single authoritative schema
-- snapshot of the final SQLite schema (SCHEMA_VERSION=128) translated to
-- PostgreSQL. The 128 hand-rolled SQLite migrations are NOT reimplemented;
-- this file materializes their final result.
--
-- Three-database topology (VAL-SCHEMA-008): project/central/archive are three
-- distinct PostgreSQL schemas in one cluster, mirroring the three SQLite files
-- (fusion.db / fusion-central.db / archive.db).
--
-- Type mapping (binding):
--   INTEGER PRIMARY KEY AUTOINCREMENT → integer GENERATED ALWAYS AS IDENTITY
--     (sequence continuity: VAL-SCHEMA-006)
--   JSON-encoded TEXT → jsonb (round-trip shape parity: VAL-SCHEMA-004)
--   BLOB → bytea (secrets ciphertext/nonce)
--   INTEGER 0/1 flags → integer (preserved verbatim, no boolean coercion)
--   TEXT timestamps → text (ISO-8601 strings preserved)
--   REAL → real
--
-- CHECK constraints, FK cascade rules, and unique indexes preserved one-for-one
-- (VAL-SCHEMA-002, VAL-SCHEMA-003, VAL-SCHEMA-005).
--
-- FTS5 tables (tasks_fts, archived_tasks_fts) are replaced by tsvector/GIN
-- generated columns (search_vector) on the tasks and archived_tasks tables
-- (fts-replacement feature, U7). See VAL-SEARCH-001..007.

-- ── Schemas ──────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS project;
CREATE SCHEMA IF NOT EXISTS central;
CREATE SCHEMA IF NOT EXISTS archive;

-- ════════════════════════════════════════════════════════════════════
-- PROJECT SCHEMA
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS project.tasks (
  id text PRIMARY KEY,
  -- FNXC:MultiProjectIsolation 2026-07-10: per-project partition key for
  -- embedded-PG multi-project isolation (shared cluster/db/schema). Populated
  -- from the store's bound projectId on insert; filtered on every backend-mode
  -- read/claim/list. Nullable so SQLite mode + legacy rows are unaffected.
  project_id text,
  lineage_id text,
  title text,
  description text NOT NULL,
  priority text DEFAULT 'normal',
  "column" text NOT NULL,
  status text,
  size text,
  review_level integer,
  current_step integer DEFAULT 0,
  worktree text,
  blocked_by text,
  overlap_blocked_by text,
  paused integer DEFAULT 0,
  user_paused integer DEFAULT 0,
  paused_reason text,
  base_branch text,
  branch text,
  auto_merge integer,
  auto_merge_provenance text,
  execution_start_branch text,
  base_commit_sha text,
  model_preset_id text,
  model_provider text,
  model_id text,
  validator_model_provider text,
  validator_model_id text,
  planning_model_provider text,
  planning_model_id text,
  merger_model_provider text,
  merger_model_id text,
  merger_thinking_level text,
  merge_retries integer,
  workflow_step_retries integer,
  resume_limbo_count integer DEFAULT 0,
  graph_resume_retry_count integer DEFAULT 0,
  resume_limbo_tip_sha text,
  resume_limbo_step_signature text,
  execute_requeue_loop_count integer DEFAULT 0,
  execute_requeue_loop_signature text,
  recovery_retry_count integer,
  task_done_retry_count integer DEFAULT 0,
  -- FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker (nullable ISO timestamp).
  bulk_completion_refusal_at text,
  -- FNXC:WorkflowIrPin 2026-07-19-03:10: U9b/KTD-3 durable per-node-entry IR pin (see migration 0026).
  workflow_ir_pin text,
  workflow_ir_pin_node_id text,
  workflow_ir_pin_column_id text,
  -- FNXC:LegacyAdoption 2026-07-19-03:10: U9b/KTD-8 one-time adoption stamp (see migration 0026).
  legacy_adopted_at text,
  worktree_session_retry_count integer DEFAULT 0,
  completion_handoff_limbo_recovery_count integer DEFAULT 0,
  merge_conflict_bounce_count integer DEFAULT 0,
  merge_audit_bounce_count integer DEFAULT 0,
  merge_transient_retry_count integer DEFAULT 0,
  -- FNXC:SqliteFinalRemoval 2026-06-25: retry/stuck counters missed in initial snapshot
  stuck_kill_count integer DEFAULT 0,
  post_review_fix_count integer DEFAULT 0,
  plan_review_replan_count integer DEFAULT 0,
  verification_failure_count integer DEFAULT 0,
  branch_conflict_recovery_count integer DEFAULT 0,
  reviewer_context_retry_count integer DEFAULT 0,
  reviewer_fallback_retry_count integer DEFAULT 0,
  next_recovery_at text,
  error text,
  summary text,
  thinking_level text,
  validator_thinking_level text,
  planning_thinking_level text,
  execution_mode text DEFAULT 'standard',
  token_usage_input_tokens bigint,
  token_usage_output_tokens bigint,
  token_usage_cached_tokens bigint,
  token_usage_cache_write_tokens bigint,
  token_usage_total_tokens bigint,
  token_usage_first_used_at text,
  token_usage_last_used_at text,
  token_usage_model_provider text,
  token_usage_model_id text,
  token_usage_per_model jsonb,
  token_budget_soft_alerted_at text,
  token_budget_hard_alerted_at text,
  token_budget_override jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  column_moved_at text,
  first_execution_at text,
  cumulative_active_ms bigint,
  execution_started_at text,
  execution_completed_at text,
  dependencies jsonb DEFAULT '[]',
  steps jsonb DEFAULT '[]',
  log jsonb DEFAULT '[]',
  attachments jsonb DEFAULT '[]',
  steering_comments jsonb DEFAULT '[]',
  comments jsonb DEFAULT '[]',
  review jsonb,
  review_state jsonb,
  workflow_step_results jsonb DEFAULT '[]',
  pr_info jsonb,
  pr_infos jsonb,
  issue_info jsonb,
  github_tracking jsonb,
  gitlab_tracking jsonb,
  source_issue_provider text,
  source_issue_repository text,
  source_issue_external_issue_id text,
  source_issue_number integer,
  source_issue_url text,
  source_issue_closed_at text,
  merge_details jsonb,
  workspace_worktrees jsonb,
  break_into_subtasks integer DEFAULT 0,
  no_commits_expected integer DEFAULT 0,
  enabled_workflow_steps jsonb DEFAULT '[]',
  modified_files jsonb DEFAULT '[]',
  mission_id text,
  slice_id text,
  scope_override integer,
  scope_override_reason text,
  scope_auto_widen jsonb DEFAULT '[]',
  assigned_agent_id text,
  paused_by_agent_id text,
  assignee_user_id text,
  -- FNXC:SqliteFinalRemoval 2026-06-25: node routing fields missed in initial snapshot
  node_id text,
  effective_node_id text,
  effective_node_source text,
  source_type text,
  source_agent_id text,
  source_run_id text,
  source_session_id text,
  source_message_id text,
  source_parent_task_id text,
  source_metadata jsonb,
  proposal_claim_id text,
  checked_out_by text,
  checked_out_at text,
  checkout_node_id text,
  checkout_run_id text,
  checkout_lease_renewed_at text,
  checkout_lease_epoch bigint DEFAULT 0,
  deleted_at text,
  allow_resurrection integer DEFAULT 0,
  transition_pending text,
  custom_fields jsonb DEFAULT '{}',
  -- FNXC:TaskStoreSearch 2026-06-24-12:30:
  -- Full-text search vector (tsvector) replacing the SQLite FTS5 tasks_fts
  -- table. GENERATED ALWAYS so PostgreSQL keeps it in sync on write
  -- (VAL-SEARCH-002/003/004). 'simple' config for code-like tokenization
  -- parity with FTS5. Value-aware: only regenerates when id/title/description/
  -- comments change (VAL-SEARCH-006).
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(id, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(comments::text, ''))
  ) STORED
);

-- FNXC:MultiProjectIsolation 2026-07-11: per-project config isolation. The old
-- singleton row (id = 1, CHECK-enforced) forced every project in the shared
-- `project` schema to share one taskPrefix / maxConcurrent / maxWorktrees. The
-- row is now keyed per-project on project_id (the PK); `id` stays for column
-- parity (always 1) but is no longer the PK / no longer CHECK-constrained.
CREATE TABLE IF NOT EXISTS project.config (
  id integer DEFAULT 1,
  project_id text NOT NULL DEFAULT '' PRIMARY KEY,
  next_id integer DEFAULT 1,
  next_workflow_step_id integer DEFAULT 1,
  -- FNXC:SqliteFinalRemoval 2026-06-28: WF-id counter for createWorkflowDefinition
  -- (SQLite used a __meta row; PG has no __meta table).
  next_workflow_definition_id integer DEFAULT 1,
  settings jsonb DEFAULT '{}',
  workflow_steps jsonb DEFAULT '[]',
  updated_at text
);

CREATE TABLE IF NOT EXISTS project.distributed_task_id_state (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  prefix text NOT NULL,
  next_sequence integer NOT NULL,
  committed_cluster_task_count integer NOT NULL,
  last_committed_task_id text,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, prefix)
);

CREATE TABLE IF NOT EXISTS project.distributed_task_id_reservations (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  reservation_id text NOT NULL,
  prefix text NOT NULL,
  node_id text NOT NULL,
  sequence integer NOT NULL,
  task_id text NOT NULL,
  status text NOT NULL,
  reason text,
  expires_at text NOT NULL,
  committed_at text,
  aborted_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, reservation_id),
  CONSTRAINT distributed_task_id_reservations_prefix_fkey
    FOREIGN KEY (project_id, prefix) REFERENCES project.distributed_task_id_state(project_id, prefix) ON DELETE CASCADE,
  CONSTRAINT distributed_task_id_reservations_status_check
    CHECK (status IN ('reserved', 'committed', 'aborted', 'expired')),
  CONSTRAINT distributed_task_id_reservations_reason_check
    CHECK (reason IS NULL OR reason IN ('abort', 'expired', 'failed-create')),
  CONSTRAINT distributed_task_id_reservations_prefix_sequence_unique UNIQUE (project_id, prefix, sequence),
  CONSTRAINT distributed_task_id_reservations_prefix_task_id_unique UNIQUE (project_id, prefix, task_id)
);
CREATE INDEX IF NOT EXISTS "idxDistributedTaskIdReservationsPrefixStatus"
  ON project.distributed_task_id_reservations(project_id, prefix, status);
CREATE INDEX IF NOT EXISTS "idxDistributedTaskIdReservationsExpiry"
  ON project.distributed_task_id_reservations(status, expires_at);

-- FNXC:SymbolLock 2026-07-30-14:10: baseline creates the table only; 0025
-- applies RLS after 0006 defines the ownership trigger and policy machinery.
CREATE TABLE IF NOT EXISTS project.symbol_locks (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  symbol_key text NOT NULL,
  owner_task_id text NOT NULL,
  mission_id text,
  feature_id text,
  lineage_id text,
  node_id text,
  agent_id text,
  status text NOT NULL,
  acquired_at text NOT NULL,
  renewed_at text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, symbol_key),
  CONSTRAINT symbol_locks_status_check CHECK (status IN ('held', 'released', 'expired'))
);
CREATE INDEX IF NOT EXISTS "idxSymbolLocksOwner"
  ON project.symbol_locks(project_id, owner_task_id);
CREATE INDEX IF NOT EXISTS "idxSymbolLocksExpiry"
  ON project.symbol_locks(status, expires_at);

CREATE TABLE IF NOT EXISTS project.workflow_steps (
  id text PRIMARY KEY,
  template_id text,
  name text NOT NULL,
  description text NOT NULL,
  mode text NOT NULL DEFAULT 'prompt',
  phase text NOT NULL DEFAULT 'pre-merge',
  prompt text NOT NULL DEFAULT '',
  gate_mode text NOT NULL DEFAULT 'advisory',
  tool_mode text,
  script_name text,
  enabled integer NOT NULL DEFAULT 1,
  default_on integer DEFAULT 0,
  model_provider text,
  model_id text,
  migrated_fragment_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.workflows (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  ir jsonb NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}',
  kind text NOT NULL DEFAULT 'workflow',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxWorkflowsCreatedAt" ON project.workflows(created_at);

CREATE TABLE IF NOT EXISTS project.task_workflow_selection (
  task_id text PRIMARY KEY,
  workflow_id text NOT NULL,
  step_ids jsonb NOT NULL DEFAULT '[]',
  updated_at text NOT NULL
);

-- FNXC:TaskVerificationRequest 2026-07-30-00:00: chat queues profiles; only executor runs the resolved command.
CREATE TABLE IF NOT EXISTS project.task_verification_requests (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  task_id text NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL,
  profile text NOT NULL,
  command text NOT NULL,
  scope text NOT NULL,
  requested_by text NOT NULL,
  requested_at text NOT NULL,
  started_at text,
  completed_at text,
  result jsonb,
  rejection_reason text,
  PRIMARY KEY (project_id, task_id),
  UNIQUE (project_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_task_verification_requests_status ON project.task_verification_requests(project_id, status, requested_at);

CREATE TABLE IF NOT EXISTS project.activity_log (
  project_id text NOT NULL,
  id text PRIMARY KEY,
  timestamp text NOT NULL,
  type text NOT NULL,
  task_id text,
  task_title text,
  details text NOT NULL,
  metadata jsonb
);
CREATE INDEX IF NOT EXISTS "idxActivityLogTimestamp" ON project.activity_log(timestamp);
CREATE INDEX IF NOT EXISTS "idxActivityLogProjectTimestamp" ON project.activity_log(project_id, timestamp);
CREATE INDEX IF NOT EXISTS "idxActivityLogType" ON project.activity_log(type);
CREATE INDEX IF NOT EXISTS "idxActivityLogTaskId" ON project.activity_log(task_id);

CREATE TABLE IF NOT EXISTS project.archived_tasks (
  id text PRIMARY KEY,
  -- FNXC:MultiProjectIsolation 2026-07-10: per-project partition key (see project.tasks.project_id).
  project_id text,
  data text NOT NULL,
  archived_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxArchivedTasksId" ON project.archived_tasks(id);
CREATE INDEX IF NOT EXISTS "idxArchivedTasksProjectId" ON project.archived_tasks(project_id);

CREATE TABLE IF NOT EXISTS project.task_commit_associations (
  id text PRIMARY KEY,
  task_lineage_id text NOT NULL,
  task_id_snapshot text NOT NULL,
  commit_sha text NOT NULL,
  commit_subject text NOT NULL,
  authored_at text NOT NULL,
  matched_by text NOT NULL,
  confidence text NOT NULL,
  note text,
  additions integer,
  deletions integer,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT task_commit_associations_matched_by_check
    CHECK (matched_by IN ('canonical-lineage-trailer', 'legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')),
  CONSTRAINT task_commit_associations_confidence_check
    CHECK (confidence IN ('canonical', 'legacy', 'ambiguous')),
  CONSTRAINT task_commit_associations_task_lineage_id_commit_sha_matched_by_unique
    UNIQUE (task_lineage_id, commit_sha, matched_by)
);
CREATE INDEX IF NOT EXISTS "idxTaskCommitAssociationsLineage"
  ON project.task_commit_associations(task_lineage_id);
CREATE INDEX IF NOT EXISTS "idxTaskCommitAssociationsCommitSha"
  ON project.task_commit_associations(commit_sha);

CREATE TABLE IF NOT EXISTS project.automations (
  project_id text NOT NULL DEFAULT '',
  id text NOT NULL,
  name text NOT NULL,
  description text,
  schedule_type text NOT NULL,
  cron_expression text NOT NULL,
  command text NOT NULL,
  enabled integer DEFAULT 1,
  timeout_ms integer,
  steps jsonb,
  next_run_at text,
  last_run_at text,
  last_run_result jsonb,
  run_count integer DEFAULT 0,
  run_history jsonb DEFAULT '[]',
  scope text DEFAULT 'project',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS project.agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  role text NOT NULL,
  state text NOT NULL DEFAULT 'idle',
  task_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_heartbeat_at text,
  metadata jsonb DEFAULT '{}',
  data jsonb DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS project.agent_heartbeats (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id text NOT NULL,
  timestamp text NOT NULL,
  status text NOT NULL,
  run_id text NOT NULL,
  CONSTRAINT agent_heartbeats_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxAgentHeartbeatsAgentId" ON project.agent_heartbeats(agent_id);
CREATE INDEX IF NOT EXISTS "idxAgentHeartbeatsRunId" ON project.agent_heartbeats(run_id);

CREATE TABLE IF NOT EXISTS project.agent_runs (
  project_id text NOT NULL,
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  data jsonb NOT NULL,
  started_at text NOT NULL,
  ended_at text,
  status text NOT NULL,
  CONSTRAINT agent_runs_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxAgentRunsAgentIdStartedAt" ON project.agent_runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS "idxAgentRunsProjectStartedAt" ON project.agent_runs(project_id, started_at);
CREATE INDEX IF NOT EXISTS "idxAgentRunsStatus" ON project.agent_runs(status);

CREATE TABLE IF NOT EXISTS project.agent_task_sessions (
  agent_id text NOT NULL,
  task_id text NOT NULL,
  data jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (agent_id, task_id),
  CONSTRAINT agent_task_sessions_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project.agent_api_keys (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  data jsonb NOT NULL,
  created_at text NOT NULL,
  revoked_at text,
  CONSTRAINT agent_api_keys_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxAgentApiKeysAgentId" ON project.agent_api_keys(agent_id);

CREATE TABLE IF NOT EXISTS project.agent_config_revisions (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  data jsonb NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT agent_config_revisions_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxAgentConfigRevisionsAgentIdCreatedAt"
  ON project.agent_config_revisions(agent_id, created_at);

CREATE TABLE IF NOT EXISTS project.agent_blocked_states (
  agent_id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT agent_blocked_states_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project.merge_queue (
  task_id text PRIMARY KEY,
  enqueued_at text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  leased_by text,
  leased_at text,
  lease_expires_at text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT merge_queue_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_mergeQueue_lease_ready"
  ON project.merge_queue(leased_by, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS "idx_mergeQueue_leaseExpiresAt"
  ON project.merge_queue(lease_expires_at);

CREATE TABLE IF NOT EXISTS project.merge_requests (
  task_id text PRIMARY KEY,
  state text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT merge_requests_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_merge_requests_state_updatedAt"
  ON project.merge_requests(state, updated_at);

CREATE TABLE IF NOT EXISTS project.completion_handoff_markers (
  task_id text PRIMARY KEY,
  accepted_at text NOT NULL,
  source text NOT NULL,
  CONSTRAINT completion_handoff_markers_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_completion_handoff_markers_acceptedAt"
  ON project.completion_handoff_markers(accepted_at);

CREATE TABLE IF NOT EXISTS project.workflow_work_items (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  task_id text NOT NULL,
  node_id text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  retry_after text,
  lease_owner text,
  lease_expires_at text,
  last_error text,
  blocked_reason text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT workflow_work_items_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE,
  CONSTRAINT workflow_work_items_run_id_task_id_node_id_kind_unique
    UNIQUE (run_id, task_id, node_id, kind)
);
CREATE INDEX IF NOT EXISTS "idx_workflow_work_items_due"
  ON project.workflow_work_items(state, retry_after, created_at);
CREATE INDEX IF NOT EXISTS "idx_workflow_work_items_leaseExpiresAt"
  ON project.workflow_work_items(lease_expires_at);
CREATE INDEX IF NOT EXISTS "idx_workflow_work_items_task_run"
  ON project.workflow_work_items(task_id, run_id);

CREATE TABLE IF NOT EXISTS project.workflow_run_branches (
  task_id text NOT NULL,
  run_id text NOT NULL,
  branch_id text NOT NULL,
  current_node_id text NOT NULL,
  status text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (task_id, run_id, branch_id),
  CONSTRAINT workflow_run_branches_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_workflow_run_branches_task_run"
  ON project.workflow_run_branches(task_id, run_id);

CREATE TABLE IF NOT EXISTS project.workflow_run_step_instances (
  task_id text NOT NULL,
  run_id text NOT NULL,
  foreach_node_id text NOT NULL,
  step_index integer NOT NULL,
  pinned_step_count integer NOT NULL,
  current_node_id text,
  status text NOT NULL,
  baseline_sha text,
  checkpoint_id text,
  rework_count integer NOT NULL DEFAULT 0,
  branch_name text,
  integrated_at text,
  updated_at text NOT NULL,
  PRIMARY KEY (task_id, run_id, foreach_node_id, step_index),
  CONSTRAINT workflow_run_step_instances_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_workflow_run_step_instances_task_run"
  ON project.workflow_run_step_instances(task_id, run_id);

CREATE TABLE IF NOT EXISTS project.workflow_settings (
  workflow_id text NOT NULL,
  project_id text NOT NULL,
  values jsonb DEFAULT '{}',
  updated_at text NOT NULL,
  PRIMARY KEY (workflow_id, project_id)
);
CREATE INDEX IF NOT EXISTS "idx_workflow_settings_project"
  ON project.workflow_settings(project_id);

CREATE TABLE IF NOT EXISTS project.workflow_prompt_overrides (
  workflow_id text NOT NULL,
  project_id text NOT NULL,
  overrides jsonb NOT NULL DEFAULT '{}',
  updated_at text NOT NULL,
  PRIMARY KEY (workflow_id, project_id)
);
CREATE INDEX IF NOT EXISTS "idx_workflow_prompt_overrides_project"
  ON project.workflow_prompt_overrides(project_id);

CREATE TABLE IF NOT EXISTS project.task_documents (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  key text NOT NULL,
  content text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  author text NOT NULL DEFAULT 'user',
  metadata jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT task_documents_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE,
  CONSTRAINT task_documents_task_id_key_unique UNIQUE (task_id, key)
);
CREATE INDEX IF NOT EXISTS "idxTaskDocumentsTaskId" ON project.task_documents(task_id);

CREATE TABLE IF NOT EXISTS project.artifacts (
  id text PRIMARY KEY,
  type text NOT NULL,
  title text NOT NULL,
  description text,
  mime_type text,
  size_bytes integer,
  uri text,
  content text,
  author_id text NOT NULL,
  author_type text NOT NULL DEFAULT 'agent',
  task_id text,
  metadata jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT artifacts_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxArtifactsTaskId" ON project.artifacts(task_id);
CREATE INDEX IF NOT EXISTS "idxArtifactsAuthorId" ON project.artifacts(author_id);
CREATE INDEX IF NOT EXISTS "idxArtifactsType" ON project.artifacts(type);
CREATE INDEX IF NOT EXISTS "idxArtifactsCreatedAt" ON project.artifacts(created_at);

CREATE TABLE IF NOT EXISTS project.task_document_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id text NOT NULL,
  key text NOT NULL,
  content text NOT NULL,
  revision integer NOT NULL,
  author text NOT NULL,
  metadata jsonb,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxTaskDocumentRevisionsTaskKey"
  ON project.task_document_revisions(task_id, key);

CREATE TABLE IF NOT EXISTS project.research_runs (
  id text PRIMARY KEY,
  query text NOT NULL,
  topic text,
  status text NOT NULL,
  project_id text,
  trigger text,
  provider_config jsonb,
  sources jsonb NOT NULL DEFAULT '[]',
  events jsonb NOT NULL DEFAULT '[]',
  results jsonb,
  error text,
  token_usage jsonb,
  tags jsonb NOT NULL DEFAULT '[]',
  metadata jsonb,
  lifecycle jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  started_at text,
  completed_at text,
  cancelled_at text
);
CREATE INDEX IF NOT EXISTS "idxResearchRunsStatus" ON project.research_runs(status);
CREATE INDEX IF NOT EXISTS "idxResearchRunsCreatedAt" ON project.research_runs(created_at);
CREATE INDEX IF NOT EXISTS "idxResearchRunsUpdatedAt" ON project.research_runs(updated_at);

CREATE TABLE IF NOT EXISTS project.research_exports (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  format text NOT NULL,
  content text NOT NULL,
  file_path text,
  created_at text NOT NULL,
  CONSTRAINT research_exports_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES project.research_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxResearchExportsRunId" ON project.research_exports(run_id);

CREATE TABLE IF NOT EXISTS project.research_run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  message text NOT NULL,
  status text,
  classification text,
  metadata jsonb,
  created_at text NOT NULL,
  CONSTRAINT research_run_events_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES project.research_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxResearchRunEventsRunIdSeq"
  ON project.research_run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS project.experiment_sessions (
  id text PRIMARY KEY,
  name text NOT NULL,
  project_id text,
  status text NOT NULL,
  metric text NOT NULL,
  current_segment integer NOT NULL DEFAULT 1,
  max_iterations integer,
  working_dir text,
  baseline_run_id text,
  best_run_id text,
  kept_run_ids jsonb NOT NULL DEFAULT '[]',
  tags jsonb NOT NULL DEFAULT '[]',
  metadata jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  finalized_at text
);
CREATE INDEX IF NOT EXISTS "idxExperimentSessionsStatus" ON project.experiment_sessions(status);
CREATE INDEX IF NOT EXISTS "idxExperimentSessionsProject" ON project.experiment_sessions(project_id);
CREATE INDEX IF NOT EXISTS "idxExperimentSessionsCreatedAt" ON project.experiment_sessions(created_at);

CREATE TABLE IF NOT EXISTS project.experiment_session_records (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  segment integer NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT experiment_session_records_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES project.experiment_sessions(id) ON DELETE CASCADE,
  CONSTRAINT experiment_session_records_session_id_seq_unique UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS "idxExperimentRecordsSessionSegment"
  ON project.experiment_session_records(session_id, segment, seq);
CREATE INDEX IF NOT EXISTS "idxExperimentRecordsType"
  ON project.experiment_session_records(session_id, type);

CREATE TABLE IF NOT EXISTS project.eval_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  status text NOT NULL,
  trigger text NOT NULL,
  scope text NOT NULL,
  "window" jsonb NOT NULL DEFAULT '{}',
  requested_task_ids jsonb NOT NULL DEFAULT '[]',
  evaluated_task_ids jsonb NOT NULL DEFAULT '[]',
  counts jsonb NOT NULL DEFAULT '{"totalTasks":0,"scoredTasks":0,"skippedTasks":0,"erroredTasks":0}',
  aggregate_scores jsonb,
  summary text,
  error text,
  provenance jsonb,
  metadata jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  started_at text,
  completed_at text,
  cancelled_at text
);
CREATE INDEX IF NOT EXISTS "idxEvalRunsProjectIdCreatedAt" ON project.eval_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS "idxEvalRunsProjectTriggerStatus"
  ON project.eval_runs(project_id, trigger, status);
CREATE INDEX IF NOT EXISTS "idxEvalRunsStatusCreatedAt" ON project.eval_runs(status, created_at);

CREATE TABLE IF NOT EXISTS project.eval_task_results (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  task_id text NOT NULL,
  task_snapshot jsonb NOT NULL,
  status text NOT NULL,
  overall_score real,
  max_score real,
  category_scores jsonb NOT NULL DEFAULT '[]',
  rationale text,
  summary text,
  evidence jsonb NOT NULL DEFAULT '[]',
  deterministic_signals jsonb NOT NULL DEFAULT '[]',
  ai_signals jsonb,
  follow_ups jsonb NOT NULL DEFAULT '[]',
  provenance jsonb,
  metadata jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT eval_task_results_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES project.eval_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxEvalTaskResultsRunIdCreatedAt"
  ON project.eval_task_results(run_id, created_at);
CREATE INDEX IF NOT EXISTS "idxEvalTaskResultsTaskIdCreatedAt"
  ON project.eval_task_results(task_id, created_at);
CREATE INDEX IF NOT EXISTS "idxEvalTaskResultsStatusRunId"
  ON project.eval_task_results(status, run_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idxEvalTaskResultsRunTaskUnique"
  ON project.eval_task_results(run_id, task_id);

CREATE TABLE IF NOT EXISTS project.eval_run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  message text NOT NULL,
  status text,
  task_id text,
  metadata jsonb,
  created_at text NOT NULL,
  CONSTRAINT eval_run_events_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES project.eval_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxEvalRunEventsRunIdSeq" ON project.eval_run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS project.secrets (
  id text PRIMARY KEY,
  key text NOT NULL,
  value_ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  description text,
  access_policy text NOT NULL DEFAULT 'auto',
  env_exportable integer NOT NULL DEFAULT 0,
  env_export_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_read_at text,
  last_read_by text,
  CONSTRAINT secrets_access_policy_check CHECK (access_policy IN ('auto', 'prompt', 'deny')),
  CONSTRAINT secrets_env_exportable_check CHECK (env_exportable IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_key_unique" ON project.secrets(key);

CREATE TABLE IF NOT EXISTS project.__meta (
  key text PRIMARY KEY,
  value text
);

CREATE TABLE IF NOT EXISTS project.missions (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL,
  interview_state text NOT NULL,
  base_branch text,
  branch_strategy text,
  auto_advance integer DEFAULT 0,
  auto_merge integer,
  autopilot_enabled integer NOT NULL DEFAULT 0,
  autopilot_state text NOT NULL DEFAULT 'inactive',
  last_autopilot_activity_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.branch_groups (
  id text PRIMARY KEY,
  source_type text NOT NULL,
  source_id text NOT NULL,
  branch_name text NOT NULL UNIQUE,
  worktree_path text,
  auto_merge integer NOT NULL DEFAULT 0,
  pr_state text NOT NULL DEFAULT 'none',
  pr_url text,
  pr_number integer,
  status text NOT NULL DEFAULT 'open',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  closed_at bigint,
  CONSTRAINT branch_groups_source_type_check CHECK (source_type IN ('mission','planning','new-task')),
  CONSTRAINT branch_groups_pr_state_check CHECK (pr_state IN ('none','open','merged','closed')),
  CONSTRAINT branch_groups_status_check CHECK (status IN ('open','finalized','abandoned'))
);
CREATE INDEX IF NOT EXISTS "idxBranchGroupsSource" ON project.branch_groups(source_type, source_id);
CREATE INDEX IF NOT EXISTS "idxBranchGroupsBranchName" ON project.branch_groups(branch_name);

CREATE TABLE IF NOT EXISTS project.pull_requests (
  id text PRIMARY KEY,
  source_type text NOT NULL,
  source_id text NOT NULL,
  repo text NOT NULL,
  head_branch text NOT NULL,
  base_branch text,
  state text NOT NULL DEFAULT 'creating',
  pr_number integer,
  pr_url text,
  head_oid text,
  mergeable text,
  checks_rollup jsonb,
  review_decision text,
  auto_merge integer NOT NULL DEFAULT 0,
  unverified integer NOT NULL DEFAULT 0,
  failure_reason text,
  response_rounds integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  closed_at bigint,
  CONSTRAINT pull_requests_source_type_check CHECK (source_type IN ('task','branch-group')),
  CONSTRAINT pull_requests_state_check
    CHECK (state IN ('creating','open','responding','merged','closed','failed'))
);
-- Partial unique indexes: only enforce uniqueness among non-terminal rows so
-- history can accumulate and reopen/recreate-after-close is permitted.
CREATE UNIQUE INDEX IF NOT EXISTS "idxPullRequestsOpenSource"
  ON project.pull_requests(source_type, source_id)
  WHERE state NOT IN ('merged','closed','failed');
CREATE UNIQUE INDEX IF NOT EXISTS "idxPullRequestsOpenBranch"
  ON project.pull_requests(repo, head_branch)
  WHERE state NOT IN ('merged','closed','failed');
CREATE UNIQUE INDEX IF NOT EXISTS "idxPullRequestsNumber"
  ON project.pull_requests(repo, pr_number)
  WHERE pr_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS project.pull_request_thread_state (
  pr_entity_id text NOT NULL,
  thread_id text NOT NULL,
  head_oid text NOT NULL,
  outcome text NOT NULL,
  fix_commit_sha text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (pr_entity_id, thread_id, head_oid),
  CONSTRAINT pull_request_thread_state_pr_entity_id_fkey
    FOREIGN KEY (pr_entity_id) REFERENCES project.pull_requests(id) ON DELETE CASCADE,
  CONSTRAINT pull_request_thread_state_outcome_check
    CHECK (outcome IN ('fixed','disagreed','pending'))
);

CREATE TABLE IF NOT EXISTS project.goals (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxGoalsStatus" ON project.goals(status);

CREATE TABLE IF NOT EXISTS project.mission_goals (
  mission_id text NOT NULL,
  goal_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (mission_id, goal_id),
  CONSTRAINT mission_goals_mission_id_fkey
    FOREIGN KEY (mission_id) REFERENCES project.missions(id) ON DELETE CASCADE,
  CONSTRAINT mission_goals_goal_id_fkey
    FOREIGN KEY (goal_id) REFERENCES project.goals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxMissionGoalsGoalId" ON project.mission_goals(goal_id);

CREATE TABLE IF NOT EXISTS project.goal_citations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  goal_id text NOT NULL,
  agent_id text NOT NULL,
  task_id text,
  surface text NOT NULL,
  source_ref text NOT NULL,
  snippet text NOT NULL,
  timestamp text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxGoalCitationsGoalId" ON project.goal_citations(goal_id);
CREATE INDEX IF NOT EXISTS "idxGoalCitationsAgentId" ON project.goal_citations(agent_id);
CREATE INDEX IF NOT EXISTS "idxGoalCitationsTimestamp" ON project.goal_citations(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS "uxGoalCitationsDedup"
  ON project.goal_citations(goal_id, surface, source_ref);

CREATE TABLE IF NOT EXISTS project.milestones (
  id text PRIMARY KEY,
  mission_id text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL,
  order_index integer NOT NULL,
  interview_state text NOT NULL,
  dependencies jsonb DEFAULT '[]',
  planning_notes text,
  verification text,
  acceptance_criteria text,
  validation_state text NOT NULL DEFAULT 'not_started',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT milestones_mission_id_fkey
    FOREIGN KEY (mission_id) REFERENCES project.missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project.slices (
  id text PRIMARY KEY,
  milestone_id text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL,
  order_index integer NOT NULL,
  activated_at text,
  plan_state text NOT NULL DEFAULT 'not_started',
  planning_notes text,
  verification text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT slices_milestone_id_fkey
    FOREIGN KEY (milestone_id) REFERENCES project.milestones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project.mission_features (
  id text PRIMARY KEY,
  slice_id text NOT NULL,
  task_id text,
  title text NOT NULL,
  description text,
  acceptance_criteria text,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  loop_state text NOT NULL DEFAULT 'idle',
  implementation_attempt_count integer NOT NULL DEFAULT 0,
  validator_attempt_count integer NOT NULL DEFAULT 0,
  last_validator_run_id text,
  last_validator_status text,
  generated_from_feature_id text,
  generated_from_run_id text,
  research_run_id text,
  research_finding_id text,
  research_source_urls jsonb,
  CONSTRAINT mission_features_slice_id_fkey
    FOREIGN KEY (slice_id) REFERENCES project.slices(id) ON DELETE CASCADE,
  CONSTRAINT mission_features_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES project.tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project.mission_events (
  id text PRIMARY KEY,
  mission_id text NOT NULL,
  event_type text NOT NULL,
  description text NOT NULL,
  metadata jsonb,
  timestamp text NOT NULL,
  seq integer NOT NULL DEFAULT 0,
  CONSTRAINT mission_events_mission_id_fkey
    FOREIGN KEY (mission_id) REFERENCES project.missions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxMissionEventsMissionId" ON project.mission_events(mission_id);
CREATE INDEX IF NOT EXISTS "idxMissionEventsTimestamp" ON project.mission_events(timestamp);
CREATE INDEX IF NOT EXISTS "idxMissionEventsType" ON project.mission_events(event_type);

CREATE TABLE IF NOT EXISTS project.plugins (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  description text,
  author text,
  homepage text,
  path text NOT NULL,
  enabled integer DEFAULT 1,
  state text NOT NULL DEFAULT 'installed',
  settings jsonb DEFAULT '{}',
  settings_schema jsonb,
  error text,
  dependencies jsonb DEFAULT '[]',
  ai_scan_on_load integer NOT NULL DEFAULT 0,
  last_security_scan text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS central.global_routines (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  agent_id text NOT NULL DEFAULT '',
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL,
  command text,
  enabled integer NOT NULL DEFAULT 1,
  last_run_at text,
  last_run_result jsonb,
  next_run_at text,
  run_count integer NOT NULL DEFAULT 0,
  run_history jsonb NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_routines_next_run_at ON central.global_routines(next_run_at);

CREATE TABLE IF NOT EXISTS project.routines (
  id text PRIMARY KEY,
  agent_id text NOT NULL DEFAULT '',
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL,
  command text,
  steps jsonb,
  timeout_ms integer,
  catch_up_policy text NOT NULL DEFAULT 'run_one',
  execution_policy text NOT NULL DEFAULT 'queue',
  catch_up_limit integer DEFAULT 5,
  enabled integer DEFAULT 1,
  last_run_at text,
  last_run_result jsonb,
  next_run_at text,
  run_count integer DEFAULT 0,
  run_history jsonb DEFAULT '[]',
  scope text DEFAULT 'project',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.project_insights (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  title text NOT NULL,
  content text,
  category text NOT NULL,
  status text NOT NULL,
  fingerprint text NOT NULL,
  provenance jsonb,
  last_run_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxProjectInsightsProjectId"
  ON project.project_insights(project_id);
CREATE INDEX IF NOT EXISTS "idxProjectInsightsFingerprint"
  ON project.project_insights(project_id, fingerprint);
CREATE INDEX IF NOT EXISTS "idxProjectInsightsCategory"
  ON project.project_insights(category);

CREATE TABLE IF NOT EXISTS project.project_insight_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL,
  summary text,
  error text,
  insights_created integer NOT NULL DEFAULT 0,
  insights_updated integer NOT NULL DEFAULT 0,
  input_metadata jsonb,
  output_metadata jsonb,
  lifecycle jsonb,
  created_at text NOT NULL,
  started_at text,
  completed_at text,
  cancelled_at text
);
CREATE INDEX IF NOT EXISTS "idxInsightRunsProjectId"
  ON project.project_insight_runs(project_id);
CREATE INDEX IF NOT EXISTS "idxInsightRunsProjectTriggerStatus"
  ON project.project_insight_runs(project_id, trigger, status);

CREATE TABLE IF NOT EXISTS project.project_insight_run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  message text NOT NULL,
  status text,
  classification text,
  metadata jsonb,
  created_at text NOT NULL,
  CONSTRAINT project_insight_run_events_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES project.project_insight_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxInsightRunEventsRunIdSeq"
  ON project.project_insight_run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS project.todo_lists (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  title text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxTodoListsProjectId" ON project.todo_lists(project_id);

CREATE TABLE IF NOT EXISTS project.todo_items (
  id text PRIMARY KEY,
  list_id text NOT NULL,
  text text NOT NULL,
  completed integer NOT NULL DEFAULT 0,
  completed_at text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT todo_items_list_id_fkey
    FOREIGN KEY (list_id) REFERENCES project.todo_lists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxTodoItemsListId" ON project.todo_items(list_id);
CREATE INDEX IF NOT EXISTS "idxTodoItemsSortOrder" ON project.todo_items(list_id, sort_order);

CREATE TABLE IF NOT EXISTS project.usage_events (
  project_id text NOT NULL,
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts text NOT NULL,
  kind text NOT NULL,
  task_id text,
  agent_id text,
  node_id text,
  model text,
  provider text,
  tool_name text,
  category text,
  meta jsonb
);
CREATE INDEX IF NOT EXISTS "idxUsageEventsTs" ON project.usage_events(ts);
CREATE INDEX IF NOT EXISTS "idxUsageEventsProjectTs" ON project.usage_events(project_id, ts);
CREATE INDEX IF NOT EXISTS "idxUsageEventsTaskId" ON project.usage_events(task_id);
CREATE INDEX IF NOT EXISTS "idxUsageEventsAgentId" ON project.usage_events(agent_id);
CREATE INDEX IF NOT EXISTS "idxUsageEventsKindTs" ON project.usage_events(kind, ts);

CREATE TABLE IF NOT EXISTS project.plugin_activations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_id text NOT NULL,
  source text NOT NULL,
  plugin_version text,
  activated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxPluginActivationsActivatedAt"
  ON project.plugin_activations(activated_at);
CREATE INDEX IF NOT EXISTS "idxPluginActivationsPluginId"
  ON project.plugin_activations(plugin_id);

CREATE TABLE IF NOT EXISTS project.knowledge_pages (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_key text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text,
  content text NOT NULL,
  tags jsonb,
  search_text text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxKnowledgePagesSourceKind"
  ON project.knowledge_pages(source_kind);
CREATE INDEX IF NOT EXISTS "idxKnowledgePagesUpdatedAt"
  ON project.knowledge_pages(updated_at);

CREATE TABLE IF NOT EXISTS project.deployments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL DEFAULT '',
  deployment_id text NOT NULL,
  service text,
  environment text,
  version text,
  status text,
  deployed_at text NOT NULL,
  link text,
  meta jsonb,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idxDeploymentsProjectDeploymentId" ON project.deployments(project_id, deployment_id);
CREATE INDEX IF NOT EXISTS "idxDeploymentsProjectDeployedAt" ON project.deployments(project_id, deployed_at);
CREATE INDEX IF NOT EXISTS "idxDeploymentsDeployedAt" ON project.deployments(deployed_at);
CREATE INDEX IF NOT EXISTS "idxDeploymentsService" ON project.deployments(service);

CREATE TABLE IF NOT EXISTS project.incidents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL DEFAULT '',
  incident_id text NOT NULL UNIQUE,
  grouping_key text NOT NULL,
  title text NOT NULL,
  severity text,
  status text NOT NULL,
  source text,
  fix_task_id text,
  opened_at text NOT NULL,
  resolved_at text,
  link text,
  meta jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS "idxIncidentsProjectOpenedAt" ON project.incidents(project_id, opened_at);
CREATE INDEX IF NOT EXISTS "idxIncidentsProjectStatus" ON project.incidents(project_id, status);
CREATE INDEX IF NOT EXISTS "idxIncidentsGroupingKey" ON project.incidents(grouping_key);
CREATE INDEX IF NOT EXISTS "idxIncidentsStatus" ON project.incidents(status);
CREATE INDEX IF NOT EXISTS "idxIncidentsOpenedAt" ON project.incidents(opened_at);
CREATE INDEX IF NOT EXISTS "idxIncidentsResolvedAt" ON project.incidents(resolved_at);

-- ── Migration-only tables (converge on same shape as fresh-init) ─────

CREATE TABLE IF NOT EXISTS project.ai_sessions (
  id text PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  input_payload jsonb NOT NULL,
  conversation_history jsonb DEFAULT '[]',
  current_question text,
  result jsonb,
  thinking_output text DEFAULT '',
  error text,
  project_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  locked_by_tab text,
  locked_at text,
  archived integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project.messages (
  id text PRIMARY KEY,
  from_id text NOT NULL,
  from_type text NOT NULL,
  to_id text NOT NULL,
  to_type text NOT NULL,
  content text NOT NULL,
  type text NOT NULL,
  read integer DEFAULT 0,
  metadata jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.agent_ratings (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  rater_type text NOT NULL,
  rater_id text,
  score integer NOT NULL,
  category text,
  comment text,
  run_id text,
  task_id text,
  created_at text NOT NULL,
  CONSTRAINT agent_ratings_score_check CHECK (score BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS project.chat_sessions (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active',
  project_id text,
  model_provider text,
  model_id text,
  thinking_level text,
  validator_thinking_level text,
  planning_thinking_level text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  pinned_at text,
  cli_session_file text,
  in_flight_generation jsonb,
  cli_executor_adapter_id text
);

CREATE TABLE IF NOT EXISTS project.cli_sessions (
  id text PRIMARY KEY,
  task_id text,
  chat_session_id text,
  purpose text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  agent_state text NOT NULL DEFAULT 'starting',
  termination_reason text,
  native_session_id text,
  resume_attempts integer NOT NULL DEFAULT 0,
  autonomy_posture text,
  worktree_path text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.chat_messages (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  thinking_output text,
  metadata jsonb,
  created_at text NOT NULL,
  attachments jsonb
);

-- FNXC:PostgresCutover 2026-07-04-00:00: append-only chat token-accounting table (ChatStore.recordTokenUsage + Command Center aggregateTokenAnalytics).
CREATE TABLE IF NOT EXISTS project.chat_token_usage (
  id text PRIMARY KEY,
  source_kind text NOT NULL,
  chat_session_id text,
  room_id text,
  message_id text,
  project_id text,
  agent_id text,
  model_provider text,
  model_id text,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cached_tokens bigint NOT NULL,
  cache_write_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.run_audit_events (
  id text PRIMARY KEY,
  timestamp text NOT NULL,
  task_id text,
  agent_id text NOT NULL,
  run_id text NOT NULL,
  domain text NOT NULL,
  mutation_type text NOT NULL,
  target text NOT NULL,
  metadata jsonb
);

CREATE TABLE IF NOT EXISTS project.mission_contract_assertions (
  id text PRIMARY KEY,
  milestone_id text NOT NULL,
  title text NOT NULL,
  assertion text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  type text NOT NULL DEFAULT 'static',
  order_index integer NOT NULL DEFAULT 0,
  source_feature_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.mission_feature_assertions (
  feature_id text NOT NULL,
  assertion_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (feature_id, assertion_id)
);

CREATE TABLE IF NOT EXISTS project.mission_validator_runs (
  id text PRIMARY KEY,
  feature_id text NOT NULL,
  milestone_id text NOT NULL,
  slice_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  trigger_type text NOT NULL DEFAULT 'auto',
  implementation_attempt integer NOT NULL DEFAULT 0,
  validator_attempt integer NOT NULL DEFAULT 0,
  summary text,
  blocked_reason text,
  started_at text NOT NULL,
  completed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  task_id text
);

CREATE TABLE IF NOT EXISTS project.mission_validator_failures (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  feature_id text NOT NULL,
  assertion_id text NOT NULL,
  message text,
  expected text,
  actual text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.mission_fix_feature_lineage (
  id text PRIMARY KEY,
  source_feature_id text NOT NULL,
  fix_feature_id text NOT NULL,
  run_id text NOT NULL,
  failed_assertion_ids jsonb NOT NULL DEFAULT '[]',
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.verification_cache (
  tree_sha text NOT NULL,
  test_command text NOT NULL DEFAULT '',
  build_command text NOT NULL DEFAULT '',
  recorded_at text NOT NULL,
  task_id text,
  PRIMARY KEY (tree_sha, test_command, build_command)
);

CREATE TABLE IF NOT EXISTS project.approval_requests (
  id text PRIMARY KEY,
  status text NOT NULL,
  requester_actor_id text NOT NULL,
  requester_actor_type text NOT NULL,
  requester_actor_name text NOT NULL,
  target_action_category text NOT NULL,
  target_action_operation text NOT NULL,
  target_action_summary text NOT NULL,
  target_resource_type text NOT NULL,
  target_resource_id text NOT NULL,
  target_context jsonb,
  task_id text,
  run_id text,
  requested_at text NOT NULL,
  decided_at text,
  completed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.approval_request_audit_events (
  project_id text NOT NULL DEFAULT '',
  id text PRIMARY KEY,
  request_id text NOT NULL,
  event_type text NOT NULL,
  actor_id text NOT NULL,
  actor_type text NOT NULL,
  actor_name text NOT NULL,
  note text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.chat_rooms (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  project_id text,
  created_by text,
  status text NOT NULL DEFAULT 'active',
  -- FNXC:Chat-ThinkingLevel 2026-07-13 (merge port): room-level reasoning-effort default.
  thinking_level text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS project.chat_room_members (
  room_id text NOT NULL,
  agent_id text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  added_at text NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS project.chat_room_messages (
  id text PRIMARY KEY,
  room_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  thinking_output text,
  metadata jsonb,
  attachments jsonb,
  sender_agent_id text,
  mentions jsonb,
  created_at text NOT NULL
);

-- ────────────────────────────────────────────────────────────────────
-- FNXC:PostgresSchema 2026-06-24-06:00:
-- Non-unique lookup indexes added incrementally across SQLite migration
-- blocks (db.ts applyMigration) and the base SCHEMA_SQL. These were missed
-- by the initial snapshot which only captured table/column definitions.
-- Most critical: the 8 indexes on the tasks table, including
-- idx_tasks_deletedAt used by EVERY live reader for soft-delete filtering.
-- See library/drizzle-schema-notes.md "HAZARD: Non-unique lookup indexes".
-- ────────────────────────────────────────────────────────────────────

-- tasks: the hottest table; 8 lookup indexes for live readers.
CREATE INDEX IF NOT EXISTS "idx_tasks_deletedAt" ON project.tasks(deleted_at);
CREATE INDEX IF NOT EXISTS "idxTasksAssignedAgentId" ON project.tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS "idxTasksAssigneeUserId" ON project.tasks(assignee_user_id);
CREATE INDEX IF NOT EXISTS "idxTasksColumn" ON project.tasks("column");
CREATE INDEX IF NOT EXISTS "idxTasksCreatedAt" ON project.tasks(created_at);
CREATE INDEX IF NOT EXISTS "idxTasksLineageId" ON project.tasks(lineage_id);
CREATE INDEX IF NOT EXISTS "idxTasksPausedByAgentId" ON project.tasks(paused_by_agent_id);
CREATE INDEX IF NOT EXISTS "idxTasksUpdatedAt" ON project.tasks(updated_at DESC);
-- FNXC:TaskStoreLineage 2026-06-26-10:00:
-- The lineage-integrity gate (findLiveLineageChildren / removeLineageReferences)
-- filters on source_parent_task_id on every archive/delete. Without this index
-- the gate is a full tasks-table scan. Sparse: most rows have NULL parent.
CREATE INDEX IF NOT EXISTS "idxTasksSourceParentTaskId" ON project.tasks(source_parent_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS "uqTasksProjectProposalClaimId" ON project.tasks(project_id, proposal_claim_id) WHERE proposal_claim_id IS NOT NULL;
-- FNXC:TaskStoreReads 2026-06-26-10:00:
-- Partial index for the hot kanban / board-read query shape
-- WHERE deleted_at IS NULL AND "column" = ? (every live board hydration).
-- The partial predicate shrinks the index to live rows only so the planner
-- can serve the most common board filter without a bitmap-AND over two indexes.
CREATE INDEX IF NOT EXISTS "idxTasksLiveColumn" ON project.tasks("column") WHERE deleted_at IS NULL;
-- FNXC:MultiProjectIsolation 2026-07-10: composite (project_id, column) partial
-- index for the per-project board scan + scheduler poll.
CREATE INDEX IF NOT EXISTS "idxTasksProjectLiveColumn" ON project.tasks(project_id, "column") WHERE deleted_at IS NULL;
-- FNXC:TaskStoreSearch 2026-06-24-12:35:
-- GIN index on the tasks search_vector for full-text search (VAL-SEARCH-001).
-- Replaces the FTS5 index. REINDEX restores search after bloat (VAL-SEARCH-007).
CREATE INDEX IF NOT EXISTS "idxTasksSearchVector" ON project.tasks USING gin(search_vector);

-- activity_log: timestamp-suffixed composite indexes.
CREATE INDEX IF NOT EXISTS "idxActivityLogTaskIdTimestamp" ON project.activity_log(task_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS "idxActivityLogTypeTimestamp" ON project.activity_log(type, timestamp DESC);

-- agents
CREATE INDEX IF NOT EXISTS "idxAgentsState" ON project.agents(state);

-- agent_heartbeats
CREATE INDEX IF NOT EXISTS "idxAgentHeartbeatsAgentIdTimestamp" ON project.agent_heartbeats(agent_id, timestamp DESC);

-- agent_ratings
CREATE INDEX IF NOT EXISTS "idxAgentRatingsAgentId" ON project.agent_ratings(agent_id);
CREATE INDEX IF NOT EXISTS "idxAgentRatingsCreatedAt" ON project.agent_ratings(created_at);

-- ai_sessions
CREATE INDEX IF NOT EXISTS "idxAiSessionsArchived" ON project.ai_sessions(archived);
CREATE INDEX IF NOT EXISTS "idxAiSessionsLock" ON project.ai_sessions(locked_by_tab);
CREATE INDEX IF NOT EXISTS "idxAiSessionsStatus" ON project.ai_sessions(status);
CREATE INDEX IF NOT EXISTS "idxAiSessionsStatusUpdatedAt" ON project.ai_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS "idxAiSessionsType" ON project.ai_sessions(type);
CREATE INDEX IF NOT EXISTS "idxAiSessionsUpdatedAt" ON project.ai_sessions(updated_at);

-- messages
CREATE INDEX IF NOT EXISTS "idxMessagesTo" ON project.messages(to_id, to_type, read);
CREATE INDEX IF NOT EXISTS "idxMessagesFrom" ON project.messages(from_id, from_type);
CREATE INDEX IF NOT EXISTS "idxMessagesCreatedAt" ON project.messages(created_at);

-- chat_sessions
CREATE INDEX IF NOT EXISTS "idxChatSessionsAgentId" ON project.chat_sessions(agent_id);
CREATE INDEX IF NOT EXISTS "idxChatSessionsProjectId" ON project.chat_sessions(project_id);

-- chat_messages
CREATE INDEX IF NOT EXISTS "idxChatMessagesSessionId" ON project.chat_messages(session_id);
CREATE INDEX IF NOT EXISTS "idxChatMessagesCreatedAt" ON project.chat_messages(created_at);

-- chat_token_usage
CREATE INDEX IF NOT EXISTS "idxChatTokenUsageCreatedAt" ON project.chat_token_usage(created_at);

-- cli_sessions
CREATE INDEX IF NOT EXISTS "idx_cli_sessions_taskId" ON project.cli_sessions(task_id);
CREATE INDEX IF NOT EXISTS "idx_cli_sessions_chatSessionId" ON project.cli_sessions(chat_session_id);
CREATE INDEX IF NOT EXISTS "idx_cli_sessions_project_state" ON project.cli_sessions(project_id, agent_state);

-- run_audit_events
CREATE INDEX IF NOT EXISTS "idxRunAuditEventsRunIdTimestamp" ON project.run_audit_events(run_id, timestamp);
CREATE INDEX IF NOT EXISTS "idxRunAuditEventsTaskIdTimestamp" ON project.run_audit_events(task_id, timestamp);
CREATE INDEX IF NOT EXISTS "idxRunAuditEventsTimestamp" ON project.run_audit_events(timestamp);

-- mission_contract_assertions
CREATE INDEX IF NOT EXISTS "idxContractAssertionsMilestoneOrder"
  ON project.mission_contract_assertions(milestone_id, order_index, created_at, id);

-- mission_feature_assertions
CREATE INDEX IF NOT EXISTS "idxFeatureAssertionsFeatureId" ON project.mission_feature_assertions(feature_id);
CREATE INDEX IF NOT EXISTS "idxFeatureAssertionsAssertionId" ON project.mission_feature_assertions(assertion_id);

-- mission_validator_runs
CREATE INDEX IF NOT EXISTS "idxValidatorRunsFeatureId" ON project.mission_validator_runs(feature_id);
CREATE INDEX IF NOT EXISTS "idxValidatorRunsMilestoneId" ON project.mission_validator_runs(milestone_id);
CREATE INDEX IF NOT EXISTS "idxValidatorRunsSliceId" ON project.mission_validator_runs(slice_id);
CREATE INDEX IF NOT EXISTS "idxValidatorRunsStatus" ON project.mission_validator_runs(status);

-- mission_validator_failures
CREATE INDEX IF NOT EXISTS "idxValidatorFailuresRunId" ON project.mission_validator_failures(run_id);
CREATE INDEX IF NOT EXISTS "idxValidatorFailuresFeatureId" ON project.mission_validator_failures(feature_id);
CREATE INDEX IF NOT EXISTS "idxValidatorFailuresAssertionId" ON project.mission_validator_failures(assertion_id);

-- mission_fix_feature_lineage
CREATE INDEX IF NOT EXISTS "idxFixLineageSourceFeatureId" ON project.mission_fix_feature_lineage(source_feature_id);
CREATE INDEX IF NOT EXISTS "idxFixLineageFixFeatureId" ON project.mission_fix_feature_lineage(fix_feature_id);
CREATE INDEX IF NOT EXISTS "idxFixLineageRunId" ON project.mission_fix_feature_lineage(run_id);

-- verification_cache
CREATE INDEX IF NOT EXISTS "idxVerificationCacheRecordedAt" ON project.verification_cache(recorded_at);

-- approval_requests
CREATE INDEX IF NOT EXISTS "idxApprovalRequestsStatusCreatedAt" ON project.approval_requests(status, created_at);
CREATE INDEX IF NOT EXISTS "idxApprovalRequestsRequesterCreatedAt" ON project.approval_requests(requester_actor_id, created_at);
CREATE INDEX IF NOT EXISTS "idxApprovalRequestsTaskCreatedAt" ON project.approval_requests(task_id, created_at);

-- approval_request_audit_events
CREATE INDEX IF NOT EXISTS "idxApprovalRequestAuditRequestCreatedAt"
  ON project.approval_request_audit_events(request_id, created_at, id);
CREATE INDEX IF NOT EXISTS "idxApprovalRequestAuditProjectCreatedAt"
  ON project.approval_request_audit_events(project_id, created_at);

-- chat_rooms
CREATE UNIQUE INDEX IF NOT EXISTS "idxChatRoomsSlug" ON project.chat_rooms(project_id, slug);
CREATE INDEX IF NOT EXISTS "idxChatRoomsProjectId" ON project.chat_rooms(project_id);
CREATE INDEX IF NOT EXISTS "idxChatRoomsStatus" ON project.chat_rooms(status);

-- chat_room_members
CREATE INDEX IF NOT EXISTS "idxChatRoomMembersAgentId" ON project.chat_room_members(agent_id);

-- chat_room_messages
CREATE INDEX IF NOT EXISTS "idxChatRoomMessagesRoomCreatedAt" ON project.chat_room_messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS "idxChatRoomMessagesRoomId" ON project.chat_room_messages(room_id);

-- automations
CREATE INDEX IF NOT EXISTS "idxAutomationsProjectScope" ON project.automations(project_id, scope);
CREATE INDEX IF NOT EXISTS "idxAutomationsProjectDue" ON project.automations(project_id, enabled, next_run_at);

-- routines
CREATE INDEX IF NOT EXISTS "idxRoutinesNextRunAt" ON project.routines(next_run_at);
CREATE INDEX IF NOT EXISTS "idxRoutinesEnabled" ON project.routines(enabled);
CREATE INDEX IF NOT EXISTS "idxRoutinesScope" ON project.routines(scope);

-- research_runs (composite added in a later migration block)
CREATE INDEX IF NOT EXISTS "idxResearchRunsProjectTriggerStatus"
  ON project.research_runs(project_id, trigger, status);

-- ════════════════════════════════════════════════════════════════════
-- CENTRAL SCHEMA
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS central.projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  isolation_mode text NOT NULL DEFAULT 'in-process',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_activity_at text,
  node_id text,
  settings jsonb
);
CREATE INDEX IF NOT EXISTS "idxProjectsPath" ON central.projects(path);
CREATE INDEX IF NOT EXISTS "idxProjectsStatus" ON central.projects(status);

CREATE TABLE IF NOT EXISTS central.nodes (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  type text NOT NULL,
  url text,
  api_key text,
  status text NOT NULL DEFAULT 'offline',
  capabilities jsonb,
  system_metrics jsonb,
  known_peers jsonb,
  version_info jsonb,
  plugin_versions jsonb,
  docker_config jsonb,
  max_concurrent integer NOT NULL DEFAULT 2,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT nodes_type_check CHECK (type IN ('local', 'remote'))
);
CREATE INDEX IF NOT EXISTS "idxNodesStatus" ON central.nodes(status);
CREATE INDEX IF NOT EXISTS "idxNodesType" ON central.nodes(type);

CREATE TABLE IF NOT EXISTS central.project_node_path_mappings (
  project_id text NOT NULL,
  node_id text NOT NULL,
  path text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, node_id),
  CONSTRAINT project_node_path_mappings_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES central.projects(id) ON DELETE CASCADE,
  CONSTRAINT project_node_path_mappings_node_id_fkey
    FOREIGN KEY (node_id) REFERENCES central.nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxProjectNodePathMappingsProjectId"
  ON central.project_node_path_mappings(project_id);
CREATE INDEX IF NOT EXISTS "idxProjectNodePathMappingsNodeId"
  ON central.project_node_path_mappings(node_id);

CREATE TABLE IF NOT EXISTS central.project_health (
  project_id text PRIMARY KEY,
  status text NOT NULL,
  active_task_count integer DEFAULT 0,
  in_flight_agent_count integer DEFAULT 0,
  last_activity_at text,
  last_error_at text,
  last_error_message text,
  total_tasks_completed integer DEFAULT 0,
  total_tasks_failed integer DEFAULT 0,
  average_task_duration_ms integer,
  updated_at text NOT NULL,
  CONSTRAINT project_health_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES central.projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS central.central_activity_log (
  id text PRIMARY KEY,
  timestamp text NOT NULL,
  type text NOT NULL,
  project_id text NOT NULL,
  project_name text NOT NULL,
  task_id text,
  task_title text,
  details text NOT NULL,
  metadata jsonb,
  CONSTRAINT central_activity_log_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES central.projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxCentralActivityLogTimestamp"
  ON central.central_activity_log(timestamp);
CREATE INDEX IF NOT EXISTS "idxCentralActivityLogType"
  ON central.central_activity_log(type);
CREATE INDEX IF NOT EXISTS "idxCentralActivityLogProjectId"
  ON central.central_activity_log(project_id);

CREATE TABLE IF NOT EXISTS central.global_concurrency (
  id integer PRIMARY KEY,
  global_max_concurrent integer DEFAULT 4,
  currently_active integer DEFAULT 0,
  queued_count integer DEFAULT 0,
  updated_at text,
  CONSTRAINT global_concurrency_id_check CHECK (id = 1)
);
INSERT INTO central.global_concurrency (id, global_max_concurrent, currently_active, queued_count)
VALUES (1, 4, 0, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS central.central_settings (
  id integer PRIMARY KEY,
  default_project_id text,
  updated_at text NOT NULL,
  CONSTRAINT central_settings_id_check CHECK (id = 1)
);
INSERT INTO central.central_settings (id, default_project_id, updated_at)
VALUES (1, NULL, '')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS central.peer_nodes (
  id text PRIMARY KEY,
  node_id text NOT NULL,
  peer_node_id text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  last_seen text NOT NULL,
  connected_at text NOT NULL,
  CONSTRAINT peer_nodes_node_id_peer_node_id_unique UNIQUE (node_id, peer_node_id),
  CONSTRAINT peer_nodes_node_id_fkey
    FOREIGN KEY (node_id) REFERENCES central.nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxPeerNodesNodeId" ON central.peer_nodes(node_id);

CREATE TABLE IF NOT EXISTS central.settings_sync_state (
  node_id text NOT NULL,
  remote_node_id text NOT NULL,
  last_synced_at text,
  local_checksum text,
  remote_checksum text,
  sync_count integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (node_id, remote_node_id),
  CONSTRAINT settings_sync_state_node_id_fkey
    FOREIGN KEY (node_id) REFERENCES central.nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxSettingsSyncNode" ON central.settings_sync_state(node_id);

CREATE TABLE IF NOT EXISTS central.managed_docker_nodes (
  id text PRIMARY KEY,
  node_id text,
  name text NOT NULL UNIQUE,
  image_name text NOT NULL,
  image_tag text NOT NULL,
  container_id text,
  status text NOT NULL DEFAULT 'creating',
  host_config jsonb NOT NULL DEFAULT '{}',
  env_vars jsonb NOT NULL DEFAULT '{}',
  volume_mounts jsonb NOT NULL DEFAULT '[]',
  resource_sizing jsonb NOT NULL DEFAULT '{}',
  extra_clis jsonb NOT NULL DEFAULT '[]',
  persistent_storage integer NOT NULL DEFAULT 1,
  reachable_url text,
  api_key text,
  error_message text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT managed_docker_nodes_node_id_fkey
    FOREIGN KEY (node_id) REFERENCES central.nodes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "idxManagedDockerNodesStatus"
  ON central.managed_docker_nodes(status);
CREATE INDEX IF NOT EXISTS "idxManagedDockerNodesNodeId"
  ON central.managed_docker_nodes(node_id);

CREATE TABLE IF NOT EXISTS central.plugin_installs (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  description text,
  author text,
  homepage text,
  path text NOT NULL,
  settings jsonb DEFAULT '{}',
  settings_schema jsonb,
  dependencies jsonb DEFAULT '[]',
  ai_scan_on_load integer NOT NULL DEFAULT 0,
  last_security_scan text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS central.project_plugin_states (
  project_path text NOT NULL,
  plugin_id text NOT NULL,
  enabled integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'installed',
  error text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_path, plugin_id),
  CONSTRAINT project_plugin_states_plugin_id_fkey
    FOREIGN KEY (plugin_id) REFERENCES central.plugin_installs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxProjectPluginStatesProjectPath"
  ON central.project_plugin_states(project_path);
CREATE INDEX IF NOT EXISTS "idxProjectPluginStatesPluginId"
  ON central.project_plugin_states(plugin_id);

CREATE TABLE IF NOT EXISTS central.mesh_shared_snapshots (
  node_id text NOT NULL,
  project_id text,
  scope text NOT NULL,
  payload jsonb NOT NULL,
  snapshot_version text NOT NULL,
  captured_at text NOT NULL,
  source_node_id text,
  source_run_id text,
  stale_after text,
  updated_at text NOT NULL,
  PRIMARY KEY (node_id, project_id, scope)
);
CREATE INDEX IF NOT EXISTS "idxMeshSharedSnapshotsLookup"
  ON central.mesh_shared_snapshots(node_id, project_id, scope);

CREATE TABLE IF NOT EXISTS central.mesh_write_queue (
  id text PRIMARY KEY,
  origin_node_id text NOT NULL,
  target_node_id text NOT NULL,
  project_id text,
  scope text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  intent_version text NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at text,
  last_error text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  applied_at text,
  CONSTRAINT mesh_write_queue_status_check
    CHECK (status IN ('pending', 'replaying', 'applied', 'failed'))
);
CREATE INDEX IF NOT EXISTS "idxMeshWriteQueueReplay"
  ON central.mesh_write_queue(target_node_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS central.secrets_global (
  id text PRIMARY KEY,
  key text NOT NULL,
  value_ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  description text,
  access_policy text NOT NULL DEFAULT 'auto',
  env_exportable integer NOT NULL DEFAULT 0,
  env_export_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_read_at text,
  last_read_by text,
  CONSTRAINT secrets_global_access_policy_check
    CHECK (access_policy IN ('auto', 'prompt', 'deny')),
  CONSTRAINT secrets_global_env_exportable_check
    CHECK (env_exportable IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_global_key_unique" ON central.secrets_global(key);

CREATE TABLE IF NOT EXISTS central.task_claims (
  project_id text NOT NULL,
  task_id text NOT NULL,
  owner_node_id text NOT NULL,
  owner_agent_id text NOT NULL,
  owner_run_id text,
  lease_epoch integer NOT NULL,
  lease_renewed_at text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS "idxTaskClaimsOwner" ON central.task_claims(owner_node_id);

CREATE TABLE IF NOT EXISTS central.__meta (
  key text PRIMARY KEY,
  value text
);

-- ════════════════════════════════════════════════════════════════════
-- ARCHIVE SCHEMA
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS archive.archived_tasks (
  id text PRIMARY KEY,
  -- FNXC:MultiProjectIsolation 2026-07-12: per-project partition key (see
  -- project.tasks.project_id). The cold-storage archive is shared across
  -- projects on the embedded cluster, so archived-board reads/counts must be
  -- scoped by owner; NULL = legacy/unbound rows.
  project_id text,
  task_json text NOT NULL,
  prompt text,
  archived_at text NOT NULL,
  title text,
  description text NOT NULL,
  comments jsonb DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  column_moved_at text,
  -- FNXC:TaskStoreSearch 2026-06-24-12:40:
  -- Full-text search vector replacing the SQLite FTS5 archived_tasks_fts table.
  -- GENERATED ALWAYS for automatic sync-on-write (VAL-SEARCH-005 archive parity).
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(id, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(comments::text, ''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS "idxArchivedTasksArchivedAt"
  ON archive.archived_tasks(archived_at);
CREATE INDEX IF NOT EXISTS "idxArchiveArchivedTasksProjectId"
  ON archive.archived_tasks(project_id);
CREATE INDEX IF NOT EXISTS "idxArchivedTasksCreatedAt"
  ON archive.archived_tasks(created_at);
-- FNXC:TaskStoreSearch 2026-06-24-12:45:
-- GIN index on the archive search_vector (VAL-SEARCH-005).
CREATE INDEX IF NOT EXISTS "idxArchivedTasksSearchVector"
  ON archive.archived_tasks USING gin(search_vector);

