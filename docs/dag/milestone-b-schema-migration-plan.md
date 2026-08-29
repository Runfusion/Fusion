# Milestone B Schema Migration Plan (Prototype Scaffold)

Related tasks: **FN-4491**, **FN-4490**, **FN-4487**, **FN-4471**, governance gate **FN-4359**.

See also: [DagCoordinator design](./milestone-b-dag-coordinator-design.md) · [Implementation checklist](./milestone-b-implementation-checklist.md) · [ADR v1](./adr-0001-dag-orchestration.md)

## Goals and non-goals

ADR traceability: this plan derives from ADR-0001 **Decision** (first-class SQLite DAG model), **Consequences #1** (additive storage), and **Consequences #3** (project-local scope).

### Goals
- Additive-only SQLite schema plan for per-project `.fusion/fusion.db` DAG persistence.
- Preserve WAL mode and current migration runner contract in `packages/core/src/db.ts`.
- Keep startup safe: no destructive backfills, no blocking startup jobs.
- Ensure restart recovery can reconstruct DAG state from SQLite alone, aligned with `RestartRecoveryCoordinator` expectations from FN-4490 deliverables.

### Non-goals
- No schema file or runtime implementation in this task.
- No column renames/drops/destructive migrations.
- No changes to `~/.fusion/fusion-central.db` central registry schema.

## Current state

- Project DB migration runner lives in `packages/core/src/db.ts`:
  - `Database.init()` calls `migrate()`.
  - Incremental migrations are version-gated `if (version < N)` blocks.
  - Current top migration in-tree is `version < 77` (`SCHEMA_VERSION`-driven sequence).
  - Version bump is written through `applyMigration(targetVersion, fn)` updating `__meta.schemaVersion`.
- Existing DB settings preserve WAL + busy timeout in constructor (`PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = ...`) in `packages/core/src/db.ts`.
- Central registry DB is distinct (`~/.fusion/fusion-central.db`) per `docs/multi-project.md`; DAG prototype schema changes are project DB only.

## Proposed additive tables

Naming/type conventions follow existing project DB patterns (`snake_case`, `TEXT` IDs, `INTEGER` flags/counts, ISO timestamps as `TEXT`).

### 1) `dag_run`

Suggested columns:
- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL` (project scope identifier; per-project DB still records scope for auditability)
- `status TEXT NOT NULL` (`pending|running|completed|aborted|cancelled|failed`)
- `started_at TEXT`
- `completed_at TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `metadata TEXT` (JSON payload for run-level config/trace context)

Indexes:
- `CREATE INDEX ... ON dag_run(status)`
- `CREATE INDEX ... ON dag_run(project_id, status)`
- `CREATE INDEX ... ON dag_run(created_at)`

Rationale:
- `started_at`/`completed_at` nullable to support queued runs.
- `project_id` kept explicit for consistency with audit/event payloads and future cross-node read tooling, while still local to one project DB instance.

### 2) `dag_node`

Suggested columns:
- `id TEXT PRIMARY KEY`
- `dag_run_id TEXT NOT NULL`
- `task_id TEXT` (nullable until mapped/enqueued task exists)
- `status TEXT NOT NULL` (`pending|ready|enqueued|running|completed|failed|blocked|skipped|cancelled`)
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `last_error TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Constraints/indexes:
- `FOREIGN KEY (dag_run_id) REFERENCES dag_run(id) ON DELETE CASCADE`
- `CREATE INDEX ... ON dag_node(dag_run_id, status)`
- `CREATE INDEX ... ON dag_node(task_id)`

Rationale:
- `task_id` nullable to represent not-yet-materialized nodes under enqueue-only adapter.
- `attempt_count` persisted for retry accounting aligned to FN-4490/FN-4398 retry taxonomy.

### 3) `dag_edge`

Suggested columns:
- `id TEXT PRIMARY KEY`
- `dag_run_id TEXT NOT NULL`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `edge_kind TEXT NOT NULL DEFAULT 'depends_on'`
- `created_at TEXT NOT NULL`

Constraints/indexes:
- `FOREIGN KEY (dag_run_id) REFERENCES dag_run(id) ON DELETE CASCADE`
- `FOREIGN KEY (from_node_id) REFERENCES dag_node(id) ON DELETE CASCADE`
- `FOREIGN KEY (to_node_id) REFERENCES dag_node(id) ON DELETE CASCADE`
- `UNIQUE(dag_run_id, from_node_id, to_node_id, edge_kind)`
- `CREATE INDEX ... ON dag_edge(dag_run_id, to_node_id)`
- `CREATE INDEX ... ON dag_edge(dag_run_id, from_node_id)`

Rationale:
- explicit run-scoped edge rows support deterministic readiness checks and restart rehydration.

## Migration mechanics

- Add one new migration block at next version slot **78** in `packages/core/src/db.ts` (`if (version < 78) { applyMigration(78, ...) }`).
- Migration should create new tables/indexes via `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` to stay idempotent.
- Downgrade policy: forward-only migrations (consistent with current runner). Explicitly no down migration.
- Multi-project interaction:
  - `~/.fusion/fusion-central.db`: unchanged.
  - Every project’s local `.fusion/fusion.db`: independently receives the additive tables when opened.

## Restart recovery contract

ADR traceability: aligns with ADR-0001 **Decision** (SQLite-backed DAG state) and **Consequences #2** (single-event-loop/non-blocking runtime constraints).

For engine boot recovery:
- Source of truth is SQLite rows in `dag_run` + `dag_node` + `dag_edge`.
- Recovery should identify non-terminal runs (`pending|running`) and resume readiness evaluation from persisted statuses.
- Required status invariants:
  - `dag_run.status` and `dag_node.status` transitions are monotonic toward terminal states.
  - crashes between transitions are safe because old state remains valid input for retry/re-evaluation.
  - `task_id` linkage, once set, remains stable for node lifetime.

## Rollback story

Because this milestone is scaffold-only and adapter is enqueue-only:
- if issues arise, runtime can ignore new DAG tables.
- scheduler/executor/merger behavior remains unchanged when DAG feature flag is off.
- no existing table semantics are modified.

## Open questions

1. Should `dag_run.project_id` store canonical project ID or normalized path-derived identity used by central registry APIs?
2. Do we need a dedicated `terminal_reason` column on `dag_node` vs. deriving from `last_error` + status?
3. Should `dag_node.task_id` be unique within a run (`UNIQUE(dag_run_id, task_id)` with NULL-safe behavior) to prevent accidental dual binding?
4. How should cancellation provenance (operator/system/governance) be normalized for restart-safe replay?
