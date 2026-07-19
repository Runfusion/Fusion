/**
 * Drizzle schema for the per-project working database.
 *
 * FNXC:PostgresSchema 2026-06-24-02:25:
 * Snapshotted from the current final SQLite schema (SCHEMA_VERSION=128) in
 * packages/core/src/db.ts (SCHEMA_SQL + MIGRATION_ONLY_TABLE_SCHEMAS). Every
 * table, column, CHECK constraint, foreign key with cascade rule, and unique
 * index is preserved one-for-one. This file is the schema-as-code source of
 * truth for the project database; the fresh migration SQL in
 * postgres/migrations/0000_initial.sql materializes it.
 *
 * SQLite type mapping (binding):
 *   - INTEGER PRIMARY KEY AUTOINCREMENT → integer().generatedAlwaysAsIdentity()
 *     (sequence continuity: VAL-SCHEMA-006)
 *   - JSON-encoded TEXT (dependencies/steps/log/.../settings/metadata) → jsonb
 *     (round-trip shape parity: VAL-SCHEMA-004)
 *   - BLOB (secrets ciphertext/nonce) → bytea
 *   - INTEGER 0/1 flags → integer (kept verbatim to avoid truthiness drift)
 *   - TEXT timestamps → text (ISO-8601 strings preserved verbatim)
 *   - REAL → real
 *
 * FTS5 tables (tasks_fts, archived_tasks_fts) are replaced by tsvector/GIN
 * generated columns (search_vector) on the tasks table — see the searchVector
 * column definition below (fts-replacement feature, U7). The fresh migration
 * baseline materializes these generated columns and GIN indexes.
 */

import {
  pgSchema,
  text,
  integer,
  bigint,
  real,
  jsonb,
  primaryKey,
  foreignKey,
  unique,
  uniqueIndex,
  check,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { PROJECT_SCHEMA, bytea, tsvector } from "./_shared.js";

/**
 * FNXC:PostgresSchema 2026-06-24-02:25:
 * A dedicated PostgreSQL schema for the project database. Using a named schema
 * (rather than the default `public`) preserves the three-database isolation
 * topology (VAL-SCHEMA-008) within a single cluster, mirroring the three
 * separate SQLite files (fusion.db / fusion-central.db / archive.db).
 */
export const projectSchema = pgSchema(PROJECT_SCHEMA);

// ── Tasks ────────────────────────────────────────────────────────────
export const tasks = projectSchema.table("tasks", {
  id: text("id").notNull(),
  /*
  FNXC:MultiProjectIsolation 2026-07-10:
  Partition key for embedded-PG multi-project isolation. In embedded mode every
  project's per-project TaskStore connects its AsyncDataLayer to ONE shared
  `fusion` database + ONE `project` schema, so this flat tasks table is shared
  across all projects. Without a project_id, per-project engines poll the same
  unfiltered table and claim/execute each other's tasks in the wrong repo.
  This column (populated from the store's bound projectId on every insert and
  filtered on every read/claim/list in backend mode) re-adds the partition key
  the SQLite per-file storage provided implicitly. Nullable so SQLite mode (which
  isolates via per-file storage) and legacy rows are unaffected; the filter is
  a no-op when the layer has no bound projectId (single-project / global reads).
  */
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  lineageId: text("lineage_id"),
  title: text("title"),
  description: text("description").notNull(),
  priority: text("priority").default("normal"),
  column: text("column").notNull(),
  status: text("status"),
  size: text("size"),
  reviewLevel: integer("review_level"),
  currentStep: integer("current_step").default(0),
  worktree: text("worktree"),
  blockedBy: text("blocked_by"),
  overlapBlockedBy: text("overlap_blocked_by"),
  paused: integer("paused").default(0),
  userPaused: integer("user_paused").default(0),
  pausedReason: text("paused_reason"),
  baseBranch: text("base_branch"),
  branch: text("branch"),
  autoMerge: integer("auto_merge"),
  autoMergeProvenance: text("auto_merge_provenance"),
  executionStartBranch: text("execution_start_branch"),
  baseCommitSha: text("base_commit_sha"),
  modelPresetId: text("model_preset_id"),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  validatorModelProvider: text("validator_model_provider"),
  validatorModelId: text("validator_model_id"),
  planningModelProvider: text("planning_model_provider"),
  planningModelId: text("planning_model_id"),
  mergerModelProvider: text("merger_model_provider"),
  mergerModelId: text("merger_model_id"),
  mergerThinkingLevel: text("merger_thinking_level"),
  mergeRetries: integer("merge_retries"),
  workflowStepRetries: integer("workflow_step_retries"),
  resumeLimboCount: integer("resume_limbo_count").default(0),
  graphResumeRetryCount: integer("graph_resume_retry_count").default(0),
  consecutiveToolFailureRetryCount: integer("consecutive_tool_failure_retry_count").default(0),
  executorEscalationAttempted: integer("executor_escalation_attempted").default(0),
  toolFailureDetectorLogCursor: integer("tool_failure_detector_log_cursor"),
  toolFailureRetryExhaustedAuditEmitted: integer("tool_failure_retry_exhausted_audit_emitted").default(0),
  resumeLimboTipSha: text("resume_limbo_tip_sha"),
  resumeLimboStepSignature: text("resume_limbo_step_signature"),
  // FNXC:WorkflowLifecycle 2026-07-12 (merge port from main): FN-7863 execute self-requeue streak.
  executeRequeueLoopCount: integer("execute_requeue_loop_count").default(0),
  executeRequeueLoopSignature: text("execute_requeue_loop_signature"),
  recoveryRetryCount: integer("recovery_retry_count"),
  taskDoneRetryCount: integer("task_done_retry_count").default(0),
  // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker (nullable ISO timestamp).
  bulkCompletionRefusalAt: text("bulk_completion_refusal_at"),
  // FNXC:WorkflowIrPin 2026-07-19-03:10: U9b/KTD-3 durable per-node-entry IR pin + the node it was taken for.
  workflowIrPin: text("workflow_ir_pin"),
  workflowIrPinNodeId: text("workflow_ir_pin_node_id"),
  workflowIrPinColumnId: text("workflow_ir_pin_column_id"),
  // FNXC:LegacyAdoption 2026-07-19-03:10: U9b/KTD-8 one-time legacy-adoption stamp.
  legacyAdoptedAt: text("legacy_adopted_at"),
  worktreeSessionRetryCount: integer("worktree_session_retry_count").default(0),
  completionHandoffLimboRecoveryCount: integer("completion_handoff_limbo_recovery_count").default(0),
  mergeConflictBounceCount: integer("merge_conflict_bounce_count").default(0),
  mergeAuditBounceCount: integer("merge_audit_bounce_count").default(0),
  mergeTransientRetryCount: integer("merge_transient_retry_count").default(0),
  /*
  FNXC:SqliteFinalRemoval 2026-06-25-22:55:
  Six task retry/stuck counters that were missed during the initial schema
  snapshot from SQLite (SCHEMA_VERSION=128). These mirror the SQLite columns
  added by migrations 8/38/48/79. Without them, updateTask silently drops
  these fields in backend (PostgreSQL) mode because the descriptor-driven
  buildTaskInsertValues produces values for unknown Drizzle columns.
  */
  stuckKillCount: integer("stuck_kill_count").default(0),
  postReviewFixCount: integer("post_review_fix_count").default(0),
  planReviewReplanCount: integer("plan_review_replan_count").default(0),
  verificationFailureCount: integer("verification_failure_count").default(0),
  branchConflictRecoveryCount: integer("branch_conflict_recovery_count").default(0),
  reviewerContextRetryCount: integer("reviewer_context_retry_count").default(0),
  reviewerFallbackRetryCount: integer("reviewer_fallback_retry_count").default(0),
  nextRecoveryAt: text("next_recovery_at"),
  error: text("error"),
  summary: text("summary"),
  thinkingLevel: text("thinking_level"),
  // FNXC:Settings-ThinkingLevel 2026-07-13 (merge port): validator/planning reasoning-effort overrides.
  validatorThinkingLevel: text("validator_thinking_level"),
  planningThinkingLevel: text("planning_thinking_level"),
  executionMode: text("execution_mode").default("standard"),
  /*
  FNXC:PlannerOversight 2026-07-14-18:11:
  Per-task session advisor override (null = inherit project default, 0 = off, 1 = on).
  Listed in EXPECTED_PROJECT_COLUMNS so existing embedded-PG DBs self-heal via ALTER TABLE.

  FNXC:PlannerOversight 2026-07-14-18:49:
  Fresh installs also need migration 0008_session_advisor_enabled — self-heal alone
  is not enough for Gate boot-smoke before health reconciliation runs.
  */
  sessionAdvisorEnabled: integer("session_advisor_enabled"),
  tokenUsageInputTokens: bigint("token_usage_input_tokens", { mode: "number" }),
  tokenUsageOutputTokens: bigint("token_usage_output_tokens", { mode: "number" }),
  tokenUsageCachedTokens: bigint("token_usage_cached_tokens", { mode: "number" }),
  tokenUsageCacheWriteTokens: bigint("token_usage_cache_write_tokens", { mode: "number" }),
  tokenUsageTotalTokens: bigint("token_usage_total_tokens", { mode: "number" }),
  tokenUsageFirstUsedAt: text("token_usage_first_used_at"),
  tokenUsageLastUsedAt: text("token_usage_last_used_at"),
  tokenUsageModelProvider: text("token_usage_model_provider"),
  tokenUsageModelId: text("token_usage_model_id"),
  tokenUsagePerModel: jsonb("token_usage_per_model"),
  tokenBudgetSoftAlertedAt: text("token_budget_soft_alerted_at"),
  tokenBudgetHardAlertedAt: text("token_budget_hard_alerted_at"),
  tokenBudgetOverride: jsonb("token_budget_override"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  columnMovedAt: text("column_moved_at"),
  firstExecutionAt: text("first_execution_at"),
  cumulativeActiveMs: bigint("cumulative_active_ms", { mode: "number" }),
  /*
  FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:17:
  Keep the task schema aligned with late SQLite lifecycle migrations. JSON lifecycle markers stay jsonb for native backend reads; retired board/question fields remain text so their legacy payloads round-trip byte-for-byte.
  */
  boardId: text("board_id"),
  taskQuestionInterrupt: text("task_question_interrupt"),
  columnDwellMs: jsonb("column_dwell_ms"),
  workflowTransitionNotification: jsonb("workflow_transition_notification"),
  plannerOversightLevel: text("planner_oversight_level"),
  awaitingApprovalReason: text("awaiting_approval_reason"),
  approvedPlanFingerprint: text("approved_plan_fingerprint"),
  executionStartedAt: text("execution_started_at"),
  executionCompletedAt: text("execution_completed_at"),
  dependencies: jsonb("dependencies").default([]),
  steps: jsonb("steps").default([]),
  log: jsonb("log").default([]),
  attachments: jsonb("attachments").default([]),
  steeringComments: jsonb("steering_comments").default([]),
  comments: jsonb("comments").default([]),
  review: jsonb("review"),
  reviewState: jsonb("review_state"),
  workflowStepResults: jsonb("workflow_step_results").default([]),
  prInfo: jsonb("pr_info"),
  prInfos: jsonb("pr_infos"),
  issueInfo: jsonb("issue_info"),
  githubTracking: jsonb("github_tracking"),
  // FNXC:PostgresCutover 2026-07-04-00:00:
  // gitlab_tracking was missed in the initial SQLite→PG schema snapshot
  // (github_tracking was migrated; this one was not). Without it, GitLab
  // tracking is silently dropped in backend mode and Command Center GitLab
  // analytics can't read filed counts. Mirrors github_tracking (jsonb).
  gitlabTracking: jsonb("gitlab_tracking"),
  sourceIssueProvider: text("source_issue_provider"),
  sourceIssueRepository: text("source_issue_repository"),
  sourceIssueExternalIssueId: text("source_issue_external_issue_id"),
  sourceIssueNumber: integer("source_issue_number"),
  sourceIssueUrl: text("source_issue_url"),
  sourceIssueClosedAt: text("source_issue_closed_at"),
  mergeDetails: jsonb("merge_details"),
  workspaceWorktrees: jsonb("workspace_worktrees"),
  breakIntoSubtasks: integer("break_into_subtasks").default(0),
  noCommitsExpected: integer("no_commits_expected").default(0),
  enabledWorkflowSteps: jsonb("enabled_workflow_steps").default([]),
  modifiedFiles: jsonb("modified_files").default([]),
  missionId: text("mission_id"),
  sliceId: text("slice_id"),
  scopeOverride: integer("scope_override"),
  scopeOverrideReason: text("scope_override_reason"),
  scopeAutoWiden: jsonb("scope_auto_widen").default([]),
  assignedAgentId: text("assigned_agent_id"),
  pausedByAgentId: text("paused_by_agent_id"),
  assigneeUserId: text("assignee_user_id"),
  /*
  FNXC:SqliteFinalRemoval 2026-06-25-22:55:
  Node routing fields (nodeId, effectiveNodeId, effectiveNodeSource) missed
  during the initial schema snapshot. nodeId is the user-specified target;
  effectiveNodeId is the scheduler-resolved target; effectiveNodeSource
  explains how the effective node was chosen (FN-2854). Without these, the
  PG backend silently drops node routing on updateTask.
  */
  nodeId: text("node_id"),
  effectiveNodeId: text("effective_node_id"),
  effectiveNodeSource: text("effective_node_source"),
  sourceType: text("source_type"),
  sourceAgentId: text("source_agent_id"),
  sourceRunId: text("source_run_id"),
  sourceSessionId: text("source_session_id"),
  sourceMessageId: text("source_message_id"),
  sourceParentTaskId: text("source_parent_task_id"),
  sourceMetadata: jsonb("source_metadata"),
  proposalClaimId: text("proposal_claim_id"),
  checkedOutBy: text("checked_out_by"),
  checkedOutAt: text("checked_out_at"),
  checkoutNodeId: text("checkout_node_id"),
  checkoutRunId: text("checkout_run_id"),
  checkoutLeaseRenewedAt: text("checkout_lease_renewed_at"),
  checkoutLeaseEpoch: bigint("checkout_lease_epoch", { mode: "number" }).default(0),
  deletedAt: text("deleted_at"),
  allowResurrection: integer("allow_resurrection").default(0),
  transitionPending: text("transition_pending"),
  customFields: jsonb("custom_fields").default({}),
  /*
  FNXC:TaskStoreSearch 2026-06-24-12:10:
  Full-text search vector for tasks, replacing the SQLite FTS5 external-content
  table (tasks_fts). This is a GENERATED ALWAYS column so PostgreSQL keeps it
  in sync automatically on every INSERT/UPDATE/DELETE (VAL-SEARCH-002/003/004)
  — no triggers needed. The 'simple' text-search configuration is used because
  task text is code-like (task IDs, technical terms); FTS5 used simple
  tokenization, and 'simple' preserves that behavior (no stemming/stopwords).

  The expression concatenates the same columns the FTS5 table indexed:
  id, title, description, and comments (cast to text since comments is jsonb).
  coalesce() guards NULLs so the concatenation never yields NULL.

  Value-aware partial-update optimization (VAL-SEARCH-006): PostgreSQL only
  regenerates a generated column when one of its source columns changes. An
  UPDATE that touches only non-text columns (e.g. status, updated_at) leaves
  search_vector unchanged, so no needless regeneration occurs. This replaces
  the FTS5 value-aware WHEN guard on the update trigger.
  */
  searchVector: tsvector("search_vector").generatedAlwaysAs(
    sql`to_tsvector('simple', coalesce(id, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(comments::text, ''))`,
  ),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  /*
  FNXC:PostgresSchema 2026-06-24-06:00:
  Eight lookup indexes on the tasks table. idx_tasks_deletedAt is the most
  critical: every live reader filters `deleted_at IS NULL` for soft-delete
  visibility (VAL-DATA-005). The others cover hot query paths for column
  boards, agent assignment, lineage traversal, and chronological ordering.
  */
  index("idx_tasks_deletedAt").on(t.deletedAt),
  index("idxTasksAssignedAgentId").on(t.assignedAgentId),
  index("idxTasksAssigneeUserId").on(t.assigneeUserId),
  index("idxTasksColumn").on(t.column),
  index("idxTasksCreatedAt").on(t.createdAt),
  index("idxTasksLineageId").on(t.lineageId),
  index("idxTasksPausedByAgentId").on(t.pausedByAgentId),
  index("idxTasksUpdatedAt").on(t.updatedAt),
  /*
  FNXC:TaskStoreLineage 2026-06-26-10:00:
  The lineage-integrity gate (findLiveLineageChildren / removeLineageReferences)
  filters on source_parent_task_id on every archive/delete. Without this index
  the gate is a full tasks-table scan. Sparse: most rows have NULL parent.
  */
  index("idxTasksSourceParentTaskId").on(t.sourceParentTaskId),
  // FNXC:EphemeralAgentTaskCreation 2026-07-30-12:00: proposal retries share one stable key, so the database—not a read-before-create race—enforces at-most-once materialization.
  uniqueIndex("uqTasksProjectProposalClaimId").on(t.projectId, t.proposalClaimId).where(sql`${t.proposalClaimId} IS NOT NULL`),
  /*
  FNXC:TaskStoreReads 2026-06-26-10:00:
  Partial index for the hot kanban / board-read query shape
  WHERE deleted_at IS NULL AND "column" = ? (every live board hydration).
  The partial predicate shrinks the index to live rows only so the planner
  can serve the most common board filter without a bitmap-AND over two indexes.
  */
  index("idxTasksLiveColumn")
    .on(t.column)
    .where(sql`${t.deletedAt} IS NULL`),
  /*
  FNXC:MultiProjectIsolation 2026-07-10:
  Composite index for the per-project isolation filter. Every backend-mode task
  read/claim/list adds `project_id = $current`; the hottest board query shape is
  `WHERE deleted_at IS NULL AND project_id = ? AND "column" = ?`. Leading with
  project_id (then column) serves the per-project board scan and the scheduler
  poll from one index. Partial on live rows keeps it small.
  */
  index("idxTasksProjectLiveColumn")
    .on(t.projectId, t.column)
    .where(sql`${t.deletedAt} IS NULL`),
  /*
  FNXC:TaskStoreSearch 2026-06-24-12:15:
  GIN index on the search_vector tsvector for full-text search
  (VAL-SEARCH-001). This is the PostgreSQL replacement for the FTS5 index.
  The @@ plainto_tsquery operator uses this index for ranked relevance search.
  The gin_trgm_ops extension is NOT needed; the built-in tsvector_ops is the
  default for tsvector GIN indexes. A REINDEX on this index restores search
  after bloat without data loss (VAL-SEARCH-007).
  */
  index("idxTasksSearchVector").using("gin", t.searchVector),
]);

// ── Config ───────────────────────────────────────────────────────────
export const config = projectSchema.table("config", {
  // FNXC:MultiProjectIsolation 2026-07-11:
  // In embedded-PG mode every project shares this `project` schema, so the old
  // singleton config row (id = 1, enforced by a CHECK constraint) forced ALL
  // projects to share one taskPrefix / maxConcurrent / maxWorktrees. The row is
  // now keyed per-project on `project_id` (the effective PK). `id` is retained
  // for column-shape parity (always 1) but is no longer the PK and no longer
  // CHECK-constrained. Single-project / SQLite-parity callers leave project_id
  // at its '' default (one row), preserving the pre-isolation behavior.
  id: integer("id").default(1),
  projectId: text("project_id").notNull().default("").primaryKey(),
  nextId: integer("next_id").default(1),
  nextWorkflowStepId: integer("next_workflow_step_id").default(1),
  // FNXC:SqliteFinalRemoval 2026-06-28:
  // WF-id counter for createWorkflowDefinition. SQLite stored this in a __meta
  // row (key='nextWorkflowDefinitionId'); PG has no __meta table so the counter
  // lives here alongside next_workflow_step_id. Monotonic, never reused.
  nextWorkflowDefinitionId: integer("next_workflow_definition_id").default(1),
  settings: jsonb("settings").default({}),
  workflowSteps: jsonb("workflow_steps").default([]),
  updatedAt: text("updated_at"),
});

/*
FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
Retired company-board, project-auth, and task-reviewer tables remain part of the cutover preservation contract even though current runtime code no longer reads them. Keep their legacy columns queryable and add project_id to every key and relationship so multiple SQLite project databases can migrate into one shared PostgreSQL schema without collisions.
*/
export const legacyBoards = projectSchema.table("boards", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  workflowId: text("workflow_id").notNull(),
  ordering: integer("ordering").notNull().default(0),
  requirePlanApproval: integer("require_plan_approval").notNull().default(0),
  lfgMode: integer("lfg_mode").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxLegacyBoardsProjectOrdering").on(t.projectId, t.ordering),
]);

export const legacyProjectAuthUsers = projectSchema.table("project_auth_users", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxLegacyProjectAuthUsersEmail").on(t.projectId, t.email),
]);

export const legacyProjectAuthMemberships = projectSchema.table("project_auth_memberships", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({
    columns: [t.projectId, t.userId],
    foreignColumns: [legacyProjectAuthUsers.projectId, legacyProjectAuthUsers.id],
  }).onDelete("cascade"),
  index("idxLegacyProjectAuthMembershipsUser").on(t.projectId, t.userId),
  index("idxLegacyProjectAuthMembershipsRole").on(t.projectId, t.role),
]);

export const legacyProjectAuthProviders = projectSchema.table("project_auth_providers", {
  projectId: text("project_id").notNull(),
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  providerUserId: text("provider_user_id").notNull(),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({
    columns: [t.projectId, t.userId],
    foreignColumns: [legacyProjectAuthUsers.projectId, legacyProjectAuthUsers.id],
  }).onDelete("cascade"),
  uniqueIndex("idxLegacyProjectAuthProvidersIdentity").on(t.projectId, t.provider, t.providerUserId),
  index("idxLegacyProjectAuthProvidersUser").on(t.projectId, t.userId),
]);

export const legacyProjectAuthSessions = projectSchema.table("project_auth_sessions", {
  projectId: text("project_id").notNull(),
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  membershipId: text("membership_id").notNull(),
  sessionToken: text("session_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({
    columns: [t.projectId, t.userId],
    foreignColumns: [legacyProjectAuthUsers.projectId, legacyProjectAuthUsers.id],
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.projectId, t.membershipId],
    foreignColumns: [legacyProjectAuthMemberships.projectId, legacyProjectAuthMemberships.id],
  }).onDelete("cascade"),
  uniqueIndex("idxLegacyProjectAuthSessionsToken").on(t.projectId, t.sessionToken),
  index("idxLegacyProjectAuthSessionsUser").on(t.projectId, t.userId),
  index("idxLegacyProjectAuthSessionsMembership").on(t.projectId, t.membershipId),
  index("idxLegacyProjectAuthSessionsExpiry").on(t.projectId, t.expiresAt),
]);

export const legacyTaskReviewerRuns = projectSchema.table("task_reviewer_runs", {
  projectId: text("project_id").notNull(),
  id: text("id").notNull(),
  taskId: text("task_id").notNull(),
  boardId: text("board_id").notNull().default(""),
  status: text("status").notNull().default("pending"),
  summary: text("summary"),
  failureReasons: text("failure_reasons"),
  reviewerAgentId: text("reviewer_agent_id"),
  reworkRound: integer("rework_round").notNull().default(0),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  invalidatedAt: text("invalidated_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxLegacyTaskReviewerRunsTask").on(t.projectId, t.taskId),
  index("idxLegacyTaskReviewerRunsStatus").on(t.projectId, t.status),
]);

// ── Distributed task ID allocator ────────────────────────────────────
/*
FNXC:ProjectTaskIdentity 2026-07-14-12:32:
Task IDs and allocator state belong to one project. Composite ownership keys let projects reuse the same prefix and task ID without sharing sequence floors, reservations, or merge work.
*/
export const distributedTaskIdState = projectSchema.table("distributed_task_id_state", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  prefix: text("prefix").notNull(),
  nextSequence: integer("next_sequence").notNull(),
  committedClusterTaskCount: integer("committed_cluster_task_count").notNull(),
  lastCommittedTaskId: text("last_committed_task_id"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.prefix] })]);

export const distributedTaskIdReservations = projectSchema.table("distributed_task_id_reservations", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  reservationId: text("reservation_id").notNull(),
  prefix: text("prefix").notNull(),
  nodeId: text("node_id").notNull(),
  sequence: integer("sequence").notNull(),
  taskId: text("task_id").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  expiresAt: text("expires_at").notNull(),
  committedAt: text("committed_at"),
  abortedAt: text("aborted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.reservationId] }),
  foreignKey({ columns: [t.projectId, t.prefix], foreignColumns: [distributedTaskIdState.projectId, distributedTaskIdState.prefix] })
    .onDelete("cascade"),
  unique("distributed_task_id_reservations_prefix_sequence_unique").on(t.projectId, t.prefix, t.sequence),
  unique("distributed_task_id_reservations_prefix_task_id_unique").on(t.projectId, t.prefix, t.taskId),
  check(
    "distributed_task_id_reservations_status_check",
    sql`${t.status} IN ('reserved', 'committed', 'aborted', 'expired')`,
  ),
  check(
    "distributed_task_id_reservations_reason_check",
    sql`${t.reason} IS NULL OR ${t.reason} IN ('abort', 'expired', 'failed-create')`,
  ),
  index("idxDistributedTaskIdReservationsPrefixStatus").on(t.prefix, t.status),
  index("idxDistributedTaskIdReservationsExpiry").on(t.status, t.expiresAt),
]);

// ── Durable symbol locks ─────────────────────────────────────────────
/*
FNXC:SymbolLock 2026-07-30-14:10:
Mission-lineage admission needs one project-scoped row per canonical symbol.
A composite primary key retains released/expired ownership history while the
atomic store seam may reclaim those rows as held without cross-project conflict.
*/
export const symbolLocks = projectSchema.table("symbol_locks", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  symbolKey: text("symbol_key").notNull(),
  ownerTaskId: text("owner_task_id").notNull(),
  missionId: text("mission_id"),
  featureId: text("feature_id"),
  lineageId: text("lineage_id"),
  nodeId: text("node_id"),
  agentId: text("agent_id"),
  status: text("status").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  renewedAt: text("renewed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.symbolKey] }),
  check("symbol_locks_status_check", sql`${t.status} IN ('held', 'released', 'expired')`),
  index("idxSymbolLocksOwner").on(t.projectId, t.ownerTaskId),
  index("idxSymbolLocksExpiry").on(t.status, t.expiresAt),
]);

// ── Workflow step definitions ────────────────────────────────────────
export const workflowSteps = projectSchema.table("workflow_steps", {
  id: text("id").primaryKey(),
  templateId: text("template_id"),
  name: text("name").notNull(),
  description: text("description").notNull(),
  mode: text("mode").notNull().default("prompt"),
  phase: text("phase").notNull().default("pre-merge"),
  prompt: text("prompt").notNull().default(""),
  gateMode: text("gate_mode").notNull().default("advisory"),
  toolMode: text("tool_mode"),
  scriptName: text("script_name"),
  enabled: integer("enabled").notNull().default(1),
  defaultOn: integer("default_on").default(0),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  migratedFragmentId: text("migrated_fragment_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflows = projectSchema.table("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  icon: text("icon"),
  ir: jsonb("ir").notNull(),
  layout: jsonb("layout").notNull().default({}),
  kind: text("kind").notNull().default("workflow"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("idxWorkflowsCreatedAt").on(t.createdAt)]);

export const taskWorkflowSelection = projectSchema.table("task_workflow_selection", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  stepIds: jsonb("step_ids").notNull().default([]),
  updatedAt: text("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.taskId] })]);

/*
FNXC:TaskVerificationRequest 2026-07-30-00:00:
One latest request per project/task gives chat an observable queue while CAS writes
prevent stale executor completions from overwriting a later request.
*/
export const taskVerificationRequests = projectSchema.table("task_verification_requests", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  requestId: text("request_id").notNull(),
  status: text("status").notNull(),
  profile: text("profile").notNull(),
  command: text("command").notNull(),
  scope: text("scope").notNull(),
  requestedBy: text("requested_by").notNull(),
  requestedAt: text("requested_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  result: jsonb("result"),
  rejectionReason: text("rejection_reason"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId] }),
  unique("task_verification_requests_project_request_id_unique").on(t.projectId, t.requestId),
  index("idx_task_verification_requests_status").on(t.projectId, t.status, t.requestedAt),
]);

// ── Activity log ─────────────────────────────────────────────────────
export const activityLog = projectSchema.table("activity_log", {
  // FNXC:AnalyticsIsolation 2026-07-13-23:41: Shared PostgreSQL telemetry must carry an explicit project partition; dashboard ranges must never aggregate another project's activity.
  projectId: text("project_id").notNull(),
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  type: text("type").notNull(),
  taskId: text("task_id"),
  taskTitle: text("task_title"),
  details: text("details").notNull(),
  metadata: jsonb("metadata"),
}, (t) => [
  index("idxActivityLogTimestamp").on(t.timestamp),
  index("idxActivityLogProjectTimestamp").on(t.projectId, t.timestamp),
  index("idxActivityLogType").on(t.type),
  index("idxActivityLogTaskId").on(t.taskId),
  index("idxActivityLogTaskIdTimestamp").on(t.taskId, t.timestamp),
  index("idxActivityLogTypeTimestamp").on(t.type, t.timestamp),
]);

// ── Archived tasks (project-side legacy copy) ────────────────────────
export const archivedTasks = projectSchema.table("archived_tasks", {
  id: text("id").primaryKey(),
  // FNXC:MultiProjectIsolation 2026-07-10: per-project partition key (see tasks.projectId).
  projectId: text("project_id"),
  data: text("data").notNull(),
  archivedAt: text("archived_at").notNull(),
}, (t) => [
  index("idxArchivedTasksId").on(t.id),
  index("idxArchivedTasksProjectId").on(t.projectId),
]);

// ── Task commit associations ─────────────────────────────────────────
export const taskCommitAssociations = projectSchema.table("task_commit_associations", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  taskLineageId: text("task_lineage_id").notNull(),
  taskIdSnapshot: text("task_id_snapshot").notNull(),
  commitSha: text("commit_sha").notNull(),
  commitSubject: text("commit_subject").notNull(),
  authoredAt: text("authored_at").notNull(),
  matchedBy: text("matched_by").notNull(),
  confidence: text("confidence").notNull(),
  note: text("note"),
  additions: integer("additions"),
  deletions: integer("deletions"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  unique("task_commit_associations_task_lineage_id_commit_sha_matched_by_unique")
    .on(t.projectId, t.taskLineageId, t.commitSha, t.matchedBy),
  check(
    "task_commit_associations_matched_by_check",
    sql`${t.matchedBy} IN ('canonical-lineage-trailer', 'legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')`,
  ),
  check(
    "task_commit_associations_confidence_check",
    sql`${t.confidence} IN ('canonical', 'legacy', 'ambiguous')`,
  ),
  index("idxTaskCommitAssociationsLineage").on(t.taskLineageId),
  index("idxTaskCommitAssociationsCommitSha").on(t.commitSha),
]);

// ── Automations ──────────────────────────────────────────────────────
export const automations = projectSchema.table("automations", {
  /*
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * Automations are partitioned by the AsyncDataLayer's project ID because embedded PostgreSQL consolidates the per-project SQLite files into one table. The composite key deliberately permits the same automation ID in two projects without allowing either project's CRUD or cron-claim path to address the other row. The empty default preserves an explicit partition for legacy and project-agnostic callers until startup stamps migrated rows.
   */
  projectId: text("project_id").notNull().default(""),
  id: text("id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  scheduleType: text("schedule_type").notNull(),
  cronExpression: text("cron_expression").notNull(),
  command: text("command").notNull(),
  enabled: integer("enabled").default(1),
  timeoutMs: integer("timeout_ms"),
  steps: jsonb("steps"),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  lastRunResult: jsonb("last_run_result"),
  runCount: integer("run_count").default(0),
  runHistory: jsonb("run_history").default([]),
  scope: text("scope").default("project"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxAutomationsProjectScope").on(t.projectId, t.scope),
  index("idxAutomationsProjectDue").on(t.projectId, t.enabled, t.nextRunAt),
]);

// ── Agents ───────────────────────────────────────────────────────────
export const agents = projectSchema.table("agents", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  state: text("state").notNull().default("idle"),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastHeartbeatAt: text("last_heartbeat_at"),
  metadata: jsonb("metadata").default({}),
  data: jsonb("data").default({}),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxAgentsState").on(t.state),
]);

export const agentHeartbeats = projectSchema.table("agent_heartbeats", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: integer("id").generatedAlwaysAsIdentity().notNull(),
  agentId: text("agent_id").notNull(),
  timestamp: text("timestamp").notNull(),
  status: text("status").notNull(),
  runId: text("run_id").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.agentId], foreignColumns: [agents.projectId, agents.id] }).onDelete("cascade"),
  index("idxAgentHeartbeatsAgentId").on(t.agentId),
  index("idxAgentHeartbeatsRunId").on(t.runId),
  index("idxAgentHeartbeatsAgentIdTimestamp").on(t.agentId, t.timestamp),
]);

export const agentRuns = projectSchema.table("agent_runs", {
  // FNXC:AnalyticsIsolation 2026-07-13-23:41: Agent-run analytics are project-scoped even though run IDs remain globally unique.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  agentId: text("agent_id").notNull(),
  data: jsonb("data").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  status: text("status").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.agentId], foreignColumns: [agents.projectId, agents.id] }).onDelete("cascade"),
  index("idxAgentRunsAgentIdStartedAt").on(t.agentId, t.startedAt),
  index("idxAgentRunsProjectStartedAt").on(t.projectId, t.startedAt),
  index("idxAgentRunsStatus").on(t.status),
]);

export const agentTaskSessions = projectSchema.table("agent_task_sessions", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  agentId: text("agent_id").notNull(),
  taskId: text("task_id").notNull(),
  data: jsonb("data").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.agentId, t.taskId] }),
  foreignKey({ columns: [t.projectId, t.agentId], foreignColumns: [agents.projectId, agents.id] }).onDelete("cascade"),
]);

export const agentApiKeys = projectSchema.table("agent_api_keys", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  agentId: text("agent_id").notNull(),
  data: jsonb("data").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.agentId], foreignColumns: [agents.projectId, agents.id] }).onDelete("cascade"),
  index("idxAgentApiKeysAgentId").on(t.agentId),
]);

export const agentConfigRevisions = projectSchema.table("agent_config_revisions", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  agentId: text("agent_id").notNull(),
  data: jsonb("data").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.agentId], foreignColumns: [agents.projectId, agents.id] }).onDelete("cascade"),
  index("idxAgentConfigRevisionsAgentIdCreatedAt").on(t.agentId, t.createdAt),
]);

export const agentBlockedStates = projectSchema.table("agent_blocked_states", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  agentId: text("agent_id").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.agentId] }),
  foreignKey({ columns: [t.projectId, t.agentId], foreignColumns: [agents.projectId, agents.id] }).onDelete("cascade"),
]);

// ── Merge queue / merge requests / handoff ───────────────────────────
export const mergeQueue = projectSchema.table("merge_queue", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  enqueuedAt: text("enqueued_at").notNull(),
  priority: text("priority").notNull().default("normal"),
  leasedBy: text("leased_by"),
  leasedAt: text("leased_at"),
  leaseExpiresAt: text("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  index("idx_mergeQueue_lease_ready").on(t.leasedBy, t.priority, t.enqueuedAt),
  index("idx_mergeQueue_leaseExpiresAt").on(t.leaseExpiresAt),
]);

export const mergeRequests = projectSchema.table("merge_requests", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  state: text("state").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  index("idx_merge_requests_state_updatedAt").on(t.state, t.updatedAt),
]);

export const completionHandoffMarkers = projectSchema.table("completion_handoff_markers", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  acceptedAt: text("accepted_at").notNull(),
  source: text("source").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  index("idx_completion_handoff_markers_acceptedAt").on(t.acceptedAt),
]);

// ── Workflow work items ──────────────────────────────────────────────
export const workflowWorkItems = projectSchema.table("workflow_work_items", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  runId: text("run_id").notNull(),
  taskId: text("task_id").notNull(),
  nodeId: text("node_id").notNull(),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  attempt: integer("attempt").notNull().default(0),
  retryAfter: text("retry_after"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  lastError: text("last_error"),
  blockedReason: text("blocked_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  unique("workflow_work_items_run_id_task_id_node_id_kind_unique")
    .on(t.projectId, t.runId, t.taskId, t.nodeId, t.kind),
  index("idx_workflow_work_items_due").on(t.state, t.retryAfter, t.createdAt),
  index("idx_workflow_work_items_leaseExpiresAt").on(t.leaseExpiresAt),
  index("idx_workflow_work_items_task_run").on(t.taskId, t.runId),
]);

export const workflowRunBranches = projectSchema.table("workflow_run_branches", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  runId: text("run_id").notNull(),
  branchId: text("branch_id").notNull(),
  currentNodeId: text("current_node_id").notNull(),
  status: text("status").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId, t.runId, t.branchId] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  index("idx_workflow_run_branches_task_run").on(t.taskId, t.runId),
]);

export const workflowRunStepInstances = projectSchema.table("workflow_run_step_instances", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskId: text("task_id").notNull(),
  runId: text("run_id").notNull(),
  foreachNodeId: text("foreach_node_id").notNull(),
  stepIndex: integer("step_index").notNull(),
  pinnedStepCount: integer("pinned_step_count").notNull(),
  currentNodeId: text("current_node_id"),
  status: text("status").notNull(),
  baselineSha: text("baseline_sha"),
  checkpointId: text("checkpoint_id"),
  reworkCount: integer("rework_count").notNull().default(0),
  branchName: text("branch_name"),
  integratedAt: text("integrated_at"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId, t.runId, t.foreachNodeId, t.stepIndex] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  index("idx_workflow_run_step_instances_task_run").on(t.taskId, t.runId),
]);

export const workflowSettings = projectSchema.table("workflow_settings", {
  workflowId: text("workflow_id").notNull(),
  projectId: text("project_id").notNull(),
  values: jsonb("values").default({}),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.workflowId, t.projectId] }),
  index("idx_workflow_settings_project").on(t.projectId),
]);

export const workflowPromptOverrides = projectSchema.table("workflow_prompt_overrides", {
  workflowId: text("workflow_id").notNull(),
  projectId: text("project_id").notNull(),
  overrides: jsonb("overrides").notNull().default({}),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.workflowId, t.projectId] }),
  index("idx_workflow_prompt_overrides_project").on(t.projectId),
]);

/*
FNXC:ConfigVersioning 2026-07-18-00:00:
Configuration history is project-partitioned even for central/global settings:
the reserved owner identity prevents a write initiated by one project from being
misattributed to that incidental project's history.
*/
export const configurationRevisions = projectSchema.table("configuration_revisions", {
  projectId: text("project_id").notNull(),
  id: text("id").notNull(),
  /* FNXC:ConfigVersioning 2026-07-18-14:00: a database-assigned sequence breaks same-millisecond timestamp ties so newest-first history remains chronological. */
  sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
  ownerScope: text("owner_scope").notNull(),
  configKind: text("config_kind").notNull(),
  configTarget: jsonb("config_target").notNull(),
  configTargetKey: text("config_target_key").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  diffs: jsonb("diffs").notNull().default([]),
  changedBy: jsonb("changed_by").notNull(),
  source: text("source").notNull(),
  rollbackToRevisionId: text("rollback_to_revision_id"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idx_configuration_revisions_target_newest").on(t.projectId, t.configKind, t.configTargetKey, t.createdAt, t.sequence),
]);

// ── Task documents + revisions ───────────────────────────────────────
export const taskDocuments = projectSchema.table("task_documents", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  taskId: text("task_id").notNull(),
  key: text("key").notNull(),
  content: text("content").notNull().default(""),
  revision: integer("revision").notNull().default(1),
  author: text("author").notNull().default("user"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("cascade"),
  unique("task_documents_task_id_key_unique").on(t.projectId, t.taskId, t.key),
  index("idxTaskDocumentsTaskId").on(t.taskId),
]);

export const artifacts = projectSchema.table("artifacts", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  uri: text("uri"),
  content: text("content"),
  authorId: text("author_id").notNull(),
  authorType: text("author_type").notNull().default("agent"),
  taskId: text("task_id"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.taskId], foreignColumns: [tasks.id] }).onDelete("cascade"),
  index("idxArtifactsTaskId").on(t.taskId),
  index("idxArtifactsAuthorId").on(t.authorId),
  index("idxArtifactsType").on(t.type),
  index("idxArtifactsCreatedAt").on(t.createdAt),
]);

export const taskDocumentRevisions = projectSchema.table("task_document_revisions", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  projectId: text("project_id"),
  legacySqliteId: integer("legacy_sqlite_id"),
  taskId: text("task_id").notNull(),
  key: text("key").notNull(),
  content: text("content").notNull(),
  revision: integer("revision").notNull(),
  author: text("author").notNull(),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idxTaskDocumentRevisionsTaskKey").on(t.taskId, t.key),
  unique("task_document_revisions_legacy_identity_unique").on(t.projectId, t.legacySqliteId),
]);

// ── Research runs ────────────────────────────────────────────────────
export const researchRuns = projectSchema.table("research_runs", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  topic: text("topic"),
  status: text("status").notNull(),
  projectId: text("project_id"),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  trigger: text("trigger"),
  providerConfig: jsonb("provider_config"),
  sources: jsonb("sources").notNull().default([]),
  events: jsonb("events").notNull().default([]),
  results: jsonb("results"),
  error: text("error"),
  tokenUsage: jsonb("token_usage"),
  tags: jsonb("tags").notNull().default([]),
  metadata: jsonb("metadata"),
  lifecycle: jsonb("lifecycle"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  cancelledAt: text("cancelled_at"),
}, (t) => [
  index("idxResearchRunsStatus").on(t.status),
  index("idxResearchRunsCreatedAt").on(t.createdAt),
  index("idxResearchRunsUpdatedAt").on(t.updatedAt),
  index("idxResearchRunsProjectTriggerStatus").on(t.projectId, t.trigger, t.status),
]);

export const researchExports = projectSchema.table("research_exports", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  format: text("format").notNull(),
  content: text("content").notNull(),
  filePath: text("file_path"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.runId], foreignColumns: [researchRuns.id] }).onDelete("cascade"),
  index("idxResearchExportsRunId").on(t.runId),
]);

export const researchRunEvents = projectSchema.table("research_run_events", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  status: text("status"),
  classification: text("classification"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.runId], foreignColumns: [researchRuns.id] }).onDelete("cascade"),
  index("idxResearchRunEventsRunIdSeq").on(t.runId, t.seq),
]);

// ── Experiment sessions ──────────────────────────────────────────────
export const experimentSessions = projectSchema.table("experiment_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  projectId: text("project_id"),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  status: text("status").notNull(),
  metric: text("metric").notNull(),
  currentSegment: integer("current_segment").notNull().default(1),
  maxIterations: integer("max_iterations"),
  workingDir: text("working_dir"),
  baselineRunId: text("baseline_run_id"),
  bestRunId: text("best_run_id"),
  keptRunIds: jsonb("kept_run_ids").notNull().default([]),
  tags: jsonb("tags").notNull().default([]),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  finalizedAt: text("finalized_at"),
}, (t) => [
  index("idxExperimentSessionsStatus").on(t.status),
  index("idxExperimentSessionsProject").on(t.projectId),
  index("idxExperimentSessionsCreatedAt").on(t.createdAt),
]);

export const experimentSessionRecords = projectSchema.table("experiment_session_records", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  segment: integer("segment").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.sessionId], foreignColumns: [experimentSessions.id] }).onDelete("cascade"),
  unique("experiment_session_records_session_id_seq_unique").on(t.sessionId, t.seq),
  index("idxExperimentRecordsSessionSegment").on(t.sessionId, t.segment, t.seq),
  index("idxExperimentRecordsType").on(t.sessionId, t.type),
]);

// ── Eval runs ────────────────────────────────────────────────────────
export const evalRuns = projectSchema.table("eval_runs", {
  id: text("id").notNull(),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: reflect the DB default installed by migration 0006 so insert types treat the trigger/GUC-owned partition as optional; stores must not write it.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  status: text("status").notNull(),
  trigger: text("trigger").notNull(),
  scope: text("scope").notNull(),
  window: jsonb("window").notNull().default({}),
  requestedTaskIds: jsonb("requested_task_ids").notNull().default([]),
  evaluatedTaskIds: jsonb("evaluated_task_ids").notNull().default([]),
  counts: jsonb("counts").notNull().default({ totalTasks: 0, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 }),
  aggregateScores: jsonb("aggregate_scores"),
  summary: text("summary"),
  error: text("error"),
  provenance: jsonb("provenance"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  cancelledAt: text("cancelled_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxEvalRunsProjectIdCreatedAt").on(t.projectId, t.createdAt),
  index("idxEvalRunsProjectTriggerStatus").on(t.projectId, t.trigger, t.status),
  index("idxEvalRunsStatusCreatedAt").on(t.status, t.createdAt),
]);

export const evalTaskResults = projectSchema.table("eval_task_results", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  runId: text("run_id").notNull(),
  taskId: text("task_id").notNull(),
  taskSnapshot: jsonb("task_snapshot").notNull(),
  status: text("status").notNull(),
  overallScore: real("overall_score"),
  maxScore: real("max_score"),
  categoryScores: jsonb("category_scores").notNull().default([]),
  rationale: text("rationale"),
  summary: text("summary"),
  evidence: jsonb("evidence").notNull().default([]),
  deterministicSignals: jsonb("deterministic_signals").notNull().default([]),
  aiSignals: jsonb("ai_signals"),
  followUps: jsonb("follow_ups").notNull().default([]),
  provenance: jsonb("provenance"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.runId], foreignColumns: [evalRuns.projectId, evalRuns.id] }).onDelete("cascade"),
  index("idxEvalTaskResultsRunIdCreatedAt").on(t.runId, t.createdAt),
  index("idxEvalTaskResultsTaskIdCreatedAt").on(t.taskId, t.createdAt),
  index("idxEvalTaskResultsStatusRunId").on(t.status, t.runId),
  unique("idxEvalTaskResultsRunTaskUnique").on(t.projectId, t.runId, t.taskId),
]);

export const evalRunEvents = projectSchema.table("eval_run_events", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  status: text("status"),
  taskId: text("task_id"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.runId], foreignColumns: [evalRuns.projectId, evalRuns.id] }).onDelete("cascade"),
  index("idxEvalRunEventsRunIdSeq").on(t.runId, t.seq),
]);

// ── Secrets (project-scoped) ─────────────────────────────────────────
export const secrets = projectSchema.table("secrets", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  valueCiphertext: bytea("value_ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  description: text("description"),
  accessPolicy: text("access_policy").notNull().default("auto"),
  envExportable: integer("env_exportable").notNull().default(0),
  envExportKey: text("env_export_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastReadAt: text("last_read_at"),
  lastReadBy: text("last_read_by"),
}, (t) => [
  unique("secrets_key_unique").on(t.key),
  check("secrets_access_policy_check", sql`${t.accessPolicy} IN ('auto', 'prompt', 'deny')`),
  check("secrets_env_exportable_check", sql`${t.envExportable} IN (0, 1)`),
]);

// ── Schema version meta ──────────────────────────────────────────────
export const projectMeta = projectSchema.table("__meta", {
  /*
  FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
  Embedded PostgreSQL is shared by every registered project, so SQLite __meta keys must be partitioned by the authoritative registry project ID. A global key primary key makes the second project inherit or overwrite the first project's identity and migration markers.
  */
  projectId: text("project_id").notNull(),
  key: text("key").notNull(),
  value: text("value"),
}, (t) => [primaryKey({ columns: [t.projectId, t.key] })]);

// ── Missions hierarchy ───────────────────────────────────────────────
export const missions = projectSchema.table("missions", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  interviewState: text("interview_state").notNull(),
  baseBranch: text("base_branch"),
  branchStrategy: text("branch_strategy"),
  autoAdvance: integer("auto_advance").default(0),
  autoMerge: integer("auto_merge"),
  // FNXC:MissionStore 2026-06-24-08:00:
  // Autopilot columns were added via addColumnIfMissing in SQLite migrations
  // (db.ts SCHEMA_VERSION=128) but were missing from the initial U3 snapshot.
  // Added here for VAL-SCHEMA-001 final-schema parity. These track the
  // autonomous mission execution state (enabled flag, state machine, activity
  // heartbeat) consumed by MissionStore.rowToMission.
  autopilotEnabled: integer("autopilot_enabled").notNull().default(0),
  autopilotState: text("autopilot_state").notNull().default("inactive"),
  lastAutopilotActivityAt: text("last_autopilot_activity_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.id] })]);

export const branchGroups = projectSchema.table("branch_groups", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  branchName: text("branch_name").notNull().unique(),
  worktreePath: text("worktree_path"),
  autoMerge: integer("auto_merge").notNull().default(0),
  prState: text("pr_state").notNull().default("none"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  status: text("status").notNull().default("open"),
  // FNXC:PostgresSchema 2026-06-24-12:00:
  // Epoch-millis timestamps require bigint (int64). The SQLite schema used
  // INTEGER (64-bit in SQLite), but the initial PostgreSQL snapshot mapped
  // these to integer (int32), which overflows at current epoch millis
  // (~1.78e12 > 2.14e9 int32 max). Fixed to bigint in U14.
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  closedAt: bigint("closed_at", { mode: "number" }),
}, (t) => [
  check("branch_groups_source_type_check", sql`${t.sourceType} IN ('mission','planning','new-task')`),
  check("branch_groups_pr_state_check", sql`${t.prState} IN ('none','open','merged','closed')`),
  check("branch_groups_status_check", sql`${t.status} IN ('open','finalized','abandoned')`),
  index("idxBranchGroupsSource").on(t.sourceType, t.sourceId),
  index("idxBranchGroupsBranchName").on(t.branchName),
]);

export const pullRequests = projectSchema.table("pull_requests", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  repo: text("repo").notNull(),
  headBranch: text("head_branch").notNull(),
  baseBranch: text("base_branch"),
  state: text("state").notNull().default("creating"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  headOid: text("head_oid"),
  mergeable: text("mergeable"),
  checksRollup: jsonb("checks_rollup"),
  reviewDecision: text("review_decision"),
  autoMerge: integer("auto_merge").notNull().default(0),
  unverified: integer("unverified").notNull().default(0),
  failureReason: text("failure_reason"),
  responseRounds: integer("response_rounds").notNull().default(0),
  // FNXC:PostgresSchema 2026-06-24-12:00:
  // Epoch-millis timestamps require bigint (int64). See branch_groups note.
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  closedAt: bigint("closed_at", { mode: "number" }),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  check("pull_requests_source_type_check", sql`${t.sourceType} IN ('task','branch-group')`),
  check(
    "pull_requests_state_check",
    sql`${t.state} IN ('creating','open','responding','merged','closed','failed')`,
  ),
  unique("idxPullRequestsOpenSource").on(t.projectId, t.sourceType, t.sourceId),
  unique("idxPullRequestsOpenBranch").on(t.projectId, t.repo, t.headBranch),
  unique("idxPullRequestsNumber").on(t.projectId, t.repo, t.prNumber),
]);

export const pullRequestThreadState = projectSchema.table("pull_request_thread_state", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  prEntityId: text("pr_entity_id").notNull(),
  threadId: text("thread_id").notNull(),
  headOid: text("head_oid").notNull(),
  outcome: text("outcome").notNull(),
  fixCommitSha: text("fix_commit_sha"),
  // FNXC:PostgresSchema 2026-06-24-12:00: Epoch-millis → bigint (see branch_groups note).
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.prEntityId, t.threadId, t.headOid] }),
  foreignKey({ columns: [t.projectId, t.prEntityId], foreignColumns: [pullRequests.projectId, pullRequests.id] }).onDelete("cascade"),
  check("pull_request_thread_state_outcome_check", sql`${t.outcome} IN ('fixed','disagreed','pending')`),
]);

export const goals = projectSchema.table("goals", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxGoalsStatus").on(t.status),
]);

export const missionGoals = projectSchema.table("mission_goals", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  missionId: text("mission_id").notNull(),
  goalId: text("goal_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.missionId, t.goalId] }),
  foreignKey({ columns: [t.projectId, t.missionId], foreignColumns: [missions.projectId, missions.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.projectId, t.goalId], foreignColumns: [goals.projectId, goals.id] }).onDelete("cascade"),
  index("idxMissionGoalsGoalId").on(t.goalId),
]);

export const goalCitations = projectSchema.table("goal_citations", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: integer("id").generatedAlwaysAsIdentity().notNull(),
  goalId: text("goal_id").notNull(),
  agentId: text("agent_id").notNull(),
  taskId: text("task_id"),
  surface: text("surface").notNull(),
  sourceRef: text("source_ref").notNull(),
  snippet: text("snippet").notNull(),
  timestamp: text("timestamp").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxGoalCitationsGoalId").on(t.goalId),
  index("idxGoalCitationsAgentId").on(t.agentId),
  index("idxGoalCitationsTimestamp").on(t.timestamp),
  unique("uxGoalCitationsDedup").on(t.projectId, t.goalId, t.surface, t.sourceRef),
]);

export const milestones = projectSchema.table("milestones", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  missionId: text("mission_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  orderIndex: integer("order_index").notNull(),
  interviewState: text("interview_state").notNull(),
  // FNXC:MissionStore 2026-06-24-08:05:
  // dependencies is a JSON array of milestone IDs stored as jsonb (was TEXT
  // DEFAULT '[]' in SQLite). acceptanceCriteria is a PLAIN TEXT string (derived
  // acceptance criteria bullet list), NOT jsonb — the U3 snapshot incorrectly
  // mapped it as jsonb. Fixed to text to match the SQLite TEXT column and the
  // MissionStore read/write semantics (rowToMilestone reads it as a raw string).
  dependencies: jsonb("dependencies").default([]),
  planningNotes: text("planning_notes"),
  verification: text("verification"),
  acceptanceCriteria: text("acceptance_criteria"),
  validationState: text("validation_state").notNull().default("not_started"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.missionId], foreignColumns: [missions.projectId, missions.id] }).onDelete("cascade"),
]);

export const slices = projectSchema.table("slices", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  milestoneId: text("milestone_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  orderIndex: integer("order_index").notNull(),
  activatedAt: text("activated_at"),
  // FNXC:MissionStore 2026-06-24-08:10:
  // planState/planningNotes/verification were added via addColumnIfMissing in
  // SQLite migrations but missing from the U3 snapshot. Added for VAL-SCHEMA-001
  // parity. planState tracks the slice planning interview lifecycle
  // (not_started → in_progress → planned), consumed by MissionStore.rowToSlice.
  planState: text("plan_state").notNull().default("not_started"),
  planningNotes: text("planning_notes"),
  verification: text("verification"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.milestoneId], foreignColumns: [milestones.projectId, milestones.id] }).onDelete("cascade"),
]);

export const missionFeatures = projectSchema.table("mission_features", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  sliceId: text("slice_id").notNull(),
  taskId: text("task_id"),
  title: text("title").notNull(),
  description: text("description"),
  // FNXC:MissionStore 2026-06-24-08:15:
  // acceptanceCriteria is a PLAIN TEXT string (feature acceptance criteria
  // bullet list), NOT jsonb. The U3 snapshot incorrectly mapped it as jsonb;
  // fixed to text to match the SQLite TEXT column and MissionStore semantics.
  acceptanceCriteria: text("acceptance_criteria"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // FNXC:MissionStore 2026-06-24-08:20:
  // Feature loop/attempts columns were added via addColumnIfMissing in SQLite
  // migrations but missing from the U3 snapshot. These track the
  // implement→validate→fix loop state machine (FeatureLoopState), attempt
  // counters, last validator run linkage, and generated-fix-feature lineage.
  // Consumed by MissionStore.rowToFeature.
  loopState: text("loop_state").notNull().default("idle"),
  implementationAttemptCount: integer("implementation_attempt_count").notNull().default(0),
  validatorAttemptCount: integer("validator_attempt_count").notNull().default(0),
  lastValidatorRunId: text("last_validator_run_id"),
  lastValidatorStatus: text("last_validator_status"),
  generatedFromFeatureId: text("generated_from_feature_id"),
  generatedFromRunId: text("generated_from_run_id"),
  // FNXC:ResearchMissionBridge 2026-07-18-12:00: Store run/finding/source lineage as columns so duplicate promotion is project+slice scoped and citations remain queryable.
  researchRunId: text("research_run_id"),
  researchFindingId: text("research_finding_id"),
  researchSourceUrls: jsonb("research_source_urls"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.sliceId], foreignColumns: [slices.projectId, slices.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete("set null"),
  uniqueIndex("mission_features_research_promotion_unique").on(t.projectId, t.sliceId, t.researchRunId, t.researchFindingId),
]);

/*
FNXC:Ideation 2026-07-30-15:30:
Persist sessions and candidates under the same project partition as Missions.
Composite project FKs make it impossible for convergence linkage to point into a
foreign project's roadmap, while candidate cascade deletion keeps a deleted
session from leaving unbounded brainstorm artifacts behind.
*/
export const ideationSessions = projectSchema.table("ideation_sessions", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  title: text("title").notNull(),
  prompt: text("prompt"),
  status: text("status").notNull().default("open"),
  targetMissionId: text("target_mission_id"),
  targetFeatureId: text("target_feature_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  convergedAt: text("converged_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.targetMissionId], foreignColumns: [missions.projectId, missions.id] }).onDelete("restrict"),
  foreignKey({ columns: [t.projectId, t.targetFeatureId], foreignColumns: [missionFeatures.projectId, missionFeatures.id] }).onDelete("restrict"),
  check("ideation_sessions_status_check", sql`${t.status} IN ('open','converged','archived')`),
]);

export const ideationCandidates = projectSchema.table("ideation_candidates", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  sessionId: text("session_id").notNull(),
  content: text("content").notNull(),
  origin: text("origin").notNull(),
  sourceRef: text("source_ref"),
  selected: integer("selected").notNull().default(0),
  linkedMissionId: text("linked_mission_id"),
  linkedFeatureId: text("linked_feature_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.sessionId], foreignColumns: [ideationSessions.projectId, ideationSessions.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.projectId, t.linkedMissionId], foreignColumns: [missions.projectId, missions.id] }).onDelete("restrict"),
  foreignKey({ columns: [t.projectId, t.linkedFeatureId], foreignColumns: [missionFeatures.projectId, missionFeatures.id] }).onDelete("restrict"),
  check("ideation_candidates_origin_check", sql`${t.origin} IN ('agent','human','research')`),
  check("ideation_candidates_selected_check", sql`${t.selected} IN (0, 1)`),
  index("idxIdeationCandidatesSession").on(t.projectId, t.sessionId),
]);

export const missionEvents = projectSchema.table("mission_events", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  missionId: text("mission_id").notNull(),
  eventType: text("event_type").notNull(),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
  timestamp: text("timestamp").notNull(),
  seq: integer("seq").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.missionId], foreignColumns: [missions.projectId, missions.id] }).onDelete("cascade"),
  index("idxMissionEventsMissionId").on(t.missionId),
  index("idxMissionEventsTimestamp").on(t.timestamp),
  index("idxMissionEventsType").on(t.eventType),
]);

// ── Plugins / routines / insights ───────────────────────────────────
export const plugins = projectSchema.table("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  author: text("author"),
  homepage: text("homepage"),
  path: text("path").notNull(),
  enabled: integer("enabled").default(1),
  state: text("state").notNull().default("installed"),
  settings: jsonb("settings").default({}),
  settingsSchema: jsonb("settings_schema"),
  error: text("error"),
  dependencies: jsonb("dependencies").default([]),
  aiScanOnLoad: integer("ai_scan_on_load").notNull().default(0),
  lastSecurityScan: text("last_security_scan"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const routines = projectSchema.table("routines", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  agentId: text("agent_id").notNull().default(""),
  name: text("name").notNull(),
  description: text("description"),
  triggerType: text("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config").notNull(),
  command: text("command"),
  steps: jsonb("steps"),
  timeoutMs: integer("timeout_ms"),
  catchUpPolicy: text("catch_up_policy").notNull().default("run_one"),
  executionPolicy: text("execution_policy").notNull().default("queue"),
  catchUpLimit: integer("catch_up_limit").default(5),
  enabled: integer("enabled").default(1),
  lastRunAt: text("last_run_at"),
  lastRunResult: jsonb("last_run_result"),
  nextRunAt: text("next_run_at"),
  runCount: integer("run_count").default(0),
  runHistory: jsonb("run_history").default([]),
  scope: text("scope").default("project"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxRoutinesNextRunAt").on(t.nextRunAt),
  index("idxRoutinesEnabled").on(t.enabled),
  index("idxRoutinesScope").on(t.scope),
]);

export const projectInsights = projectSchema.table("project_insights", {
  id: text("id").primaryKey(),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: reflect the DB default installed by migration 0006 so insert types treat the trigger/GUC-owned partition as optional; stores must not write it.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  title: text("title").notNull(),
  content: text("content"),
  category: text("category").notNull(),
  status: text("status").notNull(),
  fingerprint: text("fingerprint").notNull(),
  provenance: jsonb("provenance"),
  lastRunId: text("last_run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idxProjectInsightsProjectId").on(t.projectId),
  index("idxProjectInsightsFingerprint").on(t.projectId, t.fingerprint),
  index("idxProjectInsightsCategory").on(t.category),
]);

export const projectInsightRuns = projectSchema.table("project_insight_runs", {
  id: text("id").notNull(),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: reflect the DB default installed by migration 0006 so insert types treat the trigger/GUC-owned partition as optional; stores must not write it.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  error: text("error"),
  insightsCreated: integer("insights_created").notNull().default(0),
  insightsUpdated: integer("insights_updated").notNull().default(0),
  inputMetadata: jsonb("input_metadata"),
  outputMetadata: jsonb("output_metadata"),
  lifecycle: jsonb("lifecycle"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  cancelledAt: text("cancelled_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxInsightRunsProjectId").on(t.projectId),
  index("idxInsightRunsProjectTriggerStatus").on(t.projectId, t.trigger, t.status),
]);

export const projectInsightRunEvents = projectSchema.table("project_insight_run_events", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  status: text("status"),
  classification: text("classification"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.runId], foreignColumns: [projectInsightRuns.projectId, projectInsightRuns.id] }).onDelete("cascade"),
  index("idxInsightRunEventsRunIdSeq").on(t.runId, t.seq),
]);

// ── Todo lists ───────────────────────────────────────────────────────
export const todoLists = projectSchema.table("todo_lists", {
  id: text("id").notNull(),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: reflect the DB default installed by migration 0006 so insert types treat the trigger/GUC-owned partition as optional; stores must not write it.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.id] })]);

export const todoItems = projectSchema.table("todo_items", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  listId: text("list_id").notNull(),
  text: text("text").notNull(),
  completed: integer("completed").notNull().default(0),
  completedAt: text("completed_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  foreignKey({ columns: [t.projectId, t.listId], foreignColumns: [todoLists.projectId, todoLists.id] }).onDelete("cascade"),
  index("idxTodoItemsListId").on(t.listId),
  index("idxTodoItemsSortOrder").on(t.listId, t.sortOrder),
]);

// ── Usage events / plugin activations / knowledge pages / monitor ────
export const usageEvents = projectSchema.table("usage_events", {
  // FNXC:AnalyticsIsolation 2026-07-13-23:41: Usage events share one PostgreSQL table, so every write and query requires the owning project ID.
  projectId: text("project_id").notNull(),
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  ts: text("ts").notNull(),
  kind: text("kind").notNull(),
  taskId: text("task_id"),
  agentId: text("agent_id"),
  nodeId: text("node_id"),
  model: text("model"),
  provider: text("provider"),
  toolName: text("tool_name"),
  category: text("category"),
  meta: jsonb("meta"),
}, (t) => [
  index("idxUsageEventsTs").on(t.ts),
  index("idxUsageEventsProjectTs").on(t.projectId, t.ts),
  index("idxUsageEventsTaskId").on(t.taskId),
  index("idxUsageEventsAgentId").on(t.agentId),
  index("idxUsageEventsKindTs").on(t.kind, t.ts),
]);

export const pluginActivations = projectSchema.table("plugin_activations", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  pluginId: text("plugin_id").notNull(),
  source: text("source").notNull(),
  pluginVersion: text("plugin_version"),
  activatedAt: text("activated_at").notNull(),
}, (t) => [
  index("idxPluginActivationsActivatedAt").on(t.activatedAt),
  index("idxPluginActivationsPluginId").on(t.pluginId),
]);

export const knowledgePages = projectSchema.table("knowledge_pages", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  // FNXC:KnowledgeIndex 2026-07-14-16:35:
  // Knowledge pages contain task and PR history, so their Drizzle model must expose the project ownership added by migration 0006. Async dashboard reads and upserts use this key explicitly in addition to the database RLS policy.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  sourceKey: text("source_key").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  content: text("content").notNull(),
  tags: jsonb("tags"),
  searchText: text("search_text").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("knowledge_pages_source_key_unique").on(t.projectId, t.sourceKey),
  index("idxKnowledgePagesSourceKind").on(t.sourceKind),
  index("idxKnowledgePagesUpdatedAt").on(t.updatedAt),
]);

export const deployments = projectSchema.table("deployments", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  projectId: text("project_id").notNull().default(""),
  deploymentId: text("deployment_id").notNull(),
  service: text("service"),
  environment: text("environment"),
  version: text("version"),
  status: text("status"),
  deployedAt: text("deployed_at").notNull(),
  link: text("link"),
  meta: jsonb("meta"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("idxDeploymentsProjectDeploymentId").on(t.projectId, t.deploymentId),
  index("idxDeploymentsProjectDeployedAt").on(t.projectId, t.deployedAt),
  index("idxDeploymentsDeployedAt").on(t.deployedAt),
  index("idxDeploymentsService").on(t.service),
]);

export const incidents = projectSchema.table("incidents", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  projectId: text("project_id").notNull().default(""),
  incidentId: text("incident_id").notNull().unique(),
  groupingKey: text("grouping_key").notNull(),
  title: text("title").notNull(),
  severity: text("severity"),
  status: text("status").notNull(),
  source: text("source"),
  fixTaskId: text("fix_task_id"),
  openedAt: text("opened_at").notNull(),
  resolvedAt: text("resolved_at"),
  link: text("link"),
  meta: jsonb("meta"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idxIncidentsProjectOpenedAt").on(t.projectId, t.openedAt),
  index("idxIncidentsProjectStatus").on(t.projectId, t.status),
  index("idxIncidentsGroupingKey").on(t.groupingKey),
  index("idxIncidentsStatus").on(t.status),
  index("idxIncidentsOpenedAt").on(t.openedAt),
  index("idxIncidentsResolvedAt").on(t.resolvedAt),
]);

// ── Migration-only tables (from MIGRATION_ONLY_TABLE_SCHEMAS) ────────
export const aiSessions = projectSchema.table("ai_sessions", {
  id: text("id").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  title: text("title").notNull(),
  inputPayload: jsonb("input_payload").notNull(),
  conversationHistory: jsonb("conversation_history").default([]),
  currentQuestion: text("current_question"),
  result: jsonb("result"),
  thinkingOutput: text("thinking_output").default(""),
  error: text("error"),
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  DEAD COLUMNS — no code reads or writes these. The per-tab session lock they backed was
  removed when AI interview sessions became multi-tab (the persisted row is the shared source
  of truth; any tab may read and interact). They are retained, nullable and always NULL, only
  because dropping them is an irreversible migration that would break any still-installed
  older binary, whose upsert names `locked_by_tab`/`locked_at` explicitly. Drop them (plus
  `idxAiSessionsLock`) in a later migration once no such binary can reach this database.
  */
  lockedByTab: text("locked_by_tab"),
  lockedAt: text("locked_at"),
  archived: integer("archived").default(0),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxAiSessionsStatus").on(t.status),
  index("idxAiSessionsType").on(t.type),
  index("idxAiSessionsUpdatedAt").on(t.updatedAt),
  index("idxAiSessionsLock").on(t.lockedByTab),
  index("idxAiSessionsArchived").on(t.archived),
  index("idxAiSessionsStatusUpdatedAt").on(t.status, t.updatedAt),
]);

export const messages = projectSchema.table("messages", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  fromId: text("from_id").notNull(),
  fromType: text("from_type").notNull(),
  toId: text("to_id").notNull(),
  toType: text("to_type").notNull(),
  content: text("content").notNull(),
  type: text("type").notNull(),
  read: integer("read").default(0),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxMessagesTo").on(t.toId, t.toType, t.read),
  index("idxMessagesFrom").on(t.fromId, t.fromType),
  index("idxMessagesCreatedAt").on(t.createdAt),
]);

export const agentRatings = projectSchema.table("agent_ratings", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  raterType: text("rater_type").notNull(),
  raterId: text("rater_id"),
  score: integer("score").notNull(),
  category: text("category"),
  comment: text("comment"),
  runId: text("run_id"),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  check("agent_ratings_score_check", sql`${t.score} BETWEEN 1 AND 5`),
  index("idxAgentRatingsAgentId").on(t.agentId),
  index("idxAgentRatingsCreatedAt").on(t.createdAt),
]);

export const chatSessions = projectSchema.table("chat_sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  title: text("title"),
  status: text("status").notNull().default("active"),
  projectId: text("project_id"),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  // FNXC:ChatThinkingLevel 2026-07-10: FN-7775 per-chat thinking-level override
  // persisted alongside the session's model selection.
  thinkingLevel: text("thinking_level"),
  // FNXC:Settings-ThinkingLevel 2026-07-13 (merge port): validator/planning reasoning-effort overrides.
  validatorThinkingLevel: text("validator_thinking_level"),
  planningThinkingLevel: text("planning_thinking_level"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // FNXC:ChatPinned 2026-07-16-12:00: nullable timestamp persists the active
  // Direct-session pin; the ChatStore enforces the per-scope max-three invariant.
  pinnedAt: text("pinned_at"),
  cliSessionFile: text("cli_session_file"),
  inFlightGeneration: jsonb("in_flight_generation"),
  cliExecutorAdapterId: text("cli_executor_adapter_id"),
}, (t) => [
  index("idxChatSessionsAgentId").on(t.agentId),
  index("idxChatSessionsProjectId").on(t.projectId),
]);

export const cliSessions = projectSchema.table("cli_sessions", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  chatSessionId: text("chat_session_id"),
  purpose: text("purpose").notNull(),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: reflect the DB default installed by migration 0006 so insert types treat the trigger/GUC-owned partition as optional; stores must not write it.
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  adapterId: text("adapter_id").notNull(),
  agentState: text("agent_state").notNull().default("starting"),
  terminationReason: text("termination_reason"),
  nativeSessionId: text("native_session_id"),
  resumeAttempts: integer("resume_attempts").notNull().default(0),
  autonomyPosture: text("autonomy_posture"),
  worktreePath: text("worktree_path"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_cli_sessions_taskId").on(t.taskId),
  index("idx_cli_sessions_chatSessionId").on(t.chatSessionId),
  index("idx_cli_sessions_project_state").on(t.projectId, t.agentState),
]);

export const chatMessages = projectSchema.table("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  thinkingOutput: text("thinking_output"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  attachments: jsonb("attachments"),
}, (t) => [
  index("idxChatMessagesSessionId").on(t.sessionId),
  index("idxChatMessagesCreatedAt").on(t.createdAt),
]);

/*
FNXC:PostgresCutover 2026-07-04-00:00:
Append-only chat token-accounting table backing ChatStore.recordTokenUsage + aggregateTokenAnalytics (Command Center token totals). Columns mirror ChatTokenUsageRecord (chat-types.ts); the session/room/message/project/agent/provider/model fields are nullable, token counts + sourceKind + createdAt are non-null. created_at is indexed because every Command Center date-range query filters on it.
*/
export const chatTokenUsage = projectSchema.table("chat_token_usage", {
  id: text("id").primaryKey(),
  sourceKind: text("source_kind").notNull(),
  chatSessionId: text("chat_session_id"),
  roomId: text("room_id"),
  messageId: text("message_id"),
  projectId: text("project_id"),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  agentId: text("agent_id"),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
  cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull(),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
  totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idxChatTokenUsageCreatedAt").on(t.createdAt),
]);

export const runAuditEvents = projectSchema.table("run_audit_events", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  taskId: text("task_id"),
  agentId: text("agent_id").notNull(),
  runId: text("run_id").notNull(),
  domain: text("domain").notNull(),
  mutationType: text("mutation_type").notNull(),
  target: text("target").notNull(),
  metadata: jsonb("metadata"),
}, (t) => [
  index("idxRunAuditEventsRunIdTimestamp").on(t.runId, t.timestamp),
  index("idxRunAuditEventsTaskIdTimestamp").on(t.taskId, t.timestamp),
  index("idxRunAuditEventsTimestamp").on(t.timestamp),
]);

export const missionContractAssertions = projectSchema.table("mission_contract_assertions", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  milestoneId: text("milestone_id").notNull(),
  title: text("title").notNull(),
  assertion: text("assertion").notNull(),
  status: text("status").notNull().default("pending"),
  type: text("type").notNull().default("static"),
  orderIndex: integer("order_index").notNull().default(0),
  sourceFeatureId: text("source_feature_id"),
  scope: text("scope").notNull().default("feature"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxContractAssertionsMilestoneOrder").on(t.milestoneId, t.orderIndex, t.createdAt, t.id),
]);

export const missionFeatureAssertions = projectSchema.table("mission_feature_assertions", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  featureId: text("feature_id").notNull(),
  assertionId: text("assertion_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.featureId, t.assertionId] }),
  index("idxFeatureAssertionsFeatureId").on(t.featureId),
  index("idxFeatureAssertionsAssertionId").on(t.assertionId),
]);

export const missionValidatorRuns = projectSchema.table("mission_validator_runs", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  featureId: text("feature_id").notNull(),
  milestoneId: text("milestone_id").notNull(),
  sliceId: text("slice_id").notNull(),
  status: text("status").notNull().default("running"),
  triggerType: text("trigger_type").notNull().default("auto"),
  implementationAttempt: integer("implementation_attempt").notNull().default(0),
  validatorAttempt: integer("validator_attempt").notNull().default(0),
  summary: text("summary"),
  blockedReason: text("blocked_reason"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  taskId: text("task_id"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxValidatorRunsFeatureId").on(t.featureId),
  index("idxValidatorRunsMilestoneId").on(t.milestoneId),
  index("idxValidatorRunsSliceId").on(t.sliceId),
  index("idxValidatorRunsStatus").on(t.status),
]);

export const missionValidatorFailures = projectSchema.table("mission_validator_failures", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  runId: text("run_id").notNull(),
  featureId: text("feature_id").notNull(),
  assertionId: text("assertion_id").notNull(),
  message: text("message"),
  expected: text("expected"),
  actual: text("actual"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxValidatorFailuresRunId").on(t.runId),
  index("idxValidatorFailuresFeatureId").on(t.featureId),
  index("idxValidatorFailuresAssertionId").on(t.assertionId),
]);

export const missionFixFeatureLineage = projectSchema.table("mission_fix_feature_lineage", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  sourceFeatureId: text("source_feature_id").notNull(),
  fixFeatureId: text("fix_feature_id").notNull(),
  runId: text("run_id").notNull(),
  failedAssertionIds: jsonb("failed_assertion_ids").notNull().default([]),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxFixLineageSourceFeatureId").on(t.sourceFeatureId),
  index("idxFixLineageFixFeatureId").on(t.fixFeatureId),
  index("idxFixLineageRunId").on(t.runId),
]);

export const verificationCache = projectSchema.table("verification_cache", {
  treeSha: text("tree_sha").notNull(),
  testCommand: text("test_command").notNull().default(""),
  buildCommand: text("build_command").notNull().default(""),
  recordedAt: text("recorded_at").notNull(),
  taskId: text("task_id"),
}, (t) => [
  primaryKey({ columns: [t.treeSha, t.testCommand, t.buildCommand] }),
  index("idxVerificationCacheRecordedAt").on(t.recordedAt),
]);

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Import auto-translation must survive modal close and page reload — the operator should never re-bill the AI helper for an issue already translated. Cache one translation per (project, provider, repo, issue, target locale).
`sourceHash` is the hash of the original title+body: an edited issue produces a new hash so the stale translation is never served. Rows are only ever written for OPEN issues, and are pruned once an issue is observed closed, which is the requirement's natural expiry ("persist until the issue is closed").
`projectId` is part of the PK because all projects share one flat `project` schema — omitting it (as the older `verification_cache` PK does) would leak one project's translations into another.
*/
export const importTranslationCache = projectSchema.table("import_translation_cache", {
  /*
  FNXC:GitHubImportTranslate 2026-07-16-23:30:
  An unbound compatibility store owns cache rows in the explicit legacy
  partition. Match fusion_assign_project_id so a defaulted insert and the
  application scope predicate cannot disagree after a process restart.
  */
  projectId: text("project_id").notNull().default(sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`),
  /** Import source: "github" | "gitlab". */
  provider: text("provider").notNull(),
  /** Canonical repo identity, e.g. "owner/repo" (GitLab: project path). */
  repoKey: text("repo_key").notNull(),
  /** Issue/PR/MR number within the repo. */
  issueNumber: integer("issue_number").notNull(),
  /** BCP-47 target locale the cached fields were translated into. */
  targetLocale: text("target_locale").notNull(),
  /** Hash of the ORIGINAL title+body; a mismatch means the issue was edited. */
  sourceHash: text("source_hash").notNull(),
  translatedTitle: text("translated_title").notNull(),
  translatedBody: text("translated_body").notNull(),
  /** Detected source language, or null when detection was inconclusive. */
  detectedLocale: text("detected_locale"),
  recordedAt: text("recorded_at").notNull(),
}, (t) => [
  primaryKey({
    columns: [t.projectId, t.provider, t.repoKey, t.issueNumber, t.targetLocale],
  }),
  index("idxImportTranslationCacheRecordedAt").on(t.recordedAt),
]);

export const approvalRequests = projectSchema.table("approval_requests", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  requesterActorId: text("requester_actor_id").notNull(),
  requesterActorType: text("requester_actor_type").notNull(),
  requesterActorName: text("requester_actor_name").notNull(),
  targetActionCategory: text("target_action_category").notNull(),
  targetActionOperation: text("target_action_operation").notNull(),
  targetActionSummary: text("target_action_summary").notNull(),
  targetResourceType: text("target_resource_type").notNull(),
  targetResourceId: text("target_resource_id").notNull(),
  targetContext: jsonb("target_context"),
  taskId: text("task_id"),
  runId: text("run_id"),
  requestedAt: text("requested_at").notNull(),
  decidedAt: text("decided_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idxApprovalRequestsStatusCreatedAt").on(t.status, t.createdAt),
  index("idxApprovalRequestsRequesterCreatedAt").on(t.requesterActorId, t.createdAt),
  index("idxApprovalRequestsTaskCreatedAt").on(t.taskId, t.createdAt),
]);

export const approvalRequestAuditEvents = projectSchema.table("approval_request_audit_events", {
  projectId: text("project_id").notNull().default(""),
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  eventType: text("event_type").notNull(),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").notNull(),
  actorName: text("actor_name").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idxApprovalRequestAuditRequestCreatedAt").on(t.requestId, t.createdAt, t.id),
  index("idxApprovalRequestAuditProjectCreatedAt").on(t.projectId, t.createdAt),
]);

export const chatRooms = projectSchema.table("chat_rooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  projectId: text("project_id"),
  // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain "project" field, split from the trigger/GUC-owned project_id RLS partition (migration 0011).
  ownerProjectId: text("owner_project_id"),
  createdBy: text("created_by"),
  status: text("status").notNull().default("active"),
  // FNXC:Chat-ThinkingLevel 2026-07-13 (merge port): room-level reasoning-effort default.
  thinkingLevel: text("thinking_level"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idxChatRoomsSlug").on(t.projectId, t.slug),
  index("idxChatRoomsProjectId").on(t.projectId),
  index("idxChatRoomsStatus").on(t.status),
]);

export const chatRoomMembers = projectSchema.table("chat_room_members", {
  roomId: text("room_id").notNull(),
  agentId: text("agent_id").notNull(),
  role: text("role").notNull().default("member"),
  addedAt: text("added_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.roomId, t.agentId] }),
  index("idxChatRoomMembersAgentId").on(t.agentId),
]);

export const chatRoomMessages = projectSchema.table("chat_room_messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  thinkingOutput: text("thinking_output"),
  metadata: jsonb("metadata"),
  attachments: jsonb("attachments"),
  senderAgentId: text("sender_agent_id"),
  mentions: jsonb("mentions"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idxChatRoomMessagesRoomCreatedAt").on(t.roomId, t.createdAt),
  index("idxChatRoomMessagesRoomId").on(t.roomId),
]);

/**
 * FNXC:PostgresSchema 2026-06-24-02:30:
 * Registry of all project-schema table names. Used by the migration applier
 * and the schema-init hook to enumerate expected tables. Kept explicit so
 * adding a table requires updating both the definition and the registry
 * entry (drift signal).
 */
export const projectTableNames = [
  "tasks", "config", "boards", "project_auth_users", "project_auth_memberships",
  "project_auth_providers", "project_auth_sessions", "task_reviewer_runs",
  "distributed_task_id_state", "distributed_task_id_reservations",
  "workflow_steps", "workflows", "task_workflow_selection", "activity_log",
  "archived_tasks", "task_commit_associations", "automations", "agents",
  "agent_heartbeats", "agent_runs", "agent_task_sessions", "agent_api_keys",
  "agent_config_revisions", "agent_blocked_states", "merge_queue", "merge_requests",
  "completion_handoff_markers", "workflow_work_items", "workflow_run_branches",
  "workflow_run_step_instances", "workflow_settings", "workflow_prompt_overrides",
  "task_documents", "artifacts", "task_document_revisions", "research_runs",
  "research_exports", "research_run_events", "experiment_sessions",
  "experiment_session_records", "eval_runs", "eval_task_results", "eval_run_events",
  "secrets", "__meta", "missions", "branch_groups", "pull_requests",
  "pull_request_thread_state", "goals", "mission_goals", "goal_citations",
  "milestones", "slices", "mission_features", "ideation_sessions", "ideation_candidates", "mission_events", "plugins",
  "routines", "project_insights", "project_insight_runs", "project_insight_run_events",
  "todo_lists", "todo_items", "usage_events", "plugin_activations",
  "knowledge_pages", "deployments", "incidents", "ai_sessions", "messages",
  "agent_ratings", "chat_sessions", "cli_sessions", "chat_messages",
  "run_audit_events", "mission_contract_assertions", "mission_feature_assertions",
  "mission_validator_runs", "mission_validator_failures",
  "mission_fix_feature_lineage", "verification_cache", "import_translation_cache",
  "approval_requests",
  "approval_request_audit_events", "chat_rooms", "chat_room_members",
  "chat_room_messages", "chat_token_usage",
] as const;
