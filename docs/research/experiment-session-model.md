# Experiment Session Domain Model

## Motivation

`pi-autoresearch` parity requires a persistent session model for iterative experiment loops (configure → run → evaluate keep/discard → finalize). Existing `research_runs` is query/synthesis-oriented and cannot represent session segments, metric direction, or append-only experiment records.

## Entity Model

```text
experiment_sessions (1) ──< (many) experiment_session_records

Session
  ├─ metric definition (name/unit/direction)
  ├─ currentSegment
  ├─ baselineRunId / bestRunId
  └─ keptRunIds[]

Record (append-only by seq per session)
  ├─ config (segment headers)
  ├─ run (metric outcomes + keep/discard/checks_failed/etc.)
  ├─ hook (before/after hook execution)
  └─ finalize (kept/discarded summary + branch metadata)
```

## SQLite Schema

### `experiment_sessions`
- `id` TEXT PK
- `name` TEXT NOT NULL
- `projectId` TEXT
- `status` TEXT NOT NULL (`active|finalizing|finalized|archived`)
- `metric` TEXT NOT NULL (JSON)
- `currentSegment` INTEGER NOT NULL DEFAULT `1`
- `maxIterations` INTEGER
- `workingDir` TEXT
- `baselineRunId` TEXT
- `bestRunId` TEXT
- `keptRunIds` TEXT NOT NULL DEFAULT `'[]'`
- `tags` TEXT NOT NULL DEFAULT `'[]'`
- `metadata` TEXT
- `createdAt` TEXT NOT NULL
- `updatedAt` TEXT NOT NULL
- `finalizedAt` TEXT

Indexes: status, projectId, createdAt.

### `experiment_session_records`
- `id` TEXT PK
- `sessionId` TEXT NOT NULL FK → `experiment_sessions(id)` ON DELETE CASCADE
- `segment` INTEGER NOT NULL
- `seq` INTEGER NOT NULL
- `type` TEXT NOT NULL (`config|run|hook|finalize`)
- `payload` TEXT NOT NULL (JSON)
- `createdAt` TEXT NOT NULL

Constraints/indexes:
- `UNIQUE(sessionId, seq)`
- `(sessionId, segment, seq)` index
- `(sessionId, type)` index

## Status State Machine

`active` → `finalizing` → `finalized` → `archived`

Rules:
- Records are append-only.
- `seq` is allocated monotonically per session inside a transaction.
- Appending is rejected for `finalized` and `archived` sessions.
- Transitioning to `finalized` sets `finalizedAt` if unset.

## Upstream Mapping

| Upstream concept (`pi-autoresearch`) | Fusion model |
|---|---|
| `ExperimentState` | `ExperimentSession` |
| Metric (`name/unit/direction`) | `ExperimentMetricDefinition` + `experiment_sessions.metric` |
| Segment reset via config row | `startNewSegment()` + `config` record |
| Iteration result | `run` record payload |
| Hook log entry | `hook` record payload |
| Keep/discard ledger | `run.status` + session `keptRunIds[]` |
| Baseline/current best pointers | `baselineRunId`, `bestRunId` |
| Finalization summary | `finalize` record payload + session status/finalizedAt |

## Store API Notes

- `recordKept(sessionId, runRecordId)` is idempotent and only appends missing run IDs.
- `updateRecordPayload(recordId, patch)` applies additive payload patches for existing records (used by executor to backfill run commit SHA after keep commits).

## Follow-ups

- **FN-4219**: executor/orchestrator loop (`init/run/log`) and runtime integration.
- **FN-4221**: unify dashboard/CLI/extension/engine surfaces with one execution contract.
- **FN-4222**: finalize workflow and branch-splitting parity.
