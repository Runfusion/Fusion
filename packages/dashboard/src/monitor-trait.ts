import type {
  Task,
  TaskCreateInput,
  TaskStore,
  TraitDefinition,
} from "@fusion/core";
import {
  getTraitRegistry,
  registerTraitHookImpl,
  countRecentAutoFixTasksAsync,
  claimIncidentForFixTaskAsync,
  attachFixTaskAsync,
  releaseIncidentFixTaskClaimAsync,
} from "@fusion/core";
import { createSessionDiagnostics } from "./ai-session-diagnostics.js";
import {
  attachFixTask,
  claimIncidentForFixTask,
  countRecentAutoFixTasks,
  decideStormGuard,
  ingestIncidentSignal,
  releaseIncidentFixTaskClaim,
  type IncidentSignalInput,
  type StormGuardConfig,
} from "./monitor-store.js";

/**
 * U13 — Monitor stage trait.
 *
 * A column carrying the `monitor` trait watches post-ship work. When a card
 * enters it, the trait records that the shipped change is now being monitored.
 * Separately, a regression signal (an inbound U11 error signal arriving after a
 * ship) is fed through {@link runMonitorOnRegression}, which opens — through the
 * storm guard — at most ONE linked fix task in `triage`, closing the loop back to
 * Triage (U12).
 *
 * Mirrors `triage-trait.ts`: the trait DEFINITION is registered as a built-in so
 * plugins cannot override it; the IMPLEMENTATION lives in dashboard because it
 * reuses the monitor store + the task store, wired through the core→dashboard DI
 * seam (`registerTraitHookImpl`). The trait never re-triggers on a fix task it
 * itself opened (no self-loop), mirroring U12.
 */

const diagnostics = createSessionDiagnostics("monitor-trait");

/** Registry id of the monitor trait. */
export const MONITOR_TRAIT_ID = "monitor";

/** Column an auto-opened fix task lands in (back to the start of the loop). */
export const MONITOR_FIX_ROUTE_COLUMN = "triage";

/** Metadata marking a task as a Fusion-opened monitor fix task (self-loop guard). */
export const MONITOR_FIX_TASK_META_KEY = "monitorFixForIncidentId";
/** Metadata carrying the grouping key the fix task addresses. */
export const MONITOR_FIX_GROUPING_META_KEY = "monitorFixGroupingKey";

export const MONITOR_TRAIT_DEFINITION: TraitDefinition = {
  id: MONITOR_TRAIT_ID,
  name: "Monitor",
  description:
    "Watch post-ship work; on a regression signal, open a single linked fix task (storm-guarded) back in triage.",
  builtin: true,
  flags: { notify: true },
  hooks: { onEnter: true },
  configSchema: {
    fields: [
      { key: "threshold", type: "number", description: "Firings before a fix task opens" },
      { key: "sustainedMs", type: "number", description: "Sustained open-duration that satisfies the gate (ms)" },
      { key: "maxTasksPerWindow", type: "number", description: "Circuit breaker: max auto-fix tasks per window" },
    ],
  },
};

/**
 * True if a task is a Fusion-opened monitor fix task (never re-triage / never
 * re-trigger the guard on these — no self-loop).
 */
export function isMonitorFixTask(task: Task): boolean {
  const meta = (task.source?.sourceMetadata ?? {}) as Record<string, unknown>;
  return typeof meta[MONITOR_FIX_TASK_META_KEY] === "string";
}

function buildFixTaskInput(
  signal: IncidentSignalInput,
  incidentId: string,
): TaskCreateInput {
  const title = `Fix regression: ${signal.title}`;
  const lines = [title];
  if (signal.link) lines.push(`\nSource: ${signal.link}`);
  lines.push(`\nGrouping key: ${signal.groupingKey}`);
  lines.push(`Incident: ${incidentId}`);
  return {
    title,
    description: lines.join("\n"),
    column: MONITOR_FIX_ROUTE_COLUMN as TaskCreateInput["column"],
    priority: signal.severity === "critical" ? "urgent" : "high",
    source: {
      sourceType: "automation",
      sourceMetadata: {
        [MONITOR_FIX_TASK_META_KEY]: incidentId,
        [MONITOR_FIX_GROUPING_META_KEY]: signal.groupingKey,
        signalSource: signal.source,
        signalSeverity: signal.severity,
      },
    },
  };
}

export interface MonitorDeps {
  store: TaskStore;
  config?: StormGuardConfig;
  /** Injectable clock for deterministic tests. */
  nowMs?: number;
}

export type MonitorRegressionOutcome =
  | { kind: "fix-task-opened"; taskId: string; incidentId: string }
  | { kind: "absorbed"; incidentId: string; existingFixTaskId: string | null; reason: string }
  | { kind: "suppressed"; incidentId: string; reason: string }
  | { kind: "error"; reason: string };

/**
 * Handle a post-ship regression signal. Ingests it into the incidents table
 * (opening or absorbing into an open incident by groupingKey), then runs the
 * storm guard:
 *
 *  - absorb  → an open incident already has a fix task; bump occurrence, no new task.
 *  - suppress → flapping (gate not met) or circuit-breaker tripped; no new task.
 *  - open    → create exactly one fix task in triage and link it to the incident.
 *
 * Idempotent across a burst sharing one groupingKey: the FIRST firing past the
 * gate opens the task and links it; every subsequent firing finds the linked
 * incident and absorbs. A Fusion-opened fix task never re-enters this path.
 *
 * FNXC:Monitor 2026-06-16-14:05: only one fix task may be opened per open
 * incident window; concurrent regression ingests must not duplicate. The
 * create-then-link step is guarded by an atomic incident-level claim
 * (claimIncidentForFixTask) so the await on task creation cannot interleave two
 * winners for the same open incident.
 */
export async function runMonitorOnRegression(
  signal: IncidentSignalInput,
  deps: MonitorDeps,
): Promise<MonitorRegressionOutcome> {
  const { store, config, nowMs } = deps;
  // FNXC:PostgresCutover 2026-06-28-10:10:
  // Storm guard runs in BOTH backends. In PG backend mode the sync SQLite
  // helpers (getDatabase + countRecentAutoFixTasks/claimIncidentForFixTask/
  // attachFixTask/releaseIncidentFixTaskClaim) throw, so route through the async
  // equivalents in @fusion/core (async-monitor.ts) passing the AsyncDataLayer's
  // Drizzle handle. ingestIncidentSignal is already dual-path: in backend mode it
  // is handed the AsyncDataLayer directly (discriminated by `"ping" in db`); in
  // legacy mode it receives the sync `Database`. The storm-guard semantics — the
  // recent-auto-fix-count gate, the claim→createTask→attach→(release-on-failure)
  // sequence, and the returned outcome shapes — are identical across both paths.
  const backend = store.backendMode;
  const layer = backend ? store.getAsyncLayer() : null;
  if (backend && !layer) {
    return { kind: "error", reason: "backend mode without an AsyncDataLayer" };
  }
  // In backend mode hand the AsyncDataLayer to the dual-path ingest; the async
  // storm-guard helpers take the layer's Drizzle `db` handle.
  const ingestDb = backend ? layer! : store.getDatabase();
  const asyncDb = layer ? layer.db : null;

  let incidentId: string;
  try {
    const { incident } = await ingestIncidentSignal(ingestDb, signal);
    incidentId = incident.incidentId;

    const recent = backend
      ? await countRecentAutoFixTasksAsync(asyncDb!, config, nowMs)
      : countRecentAutoFixTasks(store.getDatabase(), config, nowMs);
    const decision = decideStormGuard(incident, recent, config, nowMs);

    if (decision.action === "absorb") {
      return {
        kind: "absorbed",
        incidentId,
        existingFixTaskId: decision.existingFixTaskId,
        reason: decision.reason,
      };
    }
    if (decision.action === "suppress") {
      return { kind: "suppressed", incidentId, reason: decision.reason };
    }

    // open-fix-task: claim the incident BEFORE the await on task creation. The
    // claim is an atomic conditional UPDATE (set fixTaskId WHERE fixTaskId IS
    // NULL), so under concurrent regression ingests for the same open incident
    // exactly one caller wins. Losers absorb instead of opening a duplicate task
    // — without this, two callers could both pass decideStormGuard (fixTaskId
    // still null), both await store.createTask, and both attach, opening two
    // tasks where only the last link wins.
    const claimed = backend
      ? await claimIncidentForFixTaskAsync(asyncDb!, incidentId)
      : claimIncidentForFixTask(store.getDatabase(), incidentId);
    if (!claimed) {
      const linked = decision.incident.fixTaskId ?? null;
      return {
        kind: "absorbed",
        incidentId,
        existingFixTaskId: linked,
        reason: "fix-task-claimed-concurrently",
      };
    }
    // FNXC:Monitor 2026-06-16-15:40: a fix-task claim must be released if task
    // creation fails so a stranded sentinel can't permanently absorb/suppress
    // future regressions. The claim wrote a non-null sentinel to fixTaskId; if
    // createTask throws here, attachFixTask never overwrites it, leaving the
    // incident pseudo-linked forever. Release the claim (back to NULL, only when
    // still the sentinel) before surfacing an error outcome so a later regression
    // can open a fix task again.
    let task: Task;
    try {
      task = await store.createTask(buildFixTaskInput(signal, incidentId));
    } catch (createErr) {
      if (backend) {
        await releaseIncidentFixTaskClaimAsync(asyncDb!, incidentId);
      } else {
        releaseIncidentFixTaskClaim(store.getDatabase(), incidentId);
      }
      diagnostics.errorFromException("Monitor fix-task creation failed; released claim", createErr, {
        groupingKey: signal.groupingKey,
        incidentId,
      });
      return {
        kind: "error",
        reason: createErr instanceof Error ? createErr.message : String(createErr),
      };
    }
    if (backend) {
      await attachFixTaskAsync(asyncDb!, incidentId, task.id);
    } else {
      attachFixTask(store.getDatabase(), incidentId, task.id);
    }
    return { kind: "fix-task-opened", taskId: task.id, incidentId };
  } catch (err) {
    diagnostics.errorFromException("Monitor regression handling failed", err, {
      groupingKey: signal.groupingKey,
    });
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── Registration (DI seam) ──────────────────────────────────────────────────

let registered = false;

/**
 * Register the monitor trait definition + onEnter hook implementation. The
 * onEnter hook records that a shipped task is now monitored; regression-driven
 * fix-task creation runs through {@link runMonitorOnRegression} from the signal
 * ingestion path, not from onEnter. Idempotent.
 */
export function registerMonitorTrait(): void {
  if (registered) return;
  const registry = getTraitRegistry();
  if (!registry.has(MONITOR_TRAIT_ID)) {
    registry.register(MONITOR_TRAIT_DEFINITION);
  }
  registerTraitHookImpl(MONITOR_TRAIT_ID, "onEnter", (...args: unknown[]) => {
    const ctx = args[0] as { task?: Task } | undefined;
    if (!ctx?.task) return undefined;
    // Post-ship watch is currently a no-op marker hook; the loop-closing work is
    // signal-driven (runMonitorOnRegression). Returning undefined keeps the
    // card in place — monitoring is observational, not a routing action.
    return undefined;
  });
  registered = true;
}

/** Test-only: reset the registration latch. */
export function __resetMonitorTraitForTests(): void {
  registered = false;
}
