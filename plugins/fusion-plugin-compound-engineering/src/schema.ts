import type { Database } from "@fusion/core";

/**
 * Idempotent DDL for the Compound Engineering plugin-local tables (U5).
 *
 * Wired via `hooks.onSchemaInit` and materialized in the same PostgreSQL schema
 * that route handlers access through `ctx.taskStore.getAsyncLayer()`; the
 * loader `emitEvent` is a logging stub — see the U5 storage/event seam note).
 *
 * `ce_sessions` is the no-silent-loss core: every interactive stage session is
 * persisted here so an interrupt/error never destroys progress (lesson:
 * docs/incidents/2026-05-23-lost-work-tasks.md). The `currentQuestion` and
 * `conversationHistory` columns are JSON; resume reconstructs the awaiting
 * question and full history from them.
 *
 * `lastActivityAt` is an interval-relative liveness field (epoch millis of the
 * last produced event). Staleness is judged relative to the session's
 * configured turn interval, NOT by raw last-event age, so a healthy-but-slow
 * agent turn is not misclassified stale (docs/fn-4172-heartbeat-investigation.md).
 *
 * `ce_pipeline_links` (U7) is the addressable back-reference table: it links a
 * board task to the CE pipeline/stage/artifact that produced it. Per FN-5719 the
 * back-reference lives in this plugin-local table (NOT in task-row JSON) so
 * board-task ownership and CE-pipeline ownership stay separate state machines.
 * U7 keeps it minimal (link records only); U8 extends it with the bidirectional
 * pipeline-state machine.
 *
 * `ce_pipeline_state` (U8) is the CE-pipeline's OWN state machine — DISTINCT from
 * board-task column state (KTD4 / FN-5719: two separate ownership state machines,
 * never one shared column encoding two concerns). It tracks where the pipeline
 * itself is: `currentStage` (the CE stage the pipeline has reached) and `status`
 * (`running` | `advancing` | `awaiting_board` | `completed`). The board owns task
 * columns; this table owns pipeline progress. They are reconciled — never merged.
 *
 * `ce_pipeline_sync_queue` (U8) is the event-enqueue seam (FN-5719). Lifecycle
 * hooks write a row here FAST (5s hook budget) and return; the reconciler drains
 * it. A dropped/never-enqueued event is still recovered because the reconciler
 * ALSO re-derives transitions from board state — the queue is an optimization,
 * board+state comparison is the convergence guarantee. `processedAt NULL` =
 * pending; non-null = drained (kept for audit, swept idempotently).
 */
export function ensureCeSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ce_sessions (
      id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'launching','active','awaiting_input','completed','error','interrupted'
      )),
      currentQuestion TEXT,
      conversationHistory TEXT NOT NULL DEFAULT '[]',
      projectId TEXT,
      artifactPath TEXT,
      error TEXT,
      turnIntervalMs INTEGER NOT NULL DEFAULT 120000,
      lastActivityAt INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idxCeSessionsStatusUpdated
      ON ce_sessions(status, updatedAt DESC, id);

    CREATE INDEX IF NOT EXISTS idxCeSessionsStageCreated
      ON ce_sessions(stage, createdAt DESC, id);

    CREATE INDEX IF NOT EXISTS idxCeSessionsProject
      ON ce_sessions(projectId, updatedAt DESC, id);

    CREATE TABLE IF NOT EXISTS ce_plan_handoff_claims (
      artifactPath TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL UNIQUE,
      projectId TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idxCePlanHandoffClaimsSession
      ON ce_plan_handoff_claims(sessionId);

    CREATE TABLE IF NOT EXISTS ce_pipeline_links (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      cePipelineId TEXT NOT NULL,
      ceStageId TEXT NOT NULL,
      ceArtifactPath TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idxCePipelineLinksPipeline
      ON ce_pipeline_links(cePipelineId, createdAt DESC, id);

    CREATE UNIQUE INDEX IF NOT EXISTS idxCePipelineLinksTask
      ON ce_pipeline_links(taskId);

    CREATE TABLE IF NOT EXISTS ce_pipeline_state (
      cePipelineId TEXT PRIMARY KEY,
      currentStage TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'running','advancing','awaiting_board','completed'
      )),
      lastArtifactPath TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idxCePipelineStateStatus
      ON ce_pipeline_state(status, updatedAt DESC, cePipelineId);

    CREATE TABLE IF NOT EXISTS ce_pipeline_sync_queue (
      id TEXT PRIMARY KEY,
      cePipelineId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      reason TEXT NOT NULL,
      fromColumn TEXT,
      toColumn TEXT,
      enqueuedAt TEXT NOT NULL,
      processedAt TEXT
    );

    CREATE INDEX IF NOT EXISTS idxCePipelineSyncQueuePending
      ON ce_pipeline_sync_queue(processedAt, enqueuedAt, id);

    CREATE INDEX IF NOT EXISTS idxCePipelineSyncQueuePipeline
      ON ce_pipeline_sync_queue(cePipelineId, enqueuedAt, id);
  `);
}
