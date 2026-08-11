import {
  getCurrentRepo,
  computeBlockerFanoutMap,
  compareTasksByPriorityThenAgeAndId,
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  nonExecutableDuplicateRedirectReason,
  isPlanReviewSatisfied,
  type TaskStore,
  type Task,
  type MissionStore,
  type AsyncMissionStore,
  type MissionFeature,
  type PrInfo,
  type AgentStore,
  type Settings,
} from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dropPreHeldExecutorSlot,
  projectAdmissionCoordinator,
  persistedTopLevelAgentTaskIdsFromStore,
  recoverIdleSemaphoreLeakCandidate,
  registerPreHeldExecutorSlot,
  resolveActiveTaskCapacityLimit,
  type AgentSemaphore,
} from "./concurrency/concurrency.js";
import { planTaskWorktreePath, resolveTaskWorkingBranch } from "./worktree/worktree-names.js";
import { schedulerLog } from "./logger.js";
import { createRepeatSuppressedLog } from "./util/repeat-suppressed-log.js";
import { type PrMonitor, type PrComment } from "./merge/pr-monitor.js";
import { persistMissionFeatureReconciliation, reconcileMissionFeatureState } from "./missions/mission-feature-sync.js";
import { resolveDedicatedPlannerColumnsForTask, resolvePlannerLanesForTask } from "./planner-lane-resolution.js";
import { evaluateSpecStaleness, getPromptPath } from "./execution/spec-staleness.js";
import { resolveEffectiveNode, type EffectiveNode } from "./project/effective-node.js";
import { applyUnavailableNodePolicy, decideOwningNodeHandoff } from "./project/node-routing-policy.js";
import type { NodeDispatchValidationResult } from "./project/node-dispatch-validation.js";
import type { MeshLeaseManager } from "./project/mesh-lease-manager.js";
import type { AutoClaimSnapshotManager } from "./scheduling/auto-claim-snapshot.js";
import { StaleTaskReporter } from "./healing/stale-task-reporter.js";
import { BacklogPressureReporter } from "./scheduling/backlog-pressure-reporter.js";
import { UnlinkedMissionsAdvisoryReporter } from "./missions/unlinked-missions-advisory-reporter.js";
import { createRunAuditor, generateSyntheticRunId } from "./util/run-audit.js";
import type { TaskMoveLanes } from "@fusion/core";
import { resolveProjectColumnsForRoles, resolveWorkflowIrForTask, resolveWorkflowIrById, resolveColumnFlags, resolveWorktreeCapacityLimit, resolveLifecycleColumns, isWipColumnRole, isReviewColumnRole, isCompleteColumnRole, columnsWithFlag } from "@fusion/core";
import type { ColumnRoleTraitFlags } from "@fusion/core";
import type { WorkflowIr, WorkflowIrV2 } from "@fusion/core";
import { checkAndRecordUnplannedExecutionBlock, runHoldReleaseSweep, isUnplannedForExecution, type SlotReservation } from "./execution/hold-release.js";
import { moveTaskToReplanColumn } from "./execution/replan-target.js";
import { evaluateParkedAgentTaskLink } from "./agents/task-agent-sync.js";
import { decideMissionSymbolAdmission, resolveMissionFeatureForTask } from "./missions/mission-symbol-admission.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./healing/recovery-policy.js";

const SYMBOL_LOCK_LEASE_MS = 10 * 60_000;

/*
FNXC:WorkflowScheduling 2026-07-15-12:55:
Every dispatch pass resolves a routing node, so logging each resolution at info level reprinted `routed to node=local (source=local)` for every task on every poll and buried real scheduler events in the TUI log pane.
Local routing is the default nobody needs told about: it is debug-only (`FUSION_DEBUG=scheduler`). Remote routing stays at info because it explains where work actually went and is what an operator reaches for when a task runs on the wrong host.
*/
function logTaskRouting(taskId: string, node: EffectiveNode): void {
  const message = `Task ${taskId} routed to node=${node.nodeId ?? "local"} (source=${node.source})`;
  if (node.nodeId === undefined) {
    schedulerLog.debug(message);
    return;
  }
  schedulerLog.log(message);
}

function shouldRunWorkflowColumnScheduler(_settings: Settings): boolean {
  /*
  FNXC:WorkflowScheduling 2026-06-22-00:00:
  Workflow columns are the scheduler runtime after cutover. Persisted workflowColumns=false values are stale compatibility data and must not reactivate the legacy todo dispatcher or bypass workflow hold/release gates.
  */
  return true;
}

/**
 * Check whether two sets of file scope paths overlap.
 * Paths overlap if they are identical, or if one is a directory prefix of the other.
 * Glob patterns (ending with `/*`) are treated as directory prefixes.
 *
 * Exported for direct unit testing; used internally by {@link Scheduler}.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const pa of a) {
    const prefixA = pa.endsWith("/*") ? pa.slice(0, -1) : null;
    for (const pb of b) {
      const prefixB = pb.endsWith("/*") ? pb.slice(0, -1) : null;

      // Exact match (ignoring glob suffix)
      const cleanA = prefixA ? pa.slice(0, -2) : pa;
      const cleanB = prefixB ? pb.slice(0, -2) : pb;
      if (cleanA === cleanB) return true;

      // Check prefix overlap
      if (prefixA && pb.startsWith(prefixA)) return true;
      if (prefixB && pa.startsWith(prefixB)) return true;
      if (prefixA && prefixB) {
        if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))
          return true;
      }

      // Exact file path match
      if (pa === pb) return true;
    }
  }
  return false;
}

function normalizeOverlapPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function hasHiddenOverlapPathSegment(path: string): boolean {
  const normalizedPath = normalizeOverlapPath(path);
  if (!normalizedPath) return false;
  return normalizedPath.split("/").some((segment) => segment.startsWith("."));
}

function isIgnoredOverlapPath(path: string, ignorePath: string): boolean {
  const normalizedPath = normalizeOverlapPath(path);
  const normalizedIgnore = normalizeOverlapPath(ignorePath);

  if (normalizedIgnore.endsWith("/*")) {
    const directory = normalizedIgnore.slice(0, -2);
    return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
  }

  if (normalizedIgnore.endsWith("/")) {
    const directory = normalizedIgnore.slice(0, -1);
    return normalizedPath === directory || normalizedPath.startsWith(normalizedIgnore);
  }

  return normalizedPath === normalizedIgnore || normalizedPath.startsWith(`${normalizedIgnore}/`);
}

function computeAutoClaimFingerprint(task: Task): string {
  const dependencies = [...(task.dependencies ?? [])].sort().join(",");
  const sortAt = task.columnMovedAt ?? task.createdAt;
  /** FNXC:TaskDispatch 2026-07-19-14:40: `userPaused` is a durable operator stop even when legacy `paused` is false; candidacy caching and every dispatch selector must treat either flag as parked. */
  return [
    task.column,
    task.paused === true ? "1" : "0",
    task.userPaused === true ? "1" : "0",
    task.assignedAgentId ?? "",
    task.checkedOutBy ?? "",
    task.deletedAt ?? "",
    dependencies,
    sortAt,
  ].join("|");
}

export interface FilterOverlapPathsOptions {
  ignoreHiddenOverlapPaths?: boolean;
}

/**
 * Remove scope entries that should not participate in file-overlap serialization.
 *
 * FNXC:OverlapScheduling 2026-06-23-13:09:
 * Hidden dot paths are ignored by default for overlap blockers because task artifacts and hidden/generated metadata such as `.fusion/`, `.changeset/`, `.github/`, `.env`, and nested `.cache/` directories caused false serialization. Operators can set `ignoreHiddenOverlapPaths=false` to restore legacy counting, while explicit `overlapIgnorePaths` keep their exact/directory/glob-prefix semantics in either mode.
 */
export function filterPathsByIgnoreList(
  paths: string[],
  ignorePaths?: string[],
  options: FilterOverlapPathsOptions = {},
): string[] {
  const shouldIgnoreHidden = options.ignoreHiddenOverlapPaths ?? true;
  const normalizedIgnorePaths = (ignorePaths ?? []).map(normalizeOverlapPath).filter(Boolean);

  if (!shouldIgnoreHidden && normalizedIgnorePaths.length === 0) {
    return paths;
  }

  return paths.filter((path) => {
    if (shouldIgnoreHidden && hasHiddenOverlapPathSegment(path)) return false;
    return !normalizedIgnorePaths.some((ignore) => isIgnoredOverlapPath(path, ignore));
  });
}

export interface QueuedOverlapCandidate {
  id: string;
  priority?: Task["priority"] | null;
  createdAt: string;
  scope: string[];
}

const COORDINATION_SAFE_SCOPE_EXACT = new Set([
  // Literal glob scope entries from PROMPT.md are kept here; concrete
  // `.changeset/<name>.md` files are covered by COORDINATION_SAFE_SCOPE_PREFIXES.
  ".changeset/*.md",
  "scripts/test-all-packages.sh",
]);

const COORDINATION_SAFE_SCOPE_PREFIXES = [
  "docs/",
  ".fusion/tasks/",
  ".changeset/",
];

const DEFAULT_DISPATCH_OSCILLATION_SETTLE_MS = 5_000;
const DEFAULT_DISPATCH_OSCILLATION_THRESHOLD = 5;
const DEFAULT_DISPATCH_OSCILLATION_WINDOW_MS = 60_000;

function isCoordinationSafeScopeEntry(entry: string): boolean {
  const normalized = normalizeOverlapPath(entry).toLowerCase();
  if (!normalized) return false;
  if (COORDINATION_SAFE_SCOPE_EXACT.has(normalized)) return true;
  return COORDINATION_SAFE_SCOPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isCoordinationSafeScope(scope: string[]): boolean {
  return scope.length === 0 || scope.every((entry) => isCoordinationSafeScopeEntry(entry));
}

function readBooleanMetadataValue(task: Task, key: string): boolean | undefined {
  const metadata = task.sourceMetadata as Record<string, unknown> | undefined;
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function isCoordinationOnlyTask(task: Task, scope: string[]): boolean {
  const explicitNoCommitSignal = task.noCommitsExpected
    ?? readBooleanMetadataValue(task, "noCommitsExpected")
    ?? readBooleanMetadataValue(task, "decisionOnly");
  if (explicitNoCommitSignal !== true) {
    return false;
  }

  return isCoordinationSafeScope(scope);
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:05 (fleet — scheduler dependency satisfaction):
A dependency's satisfaction is decided on ITS OWN board, because a dependency edge may cross
workflows: the dependent can sit on the default board while the dependency lives on a renamed one.

THE TWO RULES THIS FILE ALREADY HAD, PRESERVED EXACTLY:
  legacy (live)   satisfied = COMPLETE or ARCHIVED or the REVIEW lane (mergeBlocker/humanReview)
  marker (shadow) satisfied = COMPLETE or ARCHIVED, else the handoff marker decides

They genuinely differ on the review lane, and the conversion does NOT reconcile them — that is a
product decision, not a vocabulary one. See the PR body: #2720 settled "satisfied = complete or
archived" for `update-task-deps.ts`, which matches the MARKER rule, so the live legacy rule here is
the broader of the two. Narrowing it silently would strand every dependent of an in-review card.

`columns` is resolved per dependency and passed in by the caller. Omitted (or absent for a given
dependency) → the legacy literals, i.e. exactly today's behaviour, so no unconverted call site
changes meaning and an unresolvable workflow fails soft rather than reading as unsatisfied forever.
*/
export interface DependencySatisfactionColumns {
  /** COMPLETE ∪ ARCHIVED for the dependency's own workflow. */
  terminal: ReadonlySet<string>;
  /** The dependency's own review lane (mergeBlocker ∪ humanReview). */
  review: ReadonlySet<string>;
}

/*
DELIBERATE-LITERAL — the no-metadata fallback, reviewed 2026-07-30-20:40.
Resolved columns win when present; the literal answers only when the caller could not resolve the
dependency's workflow at all. DELETING it does not "finish the conversion" — it makes an
unresolvable workflow read as `terminal.size === 0`, i.e. NEVER satisfied, which blocks every
dependent forever. That is strictly worse than the legacy behaviour it would replace.
*/
function isTerminalDependencyColumn(dep: Task, columns: DependencySatisfactionColumns | undefined): boolean {
  if (columns) return columns.terminal.has(dep.column);
  return dep.column === "done" || dep.column === "archived";
}

/* DELIBERATE-LITERAL — same no-metadata fallback as above, reviewed 2026-07-30-20:40. */
function isLegacyDependencySatisfied(dep: Task | undefined, columns?: DependencySatisfactionColumns): boolean {
  if (!dep) return false;
  if (isTerminalDependencyColumn(dep, columns)) return true;
  if (columns) return columns.review.has(dep.column);
  return dep.column === "in-review";
}

function isMarkerDependencySatisfied(
  dep: Task | undefined,
  markerAccepted: boolean,
  columns?: DependencySatisfactionColumns,
): boolean {
  if (!dep) return false;
  if (isTerminalDependencyColumn(dep, columns)) return true;
  return markerAccepted;
}

/**
 * FNXC:WorkflowLifecycleColumns 2026-07-30-19:05:
 * Build the per-dependency column vocabulary for {@link getUnmetSchedulingDependencies}.
 *
 * `cache` is caller-owned for the reason documented on `resolveTaskLifecycleColumns`: a sweep over
 * many dependents spanning three workflows must read three IRs, not one per dependency. A
 * dependency whose workflow cannot be resolved is simply OMITTED from the map, which lands that
 * dependency on the literal fallback rather than on an empty set (an empty set would read as
 * "never satisfied" and block the dependent forever — the expensive direction to be wrong in).
 */
export async function resolveDependencySatisfactionColumns(
  store: Parameters<typeof resolveWorkflowIrForTask>[0],
  dependencies: readonly Task[],
  cache?: Map<string, WorkflowIr>,
): Promise<Map<string, DependencySatisfactionColumns>> {
  const resolved = new Map<string, DependencySatisfactionColumns>();
  const irCache = cache ?? new Map<string, WorkflowIr>();
  for (const dep of dependencies) {
    try {
      const ir = await resolveWorkflowIrForTask(store, dep.id, irCache);
      if (!ir) continue;
      const terminal = new Set([...columnsWithFlag(ir, "complete"), ...columnsWithFlag(ir, "archived")]);
      const review = new Set([...columnsWithFlag(ir, "mergeBlocker"), ...columnsWithFlag(ir, "humanReview")]);
      if (terminal.size === 0 && review.size === 0) continue;
      resolved.set(dep.id, { terminal, review });
    } catch {
      // Unresolvable workflow: leave it unmapped so this dependency keeps the legacy literals.
    }
  }
  return resolved;
}

export function computeShadowLeaseParityState(mergeRequestState: string | null): {
  shadowExecutorLeaseApplied: boolean;
  shadowMergeLockApplied: boolean;
  shadowLeaseApplied: boolean;
} {
  const shadowExecutorLeaseApplied = false;
  const shadowMergeLockApplied = mergeRequestState !== null
    && mergeRequestState !== "succeeded"
    && mergeRequestState !== "cancelled"
    && mergeRequestState !== "exhausted"
    && mergeRequestState !== "manual-required";
  return {
    shadowExecutorLeaseApplied,
    shadowMergeLockApplied,
    shadowLeaseApplied: shadowExecutorLeaseApplied || shadowMergeLockApplied,
  };
}

export interface SchedulingDependencyParityDiff {
  taskId: string;
  dependencyId: string;
  legacySatisfied: boolean;
  markerSatisfied: boolean;
}

export function getUnmetSchedulingDependencies(
  task: Task,
  tasks: Task[],
  options?: {
    markerAcceptedByTaskId?: Map<string, boolean>;
    onParityDiff?: (diff: SchedulingDependencyParityDiff) => void;
    /**
     * Per-dependency resolved column vocabulary from
     * {@link resolveDependencySatisfactionColumns}. Omitted → the legacy literals.
     */
    satisfactionColumnsByTaskId?: Map<string, DependencySatisfactionColumns>;
  },
): string[] {
  return task.dependencies.filter((depId) => {
    const dep = tasks.find((candidate) => candidate.id === depId);
    if (!dep) return false;
    const satisfactionColumns = options?.satisfactionColumnsByTaskId?.get(depId);
    const legacySatisfied = isLegacyDependencySatisfied(dep, satisfactionColumns);
    const markerSatisfied = isMarkerDependencySatisfied(
      dep,
      options?.markerAcceptedByTaskId?.get(depId) === true,
      satisfactionColumns,
    );
    if (options?.onParityDiff && legacySatisfied !== markerSatisfied) {
      options.onParityDiff({
        taskId: task.id,
        dependencyId: depId,
        legacySatisfied,
        markerSatisfied,
      });
    }
    return !legacySatisfied;
  });
}


/*
FNXC:WorkflowLifecycleColumns 2026-07-28-11:35 (U11 conversion):
A task's HOLD and INTAKE columns, resolved from its own workflow.

The scheduler's event handlers all ask a variant of "is this the backlog?" and
answered it with the literal `"todo"`. That silently stops matching for a renamed
workflow, and stops matching for EVERY workflow once U11 deletes `todo` from the
builtins. Most of these failures are LATENCY rather than incorrectness — a wake
that does not fire costs up to one poll interval — which is precisely why they
would go unnoticed.

Resolution is per task because a board spans workflows. Cost matches existing
practice in this file, which already resolves per task at the dispatch-diagnostic
and worktree-capacity sites; these handlers fire per move/update event, not per
card in a sweep.

Fail-soft to the legacy pair: an unresolvable workflow behaves exactly as before
this conversion rather than losing the wake entirely.
*/
/* SYNCHRONOUS on purpose. These run inside `task:moved` / `task:updated`
   listeners; introducing a new `await` before their existing synchronous work
   defers everything after it to a microtask and reorders handlers relative to a
   synchronous emitter. A file split must not change event ordering, so the
   resolution uses the store's sync IR path. */
/*
FNXC:WorkflowResolvedColumns 2026-07-31-10:10 (fleet: scheduler lifecycle roles):
Widened from {hold,intake} to the full role set. The listeners below ask the same "which lane is
this?" question about wip, review and the terminal columns, and answered it with literals — so on
a renamed board PR monitoring never started or stopped, failure bookkeeping never recorded, and
terminal cleanup never ran. None of those error; they simply stop happening. One resolution per
event, reusing the SAME sync path and the SAME fail-soft legacy defaults, so event ordering and
unresolvable-workflow behaviour are both unchanged.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-12:30:
`terminal` is a MEMBERSHIP set, and it is not the same question as `complete`/`archived`.

`resolveLifecycleColumns` answers FIRST MATCH PER ROLE — the right shape for "where should this card
be moved to", the wrong shape for "did this card just reach a finished lane". A workflow may declare
more than one complete-trait column (a merged lane and a shipped lane, say); `to === parked.complete`
sees only the first and silently skips the rest.

Seeded with the legacy ids. For an INCLUSION that is safe in the direction that matters: a superset
makes the reconciliation below run on a move it would otherwise ignore, which costs one extra query
and cannot wrongly withhold work. (Seeding a REFUSAL is the bug — see `node-override-guard.ts`.)

Same sync IR path and same fail-soft legacy default as the single-column answers, so event ordering
and unresolvable-workflow behaviour are unchanged.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-21:00 (fleet):
Overlay emitter-resolved lanes onto the fail-soft defaults. Only fields the emitter actually resolved
are taken, so a partial payload cannot blank a lane back to a wrong answer.
*/
function mergeParkedColumns(
  base: { hold: string; intake: string; wip: string; review: string; complete: string; archived: string; terminal: ReadonlySet<string> },
  lanes: TaskMoveLanes | undefined,
): { hold: string; intake: string; wip: string; review: string; complete: string; archived: string; terminal: ReadonlySet<string> } {
  if (!lanes) return base;
  const complete = lanes.complete ?? base.complete;
  const archived = lanes.archived ?? base.archived;
  return {
    hold: lanes.hold ?? base.hold,
    intake: lanes.intake ?? base.intake,
    wip: lanes.wip ?? base.wip,
    review: lanes.review ?? base.review,
    complete,
    archived,
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-11:10 (u12 — the overlay NARROWED a membership set):
    This rebuilt `terminal` as `new Set([complete, archived])`, which is first-match-per-role and so
    contradicted the note above ("`terminal` is a MEMBERSHIP set, and it is not the same question as
    `complete`/`archived`"). Two losses in one line: it DISCARDED `base.terminal`, which the sync IR
    path had already resolved correctly, and it had no way to express a second complete-trait column
    even when the emitter knew about one.

    Now a UNION of everything either side proved terminal. That is the direction this file already
    argues for at line ~422: a superset makes the reconciliation run on a move it would otherwise
    ignore — one extra query — while a subset silently withholds work from a card that is finished.
    */
    terminal: new Set([...base.terminal, ...(lanes.terminal ?? []), complete, archived]),
  };
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-06:35 (fleet):
The ASYNC twin. The sync one below cannot answer for a custom workflow in production, so any guard that
can reach this one must.

THE CRITERION IS WHETHER THE ANSWER IS CONSUMED SYNCHRONOUSLY, not whether the enclosing listener is
declared sync — I got that wrong earlier in this program and it cost a revert. The three call sites
converted to this all fail that test: two only feed `schedule()`, which is itself `async`,
fire-and-forget and re-entrance-guarded, and the third already sits below an `await getSettings()`.
Deferring them by a microtask changes nothing observable.

Same fail-soft legacy default as its sync twin, so an unresolvable workflow behaves exactly as before.
*/
const LEGACY_PARKED_COLUMNS = {
  hold: "todo",
  intake: "triage",
  wip: "in-progress",
  review: "in-review",
  complete: "done",
  archived: "archived",
  terminal: new Set(["done", "archived"]),
};

async function resolveTaskParkedColumns(store: TaskStore, taskId: string): Promise<{ hold: string; intake: string; wip: string; review: string; complete: string; archived: string; terminal: ReadonlySet<string>; wake: ReadonlySet<string> }> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    const l = resolveLifecycleColumns(ir);
    const complete = l?.complete ?? LEGACY_PARKED_COLUMNS.complete;
    const archived = l?.archived ?? LEGACY_PARKED_COLUMNS.archived;
    return {
      hold: l?.hold ?? LEGACY_PARKED_COLUMNS.hold,
      intake: l?.intake ?? LEGACY_PARKED_COLUMNS.intake,
      wip: l?.wip ?? LEGACY_PARKED_COLUMNS.wip,
      review: l?.review ?? LEGACY_PARKED_COLUMNS.review,
      complete,
      archived,
      terminal: new Set([
        ...LEGACY_PARKED_COLUMNS.terminal,
        ...columnsWithFlag(ir, "complete"),
        ...columnsWithFlag(ir, "archived"),
        complete,
        archived,
      ]),
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-06:35 (fleet):
      The wake set UNIONS the legacy ids rather than replacing them, and that is load-bearing rather
      than defensive. Post-U11 the default lineage has no `triage` column, so a RESOLVED answer returns
      `intake: "todo"` where the old inert path fell back to `"triage"`. Converting without the union
      therefore NARROWS the set and stops waking cards that sit in a legacy-named lane — caught by
      `scheduler-planning-finished-wake.test.ts` -> "schedules when planning clears in triage".

      A resolved conversion must be a superset of what it replaces, or it is a behaviour change wearing
      a vocabulary change's clothes.
      */
      wake: new Set([l?.hold ?? LEGACY_PARKED_COLUMNS.hold, l?.intake ?? LEGACY_PARKED_COLUMNS.intake, LEGACY_PARKED_COLUMNS.hold, LEGACY_PARKED_COLUMNS.intake]),
    };
  } catch {
    return {
      ...LEGACY_PARKED_COLUMNS,
      terminal: new Set(LEGACY_PARKED_COLUMNS.terminal),
      wake: new Set([LEGACY_PARKED_COLUMNS.hold, LEGACY_PARKED_COLUMNS.intake]),
    };
  }
}

export function shouldHoldActiveFileScopeLease(
  task: Task,
  tasks: Task[],
  options?: {
    mergeRequestContractShadowEnabled?: boolean;
    handoffAccepted?: boolean;
    schedulingDependencyOptions?: Parameters<typeof getUnmetSchedulingDependencies>[2];
    /** Resolved role answers. Omitted → the legacy column-id literals, i.e. today's behaviour. */
    isWipColumn?: boolean;
    isReviewColumn?: boolean;
  },
): boolean {
  /*
  FNXC:OverlapScheduling 2026-06-25-04:34:
  Active file-scope leases are a scheduler contract, not just a column check. Self-healing and repair paths must use this same predicate so stale `overlapBlockedBy` cleanup does not preserve blockers the scheduler would ignore on the next tick.
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:00:
  The two ROLE questions are parameters with literal defaults, not hard-coded ids.

  This predicate decides whether a card holds an active file-scope lease, and it was keyed on
  `column === "in-progress"` / `!== "in-review"`. On a board whose columns are renamed, BOTH branches
  fell through and the function returned false for every card, so `activeScopes` stayed empty and the
  dispatch path saw no overlap — two agents editing the same files, which is exactly what
  `groupOverlappingFiles` prevents. Capacity arithmetic in the same sweep already resolved
  `countsTowardWip` from the IR, so the scheduler was simultaneously right about capacity and wrong
  about leases.

  Why optional booleans rather than a flags object: this is an EXPORTED predicate shared with the
  self-healing / repair paths (see the note below), which must keep agreeing with the scheduler. A
  caller that has resolved the column's traits passes the answer; a caller that has not gets exactly
  today's behaviour, so no existing call site changes meaning. Covered by
  scheduler-renamed-wip-file-scope-lease.test.ts.
  */
  if (task.paused || task.userPaused) return false;
  /*
  FNXC:OverlapScheduling 2026-08-01-19:22:
  A failed park is not live work. Review already dropped status:"failed"; WIP must too, or a
  stranded failed in-progress card keeps its file-scope lease and serializes unrelated todos
  while consuming no real agent (same class as the capacity-holder fix in isRunningAgentTask).
  */
  if (task.status === "failed") return false;
  /*
  DELIBERATE-LITERAL — the documented default for an unconverted caller, reviewed 2026-07-30-20:40.
  Both scheduler call sites now pass the resolved answer, so these defaults are dead on the
  scheduler's own path; they exist for the self-healing / repair callers this predicate is shared
  with. Removing them would silently change those callers' meaning, which is the coupling the
  optional-parameter shape exists to avoid.
  */
  const isWipColumn = options?.isWipColumn ?? task.column === "in-progress";
  /* DELIBERATE-LITERAL — the review half of the same shared-caller default. */
  const isReviewColumn = options?.isReviewColumn ?? task.column === "in-review";
  if (isWipColumn) {
    return getUnmetSchedulingDependencies(task, tasks, options?.schedulingDependencyOptions).length === 0;
  }
  if (!isReviewColumn) return false;
  if (!task.worktree || task.status === "failed") return false;
  if (options?.mergeRequestContractShadowEnabled === true && options.handoffAccepted === true) return false;
  return true;
}

export function findHigherPriorityQueuedOverlap(
  candidate: QueuedOverlapCandidate,
  queuedScopes: QueuedOverlapCandidate[],
  overlap: (a: string[], b: string[]) => boolean,
): QueuedOverlapCandidate | null {
  let higher: QueuedOverlapCandidate | null = null;

  for (const queued of queuedScopes) {
    if (queued.id === candidate.id) continue;
    if (!queued.scope.length || !candidate.scope.length) continue;
    if (!overlap(candidate.scope, queued.scope)) continue;

    if (compareTasksByPriorityThenAgeAndId(queued, candidate) < 0) {
      if (!higher || compareTasksByPriorityThenAgeAndId(queued, higher) < 0) {
        higher = queued;
      }
    }
  }

  return higher;
}

type ConcurrencyGateName = "maxConcurrent" | "maxWorktrees" | "semaphore";

interface ConcurrencyGateSnapshot {
  used: number;
  limit: number;
  slack: number;
}

/**
 * U6 (KTD-10): a per-(workflow, column) capacity gate, the generalization of the
 * three legacy gates to workflow-defined WIP columns. Additive — the three-gate
 * report shape (maxConcurrent/maxWorktrees/semaphore) is preserved verbatim; this
 * is an optional extra field populated only when the workflowColumns flag is ON.
 */
interface PerColumnCapacityGate {
  workflowId: string;
  columnId: string;
  used: number;
  limit: number;
  slack: number;
}

interface ConcurrencyGateDiagnostic {
  available: number;
  bindingGates: ConcurrencyGateName[];
  maxConcurrentGate: ConcurrencyGateSnapshot;
  /*
  FNXC:CapacityModel 2026-07-28-11:35:
  OPTIONAL because worktrees can be turned off as a capacity dimension
  (`settings.worktreeLimitEnabled === false` → "limit via total agents only").

  When off, this field is ABSENT — there is no worktree gate object, not a gate
  holding Infinity and not a comparison skipped by convention. That is deliberate
  and is the operator's explicit requirement: an inert limiter must be incapable
  of binding, not merely unlikely to. Optionality moves the guarantee into the
  type system — `diagnostic.maxWorktreesGate.limit` does not compile without a
  presence check, so a future edit cannot reintroduce a silent worktree
  comparison in OFF mode. `bindingGates` can never contain "maxWorktrees" there.
  */
  maxWorktreesGate?: ConcurrencyGateSnapshot;
  semaphoreGate?: ConcurrencyGateSnapshot;
  holders: {
    maxConcurrent: string[];
    maxWorktrees?: string[];
    semaphore?: string[];
  };
  /** U6: additive per-column capacity gates (flag-ON only; omitted otherwise so
   *  the legacy three-gate report shape is byte-identical when the flag is OFF). */
  perColumnGates?: PerColumnCapacityGate[];
}

function recoverIdleSemaphoreLeak(
  semaphore: AgentSemaphore | undefined,
  tasks: Task[],
  source: string,
  candidateSinceMs: number | null,
  inFlightCount: number = 0,
): number | null {
  const result = recoverIdleSemaphoreLeakCandidate({
    semaphore,
    tasks,
    candidateSinceMs,
    inFlightCount,
  });
  if (result.reconciliation?.changed) {
    schedulerLog.warn(
      `${source}: recovered stale semaphore active count ${result.reconciliation.before} -> ${result.reconciliation.after} ` +
      "(semaphore over-held vs persisted+in-flight top-level agent work)",
    );
  }
  return result.candidateSinceMs;
}

function computeConcurrencyGateDiagnostic(params: {
  agentSlots: number;
  maxConcurrent: number;
  activeWorktrees: number;
  /*
  FNXC:CapacityModel 2026-07-28-11:35:
  `null` means worktrees are not a capacity dimension for this project
  (`settings.worktreeLimitEnabled === false`) — NOT "unlimited". Callers resolve it
  through `resolveWorktreeCapacityLimit` so the OFF convention has exactly one
  expression; passing a raw number here cannot accidentally re-enable the gate
  because the resolver is the only thing that produces this value.
  */
  maxWorktrees: number | null;
  semaphore?: AgentSemaphore;
  inProgressTaskIds: string[];
  startedThisTick?: number;
  /**
   * Live top-level running-agent claim (planning + in-progress + active in-review,
   * optionally merged with semaphore.activeCount). When provided, the shared
   * semaphore gate uses this instead of only in-progress agentSlots.
   */
  topLevelClaimedSlots?: number;
  /** FNXC:WorktreeCapacity 2026-08-01-04:38: active task ids occupying worktree-capacity slots. */
  worktreeHolderTaskIds?: string[];
  /** U6: additive per-column capacity gates (flag-ON only). Omitted → the legacy
   *  three-gate report is byte-identical. */
  perColumnGates?: PerColumnCapacityGate[];
}): ConcurrencyGateDiagnostic {
  const startedThisTick = Math.max(0, Math.floor(params.startedThisTick ?? 0));
  const maxConcurrentUsed = params.agentSlots + startedThisTick;
  const maxWorktreesUsed = params.activeWorktrees + startedThisTick;
  const maxConcurrentGate: ConcurrencyGateSnapshot = {
    used: maxConcurrentUsed,
    limit: params.maxConcurrent,
    slack: params.maxConcurrent - maxConcurrentUsed,
  };
  // Worktrees off → no gate object at all. See the FNXC on `maxWorktreesGate`.
  const maxWorktreesLimit = params.maxWorktrees;
  const maxWorktreesGate: ConcurrencyGateSnapshot | undefined =
    maxWorktreesLimit === null
      ? undefined
      : {
        used: maxWorktreesUsed,
        limit: maxWorktreesLimit,
        slack: maxWorktreesLimit - maxWorktreesUsed,
      };
  const semaphoreGate = params.semaphore
    ? (() => {
      /*
      FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
      Global semaphore pressure must include every live top-level agent holder (planning triage and active in-review), not only in-progress WIP, otherwise the hold/release sweep can admit an executor on top of a full planner fleet and the footer shows running > cap.
      */
      const claimed = params.topLevelClaimedSlots
        ?? Math.max(0, params.semaphore.activeCount, params.agentSlots);
      const used = Math.max(0, claimed) + startedThisTick;
      return {
        used,
        limit: params.semaphore.limit,
        slack: params.semaphore.limit - used,
      };
    })()
    : undefined;
  const available = Math.min(
    maxConcurrentGate.slack,
    maxWorktreesGate?.slack ?? Infinity,
    semaphoreGate?.slack ?? Infinity,
  );

  const bindingGates: ConcurrencyGateName[] = [];
  if (maxConcurrentGate.used >= maxConcurrentGate.limit) bindingGates.push("maxConcurrent");
  if (maxWorktreesGate && maxWorktreesGate.used >= maxWorktreesGate.limit) bindingGates.push("maxWorktrees");
  if (semaphoreGate && semaphoreGate.used >= semaphoreGate.limit) bindingGates.push("semaphore");

  return {
    available,
    bindingGates,
    maxConcurrentGate,
    maxWorktreesGate,
    semaphoreGate,
    holders: {
      maxConcurrent: [...params.inProgressTaskIds],
      maxWorktrees: maxWorktreesGate ? [...(params.worktreeHolderTaskIds ?? params.inProgressTaskIds)] : undefined,
      semaphore: semaphoreGate ? [...params.inProgressTaskIds] : undefined,
    },
    // U6: additive only — present when flag-ON, omitted otherwise.
    ...(params.perColumnGates ? { perColumnGates: params.perColumnGates } : {}),
  };
}

function formatConcurrencyLimitReason(diagnostic: ConcurrencyGateDiagnostic): string {
  const holdersText = (gate: ConcurrencyGateName): string => {
    const holders = diagnostic.holders[gate];
    return holders && holders.length > 0 ? holders.join(", ") : "none";
  };
  const gateLabel = diagnostic.bindingGates.join(", ");
  const details = [
    `maxConcurrent used=${diagnostic.maxConcurrentGate.used}/${diagnostic.maxConcurrentGate.limit} (holders: ${holdersText("maxConcurrent")})`,
  ];
  /*
  FNXC:CapacityModel 2026-07-28-11:35:
  Omit the worktree line entirely when worktrees are off. Printing
  "maxWorktrees used=2/Infinity" would tell an operator a limiter is present and
  merely generous, which is the opposite of true — it is not consulted at all.
  This string is the operator's answer to "why is my card queued?", so an absent
  dimension must be absent from the answer.
  */
  if (diagnostic.maxWorktreesGate) {
    details.push(
      `maxWorktrees used=${diagnostic.maxWorktreesGate.used}/${diagnostic.maxWorktreesGate.limit} (holders: ${holdersText("maxWorktrees")})`,
    );
  }
  if (diagnostic.semaphoreGate) {
    const semaphoreUsed = Math.max(0, diagnostic.semaphoreGate.used);
    details.push(
      `semaphore used=${semaphoreUsed}/${diagnostic.semaphoreGate.limit} (holders: ${holdersText("semaphore")}; note: semaphore slots may include triage/merge agents outside in-progress)`,
    );
  }
  return `queued — concurrency limit reached: gate=${gateLabel}; ${details.join("; ")}`;
}

export function formatConcurrencyLimitMemoKey(diagnostic: ConcurrencyGateDiagnostic): string {
  const gates = diagnostic.bindingGates.join(",");
  return `queued-concurrency:${gates || "none"}`;
}

export interface SchedulerOptions {
  /** Max concurrent in-progress tasks. Default: 2 */
  maxConcurrent?: number;
  /** Max worktrees for active (in-progress) tasks. Default: 4 */
  maxWorktrees?: number;
  /** Milliseconds between scheduling polls. Default: 15000 */
  pollIntervalMs?: number;
  /**
   * Shared concurrency semaphore. When provided, the scheduler uses
   * `semaphore.availableCount` to avoid scheduling more tasks than the
   * global concurrency limit allows (accounting for triage and merge
   * agents that also hold slots).
   */
  semaphore?: AgentSemaphore;
  /** Optional AgentStore for durable-agent state rollback during overlap requeue. */
  agentStore?: AgentStore;
  /** Optional live executor signal that preserves parked durable-agent links while work is truly active. */
  hasActiveAgentExecution?: (agentId: string) => boolean;
  /** Called when scheduler starts a task */
  onSchedule?: (task: Task) => void;
  /** Called when a task is blocked by deps */
  onBlocked?: (task: Task, blockedBy: string[]) => void;
  /** Called when a mission-linked task fails and is queued for retry handling. */
  onTaskFailed?: (taskId: string) => void | Promise<void>;
  /** Optional PR monitor for tracking in-review PRs */
  prMonitor?: PrMonitor;
  /** Optional MissionStore for slice activation and auto-advance */
  missionStore?: MissionStore | AsyncMissionStore;
  /** Optional lease manager used to recover stale checkout leases before scheduling. */
  leaseManager?: MeshLeaseManager;
  /** Optional MissionAutopilot for autonomous mission progression */
  missionAutopilot?: import("./missions/mission-autopilot.js").MissionAutopilot;
  /**
   * Called when a task with a closed/merged PR moves out of in-review
   * and the PrMonitor has buffered actionable comments.
   * The callback receives the task ID, PR info, and the drained comments.
   * If no comments were buffered, this callback is NOT invoked.
   */
  onClosedPrFeedback?: (
    taskId: string,
    prInfo: PrInfo,
    comments: PrComment[]
  ) => void | Promise<void>;
  /** Optional MissionExecutionLoop for validation cycle handling */
  missionExecutionLoop?: import("./missions/mission-execution-loop.js").MissionExecutionLoop;
  /** Optional NodeHealthMonitor for node health checks during dispatch.
   *  Reserved for FN-2722-C (unavailable node policy enforcement).
   *  Accepted here so the option can be wired at construction time. */
  nodeHealthMonitor?: import("./project/node-health-monitor.js").NodeHealthMonitor;
  /** Optional dispatch validator used to block dispatch on configuration issues before health policy checks. */
  validateNodeDispatch?: (nodeId: string) => Promise<NodeDispatchValidationResult>;
  /** Local node identifier used to distinguish self-owned leases from foreign-owned leases. Default: "local". */
  localNodeId?: string;
  /** Optional shared auto-claim snapshot manager for invalidation on task mutations. */
  snapshotManager?: AutoClaimSnapshotManager;
  /**
   * FNXC:GlobalConcurrencyControls 2026-07-17-00:00:
   * Live count of top-level triage sessions that already hold a semaphore slot
   * but have not yet persisted `status:"planning"` (pre-planning `processing`
   * entries). Read lazily on each scheduling pass and fed into stale-semaphore
   * recovery as `inFlightCount` so the scheduler's reclaim bound never undercounts
   * a live triage acquire — otherwise a pre-planning triage slot would look like
   * leaked excess (bound=0 → fast idle window) and get released, admitting an
   * agent above the configured limit (Greptile PR #2265, "Scheduler Omits Live
   * Triage Slots"). Matches the triage service's own `inFlightCount` semantics.
   */
  getInFlightTopLevelCount?: () => number;
}

/**
 * Scheduler watches the "todo" column and moves tasks to "in-progress"
 * when their dependencies are satisfied and concurrency allows.
 *
 * It respects:
 * - Dependency ordering (tasks depending on others wait)
 * - Concurrency limits (max N tasks in-progress at once)
 *
 * **Dynamic settings reload:** On every `schedule()` call the scheduler
 * reads `maxConcurrent`, `maxWorktrees`, and `pollIntervalMs` from the
 * persisted store settings (`store.getSettings()`).  This means changes
 * made via the dashboard Settings modal (`PUT /settings`) take effect on
 * the very next poll cycle without an engine restart.  The poll interval
 * itself is also refreshed: if `pollIntervalMs` differs from the active
 * timer, the `setInterval` is transparently restarted.
 */
function releaseReservedSlot(reservedSlots: number): number {
  return Math.max(0, reservedSlots - 1);
}

/**
 * FNXC:DependencyUnblock 2026-08-10-08:20:
 * Dependency auto-unblock clears ONLY the `queued` blocked marker it owns — never an arbitrary lifecycle status.
 *
 * Both unblock paths used to write `status: null` unconditionally, meaning to undo the `status: "queued"` the
 * blocked branch sets a few lines up. But `status` is a shared lifecycle channel, and the value most likely to
 * be sitting there is `needs-replan` — the graph's durable replan signal, and the ONLY thing that re-admits a
 * hold-column card to planning (`isTaskAwaitingPlanning` refuses a card whose PROMPT.md is already a real spec).
 *
 * FN-8923 died exactly here. Its plan node held on principal routing, triage correctly recorded
 * `needs-replan`, and then its blocker completing nulled that status. From that moment the card was invisible
 * to BOTH lanes: triage saw a fully-written spec with no replan flag and skipped it, while the executor's
 * `isUnplannedForExecution` still refused to dispatch because no capacity-boundary continuation existed. It sat
 * silent in Todo for 7+ hours with zero run-audit rows — not stuck in a retry loop, simply unowned.
 */
export function clearBlockedStatusOnly(dependent: Pick<Task, "status">): { status: null } | Record<string, never> {
  return dependent.status === "queued" || dependent.status == null ? { status: null } : {};
}

export class Scheduler {
  private running = false;
  private scheduling = false;
  private schedulingSince = 0;
  private wasWorktreeLimited = false;
  private wasGlobalPaused = false;
  private wasEnginePaused = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** The interval (ms) of the currently active `setInterval` timer. */
  private activePollMs: number | null = null;
  /** Tracks which task IDs are currently paused, to detect unpause transitions. */
  private pausedTaskIds = new Set<string>();
  /**
   * FNXC:CodingIdeasWorkflow 2026-07-25-13:10:
   * Tracks task IDs last seen with status "planning", so the planning -> dispatchable transition
   * can trigger an immediate scheduling pass. Plan-in-place workflows clear status without a
   * task:moved, so this is the only signal that the card just became executable.
   */
  private planningTaskIds = new Set<string>();
  /*
  FNXC:PlanReviewApproval 2026-08-04-00:26:
  Wake dispatch on the observed hold edge or the durable approval marker. The latter covers a
  restart or cross-process update that did not deliver the earlier awaiting-approval event.
  */
  private approvalHeldTaskIds = new Set<string>();
  private approvalReleasedTaskIds = new Set<string>();
  /** Tracks mission-linked tasks observed with status=failed before moveTask clears status/error. */
  private failedTaskIds = new Set<string>();
  /** Tracks tasks blocked by unavailable-node policy to deduplicate block log entries. */
  private wasNodeBlocked = new Set<string>();
  /** Tracks tasks blocked by missing project-node mapping to deduplicate block log entries. */
  private wasNodeDispatchValidationBlocked = new Set<string>();
  /** Tracks tasks queued due to missing permanent executors when ephemeral workers are disabled. */
  private wasPermanentAgentUnavailable = new Set<string>();
  /** Tracks dispatch-queued reason signatures to avoid per-tick log spam. */
  private wasDispatchQueuedReasonLogged = new Set<string>();
  /** Tracks per-task symbol-lock renewal outcomes so a persistent loss/error reports once, not once per poll. */
  private readonly symbolLockRenewalLog = createRepeatSuppressedLog();
  /** Tracks per-task candidacy fingerprints for task:updated auto-claim invalidation gating. */
  private lastAutoClaimFingerprint = new Map<string, string>();
  /** Tracks recent engine-sourced in-progress → todo requeues to prevent immediate re-dispatch races. */
  private recentEngineTodoRequeues = new Map<string, string>();
  private readonly staleTaskReporter: StaleTaskReporter;
  private readonly backlogPressureReporter: BacklogPressureReporter;
  private readonly unlinkedMissionsAdvisoryReporter: UnlinkedMissionsAdvisoryReporter;
  private lastStaleTaskReportAt = 0;
  private lastBacklogPressureReportAt = 0;
  private lastUnlinkedMissionsAdvisoryReportAt = 0;
  private lastHeartbeatWriteMs = 0;
  private idleSemaphoreLeakCandidateSince: number | null = null;
  private readonly lastHighOverlapFanoutWarningKey = new Map<string, string>();
  /** Coordinator reservations survive the lane poll that selected them. */
  private readonly coordinatorAdmittedTaskIds = new Set<string>();
  /** Durable execute candidates refreshed on each scheduler pass for cross-lane ranking. */
  private readonly coordinatorReadyTasks = new Map<string, Task>();
  private unregisterAdmissionProvider?: () => void;

  /**
   * Async listener guard convention:
   * - Any async mission helper invoked from event listeners is wrapped in internal try/catch
   *   (`handleMissionTaskMove` / `handleMissionTaskCompletion`).
   * - Fire-and-forget Promise chains in listeners terminate with `.catch(...)`.
   * Keep this invariant when adding new async EventEmitter callbacks.
   */
  constructor(
    private store: TaskStore,
    private options: SchedulerOptions = {},
  ) {
    this.staleTaskReporter = new StaleTaskReporter({ store: this.store });
    this.backlogPressureReporter = new BacklogPressureReporter({
      store: this.store,
      projectId: this.store.getRootDir(),
      logger: schedulerLog,
    });
    this.unlinkedMissionsAdvisoryReporter = new UnlinkedMissionsAdvisoryReporter({
      store: this.store,
      projectId: this.store.getRootDir(),
      logger: schedulerLog,
    });
    /*
    FNXC:ConcurrencyAdmission 2026-07-21-22:30:
    FN-8453's union must outlive a single scheduler poll. A temporary provider
    was gone before planning/merge asked for capacity, allowing newer work to
    overtake ready execute work. The refreshed map is the durable lane view.
    */
    const projectId = this.store.getRootDir();
    this.unregisterAdmissionProvider = projectAdmissionCoordinator.registerProvider(`execute:${projectId}`, {
      projectId,
      refresh: async () => [...this.coordinatorReadyTasks.values()]
        .filter((task) => !this.coordinatorAdmittedTaskIds.has(task.id))
        .map((task) => ({
          taskId: task.id,
          projectId,
          lane: "execute",
          createdAt: task.createdAt,
          reserve: () => registerPreHeldExecutorSlot(task.id, this.options.semaphore !== undefined),
          start: async () => {
            this.coordinatorReadyTasks.delete(task.id);
            this.coordinatorAdmittedTaskIds.add(task.id);
            void this.schedule();
          },
        })),
    });
    /**
     * Event-driven scheduling: when a task is created, trigger a scheduling
     * pass immediately instead of waiting for the next poll interval.
     * This reduces latency from up to 15 seconds to near-instant.
     */
    this.store.on("task:created", (task) => {
      this.lastAutoClaimFingerprint.set(task.id, computeAutoClaimFingerprint(task));
      this.options.snapshotManager?.invalidate("task:created");
      /*
      FNXC:EngineDiagnostics 2026-08-03-05:54:
      Event-driven schedule triggers fire on every create/done; the card transition is already
      visible on the board and via task:moved logs. Keep the trigger line debug-only.
      */
      schedulerLog.debug("Task created — triggering scheduling");
      this.schedule();
    });

    /**
     * Immediate unpause resume: when `globalPause` transitions from `true`
     * to `false`, trigger a scheduling pass right away instead of waiting
     * for the next poll interval (up to 15 s). Only reacts to true→false
     * transitions — no-ops on false→false and true→true.
     *
     * The re-entrance guard (`this.scheduling`) inside `schedule()` safely
     * drops the call if a poll-based pass is already in flight.
     */
    this.store.on("settings:updated", ({ settings, previous }) => {
      if (previous.globalPause && !settings.globalPause && this.running) {
        this.schedule();
      }
    });

    /**
     * Immediate soft-unpause resume: when `enginePaused` transitions from
     * `true` to `false`, trigger a scheduling pass right away instead of
     * waiting for the next poll interval. Same pattern as the globalPause
     * unpause handler above.
     */
    this.store.on("settings:updated", ({ settings, previous }) => {
      if (previous.enginePaused && !settings.enginePaused && this.running) {
        this.schedule();
      }
    });

    /**
     * PR Monitoring: Start monitoring when a task moves to "in-review",
     * stop monitoring when it moves out.
     * 
     * Also handles mission auto-advance: when a linked task completes,
     * update feature status and potentially activate next pending slice.
     */
    this.store.on("task:moved", async ({ task, from, to, source, lanes }) => {
      this.lastAutoClaimFingerprint.set(task.id, computeAutoClaimFingerprint(task));
      /*
      FNXC:WorkflowResolvedColumns 2026-08-01-05:01:
      The synchronous prologue must remain in the emitter tick: snapshot invalidation, PR monitor
      transitions, mission hand-off, and failure tracking are ordered by
      `scheduler-auto-claim-invalidation.test.ts`. It therefore reads emitter-carried lanes over
      legacy defaults without awaiting. The two SQLite polling-replica emitters that carry no lanes
      retain that legacy behavior; PostgreSQL emitters carry lanes.

      Every later arm is already behind an await, so it resolves the task's workflow asynchronously
      instead of consulting the production-inert sync resolver. This covers forwarded or lane-less
      payloads without changing synchronous ordering. Terminal remains a membership union so a second
      complete-trait column reconciles dependents too.
      */
      const parked = mergeParkedColumns(LEGACY_PARKED_COLUMNS, lanes);
      if (from === parked.hold || to === parked.hold) {
        this.options.snapshotManager?.invalidate(`task:moved:${from}->${to}`);
      }
      // PR Monitoring
      if (this.options.prMonitor) {
        if (to === parked.review && task.prInfo) {
          // Start monitoring existing PR
          const repo = getCurrentRepo(this.store.getRootDir());
          if (repo) {
            this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
          }
        } else if (from === parked.review && to !== parked.review) {
          // If task has a closed/merged PR, drain buffered comments before
          // stopping monitoring (drainComments needs the tracked PR to still exist)
          if (task.prInfo && (task.prInfo.status === "closed" || task.prInfo.status === "merged")) {
            const comments = this.options.prMonitor.drainComments(task.id);
            if (comments.length > 0 && this.options.onClosedPrFeedback) {
              void Promise.resolve(this.options.onClosedPrFeedback(task.id, task.prInfo, comments))
                .then(() => {
                  schedulerLog.log(`Invoked onClosedPrFeedback for ${task.id} with ${comments.length} comment(s)`);
                })
                .catch((err) => {
                  schedulerLog.error(`Error in onClosedPrFeedback for ${task.id}:`, err);
                });
            }
          }

          // Task moved out of in-review, stop monitoring
          this.options.prMonitor.stopMonitoring(task.id);
        }
      }

      // Mission progress tracking. Resolve by linked feature instead of only
      // task.sliceId so older one-way-linked mission tasks are kept in sync too.
      if (this.options.missionStore) {
        void this.handleMissionTaskMove(task.id, to);
      }

      // Mission failure tracking: status/error are cleared during moveTask(in-progress → todo),
      // so we pair this with failedTaskIds captured from task:updated events.
      if (task.sliceId && to === parked.hold && this.options.onTaskFailed) {
        if (task.status === "failed" || this.failedTaskIds.has(task.id)) {
          this.failedTaskIds.delete(task.id);
          void Promise.resolve(this.options.onTaskFailed(task.id)).catch((err) => {
            schedulerLog.error(`Error in onTaskFailed for ${task.id}:`, err);
          });
        }
      }

      /*
      FNXC:SchedulerDispatchOscillation 2026-08-02-17:20:
      The settle-window ledger (`recentEngineTodoRequeues`) and the dispatch-oscillation reset are
      CONSUMED SYNCHRONOUSLY, so they must stay in the emitter tick with the rest of the synchronous
      prologue — reading the sync, emitter-lane-aware `parked`, never the async `resolvedParked`.
      FN-8656 moved these two arms behind `await resolveTaskParkedColumns` while converting lane
      lookups; that broke the ordering against the synchronous `task:deleted`/`task:updated`
      handlers, which also mutate `recentEngineTodoRequeues`/oscillation state. Concretely: a card
      requeued to hold then deleted in the same tick had its settle-window SET run a microtask AFTER
      the delete's synchronous CLEAR, so the guard survived deletion and the card never re-dispatched
      (todo-inprogress-flapping.test.ts "clears the settle-window guard when the task is deleted" and
      "resets dispatch oscillation state on forward transition to in-review"). This obeys FN-8656's
      own stated rule: convert to the async resolver ONLY where the answer is consumed asynchronously.
      Production emitters carry lanes, so `parked` resolves renamed hold/wip/review columns here too;
      the lane-less SQLite polling emitters retain the legacy fallback exactly as before.
      */
      if (from === parked.wip && to === parked.hold) {
        if (source === "engine") {
          this.recentEngineTodoRequeues.set(task.id, task.columnMovedAt ?? new Date().toISOString());
        } else {
          this.recentEngineTodoRequeues.delete(task.id);
        }
      } else if (to === parked.review || parked.terminal.has(to)) {
        this.recentEngineTodoRequeues.delete(task.id);
        if (task.dispatchStormCount != null || task.lastDispatchAt != null || task.executeRequeueLoopCount != null || task.executeRequeueLoopSignature != null) {
          void this.store.updateTask(task.id, {
            dispatchStormCount: null,
            lastDispatchAt: null,
            executeRequeueLoopCount: null,
            executeRequeueLoopSignature: null,
          }).catch((error) => {
            schedulerLog.warn(`Failed to reset dispatch oscillation state for ${task.id} on move to ${to}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }

      const resolvedParked = mergeParkedColumns(await resolveTaskParkedColumns(this.store, task.id), lanes);

      // FN-3895/FN-3924: complement periodic stale-blockedBy self-healing with immediate
      // blocker reconciliation when a potential blocker reaches a terminal completion column.
      // Invariant: blockedBy must reference a *current* unresolved blocker, else be null.
      if (resolvedParked.terminal.has(to)) {
        try {
          const settings = await this.store.getSettings();
          if (!settings.globalPause && !settings.enginePaused) {
            const todoTasks = await this.store.listTasks({ column: resolvedParked.hold, slim: true });
            /* One IR cache for the whole reconciliation, per the caller-owned-cache contract. */
            const dependencySatisfactionIrCache = new Map<string, WorkflowIr>();
            for (const dependent of todoTasks) {
              const mentionsCompletedTask = dependent.dependencies.includes(task.id);
              const currentlyBlockedByCompletedTask = dependent.blockedBy === task.id;
              if (!mentionsCompletedTask && !currentlyBlockedByCompletedTask) continue;

              const markerAcceptedByTaskId = settings.mergeRequestContractShadowEnabled === true
                ? new Map(await Promise.all(dependent.dependencies.map(async (depId) => [depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null] as const)))
                : undefined;
              /*
              FNXC:SchedulerArchiveReads 2026-07-14-19:10:
              Dependency reconciliation is event-scoped. Resolve only the dependent's referenced IDs so one completed task cannot make the scheduler download and parse the entire cold archive.
              */
              const dependencyTasks = (await Promise.all(
                dependent.dependencies.map((dependencyId) => this.store.getTask(dependencyId).catch(() => null)),
              )).filter((candidate) => candidate !== null);
              const satisfactionColumnsByTaskId = await resolveDependencySatisfactionColumns(
                this.store,
                [task, ...dependencyTasks],
                dependencySatisfactionIrCache,
              );
              const unresolvedDeps = getUnmetSchedulingDependencies(
                dependent,
                [dependent, task, ...dependencyTasks],
                {
                  satisfactionColumnsByTaskId,
                  ...(markerAcceptedByTaskId
                    ? {
                      markerAcceptedByTaskId,
                      onParityDiff: (diff: SchedulingDependencyParityDiff) => {
                        this.emitDependencyParityDiff(diff);
                      },
                    }
                    : {}),
                },
              );

              try {
                if (unresolvedDeps.length > 0) {
                  await this.store.updateTask(dependent.id, {
                    status: "queued",
                    blockedBy: unresolvedDeps[0],
                  });
                  await this.store.logEntry(
                    dependent.id,
                    `Auto-reblocked: unresolved dependency ${unresolvedDeps[0]} remains after ${task.id} reached ${to}`,
                  );
                } else {
                  await this.store.updateTask(dependent.id, { blockedBy: null, ...clearBlockedStatusOnly(dependent) });
                  const unblockMessage = currentlyBlockedByCompletedTask
                    ? `Auto-unblocked: blocker ${task.id} reached ${to}`
                    : `Auto-unblocked: blocker ${task.id} reached ${to} — all dependencies satisfied`;
                  await this.store.logEntry(dependent.id, unblockMessage);
                }
              } catch (error) {
                schedulerLog.error(
                  `Failed to reconcile dependent ${dependent.id} for blocker ${task.id}`,
                  error,
                );
              }
            }
          }
        } catch (error) {
          schedulerLog.error(`Failed event-driven blocker reconciliation for ${task.id}`, error);
        }
      }

      // Event-driven scheduling: when a task moves to "done" (completion) or "todo" (retry/manual move),
      // trigger scheduling immediately so waiting tasks can start without waiting
      // for the next poll interval (up to 15 seconds).
      if (resolvedParked.terminal.has(to) || to === resolvedParked.hold) {
        /*
        FNXC:EngineDiagnostics 2026-08-03-05:54:
        Duplicate of the column-move lifecycle line; schedule side-effect is not operator-facing.
        */
        schedulerLog.debug(`Task moved to ${to} — triggering scheduling`);
        this.schedule();
      }
    });

    /**
     * PR Monitoring: Start monitoring when PR is linked to an in-review task.
     * Also detects task-level unpause transitions and triggers immediate scheduling.
     */
    this.store.on("task:updated", (task, meta) => {
      const nextFingerprint = computeAutoClaimFingerprint(task);
      const previousFingerprint = this.lastAutoClaimFingerprint.get(task.id);
      if (!previousFingerprint || previousFingerprint !== nextFingerprint) {
        this.lastAutoClaimFingerprint.set(task.id, nextFingerprint);
        this.options.snapshotManager?.invalidate("task:updated");
      }
      /*
      FNXC:WorkflowEvents 2026-08-01-07:14:
      TaskStore decorates `task:updated` with its cache-warmed lanes, letting the failure and PR
      edge-trigger guards remain synchronous on renamed boards. A missing payload is unknown, not a
      legacy claim, so its fallback stays literal instead of consulting PostgreSQL's default-only sync
      resolver; that preserves existing bridge and cold-cache behaviour without reordering listeners.
      */
      const eventLanes = meta?.lanes;
      // DELIBERATE-LITERAL — absent event metadata is unknown, so the legacy wip fallback stays explicit.
      // Track mission failure signals before moveTask clears failure metadata.
      if (task.sliceId && task.status === "failed") {
        if (eventLanes ? task.column === eventLanes.wip : task.column === "in-progress") this.failedTaskIds.add(task.id);
        /*
        FNXC:MissionReconciliation 2026-08-01-00:00:
        In-place failure parks do not emit task:moved, but they release the
        task's durable symbol lock. Reconcile any mission-linked failure update
        so the roadmap records withheld provenance without fabricating completion.
        */
        if (this.options.missionStore) {
          void this.handleMissionTaskMove(task.id, task.column);
        }
      } else if (task.status !== "failed") {
        this.failedTaskIds.delete(task.id);
      }

      // Track pause state transitions for event-driven scheduling on unpause.
      // When a previously-paused task is unpaused in a schedulable column,
      // trigger a scheduling pass immediately instead of waiting for the next
      // poll interval (up to 15 seconds).
      if (task.paused || task.userPaused) {
        this.pausedTaskIds.add(task.id);
      } else if (this.pausedTaskIds.has(task.id)) {
        // Task was paused, now unpaused — trigger scheduling
        this.pausedTaskIds.delete(task.id);
        if (task.userPaused === false && (task.dispatchStormCount != null || task.lastDispatchAt != null || task.executeRequeueLoopCount != null || task.executeRequeueLoopSignature != null)) {
          void this.store.updateTask(task.id, {
            dispatchStormCount: null,
            lastDispatchAt: null,
            executeRequeueLoopCount: null,
            executeRequeueLoopSignature: null,
          }).catch((error) => {
            schedulerLog.warn(`Failed to reset dispatch oscillation state for ${task.id} on unpause: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        /* FNXC:WorkflowResolvedColumns 2026-07-31-06:35 (fleet): the answer only gates `schedule()`,
           which is async and fire-and-forget, so resolving it properly costs nothing observable. */
        void (async () => {
          const unpausedParked = await resolveTaskParkedColumns(this.store, task.id);
          if (this.running && unpausedParked.wake.has(task.column)) {
            schedulerLog.log(`Task ${task.id} unpaused — triggering scheduling`);
            void this.schedule();
          }
        })();
      }

      /*
      FNXC:CodingIdeasWorkflow 2026-07-25-13:10:
      Dispatch the moment planning finishes, instead of waiting out the poll timer.

      This closes the second half of the "started card does nothing" gap. Triage's finalize clears
      `status` in place (it deliberately skips the triage->todo move for plan-in-place workflows), so
      the card becomes dispatchable via a bare task:updated with no task:moved and no pause
      transition — none of the existing event wakes above fire for it. The operator therefore paid
      pollIntervalMs (15s default) for planning to start AND another one for execution to start.

      Same shape as the pausedTaskIds tracker above: remember ids seen mid-planning, then fire once
      on the transition back to a dispatchable state. Guarded on `!task.status` so a planning ->
      failed/awaiting-approval park does not trigger a pointless pass, and on column so a card
      finishing planning somewhere unschedulable is ignored. schedule()'s re-entrance guard drops
      the call harmlessly if a poll-based pass is already running.
      */
      if (task.status === "planning") {
        this.planningTaskIds.add(task.id);
      } else if (this.planningTaskIds.has(task.id)) {
        this.planningTaskIds.delete(task.id);
        /* FNXC:WorkflowResolvedColumns 2026-07-31-06:35 (fleet): as with the unpause wake above, the
           answer only gates `schedule()`. The `planningTaskIds.delete` stays SYNCHRONOUS — it is the
           edge-trigger bookkeeping, and deferring it would let a second update re-enter this branch. */
        void (async () => {
          const planningParked = await resolveTaskParkedColumns(this.store, task.id);
          if (
            this.running
            && !task.status
            && !task.paused
            && !task.userPaused
            && planningParked.wake.has(task.column)
          ) {
            schedulerLog.log(`Task ${task.id} finished planning — triggering scheduling`);
            void this.schedule();
          }
        })();
      }

      if (task.status === "awaiting-approval") {
        this.approvalHeldTaskIds.add(task.id);
        this.approvalReleasedTaskIds.delete(task.id);
      } else if (
        !task.status
        && !task.paused
        && !task.userPaused
        && (
          this.approvalHeldTaskIds.delete(task.id)
          || (
            (Boolean(task.approvedPlanFingerprint) || task.workflowStepResults?.some(isPlanReviewSatisfied) === true)
            && !this.approvalReleasedTaskIds.has(task.id)
          )
        )
      ) {
        this.approvalReleasedTaskIds.add(task.id);
        void (async () => {
          const approvalParked = await resolveTaskParkedColumns(this.store, task.id);
          if (
            this.running
            && !task.status
            && !task.paused
            && !task.userPaused
            && approvalParked.wake.has(task.column)
          ) {
            schedulerLog.log(`Task ${task.id} plan approval cleared — triggering scheduling`);
            void this.schedule();
          }
        })();
      }

      if (!this.options.prMonitor) return;
      // DELIBERATE-LITERAL — runtime bridges drop lanes; never replace this unknown fallback with the sync resolver.
      if (eventLanes ? task.column !== eventLanes.review : task.column !== "in-review") return;
      if (!task.prInfo) return;

      // Check if we're already monitoring this task
      const tracked = this.options.prMonitor.getTrackedPrs();
      if (tracked.has(task.id)) {
        this.options.prMonitor.updatePrInfo(task.id, task.prInfo);
        return;
      }

      const repo = getCurrentRepo(this.store.getRootDir());
      if (repo) {
        this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
      }
    });

    this.store.on("task:deleted", (task) => {
      this.lastAutoClaimFingerprint.delete(task.id);
      this.options.snapshotManager?.invalidate("task:deleted");
      this.pausedTaskIds.delete(task.id);
      // FNXC:CodingIdeasWorkflow 2026-07-25-13:10: drop planning tracking with the other per-task
      // sets so a deleted-mid-planning id cannot leak or fire a stale wake if the id is reused.
      this.planningTaskIds.delete(task.id);
      this.approvalHeldTaskIds.delete(task.id);
      this.approvalReleasedTaskIds.delete(task.id);
      this.failedTaskIds.delete(task.id);
      this.recentEngineTodoRequeues.delete(task.id);
      this.wasNodeDispatchValidationBlocked.delete(task.id);
      this.wasNodeBlocked.delete(task.id);
      this.wasPermanentAgentUnavailable.delete(task.id);
      this.clearDispatchQueuedReasonMemo(task.id);

      void (async () => {
        try {
          const settings = await this.store.getSettings();
          if (settings.globalPause || settings.enginePaused) {
            return;
          }

          const deletedParked = await resolveTaskParkedColumns(this.store, task.id);
          /*
          FNXC:WorkflowLifecycleColumns 2026-07-30-20:55:
          A HALF-CONVERTED PAIR, one line apart. The hold read above already resolved its lane while
          the wip read below stayed on the literal, so on a renamed board this dependent sweep saw
          the queued cards and none of the running ones — a dependency held by an in-flight task was
          never reconciled when that task was deleted.

          Two reads of the same board, one resolved and one not, is the shape this program keeps
          finding; that they are adjacent is what makes it easy to miss in review rather than easy to
          catch.
          */
          const deletedWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
          const todoTasks = await this.store.listTasks({ column: deletedParked.hold, slim: true });
          const inProgressById = new Map<string, Task>();
          for (const column of deletedWipColumns) {
            for (const task of await this.store.listTasks({ column, slim: true })) inProgressById.set(task.id, task);
          }
          const inProgressTasks = [...inProgressById.values()];
          const dependents = [...todoTasks, ...inProgressTasks];
          /* One IR cache for the whole reconciliation, per the caller-owned-cache contract. */
          const deletedDependencyIrCache = new Map<string, WorkflowIr>();

          for (const dependent of dependents) {
            const mentionsDeletedTask = dependent.dependencies.includes(task.id);
            const currentlyBlockedByDeletedTask = dependent.blockedBy === task.id;
            if (!mentionsDeletedTask && !currentlyBlockedByDeletedTask) continue;

            const markerAcceptedByTaskId = settings.mergeRequestContractShadowEnabled === true
              ? new Map(await Promise.all(dependent.dependencies.map(async (depId) => [depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null] as const)))
              : undefined;
            const dependencyTasks = (await Promise.all(
              dependent.dependencies.map((dependencyId) => this.store.getTask(dependencyId).catch(() => null)),
            )).filter((candidate) => candidate !== null);
            const satisfactionColumnsByTaskId = await resolveDependencySatisfactionColumns(
              this.store,
              dependencyTasks,
              deletedDependencyIrCache,
            );
            const unresolvedDeps = getUnmetSchedulingDependencies(
              dependent,
              [dependent, ...dependencyTasks],
              {
                satisfactionColumnsByTaskId,
                ...(markerAcceptedByTaskId
                  ? {
                    markerAcceptedByTaskId,
                    onParityDiff: (diff: SchedulingDependencyParityDiff) => {
                      this.emitDependencyParityDiff(diff);
                    },
                  }
                  : {}),
              },
            );

            try {
              if (unresolvedDeps.length > 0) {
                const nextBlocker = unresolvedDeps[0]!;
                await this.store.updateTask(dependent.id, {
                  blockedBy: nextBlocker,
                  status: "queued",
                });
                await this.store.logEntry(
                  dependent.id,
                  `Auto-reblocked (FN-5496): unresolved dependency ${nextBlocker} remains after blocker ${task.id} was soft-deleted`,
                );
              } else if (dependent.column === deletedParked.hold) {
                await this.store.updateTask(dependent.id, { blockedBy: null, ...clearBlockedStatusOnly(dependent) });
                await this.store.logEntry(dependent.id, `Auto-unblocked (FN-5496): blocker ${task.id} was soft-deleted`);
              } else {
                await this.store.updateTask(dependent.id, { blockedBy: null });
                await this.store.logEntry(dependent.id, `Auto-unblocked (FN-5496): blocker ${task.id} was soft-deleted`);
              }
            } catch (error) {
              schedulerLog.error(`Failed to reconcile dependent ${dependent.id} for soft-deleted blocker ${task.id}`, error);
            }
          }

          this.schedule();
        } catch (error) {
          schedulerLog.error(`Failed event-driven soft-delete blocker reconciliation for ${task.id}`, error);
        }
      })();
    });
  }

  /**
   * Validate that a task's filesystem state is intact.
   * Checks that the task directory exists and PROMPT.md is present and non-empty.
   * 
   * @param id - The task ID to validate
   * @returns Object with `valid: true` if checks pass, or `valid: false` with a `reason` string if they fail
   */
  private async validateTaskFilesystem(id: string): Promise<{ valid: boolean; reason?: string }> {
    if (typeof this.store.getTasksDir !== "function") {
      /*
      FNXC:WorkflowScheduling 2026-06-23-11:38:
      Scheduler test fakes and older embedded stores may not expose task-directory helpers. The production TaskStore still enforces task-dir and PROMPT.md validation, but minimal stores should not abort the workflow sweep before lease recovery and node-routing guards run.
      */
      return { valid: true };
    }
    const taskDir = join(this.store.getTasksDir(), id);
    
    // Check if task directory exists
    if (!existsSync(taskDir)) {
      return { valid: false, reason: "missing directory" };
    }
    
    // Check if PROMPT.md exists and has non-empty content
    const promptPath = join(taskDir, "PROMPT.md");
    if (!existsSync(promptPath)) {
      return { valid: false, reason: "missing or empty PROMPT.md" };
    }
    
    try {
      const content = await readFile(promptPath, "utf-8");
      if (!content || content.trim().length === 0) {
        return { valid: false, reason: "missing or empty PROMPT.md" };
      }
      /*
      FNXC:DuplicateIntake 2026-08-01-19:24:
      Non-empty is not enough: a sole `DUPLICATE: FN-####` line is a triage redirect, not a
      plan. Admitting it (FN-8704) fails the graph at `parse` and parks failed WIP in a loop.
      */
      const duplicateOnly = nonExecutableDuplicateRedirectReason(content);
      if (duplicateOnly) {
        return { valid: false, reason: duplicateOnly };
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      schedulerLog.warn(`PROMPT.md read failed for task dispatch validation (${id}): ${errorMessage}`);
      return { valid: false, reason: "missing or empty PROMPT.md" };
    }
    
    return { valid: true };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const interval = this.options.pollIntervalMs ?? 15_000;
    this.activePollMs = interval;
    this.pollInterval = setInterval(() => this.schedule(), interval);
    this.schedule();
    schedulerLog.log(`Started (poll interval: ${interval}ms)`);

    // Wire up MissionAutopilot: set scheduler reference for lazy injection
    // and start watching all missions with autopilotEnabled: true
    if (this.options.missionAutopilot && this.options.missionStore) {
      this.options.missionAutopilot.setScheduler(this);
      const missionStore = this.options.missionStore;
      const missionAutopilot = this.options.missionAutopilot;
      void Promise.resolve(missionStore.listMissions()).then((missions) => {
        for (const mission of missions) {
          if (mission.autopilotEnabled && mission.status !== "complete" && mission.status !== "archived") {
            missionAutopilot.watchMission(mission.id);
          }
        }
      }).catch((error) => schedulerLog.error("Failed to initialize mission autopilot watches:", error));
      this.options.missionAutopilot.start();
    }
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.activePollMs = null;
    }
    // Stop all PR monitoring when scheduler shuts down
    if (this.options.prMonitor) {
      this.options.prMonitor.stopAll();
    }
    // Stop MissionAutopilot when scheduler shuts down
    if (this.options.missionAutopilot) {
      this.options.missionAutopilot.stop();
    }
    this.unregisterAdmissionProvider?.();
    this.unregisterAdmissionProvider = undefined;
    this.coordinatorReadyTasks.clear();
    this.failedTaskIds.clear();
    this.wasNodeBlocked.clear();
    this.wasNodeDispatchValidationBlocked.clear();
    this.wasPermanentAgentUnavailable.clear();
    this.wasDispatchQueuedReasonLogged.clear();
    this.symbolLockRenewalLog.reset();
    schedulerLog.log("Stopped");
  }

  private clearDispatchQueuedReasonMemo(taskId: string): void {
    for (const key of this.wasDispatchQueuedReasonLogged) {
      if (key.startsWith(`${taskId}:`)) {
        this.wasDispatchQueuedReasonLogged.delete(key);
      }
    }
  }

  private async transitionQueuedEpisode(
    task: Task,
    input: { signature: string; blockedBy: string | null; overlapBlockedBy: string | null; action: string },
  ): Promise<boolean> {
    return (await this.store.transitionQueuedEpisode(task.id, input)).appended;
  }

  private async logDispatchQueuedReason(taskId: string, reason: string, memoKey?: string): Promise<boolean> {
    const key = `${taskId}:${memoKey ?? reason}`;
    if (this.wasDispatchQueuedReasonLogged.has(key)) {
      return false;
    }

    this.clearDispatchQueuedReasonMemo(taskId);
    this.wasDispatchQueuedReasonLogged.add(key);
    await this.store.logEntry(taskId, reason);
    return true;
  }

  private emitDependencyParityDiff(diff: SchedulingDependencyParityDiff): void {
    void this.store.recordRunAuditEvent?.({
      taskId: diff.taskId,
      agentId: "scheduler",
      runId: generateSyntheticRunId("scheduler", diff.taskId),
      domain: "database",
      mutationType: "merge:dependency-parity-diff",
      target: diff.dependencyId,
      metadata: {
        depId: diff.dependencyId,
        legacyResult: diff.legacySatisfied,
        markerResult: diff.markerSatisfied,
      },
    });
  }

  private async emitNodeUnreachableRecoveryAudit(
    task: Task,
    metadata: {
      ownerNodeId: string;
      // Includes FN-4832 online-owner parking (`owner_recovered`) in dispatch handoff audits.
      ownerNodeHealth: "offline" | "error" | "online";
      handoffAction: "park" | "reassign-local" | "reassign-any";
      handoffReason: string;
      decisionPath: "scheduler-handoff-park" | "scheduler-handoff-reassign-local" | "scheduler-handoff-reassign-any";
      newColumn: string;
      dispatchNodeBefore?: string;
      dispatchNodeAfter?: string;
    },
  ): Promise<void> {
    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("scheduler", task.id),
      agentId: "scheduler",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: "dispatch-owning-node-handoff",
    });

    try {
      await auditor.database({
        type: "task:auto-recover-node-unreachable",
        target: task.id,
        metadata: {
          previousColumn: task.column,
          ...metadata,
        },
      });
    } catch (error) {
      schedulerLog.warn(
        `Task ${task.id} failed to emit node-unreachable auto-recovery audit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async emitHighOverlapFanoutWarnings(tasks: Task[]): Promise<void> {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-11:10:
    WIRING THE ESCALATION LANES — the option existed and nothing in production filled it.

    `computeBlockerFanoutMap`'s `escalationColumns` was added as an optional resolved answer and this,
    its only production caller, passed nothing. So on a renamed board `shouldEscalate` was false for
    every blocker and the warning below reported a long-standing bottleneck as `temporary` forever.
    The fan-out COUNT was correct throughout, which is what makes it quiet: the message names a real
    problem and mis-states its age.

    FLAT SET, DELIBERATELY, and the limit is worth naming: `escalationColumns` is board-wide, so on a
    board spanning workflows this unions every workflow's active lanes. An id one workflow calls wip
    and another calls something else is therefore treated as active for both. That over-approximates
    in the CHEAP direction here — the cost is a bottleneck warning reading `long-lived` slightly too
    eagerly, never a missed one — and it matches how `terminalColumns`/`reviewColumns` are already
    passed in this file. A per-task answer would need the `classify`-shaped option this module
    documents for the cases where the distinction actually bites.

    One IR cache for the sweep, per the caller-owned-cache contract.
    */
    const escalationIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
    /* Per-task, keyed by id — see the `escalationClassify` note in blocker-fanout.ts. The flat set is
       still built alongside it as the legacy fallback for tasks whose workflow will not resolve. */
    const escalationByTaskId = new Map<string, boolean>();
    const escalationColumns = new Set<string>();
    const holdByTaskId = new Map<string, boolean>();
    const terminalByTaskId = new Map<string, boolean>();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-18:40:
    The REVIEW half was still unwired after the escalation fix, and I only found it by auditing the
    rest of the flat-set class rather than by any guard.

    `computeBlockerFanoutMap` feeds `reviewColumns` to `isStaleBlockedByBlocker`, which decides
    whether a paused or retry-exhausted review blocker still counts as blocking its dependents. This
    call passed `classify`, `escalationClassify` and `escalationColumns` and NOT this one, so that
    half ran on the legacy `{in-review}` while everything beside it was resolved — the
    half-converted-pair shape, inside a call site I had already converted twice.

    Notably my own unwired-parameter guard cannot see it: `reviewColumns` is mentioned in
    `task-priority.ts`, so the name reads as used. That blind spot is documented in the guard's header.
    */
    const blockerReviewColumns = new Set<string>();
    for (const task of tasks) {
      const ir = await resolveWorkflowIrForTask(this.store, task.id, escalationIrCache).catch(() => undefined);
      if (!ir) continue;
      for (const id of columnsWithFlag(ir, "countsTowardWip")) escalationColumns.add(id);
      for (const id of columnsWithFlag(ir, "mergeOrchestration")) escalationColumns.add(id);
      for (const id of columnsWithFlag(ir, "mergeBlocker")) escalationColumns.add(id);
      for (const id of columnsWithFlag(ir, "humanReview")) escalationColumns.add(id);
      escalationByTaskId.set(task.id, [
        ...columnsWithFlag(ir, "countsTowardWip"),
        ...columnsWithFlag(ir, "mergeOrchestration"),
        ...columnsWithFlag(ir, "mergeBlocker"),
        ...columnsWithFlag(ir, "humanReview"),
      ].includes(task.column));
      for (const id of columnsWithFlag(ir, "mergeOrchestration")) blockerReviewColumns.add(id);
      for (const id of columnsWithFlag(ir, "mergeBlocker")) blockerReviewColumns.add(id);
      for (const id of columnsWithFlag(ir, "humanReview")) blockerReviewColumns.add(id);
      holdByTaskId.set(task.id, columnsWithFlag(ir, "hold").includes(task.column));
      terminalByTaskId.set(
        task.id,
        columnsWithFlag(ir, "complete").includes(task.column) || columnsWithFlag(ir, "archived").includes(task.column),
      );
    }
    const fanoutMap = computeBlockerFanoutMap(tasks, 3, {
      ...(escalationColumns.size > 0 ? { escalationColumns } : {}),
      ...(blockerReviewColumns.size > 0 ? { reviewColumns: blockerReviewColumns } : {}),
      /* Per-task answer where the workflow resolved; the flat set above covers the rest. */
      escalationClassify: (task: Task) => escalationByTaskId.get(task.id) ?? escalationColumns.has(task.column),
      /*
      `classify` is PER TASK, which this module documents as the only correct option on a board
      spanning workflows — and it is required here for a reason the escalation half alone would have
      hidden: `overlapBlockedTodoCount` counts dependents in the HOLD lane, whose flat default is
      `"todo"`. On a renamed board that count was ZERO, so the threshold check below skipped every
      blocker and no warning was emitted AT ALL. Wiring only `escalationColumns` would have fixed the
      long-lived/temporary label on a message that never printed.

      A task whose workflow did not resolve is absent from both maps and falls back to the legacy
      answer, matching the documented default.
      */
      /* DELIBERATE-LITERAL — the unresolvable-workflow default for both halves, reviewed
         2026-07-31-11:10. A task absent from the maps above had no readable workflow, so it keeps
         the answer `computeBlockerFanoutMap` would have given it with no options at all. */
      classify: (task: Task) => ({
        isHold: holdByTaskId.get(task.id) ?? task.column === "todo",
        isTerminal: terminalByTaskId.get(task.id) ?? (task.column === "done" || task.column === "archived"),
      }),
    });
    const seenBlockers = new Set<string>();

    for (const [blockerId, fanout] of fanoutMap) {
      if (fanout.overlapBlockedTodoCount < HIGH_FANOUT_BLOCKER_TODO_THRESHOLD) continue;
      const state = fanout.escalation ? "long-lived" : "temporary";
      const dedupeKey = `${fanout.overlapBlockedTodoCount}:${state}`;
      seenBlockers.add(blockerId);

      if (this.lastHighOverlapFanoutWarningKey.get(blockerId) === dedupeKey) {
        continue;
      }

      const message = `Overlap bottleneck: ${blockerId} is currently blocking ${fanout.overlapBlockedTodoCount} todo task(s) via blockedBy (${state}).`;
      schedulerLog.warn(message);
      await this.store.logEntry(blockerId, message);
      this.lastHighOverlapFanoutWarningKey.set(blockerId, dedupeKey);
    }

    for (const blockerId of this.lastHighOverlapFanoutWarningKey.keys()) {
      if (!seenBlockers.has(blockerId)) {
        this.lastHighOverlapFanoutWarningKey.delete(blockerId);
      }
    }
  }

  private async rollbackRunningAgentsForQueuedTodoTask(taskId: string): Promise<void> {
    const agentStore = this.options.agentStore;
    if (!agentStore) return;

    const runningAgents = await agentStore.listAgents({ state: "running", includeEphemeral: false });
    const linkedAgents = runningAgents.filter((agent) => agent.taskId === taskId);

    for (const agent of linkedAgents) {
      const activeRun = await agentStore.getActiveHeartbeatRun?.(agent.id);
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-29-17:45 (PR #2518 self-review — CORRECTED):
      The synthetic column here stands for "this task is parked in the backlog",
      which is what `evaluateParkedAgentTaskLink` gates on via
      `isParkedTaskColumn(linkedTask, parkedColumns)`.

      An earlier version of this note claimed the literal made a renamed workflow
      read as UNPARKED and drop a live agent's link. THAT WAS WRONG, and the
      mutation test proved it: the literal passed `{column:"todo"}` together with
      the helper's LEGACY default parked list, so the pair was self-consistent and
      read as parked either way. This conversion is behaviour-NEUTRAL here.

      What is load-bearing is the pair travelling TOGETHER. The dangerous state is
      drift — a resolved column checked against the legacy list (or the reverse),
      which reads as unparked and clears a live agent's link. That invariant, not
      the conversion, is what the agent-link tests pin.
      */
      const rollbackParked = await resolveTaskParkedColumns(this.store, taskId);
      const proof = evaluateParkedAgentTaskLink({
        agent,
        linkedTask: { column: rollbackParked.hold } as Pick<Task, "column">,
        activeRun,
        hasActiveAgentExecution: this.options.hasActiveAgentExecution,
        parkedColumns: [rollbackParked.hold, rollbackParked.intake],
      });
      if (proof.shouldPreserveParkedLink) {
        schedulerLog.log(
          `Preserved running agent ${agent.id} for queued ${taskId}; live proof freshRun=${proof.hasFreshRun} activeExecution=${proof.hasActiveExecution}`,
        );
        continue;
      }

      await agentStore.updateAgentState(agent.id, "active");
      await agentStore.syncExecutionTaskLink(agent.id, undefined);
      schedulerLog.log(
        `Cleared stale running agent ${agent.id} after overlap requeue of ${taskId}; file-scope lease remains queued`,
      );
    }
  }

  /**
   * If `newIntervalMs` differs from the currently active timer, restart
   * the `setInterval` so the new cadence takes effect immediately.
   */
  private refreshPollInterval(newIntervalMs?: number): void {
    if (!this.running || !newIntervalMs) return;
    if (newIntervalMs === this.activePollMs) return;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.activePollMs = newIntervalMs;
    this.pollInterval = setInterval(() => this.schedule(), newIntervalMs);
    schedulerLog.log(`Poll interval updated to ${newIntervalMs}ms`);
  }

  getMissionAutopilot(): import("./missions/mission-autopilot.js").MissionAutopilot | undefined {
    return this.options.missionAutopilot;
  }

  configurePrMonitoring(options: {
    prMonitor?: PrMonitor;
    onClosedPrFeedback?: SchedulerOptions["onClosedPrFeedback"];
  }): void {
    this.options.prMonitor = options.prMonitor;
    this.options.onClosedPrFeedback = options.onClosedPrFeedback;

    if (!options.prMonitor) {
      return;
    }

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-20:40 (fleet — PR-monitor startup hydration):
    Startup rehydration of PR monitoring resolves the review lane per task.

    Keyed on `column !== "in-review"`, a renamed board hydrated NOTHING on engine restart: every
    open PR silently stopped being watched, so merges, review comments and closures went unnoticed
    until something else moved the card. The failure is invisible precisely because it is a missing
    background watcher rather than an error.

    This is a one-shot startup pass over an already-fetched list, and it is already off the hot path
    (`void ... .then(...)`), so a per-task resolution with a shared IR cache costs one read per
    distinct workflow. Fail-soft: an unresolvable workflow falls back to the legacy literal via
    `isReviewColumnRole`'s documented no-metadata behaviour rather than dropping the watcher.
    */
    void this.store.listTasks({ slim: true, includeArchived: false, startupMemo: true })
      .then(async (tasks) => {
        const repo = getCurrentRepo(this.store.getRootDir());
        if (!repo) return;

        const hydrationIrCache = new Map<string, WorkflowIr>();
        for (const task of tasks) {
          if (!task.prInfo) continue;
          let flags: ColumnRoleTraitFlags | undefined;
          try {
            const ir = await resolveWorkflowIrForTask(this.store, task.id, hydrationIrCache);
            const column = (ir as WorkflowIrV2).columns?.find((candidate) => candidate.id === task.column);
            if (column) flags = resolveColumnFlags(column);
          } catch {
            // Unresolvable workflow: `isReviewColumnRole` falls back to the legacy id below.
          }
          if (!isReviewColumnRole(flags, task.column)) continue;
          options.prMonitor!.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
        }
      })
      .catch((err) => {
        schedulerLog.error("Failed to hydrate PR monitoring from existing in-review tasks:", err);
      });
  }

  /**
   * Resolve the base branch for a task being started.
   *
   * Checks explicit dependencies and implicit `blockedBy` for an in-review
   * task with an unmerged branch. Returns the git branch name to start from,
   * or `null` if the task should start from HEAD (default).
   *
   * Priority: explicit dep in-review (first with worktree) > blockedBy in-review.
   *
   * FNXC:WorkflowLifecycleColumns 2026-07-30-20:40 (fleet — scheduler base-branch stacking):
   * `isReviewColumn` is a REQUIRED resolved answer, not an optional one with a literal default.
   *
   * This decides whether a starting task stacks its branch on a predecessor still in review. Keyed
   * on the literal, a renamed board resolved every predecessor as "not in review" and the task
   * started from HEAD instead of from its dependency's branch — so the dependent silently rebuilt
   * work its predecessor had already done, and the first merge of the two conflicted. That is a
   * quiet wrong answer, not a crash, which is why it would survive unnoticed.
   *
   * Required rather than optional because this method has exactly ONE caller, inside
   * `runHoldReleaseSweepPass`, which has already resolved per-task trait flags for the whole board.
   * An optional parameter with a literal default would let a future caller reintroduce the bug by
   * omission; making it required means the compiler asks the question.
   */
  private resolveBaseBranch(
    task: Task,
    allTasks: Task[],
    isReviewColumn: (candidate: Task) => boolean,
  ): string | null {
    // Check explicit dependencies for review-lane tasks with worktrees
    for (const depId of task.dependencies) {
      const dep = allTasks.find((t) => t.id === depId);
      if (dep && isReviewColumn(dep) && dep.worktree) {
        return resolveTaskWorkingBranch(dep);
      }
    }

    // Check implicit blockedBy for a review-lane task with worktree
    if (task.blockedBy) {
      const blocker = allTasks.find((t) => t.id === task.blockedBy);
      if (blocker && isReviewColumn(blocker) && blocker.worktree) {
        return resolveTaskWorkingBranch(blocker);
      }
    }

    return null;
  }

  /**
   * Delegates to the module-level {@link pathsOverlap} for testability.
   */
  private pathsOverlap(a: string[], b: string[]): boolean {
    return pathsOverlap(a, b);
  }

  /**
   * Reserve the worktree path a task will use before it enters in-progress.
   * This prevents tasks from appearing active without an assigned worktree.
   */
  private planWorktreePath(
    task: Task,
    naming: string | undefined,
    reservedNames: Set<string>,
    settings: Partial<Settings>,
  ): string {
    return planTaskWorktreePath(task, this.store.getRootDir(), naming, reservedNames, settings);
  }

  /**
   * Run one scheduling pass.
   *
   * Uses a re-entrance guard (`this.scheduling`) to prevent overlapping
   * passes. Because `schedule()` is async but triggered by `setInterval`,
   * a slow pass could still be running when the next interval fires.
   * Without the guard, two passes would snapshot the same task list and
   * both could start tasks whose file scopes overlap — defeating the
   * overlap detection that relies on `inProgressScopes` being accurate.
   */
  async schedule(): Promise<void> {
    if (!this.running) return;
    if (this.scheduling) {
      /* FNXC:PumpWatchdog 2026-08-01-02:00: one hung pass leaves the guard closed forever and every later tick/wake drops SILENTLY (the triage-poll death, 00769fad7c/e51ebff381). Past the threshold, warn with the stuck duration and force the guard open; the hung pass's own finally re-clearing it later is harmless. Dispatch prep runs real git work per candidate, so the threshold is generous. */
      const stuckMs = this.schedulingSince > 0 ? Date.now() - this.schedulingSince : 0;
      if (stuckMs < 600_000) return;
      schedulerLog.warn(`schedule watchdog: previous pass still marked in-flight after ${Math.round(stuckMs / 1000)}s — forcing the guard open so dispatch resumes`);
    }
    this.scheduling = true;
    this.schedulingSince = Date.now();

    try {
      let tasks = await this.store.listTasks({ slim: true, includeArchived: false, startupMemo: false });
      let settings = await this.store.getSettings();
      this.idleSemaphoreLeakCandidateSince = recoverIdleSemaphoreLeak(
        this.options.semaphore,
        tasks,
        "scheduler",
        this.idleSemaphoreLeakCandidateSince,
        this.options.getInFlightTopLevelCount?.() ?? 0,
      );

      // Refresh the poll interval if the persisted setting has changed
      this.refreshPollInterval(settings.pollIntervalMs);

      await this.renewActiveMissionSymbolLocks(tasks);

      // Global pause (hard stop): halt all scheduling activity
      if (settings.globalPause) {
        if (!this.wasGlobalPaused) {
          schedulerLog.warn("⚠ Global pause active — scheduling halted. To resume: set globalPause to false in settings.");
          this.wasGlobalPaused = true;
        }
        return;
      }
      if (this.wasGlobalPaused) {
        schedulerLog.log("Global pause cleared — scheduling resumed");
      }
      this.wasGlobalPaused = false;

      // Engine paused (soft pause): halt new work dispatch, but let agents finish
      if (settings.enginePaused) {
        if (!this.wasEnginePaused) {
          schedulerLog.warn("⚠ Engine paused — scheduling halted (in-flight agents continue). To resume: set enginePaused to false.");
          this.wasEnginePaused = true;
        }
        return;
      }
      if (this.wasEnginePaused) {
        schedulerLog.log("Engine pause cleared — scheduling resumed");
      }
      this.wasEnginePaused = false;

      const heartbeatIntervalMs = Math.max(1, settings.pollIntervalMs ?? 15_000);
      if (Date.now() - this.lastHeartbeatWriteMs >= heartbeatIntervalMs) {
        /*
        FNXC:TaskTiming 2026-06-25-00:00:
        Persist a throttled engineLastActiveAt heartbeat only while the engine is unpaused so process-down wall-clock can be excluded from in-progress task active time after restart without per-tick DB churn.
        */
        await this.store.updateSettings({ engineLastActiveAt: new Date().toISOString() });
        this.lastHeartbeatWriteMs = Date.now();
      }

      // ── U6: hold/release sweep ─────────────────────────────────────────────
      /*
      FNXC:WorkflowScheduling 2026-06-23-10:32:
      Workflow columns graduated from Experimental and are now the scheduler's only dispatch model. The hold/release sweep owns todo→in-progress pickup, so do not fall through into the legacy pull-from-todo dispatcher after the sweep runs.
      */
      if (shouldRunWorkflowColumnScheduler(settings)) {
        await this.runHoldReleaseSweepPass(tasks, settings);
        tasks = await this.store.listTasks({ slim: true, includeArchived: false, startupMemo: false });
        settings = await this.store.getSettings();
        await this.emitHighOverlapFanoutWarnings(tasks);

        const staleWarningWindows = [settings.staleInProgressWarningMs, settings.staleInReviewWarningMs]
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
        const minWarningMs = staleWarningWindows.length > 0 ? Math.min(...staleWarningWindows) : 0;
        if (minWarningMs > 0 && Date.now() - this.lastStaleTaskReportAt >= minWarningMs) {
          try {
            await this.staleTaskReporter.report();
            this.lastStaleTaskReportAt = Date.now();
          } catch (error) {
            schedulerLog.warn("Stale task reporter failed", error);
          }
        }

        if (settings.backlogPressureAlertEnabled !== false && Date.now() - this.lastBacklogPressureReportAt >= 60_000) {
          try {
            await this.backlogPressureReporter.report();
          } catch (error) {
            schedulerLog.warn("Backlog pressure reporter failed", error);
          } finally {
            this.lastBacklogPressureReportAt = Date.now();
          }
        }

        if (Date.now() - this.lastUnlinkedMissionsAdvisoryReportAt >= 60_000) {
          try {
            await this.unlinkedMissionsAdvisoryReporter.report();
          } catch (error) {
            schedulerLog.warn("Unlinked missions advisory reporter failed", error);
          } finally {
            this.lastUnlinkedMissionsAdvisoryReportAt = Date.now();
          }
        }
        return;
      }
    } catch (err) {
      schedulerLog.error("Scheduling error:", err);
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * U6: run one hold/release sweep pass, wiring the scheduler's semaphore +
   * worktree allocation into the reservation-first ordering (KTD-10). Failures
   * are isolated so a sweep error never breaks the scheduling pass.
   */
  /**
   * FNXC:MissionSymbolAdmission 2026-07-19-22:04:
   * Active implementation follows the workflow `countsTowardWip` trait, so renamed
   * and multi-WIP workflows keep their declared symbols exclusively held.
   */
  private async renewActiveMissionSymbolLocks(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      /* DELIBERATE-LITERAL — seeds the trait resolution immediately below, which overwrites it
         whenever the workflow resolves; the literal survives only as the documented fallback for an
         unresolvable workflow. Reviewed 2026-07-30-20:40. */
      let isImplementationColumn = task.column === "in-progress";
      try {
        const ir = await resolveWorkflowIrForTask(this.store, task.id);
        const column = (ir as WorkflowIrV2).columns?.find((candidate) => candidate.id === task.column);
        if (column) isImplementationColumn = resolveColumnFlags(column).countsTowardWip === true;
      } catch {
        // Preserve the legacy in-progress fallback if workflow resolution is unavailable.
      }
      if (!isImplementationColumn) continue;
      // TaskStore normalizes durable declarations on write; renewal deliberately
      // reads that field rather than the prompt so an explicit declaration clear
      // can never recreate a lock.
      const symbols = [...new Set((task.declaredSymbols ?? []).filter((symbol): symbol is string => typeof symbol === "string" && symbol.trim().length > 0))];
      if (symbols.length === 0) continue;

      // A direct mission/slice link is sufficient for renewal. Feature-only links
      // are resolved through the store when available, without re-evaluating
      // approval: a running owner retains its admission lease until transition release.
      let missionLinked = Boolean(task.missionId || task.sliceId);
      if (!missionLinked && this.options.missionStore) {
        try {
          missionLinked = Boolean(await this.options.missionStore.getFeatureByTaskId(task.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.symbolLockRenewalLog.logOnce(
            schedulerLog,
            task.id,
            `lineage-lookup-failed:${message}`,
            `Symbol-lock renewal lineage lookup failed for ${task.id}: ${message}`,
            "warn",
          );
          continue;
        }
      }
      if (!missionLinked) continue;

      /*
      FNXC:EngineDiagnostics 2026-08-10-17:13:
      Renewal re-runs every poll for every implementation-column task that declares symbols, and a LOST lock never
      recovers by renewing — `renewSymbolLocks` reports the same `lost` set on every subsequent pass, so the warning and
      its `logEntry` companion repeated forever: log-pane spam plus an unbounded activityLog append for a stuck task.
      Report a lost set (and a persistent renewal error) once per task per distinct signature — a changed set of lost
      symbols or a new error message is a real transition and reports again — and clear the memo on a clean renewal so a
      later loss is reported afresh. The `logEntry` write is gated on the SAME first-occurrence decision, so the task's
      activity log records the transition rather than one row per poll.
      */
      try {
        const result = await this.store.renewSymbolLocks(symbols, task.id, SYMBOL_LOCK_LEASE_MS);
        if (result.lost.length > 0) {
          const lost = [...result.lost].sort();
          const appended = this.symbolLockRenewalLog.logOnce(
            schedulerLog,
            task.id,
            `lost:${lost.join(",")}`,
            `Symbol-lock renewal lost ownership for ${task.id}: ${result.lost.join(", ")}`,
            "warn",
          );
          if (appended) {
            await this.store.logEntry(task.id, `symbol-lock renewal lost: ${result.lost.join(", ")}`);
          }
        } else {
          this.symbolLockRenewalLog.clear(task.id);
        }
      } catch (error) {
        // Do not abort capacity admission for unrelated tasks; the durable expiry
        // and self-healing reconciliation remain the crash-safe backstop.
        const message = error instanceof Error ? error.message : String(error);
        this.symbolLockRenewalLog.logOnce(
          schedulerLog,
          task.id,
          `renewal-failed:${message}`,
          `Symbol-lock renewal failed for ${task.id}: ${message}`,
          "warn",
        );
      }
    }
  }

  private async runHoldReleaseSweepPass(tasks: Task[], settings: Settings): Promise<void> {
    try {
      // FNXC:CapacityModel 2026-07-28-11:35: null = worktrees are not a capacity
      // dimension for this project (worktreeLimitEnabled false), NOT unlimited.
      const maxWorktrees = resolveWorktreeCapacityLimit({
        maxWorktrees: settings.maxWorktrees ?? this.options.maxWorktrees ?? 4,
        worktreeLimitEnabled: settings.worktreeLimitEnabled,
      });
      const maxConcurrent = settings.maxConcurrent ?? this.options.maxConcurrent ?? 2;
      const activeTaskLimit = resolveActiveTaskCapacityLimit({
        maxConcurrent,
        maxWorktrees: settings.maxWorktrees ?? this.options.maxWorktrees ?? 4,
        worktreeLimitEnabled: settings.worktreeLimitEnabled,
      });
      /*
      FNXC:WorkflowScheduling 2026-07-19-02:35 (U4/KTD-9):
      Count active WIP reservations by the `wip` trait, not the literal
      "in-progress" column, so a renamed or multi-`wip` workflow reserves against
      the right pool. For the default workflow (in-progress is the sole wip column)
      this is byte-identical to the prior literal count. IRs are resolved once per
      workflow via the cache; a resolution failure falls back to the legacy literal
      so the sweep never crashes on a bad IR.

      FNXC:WorkflowScheduling 2026-07-19-12:40 (PR #2335 review):
      Batched to avoid N sequential DB round-trips per sweep: the per-task
      selection lookups run concurrently, each DISTINCT workflow's IR is resolved
      once (wip column-flag map per workflow), and the WIP count itself is a
      synchronous filter — mirroring the U6 trait→columnIds expansion pattern in
      workflow-lifecycle-traits. Byte-compat is preserved: a missing/failed
      selection maps to `builtin:coding` (same IR resolveWorkflowIrForTask would
      use), and a column absent from the resolved IR (or a failed/non-v2 IR)
      falls back to the legacy literal "in-progress" check per task.
      */
      const wipIrCache = new Map<string, WorkflowIr>();
      // FNXC:WorkflowScheduling 2026-08-09-06:07: Share this pass-local selection cache with the hold sweep and reservation path; a persistent cache would hide mutable selection writes.
      const selectionCache = new Map<string, { workflowId: string; stepIds: string[] } | undefined>();
      const workflowIdByTaskId = new Map<string, string>();
      const taskIds = [...new Set(tasks.map((task) => task.id))];
      try {
        if (this.store.getTaskWorkflowSelectionsAsync) {
          const selections = await this.store.getTaskWorkflowSelectionsAsync(taskIds);
          for (const taskId of taskIds) selectionCache.set(taskId, selections.get(taskId));
        } else {
          await Promise.all(taskIds.map(async (taskId) => {
            try { selectionCache.set(taskId, await this.store.getTaskWorkflowSelectionAsync(taskId)); } catch { /* default below */ }
          }));
        }
      } catch {
        // FNXC:WorkflowScheduling 2026-08-09-08:16: a batch transport failure
        // must retain the legacy per-task retry path. Defaulting the entire pass
        // merges distinct capacity pools before the sweep can retry each row.
        await Promise.all(taskIds.map(async (taskId) => {
          try { selectionCache.set(taskId, await this.store.getTaskWorkflowSelectionAsync(taskId)); } catch { /* default below */ }
        }));
      }
      for (const task of tasks) workflowIdByTaskId.set(task.id, selectionCache.get(task.id)?.workflowId ?? "builtin:coding");
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-15:40 (fleet conversion, scheduler.ts):
      Per distinct workflow: columnId → resolved trait flags; null when the IR failed to resolve or
      has no v2 columns, which leaves every lookup undefined and defers to the helper's documented
      degraded mode.

      Was a hand-rolled copy of `isWipColumnRole`: it stored only `countsTowardWip` as a boolean and
      re-implemented flags-first-then-legacy-id inline. Storing the flags object instead lets the
      shared predicate decide, so this scheduler and the role helpers cannot drift on what "counts as
      WIP" means. Behaviour is identical in all four states — column present with the flag true or
      false (flags win), column absent from a resolved IR, and IR resolution failed (both fall back
      to the legacy id).
      */
      const columnFlagsByWorkflowId = new Map<string, Map<string, ColumnRoleTraitFlags> | null>();
      for (const workflowId of new Set(workflowIdByTaskId.values())) {
        try {
          const ir = await resolveWorkflowIrById(this.store, workflowId, wipIrCache);
          const columns = (ir as WorkflowIrV2).columns;
          columnFlagsByWorkflowId.set(
            workflowId,
            columns ? new Map(columns.map((c) => [c.id, resolveColumnFlags(c)])) : null,
          );
        } catch {
          columnFlagsByWorkflowId.set(workflowId, null);
        }
      }
      const columnFlagsForTask = (task: Task): ColumnRoleTraitFlags | undefined =>
        columnFlagsByWorkflowId.get(workflowIdByTaskId.get(task.id) ?? "builtin:coding")?.get(task.column);
      const isWipColumnTask = (task: Task): boolean =>
        isWipColumnRole(columnFlagsForTask(task), task.column);
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-19:05:
      The review-lane twin of `isWipColumnTask`, over the SAME resolved flags map.

      The file-scope lease sweep below had a renamed-board hole in the shape 2026-07-30-16:30 already
      fixed for the wip half: the review pass gated on the literal `column === "in-review"`, so on a
      renamed board no review card entered `activeScopes` and its worktree's files read as free while
      the merge was still in flight. Fixing only the wip half left the two halves of one registry
      disagreeing. Same predicate, same flags, so they cannot drift.
      */
      const isReviewColumnTask = (task: Task): boolean =>
        isReviewColumnRole(columnFlagsForTask(task), task.column);
      /*
      FNXC:ConcurrencyIndicators 2026-08-01-19:22:
      Failed WIP is not a live holder (isRunningAgentTask). Keep the WIP list aligned so
      same-sweep executor reservation arithmetic does not re-count stranded failed parks.
      */
      const wipTaskIds = tasks
        .filter((task) => isWipColumnTask(task) && task.status !== "failed")
        .map((task) => task.id);
      /*
      FNXC:WorktreeCapacity 2026-08-01-04:38 (inactive retained-worktree capacity inversion):
      Worktree capacity is a LIVE-TASK budget, not a count of directories retained on disk. The
      dashboard showed seven active tasks against maxWorktrees=9, but two dependency-blocked queued
      cards retained worktree paths. Counting those inactive paths filled the ledger and prevented
      the dependency-free roots from starting. Use the canonical enriched running-agent predicate
      shared with the board; planning, WIP, and active review count, while queued/paused/terminal
      tasks do not. Same-sweep reservations below keep newly released tasks visible immediately.
      */
      /*
      FNXC:WorkflowScheduling 2026-08-09-11:01:
      The active-worktree count resolves every task's IR before the hold sweep. It
      must read the same pass-scoped selection cache rather than silently adding
      one selection query per card after the batch; otherwise this production
      path recreates issue #3364's three-connection-pool saturation.
      */
      const selectionCachedStore = new Proxy(this.store, {
        get: (target, property, receiver) => {
          if (property === "getTaskWorkflowSelectionAsync") {
            return async (taskId: string) => selectionCache.has(taskId)
              ? selectionCache.get(taskId)
              : await target.getTaskWorkflowSelectionAsync(taskId);
          }
          if (property === "getTaskWorkflowSelection") {
            return (taskId: string) => selectionCache.has(taskId)
              ? selectionCache.get(taskId)
              : target.getTaskWorkflowSelection(taskId);
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const activeWorktreeTaskIds = await persistedTopLevelAgentTaskIdsFromStore(selectionCachedStore, tasks);
      let reservedWorktreeSlots = activeWorktreeTaskIds.length;
      let reservedConcurrentSlots = wipTaskIds.length;
      const dispatchPrepByTaskId = new Map<string, {
        baseBranch: string | null;
        dispatchStormCount: number;
        dispatchTimestamp: string;
        effectiveNodeId: string | null;
        effectiveNodeSource: string;
        task: Task;
      }>();
      const activeScopes = new Map<string, string[]>();
      const activeScopeColumns = new Map<string, Task["column"]>();
      const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
      const filteredScopeByTaskId = new Map<string, string[]>();
      const getFilteredFileScope = async (taskId: string): Promise<string[]> => {
        const cached = filteredScopeByTaskId.get(taskId);
        if (cached !== undefined) return cached;
        const scope = await this.store.parseFileScopeFromPrompt(taskId);
        const filteredScope = filterPathsByIgnoreList(scope, overlapIgnorePaths, { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths });
        filteredScopeByTaskId.set(taskId, filteredScope);
        return filteredScope;
      };

      const mergeShadowEnabled = settings.mergeRequestContractShadowEnabled === true;
      const markerAcceptedByTaskId = new Map<string, boolean>();
      if (mergeShadowEnabled) {
        const dependencyIds = new Set(tasks.flatMap((candidate) => candidate.dependencies));
        for (const depId of dependencyIds) {
          markerAcceptedByTaskId.set(depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
        }
      }
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-19:05:
      Resolved ONCE per sweep, over the dependency cards actually referenced — not per dependent,
      and not over the whole board. `tasks` is already in memory, so this adds workflow-IR reads
      bounded by the number of distinct workflows, not by the number of dependency edges.
      */
      const referencedDependencyIds = new Set(tasks.flatMap((candidate) => candidate.dependencies));
      const satisfactionColumnsByTaskId = await resolveDependencySatisfactionColumns(
        this.store,
        tasks.filter((candidate) => referencedDependencyIds.has(candidate.id)),
        new Map<string, WorkflowIr>(),
      );
      const schedulingDependencyOptions = mergeShadowEnabled
        ? {
          satisfactionColumnsByTaskId,
          markerAcceptedByTaskId,
          onParityDiff: (diff: SchedulingDependencyParityDiff) => {
            this.emitDependencyParityDiff(diff);
          },
        }
        : { satisfactionColumnsByTaskId };

      if (settings.groupOverlappingFiles) {
        for (const task of tasks) {
          /*
          FNXC:WorkflowResolvedColumns 2026-07-30-16:30:
          Trait-aware, not `column !== "in-progress"`. `activeScopes` is the file-scope lease registry
          the dispatch path reads to decide whether a candidate overlaps work already in flight. The
          literal skipped every card in a RENAMED wip column, so the registry stayed empty while the
          capacity arithmetic above — which resolves `countsTowardWip` from the IR — counted the same
          cards correctly; a second task sharing the file scope then dispatched instead of queueing,
          putting two agents on the same files. `isWipColumnTask` is the same predicate capacity uses,
          so the two cannot disagree again. Covered by
          scheduler-renamed-wip-file-scope-lease.test.ts.
          */
          if (!isWipColumnTask(task)) continue;
          if (!shouldHoldActiveFileScopeLease(task, tasks, { schedulingDependencyOptions, isWipColumn: true })) continue;
          const filteredScope = await getFilteredFileScope(task.id);
          if (isCoordinationOnlyTask(task, filteredScope)) continue;
          if (filteredScope.length === 0) continue;
          activeScopes.set(task.id, filteredScope);
          activeScopeColumns.set(task.id, task.column);
        }

        // FNXC:PostgresCutover 2026-06-27-09:30:
        // Pre-compute handoff markers before the .filter() because
        // getCompletionHandoffAcceptedMarker is async.
        const reviewHandoffMarkerMap = new Map<string, boolean>();
        if (settings.mergeRequestContractShadowEnabled === true) {
          for (const t of tasks) {
            if (isReviewColumnTask(t)) {
              reviewHandoffMarkerMap.set(t.id, (await this.store.getCompletionHandoffAcceptedMarker(t.id)) !== null);
            }
          }
        }
        const inReviewWithWorktree = tasks.filter(
          (task) => isReviewColumnTask(task) && shouldHoldActiveFileScopeLease(task, tasks, {
            mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
            handoffAccepted: reviewHandoffMarkerMap.get(task.id) ?? false,
            schedulingDependencyOptions,
            /* Both halves of the gate agree: the filter said review, so the predicate is told so. */
            isReviewColumn: true,
          }),
        );
        for (const task of inReviewWithWorktree) {
          const filteredScope = await getFilteredFileScope(task.id);
          if (isCoordinationOnlyTask(task, filteredScope)) continue;
          if (filteredScope.length > 0) {
            activeScopes.set(task.id, filteredScope);
            activeScopeColumns.set(task.id, task.column);
          }
        }
      }

      const result = await runHoldReleaseSweep(this.store, {
        now: () => Date.now(),
        selectionCache,
        reserveSlot: async (task): Promise<SlotReservation | null> => {
          let reservedScope = false;

          /*
          FNXC:WorkflowScheduling 2026-07-07-00:00:
          The workflow-column dispatch path is the only dispatcher when the flag is on, so the planning/bootstrap guards from the legacy todo filter must also apply here — and they must be TRAIT-based, not keyed on the literal "todo" column id. A custom workflow's intake/planning column can be renamed (`ideas`, `Inbox`, the default workflow's renamed "Planning"), so gating this guard on `task.column === "todo"` alone let an unplanned card in a renamed intake column bypass the stub check and release straight into execution (FN-7648). `isUnplannedForExecution` resolves the intake trait on the task's OWN resolved workflow IR so every renamed variant is covered.
          */
          try {
            const ir = await resolveWorkflowIrForTask(this.store, task.id, wipIrCache, selectionCache);
            if (await isUnplannedForExecution(this.store, task, ir)) {
              await checkAndRecordUnplannedExecutionBlock(this.store, task, ir);
              return null;
            }
          } catch {
            // IR resolution failure: fall through to the filesystem/other guards below,
            // which handle a missing/invalid workflow via their own error paths.
          }

          const unmetDeps = getUnmetSchedulingDependencies(task, tasks, schedulingDependencyOptions);
          if (unmetDeps.length > 0) {
            const normalizedUnmetDeps = [...new Set(unmetDeps)].sort();
            /*
            FNXC:WorkflowScheduling 2026-08-05-06:22:
            Dependency blocking and file-scope blocking are independent display truths. Keep the unfinished dependency authoritative while re-deriving overlapBlockedBy from the same active-scope registry used for dispatch, so paused/re-scoped leases disappear and resumed or replacement leases reappear without waiting for the dependency to finish.
            */
            let activeOverlapBlockedBy: string | null = null;
            if (activeScopes.size > 0) {
              try {
                const taskScope = await getFilteredFileScope(task.id);
                if (taskScope.length > 0 && !isCoordinationOnlyTask(task, taskScope)) {
                  activeOverlapBlockedBy = Array.from(activeScopes.entries())
                    .sort(([aId], [bId]) => aId.localeCompare(bId))
                    .find(([, activeScope]) => this.pathsOverlap(taskScope, activeScope))?.[0] ?? null;
                }
              } catch (error) {
                schedulerLog.warn(`Failed to refresh file-scope overlap blocker for dependency-blocked task ${task.id}`, error);
              }
            }
            await this.transitionQueuedEpisode(task, {
              signature: `dependency:${normalizedUnmetDeps.join(",")}`,
              blockedBy: unmetDeps[0] ?? null,
              overlapBlockedBy: activeOverlapBlockedBy,
              action: `queued — unmet dependencies: ${unmetDeps.join(", ")}`,
            });
            this.options.onBlocked?.(task, unmetDeps);
            return null;
          }

          if (this.options.missionStore && task.sliceId) {
            try {
              const slice = await this.options.missionStore.getSlice(task.sliceId);
              const milestone = slice ? await this.options.missionStore.getMilestone(slice.milestoneId) : undefined;
              const mission = milestone ? await this.options.missionStore.getMission(milestone.missionId) : undefined;
              if (mission?.status === "blocked") {
                await this.store.updateTask(task.id, { status: "queued" });
                await this.logDispatchQueuedReason(task.id, "queued — mission is blocked");
                return null;
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              schedulerLog.warn(
                `Mission/slice lookup failed during workflow scheduling (task ${task.id}): ${errorMessage} — proceeding without blocked-slice check`,
              );
            }
          }

          /*
          FNXC:WorkflowScheduling 2026-06-23-11:12:
          The workflow sweep is the only dispatcher, so the scheduler-only pre-dispatch gates must run before a capacity hold moves to an execution column. Keep dependency, filesystem, node-routing, permanent-agent, and oscillation checks on this path instead of relying on the retired todo loop.
          */
          const validation = await this.validateTaskFilesystem(task.id);
          if (!validation.valid) {
            schedulerLog.warn(`Task ${task.id} filesystem validation failed: ${validation.reason}`);
            /*
            FNXC:WorkflowScheduling 2026-08-01-18:47:
            Missing/empty PROMPT used to rebound with unbounded needs-replan writes (FN-8704
            storm twin). Share the planning recovery budget: backoff while attempts remain,
            then park failed so a broken task dir cannot spin forever. The status write is
            still what makes triage rediscover a card whose replan column equals its current column.
            */
            const replanColumn = await moveTaskToReplanColumn(this.store, task);
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });
            if (!decision.shouldRetry) {
              const error = `REQUIRED_ARTIFACT_RECOVERY_EXHAUSTED: filesystem validation failed (${validation.reason}) after ${MAX_RECOVERY_RETRIES} automatic planning retries.`;
              await this.store.updateTask(task.id, {
                status: "failed",
                error,
                recoveryRetryCount: null,
                nextRecoveryAt: null,
              });
              await this.store.logEntry(task.id, error, validation.reason);
              return null;
            }
            const attempt = decision.nextState.recoveryRetryCount ?? MAX_RECOVERY_RETRIES;
            await this.store.updateTask(task.id, {
              status: "needs-replan",
              error: null,
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
            });
            await this.store.logEntry(
              task.id,
              `Task rebounded to ${replanColumn} for re-specification — filesystem validation failed (attempt ${attempt}/${MAX_RECOVERY_RETRIES} in ${formatDelay(decision.delayMs)})`,
              validation.reason,
            );
            return null;
          }

          if (typeof this.store.getTasksDir === "function") {
            const promptPath = getPromptPath(this.store.getTasksDir(), task.id);
            const staleness = await evaluateSpecStaleness({
              settings,
              promptPath,
              task,
              plannerColumns: await resolveDedicatedPlannerColumnsForTask(this.store, task.id),
            });
            if (staleness.isStale) {
              schedulerLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
              await moveTaskToReplanColumn(this.store, task);
              await this.store.updateTask(task.id, { status: "needs-replan" });
              await this.store.logEntry(task.id, staleness.reason);
              return null;
            }
          }

          const freshTask = await this.store.getTask(task.id);
          if (!freshTask || freshTask.column !== task.column || freshTask.paused || freshTask.userPaused) {
            if (freshTask?.userPaused === true && freshTask.status !== "queued") {
              await this.store.updateTask(task.id, { status: "queued" });
              await this.logDispatchQueuedReason(task.id, "queued — user paused (manual move to todo)");
            }
            return null;
          }

          if (freshTask.checkedOutBy && this.options.leaseManager) {
            const recovered = await this.options.leaseManager.recoverAbandonedLease(
              freshTask.id,
              "scheduler detected stale todo lease",
              { preserveProgress: true },
            );
            if (!recovered) {
              await this.options.leaseManager.reconcileLeaseRow(freshTask.id);
              await this.store.updateTask(freshTask.id, { status: "queued" });
              await this.logDispatchQueuedReason(freshTask.id, "queued — checkout lease recovery blocked dispatch");
              return null;
            }
          }

          const latestSettings = await this.store.getSettings();
          if (latestSettings.globalPause) {
            schedulerLog.log(`Task ${task.id} dispatch aborted — globalPause became active mid-pass`);
            return null;
          }
          if (latestSettings.enginePaused) {
            schedulerLog.log(`Task ${task.id} dispatch aborted — enginePaused became active mid-pass`);
            return null;
          }

          let effectiveNode = resolveEffectiveNode(freshTask, settings);
          logTaskRouting(task.id, effectiveNode);

          if (effectiveNode.nodeId !== undefined && this.options.validateNodeDispatch) {
            const nodeValidation = await this.options.validateNodeDispatch(effectiveNode.nodeId);
            if (!nodeValidation.allowed) {
              if (!this.wasNodeDispatchValidationBlocked.has(task.id)) {
                this.wasNodeDispatchValidationBlocked.add(task.id);
                schedulerLog.log(`Task ${task.id} dispatch blocked — ${nodeValidation.reason}`);
                await this.store.logEntry(task.id, nodeValidation.reason);
              }
              return null;
            }
            this.wasNodeDispatchValidationBlocked.delete(task.id);
          }

          if (effectiveNode.nodeId !== undefined && this.options.nodeHealthMonitor) {
            const localNodeId = this.options.localNodeId ?? "local";
            if (freshTask.checkoutNodeId && freshTask.checkedOutBy && freshTask.checkoutNodeId !== localNodeId) {
              const ownerNodeHealth = this.options.nodeHealthMonitor.getNodeHealth(freshTask.checkoutNodeId);
              const handoffDecision = decideOwningNodeHandoff({
                task: freshTask,
                ownerNodeId: freshTask.checkoutNodeId,
                ownerNodeHealth,
                localNodeId,
                handoffPolicy: settings.owningNodeHandoffPolicy,
              });

              if (handoffDecision.action === "park") {
                if (!this.wasNodeBlocked.has(task.id)) {
                  this.wasNodeBlocked.add(task.id);
                  if (ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online") {
                    await this.emitNodeUnreachableRecoveryAudit(freshTask, {
                      ownerNodeId: freshTask.checkoutNodeId,
                      ownerNodeHealth,
                      handoffAction: handoffDecision.action,
                      handoffReason: handoffDecision.reason,
                      decisionPath: "scheduler-handoff-park",
                      newColumn: freshTask.column,
                      dispatchNodeBefore: effectiveNode.nodeId,
                      dispatchNodeAfter: effectiveNode.nodeId,
                    });
                  }
                  const reason = `Owning-node handoff parked dispatch: ${handoffDecision.reason}`;
                  schedulerLog.log(`Task ${task.id} dispatch blocked — ${reason}`);
                  await this.store.logEntry(task.id, reason);
                  try {
                    await this.store.recordRunAuditEvent?.({
                      taskId: freshTask.id,
                      agentId: "scheduler",
                      runId: generateSyntheticRunId("scheduler", freshTask.id),
                      domain: "database",
                      mutationType: "node:handoff:parked",
                      target: freshTask.id,
                      metadata: {
                        taskId: freshTask.id,
                        ownerNodeId: freshTask.checkoutNodeId,
                        ownerNodeHealth:
                          ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online"
                            ? ownerNodeHealth
                            : "unknown",
                        localNodeId,
                        handoffPolicy: settings.owningNodeHandoffPolicy,
                        decisionReason: handoffDecision.reason,
                        source: "scheduler.dispatch",
                      },
                    });
                  } catch (error) {
                    schedulerLog.warn(`Task ${task.id} failed to emit node:handoff:parked audit: ${error instanceof Error ? error.message : String(error)}`);
                  }
                }
                return null;
              }

              await this.store.logEntry(task.id, `Owning-node handoff applied: ${handoffDecision.reason}`);
              try {
                await this.store.recordRunAuditEvent?.({
                  taskId: freshTask.id,
                  agentId: "scheduler",
                  runId: generateSyntheticRunId("scheduler", freshTask.id),
                  domain: "database",
                  mutationType: handoffDecision.action === "reassign-local" ? "node:handoff:reassign-local" : "node:handoff:reassign-any",
                  target: freshTask.id,
                  metadata: {
                    taskId: freshTask.id,
                    ownerNodeId: freshTask.checkoutNodeId,
                    ownerNodeHealth:
                      ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online"
                        ? ownerNodeHealth
                        : "unknown",
                    localNodeId,
                    handoffPolicy: settings.owningNodeHandoffPolicy,
                    decisionReason: handoffDecision.reason,
                    source: "scheduler.dispatch",
                  },
                });
              } catch (error) {
                schedulerLog.warn(`Task ${task.id} failed to emit node:handoff audit: ${error instanceof Error ? error.message : String(error)}`);
              }
              const dispatchNodeBefore = effectiveNode.nodeId;
              if (handoffDecision.action === "reassign-local") {
                effectiveNode = { nodeId: undefined, source: "local" };
              }
              if (ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online") {
                await this.emitNodeUnreachableRecoveryAudit(freshTask, {
                  ownerNodeId: freshTask.checkoutNodeId,
                  ownerNodeHealth,
                  handoffAction: handoffDecision.action,
                  handoffReason: handoffDecision.reason,
                  decisionPath:
                    handoffDecision.action === "reassign-local"
                      ? "scheduler-handoff-reassign-local"
                      : "scheduler-handoff-reassign-any",
                  newColumn: freshTask.column,
                  dispatchNodeBefore,
                  dispatchNodeAfter: effectiveNode.nodeId,
                });
              }
            }

            if (effectiveNode.nodeId !== undefined) {
              const nodeHealth = this.options.nodeHealthMonitor.getNodeHealth(effectiveNode.nodeId);
              const decision = applyUnavailableNodePolicy({
                effectiveNode,
                nodeHealth,
                policy: settings.unavailableNodePolicy,
              });
              if (!decision.allowed) {
                if (!this.wasNodeBlocked.has(task.id)) {
                  this.wasNodeBlocked.add(task.id);
                  schedulerLog.log(`Task ${task.id} dispatch blocked — ${decision.reason}`);
                  await this.store.logEntry(task.id, decision.reason);
                }
                return null;
              }
              this.wasNodeBlocked.delete(task.id);
              if (decision.fallbackToLocal) {
                schedulerLog.log(`Task ${task.id} falling back to local — ${decision.reason}`);
                await this.store.logEntry(task.id, decision.reason);
                effectiveNode = { nodeId: undefined, source: "local" };
              }
            }
          }

          this.wasPermanentAgentUnavailable.delete(task.id);

          const oscillationSettings = latestSettings as Settings & {
            dispatchOscillationSettleMs?: number;
            dispatchOscillationThreshold?: number;
            dispatchOscillationWindowMs?: number;
          };
          const dispatchSettleMs = oscillationSettings.dispatchOscillationSettleMs
            ?? DEFAULT_DISPATCH_OSCILLATION_SETTLE_MS;
          const dispatchOscillationThreshold = oscillationSettings.dispatchOscillationThreshold
            ?? DEFAULT_DISPATCH_OSCILLATION_THRESHOLD;
          const dispatchOscillationWindowMs = oscillationSettings.dispatchOscillationWindowMs
            ?? DEFAULT_DISPATCH_OSCILLATION_WINDOW_MS;
          const recentEngineTodoMovedAt = this.recentEngineTodoRequeues.get(task.id);
          if (recentEngineTodoMovedAt) {
            if (freshTask.columnMovedAt !== recentEngineTodoMovedAt) {
              this.recentEngineTodoRequeues.delete(task.id);
            } else {
              const movedAtMs = Date.parse(recentEngineTodoMovedAt);
              const settleAgeMs = Number.isFinite(movedAtMs) ? Math.max(0, Date.now() - movedAtMs) : dispatchSettleMs;
              if (settleAgeMs < dispatchSettleMs) {
                schedulerLog.log(`Task ${task.id} was engine-requeued ${settleAgeMs}ms ago — waiting ${dispatchSettleMs}ms settle window before redispatch`);
                return null;
              }
              this.recentEngineTodoRequeues.delete(task.id);
            }
          }

          const dispatchTimestamp = new Date().toISOString();
          const lastDispatchAtMs = freshTask.lastDispatchAt ? Date.parse(freshTask.lastDispatchAt) : Number.NaN;
          const priorDispatchWithinWindow = Number.isFinite(lastDispatchAtMs)
            && Date.now() - lastDispatchAtMs <= dispatchOscillationWindowMs;
          const nextDispatchStormCount = priorDispatchWithinWindow
            ? (freshTask.dispatchStormCount ?? 0) + 1
            : 1;
          if (nextDispatchStormCount > dispatchOscillationThreshold) {
            const oscillationError = freshTask.error
              ?? `DISPATCH_OSCILLATION: detected ${nextDispatchStormCount} todo↔in-progress cycles within ${dispatchOscillationWindowMs}ms. Task auto-paused for operator review.`;
            await this.store.updateTask(task.id, {
              dispatchStormCount: nextDispatchStormCount,
              lastDispatchAt: dispatchTimestamp,
              paused: true,
              pausedReason: "dispatch-oscillation",
              status: freshTask.status ?? "queued",
              error: oscillationError,
            });
            await this.store.logEntry(
              task.id,
              `Dispatch oscillation auto-paused after ${nextDispatchStormCount} cycles within ${dispatchOscillationWindowMs}ms`,
            );
            await this.store.appendAgentLog?.(
              task.id,
              "Dispatch oscillation detected — task auto-paused for operator review",
              "text",
              `cycleCount=${nextDispatchStormCount} windowMs=${dispatchOscillationWindowMs}`,
            );
            await this.store.recordRunAuditEvent?.({
              taskId: task.id,
              agentId: "scheduler",
              runId: generateSyntheticRunId("scheduler-dispatch-oscillation", task.id),
              domain: "database",
              mutationType: "task:dispatch-oscillation-terminalized",
              target: task.id,
              metadata: {
                taskId: task.id,
                cycleCount: nextDispatchStormCount,
                windowMs: dispatchOscillationWindowMs,
                lastMoveSource: recentEngineTodoMovedAt ? "engine" : "scheduler",
              },
            });
            schedulerLog.warn(`Task ${task.id} auto-paused after dispatch oscillation threshold ${dispatchOscillationThreshold} was exceeded (${nextDispatchStormCount} cycles)`);
            return null;
          }

          /*
          FNXC:MissionSymbolAdmission 2026-07-31-12:00:
          FN-8306 blocks mission-linked work before any file-scope or work-slot
          reservation unless the canonical lineage predicate is satisfied. A
          symbol-lock candidate bypasses coarse overlap only; every capacity,
          checkout, dependency, and semaphore gate below still applies.
          */
          const missionAdmission = await decideMissionSymbolAdmission(
            freshTask,
            this.options.missionStore,
            { planApprovalRequired: latestSettings.planApprovalMode === "require-all" },
          );
          if (missionAdmission.kind === "lineage-blocked") {
            await this.store.updateTask(task.id, { status: "queued", blockedBy: null, overlapBlockedBy: null });
            await this.logDispatchQueuedReason(task.id, `queued — mission lineage blocked: ${missionAdmission.reason}`);
            return null;
          }

          if (settings.groupOverlappingFiles && missionAdmission.kind === "coarse-fallback") {
            const taskScope = await getFilteredFileScope(task.id);
            if (taskScope.length > 0 && !isCoordinationOnlyTask(task, taskScope)) {
              const overlappingTaskId = Array.from(activeScopes.entries())
                .sort(([aId], [bId]) => aId.localeCompare(bId))
                .find(([, activeScope]) => this.pathsOverlap(taskScope, activeScope))?.[0] ?? null;

              if (overlappingTaskId) {
                const activeLeaseColumn = activeScopeColumns.get(overlappingTaskId) ?? "in-progress";
                await this.transitionQueuedEpisode(task, {
                  signature: `file-scope:${overlappingTaskId}`,
                  blockedBy: null,
                  overlapBlockedBy: overlappingTaskId,
                  action: `queued — blocked by active file-scope lease ${overlappingTaskId} (column=${activeLeaseColumn})`,
                });
                await this.rollbackRunningAgentsForQueuedTodoTask(task.id);
                return null;
              }

              if (task.overlapBlockedBy) {
                await this.store.updateTask(task.id, { overlapBlockedBy: null });
              }

              activeScopes.set(task.id, taskScope);
              activeScopeColumns.set(task.id, "in-progress");
              reservedScope = true;
            } else if (task.overlapBlockedBy) {
              await this.store.updateTask(task.id, { overlapBlockedBy: null });
              if (isCoordinationOnlyTask(task, taskScope)) {
                await this.store.logEntry(
                  task.id,
                  "coordination/no-commit task bypassed non-implementation overlap lease",
                );
              }
            }
          }

          /*
          FNXC:WorktreeCapacity 2026-08-01-04:38:
          Serialize the workflow scheduler's direct hold release with planning and merge admission.
          All three lanes count the same active population, so independent snapshots must not each
          claim the final slot. The reservation remains until the executor observes the persisted
          WIP row and takes the handoff.
          */
          let finalClaimSnapshot: Promise<{ count: number; ids: string[] }> | undefined;
          const getFinalClaimSnapshot = () => finalClaimSnapshot ??= (async () => {
            /*
            FNXC:WorkflowContinuationCapacity 2026-08-01-07:10:
            Worktree preparation and startup recovery can make the sweep's original task list stale
            before this serialized admission point. A planner that became live after that snapshot
            was absent from `activeWorktreeTaskIds`; once its handoff reservation transferred to the
            durable planning status, the coordinator could no longer see either claim and admitted a
            tenth active task against maxWorktrees=9. Re-read full rows lazily inside the coordinator
            drain so pending workflow-step leases and every newly durable lane holder participate in
            the final decision. Same-sweep transient starts remain covered by coordinator reservations.
            */
            const liveTasks = await this.store.listTasks({ slim: false, includeArchived: false });
            const ids = await persistedTopLevelAgentTaskIdsFromStore(this.store, liveTasks);
            return { count: ids.length, ids };
          })();
          let projectSlotReserved = false;
          const admittedTaskId = await projectAdmissionCoordinator.admitNext({
            projectId: this.store.getRootDir(),
            maxConcurrent: activeTaskLimit,
            claimed: async () => (await getFinalClaimSnapshot()).count,
            claimedTaskIds: async () => (await getFinalClaimSnapshot()).ids,
            semaphore: this.options.semaphore,
            refresh: async () => [{
              taskId: task.id,
              projectId: this.store.getRootDir(),
              lane: "execute",
              createdAt: task.createdAt,
              reserve: () => registerPreHeldExecutorSlot(task.id, this.options.semaphore !== undefined),
              start: async () => {
                projectSlotReserved = true;
                return true;
              },
            }],
          });
          if (!projectSlotReserved) {
            if (reservedScope) {
              activeScopes.delete(task.id);
              activeScopeColumns.delete(task.id);
            }
            /*
            FNXC:WorktreeCapacity 2026-08-08-04:17:
            A scheduler candidate can lose one serialized admission pass because a higher-priority
            merge/planning provider was selected, even with a free slot. Only call it exhaustion
            after the coordinator admitted nobody and report the fresh canonical holder snapshot
            that made that decision; the pre-sweep snapshot is diagnostic-only and can be stale.
            */
            const freshClaims = await getFinalClaimSnapshot();
            const exhausted = admittedTaskId === undefined;
            const freshDiagnostic = computeConcurrencyGateDiagnostic({
              agentSlots: freshClaims.count,
              maxConcurrent,
              activeWorktrees: freshClaims.count,
              maxWorktrees,
              worktreeHolderTaskIds: freshClaims.ids,
              semaphore: this.options.semaphore,
              inProgressTaskIds: freshClaims.ids,
              topLevelClaimedSlots: freshClaims.count,
            });
            const reason = exhausted
              ? formatConcurrencyLimitReason(freshDiagnostic)
              : `queued — higher-priority lifecycle admission started: task=${admittedTaskId}`;
            await this.store.updateTask(task.id, { status: "queued" });
            await this.logDispatchQueuedReason(task.id, reason);
            return null;
          }

          // admitNext acquired and registered the host slot atomically with the
          // project reservation, so this handoff cannot bypass review candidates.
          const sem = this.options.semaphore;

          let acquiredSymbols: string[] | undefined;
          try {
            if (missionAdmission.kind === "symbol-lock") {
            /*
            FNXC:MissionSymbolAdmission 2026-07-31-12:00:
            Acquire after all capacity gates and immediately before hold release;
            the reservation release path below returns this lock if moveTask
            rejects, while a successful move transfers ownership to the task.
            */
              const lockResult = await this.store.acquireSymbolLocks(
                missionAdmission.symbols,
                { ownerTaskId: task.id, missionId: freshTask.missionId, featureId: missionAdmission.feature.id, agentId: "scheduler" },
                SYMBOL_LOCK_LEASE_MS,
              );
              if (!lockResult.acquired) {
                if (dropPreHeldExecutorSlot(task.id)) sem?.release();
                if (reservedScope) {
                  activeScopes.delete(task.id);
                  activeScopeColumns.delete(task.id);
                }
                const conflict = lockResult.conflicts[0];
                await this.store.updateTask(task.id, { status: "queued", blockedBy: null, overlapBlockedBy: null });
                await this.logDispatchQueuedReason(
                  task.id,
                  `queued — symbol contention: symbol=${conflict?.symbolKey ?? "unknown"} holder=${conflict?.ownerTaskId ?? "unknown"}`,
                );
                return null;
              }
              acquiredSymbols = missionAdmission.symbols;
              await this.store.logEntry(task.id, `symbol-lock admission acquired: ${missionAdmission.symbols.join(", ")}`);
            }

            dispatchPrepByTaskId.set(task.id, {
              baseBranch: this.resolveBaseBranch(freshTask, tasks, isReviewColumnTask),
              dispatchStormCount: nextDispatchStormCount,
              dispatchTimestamp,
              effectiveNodeId: effectiveNode.nodeId ?? null,
              effectiveNodeSource: effectiveNode.source,
              task: freshTask,
            });

            reservedWorktreeSlots += 1;
            reservedConcurrentSlots += 1;
            let released = false;
            return {
              release: () => {
                if (released) return;
                released = true;
                if (reservedScope) {
                  activeScopes.delete(task.id);
                  activeScopeColumns.delete(task.id);
                }
                reservedWorktreeSlots = releaseReservedSlot(reservedWorktreeSlots);
                reservedConcurrentSlots = releaseReservedSlot(reservedConcurrentSlots);
                dispatchPrepByTaskId.delete(task.id);
                if (dropPreHeldExecutorSlot(task.id)) sem?.release();
                if (acquiredSymbols) {
                  void this.store.releaseSymbolLocks(acquiredSymbols, task.id);
                }
              },
            };
          } catch (error) {
            if (dropPreHeldExecutorSlot(task.id)) sem?.release();
            if (reservedScope) {
              activeScopes.delete(task.id);
              activeScopeColumns.delete(task.id);
            }
            if (acquiredSymbols) {
              await this.store.releaseSymbolLocks(acquiredSymbols, task.id).catch(() => undefined);
            }
            throw error;
          }
        },
        allocateWorktree: (task, reservedNames) =>
          this.planWorktreePath(task, settings.worktreeNaming, reservedNames, settings),
      });
      for (const taskId of result.released) {
        // The authoritative move has made this task visible to canonical live-task
        // counting; the transient project reservation no longer needs to bridge it.
        projectAdmissionCoordinator.releaseReservation(taskId);
        const prep = dispatchPrepByTaskId.get(taskId);
        if (!prep) continue;
        /*
        FNXC:WorkflowScheduling 2026-06-23-21:49:
        A workflow hold release is not a committed dispatch until moveTask succeeds and appears in result.released. Only then may the scheduler emit "Starting" and clear queued state.

        FNXC:WorkflowScheduling 2026-06-23-22:36:
        Persist dispatch metadata before executor handoff when possible, but isolate update/log failures per task. A metadata failure must not block later released tasks or strand an already released task without onSchedule handoff.
        */
        schedulerLog.log(`Starting ${taskId}: ${prep.task.title || taskId} (deps satisfied)`);
        const latest = await this.store.getTask(taskId).catch(() => null);
        const dispatchUpdate = {
          status: null,
          blockedBy: null,
          executionStartBranch: prep.baseBranch ?? undefined,
          effectiveNodeId: prep.effectiveNodeId,
          effectiveNodeSource: prep.effectiveNodeSource,
          mergeRetries: 0,
          dispatchStormCount: prep.dispatchStormCount,
          lastDispatchAt: prep.dispatchTimestamp,
        };
        const scheduledTask = {
          ...(latest?.id === taskId ? latest : prep.task),
          ...dispatchUpdate,
          status: undefined,
          blockedBy: undefined,
          effectiveNodeId: prep.effectiveNodeId ?? undefined,
          effectiveNodeSource: prep.effectiveNodeSource as Task["effectiveNodeSource"],
          column: "in-progress" as const,
        };
        try {
          await this.store.updateTask(taskId, dispatchUpdate);
        } catch (error) {
          schedulerLog.error(`Post-release dispatch metadata update failed for ${taskId}:`, error);
        }
        try {
          this.options.onSchedule?.(scheduledTask);
        } catch (error) {
          schedulerLog.error(`onSchedule failed for ${taskId}:`, error);
        }
        this.recentEngineTodoRequeues.delete(taskId);
        this.wasNodeBlocked.delete(taskId);
        this.wasNodeDispatchValidationBlocked.delete(taskId);
        this.wasPermanentAgentUnavailable.delete(taskId);
        this.clearDispatchQueuedReasonMemo(taskId);
        try {
          await this.store.logEntry(taskId, `Node routing resolved: ${prep.effectiveNodeId ?? "local"} (source: ${prep.effectiveNodeSource})`);
        } catch (error) {
          schedulerLog.error(`Post-release dispatch log failed for ${taskId}:`, error);
        }
      }
    } catch (error) {
      schedulerLog.error("Hold/release sweep failed:", error);
    }
  }

  /**
   * Handle a mission-linked task column move.
   * Keeps feature state synchronized with task columns across the full task
   * lifecycle, including review/merge transitions and older tasks whose task
   * row has mission/slice metadata but whose feature row lacks taskId.
   */
  private async handleMissionTaskMove(taskId: string, toColumn: import("@fusion/core").ColumnId): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const task = await this.store.getTask(taskId);
      if (!task) {
        return;
      }

      const feature = await this.resolveMissionFeatureForTask(missionStore, task);
      if (!feature) {
        /*
        FNXC:EngineDiagnostics 2026-08-03-05:54:
        Most tasks are not mission-linked. Skipping mission status is the expected steady-state path,
        not an operator-visible event — keep it off the default TUI unless FUSION_DEBUG=scheduler.
        */
        schedulerLog.debug(`No linked feature found for task ${taskId} (sliceId=${task.sliceId ?? "none"}) — skipping mission status update`);
        return;
      }

      if (task.sliceId && feature.sliceId !== task.sliceId) {
        schedulerLog.warn(
          `Task ${taskId} sliceId ${task.sliceId} does not match linked feature ${feature.id} sliceId ${feature.sliceId}; skipping mission update`,
        );
        return;
      }

      const hasLinkedAssertions = (await missionStore.listAssertionsForFeature(feature.id)).length > 0;

      const reconciliation = await reconcileMissionFeatureState(
        this.store,
        { ...task, column: toColumn },
        feature,
        {
          hasLinkedAssertions,
          plannerColumns: await resolvePlannerLanesForTask(this.store, task.id),
        },
      );

      const sliceIdBeforeUpdate = feature.sliceId;

      /*
      FNXC:SpecLockMissionAlignment 2026-08-10-16:17:
      Scheduler move reconciliation is a production consumer of deterministic drift. Persist its
      orthogonal projection even when delivery status is unchanged, or the evaluated alignment is
      discarded before Mission Manager can render the roadmap's actual state.
      */
      if (await persistMissionFeatureReconciliation(missionStore, feature, reconciliation)) {
        if (reconciliation.kind === "update") {
          schedulerLog.log(
            `Feature ${feature.id} marked ${reconciliation.status} (${reconciliation.reason})`,
          );
        }
      }

      if (reconciliation.kind === "blocked") {
        schedulerLog.warn(`Task ${taskId} mission update blocked — ${reconciliation.reason}`);
        return;
      }

      if (reconciliation.kind === "failure") {
        schedulerLog.warn(`Task ${taskId} mission update reported failure — ${reconciliation.reason}`);
        return;
      }

      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-20:40 (fleet — mission completion advance):
      "Did this task just COMPLETE?" resolved from the destination column's own trait.

      Keyed on `toColumn === "done"`, a renamed board never advanced mission execution: the feature
      status above was reconciled (that path already resolves traits), but the follow-on completion
      never fired, so the mission stalled with its roadmap showing the work finished. The two halves
      of one handler disagreed about whether the same move was a completion.

      Fail-soft to the legacy literal via `isCompleteColumnRole`'s documented no-metadata behaviour —
      an unresolvable workflow keeps today's behaviour rather than stalling the mission.
      */
      let completionFlags: ColumnRoleTraitFlags | undefined;
      try {
        const ir = await resolveWorkflowIrForTask(this.store, taskId);
        const column = (ir as WorkflowIrV2).columns?.find((candidate) => candidate.id === toColumn);
        if (column) completionFlags = resolveColumnFlags(column);
      } catch {
        // Unresolvable workflow: fall back to the legacy `done` literal below.
      }
      if (isCompleteColumnRole(completionFlags, toColumn)) {
        await this.handleMissionTaskCompletion(taskId, sliceIdBeforeUpdate);
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task move for ${taskId}:`, err);
    }
  }

  private async resolveMissionFeatureForTask(missionStore: MissionStore | AsyncMissionStore, task: Task): Promise<MissionFeature | undefined> {
    const linkedFeature = await resolveMissionFeatureForTask(missionStore, task);
    if (linkedFeature) {
      return linkedFeature;
    }

    if (!task.sliceId || !task.title) {
      return undefined;
    }

    const normalizedTaskTitle = this.normalizeMissionFeatureTitle(task.title);
    const matchingFeature = (await missionStore
      .listFeatures(task.sliceId))
      .find((feature) =>
        !feature.taskId
        && this.normalizeMissionFeatureTitle(feature.title) === normalizedTaskTitle
      );

    if (!matchingFeature) {
      return undefined;
    }

    schedulerLog.warn(
      `Repairing one-way mission link: task ${task.id} matched unlinked feature ${matchingFeature.id}`,
    );
    return missionStore.linkFeatureToTask(matchingFeature.id, task.id);
  }

  private normalizeMissionFeatureTitle(title: string): string {
    return title.trim().replace(/\s+/g, " ").toLowerCase();
  }

  /**
   * Handle mission task completion.
   * When a task moves to "done", advance mission execution after the linked
   * feature status has already been reconciled by handleMissionTaskMove().
   * updateFeatureStatus cascades via recomputeSliceStatus — if all features
   * in the slice are done the slice status becomes "complete" automatically.
   *
   * If MissionAutopilot is configured, delegate slice advancement to it
   * (which tracks autopilot state and handles retries). Otherwise fall back
   * to the legacy onSliceComplete() path for non-autopilot missions.
   */
  private async handleMissionTaskCompletion(taskId: string, sliceId: string): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const feature = await missionStore.getFeatureByTaskId(taskId);
      if (!feature) return;

      if (feature.sliceId !== sliceId) {
        schedulerLog.warn(
          `Task ${taskId} sliceId ${sliceId} does not match linked feature ${feature.id} sliceId ${feature.sliceId}; skipping mission completion update`,
        );
        return;
      }

      const sliceIdBeforeUpdate = feature.sliceId;

      // Trigger the mission execution loop to run validation
      // This is called regardless of whether the slice is complete - the loop
      // handles the validation cycle independently
      if (this.options.missionExecutionLoop) {
        if (!this.options.missionExecutionLoop.isRunning()) {
          schedulerLog.warn(
            `MissionExecutionLoop was not running during task completion for ${taskId}; starting loop before processing outcome`,
          );
          this.options.missionExecutionLoop.start();
        }

        void this.options.missionExecutionLoop.processTaskOutcome(taskId).catch((err) => {
          schedulerLog.error(`Error in missionExecutionLoop.processTaskOutcome for ${taskId}:`, err);
        });
      }

      // Check if the slice became complete after the feature update
      const slice = await missionStore.getSlice(sliceIdBeforeUpdate);
      if (slice && slice.status === "complete") {
        // If MissionAutopilot is available AND actively watching this mission,
        // delegate progression to it. The autopilot handles: watching missions,
        // autoAdvance guard, retry logic, and state tracking. The autopilot
        // will call back into scheduler.activateNextPendingSlice() when appropriate.
        //
        // If autopilot is not watching this mission (e.g., legacy missions with
        // autoAdvance=true but no autopilot instance, or autopilot unwatched),
        // fall back to onSliceComplete() which uses the compatibility rule.
        const autopilot = this.options.missionAutopilot;
        const milestone = await missionStore.getMilestone(slice.milestoneId);
        const missionId = milestone?.missionId;
        const isWatching = autopilot && missionId ? autopilot.isWatching(missionId) : false;

        if (autopilot && isWatching) {
          schedulerLog.log(`Slice ${slice.id} is complete — delegating to autopilot`);
          await autopilot.handleTaskCompletion(taskId);
        } else {
          // Fallback path: onSliceComplete uses autopilotEnabled/autoAdvance compat
          schedulerLog.log(`Slice ${slice.id} is complete — triggering auto-advance`);
          await this.onSliceComplete(slice);
        }
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task completion for ${taskId}:`, err);
    }
  }

  async onSliceComplete(slice: import("@fusion/core").Slice): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const milestone = await missionStore.getMilestone(slice.milestoneId);
      if (!milestone) {
        schedulerLog.warn(`Milestone ${slice.milestoneId} not found for slice ${slice.id}`);
        return;
      }

      const mission = await missionStore.getMission(milestone.missionId);
      // Use autopilotEnabled as canonical, fall back to autoAdvance for backward compat
      const shouldAutoAdvance =
        mission?.autopilotEnabled === true || mission?.autoAdvance === true;
      if (!mission || mission.status !== "active" || !shouldAutoAdvance) {
        return;
      }

      const nextSlice = await this.activateNextPendingSlice(mission.id);
      if (nextSlice) {
        schedulerLog.log(`Auto-advanced: activated slice ${nextSlice.id} for mission ${mission.id}`);
      }
    } catch (err) {
      schedulerLog.error(`Error handling slice completion for ${slice.id}:`, err);
    }
  }

  /**
   * Activate the next pending slice in a mission.
   * Finds the first milestone with pending slices and activates
   * the first pending slice in that milestone.
   *
   * @param missionId - Mission ID
   * @returns The activated slice, or null if no pending slices
   */
  async activateNextPendingSlice(missionId: string): Promise<import("@fusion/core").Slice | null> {
    if (!this.options.missionStore) return null;

    const missionStore = this.options.missionStore;

    try {
      // The store atomically re-reads the hierarchy and claims the candidate.
      // A duplicate signal is an expected no-op, not a scheduler error.
      const activated = await missionStore.tryActivateNextPendingSlice(missionId);
      if (activated) {
        schedulerLog.log(`Activated slice ${activated.id} for mission ${missionId}`);
        return activated;
      }

      schedulerLog.log(`Mission ${missionId}: no serially eligible slice to activate`);
      return null;
    } catch (err) {
      schedulerLog.error(`Error activating next slice for mission ${missionId}:`, err);
      return null;
    }
  }

  /**
   * Reconcile feature status for all active missions on startup.
   *
   * This ensures that feature statuses are in sync with their linked task
   * columns for all missions, not just autopilot-enabled ones. The
   * reconciliation logic mirrors MissionAutopilot.reconcileMissionConsistency()
   * but runs unconditionally on startup.
   *
   * @returns The total number of fixes applied across all missions
   */
  async reconcileAllMissionFeatures(): Promise<number> {
    if (!this.options.missionStore) {
      return 0;
    }

    const missionStore = this.options.missionStore;
    let totalFixed = 0;

    try {
      const missions = await missionStore.listMissions();
      const activeMissions = missions.filter((m) => m.status === "active");
      const activeMissionIds = new Set(activeMissions.map((mission) => mission.id));
      const taskBySliceAndTitle = new Map<string, Task | null>();
      const missionTasks = await this.store.listTasks({ slim: true, includeArchived: false });

      for (const task of missionTasks) {
        if (!task.missionId || !task.sliceId || !task.title || !activeMissionIds.has(task.missionId)) {
          continue;
        }

        const key = this.getMissionFeatureTitleKey(task.sliceId, task.title);
        taskBySliceAndTitle.set(
          key,
          taskBySliceAndTitle.has(key) ? null : task,
        );
      }

      for (const mission of activeMissions) {
        const hierarchy = await missionStore.getMissionWithHierarchy(mission.id);
        if (!hierarchy) continue;

        const activeSlices = hierarchy.milestones
          .flatMap((milestone) => milestone.slices)
          .filter((slice) => slice.status === "active");

        for (const slice of activeSlices) {
          const missionAutoTriageEnabled = mission.autopilotEnabled === true || mission.autoAdvance === true;
          const supersededFixes = await missionStore.reconcileSupersededGeneratedFixFeatures(slice.id);
          if (supersededFixes.supersededCount > 0) {
            totalFixed += supersededFixes.supersededCount;
            schedulerLog.warn(
              `Superseded ${supersededFixes.supersededCount} stale generated fix feature(s) during mission reconciliation for slice ${slice.id}`,
            );
          }
          const features = supersededFixes.supersededCount > 0
            ? await missionStore.listFeatures(slice.id)
            : slice.features;
          const supersededFeatureIds = new Set(supersededFixes.featureIds);

          if (supersededFixes.supersededCount > 0) {
            const refreshedSlice = await missionStore.getSlice(slice.id);
            if (refreshedSlice?.status === "complete") {
              /*
              FNXC:Missions 2026-07-11-12:35:
              Startup reconciliation can terminalize every stale generated-fix feature in an active slice before the scheduler loop runs no-task recovery.
              Treat the recomputed complete slice as complete immediately so stale fixes do not keep an active slice from advancing after restart.
              */
              await this.onSliceComplete(refreshedSlice);
              continue;
            }
          }

          for (const feature of features) {
            let featureForReconciliation = feature;
            let task: Task | undefined;
            if (supersededFeatureIds.has(feature.id)) {
              /*
              FNXC:Missions 2026-07-11-12:35:
              The title-to-task map is built before generated-fix supersedence detaches stale task ownership.
              Skip freshly superseded features so pre-reconciliation task links cannot be restored in the same startup sweep.
              */
              continue;
            }
            if (feature.status === "done" && this.isGeneratedFixFeature(feature) && !feature.taskId) {
              /*
              FNXC:Missions 2026-07-11-12:35:
              Done generated-fix features with no task ownership are terminal after supersedence clears their board links.
              Keep any done feature that still has task ownership in startup self-healing so linked task drift can still be repaired.
              */
              continue;
            }
            if (feature.taskId) {
              task = await this.store.getTask(feature.taskId);
            } else {
              const matchedTask = taskBySliceAndTitle.get(
                this.getMissionFeatureTitleKey(feature.sliceId, feature.title),
              );
              if (matchedTask) {
                schedulerLog.warn(
                  `Repairing one-way mission link during reconciliation: task ${matchedTask.id} matched unlinked feature ${feature.id}`,
                );
                featureForReconciliation = await missionStore.linkFeatureToTask(feature.id, matchedTask.id);
                task = matchedTask;
                totalFixed++;
                await this.emitStrandedFeatureTriageAudit(mission.id, slice.id, feature.id, matchedTask.id);
              } else if (
                missionAutoTriageEnabled
                && feature.status !== "blocked"
              ) {
                if (feature.status !== "defined" && this.isGeneratedFixFeature(feature)) {
                  try {
                    schedulerLog.warn(
                      `Blocking stranded generated fix feature ${feature.id}: no linked task and no title-matched task available`,
                    );
                    await missionStore.updateFeature(feature.id, {
                      status: "blocked",
                      loopState: "blocked",
                      taskId: undefined,
                    });
                    totalFixed++;
                  } catch (error) {
                    schedulerLog.warn(
                      `Failed to block stranded fix feature ${feature.id} during reconciliation: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                } else if (feature.status === "defined" || feature.status === "triaged" || feature.status === "in-progress") {
                  try {
                    const featureToTriage = feature.status === "defined"
                      ? feature
                      : await missionStore.updateFeature(feature.id, {
                        status: "defined",
                        loopState: "idle",
                        taskId: undefined,
                      });
                    if (featureToTriage.status !== feature.status) {
                      totalFixed++;
                    }
                    featureForReconciliation = await missionStore.triageFeature(featureToTriage.id);
                    task = featureForReconciliation.taskId
                      ? await this.store.getTask(featureForReconciliation.taskId)
                      : undefined;
                    totalFixed++;
                    if (featureForReconciliation.taskId) {
                      await this.emitStrandedFeatureTriageAudit(
                        mission.id,
                        slice.id,
                        featureForReconciliation.id,
                        featureForReconciliation.taskId,
                      );
                    }
                  } catch (error) {
                    schedulerLog.warn(
                      `Failed to triage stranded feature ${feature.id} during reconciliation: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                } else {
                  schedulerLog.warn(
                    `Skipping stranded feature ${feature.id} with terminal status ${feature.status}: no linked task and no title-matched task available`,
                  );
                }
              }
            }

            if (!task) continue;

            const hasLinkedAssertions = (await missionStore.listAssertionsForFeature(featureForReconciliation.id)).length > 0;
            const reconciliation = await reconcileMissionFeatureState(this.store, task, featureForReconciliation, {
              hasLinkedAssertions,
            });

            /*
            FNXC:SpecLockMissionAlignment 2026-08-10-16:17:
            Periodic reconciliation must retain the same drift projection as event-driven moves;
            otherwise a quiet task's alignment disappears until an unrelated status transition.
            */
            if (await persistMissionFeatureReconciliation(missionStore, featureForReconciliation, reconciliation)) {
              totalFixed++;
            }

            if (reconciliation.kind === "failure") {
              if (this.options.onTaskFailed) {
                await this.options.onTaskFailed(task.id);
                totalFixed++;
              } else {
                schedulerLog.warn(`Skipping failed feature reconciliation for ${feature.id} — ${reconciliation.reason}`);
              }
              continue;
            }

            if (reconciliation.kind === "blocked") {
              schedulerLog.warn(`Skipping feature ${feature.id} reconciliation — ${reconciliation.reason}`);
              continue;
            }

          }
        }
      }

      if (totalFixed > 0) {
        schedulerLog.log(`Mission feature reconciliation: fixed ${totalFixed} inconsistencies`);
      }
    } catch (err) {
      schedulerLog.error("Error during mission feature reconciliation:", err);
    }

    return totalFixed;
  }

  private async emitStrandedFeatureTriageAudit(
    missionId: string,
    sliceId: string,
    featureId: string,
    taskId: string,
  ): Promise<void> {
    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("scheduler-mission-stranded-feature", featureId),
      agentId: "scheduler",
      taskId,
      phase: "mission-stranded-feature-reconcile",
    });

    try {
      await auditor.database({
        type: "mission:stranded-feature-triaged",
        target: featureId,
        metadata: {
          missionId,
          sliceId,
          featureId,
          taskId,
        },
      });
    } catch (error) {
      schedulerLog.warn(
        `Feature ${featureId} failed to emit stranded-feature triage audit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getMissionFeatureTitleKey(sliceId: string, title: string): string {
    return `${sliceId}\0${this.normalizeMissionFeatureTitle(title)}`;
  }

  private isGeneratedFixFeature(feature: Pick<MissionFeature, "generatedFromFeatureId" | "generatedFromRunId">): boolean {
    return Boolean(feature.generatedFromFeatureId || feature.generatedFromRunId);
  }
}
