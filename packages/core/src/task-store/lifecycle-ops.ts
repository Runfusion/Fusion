/**
 * lifecycle-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS, WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX} from "../store.js";
import {planLegacyAdoption} from "../legacy-adoption.js";
import {sql} from "drizzle-orm";
import {MIGRATION_BOOKKEEPING_TABLE, LEGACY_ADOPTION_DRAINED_MARKER} from "../postgres/schema-applier.js";
import {mkdir, readdir, readFile, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync, watch, type Dirent} from "node:fs";
import type {Task, AgentLogEntry, Column, Settings, GlobalSettings} from "../types.js";
import {DEFAULT_SETTINGS} from "../types.js";
import {MOVED_SETTINGS_KEYS, SETTINGS_MIGRATION_VERSION, SETTINGS_MIGRATION_MARKER_KEY} from "../moved-settings.js";
import {stepsToWorkflowIr, stepToFragmentIr, layoutForIr} from "../workflow-steps-to-ir.js";
import {getTraitRegistry} from "../trait-registry.js";
import {registerDefaultWorkflowHooks} from "../default-workflow-hooks.js";
import {clearTransitionPending, readTransitionPending, reconcileHooksRemaining} from "../transition-pending.js";
import {clearTransitionPendingAsync, listTransitionPendingTaskIdsAsync, readTransitionPendingAsync} from "./async-transition-pending.js";
import type {WorkflowSettingDefinition} from "../workflow-ir-types.js";
import {validateSettingValuePatch} from "../workflow-settings.js";
import "../builtin-traits.js";
import {Database, SCHEMA_VERSION} from "../db.js";
import {ensureMemoryFileWithBackend} from "../project-memory.js";
import {appendAgentLogEntriesSync} from "../agent-log-file-store.js";
import {getErrorMessage} from "../error-message.js";
import {type TaskRow} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {reconcileTaskIdStateAsync} from "../task-store/async-allocator.js";

export async function initImpl(store: TaskStore): Promise<void> {
    store.closing = false;
    await mkdir(store.tasksDir, { recursive: true });

    // U4: register the default-workflow trait hook implementations into the
    // shared trait registry (the flag-ON moveTaskInternal path resolves the
    // legacy per-column effects through these). Idempotent; built-in trait
    // DEFINITIONS self-register on import of ./builtin-traits.js (pulled in
    // transitively via default-workflow-hooks / trait-registry).
    registerDefaultWorkflowHooks();

    // FNXC:RuntimeBackendInjection 2026-06-24-14:15:
    // In backend mode (an AsyncDataLayer was injected), TaskStore skips ALL
    // SQLite construction and the SQLite-specific startup reconciliations
    // (corruption guard, legacy file migration, agent-log file migration,
    // schema-version re-init, orphaned task-dir reconcile, activity-log
    // listener wiring that reads from SQLite, etc.). The PostgreSQL schema
    // baseline is applied by the startup factory before constructing the
    // store, and the async equivalents of these reconciliations are wired by
    // the runtime-*-async features. init() in backend mode performs only the
    // backend-agnostic setup (mkdir, trait-hook registration) above and returns.
    //
    // When the async layer is ABSENT, the entire block below runs exactly as
    // before — byte-identical to the pre-migration SQLite path.
    if (store.backendMode) {
      // FNXC:RuntimePersistenceAsync 2026-06-24-10:32:
      // In backend mode, run the async allocator reconciliation so sequences
      // are bumped to the high-water mark on store open (VAL-DATA-007/008).
      // Soft-deleted/archived IDs stay reserved because the reconciliation
      // scans them. The SQLite-specific integrity-report refreshers are not
      // applicable in backend mode (the async task-id-integrity detector is
      // wired by a separate feature).
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
      return;
    }

    // Initialize SQLite database
    if (!store._db) {
      // Startup corruption guard: before opening, detect a malformed fusion.db
      // (a node:sqlite SIGSEGV mid-write can leave the B-tree corrupt in a way
      // that still opens) and rebuild it via sqlite3 .recover, preserving the
      // corrupt original. Disk-backed only; opt out with FUSION_DISABLE_DB_AUTORECOVER.
      // FNXC:SqliteRemoval 2026-06-25-18:30: inMemoryDb always false now (removed).
      if (process.env.FUSION_DISABLE_DB_AUTORECOVER !== "1") {
        try {
          const recovery = Database.recoverIfCorrupt(store.fusionDir);
          if (recovery.status === "recovered") {
            // A `.recover` rebuild can drop task rows whose task.json survived on disk. Let the
            // orphan reconcile below bypass its recency window so those rows are recovered even
            // when their (possibly old) task.json mtime would otherwise fail the gate.
            store.dbWasCorruptionRecovered = true;
            storeLog.warn("Recovered corrupt fusion.db on startup", {
              phase: "init:db-autorecover",
              corruptBackupPath: recovery.corruptBackupPath,
              errors: recovery.errors?.slice(0, 5),
            });
          } else if (recovery.status === "failed") {
            storeLog.error("fusion.db is corrupt and automatic recovery failed", {
              phase: "init:db-autorecover",
              errors: recovery.errors?.slice(0, 5),
            });
          }
        } catch (error) {
          storeLog.warn("Startup db corruption guard threw — continuing to open", {
            phase: "init:db-autorecover",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const db = new Database(store.fusionDir, { inMemory: false });
      try {
        db.init();
      } catch (error) {
        db.close();
        throw error;
      }
      store._db = db;
    }

    store.reconcileDistributedTaskIdStateOnOpen();
    
    await store.migrateActiveArchivedTasksToArchiveDb();
    await store.migrateAgentLogEntriesToFilesOnce();
    await store.cleanupNoOpTaskMovedActivityRowsOnce();
    try {
      await store.markLegacyAutoMergeStampsOnce();
    } catch (err) {
      storeLog.warn("Legacy auto-merge stamp marker failed during init (non-fatal)", {
        phase: "init:legacy-auto-merge-stamp-marker",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // U4: one-time per-project hard-move of MOVED_SETTINGS_KEYS into workflow
    // setting values (marker-gated, idempotent, never blocks startup).
    try {
      await store.migrateMovedSettingsToWorkflowValuesOnce();
    } catch (err) {
      storeLog.warn("Settings hard-move migration failed during init (non-fatal)", {
        phase: "init:settings-hard-move",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Re-run init when migrations are pending, or when the deferred
    // agentLogEntries drop still needs to fire: migration 102 skips the
    // destructive drop until migrateAgentLogEntriesToFilesOnce() above writes
    // the __meta guard, but migrations 103+ bump the schema version past 102
    // on the first pass, so the version check alone no longer triggers the
    // second pass that performs the drop.
    const legacyAgentLogTableRemains =
      store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1")
        .get() !== undefined;
    if (store.db.getSchemaVersion() < SCHEMA_VERSION || legacyAgentLogTableRemains) {
      store.db.init();
    }
    await store.importLegacyAgentLogsOnce();
    store.taskIdStateReconciled = false;
    store.reconcileDistributedTaskIdStateOnOpen();
    try {
      await store.reconcileOrphanedTaskDirs({ ignoreRecencyWindow: store.dbWasCorruptionRecovered });
    } catch (err) {
      storeLog.warn("Orphaned task-dir reconcile failed during init (non-fatal)", {
        phase: "init:orphaned-task-dir-reconcile",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Write config.json for backward compatibility if it doesn't exist
    if (!existsSync(store.configPath)) {
      const config = await store.readConfig();
      try {
        await writeFile(store.configPath, store.serializeConfigForDisk(config));
      } catch (err) {
        storeLog.warn("Backward-compat config.json sync failed during init", {
          phase: "init:config-sync",
          configPath: store.configPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    
    store.setupActivityLogListeners();

    // Bootstrap project memory file if memory is enabled
    try {
      const config = await store.readConfig();
      const mergedSettings: Settings = { ...DEFAULT_SETTINGS, ...config.settings };
      if (mergedSettings.memoryEnabled !== false) {
        // Use backend-aware bootstrap to honor memoryBackendType setting
        await ensureMemoryFileWithBackend(store.rootDir, mergedSettings);
      }
    } catch (err) {
      // Non-fatal — memory bootstrap failure should not block startup
      storeLog.warn("Project-memory bootstrap failed during init", {
        phase: "init:memory-bootstrap",
        rootDir: store.rootDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    /*
    FNXC:RunAudit 2026-07-13-13:10 (merge port from main):
    Store-open provenance stamp. A store open by a stale binary is how the
    FN-7910 incident happened (a pre-fix process's init evacuated Ideas cards;
    the run-audit row said only agentId:"system"). Stamp pid / parent pid /
    executable / entry script / cwd / node version — ids/paths only, no prose.
    Best-effort: a failed stamp never blocks startup.
    */
    try {
      store.insertRunAuditEventRow({
        agentId: "store",
        domain: "database",
        mutationType: "store:open",
        target: store.rootDir,
        metadata: {
          pid: process.pid,
          ppid: process.ppid,
          execPath: process.execPath,
          entry: process.argv[1] ?? null,
          cwd: process.cwd(),
          nodeVersion: process.version,
        },
      });
    } catch (err) {
      storeLog.warn("store-open provenance stamp failed during init", {
        phase: "init:store-open-stamp",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // U12: workflow-columns integrity pass. Audit + re-home any task whose
    // stored column is no longer valid in its resolved workflow (KTD-1
    // guarantees zero rewrites for healthy legacy rows, so this is a no-op for
    // the common case). Idempotent; non-fatal — never blocks startup.
    /*
    FNXC:WorkflowColumns 2026-07-12-22:40 (merge port from main):
    Workflow columns graduated to always-on at runtime, so init must ALWAYS run
    the workflow-aware integrity pass and must NEVER run the #1409 flag-OFF
    evacuation: the retired experimental flag reads false for virtually every
    install, so the old flag-keyed branch ran
    evacuateCustomColumnsToLegacy("flag-off-init") on EVERY store open — it
    declared healthy custom intake columns (e.g. Coding (Ideas)) invalid and
    dumped their cards into "triage", where triage auto-planned and executed
    work the operator had deliberately parked (FN-7910). The evacuation now
    runs only on an explicit ON→OFF settings toggle.
    */
    try {
      await store.runWorkflowColumnsIntegrityPass();
      // #1401: recover any transitionPending markers stranded by a crash
      // between the in-txn write and the post-commit clear (they otherwise
      // permanently inflate capacity counts for their target column).
      await store.recoverStaleTransitionPending();
    } catch (err) {
      storeLog.warn("workflowColumns integrity pass failed during init", {
        phase: "init:workflow-columns-integrity",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    /*
    FNXC:LegacyAdoption 2026-07-19-14:30 (PR #2341 review):
    Adoption runs OUTSIDE the integrity-pass try block: a throw from
    runWorkflowColumnsIntegrityPass/recoverStaleTransitionPending must not skip the
    sweep for the boot cycle ("every pre-cutover row wakes OWNED" cannot depend on an
    unrelated pass succeeding). Safe as a bare await — the sweep is internally fail-soft
    and never throws.
    */
    await adoptLegacyTaskRowsOnOpen(store);
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
    storeLog.warn("Legacy-adoption drained-marker read failed — sweeping anyway", {
      phase: "init:legacy-adoption",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function writeLegacyAdoptionDrainedMarker(store: TaskStore): Promise<void> {
  const db = store.asyncLayer?.db;
  if (!db) return;
  try {
    await db.execute(
      sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${LEGACY_ADOPTION_DRAINED_MARKER}) ON CONFLICT (version) DO NOTHING`,
    );
  } catch (error) {
    // Non-fatal: the next fully-clean drain writes it again.
    storeLog.warn("Legacy-adoption drained-marker write failed", {
      phase: "init:legacy-adoption",
      error: error instanceof Error ? error.message : String(error),
    });
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
      if (store.suppressActivityLogForPollingEmit) return;
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
      if (store.suppressActivityLogForPollingEmit) return;
      if (data.from === data.to) return;
      store.recordActivityFromListener(
        {
          type: "task:moved",
          taskId: data.task.id,
          taskTitle: data.task.title,
          details: `Task ${data.task.id} moved: ${data.from} → ${data.to}`,
          metadata: { from: data.from, to: data.to },
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

    // Task updated (check for failures)
    store.on("task:updated", (task) => {
      if (store.suppressActivityLogForPollingEmit) return;
      if (task.status === "failed") {
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

    // Settings updated (log important changes)
    store.on("settings:updated", (data) => {
      const importantChanges: string[] = [];
      if (data.settings.ntfyEnabled !== data.previous.ntfyEnabled) {
        importantChanges.push(`ntfy ${data.settings.ntfyEnabled ? "enabled" : "disabled"}`);
      }
      if (data.settings.ntfyTopic !== data.previous.ntfyTopic) {
        importantChanges.push(`ntfy topic changed to ${data.settings.ntfyTopic}`);
      }
      if (data.settings.globalPause !== data.previous.globalPause) {
        importantChanges.push(`global pause ${data.settings.globalPause ? "enabled" : "disabled"}`);
      }
      if (data.settings.enginePaused !== data.previous.enginePaused) {
        importantChanges.push(`engine pause ${data.settings.enginePaused ? "enabled" : "disabled"}`);
      }

      if (importantChanges.length > 0) {
        store.recordActivityFromListener(
          {
            type: "settings:updated",
            details: `Settings updated: ${importantChanges.join(", ")}`,
            metadata: { changes: importantChanges },
          },
          "settings:updated",
        );
      }
    });

    // Task deleted
    store.on("task:deleted", (task) => {
      if (store.suppressActivityLogForPollingEmit) return;
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
    FNXC:PostgresCutover 2026-07-04-00:00:
    Assessed safe-default: in PG backend mode, the sync filesystem scan + store.db re-insert
    path cannot run (Drizzle is async, store.db is removed). The self-healing caller (line 2302)
    receives an empty result — orphaned task dirs are NOT reconciled in PG mode. This is low-risk
    because PG soft-delete is the norm (task.json dirs persist for active tasks; deleted tasks
    keep their dirs but are tombstoned in PG, not lost). A full async reconcile (scan dirs,
    check PG for matching rows, re-import missing) is feasible but not P0 given the rarity of
    PG-mode orphans. Not claiming a non-existent async fallback.
    */
    if (store.backendMode) {
      return { recovered: [], skipped: [] };
    }
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
      const row = store.db
        .prepare('SELECT EXISTS(SELECT 1 FROM tasks WHERE deletedAt IS NULL LIMIT 1) AS present')
        .get() as { present?: number } | undefined;
      dbHasLiveTasks = (row?.present ?? 0) === 1;
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
            storeLog.warn("Skipping stale orphaned task-dir reconcile (beyond recency window)", {
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
        store.db.transactionImmediate(() => {
          // FNXC:SqliteFinalRemoval 2026-06-26: taskIdExistsAnywhere is now async;
          // inline the sync SQLite check here since this runs inside transactionImmediate.
          if (store.readTaskFromDb(id, { includeDeleted: true }) || store.isTaskIdPresentInArchivedTasksTable(id) || store.archiveDb.get(id) !== undefined) {
            skipReason = "id-exists-anywhere";
            return;
          }
          try {
            store.insertTaskWithFtsRecovery(task, "reconcileOrphanedTaskDirs");
            store.insertRunAuditEventRow({
              taskId: id,
              domain: "database",
              mutationType: "task:reconcile-orphaned-task-dir",
              target: id,
              metadata: {
                id,
                column: task.column,
                status: task.status ?? null,
                taskJsonPath,
              },
            });
            recovered = true;
          } catch (error) {
            if (store.isTaskIdConflictError(error) || /Task ID already exists/i.test(error instanceof Error ? error.message : String(error))) {
              skipReason = "id-conflict-during-insert";
              return;
            }
            throw error;
          }
        });
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
        storeLog.warn("Recovered orphaned task.json into SQLite task index", {
          phase: "reconcileOrphanedTaskDirs:recovered",
          taskId: id,
          column: task.column,
          status: task.status,
          taskJsonPath,
        });
        store.emitTaskLifecycleEventSafely("task:created", [task]);
      } else {
        result.skipped.push({ id, reason: skipReason ?? "not-recovered" });
      }
    }

    return result;
  }

export async function watchImpl(store: TaskStore): Promise<void> {
    if (store.watcher || store.pollInterval) return; // already watching
    store.clearStartupSlimListMemo();

    /*
     * FNXC:BackendFlip 2026-06-26-16:00:
     * In backend mode (PostgreSQL), the entire watch() body below is
     * SQLite-specific: it reads store.db.getLastModified(), sets up an fs.watch
     * sentinel + a 1s polling interval whose checkForChanges() cycle queries
     * store.db.prepare('SELECT ... FROM tasks'), and runs SQLite-only stamp
     * markers. All of those throw "SQLite Database is not available in backend
     * mode" because store.db is not constructed when an AsyncDataLayer is
     * injected.
     *
     * The async backend does not rely on this SQLite polling loop for change
     * detection — runtime mutations go through the async layer and emit their
     * own events. Populate the in-memory task cache (so the HTTP layer has a
     * snapshot) via the backend-aware listTasks(), then return without
     * installing the SQLite watcher/poller. This keeps `fn serve` / boot smoke
     * booting against embedded PG.
     */
    if (store.backendMode) {
      const tasks = await store.listTasks({ slim: true, startupMemo: false });
      store.taskCache.clear();
      for (const task of tasks) {
        store.taskCache.set(task.id, { ...task });
      }
      return;
    }

    // Populate cache with current state. The watcher only needs metadata to
    // detect created/updated/moved/deleted events; full task logs stay on the
    // detail path.
    const tasks = await store.listTasks({ slim: true, startupMemo: false });
    store.taskCache.clear();
    for (const task of tasks) {
      store.taskCache.set(task.id, { ...task });
    }

    try {
      await store.markLegacyAutoMergeStampsOnce();
    } catch (err) {
      storeLog.warn("Legacy auto-merge stamp marker failed during watch startup (non-fatal)", {
        phase: "watch:legacy-auto-merge-stamp-marker",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!store.donePauseBackfillDone) {
      const repairedTaskIds: string[] = [];
      for (const [taskId, cachedTask] of store.taskCache.entries()) {
        if (cachedTask.column !== "done") continue;

        const taskDir = store.taskDir(taskId);
        let raw: string;
        try {
          raw = await readFile(join(taskDir, "task.json"), "utf-8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            /*
             * FNXC:StartupRecovery 2026-06-23-05:02:
             * A recovered or corrupt SQLite index can retain done-task rows whose legacy task.json mirror was already removed. Startup watch must not crash while running the one-time done-pause backfill; skip the missing mirror and keep the dashboard available so operators can inspect or repair the project.
             */
            storeLog.warn("Skipping done-task pause metadata backfill for missing task.json", {
              phase: "watch:done-pause-backfill",
              taskId,
              taskJsonPath: join(taskDir, "task.json"),
            });
            continue;
          }
          throw error;
        }
        const diskTask = JSON.parse(raw) as Task;
        if (!store.clearDoneTransientFields(diskTask)) continue;

        await store.atomicWriteTaskJson(taskDir, diskTask);
        store.taskCache.set(taskId, { ...diskTask });
        repairedTaskIds.push(taskId);
      }
      store.donePauseBackfillDone = true;

      storeLog.log("done-task pause metadata backfill completed", {
        phase: "watch:done-pause-backfill",
        repairedCount: repairedTaskIds.length,
        repairedTaskIds: repairedTaskIds.slice(0, 20),
      });
    }

    // Store current lastModified
    store.lastKnownModified = store.db.getLastModified();
    // Initialize lastPollTime so the first checkForChanges() cycle filters by
    // "modified since now" instead of doing a full SELECT * + emitting an
    // update event for every cached task. Without this, dashboard startup
    // re-loaded the entire tasks table 1s after watch() began.
    store.lastPollTime = new Date().toISOString();

    // Use a sentinel watcher object so existing code that checks `store.watcher` still works
    try {
      store.watcher = watch(store.tasksDir, { recursive: true }, (_event, _filename) => {
        // No-op - we use polling now, but keep watcher for API compat
      });
      store.watcher.on("error", (err) => {
        storeLog.warn("fs.watch emitted an error; polling will continue", {
          phase: "watch:fs-watch-error",
          error: err instanceof Error ? err.message : String(err),
          tasksDir: store.tasksDir,
        });
      });
    } catch (err) {
      // fs.watch may not be available - that's fine
      storeLog.warn("fs.watch unavailable; falling back to polling-only updates", {
        phase: "watch:fs-watch-setup",
        error: err instanceof Error ? err.message : String(err),
        tasksDir: store.tasksDir,
      });
    }

    // Poll for changes every second
    store.pollInterval = setInterval(() => {
      void store.checkForChanges();
    }, 1000);
    store.clearStartupSlimListMemo();
  }

export async function checkForChangesImpl(store: TaskStore): Promise<void> {
    const startTime = Date.now();

    // Guard against overlapping poll cycles
    if (store.pollingInProgress) return;
    store.pollingInProgress = true;

    try {
      const currentModified = store.db.getLastModified();
      if (currentModified <= store.lastKnownModified) return;
      store.lastKnownModified = currentModified;

      // Detect deletions cheaply: compare ID sets without loading full rows.
      // A row missing from `tasks` can mean two things: the task was actually
      // deleted, OR it was archived (archiveTask removes it from `tasks` after
      // copying into `archived_tasks`). Other TaskStore instances polling the
      // same DB can't tell the difference from this view alone — without the
      // archive check below they emit spurious task:deleted events for every
      // archived task, which the activity log records as a deletion.
      // FN-5105: intentionally include soft-deleted rows here so a deletedAt
      // transition can be observed and emit task:deleted exactly once.
      const idRows = store.db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>;
      const currentIds = new Set(idRows.map((r) => r.id));
      const missingIds: string[] = [];
      for (const id of store.taskCache.keys()) {
        if (!currentIds.has(id)) missingIds.push(id);
      }
      if (missingIds.length > 0) {
        const archivedSet = store.archiveDb.filterArchived(missingIds);
        for (const id of missingIds) {
          const cached = store.taskCache.get(id);
          if (!cached) continue;
          store.taskCache.delete(id);
          store.suppressActivityLogForPollingEmit = true;
          try {
            if (archivedSet.has(id)) {
              // Task moved to archive — emit task:moved (matching what
              // archiveTask emits in-process) so other subscribers can react.
              // Skip already-archived cache entries to avoid no-op emits.
              // Activity-log listeners skip polling emits; the originating
              // TaskStore instance wrote the row in-process.
              if (cached.column !== "archived") {
                store.emit("task:moved", { task: cached, from: cached.column, to: "archived" as Column, source: "engine" });
              }
            } else {
              // Polling replicas only mirror the originating delete signal.
              // Do not record run-audit here; the writer already owns that row.
              store.emit("task:deleted", cached);
            }
          } finally {
            store.suppressActivityLogForPollingEmit = false;
          }
        }
      }

      // Yield to event loop before the expensive SELECT query
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Only load tasks modified since our last known timestamp.
      // Use lastKnownPollTime (ISO string) to filter — much cheaper than full scan.
      const selectClause = store.getTaskSelectClause(true);
      const changedRows = store.lastPollTime
        ? store.db.prepare(`SELECT ${selectClause} FROM tasks WHERE updatedAt > ? OR columnMovedAt > ?`).all(store.lastPollTime, store.lastPollTime) as unknown as TaskRow[]
        : store.db.prepare(`SELECT ${selectClause} FROM tasks`).all() as unknown as TaskRow[];
      store.lastPollTime = new Date().toISOString();

      for (let i = 0; i < changedRows.length; i++) {
        const row = changedRows[i];
        const task = store.rowToTask(row);
        const cached = store.taskCache.get(task.id);

        store.suppressActivityLogForPollingEmit = true;
        try {
          if (task.deletedAt) {
            if (cached) {
              store.taskCache.delete(task.id);
              // Polling replicas only re-emit task:deleted for subscribers.
              // They must not insert duplicate run-audit rows cross-instance.
              store.emit("task:deleted", cached);
            }
            continue;
          }

          if (!cached) {
            store.taskCache.set(task.id, { ...task });
            store.emit("task:created", task);
          } else if (cached.column !== task.column) {
            const from = cached.column;
            store.taskCache.set(task.id, { ...task });
            store.emit("task:moved", { task, from, to: task.column, source: "engine" });
          } else {
            store.taskCache.set(task.id, { ...task });
            store.emit("task:updated", task);
          }
        } finally {
          store.suppressActivityLogForPollingEmit = false;
        }

        // Yield every ~50 rows to prevent blocking the event loop during large updates
        if (i > 0 && i % 50 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 750) {
        storeLog.warn("checkForChanges took longer than expected", {
          elapsedMs: elapsed,
          thresholdMs: 750,
        });
      }
    } catch (err) {
      storeLog.warn("checkForChanges poll cycle failed", {
        lastKnownModified: store.lastKnownModified,
        lastPollTime: store.lastPollTime,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      store.pollingInProgress = false;
    }
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
          const task = backend
            ? await store.getTask(id).catch(() => null)
            : store.readTaskFromDb(id, { includeDeleted: false });
          if (task) {
            const ir = store.resolveTaskWorkflowIrSync(id);
            // fromColumn is unknown post-crash; the marker only records toColumn.
            // The hook runner keys onEnter off toColumn (and onExit off fromColumn);
            // re-running onEnter for the destination is the recoverable, idempotent
            // half. Use the task's current column as fromColumn (it committed to
            // toColumn at marker-write time, so current == toColumn and onExit is a
            // no-op, which is correct — we never re-fire an exit we may have run).
            try {
              await store.runPluginColumnTransitionHooks(id, ir, task.column, live.toColumn);
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

        void store.recordRunAuditEvent({
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
    // Resolve async prerequisites BEFORE the synchronous transaction: the
    // workflow-columns flag (for flag-aware persistence). The project default is
    // re-read AFTER the transaction (compare-and-set) so a concurrently-set
    // default is never clobbered.
    const flagOn = await store.workflowColumnsFlagOn();

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
          flagOn,
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
          flagOn,
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
  event: "task:created" | "task:updated",
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
