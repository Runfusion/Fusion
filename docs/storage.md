# Fusion Dashboard Storage Audit (FN-1202)

> Current authority: Fusion runtime metadata lives in PostgreSQL. `.fusion/project.json` is the local identity marker; `fusion.db`, `archive.db`, SQLite inventories, FTS5 notes, and worktree-DB hydration sections below are retained only as pre-cutover migration/history records and do not describe a supported runtime fallback.

See the [2026-07-14 PostgreSQL runtime cutover review](./postgres-migration-review-2026-07-14.md) for the audited authority inventory, exact authorized legacy readers, and deployment/rollback checklist.

## Embedded PostgreSQL startup resources

- The zero-config embedded PostgreSQL lifecycle uses mmap-backed primary shared memory to avoid exhausted SysV shared-memory IDs on constrained hosts.
- The supported, tested constrained-host floor is **64MB `/dev/shm`**. Both `fn serve` and boot smoke inherit this lifecycle default; an explicit later PostgreSQL `-c shared_memory_type=…` flag remains an operator override.

## Task-ID allocator authority and compatibility

- `distributed_task_id_state` is the authoritative local task-ID allocator state. `nextSequence` is the active high-water mark used for local ID reservations.
- `distributed_task_id_reservations` tracks reserve/commit/abort lifecycle entries. Aborted/expired reservations are burned and never reissued. Create-class writes commit the reservation in the same PostgreSQL transaction as the `tasks` row insert, then roll back the row/partial directory and move the reservation to aborted if post-insert `task.json`/`PROMPT.md` materialization or create validation fails.
- `config.nextId` is retained only as a deprecated legacy compatibility field and optional one-time seed source. Fusion still reads it during reconciliation, but runtime task creation and settings writes no longer mutate it.
- Startup/store-open allocator reconciliation bumps each active prefix sequence to `max(current nextSequence, max(tasks suffix)+1, max(archivedTasks suffix)+1, max(reservation sequence)+1)` so stale allocator rows self-heal before local task creation resumes.
- Create-class task persistence is intentionally non-destructive: new tasks use plain `INSERT` semantics, while upserts remain update-only. If counters drift and a reserved ID still collides, the create fails and the existing PostgreSQL row / task directory stays intact. A `committed` distributed reservation is valid only with a matching durable task row/directory; failed creates burn the reservation as `aborted` instead of leaving a committed-reservation-without-task phantom.

## Soft-deleted tasks (FN-5105)

- User-initiated `TaskStore.deleteTask` is a **soft delete**: the task row stays in `tasks` and `deletedAt` is set.
- Active task readers (`getTask`, `listTasks`, search, dependency scans, scheduler/watcher reads, mission task aggregations) must filter with `deletedAt IS NULL`.
- Archived-task flows (`archiveTask`, archived cleanup/migration) hard-delete from the active `tasks` table after copying to PostgreSQL cold storage. Legacy `archive.db` files are import-only.
- ID reservation is unchanged: soft-deleted IDs remain reserved. `distributed-task-id` and `task-id-integrity` intentionally scan all task rows (including soft-deleted rows), and must not filter on `deletedAt`.

### Orphaned task-dir reconciliation (FN-6783)

- PostgreSQL-backed `TaskStore` instances reconcile `.fusion/tasks/{ID}/task.json` compatibility artifacts against the PostgreSQL `project.tasks` table on store open and during `SelfHealingManager` Batch 1 maintenance (`reconcile-orphaned-task-dirs`). This closes the visibility gap where a heartbeat-created task could exist on disk but be absent from `getTask`/`listTasks` and the dashboard board.
- The reconcile is non-destructive: when an ID already exists anywhere the create path would reserve it (active task row, soft-deleted row, archived table/archive DB, or tombstone), the scan skips the directory and never overwrites or resurrects that ID. Only a valid live `task.json` with no DB record anywhere is re-imported.
- Recovered rows preserve the on-disk task metadata, including `column`, `status`, dependencies, steps, and log, after the same defensive disk normalization used by task JSON fallback reads. Malformed or unparseable `task.json` files are skipped with a warning instead of failing store open or maintenance.
- Recovery is visible: each inserted orphan emits a store warning, a `task:reconcile-orphaned-task-dir` run-audit event, and a `task:created` lifecycle event so live boards can render the recovered card.
- On-disk retention matters for scan safety. `deleteTask()` leaves `.fusion/tasks/{ID}/task.json` and `agent-log.jsonl` on disk for forensics while marking the row `deletedAt`; the reconcile must skip those soft-deleted IDs. `archiveTask(id)` with the default cleanup removes the task directory, but `archiveTask(id, false)` and legacy archives can leave a `task.json` behind, so archived IDs are also guarded and skipped.

### Agent log storage + soft-delete visibility (FN-5143 / FN-5911)

- Agent logs are stored outside PostgreSQL. Each task appends newline-delimited JSON records to `<rootDir>/.fusion/tasks/{ID}/agent-log.jsonl`.
- Tool arguments and successful `tool_result` detail remain opt-in through `persistAgentToolOutput`; failed `tool_error` detail always persists as bounded diagnostic signal so task Activity transcripts can reveal the underlying failure.
- Agent-log JSONL rows may include optional numeric timing metadata: `timeToFirstTokenMs` on the first visible model-output row for a request, and `durationMs` on tool/request completion rows such as `tool_result` or `tool_error`. These fields are additive, non-sensitive millisecond values; legacy rows may omit them and readers must continue to treat omission as normal.
- `TaskStore.deleteTask` keeps that JSONL file on disk for forensics, but all live read APIs (`getAgentLogs*`, `getAgentLogCount`) gate on task liveness and return zero entries once `deletedAt` is set.
- Archived-task snapshot behavior (`taskToArchiveEntry` / `archiveTask`) embeds a capped agent-log snapshot sourced from JSONL.
- Retention is independent from PostgreSQL operational-log pruning. `settings.agentLogFileRetentionDays` controls age-based pruning of JSONL entries for soft-deleted and archived tasks only. Default: `0` (disabled).
- PostgreSQL operational-log pruning is controlled separately by `settings.operationalLogRetentionDays`. It prunes `activityLog`, `runAuditEvents`, `agentHeartbeats`, terminal `agentRuns` rows by `endedAt`, and `agentConfigRevisions` by `createdAt`.
- Safety invariants for operational pruning: in-flight `agentRuns` (`endedAt IS NULL`) are never deleted, and the most-recent `agentConfigRevisions` row per agent is always preserved even when older than the retention window.

### Archived-column pagination (FN-7659)

- The Archived board column no longer loads the full archive into memory. `ArchiveDatabase.listPage(limit, offset)` reads a bounded page ordered `archivedAt DESC, rowid DESC` via SQL `LIMIT/OFFSET`, backed by the existing `idxArchivedTasksArchivedAt` index.
- `TaskStore.listArchivedTasks({ limit, offset, slim })` is a dedicated, archive-only read path (default page size 100) that maps paged entries through `archiveEntryToTask` and returns `{ tasks, total, hasMore }` in `archivedAt DESC` order. It intentionally does **not** run the `createdAt ASC` sort used by the merged `listTasks({ includeArchived: true })` path — that merged path (and its non-board consumers: github-tracking reconciler, signal routes, agent-token-usage, self-healing) is unchanged.
- `GET /tasks/archived?limit=&offset=` exposes the paged read with `projectId` scoping and `limit`/`offset` validation, returning the same `{ tasks, total, hasMore }` shape.
- The dashboard's `useTasks` hook loads page 1 on first Archived-column expand and fetches subsequent pages only via an explicit "Show more" click (`loadMoreArchivedTasks`); it never re-fetches the whole archive on SSE reconnect, tab-visibility recovery, or repeated expand calls. Fetched pages merge into the board `tasks` array de-duplicated by id, with active PostgreSQL rows authoritative over archive snapshots.

### Activity-log no-op `task:moved` cleanup (FN-5940)

- `TaskStore` now defends the invariant that `activityLog` never records a `task:moved` row when `metadata.from === metadata.to`.
- Defense is layered: the `task:moved` listener skips same-column transitions, and source emitters skip no-op `archived -> archived` / same-column polling re-emits before subscribers see them.
- Existing junk rows are removed by a one-time init migration guarded by `__meta.noOpTaskMovedActivityCleanupVersion = "1"`.
- The cleanup deletes only rows matching `type = 'task:moved'` where `json_extract(metadata, '$.from') = json_extract(metadata, '$.to')`; legitimate distinct-column moves are preserved.
- Historical migration note: the pre-cutover SQLite cleanup did **not** run `VACUUM` automatically. `fn db --vacuum` applies only while inspecting a retained legacy database and is not part of PostgreSQL operation.

### Dashboard delete-event handling (FN-5135)

- Dashboard clients treat any SSE payload with `deletedAt != null` (`task:created`, `task:updated`, `task:moved`, `task:merged`) as a delete-equivalent and remove/suppress that task locally.
- SSE slim serialization (`stripTaskListHeavyFields`) must preserve `deletedAt`; dropping it can resurrect soft-deleted cards on live boards.
- Client-side SWR cache hydration also filters `deletedAt` rows before normalization as defense-in-depth; REST slim `listTasks` remains server-filtered with `deletedAt IS NULL`.

### Lineage children (FN-5129)

- `deleteTask` and `archiveTask` now enforce lineage integrity for `sourceParentTaskId` links.
- Default behavior: if a task still has **live lineage children** (`deletedAt IS NULL` and `column != 'archived'`) that reference it as parent, deletion/archive throws `TaskHasLineageChildrenError`.
- Opt-in unlink behavior: pass `removeLineageReferences: true` to `deleteTask` or `archiveTask` to clear live children (`sourceParentTaskId = NULL`, `updatedAt` bumped, `task:updated` emitted) before removing the parent.
- Gate boundary: soft-deleted children and archived-column children do **not** block parent removal; only live non-archived children block.
- `cleanupArchivedTasks` intentionally tolerates dangling lineage pointers in historical/archive cleanup flows; it does not run lineage rewrites.
- For forensic reads, soft-deleted parents remain accessible through `readTaskFromDb(id, { includeDeleted: true })`.
- Agent-facing tool layer (FN-7661): the `fn_task_archive` and `fn_task_delete` pi/CLI tools (`packages/cli/src/extension.ts`) both accept an optional `removeLineageReferences` boolean and forward it to `store.archiveTask` / `store.deleteTask`, so an agent that hits `TaskHasLineageChildrenError` can retry with `{ removeLineageReferences: true }` to clear the block — matching the recovery path the error message already advertises.

### Documents under soft-deleted tasks (FN-5140)

- Soft-deleting a task preserves its `task_documents` and `task_document_revisions` rows; document storage is not hard-deleted as part of `TaskStore.deleteTask`.
- Normal live-reader APIs must hide those rows by enforcing the parent-task active filter through `ACTIVE_TASKS_WHERE`: `getAllDocuments`, `getTaskDocuments`, `getTaskDocument`, and `getTaskDocumentRevisions` all treat a soft-deleted parent as out of scope for ordinary reads.
- The HTTP surface inherits the same contract: `GET /api/documents` excludes documents whose parent task is soft-deleted, while per-task document GET routes behave like "task not found" (`[]` for list/revisions and `404 Document not found` for the single-document read).
- No public forensic flag is exposed on document read methods or routes. Forensic access remains an internal/operator concern via `readTaskFromDb(id, { includeDeleted: true })` plus direct SQL against the preserved document tables.
- Write semantics stay intentionally asymmetric: `upsertTaskDocument` still refuses soft-deleted parents, while `deleteTaskDocument` remains allowed so forensic cleanup can scrub preserved document rows when needed.

### Artifact registry (FN-6777)

- `artifacts` is the first-class PostgreSQL metadata registry for generated or uploaded task artifacts. Rows store ID, `type` (`document`, `image`, `video`, `audio`, or `other`), title/description, MIME type, size, author identity/type, optional task linkage, metadata JSON, textual `content`, a relative `uri`, and timestamps; binary bytes stay on disk.
- `TaskStore.registerArtifact()` writes task-scoped binary payloads under `<rootDir>/.fusion/tasks/{ID}/artifacts/` and task-less registry payloads under `<rootDir>/.fusion/artifacts/`, then records a relative `artifacts/<file>` URI in PostgreSQL. If the DB insert fails after a binary write, the store removes the orphaned file before surfacing the error.
- Image task attachments (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) and video task attachments (`video/mp4`, `video/webm`, `video/quicktime`; 100MB cap vs 5MB for other attachments) are bridged into the artifact registry by `TaskStore.addAttachment()` as `image`/`video` rows with `metadata.source: "attachment"` and a relative `attachments/<file>` URI. This keeps one copy of the bytes under `<rootDir>/.fusion/tasks/{ID}/attachments/` while making the image discoverable through artifact list APIs and the Documents/Task Artifacts galleries. Non-image attachments remain attachment-only. Deleting an attachment also deletes its bridged artifact row before removing the attachment file so `/api/artifacts/:id/media` does not point at a deleted attachment.
- Inline text/document artifacts may store `content` directly in PostgreSQL and therefore have no media file. The dashboard media route streams `GET /api/artifacts/:id/media` from disk when `uri` is present, accepting task-scoped artifact URIs under `artifacts/` and bridged image-attachment URIs under `attachments/`, or returns inline `content` with the persisted MIME type when no `uri` exists.
- `getArtifact(id)` returns metadata by ID, `getArtifacts(taskId)` returns active-task artifacts newest-first, and `listArtifacts(...)` is the cross-agent query path with type/author/task/search filters and pagination. List reads hide artifacts whose parent task is soft-deleted while preserving task-less artifacts.
- `updateArtifact(id, { title?, description?, content? })` powers the dashboard Artifacts view's in-place doc editing (`GET`/`PATCH /api/artifacts/:id`). Content edits are only allowed on inline-content rows (no `uri`); binary-backed rows accept metadata edits only, archived-task artifacts stay read-only, and successful updates emit `artifact:updated` for live gallery refresh.
- `fn_artifact_register` accepts a local file `path` (in addition to inline `content`/`dataBase64`): the tool reads the file (50 MB cap), infers the MIME type from the extension when omitted, signature-validates image payloads (PNG/JPEG/GIF/WebP magic bytes, SVG text sniff), video payloads (mp4/mov `ftyp` box, WebM EBML header), and PDF payloads (`%PDF-` prefix), and persists the bytes through `registerArtifact()`'s managed storage path so the registry row keeps a servable URI after worktrees are cleaned up. Executor-lane registrations resolve relative paths against the task worktree and default `taskId` to the executing task. Every `path` is containment-checked before stat/read: the realpath-canonicalized file (symlinks and `../` segments resolved) must remain inside the session's `baseDir` or the OS temp directory; relative paths require a configured `baseDir`, and lanes without one (dashboard chat, no-task heartbeats) accept only absolute paths under the OS temp directory. HTML mockups register as `type="document"` + `mimeType="text/html"` (via `content` or `path`) and render as live sandboxed previews in the Artifacts view.
- `GET /api/artifacts/:id/media` serves HTTP byte ranges (`Accept-Ranges: bytes`, 206 + `Content-Range` for single ranges, 416 for unsatisfiable ranges) so `<video>`/`<audio>` seeking works and Safari plays media at all.
- Task-linked artifact registration requires an active, non-archived task. Archived tasks are read-only for artifact writes; soft-deleted or missing tasks are rejected.
- Retention follows the existing task lifecycle rather than a separate artifact policy: soft-deleted parent tasks keep artifact rows/files for forensics but normal live-reader APIs hide them; hard deletion from the active `tasks` table cascades artifact metadata through the `taskId` foreign key, and archive cleanup removes the task directory that contains task-scoped artifact binaries. Task-less artifacts live under `<rootDir>/.fusion/artifacts/` and are not tied to task archival cleanup.
- Worktree DB hydration copies task-scoped artifact metadata for the current task/dependency graph alongside task rows and `task_documents`. It intentionally does not copy binary payload files, and it intentionally excludes task-less registry artifacts because dependency hydration is scoped to the active task graph.
- **Cross-instance live refresh (FN-7544).** A project can have more than one `TaskStore` instance open against the same DB at once (e.g. the dashboard's cached `getOrCreateProjectStore` instance vs. the engine's own internally-constructed store, or two dashboard processes). `registerArtifact()` calls `bumpLastModified()` and `checkForChanges()`'s 1s polling loop diffs the `artifacts` table by a strictly-increasing `rowid` cursor (not a timestamp, to avoid millisecond ties), re-emitting `artifact:registered` on any instance that did not perform the write itself. Without this, an already-open Documents/task Artifacts gallery served by a different store instance than the one an agent wrote through would never receive the live event and would show a stale list until a full reload re-ran the initial fetch.

Agent-facing registration tools are documented in [Artifact registry tools](./agents.md#artifact-registry-tools), and the dashboard browsing surface is documented in [Artifacts View](./dashboard-guide.md#artifacts-view).

### Task-ID integrity detection

Fusion runs a read-only task-ID integrity detector at startup and on demand to surface allocator regressions before operators lose track of overwritten cards. The detector checks for:

- duplicate task IDs inside `tasks`
- task IDs that exist in both `tasks` and `archivedTasks`
- `distributed_task_id_state.nextSequence` values that point at or below an already-used numeric suffix
- committed reservation rows that still reference existing task IDs
- active task rows whose prefix falls outside the prefixes declared in `distributed_task_id_state`

The latest report is exposed in two operator-facing places:

- `GET /api/health` returns a `taskIdIntegrity` object with `status`, `checkedAt`, `anomalies`, and a `recommendedAction` string. Anomalies or an integrity-query `error` degrade the top-level health status; missing PostgreSQL layers and connectivity failures also fail closed rather than reporting the backend-mode healthy sentinel.
- The dashboard renders a non-dismissible task-ID integrity banner for anomalous reports so the operator sees the issue in the same session.

### Operator playbook

When the detector reports an anomaly:

1. Pause task delegation and avoid creating new tasks until the state is understood.
2. Inspect the affected task IDs in the dashboard/database and confirm whether any live task content or archived records mismatched their IDs.
3. If the historical allocator audit script is available in your checkout, run it before resuming normal task creation.

### Detecting historical task-ID overwrites

If allocator state drifted before the current guards landed, historical task records may still contain overwrite evidence. Run the audit script from the project root:

```bash
node scripts/audit-task-id-collisions.mjs [--project-root /path/to/project]
```

The script checks for:
- `task.json.history` timestamps older than the active DB row's `createdAt`
- task-title mismatches between PostgreSQL and the first `#` heading in `PROMPT.md`
- task-title mismatches against the latest `Fusion-Task-Id` commit subject on `main`
- active tasks that share an ID with an `archivedTasks` row

Treat flagged candidates as recovery leads, not automatic truth: review the surviving task files, logs, and commit history, then file a follow-up recovery task for any confirmed overwrite.

### Reconciling stale task title/description vs canonical PROMPT.md

Use the one-shot reconciliation script only when the surviving evidence agrees on a single canonical task identity and the ambiguity is limited to stale metadata fields on that same task row:

```bash
node scripts/reconcile-fn-3909-identity.mjs [--project-root /path/to/project] [--apply]
```

The script is intentionally narrow and idempotent:
- dry-run is the default and prints the before/after title + description diff without mutating anything
- `--apply` only updates task `FN-3909` through `TaskStore.updateTask(...)` and appends an audit log entry referencing `FN-4194`
- the script refuses to run if `PROMPT.md` no longer matches the expected canonical heading, if the stale heartbeat-scope row contents are not present, or if the row is already canonical without the reconciliation marker

Use this path for the confirmed FN-3909 mismatch (canonical UI-fix prompt/merge history, stale heartbeat-scope title/description). Do **not** use it for allocator-collision or overwrite incidents that may involve multiple tasks or conflicting survivors; run `scripts/audit-task-id-collisions.mjs` first and treat those cases as recovery/postmortem work instead of automatic metadata repair.

### Forensic / historical-task reconciliation: where to read from

For any audit/forensic/reconciliation task that targets another task ID (for example FN-4194 reconciling FN-3909), source-of-truth locations are always at the project root:

- On-disk task artifacts: `<rootDir>/.fusion/tasks/{ID}/` (`task.json`, `PROMPT.md`, `attachments/`, agent logs)
- Task database row: PostgreSQL `project.tasks` scoped by the project's `.fusion/project.json` identity

Important execution nuance:

- `.fusion/` is gitignored, so worktrees branched from `main` do not contain other tasks' artifact directories or the live DB file.
- The running worktree's own `.fusion/` (when present) is scratch/session state for the running task only; do not treat it as authoritative evidence for historical tasks.
- Triage spec writers inject this guidance via `TRIAGE_SYSTEM_PROMPT` and `FAST_TRIAGE_SYSTEM_PROMPT` in `packages/engine/src/triage.ts`.
- Executor-side path normalization remains consistent with this rule through `scopePromptToWorktree` in `packages/engine/src/step-session-executor.ts`, which rewrites accidental worktree-local `.fusion` references back to project-root `.fusion` paths.

## Executor snapshot vs landed diff (FN-4646)

- `task.modifiedFiles` stores the executor's last captured worktree snapshot. During in-progress/in-review this is the primary fallback and may include files later reverted before merge or changed by verification rebuilds.
- `task.mergeDetails.landedFiles` stores the authoritative landed file list on the merge target:
  - squash path: `git show --name-only --format= <commitSha>`
  - rebase/cherry-pick path: union of files from task-attributable commits returned by `filterFilesToOwnTaskCommits` (`landedFilesAttributionRestricted: true`)
  - attribution fallback path: if commit attribution fails, merger falls back to `git diff --name-only <rebaseBaseSha>..<commitSha>` and sets `landedFilesCaptureFallback: "attribution-failed"`
- `mergeDetails.noOpVerifiedShortCircuit` marks rebase captures where zero commits are attributable to the task (`landedFiles: []`, stats zero); this indicates the branch's work was already on main.
- After merge (and during self-healing reconciliation), Fusion updates `task.modifiedFiles` to match `landedFiles` when the landed set is available and non-empty.
- Consumer guidance:
  - done tasks: prefer `mergeDetails.landedFiles`
  - in-progress/in-review (or legacy pre-FN-4646 tasks): fall back to `task.modifiedFiles`

## Legacy SQLite FTS5 task-index maintenance (historical, FN-5943 / FN-5976)

This section records the pre-PostgreSQL design for migration archaeology. It is not an active runtime architecture or recommendation.

- Live task search uses the `tasks_fts` external-content FTS5 table in `fusion.db`; the archive log uses a separate `archived_tasks_fts` table in `archive.db`.
- `tasks_fts_au` is value-aware and column-scoped. Hot task mutations (`atomicWriteTaskJson` / `atomicWriteTaskJsonWithAudit`) now diff the current row against the incoming task and issue `UPDATE tasks SET <changed cols>, updatedAt = ? WHERE id = ?` instead of rewriting the full task row. Non-text churn (status, steps, leases, scheduler stamps) therefore skips the FTS trigger entirely because those UPDATEs omit the indexed text columns.
- Full-row task persistence is still intentional for create/restore/replication-class paths: `insertTask` / `atomicCreateTaskJson` remain plain `INSERT`, and direct replication-style upserts (`upsertTaskWithFtsRecovery`, for example task-metadata snapshot application) still use the generated full-row `INSERT ... ON CONFLICT DO UPDATE` form.
- After a partial SQLite update, Fusion rewrites compatibility `task.json` from a fresh DB read so the disk mirror stays byte-aligned with the authoritative row even on narrow SQL patches.
- Checkout lease renewal has its own targeted path (`renewCheckoutLease`), updating only `checkoutRunId`, `checkoutLeaseRenewedAt`, and `updatedAt` instead of routing through the broad `updateTask(...)` mutator.
- Both `Database.getFtsIndexBytes()` and `ArchiveDatabase.getFtsIndexBytes()` measure index size via `SELECT SUM(LENGTH(block)) FROM <fts>_data`. Fusion intentionally does **not** rely on `dbstat`, because node:sqlite builds do not guarantee `SQLITE_ENABLE_DBSTAT_VTAB`.
- `SelfHealingManager` Batch 1 runs one `fts-maintenance` step with per-index `fts5Available` guards:
  - `tasks_fts`: every maintenance tick runs incremental `merge`, every 4th tick escalates to `optimize`, and an immediate full `rebuild` fires when the index exceeds either `32 MiB` absolute or `1 MiB × live task count`.
  - `archived_tasks_fts`: because the archive DB is mostly append-only, maintenance runs less often — incremental `merge` every 8th tick, `optimize` every 24th tick, and a full `rebuild` only when the index exceeds either `64 MiB` absolute or `512 KiB × archived row count`.
- Each maintenance pass emits run-audit telemetry with `mutationType: "task:fts-maintenance"`; the live index uses `target: "tasks_fts"`, the archive index uses `target: "archived_tasks_fts"`, and metadata includes the before/after byte counts plus row-count/threshold details for that target.
- `rebuildFts5Index()` and migration 103 also set conservative FTS5 merge policy (`automerge=8`, `crisismerge=16`) so legitimate text edits merge segments sooner without forcing the heaviest optimize path on every write.

### Attached live-FTS DB investigation (FN-5976)

- Recommendation: **defer** moving `tasks_fts*` into a dedicated attached SQLite file.
- The key blocker is architectural, not syntactic:
  - SQLite FTS5 external-content tables require the content table to live in the **same database** (`https://www.sqlite.org/fts5.html`, §4.4.3).
  - SQLite non-TEMP triggers may only query/modify tables in the **same database** as the trigger target (`https://www.sqlite.org/lang_createtrigger.html`, §2.1).
  - So relocating `tasks_fts*` while `tasks` stays in `fusion.db` is **not** a simple shadow-table split. It forces a move away from external-content FTS to a **contentless/standalone** FTS table with manual population and sync.
- Current code paths that would have to change for such a redesign:
  - `packages/core/src/db.ts` — FTS table definition, trigger model, `rebuildFts5Index()`, integrity/maintenance hooks
  - `packages/core/src/store.ts` — `searchTasks()` join shape and FTS corruption-recovery wrappers
  - potentially backup/checkpoint handling for a second live writable DB file
- The existing `archive.db` setup is only a partial precedent: `archived_tasks_fts` lives in a separate file from `fusion.db`, but it still lives in the **same file** as its own content table (`archived_tasks`). It does **not** demonstrate cross-database external-content FTS.
- `DatabaseSync` can execute `ATTACH DATABASE` because the adapter exposes raw SQLite `exec()` / `prepare()`, and an empirical `node:sqlite` probe confirmed that an attached contentless FTS table can participate in a cross-db `JOIN` + `MATCH` query. But that only proves query feasibility after a redesign; it does not preserve today's automatic external-content sync model.

| Dimension | Verdict vs baseline | Why |
| --- | --- | --- |
| Cross-DB search joins | worse | Feasible only after abandoning external-content semantics and rewriting `searchTasks()` around a manually maintained attached FTS table. |
| Transaction / atomicity behavior | blocker | SQLite attached-db docs warn that with `journal_mode=WAL`, crash atomicity is only per file, so `tasks` and attached FTS writes can tear across files (`https://www.sqlite.org/lang_attach.html`). |
| WAL / checkpoint coordination | worse | `walCheckpoint()` / self-healing would need to coordinate two live WAL files instead of one. |
| Backup / restore flow | worse | Operators must back up and restore a consistent multi-file live DB set or treat the FTS file as disposable and rebuild it explicitly. |
| Multi-instance polling | worse | Two writable files widen the lock/busy surface for concurrent Fusion processes over the same project storage. |
| FTS corruption recovery | improves | Best upside: corruption/bloat would be isolated to a disposable FTS file instead of the primary task DB. |

- Why defer now:
  - FN-5943 already landed the lower-risk fix for the observed incident: fewer rewrites, bounded merge/optimize maintenance, and threshold-triggered rebuild.
  - FN-6008 rechecked the post-FN-5943 operational evidence against the live project DB and the defer condition still holds:
    - recent `runAuditEvents` telemetry for `target: "tasks_fts"` shows the live index staying bounded in the **tens to low hundreds of KB**, not MB-scale bloat;
    - sampled maintenance windows showed **0 rebuild events**, with `merge`/`optimize` repeatedly pulling the index back down (for example `141186 → 43990` bytes, `96571 → 40693` bytes, `44076 → 43296` bytes, and `53261 → 40449` bytes);
    - direct `tasks_fts_data` size checks during review were only about **48–50 KB** for the current project DB (including **47884 bytes** in one sample and about **50 KB** for **36** live tasks in another);
    - reviewed logs showed no concrete recurring post-FN-5943 live `tasks_fts` corruption pattern or repeated FTS rebuild failures, though one older merge-agent log did contain a general `database disk image is malformed` crash.
  - The attached-file idea still improves corruption isolation, but it would trade away the current same-file trigger-maintained index for a manual two-file sync architecture with weaker crash atomicity under WAL.
- Revisit only if post-FN-5943 production evidence shows recurring `fusion.db`-coupled FTS corruption or materially persistent live-index bloat significant enough to justify a contentless/manual-sync redesign. Until then, keep the single-file external-content design and existing maintenance path.

## Legacy SQLite write-path lock recovery (historical, FN-4042 / FN-4083)

- Every disk-backed SQLite connection that Fusion opens for project storage (`fusion.db`), the central registry (`fusion-central.db`), archives (`archive.db`), and worktree hydration explicitly sets `PRAGMA busy_timeout = 5000` and `PRAGMA journal_mode = WAL` at connection open time before write work begins.
- Project database transactions now distinguish read and write intent:
  - `Database.transaction()` uses `BEGIN` (DEFERRED) for outermost transactions so read-only callers do not reserve the writer lock up front.
  - `Database.transactionImmediate()` uses `BEGIN IMMEDIATE` for write-heavy paths that must detect writer contention before user code runs.
- The shared task mutation path `atomicWriteTaskJsonWithAudit()` uses `transactionImmediate()`, so the task-row upsert and matching `runAuditEvents` insert still commit or roll back together, while lock contention is detected before the callback mutates in-memory state.
- `CentralDatabase.transaction()` remains `BEGIN IMMEDIATE`-based because its current callers are write-oriented coordination updates; nested transactions still use SQLite `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` semantics in both databases.
- Recovery is intentionally bounded: transient `SQLITE_BUSY` / `SQLITE_LOCKED` failures on outermost `BEGIN IMMEDIATE` and `COMMIT` are retried for a short additional window with small synchronous backoff sleeps. If the lock does not clear, the original write still fails loudly.
- Concurrent-write guarantees are layered:
  - per-task mutations inside one engine process are serialized by `TaskStore.withTaskLock()`
  - cross-task writes rely on WAL mode plus `busy_timeout`
  - write-heavy transactional hot paths acquire `BEGIN IMMEDIATE` before mutating state
  - compatibility `task.json` writes still happen only after the SQLite transaction succeeds
- Direct `recordRunAuditEvent()` writes continue to execute inside the shared transaction helper so they benefit from the same lock recovery and do not duplicate rows during transient contention.

## 1) Summary

- **localStorage keys in runtime dashboard code:** **20**
- **Backend settings keys defined in `@fusion/core`:** **79** total
  - **Global settings:** 17 (`GlobalSettings`)
  - **Project settings:** 62 (`ProjectSettings`)
- **Legacy SQLite tables in the audited pre-cutover project schema (`packages/core/src/db.ts`):** **47** (including migration-created tables; retained here as migration inventory)
- **Issues identified:** **9**
  - High: 2
  - Medium: 5
  - Low: 2

High-level finding: the dashboard currently uses localStorage extensively for UX state and drafts (good for responsiveness), but several keys are **not project-scoped** in a multi-project app and some data has **sync gaps** against backend persistence (notably theme settings).

---

## 2) localStorage Inventory

| Storage Key | Component/Hook | Data Type | Category | Risk Level |
|---|---|---|---|---|
| `kb-dashboard-theme-mode` | `hooks/useTheme.ts` | enum string (`dark`/`light`/`system`) | settings overlap | **Medium** |
| `kb-dashboard-color-theme` | `hooks/useTheme.ts` | enum string (color theme id) | settings overlap | **Medium** |
| `kb-dashboard-current-project` | `hooks/useCurrentProject.ts` | JSON `ProjectInfo` object (includes id/name/path/status/etc.) | project/identity | **Medium** |
| `kb-terminal-tabs` | `hooks/useTerminalSessions.ts` | JSON array of tab objects (`id`, `sessionId`, `title`, active state, timestamp) | UI preference (operational session state) | **High** |
| `fn-agent-tree-expanded` | `hooks/useAgentHierarchy.ts` | JSON string[] of expanded agent ids | UI preference | Low |
| `kb-planning-last-description` | `hooks/modalPersistence.ts` (used by `PlanningModeModal`) | free-text draft | user draft | Medium |
| `kb-subtask-last-description` | `hooks/modalPersistence.ts` (used by `SubtaskBreakdownModal`) | free-text draft | user draft | Medium |
| `kb-mission-last-goal` | `hooks/modalPersistence.ts` (used by `MissionInterviewModal`) | free-text draft | user draft | Medium |
| `kb-dashboard-view-mode` | `App.tsx` | enum string (`overview`/`project`) | UI preference | Low |
| `kb-dashboard-task-view` | `App.tsx` | enum string (`board`/`list`/`agents`) | UI preference | Low |
| `kb-dashboard-list-columns` | `components/ListView.tsx` | JSON array of visible list columns | UI preference | Low |
| `kb-dashboard-hide-done` | `components/ListView.tsx` | boolean string (`"true"`/`"false"`) | UI preference | Low |
| `kb-dashboard-list-collapsed` | `components/ListView.tsx` | JSON array of collapsed column ids | UI preference | Low |
| `kb-dashboard-selected-tasks` | `components/ListView.tsx` | JSON array of selected task IDs | UI preference | **Medium** |
| `kb-quick-entry-text` | `components/QuickEntryBox.tsx` | free-text task draft | user draft | Medium |
| `kb-quick-entry-expanded` | `components/QuickEntryBox.tsx` (legacy cleanup via `removeItem`) | legacy bool key (no longer used) | UI preference | Low |
| `kb-inline-create-text` | `components/InlineCreateCard.tsx` | free-text task draft | user draft | Medium |
| `fn-agent-view` | `components/AgentsView.tsx`, `components/AgentListModal.tsx` | enum string (`board`/`list`/`tree` in view; modal supports board/list) | UI preference | Medium |
| `kb-usage-view-mode` | `components/UsageIndicator.tsx` | enum string (`used`/`remaining`) | UI preference | Low |
| `kb-dashboard-recent-projects` | `components/ProjectOverview.tsx` | JSON array of recent project IDs | project/identity | Low |

Notes:
- Search scope: `packages/dashboard/app/**/*.ts(x)` runtime code (tests excluded).
- `useTheme.getThemeInitScript()` also reads the same theme keys before hydration.

---

## 3) Backend Settings Inventory

API endpoints reviewed:
- `GET /api/settings` (merged global + project view)
- `PUT /api/settings` (project updates)
- `GET /api/settings/global`
- `PUT /api/settings/global`
- `GET /api/settings/scopes`

### 3.1 Global settings (`~/.fusion/settings.json`)

| Setting Key | Scope | API Endpoint | Description |
|---|---|---|---|
| `themeMode` | Global | `GET/PUT /api/settings/global` (+ merged via `GET /api/settings`) | Theme mode preference |
| `colorTheme` | Global | `GET/PUT /api/settings/global` | Color/accent theme |
| `dashboardFontScalePct` | Global | `GET/PUT /api/settings/global` | Dashboard Appearance font scale percentage (85–125, default 100) applied before hydration. |
| `defaultProvider` | Global | `GET/PUT /api/settings/global` | Default model provider |
| `defaultModelId` | Global | `GET/PUT /api/settings/global` | Default model id |
| `fallbackProvider` | Global | `GET/PUT /api/settings/global` | Fallback model provider |
| `fallbackModelId` | Global | `GET/PUT /api/settings/global` | Fallback model id |
| `fallbackThinkingLevel` | Global | `GET/PUT /api/settings/global` | Fallback model reasoning effort; unset inherits |
| `defaultThinkingLevel` | Global | `GET/PUT /api/settings/global` | Default reasoning effort |
| `ntfyEnabled` | Global | `GET/PUT /api/settings/global` | Notifications enabled |
| `ntfyTopic` | Global | `GET/PUT /api/settings/global` | Ntfy topic |
| `ntfyBaseUrl` | Global | `GET/PUT /api/settings/global` | Custom ntfy server base URL override |
| `ntfyAccessToken` | Global | `GET/PUT /api/settings/global` | Access token for authenticated ntfy publishes |
| `ntfyEvents` | Global | `GET/PUT /api/settings/global` | Notification event filters (includes opt-in `task-created` for agent-created task notifications) |
| `ntfyDashboardHost` | Global | `GET/PUT /api/settings/global` | Host for deep links |
| `defaultProjectId` | Global | `GET/PUT /api/settings/global` | CLI default project |
| `setupComplete` | Global | `GET/PUT /api/settings/global` (internal first-run use) | Setup wizard completion flag |
| `favoriteProviders` | Global | `GET/PUT /api/settings/global` | Favorited providers |
| `favoriteModels` | Global | `GET/PUT /api/settings/global` | Favorited models |
| `openrouterModelSync` | Global | `GET/PUT /api/settings/global` | Startup model sync behavior |
| `modelOnboardingComplete` | Global | `GET/PUT /api/settings/global` | Onboarding completion flag |
| `executionGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for task execution |
| `executionGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for task execution |
| `planningGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for planning |
| `planningGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for planning |
| `validatorGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for validator/reviewer |
| `validatorGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for validator/reviewer |
| `titleSummarizerGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for title summarization |
| `titleSummarizerGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for title summarization |

### 3.2 Project settings (`.fusion/config.json` / `config.settings`)

| Setting Key | Scope | API Endpoint | Description |
|---|---|---|---|
| `globalPause` | Project | `GET/PUT /api/settings` | Hard stop for engine activity |
| `enginePaused` | Project | `GET/PUT /api/settings` | Soft pause for dispatch |
| `maxConcurrent` | Project | `GET/PUT /api/settings` | Max concurrent task-lane agents. Utility AI workflows bypass this limit. |
| `maxWorktrees` | Project | `GET/PUT /api/settings` | Worktree cap |
| `pollIntervalMs` | Project | `GET/PUT /api/settings` | Scheduler poll interval |
| `groupOverlappingFiles` | Project | `GET/PUT /api/settings` | Serialize overlapping file work |
| `overlapIgnorePaths` | Project | `GET/PUT /api/settings` | Project-relative file/directory paths ignored by overlap blocking |
| `autoMerge` | Project | `GET/PUT /api/settings` | Enable auto merge |
| `planApprovalMode` | Project | `GET/PUT /api/settings` | Project-wide plan approval override: `workflow`, `auto-approve-all`, or `require-all` |
| `mergeStrategy` | Project | `GET/PUT /api/settings` | Direct vs PR merge strategy |
| `worktreeInitCommand` | Project | `GET/PUT /api/settings` | Command run on worktree init |
| `testCommand` | Project | `GET/PUT /api/settings` | Project test command |
| `buildCommand` | Project | `GET/PUT /api/settings` | Project build command |
| `recycleWorktrees` | Project | `GET/PUT /api/settings` | Worktree pool toggle |
| `worktreeNaming` | Project | `GET/PUT /api/settings` | Worktree naming strategy |
| `worktrunk` (`worktrunk.enabled`, `worktrunk.binaryPath`, `worktrunk.onFailure`) | Global + Project | `GET/PUT /api/settings/global` and `GET/PUT /api/settings` | Worktrunk integration settings group. Resolved with field-level project-overrides-global precedence in merged settings. See `docs/settings-reference.md` for key details and defaults. |
| `worktreesDir` | Project | `GET/PUT /api/settings` | Optional worktree container directory (supports absolute/project-relative paths, `~`, `{repo}` token) |
| `taskPrefix` | Project | `GET/PUT /api/settings` | Task ID prefix |
| `includeTaskIdInCommit` | Project | `GET/PUT /api/settings` | Commit scope formatting |
| `defaultProviderOverride` | Project | `GET/PUT /api/settings` | Project-level override for base default provider |
| `defaultModelIdOverride` | Project | `GET/PUT /api/settings` | Project-level override for base default model ID |
| `executionProvider` | Project | `GET/PUT /api/settings` | AI provider for task execution |
| `executionModelId` | Project | `GET/PUT /api/settings` | AI model ID for task execution |
| `planningProvider` | Project | `GET/PUT /api/settings` | Planning model provider |
| `planningModelId` | Project | `GET/PUT /api/settings` | Planning model id |
| `planningFallbackProvider` | Workflow | `fn_workflow_settings` / workflow settings API | Planning fallback provider |
| `planningFallbackModelId` | Workflow | `fn_workflow_settings` / workflow settings API | Planning fallback model id |
| `planningFallbackThinkingLevel` | Workflow | `fn_workflow_settings` / workflow settings API | Planning fallback reasoning effort; unset inherits |
| `validatorProvider` | Project | `GET/PUT /api/settings` | Validator model provider |
| `validatorModelId` | Project | `GET/PUT /api/settings` | Validator model id |
| `validatorFallbackProvider` | Workflow | `fn_workflow_settings` / workflow settings API | Validator fallback provider |
| `validatorFallbackModelId` | Workflow | `fn_workflow_settings` / workflow settings API | Validator fallback model id |
| `validatorFallbackThinkingLevel` | Workflow | `fn_workflow_settings` / workflow settings API | Validator fallback reasoning effort; unset inherits |
| `modelPresets` | Project | `GET/PUT /api/settings` | Reusable model presets |
| `autoSelectModelPreset` | Project | `GET/PUT /api/settings` | Auto-preset by task size |
| `defaultPresetBySize` | Project | `GET/PUT /api/settings` | Size→preset mapping |
| `autoResolveConflicts` | Project | `GET/PUT /api/settings` | Smart conflict auto-resolution |
| `smartConflictResolution` | Project | `GET/PUT /api/settings` | Alias for conflict automation |
| `strictScopeEnforcement` | Project | `GET/PUT /api/settings` | Block out-of-scope file changes |
| `buildRetryCount` | Project | `GET/PUT /api/settings` | Build retry attempts |
| `buildTimeoutMs` | Project | `GET/PUT /api/settings` | Build timeout |
| `requirePlanApproval` | Project | `GET/PUT /api/settings` | Manual plan approval gate |
| `taskStuckTimeoutMs` | Project | `GET/PUT /api/settings` | Stuck task timeout |
| `autoUnpauseEnabled` | Project | `GET/PUT /api/settings` | Auto unpause on rate limits |
| `autoUnpauseBaseDelayMs` | Project | `GET/PUT /api/settings` | Base backoff delay |
| `autoUnpauseMaxDelayMs` | Project | `GET/PUT /api/settings` | Max backoff delay |
| `maxStuckKills` | Project | `GET/PUT /api/settings` | Max detector retries |
| `maxSpawnedAgentsPerParent` | Project | `GET/PUT /api/settings` | Child agents per parent |
| `maxSpawnedAgentsGlobal` | Project | `GET/PUT /api/settings` | Total spawned-agent cap |
| `maintenanceIntervalMs` | Project | `GET/PUT /api/settings` | Maintenance cadence |
| `autoUpdatePrStatus` | Project | `GET/PUT /api/settings` | PR badge polling |
| `autoCreatePr` | Project | `GET/PUT /api/settings` | Automatic PR creation |
| `autoBackupEnabled` | Project | `GET/PUT /api/settings` | Scheduled backup toggle |
| `autoBackupSchedule` | Project | `GET/PUT /api/settings` | Backup cron schedule |
| `autoBackupRetention` | Project | `GET/PUT /api/settings` | Backup retention count |
| `autoBackupDir` | Project | `GET/PUT /api/settings` | Backup directory |
| `autoSummarizeTitles` | Project | `GET/PUT /api/settings` | Auto-title generation |
| `titleSummarizerProvider` | Project | `GET/PUT /api/settings` | Title model provider |
| `titleSummarizerModelId` | Project | `GET/PUT /api/settings` | Title model id |
| `titleSummarizerFallbackProvider` | Project | `GET/PUT /api/settings` | Title fallback provider |
| `titleSummarizerFallbackModelId` | Project | `GET/PUT /api/settings` | Title fallback model id |
| `titleSummarizerFallbackThinkingLevel` | Project | `GET/PUT /api/settings` | Title fallback reasoning effort; unset inherits |
| `scripts` | Project | `GET/PUT /api/settings` | Named script map |
| `setupScript` | Project | `GET/PUT /api/settings` | Named setup script reference |
| `insightExtractionEnabled` | Project | `GET/PUT /api/settings` | Insight extraction toggle |
| `insightExtractionSchedule` | Project | `GET/PUT /api/settings` | Insight extraction schedule |
| `insightExtractionMinIntervalMs` | Project | `GET/PUT /api/settings` | Minimum extraction interval |
| `memoryEnabled` | Project | `GET/PUT /api/settings` | Memory system toggle |
| `tokenCap` | Project | `GET/PUT /api/settings` | Token cap for compacting |
| `runStepsInNewSessions` | Project | `GET/PUT /api/settings` | Step session isolation |
| `maxParallelSteps` | Project | `GET/PUT /api/settings` | Parallel step cap |
| `agentPrompts` | Project | `GET/PUT /api/settings` | Per-role prompt templates |

Additional backend notes:
- `githubTokenConfigured` is returned by `GET /api/settings` but is **computed server-side**, not persisted.
- Non-settings config persisted in backend include `nextId`, `workflowSteps`, and `nextWorkflowStepId` (`config` row / config JSON compatibility path).
- **`*Global*` keys are never persisted in project settings** — these belong exclusively to global settings. Conversely, project-only keys (`defaultProviderOverride`, `executionProvider`, `planningProvider`, etc.) are never persisted in global settings. The two scopes are strictly isolated.

---

### Legacy SQLite backup pairing behavior (migration/history only)

Backups in `.fusion/backups/` now capture the project DB and (when present) the global central DB as a pair using the same timestamp/counter:
- `fusion-<timestamp>(-N).db` (project)
- `fusion-central-<timestamp>(-N).db` (central, from `~/.fusion/fusion-central.db`)

`BackupManager` supports `includeCentralDb` (default `true`). If central DB is missing or disabled, project backup still succeeds and records a skip reason. Retention (`autoBackupRetention`) is still computed from project backups; when an old project backup is pruned, its matching `fusion-central-*` sibling is pruned too. Restoring a project backup also restores the paired central backup when available; restoring a `fusion-central-*` file restores the central DB only. Pre-restore snapshots use `fusion-pre-restore-<timestamp>.db` and `fusion-central-pre-restore-<timestamp>.db`.

Database Backup automation failures are surfaced with DB-qualified detail. Project backup failures include the project DB source path, backup target or backup directory when available, and the underlying cause; central DB sub-failures keep the project backup run successful but include `Central DB backup failed` plus central source/target/cause detail in the run output.

## 4) Legacy SQLite Tables Inventory (`packages/core/src/db.ts`, migration reference)

| Table | Purpose |
|---|---|
| `tasks` | Core task metadata and JSON-backed nested fields (priority, dependencies, steps, log, attachments, comments, model overrides, workflow results, merge details, assignment, mission linkage). |
| `branch_groups` | Durable PostgreSQL shared-branch group records keyed by project plus `BG-*` id, with source linkage (`mission`/`planning`/`new-task`), branch/worktree metadata, optional PR tracking fields, lifecycle status, and per-group `autoMerge` override. These rows are authoritative after restart; task `sourceMetadata.fusionBranchContext.groupId` values should point at real `BG-*` rows, and stale references are cleared through `TaskStore.setTaskBranchGroup(taskId, null)` / `POST /api/branch-groups/assign` rather than direct SQL edits. |
| `mergeQueue` | Durable merge handoff queue keyed by `taskId`. Stores enqueue ordering (`enqueuedAt`, mirrored `priority`), single-owner lease state (`leasedBy`, `leasedAt`, `leaseExpiresAt`), and retry diagnostics (`attemptCount`, `lastError`). Leasing is priority-first + FIFO within priority, and expired leases are recoverable without incrementing attempts. FN-5242 adds the persistence/lease primitive; FN-5241 and FN-5243 wire executor enqueue + merger consumption. |

FN-5240/FN-5241/FN-5242 establish the handoff invariant: the only legal executor/self-healing path into `in-review` after execution finishes is `TaskStore.handoffToReview(...)`. That helper runs the column move, `mergeQueue` insert, and handoff audit fan-out inside one `BEGIN IMMEDIATE` transaction so observers never see `column = "in-review"` without the matching queue row. Direct `moveTask(taskId, "in-review")` writes remain allowed for explicit non-handoff/test paths but emit `task:handoff-invariant-violation` run-audit events unless the caller opts into the narrow allowlist flag.

The `tasks.githubTracking` JSON column stores per-task GitHub tracking state (`enabled`, optional `repoOverride`, linked issue metadata, and `unlinkedAt`). It is additive and default-off; imported-source issue metadata remains in `issueInfo` / `sourceIssue`. Behavior wiring (issue creation/lifecycle sync and UI surfacing) lands in FN-3870/FN-3873/FN-3874.

The `tasks.sourceIssueClosedAt` column (migration 122) backs `TaskSourceIssue.closedAt`, a nullable ISO-8601 timestamp for the originating external issue's real close time. Going forward, the GitHub source-issue reconciler fills it when it closes the linked issue itself or observes GitHub's `closed_at`/`closedAt` value. Historical GitHub-imported `done`/`archived` rows that still have `NULL` can be filled retroactively by the optional manual `POST /api/git/github/backfill-source-issue-closed-at` sweep, now exposed as **Backfill exact close times** in the Command Center GitHub area's Fixed by Fusion card. The sweep is idempotent, paginated, writes only real GitHub `closed_at` values, reports `scanned`/`filled`/`skipped`/`errors`, and never overwrites an existing timestamp or runs automatically. Command Center "Fixed by Fusion" analytics read this exact timestamp when available and fall back to `updatedAt` only when it has not been observed.

The `tasks.tokenUsage*` columns store cumulative per-task token usage for analytics. `tokenUsageModelProvider` and `tokenUsageModelId` are analytics-only snapshots of the actually-used runtime model recorded when usage is accumulated; they let Command Center group and price resolved-via-settings usage by provider/model without writing the task-level `modelProvider` / `modelId` own-model override fields that control future model resolution. Cost attribution reads the snapshot first and falls back to the legacy own-model columns for pre-snapshot rows.

The nullable `tasks.tokenUsagePerModel` JSON column (migration 125) stores the per-task, per-runtime-model breakdown behind those cumulative totals. Each bucket records provider/model, token counts, and first/last use timestamps. Command Center model/provider analytics expand these buckets so multi-model tasks appear under every model they actually used; task-level totals, cost, time series, node grouping, and agent grouping still read the top-level aggregate so grand `nTasks` is not double-counted. Empty, missing, or malformed per-model JSON falls back to the legacy single-snapshot grouping path.

The `task_commit_associations.additions` and `task_commit_associations.deletions` columns (migration 123) store nullable merge-time git shortstat counts for the associated commit. Command Center Productivity uses `SUM(additions + deletions)` as the Lines changed source when at least one in-range association has non-null stats, then derives estimated `hoursSaved` as `round(loc / HUMAN_LINES_PER_HOUR, 1)`. `NULL` means stats were unknown or unavailable for that association, not zero; ranges with no non-null stats keep the unavailable `—` sentinel for both LOC and hours saved instead of reporting `0`. Historical rows created before diff-stat capture can be backfilled from local git with the explicit operator action `POST /api/command-center/productivity/backfill-loc` (dry-run by default). The backfill only updates rows where both columns are `NULL`; it validates commit SHAs before invoking git, leaves malformed or locally unavailable commit objects as `NULL`, and never overwrites already-populated stats.

The `tasks.cumulativeActiveMs` and `tasks.executionCompletedAt` columns are the Command Center Productivity task-duration source. Duration analytics select `column = 'done'` tasks completed in the requested range (`executionCompletedAt`) and include only positive `cumulativeActiveMs` values, then compute completed count, average, median, p90, and total active execution time. Missing, zero, or historical untracked duration values remain unavailable (`—`) rather than being serialized or rendered as `0`.
| `config` | Single-row project configuration (`nextId`, settings payload, workflow step counters). |
| `workflow_steps` | Workflow step definitions (`prompt`/`script`) with phase, template metadata, and model overrides. |
| `activityLog` | Per-project activity/event log with timestamp/type/task indexes. |
| `task_commit_associations` | Commit-to-task-lineage associations for canonical and legacy landed-commit attribution. Includes nullable `additions`/`deletions` diff-stat columns captured at merge time or by the explicit NULL-only local-git backfill for Command Center Productivity LOC and derived estimated `hoursSaved`; `NULL` means stats unknown, not zero. |
| `archivedTasks` | Archived task snapshots (compact JSON payload + archive timestamp). |
| `automations` | Scheduled automation definitions, run state, and run history. |
| `agents` | Agent registry/state/task assignment metadata. |
| `agentHeartbeats` | Heartbeat run events linked to agents (`agentId` FK cascade). |
| `approval_requests` | Durable approval request records: requester actor snapshot, target action payload (category/action/resource/context), lifecycle status (`pending`/`approved`/`denied`/`completed`), optional task/run context, and requested/decided/completed timestamps. |
| `approval_request_audit_events` | Append-only audit trail for approval requests. Each row stores event type (`created`/`approved`/`denied`/`completed`), immutable actor snapshot, optional note, and deterministic per-request ordering by `(createdAt, rowid)`. |
| `secrets` | Encrypted secret KV rows (`key` unique) with raw BLOB `value_ciphertext` + per-row random `nonce` (AES-256-GCM), per-secret `access_policy` CHECK (`auto`/`prompt`/`deny`), env-materialization metadata (`env_exportable`, `env_export_key`), and read-audit fields (`last_read_at`, `last_read_by`). Plaintext is never written to the database. |
| `task_documents` | Task-scoped document metadata/content keyed by `(taskId, key)` with current revision pointer. |
| `task_document_revisions` | Immutable revision history for task documents (content snapshots by revision). |
| `artifacts` | Artifact registry metadata for inline text and on-disk media artifacts. Stores type/title/description, MIME type/size, author identity, optional task linkage, metadata JSON, inline `content`, relative `uri`, and timestamps; binary media bytes live under task or registry `artifacts/` directories instead of SQLite. |
| `__meta` | Schema version + monotonic `lastModified` change detector, plus one-time bootstrap metadata such as `bootstrappedAt` and `projectIdentity`. |
| `goals` | Strategic intent records (`title`, optional `description`, `status`, timestamps) that can outlive mission timelines. |
| `mission_goals` | Many-to-many join between missions and goals with composite PK `(missionId, goalId)`, `createdAt`, and cascade-delete foreign keys to both parents. |
| `missions` | Mission-level planning hierarchy root. |
| `milestones` | Milestones under missions, including dependency lists and validation state. |
| `slices` | Slices under milestones with plan-state/activation metadata. |
| `mission_features` | Features under slices with optional task linkage and execution-loop counters/state. |
| `mission_events` | Mission event log with ordered sequence numbers and metadata payloads. |
| `plugins` | Plugin registry, lifecycle state, dependency metadata, and settings blobs. |
| `routines` | Routine definitions (trigger config, steps/command, catch-up policy, run history, and persisted `agentId` ownership metadata). Legacy databases missing routine fields (including `agentId`) are backfilled during init-time compatibility migration. |
| `roadmaps` | Roadmap plugin metadata (owned/registered by `plugins/fusion-plugin-roadmap`). |
| `roadmap_milestones` | Milestones within roadmaps (`roadmapId` FK), owned/registered by roadmap plugin schema hooks. |
| `roadmap_features` | Features within roadmap milestones (`milestoneId` FK), owned/registered by roadmap plugin schema hooks. |
| `project_insights` | Extracted project insights with fingerprint-based deduplication and provenance metadata. |
| `project_insight_runs` | Insight extraction run history with durable lifecycle metadata (`lifecycle` JSON includes terminalReason/cause, failureClass, retryable flag, cancellationRequestedAt, timeoutAt, retry lineage fields). Terminal rows are immutable for state transitions. |
| `project_insight_run_events` | Append-only per-run lifecycle trail (`seq`, `type`, `message`, optional `status`/`classification`/`metadata`) used by cancel/retry/timeout auditing and API inspection. |
| `todo_lists` | Project-scoped todo list metadata (`projectId`, title, created/updated timestamps). |
| `todo_items` | Todo list items (`listId` FK) with completion state, completion timestamp, and deterministic `sortOrder`. |
| `ai_sessions` *(migration-created)* | Persisted AI interactive sessions (planning/interview/subtask) with status and conversation history. Deletion is final within a bounded tombstone window (FN-7949) — see below. |
| `messages` *(migration-created)* | Inter-agent/user message mailbox storage. |
| `agentRatings` *(migration-created)* | Agent performance ratings (1-5), optional reviewer metadata, and run/task attribution. |
| `chat_sessions` *(migration-created)* | Chat session metadata (agent/project/model/status/title timestamps). |
| `chat_messages` *(migration-created)* | Chat message history per session (`role`, `content`, thinking output, metadata). |
| `chat_rooms` *(migration-created)* | Room metadata (`name`, `slug`, `description`, `projectId`, `createdBy`, status and timestamps). |
| `chat_room_members` *(migration-created)* | Room membership map with composite PK `(roomId, agentId)` and role (`owner`/`member`). |
| `chat_room_messages` *(migration-created)* | Room message history with `senderAgentId`, JSON `mentions`, attachments/metadata blobs, ordered by `createdAt`. |
| `runAuditEvents` *(migration-created)* | Run audit trail events across database/git/filesystem mutation domains. |
| `mission_contract_assertions` *(migration-created)* | Milestone contract assertions used by mission validator workflows, including nullable `sourceFeatureId` for the store-managed per-feature assertion owner. |
| `mission_feature_assertions` *(migration-created)* | Many-to-many links between mission features and contract assertions. |
| `mission_validator_runs` *(migration-created)* | Validator run records for mission feature loop execution. |
| `mission_validator_failures` *(migration-created)* | Assertion failure records captured during validator runs. |
| `mission_fix_feature_lineage` *(migration-created)* | Source↔fix feature lineage for auto-generated mission fix features. |
| `research_runs` | Research run state (query, topic, status, lifecycle, sources, results, citations, events, exports, token usage). Supports project-scoped active-run uniqueness via `(projectId, trigger, status)` index. Terminal runs are immutable. |
| `research_exports` | Persisted export records for research runs (`runId` FK cascade). Stores format, content, and optional file path. |
| `research_run_events` | Append-only event log for research run lifecycle tracking (`runId` FK cascade, ordered by `seq`). Records status transitions, phase changes, step lifecycle, and failure classifications. |
| `experiment_sessions` | Experiment-loop session envelope for pi-autoresearch parity (`name`, metric definition JSON, status, current segment, baseline/best run pointers, kept run IDs, tags/metadata, timestamps). |
| `experiment_session_records` | Append-only ordered experiment records per session (`config`/`run`/`hook`/`finalize`) with per-session contiguous `seq`, segment number, JSON payload, and cascade delete via `sessionId` FK. |
| `eval_runs` | Eval run lifecycle state (status, trigger, scope, evaluation window boundaries, evaluated task IDs/counts, aggregate scores, provenance). |
| `eval_task_results` | Per-task eval outcomes linked to runs (`runId` FK cascade), including durable task snapshots and structured score payloads. `categoryScores[]` stores canonical per-category fields (`category`, `deterministicScore`, `aiScore`, `finalScore`, `weight`, `band`, `rationale`, `evidence[]`), plus `overallScore` derived from category finals. Also stores deterministic/AI signal payloads, summary rationale, structured follow-up suggestions (`suggestionId`, `dedupeKey`, recommendation, lifecycle state, suppression fields, optional `createdTaskId` linkage), and a bounded `TaskEvaluationEvidenceBundle` (fixed source-order groups, capped entry counts, max 500-char excerpts with truncation marker) embedded in result metadata for backward-compatible persistence. |
| `eval_run_events` | Append-only eval run event trail (`runId` FK cascade, ordered by `seq`) for orchestration/debug auditing and downstream API/UI drill-down. |

### AI session delete tombstones (FN-7949)

/*
FNXC:AiSessionStore 2026-07-13-00:00: Deleting a Planning Mode session while its background generation was still in flight let the session silently reappear moments later. Root cause: `runGenerationWithTimeout`'s `Promise.race` (in `planning.ts`, and the equivalent wrappers in `subtask-breakdown.ts`/`mission-interview.ts`/`milestone-slice-interview.ts`) only stops the *caller* from awaiting the in-flight `session.agent.session.prompt()` call — it does not cancel it. A straggling `persistSession(...)`-style `upsert()` call landing after the row was deleted would silently re-INSERT it and re-broadcast `ai_session:updated`.
*/

`AiSessionStore.delete()` / `deleteByIdAndType()` / the bulk `cleanupOld()` / `cleanupStaleSessions()` paths now record a delete tombstone (`id -> deletion timestamp`) alongside removing the row. `AiSessionStore.upsert()` checks that tombstone first: a write for an id deleted within the last `DELETE_TOMBSTONE_TTL_MS` (10 minutes — generously longer than any realistic straggling generation write) is dropped without touching PostgreSQL and without emitting `ai_session:updated`. This closes the resurrection race for every `AiSessionType` producer that shares the store (`planning`, `subtask`, `mission_interview`, `milestone_interview`, `slice_interview`), not just the originally reported Planning Mode case.

A normal delete with no in-flight generation, and a genuinely new session that reuses a brand-new distinct id, are both unaffected — the guard only applies to writes for the *exact* id that was just deleted. Tombstone entries are pruned lazily (on tombstone check) and piggyback pruning on the existing `cleanupStaleSessions()` cadence, so the in-memory tombstone map cannot grow unbounded on a long-running server. See `packages/dashboard/src/ai-session-store.ts` (`upsert()`, `isTombstoned()`, `pruneExpiredTombstones()`).

### Legacy Central SQLite Tables Inventory (`packages/core/src/central-db.ts`, migration reference)

| Table | Purpose |
|---|---|
| `secrets_global` | Global-scope counterpart of `secrets`, stored in `~/.fusion/fusion-central.db`; encrypted KV rows with BLOB `value_ciphertext` + per-row random `nonce` (AES-256-GCM), `access_policy` CHECK (`auto`/`prompt`/`deny`), env metadata (`env_exportable`, `env_export_key`), read-audit fields (`last_read_at`, `last_read_by`), and unique index on `key` (plaintext is never persisted). |

### Schema self-heal on init

`Database.init()` runs versioned migrations first, then checks `__meta.schemaCompatFingerprint` against a process-local fingerprint derived from `SCHEMA_VERSION` plus the canonicalized table declarations from `SCHEMA_SQL` and `MIGRATION_ONLY_TABLE_SCHEMAS`.

- **Fingerprint match:** skip the expensive column-reconciliation walk, but still run the cheap idempotent side effects that must always happen on open (for example `CREATE INDEX IF NOT EXISTS ...` and routines NULL backfills).
- **Fingerprint absent or mismatched:** run the full schema-compatibility reconciliation pass, unioning table definitions from `SCHEMA_SQL` plus `MIGRATION_ONLY_TABLE_SCHEMAS` and backfilling missing columns on tables that already exist, then persist the new fingerprint.

Invariant: after init, every declared column for covered tables exists regardless of `__meta.schemaVersion` whenever the fingerprint is stale or missing, preventing legacy drift from causing `no such column` regressions on newly added fields while keeping unchanged-schema opens fast.

### Legacy project identity row (`__meta.projectIdentity`, migration reference)

Pre-cutover `.fusion/fusion.db` files stored the canonical central registry identity in `__meta.projectIdentity` as JSON:

```json
{ "id": "proj_0123456789abcdef", "createdAt": "2026-05-21T12:00:00.000Z", "firstSeenPath": "/abs/project/path" }
```

The PostgreSQL-era runtime writes `.fusion/project.json`. Startup reads this legacy SQLite identity only during migration/reattachment, then preserves the same `projectId` instead of minting a new one.

---

### Chat rooms (migration 70)

`ChatStore` now persists room chat data across three tables: `chat_rooms`, `chat_room_members`, and `chat_room_messages`.

- `chat_rooms` stores canonical room identity (`id`, normalized `name`, unique `slug` scoped by `projectId`), metadata (`description`, `createdBy`), lifecycle status, and timestamps.
- `chat_room_members` links agents to rooms via composite primary key `(roomId, agentId)` and tracks `role` plus `addedAt`.
- `chat_room_messages` stores room history with message role/content, optional `thinkingOutput`, JSON `metadata`, JSON `attachments`, optional `senderAgentId`, and JSON `mentions`.
- Foreign keys from members/messages to `chat_rooms(id)` use `ON DELETE CASCADE`, so deleting a room automatically removes memberships and room message history.

## 5) Issues Found

1. **Theme dual-storage sync gap**  
   - **Severity:** High  
   - **Affected:** `hooks/useTheme.ts`, `App.tsx`, `SettingsModal.tsx`, global settings API (`/api/settings/global`)  
   - **Problem:** Theme is persisted in both localStorage (`kb-dashboard-theme-mode`, `kb-dashboard-color-theme`) and backend global settings (`themeMode`, `colorTheme`), but app bootstrap uses localStorage-only theme hydration. If backend and browser cache diverge, cross-device consistency breaks.  
   - **Recommended fix:** Make backend global settings the source of truth (or explicitly define local cache precedence + bidirectional sync strategy and conflict resolution).

2. **Project-unscoped localStorage keys in multi-project UX state**  
   - **Severity:** High  
   - **Affected:** `App.tsx`, `ListView.tsx`, `QuickEntryBox.tsx`, `InlineCreateCard.tsx`, `AgentsView.tsx`, `useTerminalSessions.ts`, `useAgentHierarchy.ts`, `UsageIndicator.tsx`  
   - **Problem:** Many keys are global (`kb-dashboard-task-view`, `kb-dashboard-list-*`, `kb-dashboard-selected-tasks`, `kb-quick-entry-text`, `kb-inline-create-text`, `kb-terminal-tabs`, etc.) and are reused across projects. This can leak preferences/drafts/selections between projects unexpectedly.  
   - **Recommended fix:** Namespace project-specific keys with `projectId` (e.g., `kb:{projectId}:dashboard-list-columns`). Keep only true global prefs unscoped.

3. **`kb-dashboard-selected-tasks` can carry stale selections across projects**  
   - **Severity:** Medium  
   - **Affected:** `components/ListView.tsx`  
   - **Problem:** Selected task IDs persist globally. In multi-project setups with overlapping ID patterns, stale selections can reappear and affect bulk operations unexpectedly.  
   - **Recommended fix:** Project-scope this key, and/or treat selection as in-memory/session-only state.

4. **Terminal session persistence stores operational identifiers in localStorage**  
   - **Severity:** Medium  
   - **Affected:** `hooks/useTerminalSessions.ts` (`kb-terminal-tabs`)  
   - **Problem:** Session IDs and tab metadata persist client-side and are not project-scoped. This is operational state better owned by backend/session layer; stale tabs also survive cache until cleanup logic runs.  
   - **Recommended fix:** Move terminal tab/session state to server persistence (or at minimum sessionStorage + project scoping + TTL/versioning).

5. **Current project persistence stores full `ProjectInfo` object (includes filesystem path)**  
   - **Severity:** Medium  
   - **Affected:** `hooks/useCurrentProject.ts` (`kb-dashboard-current-project`)  
   - **Problem:** Storing full project objects increases drift risk and stores more data than needed (including local path).  
   - **Recommended fix:** Persist only stable `projectId`; resolve current object from backend project list each load.

6. **Draft persistence is local-only (device/browser-bound)**  
   - **Severity:** Medium  
   - **Affected:** `modalPersistence.ts`, `QuickEntryBox.tsx`, `InlineCreateCard.tsx`  
   - **Problem:** Planning/subtask/mission/task-entry drafts are lost on storage clear or browser/device switch.  
   - **Recommended fix:** Keep local quick-draft behavior, but add optional server-backed drafts (short TTL) for continuity.

7. **Settings scope key lists drift from interfaces**  
   - **Severity:** Medium  
   - **Affected:** `packages/core/src/types.ts`, `store.ts`, `routes.ts`, `SettingsModal.tsx`  
   - **Problem:** `GLOBAL_SETTINGS_KEYS` (14) omits `setupComplete`, `favoriteProviders`, `favoriteModels`; `PROJECT_SETTINGS_KEYS` (52) omits 9 project interface keys (`strictScopeEnforcement`, `buildRetryCount`, `buildTimeoutMs`, `autoUnpause*`, `maintenanceIntervalMs`, `scripts`, `setupScript`). This creates scope-classification and patch-filter inconsistencies.  
   - **Recommended fix:** Generate key lists from schema/interface source (or enforce parity tests) to prevent drift.

8. **`fn-agent-view` shared by two UIs with different supported modes**  
   - **Severity:** Low  
   - **Affected:** `AgentsView.tsx`, `AgentListModal.tsx`  
   - **Problem:** Both share the same key, but one surface supports `tree` and the modal supports only `board/list`; behavior remains valid but coupling is implicit.  
   - **Recommended fix:** Decide intentional shared behavior and document it; otherwise split keys by surface.

9. **Workflow steps still persisted in config JSON compatibility path (known in-progress work)**  
   - **Severity:** Low  
   - **Affected:** `config.settings/workflowSteps`, `db.ts` config table  
   - **Problem (historical audit):** Workflow step storage was tied to config blob structure; **FN-1201** moved it to a dedicated table before the PostgreSQL cutover.
   - **Recommended fix:** Preserve the dedicated PostgreSQL table and do not reintroduce config-blob coupling.

---

## 6) Recommendations (Prioritized)

### P0 — High impact / should do first

1. **Unify theme persistence contract**
   - Backend global settings should be canonical for multi-device consistency.
   - Keep localStorage only as startup cache, with explicit hydration/sync rules.

2. **Project-scope localStorage keys for project-specific UX state**
   - Scope at least: `kb-dashboard-task-view`, list settings (`columns`, `hide-done`, `collapsed`, `selected-tasks`), drafts, terminal tabs, agent hierarchy.
   - Preserve unscoped behavior only for truly global prefs (e.g., appearance if desired).

3. **Fix settings key parity drift (`*_SETTINGS_KEYS` vs interfaces)**
   - Add tests to fail when interface keys and key arrays diverge.
   - Prevent accidental mis-scoping and patch filtering anomalies.

### P1 — Medium impact

4. **Reduce persisted identity payloads**
   - Store only `projectId` for current project selection, not full object/path.

5. **Rework terminal tab persistence model**
   - Prefer server-managed tab/session restoration or at minimum short-lived, project-scoped client persistence with cleanup/versioning.

6. **Adjust selected-task persistence strategy**
   - Move selection to memory/session scope or project-scoped key with validation on project switch.

### P2 — Lower effort / UX polish

7. **Optional server-backed draft recovery**
   - Keep local fast drafts; add opt-in backend draft sync for cross-browser resilience.

8. **Clarify shared `fn-agent-view` semantics**
   - Either intentionally share and document, or split keys by surface.

9. **Complete FN-1201 workflow-step migration**
   - Keep as tracked in-progress storage hardening item.

---

## 7) Verification Checklist (for this audit)

- [x] All runtime localStorage keys in `packages/dashboard/app` cataloged
- [x] Theme dual-storage gap addressed
- [x] Current-project persistence behavior addressed
- [x] Planning/subtask/mission draft behavior addressed
- [x] ListView state scoping addressed
- [x] Terminal tab persistence addressed (`kb-terminal-tabs`)
- [x] QuickEntry expanded key addressed (`kb-quick-entry-expanded` legacy cleanup)
- [x] Agent hierarchy expand state addressed (`fn-agent-tree-expanded`)
- [x] Backend settings + API route inventory included
- [x] SQLite table inventory included
- [x] Known in-progress FN-1201 called out

## Legacy per-worktree SQLite DB hydration (historical)

The following section documents the retired SQLite runtime. PostgreSQL-backed worktrees do not create or hydrate authoritative `fusion.db` files.

Each git worktree has its own gitignored `.fusion/` directory, so `.fusion/fusion.db` is local scratch state per worktree. That isolation created a cross-task lookup gap: executor prompts that query sibling/dependency rows directly from the worktree DB could see empty results. FN-3840 documented the manual `ATTACH`/`INSERT OR REPLACE` recovery, and FN-3832 was the breaking case that surfaced this in production.

Fusion now auto-hydrates the worktree DB during executor startup at three points:
- after fresh worktree creation (including init/setup commands),
- after pooled worktree acquire/reassignment,
- when reusing an existing on-disk worktree for resume.

Hydration copies only:
- current task row,
- transitive dependency task rows (BFS, depth cap 5, max 50 unique task IDs),
- `task_documents` rows for that same task-id set,
- task-scoped `artifacts` metadata rows for that same task-id set.

Implementation uses in-process SQLite streaming (`DatabaseSync`), source-side `SELECT`, destination-side `INSERT OR REPLACE` inside a destination transaction. Column lists are built from source/destination schema intersection (`PRAGMA table_info`), so schema drift degrades gracefully (dropped columns are logged once, and defaults apply on destination-only columns).

Example shape of the destination write:

```sql
INSERT OR REPLACE INTO tasks (<shared-columns...>) VALUES (<placeholders...>);
INSERT OR REPLACE INTO task_documents (<shared-columns...>) VALUES (<placeholders...>);
INSERT OR REPLACE INTO artifacts (<shared-columns...>) VALUES (<placeholders...>);
```

Expected executor log entry on success:

```text
Hydrated worktree DB: 4 tasks, 12 task_documents, 3 artifacts
```

A concrete recovered failure mode now covered by tests: when a worktree directory exists but its local `.fusion/` scratch state is missing, opening `DatabaseSync(<worktree>/.fusion/fusion.db)` can fail with `unable to open database file`. Hydration now performs destination bootstrap (`mkdir -p .fusion` + schema init) and retries the destination open once before degrading.

Failure policy remains strict non-blocking for genuinely unrecoverable cases: hydration warnings are logged, but worktree creation/execution continues. Examples that still intentionally degrade include source DB missing, destination write-permission failures, and irreconcilable schema/open errors after bootstrap retry. Canonical task data remains the root project TaskStore DB; if an agent needs non-hydrated rows immediately, `fn_task_show` remains the canonical fallback path.

## Silent board-mutation write loss (FN-7730)

**Symptom:** board mutations issued through `fn_task_update` (and other pi-extension write
tools invoked from an executor agent session) appeared to succeed, but the change was never
visible on the project-root `.fusion/fusion.db` that the engine and dashboard read from — with
no error surfaced on any write path.

**Root cause — a DB-path resolution mismatch, not a WAL/durability defect.** Investigation
(see task FN-7730's `research` document for the full trace) disproved the WAL `-shm`-unavailable
and uncheckpointed-WAL/`.recover` hypotheses on a normally-writable POSIX filesystem: both
failure conditions were reproduced directly and confirmed to throw a loud SQLite error rather
than silently drop data with the `node:sqlite` bindings and `sqlite3` CLI version this repo
requires. The real defect was in **project-root resolution** for pi-extension tool calls
(`packages/cli/src/extension.ts`'s `resolveProjectRoot(cwd)` → `getProjectRootFromWorktree`
in `packages/core/src/pi-extensions.ts`):

1. `getProjectRootFromWorktree` matches the standard `.worktrees/<id>` and
 `.fusion/worktrees/<id>` path shapes via hardcoded regex. A project with a non-default
 `settings.worktreesDir` (an arbitrary relative/absolute location — common in containerized
 deployments) doesn't match either pattern.
2. The only remaining resolution path, `getProjectRootFromGitLinkedWorktree`, shelled out to
 `git rev-parse --git-common-dir`/`--git-dir` via `spawnSync`. A failing `git` invocation —
 missing binary in a minimal container image, Docker's "detected dubious ownership"
 `safe.directory` refusal on a bind-mounted repo owned by a different UID, or any other
 non-zero exit — returned `null` with **no thrown error** (by design, so a non-worktree `cwd`
 doesn't explode), but with no non-git fallback.
3. `resolveProjectRoot`'s caller then fell back to a naive upward walk for the nearest ancestor
 with a `.fusion` directory. Because the task's own worktree already has a locally-hydrated
 `.fusion/fusion.db` (see "Per-Worktree DB Hydration" above), the walk matched **immediately**
 at the worktree itself, never reaching the true project root.
4. Every subsequent write tool call for that agent session then silently landed in the
 throwaway, one-way-hydrated worktree-local `fusion.db` — never synced back to the project
 root — with zero error surfaced.

**Fix:** `getProjectRootFromGitLinkedWorktree` now resolves the linked-worktree relationship
directly from git's own on-disk metadata first — the worktree's `.git` file (`gitdir: <path>`)
plus its `commondir` sidecar, the same contract `git worktree add` writes — via plain
filesystem reads. This has **no subprocess dependency and is unaffected by the `git` binary's
availability or Docker UID/`safe.directory` permission checks**. The `git rev-parse` CLI path is
kept as a secondary fallback for any layout the filesystem parser can't resolve, preserving
prior behavior for those edge cases.

**Operator guidance:** if you suspect a write went to the wrong file, confirm which path a tool
session resolves by checking `.fusion/fusion.db` for a `mtime` change immediately after the
write in both the project root and (if applicable) the task's worktree directory. A
non-standard `settings.worktreesDir` combined with a broken `git` CLI in the execution
environment (missing binary, or `git config --global --add safe.directory '*'` not set for a
bind-mounted repo owned by a different UID) was the confirmed trigger; setting
`safe.directory` correctly or installing `git` resolves the underlying condition even without
this fix, and this fix additionally removes the dependency on that condition being addressed.
There is no data-recovery step needed once the resolver is fixed — no rows were corrupted, they
were written to (and remain recoverable from) the worktree-local `.fusion/fusion.db` if it still
exists on disk.
