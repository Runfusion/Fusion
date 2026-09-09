import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
/* FNXC:RunAudit 2026-08-20-05:49: FN-9177 bounds optional audit telemetry so a hostile sink cannot alter this lifecycle path. */
/**
 * lifecycle-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS, WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX} from "../store.js";
import {planLegacyAdoption} from "../db/legacy-adoption.js";
import {and, eq, sql} from "drizzle-orm";
import {
  MIGRATION_BOOKKEEPING_TABLE,
  LEGACY_ADOPTION_DRAINED_MARKER,
  LEGACY_ADOPTION_DRAINED_MARKER_FUNCTION,
} from "../postgres/schema-applier.js";
import {mkdir, readdir, readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import {existsSync, type Dirent} from "node:fs";
import type {Task, AgentLogEntry, GlobalSettings} from "../types.js";
import {MOVED_SETTINGS_KEYS, SETTINGS_MIGRATION_VERSION, SETTINGS_MIGRATION_MARKER_KEY} from "../config/moved-settings.js";
import {stepsToWorkflowIr, stepToFragmentIr, layoutForIr} from "../workflows/workflow-steps-to-ir.js";
import {getTraitRegistry} from "../workflows/trait-registry.js";
import {registerDefaultWorkflowHooks} from "../workflows/default-workflow-hooks.js";
import {clearTransitionPending, readTransitionPending, reconcileHooksRemaining} from "../tasks/transition-pending.js";
import {clearTransitionPendingAsync, listTransitionPendingTaskIdsAsync, readTransitionPendingAsync} from "./async/async-transition-pending.js";
import type {WorkflowSettingDefinition} from "../workflows/workflow-ir-types.js";
import {validateSettingValuePatch} from "../workflows/workflow-settings.js";
import "../builtin-traits.js";
import {appendAgentLogEntriesSync} from "../agents/agent-log-file-store.js";
import {getErrorMessage} from "../process/error-message.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {reconcileTaskIdStateAsync} from "../task-store/async/async-allocator.js";
import {ACTIVE_TASK_FILTER, insertTaskRowInTransaction, isTaskIdConflictError as isPgTaskIdConflictError, readTaskRow} from "./async/async-persistence.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import {recordRunAuditEventWithinTransaction} from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import {diffSettingsForActivity, formatSettingsActivity} from "./settings-activity.js";
import {LIFECYCLE_ROLE_RANK} from "../workflows/workflow-lifecycle-direction.js";

export async function initImpl(store: TaskStore, options?: { skipArchiveReintegration?: boolean }): Promise<void> {
    store.closing = false;
    await mkdir(store.tasksDir, { recursive: true });

    // U4: register the default-workflow trait hook implementations into the
    // shared trait registry (the flag-ON moveTaskInternal path resolves the
    // legacy per-column effects through these). Idempotent; built-in trait
    // DEFINITIONS self-register on import of ./builtin-traits.js (pulled in
    // transitively via default-workflow-hooks / trait-registry).
    registerDefaultWorkflowHooks();

    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-13:50:
    TaskStore.init is PostgreSQL-only. The former non-backend SQLite corruption-guard / legacy-migration / schema-version init tail is deleted. Production always injects AsyncDataLayer; schema baseline is applied by the startup factory before constructing the store.

    FNXC:RuntimePersistenceAsync 2026-06-24-10:32:
    Run async allocator reconciliation so sequences are bumped to the high-water mark on store open (VAL-DATA-007/008). Soft-deleted/archived IDs stay reserved because the reconciliation scans them.
    */
    try {
      await reconcileTaskIdStateAsync(store.asyncLayer!);
      store.taskIdStateReconciled = true;
    } catch (error) {
      storeLog.warn("Async allocator reconciliation failed during backend init", {
        phase: "init:async-allocator-reconcile",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    /*
    FNXC:LegacyAdoption 2026-07-19-05:10 (U9b / R10 / KTD-8):
    Store-open legacy adoption must run HERE, not only in the SQLite tail below — backend
    mode returns early, and backend mode is production. Placing the call only after this
    return would make it dead code exactly where pre-cutover rows actually live. Uses the
    async store API (listTasks/updateTask), so it is PG-safe.
    */
    await adoptLegacyTaskRowsOnOpen(store);
    /*
    FNXC:TaskArchiveReintegration 2026-09-06-08:00:
    Legacy status adoption must finish before the cooperative archive drain. Run the same idempotent
    primitive here as engine maintenance so dashboard-only and CLI hosts expose every eligible
    completed task before later completion-column consumers run.
    */
    try {
      if (!options?.skipArchiveReintegration) await store.reconcileArchivedTasksIntoDone();
    } catch (error) {
      storeLog.warn("Archived task reintegration failed during backend init", {
        phase: "init:archive-reintegration",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    /*
    FNXC:PatchnodeLedger 2026-08-28-12:16:
    Store-open reconciliation is a warn-degraded backlog convenience, not the live durability guarantee. Init runs once per process; completion writers capture in their own transactions, while the TTL-rearmed read path revisits surviving legacy evidence.
    */
    try {
      await store.reconcilePatchnodeLedger({ force: true });
    } catch (error) {
      storeLog.warn("Patchnode reconciliation failed during backend init", {
        phase: "init:patchnode-reconcile",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Lifecycle listeners are backend-agnostic: recordActivity() routes their
    // best-effort writes through the injected PostgreSQL data layer.
    store.setupActivityLogListeners();
    return;
}

/*
FNXC:LegacyAdoption 2026-07-19-05:00 (U9b / R10 / KTD-8):
Store-open legacy adoption — the SECOND consumer of the KTD-8 adoption table, sharing
`planLegacyAdoption` with self-healing's startup sweep so the two cannot disagree about
what a legacy row means.

Why both: the self-healing sweep only runs where the ENGINE runs. A store opened without
it (CLI commands, dashboard-only serve, embedded/test hosts) would otherwise leave
pre-cutover rows carrying a legacy `task.status` whose writer the cutover deleted — frozen
exactly as R10 forbids. Running in both places is safe because `legacyAdoptedAt` makes
adoption idempotent: whichever opens first adopts, the other skips.

Deliberately NOT audited here. Run-audit emission at store-open would have to go through
the sync SQLite row-insert path, which is one of the masked no-op sites under PG mode; the
engine sweep is the audited path. Adoption is logged instead, and a failure is warned and
swallowed — a store must still open when adoption cannot run.

FNXC:LegacyAdoption 2026-07-19-09:00 (PR #2335 review):
The sweep PAGINATES until the active census is drained instead of scanning only the newest
500 rows. `listTasks` orders by (created_at, id), which recency ordering means a capped
single fetch would re-read the same newest page on every open and strand older legacy rows
forever. Offset pagination is stable here: adoption patches never change created_at and
adopted rows stay in the active list, so page boundaries do not shift mid-drain. Each page
stays bounded (500) so store open never materializes the whole table at once.

FNXC:LegacyAdoption 2026-07-19-14:30 (PR #2341 review):
Completion short-circuit. Without one, the full active-census scan runs on EVERY store open
forever — a permanent startup cost scaling with total task count, not the shrinking legacy
backlog. After a full drain in which NO row produced a mutating adoption plan, a durable
NON-NUMERIC marker row (LEGACY_ADOPTION_DRAINED_MARKER) is recorded in the
fusion_schema_migrations bookkeeping table (INSERT ... ON CONFLICT DO NOTHING) and checked
before sweeping on later opens. Non-numeric is deliberate: assertBinaryNotOlderThanDatabase
ignores unparseable version identifiers by design (coupling documented at both sites).
Safety rules:
- Any mutating plan during a sweep (including one withheld only by userPaused) withholds
  the marker that cycle — rows may still be arriving from an old binary (unlikely under the
  stale-binary guard, but the check is cheap), and a paused legacy row must stay adoptable
  after the operator unpauses.
- A failed marker READ falls back to sweeping (fail-open toward correctness); a failed
  marker WRITE is warned and swallowed (the next clean drain retries).
- SQLite (non-backend) mode has no bookkeeping table → no marker, sweep always runs.
*/
/*
FNXC:LegacyAdoption 2026-07-22-10:30:
#2387's Drizzle wrapper says only "Failed query" while PostgreSQL puts the
actionable SQLSTATE on a nested cause. Preserve that chain in the diagnostic and
only report permanent marker infrastructure classes once per process: a CLI
process may open many stores, but repeated permission-denied spam hides real
startup failures. Read failures still fail open to preserve adoption correctness.
*/
const reportedLegacyAdoptionMarkerFailureClasses = new Set<string>();
const PERMANENT_LEGACY_ADOPTION_MARKER_SQLSTATES = new Set(["42501", "42P01", "42883", "3F000"]);

type StoreOpenDbError = {cause?: unknown; code?: unknown; message?: unknown};

function getStoreOpenDbErrorSqlstate(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    if (typeof current !== "object") break;
    const candidate = current as StoreOpenDbError;
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function describeStoreOpenDbError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    const candidate = typeof current === "object" ? current as StoreOpenDbError : undefined;
    const message = current instanceof Error
      ? current.message
      : typeof candidate?.message === "string" ? candidate.message : String(current);
    const sqlstate = typeof candidate?.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)
      ? ` [SQLSTATE ${candidate.code}]`
      : "";
    parts.push(`${message.length > 400 ? `${message.slice(0, 200)} … ${message.slice(-120)}` : message}${sqlstate}`);
    current = candidate?.cause;
  }
  return parts.join(" ⇐ ");
}

function reportLegacyAdoptionMarkerFailure(operation: "read" | "write", error: unknown): void {
  const sqlstate = getStoreOpenDbErrorSqlstate(error);
  if (sqlstate && PERMANENT_LEGACY_ADOPTION_MARKER_SQLSTATES.has(sqlstate)) {
    const sqlstateClass = sqlstate.slice(0, 2);
    if (reportedLegacyAdoptionMarkerFailureClasses.has(sqlstateClass)) return;
    reportedLegacyAdoptionMarkerFailureClasses.add(sqlstateClass);
    storeLog.error("Legacy-adoption drained-marker infrastructure is unavailable; sweeping will continue", {
      phase: "init:legacy-adoption",
      operation,
      sqlstate,
      sqlstateClass,
      error: describeStoreOpenDbError(error),
      hint: "Apply schema baseline 0032+ and verify fusion_runtime has public schema USAGE, bookkeeping SELECT, and marker-helper EXECUTE.",
    });
    return;
  }
  storeLog.warn(`Legacy-adoption drained-marker ${operation} failed${operation === "read" ? " — sweeping anyway" : ""}`, {
    phase: "init:legacy-adoption",
    error: describeStoreOpenDbError(error),
  });
}

async function hasLegacyAdoptionDrainedMarker(store: TaskStore): Promise<boolean> {
  const db = store.asyncLayer?.db;
  if (!db) return false;
  try {
    const rows = (await db.execute(
      sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`,
    )) as unknown as unknown[];
    return rows.length > 0;
  } catch (error) {
    // Fail-open toward correctness: an unreadable marker means sweep.
    reportLegacyAdoptionMarkerFailure("read", error);
    return false;
  }
}

async function writeLegacyAdoptionDrainedMarker(store: TaskStore): Promise<void> {
  const db = store.asyncLayer?.db;
  if (!db) return;
  try {
    /*
    FNXC:LegacyAdoption 2026-07-21-17:30:
    Call the SECURITY DEFINER helper (migration 0032) instead of a raw INSERT.
    fusion_runtime has EXECUTE on the function but not unrestricted INSERT on
    fusion_schema_migrations, so it cannot stamp arbitrary migration versions.
    */
    await db.execute(sql`SELECT public.${sql.identifier(LEGACY_ADOPTION_DRAINED_MARKER_FUNCTION)}()`);
  } catch (error) {
    // Non-fatal: the next fully-clean drain writes it again.
    reportLegacyAdoptionMarkerFailure("write", error);
  }
}

export async function adoptLegacyTaskRowsOnOpen(store: TaskStore): Promise<number> {
  try {
    if (await hasLegacyAdoptionDrainedMarker(store)) return 0;
    const now = new Date().toISOString();
    const pageSize = 500;
    let offset = 0;
    let adopted = 0;
    let mutationPlanned = false;
    for (;;) {
      const tasks = await store.listTasks({ slim: true, includeArchived: false, limit: pageSize, offset });
      for (const task of tasks) {
        const plan = planLegacyAdoption(
          {
            status: task.status,
            column: task.column,
            reviewLevel: task.reviewLevel,
            enabledWorkflowSteps: task.enabledWorkflowSteps,
            legacyAdoptedAt: task.legacyAdoptedAt,
          },
          now,
        );
        if (plan.action === "skip" || !plan.patch) continue;
        // A mutating plan — applied or userPaused-withheld — blocks the drained
        // marker this cycle (see FNXC note above).
        mutationPlanned = true;
        if (task.userPaused === true) continue;
        try {
          await store.updateTask(task.id, plan.patch);
          adopted += 1;
        } catch (error) {
          storeLog.warn("Legacy adoption failed for task during store open", {
            phase: "init:legacy-adoption",
            taskId: task.id,
            action: plan.action,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (tasks.length < pageSize) break;
      offset += tasks.length;
    }
    if (adopted > 0) {
      storeLog.log?.(`Legacy adoption adopted ${adopted} pre-cutover row(s) at store open`);
    }
    if (!mutationPlanned) {
      await writeLegacyAdoptionDrainedMarker(store);
    }
    return adopted;
  } catch (error) {
    storeLog.warn("Legacy adoption pass failed during store open", {
      phase: "init:legacy-adoption",
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export function setupActivityLogListenersImpl(store: TaskStore): void {
    if (store.activityListenersWired) return;
    store.activityListenersWired = true;

    // Task created
    store.on("task:created", (task) => {
      store.recordActivityFromListener(
        {
          type: "task:created",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} created${task.title ? `: ${task.title}` : ""}`,
        },
        "task:created",
      );
    });

    // Task moved
    store.on("task:moved", (data) => {
      if (data.from === data.to) return;
      const roles = Object.keys(LIFECYCLE_ROLE_RANK) as Array<keyof typeof LIFECYCLE_ROLE_RANK>;
      const fromRole = roles.find((role) => data.lanes?.[role] === data.from);
      const toRole = roles.find((role) => data.lanes?.[role] === data.to);
      const direction = !fromRole || !toRole
        ? "unclassified"
        : LIFECYCLE_ROLE_RANK[toRole] > LIFECYCLE_ROLE_RANK[fromRole]
          ? "forward"
          : LIFECYCLE_ROLE_RANK[toRole] < LIFECYCLE_ROLE_RANK[fromRole]
            ? "backward"
            : "lateral";
      store.recordActivityFromListener(
        {
          type: "task:moved",
          taskId: data.task.id,
          taskTitle: data.task.title,
          details: `Task ${data.task.id} moved: ${data.from} → ${data.to} (${direction})`,
          metadata: {
            from: data.from,
            to: data.to,
            direction,
            source: data.source,
            ...(data.lifecycleReason ? { lifecycleReason: data.lifecycleReason } : {}),
          },
        },
        "task:moved",
      );
    });

    // Task merged
    store.on("task:merged", (result) => {
      const status = result.merged ? "successfully merged" : "merge attempted";
      store.recordActivityFromListener(
        {
          type: "task:merged",
          taskId: result.task.id,
          taskTitle: result.task.title,
          details: `Task ${result.task.id} ${status} to main`,
          metadata: { merged: result.merged, branch: result.branch },
        },
        "task:merged",
      );
    });

    /*
    FNXC:ActivityLogFailureDedup 2026-08-19-19:33:
    A failed-state bookkeeping update is not a new durable failure episode. Only the serialized
    non-failed → failed transition from updateTask may append task:failed activity, so listeners
    cannot turn subsequent task mutations into an unbounded project.activity_log write path.
    */
    store.on("task:updated", (task, meta) => {
      if (meta?.failedTransition) {
        store.recordActivityFromListener(
          {
            type: "task:failed",
            taskId: task.id,
            taskTitle: task.title,
            details: `Task ${task.id} failed${task.error ? `: ${task.error}` : ""}`,
            metadata: task.error ? { error: task.error } : undefined,
          },
          "task:updated",
        );
      }
    });

    /*
    FNXC:SettingsAuditTrail 2026-08-09-02:05:
    Keep settings activity policy in settings-activity.ts so every settings:updated emitter
    gets one safe, generic diff without reintroducing a partial listener allowlist.
    */
    store.on("settings:updated", (data) => {
      try {
        const activity = formatSettingsActivity(diffSettingsForActivity(data.previous, data.settings));
        if (activity) {
          store.recordActivityFromListener(
            { type: "settings:updated", details: activity.details, metadata: activity.metadata },
            "settings:updated",
          );
        }
      } catch (error) {
        storeLog.warn("Failed to format settings activity", { error: getErrorMessage(error) });
      }
    });

    // Task deleted
    store.on("task:deleted", (task, meta) => {
      /*
      FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
      Observed outbox replay is intentionally at-least-once. Activity is writer-owned and
      accumulating, so observed events must not create a duplicate activity/audit side effect.
      Cache eviction and bridge fan-out remain safe for duplicate observed notifications.
      */
      if (meta?.observed) return;
      store.recordActivityFromListener(
        {
          type: "task:deleted",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} deleted${task.title ? `: ${task.title}` : ""}`,
        },
        "task:deleted",
      );
    });
  }

export async function reconcileOrphanedTaskDirsImpl(store: TaskStore, opts: { ignoreRecencyWindow?: boolean } = {},): Promise<{ recovered: string[]; skipped: Array<{ id: string; reason: string }> }> {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:45:
    PostgreSQL path: scan task.json dirs and re-insert missing IDs via insertTaskRow
    after taskIdExistsAnywhere (live + archive). Same recency/empty-board gates as
    the SQLite path; previously backendMode returned empty and never recovered.
    */
    const result: { recovered: string[]; skipped: Array<{ id: string; reason: string }> } = {
      recovered: [],
      skipped: [],
    };

    // FNXC:SqliteRemoval 2026-06-25-18:30: inMemoryDb removed, always disk-backed.
    if (!existsSync(store.tasksDir)) {
      return result;
    }

    // The recency window stops legacy hard-deleted dirs (no tombstone) from being silently
    // resurrected onto a populated board. But the sweep's other job is recovering rows lost to
    // DB corruption or a restore-from-old-backup — where the surviving task.json files keep
    // their original (often >7-day-old) mtimes and the DB is empty. Detect that case: when the
    // live task table is empty, bypass the recency gate so corruption recovery isn't defeated by
    // the same guard added to stop resurrection. Callers may also force the bypass explicitly.
    let dbHasLiveTasks = true;
    try {
            const layer = store.asyncLayer!;
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      Empty-board probe must be project-scoped; another project's live rows must not keep this project's recency window closed.
      */
      const probeConds = [ACTIVE_TASK_FILTER];
      if (layer.projectId) probeConds.push(eq(schema.project.tasks.projectId, layer.projectId));
      const rows = await layer.db
        .select({ id: schema.project.tasks.id })
        .from(schema.project.tasks)
        .where(and(...probeConds))
        .limit(1);
      dbHasLiveTasks = rows.length > 0;

    } catch {
      // If the count probe fails, keep the gate on (conservative — don't mass-resurrect).
      dbHasLiveTasks = true;
    }
    const applyRecencyWindow = !opts.ignoreRecencyWindow && dbHasLiveTasks;

    let entries: Dirent[];
    try {
      entries = await readdir(store.tasksDir, { withFileTypes: true });
    } catch (error) {
      storeLog.warn("Skipping orphaned task-dir reconcile because tasksDir is unreadable", {
        phase: "reconcileOrphanedTaskDirs:scan",
        tasksDir: store.tasksDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const taskDir = join(store.tasksDir, id);
      const taskJsonPath = join(taskDir, "task.json");
      if (!existsSync(taskJsonPath)) {
        result.skipped.push({ id, reason: "missing-task-json" });
        continue;
      }

      // FN: recency gate. This sweep exists to recover task dirs that "appear after
      // store init" — heartbeat-created dirs that race startup, or rows lost to a
      // recent DB corruption while their task.json survived on disk. It must NOT
      // resurrect *ancient* deleted-task dirs that merely lingered on disk: modern
      // deletes leave a soft-delete tombstone (taskIdExistsAnywhere catches those),
      // but legacy hard-deletes left no tombstone, so a months-old task.json with no
      // DB row would otherwise be silently re-imported onto the live board (the
      // "all task IDs reset / starting over" failure). Only reconcile dirs whose
      // task.json was modified within the recency window; older orphans are left for
      // explicit recovery (unarchive/restore) or directory cleanup. Skipped entirely when
      // the DB is empty / a caller forces recovery (corruption/restore path — see above).
      if (applyRecencyWindow) {
        try {
          const { mtimeMs } = await stat(taskJsonPath);
          const ageMs = Date.now() - mtimeMs;
          if (ageMs > RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS) {
            result.skipped.push({ id, reason: "stale-orphan-dir-beyond-recency-window" });
            /*
            FNXC:Diagnostics 2026-07-31-00:50 (operator report — warn spam):
            This skip is STEADY-STATE: a months-old orphan dir (e.g. a pre-tombstone hard-delete
            leftover) trips it on EVERY maintenance sweep, forever, until someone deletes the dir.
            Per the self-healing logging policy (self-healing.ts header), per-sweep
            no-action/skip lines are debug (FUSION_DEBUG=task-store), not warn — warn is for real
            recoveries and failures. The skip stays visible in the sweep's returned `skipped`
            summary either way.
            */
            storeLog.debug("Skipping stale orphaned task-dir reconcile (beyond recency window)", {
              phase: "reconcileOrphanedTaskDirs:recency",
              taskId: id,
              taskJsonPath,
              ageMs,
              maxAgeMs: RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS,
            });
            continue;
          }
        } catch (error) {
          result.skipped.push({ id, reason: `stat-failed: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
      }

      let task: Task;
      try {
        const raw = await readFile(taskJsonPath, "utf-8");
        task = store.normalizeTaskFromDisk(JSON.parse(raw) as Task);
      } catch (error) {
        const reason = `malformed-task-json: ${error instanceof Error ? error.message : String(error)}`;
        result.skipped.push({ id, reason });
        storeLog.warn("Skipping malformed task.json during orphaned task-dir reconcile", {
          phase: "reconcileOrphanedTaskDirs:parse",
          taskId: id,
          taskJsonPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const malformedReason = store.getMalformedTaskMetadataReason(task, id);
      if (malformedReason) {
        result.skipped.push({ id, reason: `malformed-task-metadata: ${malformedReason}` });
        storeLog.warn("Skipping malformed task metadata during orphaned task-dir reconcile", {
          phase: "reconcileOrphanedTaskDirs:validate",
          taskId: id,
          taskJsonPath,
          reason: malformedReason,
        });
        continue;
      }

      let recovered = false;
      let skipReason: string | undefined;
      try {
                if (await store.taskIdExistsAnywhere(id)) {
          skipReason = "id-exists-anywhere";
        } else {
          try {
            /*
            FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
            Orphan recovery insert + audit share one transaction (parity with the removed SQLite transactionImmediate wrap) so a failed audit cannot leave an unaudited recovered row.
            */
            const layer = store.asyncLayer!;
            const context = store.createTaskPersistSerializationContext(task);
            await layer.transactionImmediate(async (tx) => {
              await insertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);
              /*
              FNXC:SqliteDualPathCleanup 2026-07-26-15:10:
              Run-audit metadata stays ids/outcomes-only — do not persist taskJsonPath (filesystem path). Path remains on the transient storeLog lines around this recovery.
              */
              await recordRunAuditEventWithinTransaction(tx, {
                taskId: id,
                agentId: "system",
                runId: "unknown",
                domain: "database",
                mutationType: "task:reconcile-orphaned-task-dir",
                target: id,
                metadata: {
                  id,
                  column: task.column,
                  status: task.status ?? null,
                },
              });
            });
            recovered = true;
          } catch (error) {
            if (isPgTaskIdConflictError(error) || /Task ID already exists/i.test(error instanceof Error ? error.message : String(error))) {
              skipReason = "id-conflict-during-insert";
            } else {
              throw error;
            }
          }
        }

      } catch (error) {
        const reason = `insert-failed: ${error instanceof Error ? error.message : String(error)}`;
        result.skipped.push({ id, reason });
        storeLog.warn("Skipping orphaned task-dir reconcile insert after non-fatal error", {
          phase: "reconcileOrphanedTaskDirs:insert",
          taskId: id,
          taskJsonPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (recovered) {
        result.recovered.push(id);
        if (store.isWatching) store.taskCache.set(id, { ...task });
        storeLog.warn("Recovered orphaned task.json into task index", {
          phase: "reconcileOrphanedTaskDirs:recovered",
          taskId: id,
          column: task.column,
          status: task.status,
          taskJsonPath,
          backend: store.backendMode ? "postgres" : "sqlite",
        });
        store.emitTaskLifecycleEventSafely("task:created", [task]);
      } else {
        result.skipped.push({ id, reason: skipReason ?? "not-recovered" });
      }
    }

    return result;
  }

export async function watchImpl(store: TaskStore): Promise<void> {
    if (store.watcher) return; // already watching
    store.clearStartupSlimListMemo();

    /*
     * FNXC:TaskDeletedObservation 2026-08-01-09:59:
     * PostgreSQL has no cross-process `task:deleted` observer today. FN-8683 removed the
     * unreachable SQLite poller because `store.db` always throws for AsyncDataLayer stores;
     * cache warming below is the only supported watch behavior. The transactional-outbox design is
     * documented in docs/solutions/architecture/postgres-cross-process-task-deleted-observation.md.
     * FN-8684 owns the transactional writer and FN-8685 owns durable consumer delivery; do not
     * reintroduce a local polling replica as a substitute for their cursor/replay contract.
     */
    const tasks = await store.listTasks({ slim: true, startupMemo: false });
    store.taskCache.clear();
    for (const task of tasks) {
      store.taskCache.set(task.id, { ...task });
    }
    // Cache must be populated before observed deletes can safely evict local task state.
    await store.startTaskDeletedOutboxConsumer();
}

export async function migrateAgentLogEntriesImpl(store: TaskStore): Promise<void> {
    const migrationKey = "agentLogEntriesToFileMigrationVersion";
    const migrationVersion = "1";
    const row = store.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    // Only run if the agentLogEntries table still exists
    const hasTable =
      store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1").get() !==
      undefined;
    if (!hasTable) {
      // Table already gone (fresh DB or already migrated) — mark done
      store.db.prepare(`
        INSERT INTO __meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(migrationKey, migrationVersion);
      return;
    }

    interface AgentLogRow {
      id: number;
      taskId: string;
      timestamp: string;
      text: string;
      type: string;
      detail: string | null;
      agent: string | null;
    }

    // Read all rows ordered by taskId, id so each task's entries are
    // written in their original insertion order
    const rows = store.db
      .prepare("SELECT id, taskId, timestamp, text, type, detail, agent FROM agentLogEntries ORDER BY taskId, id")
      .all() as AgentLogRow[];

    if (rows.length > 0) {
      // Group rows by task
      const entriesByTask = new Map<string, AgentLogRow[]>();
      for (const row of rows) {
        let taskRows = entriesByTask.get(row.taskId);
        if (!taskRows) {
          taskRows = [];
          entriesByTask.set(row.taskId, taskRows);
        }
        taskRows.push(row);
      }

      // Write per-task JSONL files
      const rowIdToNewRef = new Map<number, string>();
      for (const [taskId, taskRows] of entriesByTask) {
        const td = store.taskDir(taskId);
        const appended = appendAgentLogEntriesSync(
          td,
          taskRows.map((r) => ({
            timestamp: r.timestamp,
            taskId: r.taskId,
            text: r.text,
            type: r.type as AgentLogEntry["type"],
            detail: r.detail,
            agent: r.agent as AgentLogEntry["agent"] | null,
          })),
        );
        // Build mapping from old rowid to new sourceRef
        for (let i = 0; i < taskRows.length; i++) {
          rowIdToNewRef.set(taskRows[i]!.id, appended[i]!.sourceRef);
        }
      }

      // Rewrite goal-citation source-refs that use the old agentLog:<rowid> format
      const oldFormatRows = store.db
        .prepare("SELECT id, sourceRef FROM goal_citations WHERE surface = 'agent_log' AND sourceRef GLOB 'agentLog:[0-9]*'")
        .all() as Array<{ id: number; sourceRef: string }>;

      const updateStmt = store.db.prepare("UPDATE goal_citations SET sourceRef = ? WHERE id = ?");
      store.db.transaction(() => {
        for (const citation of oldFormatRows) {
          const oldRowId = parseInt(citation.sourceRef.replace("agentLog:", ""), 10);
          const newRef = rowIdToNewRef.get(oldRowId);
          if (newRef) {
            updateStmt.run(newRef, citation.id);
          }
        }
      });
    }

    // Mark migration as done
    store.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    store.db.bumpLastModified();
  }

export async function migrateMovedSettingsImpl(store: TaskStore): Promise<void> {
    const markerKey = SETTINGS_MIGRATION_MARKER_KEY;
    const markerRow = store.db.prepare("SELECT value FROM __meta WHERE key = ?").get(markerKey) as
      | { value: string }
      | undefined;
    if (markerRow && Number(markerRow.value) >= SETTINGS_MIGRATION_VERSION) {
      return;
    }

    const movedKeys = MOVED_SETTINGS_KEYS as readonly string[];
    const projectId = store.getWorkflowSettingsProjectId();

    // (1) Snapshot CUSTOMIZED moved keys from RAW persisted project + global stores.
    const rawProjectSettings = await store.readRawProjectSettings();
    let rawGlobalSettings: Record<string, unknown> = {};
    try {
      rawGlobalSettings = await store.globalSettingsStore.readRaw();
    } catch {
      rawGlobalSettings = {};
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of movedKeys) {
      // Project storage wins over global (moved keys are project-scoped); only
      // snapshot keys the user actually customized (present in raw storage).
      if (Object.prototype.hasOwnProperty.call(rawProjectSettings, key)) {
        snapshot[key] = rawProjectSettings[key];
      } else if (Object.prototype.hasOwnProperty.call(rawGlobalSettings, key)) {
        snapshot[key] = rawGlobalSettings[key];
      }
    }

    // (2) Compute the write-target workflow ids (shared with the U5 v1→v2
    //     import upgrade so both write to identical lanes).
    const targetWorkflowIds = await store.computeMovedSettingsTargetWorkflowIds();

    // (3) Validate the snapshot per target workflow (async declaration resolution
    //     done HERE, before the synchronous transaction). Drop-and-log invalid
    //     values; never abort. Empty accepted maps are fine (nothing to write).
    const acceptedByWorkflow = new Map<string, Record<string, unknown>>();
    if (Object.keys(snapshot).length > 0) {
      for (const workflowId of targetWorkflowIds) {
        let declarations: WorkflowSettingDefinition[] | undefined;
        try {
          declarations = await store.resolveWorkflowSettingDeclarations(workflowId);
        } catch {
          declarations = undefined;
        }
        const result = validateSettingValuePatch(declarations, snapshot);
        if (result.rejections.length > 0) {
          storeLog.warn("Dropped invalid moved-setting values during hard-move migration", {
            phase: "migrateMovedSettings:validate",
            workflowId,
            projectId,
            rejected: result.rejections.map((r) => `${r.settingId}:${r.code}`),
          });
        }
        acceptedByWorkflow.set(workflowId, result.accepted);
      }
    }

    // (4) ONE SQLite transaction: value upserts + raw project null-out + marker.
    const now = new Date().toISOString();
    store.db.transactionImmediate(() => {
      for (const [workflowId, accepted] of acceptedByWorkflow) {
        if (Object.keys(accepted).length === 0) continue;
        const current = store.getWorkflowSettingValues(workflowId, projectId);
        const next: Record<string, unknown> = { ...current };
        for (const [k, v] of Object.entries(accepted)) {
          if (v === null || v === undefined) {
            delete next[k];
          } else {
            next[k] = v;
          }
        }
        store.db
          .prepare(
            `INSERT INTO workflow_settings (workflowId, projectId, "values", updatedAt)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(workflowId, projectId)
             DO UPDATE SET "values" = excluded."values", updatedAt = excluded.updatedAt`,
          )
          .run(workflowId, projectId, JSON.stringify(next), now);
      }

      // Null the moved keys out of the raw project config.settings.
      const configRow = store.db.prepare("SELECT settings FROM config WHERE id = 1").get() as
        | { settings: string }
        | undefined;
      if (configRow) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = (JSON.parse(configRow.settings) as Record<string, unknown>) ?? {};
        } catch {
          parsed = {};
        }
        let changed = false;
        for (const key of movedKeys) {
          if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            delete parsed[key];
            changed = true;
          }
        }
        if (changed) {
          store.db
            .prepare("UPDATE config SET settings = ?, updatedAt = ? WHERE id = 1")
            .run(JSON.stringify(parsed), now);
        }
      }

      store.db.prepare(`
        INSERT INTO __meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(markerKey, String(SETTINGS_MIGRATION_VERSION));
      store.db.bumpLastModified();
    });

    // (5) Defensive: null the moved keys out of the global store (outside the txn).
    const globalMovedPatch: Record<string, unknown> = {};
    for (const key of movedKeys) {
      if (Object.prototype.hasOwnProperty.call(rawGlobalSettings, key)) {
        globalMovedPatch[key] = null; // null-as-delete
      }
    }
    if (Object.keys(globalMovedPatch).length > 0) {
      try {
        await store.globalSettingsStore.updateSettings(globalMovedPatch as Partial<GlobalSettings>);
      } catch (err) {
        storeLog.warn("Global moved-key null-out failed during hard-move migration (non-fatal)", {
          phase: "migrateMovedSettings:global-nullout",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Invalidate cached config so subsequent reads reflect the removed keys.
    store.invalidateConfigCacheAfterMigration();
  }

export async function recoverStaleTransitionPendingImpl(store: TaskStore): Promise<{ scanned: number; recovered: number; degradedHooks: number }> {
    let scanned = 0;
    let recovered = 0;
    let degradedHooks = 0;

    /*
     * FNXC:PostgresCutover 2026-07-10:
     * Backend-mode port (previously threw "SQLite Database is not available in
     * backend mode" on every startup/maintenance sweep). All marker reads and
     * clears route through the async Drizzle helpers; the hook-reconciliation
     * and re-run logic below is backend-agnostic.
     */
    const backend = store.backendMode ? store.asyncLayer!.db : null;
    const readMarker = async (taskId: string) =>
      backend ? readTransitionPendingAsync(backend, taskId) : readTransitionPending(store.db, taskId);
    const clearMarker = async (taskId: string) => {
      if (backend) {
        await clearTransitionPendingAsync(backend, taskId);
      } else {
        clearTransitionPending(store.db, taskId);
      }
    };

    const rows: Array<{ id: string }> = backend
      ? (await listTransitionPendingTaskIdsAsync(backend)).map((id) => ({ id }))
      : store.db
        .prepare(
          `SELECT id FROM tasks WHERE transitionPending IS NOT NULL AND transitionPending != '' AND deletedAt IS NULL`,
        )
        .all() as Array<{ id: string }>;

    // The set of hook ids the current process can still honor: the always-present
    // default-workflow post-commit marker plus every registered plugin trait's
    // onEnter/onExit hook. A marker entry not in this set belongs to an
    // uninstalled plugin and is dropped (audited) rather than re-run.
    const registry = getTraitRegistry();
    const knownHookIds = new Set<string>(["default-workflow:postCommit"]);
    for (const def of registry.listTraits()) {
      if (def.hooks?.onEnter) knownHookIds.add(`${def.id}:onEnter`);
      if (def.hooks?.onExit) knownHookIds.add(`${def.id}:onExit`);
    }

    for (const { id } of rows) {
      scanned += 1;
      const marker = await readMarker(id);
      // null = nothing pending (corrupt/empty marker degrades to settled); we
      // still clear the stored column so the slot is released. undefined = row
      // vanished mid-sweep — skip.
      if (marker === undefined) continue;

      await store.withTaskLock(id, async () => {
        // Re-read inside the lock: another path may have cleared it already.
        const live = await readMarker(id);
        if (live == null) {
          // Corrupt/empty marker — clear the stored value defensively so it stops
          // counting against capacity, then move on.
          if (live === null) {
            try {
              await clearMarker(id);
            } catch {
              // best-effort
            }
          }
          return;
        }

        const { hooksRemaining, warnings } = reconcileHooksRemaining(live.hooksRemaining, knownHookIds);
        degradedHooks += warnings.length;

        // Re-run the surviving idempotent post-commit hooks. The default-workflow
        // field effects already committed in-lock pre-crash, so the only work that
        // can still be owed is the plugin trait hook runner, which re-derives its
        // pending set from the resolved IR and is idempotent (KTD-2). We invoke it
        // only when a plugin hook entry survived (a marker carrying just
        // `default-workflow:postCommit` needs no re-run — just a clear).
        const hasSurvivingPluginHook = hooksRemaining.some((h) => h !== "default-workflow:postCommit");
        if (hasSurvivingPluginHook) {
          /*
          FNXC:PostgresCutover 2026-07-31-15:40 (DEADLOCK, introduced by the backend-mode port above):
          LOCK-FREE READ, and it must stay lock-free. This whole block runs inside
          `store.withTaskLock(id, ...)`, and the per-task lock is NON-REENTRANT — the same invariant
          `branch-and-pr-entities.ts` and `workflow-ops.ts` both state in prose. `store.getTask()`
          acquires that lock (`getTaskImpl` opens with `store.withTaskLock(id, ...)`), so reading
          through it here waits forever on a lock this very frame holds.

          The SQLite path on the line below never had the bug: `readTaskFromDb` is a lock-free row
          read. The port swapped it for `getTask` on the backend arm only, so the deadlock is
          PostgreSQL-only — which is every production install.

          Reachability is narrow but real, and it is exactly the state a crash leaves behind: the
          branch runs only when a stale marker names a plugin hook the registry still knows
          (`hasSurvivingPluginHook`). A marker with no plugin hook, or one naming an uninstalled
          plugin, takes the degraded path and never reaches here — which is why every existing test
          passes. This sweep runs at STARTUP, and it deadlocks while holding the task's lock, so the
          affected task is also left permanently unlockable.
          */
          const task = backend
            ? await readTaskRow(store.asyncLayer!, id).catch(() => null) as { column?: string } | null
            : store.readTaskFromDb(id, { includeDeleted: false });
          if (task) {
            /*
            FNXC:WorkflowLifecycleColumns 2026-07-31-18:40 (PR #2809 review — greptile P1):
            ASYNC RESOLVER, because the sync one cannot answer here. `resolveTaskWorkflowIrSync`
            returns the DEFAULT workflow IR for every task under PostgreSQL (its selection reader is
            a cutover stub that answers `undefined` unconditionally). The hook runner below derives
            its pending set from the columns of the IR it is handed, so with the default IR a task on
            a CUSTOM workflow matched no plugin trait and its interrupted hook was silently skipped —
            the recovery reported success having re-run nothing.

            Nothing forced the sync call: this frame is already `async`, and awaiting here does not
            reorder anything (the marker read above is awaited on the same path). The sync reader was
            simply the one the SQLite-era code had.

            This site is removed from the `resolveTaskWorkflowIrSync` call-site allow-list in the same
            change, so the two cannot drift.
            */
            const ir = await resolveWorkflowIrForTask(store, id);
            // fromColumn is unknown post-crash; the marker only records toColumn.
            // The hook runner keys onEnter off toColumn (and onExit off fromColumn);
            // re-running onEnter for the destination is the recoverable, idempotent
            // half. Use the task's current column as fromColumn (it committed to
            // toColumn at marker-write time, so current == toColumn and onExit is a
            // no-op, which is correct — we never re-fire an exit we may have run).
            try {
              await store.runPluginColumnTransitionHooks(id, ir, task.column as string, live.toColumn);
            } catch (err) {
              storeLog.warn("transitionPending recovery: hook re-run faulted (degraded)", {
                phase: "recover-stale-transition-pending",
                taskId: id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        for (const warning of warnings) {
          storeLog.warn(warning, {
            phase: "recover-stale-transition-pending",
            taskId: id,
          });
        }

        // Clear the marker — releases the reserved capacity slot.
        try {
          await clearMarker(id);
        } catch {
          // best-effort; a later sweep retries.
        }

        void emitBoundedRunAudit(store, {
          taskId: id,
          agentId: "system",
          runId: `transition-pending-recovery-${id}-${Date.now()}`,
          domain: "database",
          mutationType: "task:transition-pending-recovered",
          target: id,
          metadata: {
            toColumn: live.toColumn,
            hooksReran: hooksRemaining,
            droppedHooks: warnings.length,
            startedAt: live.startedAt,
          },
        });
        recovered += 1;
      });
    }

    if (recovered > 0 || degradedHooks > 0) {
      storeLog.log("transitionPending recovery sweep completed", {
        phase: "recover-stale-transition-pending",
        scanned,
        recovered,
        degradedHooks,
      });
    }
    return { scanned, recovered, degradedHooks };
  }

export async function migrateLegacyWorkflowStepsImpl(store: TaskStore): Promise<{ migrated: number; skipped: number; combinedWorkflowId?: string; }> {
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, BEHAVIOUR-PRESERVING):
    The workflow-columns flag read is DELETED. It was resolved here only to thread
    "flag-aware persistence" into `insertWorkflowDefinitionSync`, where it chose
    between the v2 shape and the pure-v1 downgrade. The flag is retired and always
    false, so the downgrade arm was always taken; it is now unconditional inside the
    insert and the parameter is gone. The project default is still re-read AFTER the
    transaction (compare-and-set) so a concurrently-set default is never clobbered.
    */

    const result = store.db.transactionImmediate(() => {
      // Write lock is now held. Read the raw step rows directly (the cached,
      // plugin-merged listWorkflowSteps() is not transaction-scoped). Mirror
      // listWorkflowSteps()'s compiled-materialized filter and toStoredWorkflowStep
      // mapping so policy decisions match the user-facing step listing.
      const rows = store.db
        .prepare("SELECT * FROM workflow_steps ORDER BY createdAt ASC")
        .all() as Array<Parameters<typeof store.toStoredWorkflowStep>[0]>;

      const userSteps = rows
        .map((row) => store.applyLegacyWorkflowStepOverrides(store.toStoredWorkflowStep(row)))
        // Compiled-materialized rows are an execution detail, not user-authored.
        .filter((step) => !step.templateId?.startsWith(WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX));

      const alreadyMigrated = userSteps.filter((s) => s.migratedFragmentId);
      const unmigrated = userSteps.filter((s) => !s.migratedFragmentId);

      if (unmigrated.length === 0) {
        return { migrated: 0, skipped: alreadyMigrated.length, combinedWorkflowId: undefined as string | undefined };
      }

      // Every unmigrated user step → a single-node fragment; stamp the source row.
      for (const step of unmigrated) {
        // parseWorkflowIr runs inside both insertWorkflowDefinitionSync and
        // layoutForIr, so compute the fragment IR once and reuse it.
        const fragmentIr = stepToFragmentIr(step);
        const fragment = store.insertWorkflowDefinitionSync(
          {
            name: step.name,
            description: step.description,
            kind: "fragment",
            ir: fragmentIr,
            layout: layoutForIr(fragmentIr),
          },
        );
        store.db
          .prepare("UPDATE workflow_steps SET migrated_fragment_id = ?, updatedAt = ? WHERE id = ?")
          .run(fragment.id, new Date().toISOString(), step.id);
      }
      store.workflowStepsCache = null;
      store.db.bumpLastModified();

      // The defaultOn subset → one combined "Migrated steps" workflow.
      const defaultOnSteps = unmigrated.filter((s) => s.defaultOn === true);
      let combinedWorkflowId: string | undefined;
      if (defaultOnSteps.length > 0) {
        const ir = stepsToWorkflowIr(defaultOnSteps, "Migrated steps");
        const combined = store.insertWorkflowDefinitionSync(
          {
            name: "Migrated steps",
            description: "Converted from your legacy workflow steps",
            kind: "workflow",
            ir,
            layout: layoutForIr(ir),
          },
        );
        combinedWorkflowId = combined.id;
      }

      return { migrated: unmigrated.length, skipped: alreadyMigrated.length, combinedWorkflowId };
    });

    // Set the combined workflow as the project default — only when one was
    // created AND no explicit default is already set (don't clobber a user
    // choice). Done outside the transaction via the async setter so the project
    // default-workflow hooks run. Compare-and-set against the CURRENT default
    // (re-read immediately before writing, not the pre-transaction snapshot) so
    // a default set concurrently by another writer is never overwritten. If the
    // set fails, swallow the error: a missing migrated default is recoverable
    // (the user can set one), but throwing here would surface the whole
    // migration as failed even though the definitions were written.
    if (result.combinedWorkflowId) {
      const currentDefaultId = await store.getDefaultWorkflowId();
      if (!currentDefaultId) {
        try {
          await store.setDefaultWorkflowId(result.combinedWorkflowId);
        } catch (err) {
          storeLog.warn("Failed to set migrated combined workflow as project default", {
            phase: "migrateLegacyWorkflowSteps:set-default",
            combinedWorkflowId: result.combinedWorkflowId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return result;
  }

/**
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Emit task lifecycle events safely, catching listener errors so one bad
 * listener doesn't break the store. Extracted from store.ts.
 */
export function emitTaskLifecycleEventSafelyImpl(
  store: TaskStore,
  event: "task:created" | "task:updated" | "task:deleted",
  args: Parameters<TaskStore["emitTaskLifecycleEventSafely"]>[1],
): boolean {
  const listeners = store.listeners(event) as Array<(...listenerArgs: typeof args) => unknown>;
  if (listeners.length === 0) {
    return false;
  }
  const [task] = args;
  const taskId = task && typeof task === "object" && "id" in task ? String(task.id) : "unknown";
  for (const listener of listeners) {
    try {
      const result = listener(...args);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch((error) => {
          storeLog.warn(`[${event}] listener failed for ${taskId}: ${getErrorMessage(error)}`);
        });
      }
    } catch (error) {
      storeLog.warn(`[${event}] listener failed for ${taskId}: ${getErrorMessage(error)}`);
    }
  }
  return true;
}
