import {
  isReleaseGateVerdictFresh,
  RELEASE_GATE_VERDICT_MAX_AGE_MS,
  releaseGateEvidenceFingerprint,
} from "../utils/releaseGate";
import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, Column, ColumnId, TaskCreateInput, MergeResult, GithubIssueAction, AgentLogEntry, TaskColumnSortMode } from "@fusion/core";
// FNXC:WorkflowLifecycleColumns 2026-07-30-11:50: these are AGENT ROLE comparisons, not
// column guards — the planner LANE keeps the name `triage`; U11 removed only the COLUMN.
import { PLANNER_AGENT_ROLE, normalizeColumnId } from "@fusion/core";
import * as api from "../api";
import type { TaskResetOptions } from "../api/tasks/tasks-lifecycle";
import { subscribeSse } from "../sse-bus";
import { clearCache, readCache, readCacheSavedAt, SWR_CACHE_KEYS, SWR_TASKS_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { pushTrace } from "../utils/dashboardTraceBuffer";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { isLikelyTabSuspensionError } from "./visibilitySuspension";
import { isIntakeColumnRole, isHoldColumnRole, type ColumnRoleFlags } from "../utils/columnRoles";
import { isForeignTaskEvent, readTaskEventProjectId, stripTaskEventProjectId } from "../utils/taskEventProjectScope";

const loggedTaskCacheHitProjects = new Set<string>();

/*
FNXC:MobileTabDiscard 2026-07-26-16:40:
Destroying the task snapshot is only justified when the server actually answered and disagreed with it
(non-2xx, or a response that would not parse). A transport-level rejection on a waking mobile radio —
"Load failed" / "Failed to fetch" / an offline navigator — proves nothing about the snapshot's contents.

Before this guard, the mount revalidation's `clearOnError` catch ran on those rejections and both blanked
the hydrated board and deleted the cache entry, so the NEXT restore also started empty: a suspension
failure permanently defeated the feature the raised `SWR_TASKS_MAX_AGE_MS` exists to serve. Nine sibling
hooks (useProjects, useNodes, useMeshState, useExecutorStats, useUsageData, useMeshEngines,
useManagedDockerNodes, useProjectHealth) already guard this with the same `visibilitySuspension`
predicate; this reuses it rather than adding a tenth copy.

`navigator.onLine === false` is authoritative for "no request left the device"; `true` is not evidence of
reachability, so the message check still has to run. `lastRefreshErrorAt` is set either way, so the
re-entry/visibility retry paths still fire.
*/
function didFailureReachServer(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return !isLikelyTabSuspensionError(message);
}

/*
FNXC:MobileTabDiscard 2026-07-26-10:40:
Snapshot-write budget. `writeCache` drops any payload over `maxBytes`, and it dropped SILENTLY: a board
with many long-lived tasks (each carrying an unbounded `log` array) serialized past 500KB, so nothing
was ever cached and the mobile-discard restore had no snapshot to hydrate from at all — the cache
appeared to "work" while being a no-op exactly on the boards that need it most. The snapshot is a render
seed, not a data mirror, so `log` is stripped (the board never renders it; task detail fetches its own),
and on a still-over-budget payload the row count is shrunk until the write lands.
*/
const TASK_CACHE_MAX_BYTES = 500_000;
const TASK_CACHE_ROW_LIMITS = [500, 250, 100, 50] as const;

function toCachedTaskRow(task: Task): Task {
  const log = (task as Task & { log?: unknown }).log;
  if ((!Array.isArray(log) || log.length === 0) && task.releaseGate === undefined) return task;
  const { log: _droppedLog, releaseGate: _transientReleaseGate, ...rest } = task as Task & { log?: unknown };
  /*
  FNXC:PromoteVisibility 2026-08-11-21:06:
  A cached release verdict has no hook-local evidence provenance and may already be expired. Persist
  the task snapshot without it so cache hydration immediately takes the conservative Promote fallback.
  */
  return rest as Task;
}

/** Persist the board snapshot, shrinking row count until it fits the quota budget. Returns whether anything was written. */
function writeTaskCacheSnapshot(cacheKey: string, tasks: Task[]): boolean {
  for (const limit of TASK_CACHE_ROW_LIMITS) {
    const payload = tasks.length > limit ? tasks.slice(0, limit).map(toCachedTaskRow) : tasks.map(toCachedTaskRow);
    // `!== false` so a test double that returns undefined is treated as a successful write
    // rather than driving the shrink loop down to its smallest tier.
    if (writeCache(cacheKey, payload, { maxBytes: TASK_CACHE_MAX_BYTES }) !== false) {
      return true;
    }
  }
  return false;
}

/*
FNXC:WorkflowColumns 2026-07-19-2b:05 (U12 / R2 / R11):
Every task the dashboard ingests — initial list, SWR revalidation, and each SSE event — passes
through here, so this one line decided whether custom columns exist in the UI at all. It used
`normalizeColumn` (since DELETED in U12), which kept only the six legacy ids and rewrote everything else to `triage`:
a card sitting in a user-authored `Merging` column rendered in Triage, and dragging it appeared to
do nothing. The move handler below already worked around this for its own `to` id ("normalizeColumn
alone would drop custom ids"), which fixed the symptom for one event and left the ingest path lossy.
`normalizeColumnId` sanitizes structurally (non-string/empty -> fallback) and passes real ids
through; membership belongs to the task's resolved workflow, not to a client-side enum.
*/
function normalizeTask(task: Task): Task {
  return {
    ...task,
    column: normalizeColumnId((task as Task & { column?: unknown }).column),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    steps: Array.isArray(task.steps) ? task.steps : [],
    log: Array.isArray((task as Task & { log?: unknown }).log)
      ? (task as Task & { log?: Task["log"] }).log!
      : [],
  };
}

/*
FNXC:PromoteVisibility 2026-08-13-22:23:
Only GET /api/tasks pairs a release verdict with the complete hold-lane evidence used to evaluate it.
SSE is a store-derived lifecycle channel, so remove any verdict defensively before every SSE path,
including reconnect-gap upserts; a producer regression must resolve to the conservative fallback.
*/
function stripTransientReleaseGate(task: Task): Task {
  if (!Object.prototype.hasOwnProperty.call(task, "releaseGate")) return task;
  const { releaseGate: _transientReleaseGate, ...taskWithoutReleaseGate } = task;
  return taskWithoutReleaseGate as Task;
}

function normalizeNonBoardTask(task: Task): Task {
  return normalizeTask(stripTransientReleaseGate(task));
}

function isSoftDeleted(task: Task): boolean {
  return Boolean(task.deletedAt);
}

function filterActiveTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !isSoftDeleted(task));
}

type AgentLogActivityEvent = Pick<AgentLogEntry, "taskId" | "timestamp" | "type" | "agent">;

function hasFreshAgentLog(task: Task, entry: AgentLogActivityEvent): boolean {
  if (task.id !== entry.taskId) return false;
  const logTimestampMs = Date.parse(entry.timestamp);
  const taskUpdatedAtMs = Date.parse(task.updatedAt);
  return Number.isFinite(logTimestampMs)
    && Number.isFinite(taskUpdatedAtMs)
    && logTimestampMs > taskUpdatedAtMs;
}

function clearInReviewStallForFreshAgentLog(task: Task, entry: AgentLogActivityEvent): Task {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-06:20 (batch-dashboard-app — the column check is REDUNDANT,
  and removing it fixes a live bug):

  THE COLUMN CHECK IS DELETED, not converted, because the line below already implies it. All three
  stall fields are produced ONLY for review-lane cards — every assignment in `task-store/reads.ts`
  routes through a producer that gates on review itself:

    inReviewStall    getInReviewStallReason      (gates on the review lane)
    inReviewStalled  getInReviewStalledSignal    (gates on the review ROLE — already trait-converted)
    stalledReview    detectStalledReview         (gates on the review lane)

  So `!task.inReviewStall && !task.inReviewStalled && !task.stalledReview` already means "not a
  review card with a stall badge", and re-asserting the column added nothing a correct board could
  observe.

  WHAT IT DID ADD WAS A BUG, and it is live today rather than pending anything. `inReviewStalled` is
  ALREADY resolved by role, so a renamed board DOES produce that badge — and this literal then
  refused to clear it while a review agent was actively writing logs. The card read "stalled" for
  the whole time work was visibly happening, which is exactly what this function exists to prevent.

  I previously recorded this as a cross-batch coupling that cancelled out and had to be ordered
  against core. That was wrong on one of the three signals: the trait-converted one never cancelled.
  Deleting the check is correct before OR after any core change, and removes the ordering hazard
  instead of scheduling around it.
  */
  if (!hasFreshAgentLog(task, entry)) return task;
  if (!task.inReviewStall && !task.inReviewStalled && !task.stalledReview) return task;

  /*
  FNXC:DashboardStallBadges 2026-07-01-23:44:
  Board cards must not show Stalled/Merge stalled while an in-review agent is actively writing logs. The task row can remain unchanged during merger/reviewer work, so fresh agent-log metadata clears only derived stall badge fields until the next authoritative task refresh.
  */
  return {
    ...task,
    inReviewStall: undefined,
    inReviewStalled: undefined,
    stalledReview: undefined,
  };
}

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
This is the SOURCE of the planner-activity signal, and it was the narrowest gate of all:
it only stamped `recentAgentActivityAt` for cards literally in `triage`. #2515 removed
that column from the default lineage, so after that merge the stamp never happened for a
default-workflow card — and every consumer downstream (the pulsing Planning badge, the
agent-active row border, the column's executing count) had NO DATA to act on, however
correctly they resolved their own column traits.

Converting the consumers without this would have been cosmetic: they would ask the right
question of a field nothing ever set.

This hook processes SSE and has no resolved column metadata, so the lane is matched by id
against BOTH shapes — pre-merge `triage` and post-merge `todo`. Over-stamping a legacy
hold-lane card is harmless: every consumer additionally requires the column to be an
INTAKE lane before showing anything, so the extra timestamps are filtered downstream.
*/
const PLANNER_ACTIVITY_COLUMN_IDS = new Set(["triage", "todo"]);

/*
FNXC:WorkflowResolvedColumns 2026-07-31-03:45:
THE STAMP MISSED RENAMED INTAKE LANES ENTIRELY, which the note above does not cover.

That note argues over-stamping is harmless because every consumer re-checks for an INTAKE lane
before showing anything. True, and it only protects against false POSITIVES. On a board whose intake
and hold lanes are renamed, `{triage, todo}` matches nothing, so no stamp is ever written — and a
correct downstream role check has nothing to filter. The planning border and pulsing badge never
appear while the planner is actively working the card.

Resolved traits win; the legacy pair stays as the no-flags fallback, so an unconverted caller and the
remote-node path are byte-identical. Intake OR hold, mirroring what the pair meant: pre-merge
`triage` was intake and post-merge `todo` is the hold lane.
*/
function isPlannerActivityLane(task: Task, flags: ColumnRoleFlags | undefined): boolean {
  if (!flags) return PLANNER_ACTIVITY_COLUMN_IDS.has(task.column);
  return isIntakeColumnRole(flags, task.column) || isHoldColumnRole(flags, task.column);
}

function addRecentPlannerActivityForFreshAgentLog(
  task: Task,
  entry: AgentLogActivityEvent,
  flags: ColumnRoleFlags | undefined,
): Task {
  if (
    !isPlannerActivityLane(task, flags)
    || task.status === "planning"
    || entry.agent !== PLANNER_AGENT_ROLE
    || !hasFreshAgentLog(task, entry)
  ) {
    return task;
  }

  /*
  FNXC:TaskActivity 2026-07-28-12:00:
  A Planning card's border and pulsing badge must agree with the live planner
  timeline. A fresh triage log can arrive before its status row, so retain this
  client-only render signal until an authoritative task update replaces the row.
  */
  return task.recentAgentActivityAt === entry.timestamp
    ? task
    : { ...task, recentAgentActivityAt: entry.timestamp };
}

/**
 * Compare two ISO timestamp strings.
 * Returns positive if a is newer than b, negative if b is newer, 0 if equal.
 */
function compareTimestamps(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1; // b is newer if a has no timestamp
  if (!b) return 1;  // a is newer if b has no timestamp
  return a.localeCompare(b);
}

/*
FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
`awaitingPlanning` is attached by `GET /api/tasks` only — SSE task payloads come straight from the
store, so a status-only live update would otherwise wipe it and flip TaskCard's badge back to its
step-count fallback mid-stall. Carry it across same-column updates, but ONLY while the step count is
unchanged: planning finishing is exactly a step-count change, and a stale `true` surviving that would
keep claiming "Queued to plan" for a card that is now Ready until the next full board fetch. When it
is dropped the fallback answers correctly in both directions (steps landed -> Ready, steps cleared ->
queued), so the degraded state is never the wrong label.
*/
function carryAwaitingPlanning(current: Task, incoming: Task): boolean | undefined {
  if (incoming.awaitingPlanning !== undefined) return incoming.awaitingPlanning;
  const stepCountUnchanged = (current.steps?.length ?? 0) === (incoming.steps?.length ?? 0);
  return stepCountUnchanged ? current.awaitingPlanning : undefined;
}

/*
FNXC:PromoteVisibility 2026-08-11-20:38:
A wrong badge self-corrects, but a wrong Promote decision can start execution. SSE lacks the IR,
continuation, and prompt inputs, so retain a REST verdict only across identical visible evidence and
its server row clock, bounded by TTL; every doubt drops to the conservative fallback.
*/
function carryReleaseGate(
  current: Task,
  incoming: Task,
  merged: Task,
  provenance: Map<string, import("../utils/releaseGate").ReleaseGateProvenance> | undefined,
  now = Date.now(),
): Task["releaseGate"] {
  if (incoming.releaseGate !== undefined) {
    const freshProvenance = { fingerprint: releaseGateEvidenceFingerprint(merged), capturedAt: now };
    /*
    FNXC:PromoteVisibility 2026-08-11-21:06:
    A complete response may arrive after a newer row. Its verdict is evidence only when it was
    evaluated for the row being rendered, rather than merely being a defined payload field.
    */
    if (!isReleaseGateVerdictFresh(incoming.releaseGate, merged, freshProvenance, now)) {
      provenance?.delete(current.id);
      return undefined;
    }
    provenance?.set(current.id, freshProvenance);
    return incoming.releaseGate;
  }
  if (!current.releaseGate) return undefined;
  const retained = isReleaseGateVerdictFresh(current.releaseGate, merged, provenance?.get(current.id), now);
  if (!retained) provenance?.delete(current.id);
  return retained ? current.releaseGate : undefined;
}

/*
FNXC:TaskDetailStateStability 2026-08-05-02:55:
The scheduler can refresh the board while a task-detail host holds a newer queued dependency or
file-overlap snapshot. Providers (SWR, SSE, fetchTaskDetail, and local mutations) do not share an
arrival order, so lifecycle rendering must use the existing timestamp evidence: a later `columnMovedAt`
owns a real column transition; within that column, a later `updatedAt` owns status. Equal or absent
clock evidence retains the already-visible known lifecycle state unless a complete server snapshot is
newer than the row and resolves an equal legacy move clock; sparse SSE patches never receive that tie-break.

This helper intentionally merges only defined sparse fields. A slim or sparse payload's absent, empty, or whitespace-only prompt is not evidence that a loaded plan was cleared, and an empty log is not evidence that a populated journal was cleared; marked full snapshots remain authoritative for both fields. Every open-detail host and useTasks ingestion uses this one boundary so one provider cannot regress a modal, main panel, split detail, dock, or popup independently.

FNXC:TaskDetailStateStability 2026-08-09-07:13:
`mergeTaskSnapshot` arbitrates server snapshots only. Locally-authored detail patches must use
`applyLocalTaskPatch`: FN-5148 requires mismatched ids to be ignored while accepting an absent id, and
FN-8796 showed that an absent or equal local clock is not evidence of staleness.

FNXC:TaskDetailStateStability 2026-08-28-16:07:
A sparse blank prompt must not add a `prompt` key to a slim task row. Task detail uses key presence to
distinguish a complete detail from a board snapshot, so synthesizing that key would make a transient
empty payload look authoritative and could replace the loaded Definition plan with `(no prompt)`.
*/
export interface TaskSnapshotMergeOptions {
  /** Hook-local, non-persisted evidence captured when GET /api/tasks supplied a release verdict. */
  releaseGateProvenance?: Map<string, import("../utils/releaseGate").ReleaseGateProvenance>;
  /** A complete board/detail fetch can resolve an otherwise ambiguous legacy column clock. */
  fullSnapshot?: boolean;
  /** A canonical task:moved SSE payload names its destination, even when its clock ties the visible row. */
  authoritativeMove?: boolean;
  /** A canonical task event owns pause/status fields even when JSON omission represents a cleared value. */
  authoritativeLifecycle?: boolean;
}

export function mergeTaskSnapshot<T extends Task>(
  current: T,
  incoming: Task,
  options: TaskSnapshotMergeOptions = {},
): T {
  if (current.id !== incoming.id) return current;

  const merged = { ...current } as Record<string, unknown>;
  const updatedAtCompare = compareTimestamps(incoming.updatedAt, current.updatedAt);
  /*
  FNXC:TaskStatusConsistency 2026-08-05-04:14:
  Missing clocks are not authority: a legacy detail row and a sparse SSE patch with neither clock
  must retain populated metadata rather than letting their arrival order erase queue/workflow state.
  Only a strictly newer update clock, or an explicitly complete equal-clock fetch below, may replace it.
  */
  const acceptsIncomingSnapshot = updatedAtCompare > 0;
  // A fetch is explicitly marked complete at its call site. Equal clocks can only fill an absent
  // field from a sparse event; they replace populated fields only for a complete fetch.
  const acceptsEqualClockFields = options.fullSnapshot === true && updatedAtCompare === 0;
  for (const [key, value] of Object.entries(incoming)) {
    const canMergeField = acceptsIncomingSnapshot
      || acceptsEqualClockFields
      || (updatedAtCompare === 0 && merged[key] === undefined);
    if (value !== undefined && canMergeField) {
      merged[key] = value;
    }
  }

  /*
  FNXC:DashboardPauseState 2026-08-07-14:48:
  TaskStore clears optional pause lifecycle fields with `undefined`, so JSON omits them from REST and
  `task:updated` payloads. A newer full task row therefore needs omission to mean "cleared" for these
  fields; otherwise a passive dashboard retains an older `paused: true` forever. Keep this narrow to
  pause-owned fields so genuinely sparse payloads still preserve unrelated detail metadata.
  */
  const incomingOwnsLifecycleField = (field: "paused" | "userPaused" | "pausedByAgentId" | "pausedReason" | "status") =>
    options.authoritativeLifecycle === true
    || options.fullSnapshot === true
    || Object.prototype.hasOwnProperty.call(incoming, field);
  const acceptsEqualClockLifecycle = options.authoritativeLifecycle === true && updatedAtCompare === 0;
  if (acceptsIncomingSnapshot || acceptsEqualClockFields || acceptsEqualClockLifecycle) {
    if (incomingOwnsLifecycleField("paused")) merged.paused = incoming.paused;
    if (incomingOwnsLifecycleField("userPaused")) merged.userPaused = incoming.userPaused;
    if (incomingOwnsLifecycleField("pausedByAgentId")) merged.pausedByAgentId = incoming.pausedByAgentId;
    if (incomingOwnsLifecycleField("pausedReason")) merged.pausedReason = incoming.pausedReason;
  }


  const columnMovedAtCompare = compareTimestamps(incoming.columnMovedAt, current.columnMovedAt);
  /*
  FNXC:BoardBadgeFreshness 2026-08-05-05:26:
  `task:moved` is the post-commit lifecycle authority and includes its explicit destination. A board
  fetch can observe the task immediately before the move event, leaving identical clocks when one
  transition shares the engine's operation timestamp. Accept that equal-clock canonical move so cards,
  list rows, and open details change promptly; older clocks remain rejected, so delayed stale events
  cannot roll a newer badge backward.
  */
  const incomingMovesColumn = incoming.column !== undefined
    && (current.column === undefined
      || columnMovedAtCompare > 0
      || (options.authoritativeMove === true && columnMovedAtCompare === 0)
      // A full server snapshot is more complete than an SSE patch, so its newer task clock can
      // resolve a legacy equal move clock without letting a sparse event move the card.
      || (options.fullSnapshot === true && columnMovedAtCompare === 0 && updatedAtCompare > 0)
      // Older rows have no column-move clock. A newer task timestamp is still evidence for a real move.
      || (!current.columnMovedAt && !incoming.columnMovedAt && updatedAtCompare > 0));
  // An equal-clock fetch may resolve a stale client-only status only when it describes the same
  // lifecycle row. Otherwise accepting its status while rejecting its column would tear the pair.
  const acceptsEqualClockStatus = acceptsEqualClockFields
    && (incoming.column === undefined || incoming.column === current.column);
  const incomingUpdatesStatus = incomingOwnsLifecycleField("status")
    && (acceptsIncomingSnapshot
      || acceptsEqualClockStatus
      || acceptsEqualClockLifecycle
      || (incoming.status !== undefined
        && (current.status === undefined || incomingMovesColumn)));

  // The lifecycle fields are evidence-owned rather than object-spread-owned.
  merged.column = incomingMovesColumn ? incoming.column : current.column;
  merged.columnMovedAt = columnMovedAtCompare > 0 ? incoming.columnMovedAt : current.columnMovedAt;
  merged.status = incomingUpdatesStatus ? incoming.status : current.status;
  merged.updatedAt = updatedAtCompare > 0 ? incoming.updatedAt : current.updatedAt;
  merged.awaitingPlanning = acceptsIncomingSnapshot
    ? carryAwaitingPlanning(current, incoming)
    : current.awaitingPlanning;
  /*
  FNXC:PromoteVisibility 2026-08-11-21:06:
  A delayed snapshot cannot attach a defined verdict over a newer task row.
  */
  const acceptsReleaseGateSnapshot = acceptsIncomingSnapshot || acceptsEqualClockFields;
  merged.releaseGate = acceptsReleaseGateSnapshot
    ? carryReleaseGate(current, incoming, merged as unknown as Task, options.releaseGateProvenance)
    : current.releaseGate;
  /*
  FNXC:TaskStatusConsistency 2026-08-07-06:10:
  `recentAgentActivityAt` is a client-only bridge from an agent-log event to the next task snapshot.
  Preserve it while a stale payload is rejected so live Planning does not flash back to Queued. A
  complete equal-clock fetch clears it only when that same lifecycle row proves the status changed;
  otherwise an agent-log that arrived while the fetch was in flight remains newer evidence.
  */
  const equalClockStatusChanged = (acceptsEqualClockStatus || acceptsEqualClockLifecycle)
    && incoming.status !== current.status;
  merged.recentAgentActivityAt = acceptsIncomingSnapshot || equalClockStatusChanged
    ? incoming.recentAgentActivityAt
    : current.recentAgentActivityAt;

  const currentHasPrompt = "prompt" in current;
  const incomingPrompt = incoming.prompt;
  if (currentHasPrompt) {
    const currentPrompt = current.prompt;
    const sparseBlankCannotClear = options.fullSnapshot !== true
      && Boolean(currentPrompt?.trim())
      && !incomingPrompt?.trim();
    if (incomingPrompt === undefined || sparseBlankCannotClear) {
      merged.prompt = currentPrompt;
    }
  } else if (options.fullSnapshot !== true && !incomingPrompt?.trim()) {
    delete merged.prompt;
  }

  /*
  FNXC:TaskActivityFeed 2026-08-28-00:13:
  FN-205 found `stripTaskListHeavyFields` emits `log: []` for every slim SSE/list task payload. The
  task journal is append-only and trimmed server-side, so an absent or empty slim log is never evidence
  that a populated journal was cleared. Retain it independently of prompt presence; board-to-board
  merges remain inert because both slim rows have empty journals.

  A marked full detail snapshot is authoritative, including an honestly empty journal. It also adopts a
  populated journal over an empty current row even when its clock is older, because the empty stripped
  row is not competing journal evidence.
  */
  const currentLog = current.log;
  const incomingLog = incoming.log;
  if (options.fullSnapshot === true) {
    merged.log = incomingLog;
  } else if (currentLog && currentLog.length > 0 && (!incomingLog || incomingLog.length === 0)) {
    merged.log = currentLog;
  }

  return merged as T;
}

/*
FNXC:TaskDetailStateStability 2026-08-09-07:13:
Open detail views author sparse patches after a PATCH response or derived PR/review refresh. Unlike
server snapshots, these patches are applied by intent: FN-5148 ignores an explicit foreign id but
accepts an absent id. FN-8796's stale lifecycle protection remains only when both sides provide a
clock and the local patch is strictly older; absent and equal clocks are not stale evidence.
*/
export function applyLocalTaskPatch<T extends Task>(current: T, patch: Partial<Task>): T {
  if (patch.id !== undefined && patch.id !== current.id) return current;

  const merged = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }

  const hasClock = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (
    hasClock(patch.columnMovedAt)
    && hasClock(current.columnMovedAt)
    && compareTimestamps(patch.columnMovedAt, current.columnMovedAt) < 0
  ) {
    merged.column = current.column;
    merged.columnMovedAt = current.columnMovedAt;
  }
  if (
    hasClock(patch.updatedAt)
    && hasClock(current.updatedAt)
    && compareTimestamps(patch.updatedAt, current.updatedAt) < 0
  ) {
    merged.status = current.status;
    merged.updatedAt = current.updatedAt;
  }

  const mergedKeys = Object.keys(merged);
  if (mergedKeys.length === Object.keys(current).length && mergedKeys.every((key) => merged[key] === (current as Record<string, unknown>)[key])) {
    return current;
  }
  return merged as T;
}

export interface UseTasksOptions {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-03:40:
  Resolves a task's own column traits, so the planner-activity stamp below is a ROLE question.

  Supplied by App from the board-workflow payload. Absent (remote nodes, pre-load) the stamp falls
  back to the legacy id pair, which is the behaviour that shipped.
  */
  resolveColumnFlags?: (task: Task) => ColumnRoleFlags | undefined;
  /** Resolves the task's selected workflow, including the project-default fallback. */
  resolveWorkflowId?: (task: Task) => string | undefined;
  /** 
   * When provided, fetches tasks only for this project.
   * SSE events from other project contexts are ignored.
   */
  projectId?: string;
  /**
   * When provided, fetches tasks matching this search query.
   * Server-side full-text search across title, ID, description, and comments.
   */
  searchQuery?: string;
  /**
   * When false, disables SSE live-update subscription to free browser
   * HTTP/1.1 connection slots for other operations (e.g., mission detail fetches).
   * Initial fetch and visibility-change refresh remain active regardless.
   * Defaults to true.
   */
  sseEnabled?: boolean;
}

export function useTasks(options?: UseTasksOptions) {
  const projectId = options?.projectId;
  const resolveColumnFlags = options?.resolveColumnFlags;
  const resolveColumnFlagsRef = useRef(resolveColumnFlags);
  resolveColumnFlagsRef.current = resolveColumnFlags;
  const resolveWorkflowIdRef = useRef(options?.resolveWorkflowId);
  resolveWorkflowIdRef.current = options?.resolveWorkflowId;
  const searchQuery = options?.searchQuery;
  const sseEnabled = options?.sseEnabled ?? true;
  /*
  FNXC:MobileTabDiscard 2026-07-26-10:48:
  First paint after a mobile tab discard must show the last known board, not an empty one. This
  initializer is the only thing standing between the restore and a blank board, so it hydrates from a
  snapshot that may be hours old (`SWR_TASKS_MAX_AGE_MS`). That is safe only because hydration is
  always paired with revalidation: `isStale` starts true (App renders <TopProgressBar visible> off it)
  and the mount effect below unconditionally issues one `refreshTasks({ clearOnError: true })`.

  FNXC:MobileTabDiscard 2026-07-26-16:40:
  CORRECTION to the sentence this note used to end with ("whose failure branch CLEARS this cache entry
  so a wrong snapshot cannot survive into the next restore"): that is true only of a failure that
  REACHED THE SERVER. A transport-level rejection (suspended tab, offline radio) now leaves the entry
  and the painted rows alone, because it is not evidence the snapshot is wrong — and deleting on it made
  every flaky-radio restore blank, permanently. See the catch branch of `refreshTasks`.
  */
  /*
  FNXC:MobileTabDiscard 2026-07-26-14:12:
  Captured by the `tasks` initializer below and consumed by the `lastFetchTimeMs` ref initializer on
  the SAME first render, so the hydrated board is described by the snapshot's real write time from its
  very first paint. A `useRef` initial value is only honored on first render, which is exactly when the
  `useState` initializer runs — the two stay in lockstep with no effect-ordering gap. Reading the
  timestamp in an effect instead would be wrong: the value returned to consumers is `.current` read
  during render, so the first (restore) frame would still ship `undefined`.
  It is only read when a snapshot actually hydrated, so a cache miss leaves the clock `undefined`.
  */
  let hydratedSnapshotSavedAtMs: number | undefined;
  const [tasks, setTasks] = useState<Task[]>(() => {
    if (!projectId) {
      return [];
    }
    const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
    const cachedTasks = readCache<Task[]>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
    if (Array.isArray(cachedTasks)) {
      hydratedSnapshotSavedAtMs = readCacheSavedAt(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (cachedTasks.length > 0 && !loggedTaskCacheHitProjects.has(projectId)) {
        loggedTaskCacheHitProjects.add(projectId);
        console.info("[swr-cache] hit tasks=", cachedTasks.length, "projectId=", projectId);
      }
    }
    return Array.isArray(cachedTasks)
      ? filterActiveTasks(cachedTasks.map(normalizeTask).map(({ releaseGate: _releaseGate, ...task }) => task as Task))
      : [];
  });
  const [isStale, setIsStale] = useState(true);
  const [lastRefreshErrorAt, setLastRefreshErrorAt] = useState<number | null>(null);
  const tasksRef = useRef(tasks);
  // Task ids are project-local. Reconciliation may compare ids only after this owner fence holds.
  const tasksProjectIdRef = useRef<string | undefined>(projectId);
  /*
  FNXC:PromoteVisibility 2026-08-11-20:53:
  This is deliberately hook-local rather than Task state or persistent cache. It records only the
  browser-visible evidence paired with a REST verdict, so an SSE patch can retain that verdict only
  while it remains provably valid; task removal and failed retention prune it.
  */
  const releaseGateProvenanceRef = useRef(new Map<string, import("../utils/releaseGate").ReleaseGateProvenance>());
  const fetchVersionRef = useRef(0);
  /*
  FNXC:DonePagination 2026-09-04-10:36:
  Done-page requests have a project-generation fence and a dedicated accumulator. Generic board refreshes replace the current lanes plus the newest Done page while preserving pages the operator explicitly loaded.

  FNXC:DonePagination 2026-09-08-23:00:
  A continuation belongs to the complete project, sort, search, and refresh incarnation. Every authoritative refresh invalidates an in-flight Done continuation before starting page zero, so an older page cannot append cards or replace the new session cursor after search or refresh changes.

  FNXC:DonePagination 2026-09-08-23:00:
  SSE membership changes must update the aggregate physical-column count and the selected-workflow count together, including moves between two Complete columns. The workflow resolver applies the same explicit-selection/default fallback as Board; display counters never alter the captured server cursor.
  */
  const currentPageCursorRef = useRef<string | null>(null);
  const currentPageLoadingRef = useRef(false);
  const [currentTasksTotal, setCurrentTasksTotal] = useState(0);
  const [currentTasksHasMore, setCurrentTasksHasMore] = useState(false);
  const [currentTasksLoadingMore, setCurrentTasksLoadingMore] = useState(false);
  const completedRequestGenerationRef = useRef(0);
  const completedTasksRef = useRef<Task[]>([]);
  const completedNextCursorRef = useRef<string | null>(null);
  const completedLoadingMoreRef = useRef(false);
  const completedSortModeRef = useRef<TaskColumnSortMode>("completion-date-desc");
  const [completedSortMode, setCompletedSortMode] = useState<TaskColumnSortMode>("completion-date-desc");
  const [completedTotal, setCompletedTotal] = useState(0);
  const completedTotalRef = useRef(0);
  const [completedCounts, setCompletedCounts] = useState<NonNullable<api.CompletedTaskPageResponse["counts"]>>({ byColumn: {}, byWorkflow: {} });
  const [completedHasMore, setCompletedHasMore] = useState(false);
  const [completedLoadingMore, setCompletedLoadingMore] = useState(false);
  const mergeIncomingTask = (current: Task, incoming: Task, mergeOptions?: TaskSnapshotMergeOptions): Task =>
    mergeTaskSnapshot(current, incoming, { ...mergeOptions, releaseGateProvenance: releaseGateProvenanceRef.current });

  /*
  FNXC:PromoteVisibility 2026-08-11-21:06:
  Freshness cannot be checked only when SSE or fetch merges a row: an idle board can receive no
  further snapshots for longer than the verdict TTL. Wake at the earliest expiry and remove each
  expired or unverifiable verdict, ensuring TaskCard never renders a stale server decision.
  */
  useEffect(() => {
    const now = Date.now();
    let earliestExpiry = Number.POSITIVE_INFINITY;
    let needsPrune = false;
    for (const task of tasks) {
      if (!task.releaseGate) continue;
      if (!isReleaseGateVerdictFresh(task.releaseGate, task, releaseGateProvenanceRef.current.get(task.id), now)) {
        needsPrune = true;
        continue;
      }
      const evaluatedAt = Date.parse(task.releaseGate.evaluatedAt);
      earliestExpiry = Math.min(earliestExpiry, evaluatedAt + RELEASE_GATE_VERDICT_MAX_AGE_MS);
    }

    const prune = () => {
      setTasks((previous) => {
        let changed = false;
        const checkedAt = Date.now();
        const next = previous.map((task) => {
          if (!task.releaseGate || isReleaseGateVerdictFresh(task.releaseGate, task, releaseGateProvenanceRef.current.get(task.id), checkedAt)) {
            return task;
          }
          changed = true;
          releaseGateProvenanceRef.current.delete(task.id);
          return { ...task, releaseGate: undefined };
        });
        if (changed) tasksRef.current = next;
        return changed ? next : previous;
      });
    };

    if (needsPrune) {
      prune();
      return;
    }
    if (!Number.isFinite(earliestExpiry)) return;
    const timer = window.setTimeout(prune, Math.max(0, earliestExpiry - now) + 1);
    return () => window.clearTimeout(timer);
  }, [tasks]);

  /*
  FNXC:DashboardResume 2026-08-05-18:17:
  A resumed list request is a point-in-time server snapshot, while task SSE is a later committed
  mutation. Track the task ids changed after each request begins so its delayed response retains live
  creates and excludes live deletes instead of replacing the entire board with its older membership.
  A later successful fetch prunes mutations it already observed; newer mutations remain fenced until
  their own authoritative response arrives.
  */
  const liveMutationVersionRef = useRef(0);
  const liveTaskMutationsRef = useRef(new Map<string, { version: number; deleted: boolean; task?: Task }>());
  const mountedRef = useRef(true);
  const resumeRefreshRef = useRef<{ identity: string; promise: Promise<void> } | null>(null);
  // Tracks the project context version to detect stale SSE events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);
  const lastVisibilityRefreshRef = useRef<number>(0);
  const contextVersionAtLastVisibilityRef = useRef(projectContextVersionRef.current);
  const droppedStaleEventsRef = useRef(0);
  const searchQueryRef = useRef(searchQuery);
  const searchIncarnationRef = useRef(0);
  const renderedSearchQueryRef = useRef(searchQuery);
  const refreshTasksRef = useRef<typeof refreshTasks>(null!);
  const prevSseEnabledRef = useRef(sseEnabled);
  // Coordinates the earlier re-entry effect with the project-change fetch effect below.
  const projectChangeRefreshPendingRef = useRef(false);
  /*
  FNXC:MobileTabDiscard 2026-07-26-14:12:
  "Data as of" clock for everything derived from `tasks` (isTaskStuck / countStuckTasks, TaskCard's
  isStuck + isAgentActive, Column's activeTaskCount, ExecutorStatusBar's stuck counters, and the
  taskRecovery affordances). It describes the AGE OF THE ROWS CURRENTLY IN `tasks`, not the age of
  this hook instance.

  It is seeded from the hydrated snapshot's envelope `savedAt` rather than left `undefined`. When it
  is `undefined` every consumer falls back to `Date.now()`; combined with the raised
  `SWR_TASKS_MAX_AGE_MS`, an iOS-PWA restore that hydrated a 2-hour-old board measured hours-old
  `updatedAt` values against NOW and rendered every in-progress card 'stuck' (and forced
  isAgentActive false, killing the live pulse) until the mount revalidation resolved — seconds on a
  waking mobile radio, precisely the restore this cache exists to improve. Seeding makes the first
  paint honest; `refreshTasks` overwrites it with `Date.now()` the moment real server data lands.
  */
  const lastFetchTimeMs = useRef<number | undefined>(hydratedSnapshotSavedAtMs);
  /*
  FNXC:MobileTabDiscard 2026-07-26-16:40:
  True only after a successful full-board fetch has confirmed EVERY row currently in `tasks`. A hydrated
  snapshot does not confirm anything, so this starts false on mount and is reset to false whenever a
  project switch repaints from cache.

  It gates the live-update writers of `lastFetchTimeMs` below. Those writers (task:created / task:moved /
  task:updated, plus `ingestCreatedTasks`) each learn about ONE row, but `lastFetchTimeMs` is read as the
  as-of time of ALL rows. While a hydrated hours-old board is still waiting for the mount revalidation on
  a waking radio, a single unrelated task:created event used to stamp the whole board as measured-from-
  now — re-creating, through a sibling path, the exact "every in-progress card renders stuck" regression
  the savedAt seeding was added to fix.

  Once a fetch HAS confirmed the board, advancing on a live event stays honest and is deliberately kept:
  the stream reports every task mutation in the project, so a row that produced no event really has not
  changed and `now - updatedAt` is its true idle time. Freezing the clock at the last fetch instead would
  make stuck detection silently stop firing for the rest of a long SSE session (there is no periodic
  poll in this hook) — a false negative traded for the false positive.
  */
  const boardFetchConfirmedRef = useRef(false);
  /*
  FNXC:MobileTabDiscard 2026-07-26-16:40:
  Single seam for the live-update writers of the freshness clock; see `boardFetchConfirmedRef`. Kept as
  one function so a future fifth writer cannot reintroduce the ungated `lastFetchTimeMs.current =
  Date.now()` pattern by copy-paste.
  */
  const advanceFreshnessClockForLiveUpdate = useCallback(() => {
    if (!boardFetchConfirmedRef.current) {
      return;
    }
    lastFetchTimeMs.current = Date.now();
  }, []);
  const lastConfirmedProjectIdRef = useRef<string | undefined>(undefined);
  const lastConfirmedSearchQueryRef = useRef<string | undefined>(undefined);
  // Track previous projectId to detect changes
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  tasksRef.current = tasks;
  searchQueryRef.current = searchQuery;
  if (renderedSearchQueryRef.current !== searchQuery) {
    /*
    FNXC:DonePagination 2026-09-08-23:16:
    Search identity is an incarnation, not only a string value. Increment synchronously on every rendered scope change so A → B → A cannot admit an A continuation started before B while the debounced page-zero refresh is still pending.
    */
    renderedSearchQueryRef.current = searchQuery;
    searchIncarnationRef.current++;
    completedRequestGenerationRef.current++;
  }

  // Detect project changes and invalidate SSE context.
  // Keep previous tasks visible while the new project's fetch is in flight
  // (stale-while-revalidate) to avoid a blank flash and a full empty→populated
  // re-reconcile of the board. The refreshTasks fetch guard (requestProjectId)
  // rejects late responses from the previous project, and SSE handlers check
  // projectContextVersionRef before applying events.
  if (previousProjectIdRef.current !== projectId) {
    previousProjectIdRef.current = projectId;
    // A request begun by the prior render still closes over its old project id. Invalidate it
    // synchronously, before effects install this context's fetch, so it cannot paint old cards.
    fetchVersionRef.current++;
    completedRequestGenerationRef.current++;
    projectContextVersionRef.current++;
    liveTaskMutationsRef.current.clear();
    releaseGateProvenanceRef.current.clear();
    boardFetchConfirmedRef.current = false;
    projectChangeRefreshPendingRef.current = true;
  }

  const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

  const refreshTasks = useCallback(async (options?: { clearOnError?: boolean; searchQueryOverride?: string; resetCompletedPages?: boolean }) => {
    const requestVersion = ++fetchVersionRef.current;
    completedRequestGenerationRef.current++;
    completedLoadingMoreRef.current = false;
    setCompletedLoadingMore(false);
    const requestLiveMutationVersion = liveMutationVersionRef.current;
    const requestProjectId = projectId; // Capture the projectId for this request
    const requestCompletedSortMode = completedSortModeRef.current;
    const query = options?.searchQueryOverride ?? searchQueryRef.current;
    try {
      const [currentPageOrSearch, completedPage] = await Promise.all([
        api.fetchTaskPage(requestProjectId, { limit: 100, query: query || undefined }),
        query ? Promise.resolve(undefined) : api.fetchCompletedTasks(requestProjectId, 50, undefined, requestCompletedSortMode),
      ]);
      const fetchedTasks = currentPageOrSearch.tasks;
      // Reject if the project/search scope changed or a newer request superseded this response.
      if (fetchVersionRef.current !== requestVersion || projectId !== requestProjectId || (searchQueryRef.current ?? "") !== (query ?? "")) {
        return;
      }
      const fetchedAt = Date.now();
      const completedPageTasks = completedPage?.tasks.map(normalizeNonBoardTask) ?? [];
      const fetchedById = new Map<string, Task>();
      for (const task of [...fetchedTasks, ...completedPageTasks]) fetchedById.set(task.id, task);
      const normalizedFetchedTasks = filterActiveTasks([...fetchedById.values()].map(normalizeTask)).map((task) => {
        if (task.releaseGate === undefined) return task;
        const provenance = { fingerprint: releaseGateEvidenceFingerprint(task), capturedAt: fetchedAt };
        /*
        FNXC:PromoteVisibility 2026-08-13-22:02:
        A first-seen REST row has no current snapshot to merge against. Validate its verdict before
        render too, so a response evaluated for an older row never flashes an enabled Promote action.
        */
        if (!isReleaseGateVerdictFresh(task.releaseGate, task, provenance, fetchedAt)) {
          releaseGateProvenanceRef.current.delete(task.id);
          const { releaseGate: _staleReleaseGate, ...taskWithoutReleaseGate } = task;
          return taskWithoutReleaseGate as Task;
        }
        releaseGateProvenanceRef.current.set(task.id, provenance);
        return task;
      });
      /*
      FNXC:DonePagination 2026-09-04-10:36:
      A generic board refresh fetches current work separately from the newest Done page. Preserve older pages the operator explicitly loaded, but let current-work and newest-page rows win by id; search results intentionally replace the visible snapshot without mutating the Done accumulator.
      */
      const shouldCarryOverCompleted = !query && completedPage !== undefined;
      /*
      FNXC:DashboardResume 2026-08-05-18:36:
      React may defer a state updater, but the cache and mutation-fence cleanup run in this same
      callback. Reconcile from the synchronous task/mutation refs before either side effect, so a
      remount cannot hydrate the older response after an intervening SSE create or delete.
      */
      /*
      FNXC:TaskEventProjectScope 2026-09-01-06:16:
      `mergeTaskSnapshot` resolves equal ids by freshness, so callers must establish identical project
      ownership first. Project-local IDs are intentionally reusable and must never arbitrate cross-project rows.
      */
      const ownsCurrentRows = tasksProjectIdRef.current === requestProjectId;
      const previousById = new Map(ownsCurrentRows ? tasksRef.current.map((task) => [task.id, task]) : []);
      const fetchedIds = new Set(normalizedFetchedTasks.map((task) => task.id));
      const reconciledFetchedTasks = normalizedFetchedTasks.flatMap((fetched) => {
        const liveMutation = ownsCurrentRows ? liveTaskMutationsRef.current.get(fetched.id) : undefined;
        if (liveMutation && liveMutation.version > requestLiveMutationVersion) {
          return liveMutation.deleted ? [] : [liveMutation.task ?? previousById.get(fetched.id) ?? fetched];
        }
        const current = previousById.get(fetched.id);
        return [current ? mergeIncomingTask(current, fetched, { fullSnapshot: true }) : fetched];
      });
      for (const [taskId, liveMutation] of ownsCurrentRows ? liveTaskMutationsRef.current : []) {
        if (!fetchedIds.has(taskId) && liveMutation.version > requestLiveMutationVersion && !liveMutation.deleted) {
          const task = liveMutation.task ?? previousById.get(taskId);
          if (task) reconciledFetchedTasks.push(task);
        }
      }
      const freshIds = new Set(reconciledFetchedTasks.map((task) => task.id));
      const completedCarryOver = shouldCarryOverCompleted && ownsCurrentRows && !options?.resetCompletedPages
        ? completedTasksRef.current.filter((task) => !freshIds.has(task.id))
        : [];
      const nextTasks = completedCarryOver.length > 0
        ? [...reconciledFetchedTasks, ...completedCarryOver]
        : reconciledFetchedTasks;
      const tasksForCache = nextTasks;
      currentPageCursorRef.current = currentPageOrSearch.nextCursor;
      setCurrentTasksTotal(currentPageOrSearch.total);
      setCurrentTasksHasMore(currentPageOrSearch.hasMore);
      if (completedPage) {
        const nextById = new Map(nextTasks.map((task) => [task.id, task]));
        const nextCompleted = [
          ...completedPageTasks.map((task) => nextById.get(task.id) ?? task),
          ...completedCarryOver,
        ];
        completedTasksRef.current = nextCompleted;
        completedNextCursorRef.current = completedPage.nextCursor ?? null;
        if (liveMutationVersionRef.current === requestLiveMutationVersion) {
          completedTotalRef.current = completedPage.total;
          setCompletedTotal(completedPage.total);
          setCompletedCounts(completedPage.counts ?? { byColumn: {}, byWorkflow: {} });
          setCompletedHasMore(completedPage.hasMore);
        } else {
          setCompletedHasMore(completedPage.hasMore || nextCompleted.length < completedTotalRef.current);
        }
      }
      const retainedTaskIds = new Set(nextTasks.map((task) => task.id));
      for (const taskId of releaseGateProvenanceRef.current.keys()) {
        if (!retainedTaskIds.has(taskId)) releaseGateProvenanceRef.current.delete(taskId);
      }
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      for (const [taskId, mutation] of liveTaskMutationsRef.current) {
        if (mutation.version <= requestLiveMutationVersion) {
          liveTaskMutationsRef.current.delete(taskId);
        }
      }
      tasksProjectIdRef.current = requestProjectId;
      if (requestProjectId) {
        writeTaskCacheSnapshot(`${SWR_CACHE_KEYS.TASKS_PREFIX}${requestProjectId}`, tasksForCache);
      }
      setIsStale(false);
      setLastRefreshErrorAt(null);
      // Record when we received fresh server data for stuck detection
      lastFetchTimeMs.current = Date.now();
      // FNXC:MobileTabDiscard 2026-07-26-16:40: every row in `tasks` is now server-confirmed, so live
      // single-row updates may advance the clock from here on.
      boardFetchConfirmedRef.current = true;
      lastConfirmedProjectIdRef.current = requestProjectId;
      lastConfirmedSearchQueryRef.current = query;
    } catch (error) {
      // Reject failures from a superseded project/search scope too; they cannot invalidate the active page.
      if (fetchVersionRef.current !== requestVersion || projectId !== requestProjectId || (searchQueryRef.current ?? "") !== (query ?? "")) {
        return;
      }
      setLastRefreshErrorAt(Date.now());
      /*
      FNXC:MobileTabDiscard 2026-07-26-10:52:
      Load-bearing for the long hydration TTL: a snapshot is only allowed to outlive a tab discard
      because a failed revalidation deletes it here. Without this, an unverifiable board could be
      re-hydrated on every subsequent restore for the whole TTL window. Do not weaken.

      FNXC:MobileTabDiscard 2026-07-26-16:40:
      CORRECTION — the 10:52 note above claimed "a failed revalidation deletes it", and the code did
      exactly that for EVERY failure. That was wrong, and it broke the case the cache exists for: the
      mount revalidation runs on a just-woken mobile radio, where the first fetch routinely rejects at
      the transport layer. Such a rejection carries no information about the snapshot, yet it deleted
      the entry AND (with `clearOnError`) blanked the freshly hydrated board — so the restore went white
      and the next restore had nothing left to hydrate. Only a failure that actually reached the server
      is allowed to destroy the snapshot; see `didFailureReachServer`. Suspension/offline failures leave
      both the cache and the on-screen rows intact and rely on the retry paths keyed off
      `lastRefreshErrorAt`.
      */
      if (!didFailureReachServer(error)) {
        return;
      }
      if (requestProjectId) {
        clearCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}${requestProjectId}`);
      }
      if (options?.clearOnError) {
        setTasks([]);
        return;
      }
    }
  }, [projectId]);
  refreshTasksRef.current = refreshTasks;

  /*
  FNXC:DashboardResume 2026-08-05-18:00:
  Visibility, focus, pageshow, and an SSE reconnect are independent browser resume signals; any one
  may be the only signal delivered by a desktop tab, bfcache restore, mobile PWA, or resumed socket.
  They all enter this seam, which deduplicates only an overlapping request for the same captured
  project/search identity. A changed context, an unmounted hook, or an older request version
  cannot write cards after newer server or live-event state, and a failed request clears the in-flight
  marker so the next resume signal retries without blanking the usable SWR snapshot.
  */
  const revalidateAfterResume = useCallback((trigger: "visibility" | "focus" | "pageshow" | "sse-reconnect", reason?: string) => {
    if (!mountedRef.current) return;
    const query = searchQueryRef.current;
    const identity = `${projectContextVersionRef.current}:${projectId ?? "default"}:${query ?? ""}`;
    const existing = resumeRefreshRef.current;
    if (existing?.identity === identity) return;

    recordResumeEvent({ view: "useTasks", trigger, projectId, replayAttempted: false, reason });
    const promise = refreshTasksRef.current();
    resumeRefreshRef.current = { identity, promise };
    void promise.finally(() => {
      if (resumeRefreshRef.current?.promise === promise) {
        resumeRefreshRef.current = null;
      }
    });
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchVersionRef.current++;
      resumeRefreshRef.current = null;
    };
  }, []);

  /*
  FNXC:DashboardLiveUpdates 2026-08-04-08:12:
  Task SSE is disabled outside Board/List, so elapsed time cannot prove that the in-memory snapshot is
  current: any task lifecycle event may have been missed during that lossy interval. Every genuine
  false→true task-view return therefore reconciles once with the server, regardless of snapshot age.

  The project-change effect is deliberately later in this hook. When a project switch and false→true
  return occur in one render, it owns the single new-project request; this effect skips that coincident
  transition rather than issuing a duplicate. Initial true mounts, false→false renders, and Board↔List
  true→true renders are not re-entries, while a later same-project false→true transition remains eligible.
  */
  useEffect(() => {
    const previous = prevSseEnabledRef.current;
    prevSseEnabledRef.current = sseEnabled;

    if (previous === false && sseEnabled === true && !projectChangeRefreshPendingRef.current) {
      void refreshTasksRef.current();
    }
  }, [sseEnabled]);

  const completedRequestIsCurrent = useCallback((request: {
    generation: number;
    fetchVersion: number;
    projectId: string | undefined;
    query: string | undefined;
    searchIncarnation: number;
    sort: TaskColumnSortMode;
  }) => (
    completedRequestGenerationRef.current === request.generation
    && fetchVersionRef.current === request.fetchVersion
    && projectId === request.projectId
    && searchIncarnationRef.current === request.searchIncarnation
    && searchQueryRef.current === request.query
    && completedSortModeRef.current === request.sort
  ), [projectId]);

  const mergeCompletedPage = useCallback((page: Task[], requestLiveMutationVersion: number) => {
    const normalizedPage = page.map(normalizeNonBoardTask);
    const knownIds = new Set(completedTasksRef.current.map((task) => task.id));
    const pageIds = new Set<string>();
    const additions = normalizedPage.flatMap((task) => {
      if (knownIds.has(task.id) || pageIds.has(task.id)) return [];
      pageIds.add(task.id);
      const liveMutation = liveTaskMutationsRef.current.get(task.id);
      if (liveMutation && liveMutation.version > requestLiveMutationVersion) {
        if (liveMutation.deleted || !liveMutation.task) return [];
        const liveIsCompleted = liveMutation.task.column === "done"
          || resolveColumnFlagsRef.current?.(liveMutation.task)?.complete === true;
        return liveIsCompleted ? [liveMutation.task] : [];
      }
      return [task];
    });
    if (additions.length === 0) return;
    completedTasksRef.current = [...completedTasksRef.current, ...additions];
    setTasks((previous) => {
      const existingIds = new Set(previous.map((task) => task.id));
      const next = [...previous, ...additions.filter((task) => !existingIds.has(task.id))];
      tasksRef.current = next;
      return next;
    });
  }, []);

  /*
  FNXC:TaskListPagination 2026-09-07-16:03:
  Current-lane pages share one project-scoped cursor across Board columns. Any column sentinel may request continuation, but the hook serializes the request, rejects stale project/search responses, and merges by task ID so concurrent SSE updates remain authoritative.
  */
  const loadMoreCurrentTasks = useCallback(async () => {
    const cursor = currentPageCursorRef.current;
    if (currentPageLoadingRef.current || !currentTasksHasMore || !cursor) return;
    currentPageLoadingRef.current = true;
    setCurrentTasksLoadingMore(true);
    const requestVersion = fetchVersionRef.current;
    const requestProjectId = projectId;
    const requestQuery = searchQueryRef.current;
    try {
      const page = await api.fetchTaskPage(requestProjectId, { limit: 100, cursor, query: requestQuery || undefined });
      if (fetchVersionRef.current !== requestVersion || projectId !== requestProjectId || searchQueryRef.current !== requestQuery) return;
      const completedIds = new Set(completedTasksRef.current.map((task) => task.id));
      const byId = new Map(tasksRef.current.map((task) => [task.id, task]));
      for (const incoming of page.tasks.map(normalizeNonBoardTask)) {
        const current = byId.get(incoming.id);
        byId.set(incoming.id, current ? mergeIncomingTask(current, incoming, { fullSnapshot: true }) : incoming);
      }
      const currentRows = [...byId.values()].filter((task) => !completedIds.has(task.id));
      const completedRows = completedTasksRef.current.map((task) => byId.get(task.id) ?? task);
      const next = [...currentRows, ...completedRows];
      tasksRef.current = next;
      setTasks(next);
      currentPageCursorRef.current = page.nextCursor;
      setCurrentTasksTotal(page.total);
      setCurrentTasksHasMore(page.hasMore);
    } finally {
      if (fetchVersionRef.current === requestVersion && projectId === requestProjectId) {
        currentPageLoadingRef.current = false;
        setCurrentTasksLoadingMore(false);
      }
    }
  }, [currentTasksHasMore, projectId]);

  /** Fetch the next bounded Done page. No-op when every completed task is already loaded. */
  const loadMoreCompletedTasks = useCallback(async () => {
    const cursor = completedNextCursorRef.current;
    if (completedLoadingMoreRef.current || !completedHasMore || !cursor) return;
    completedLoadingMoreRef.current = true;
    setCompletedLoadingMore(true);
    const request = {
      generation: completedRequestGenerationRef.current,
      fetchVersion: fetchVersionRef.current,
      projectId,
      query: searchQueryRef.current,
      searchIncarnation: searchIncarnationRef.current,
      sort: completedSortModeRef.current,
    };
    const requestLiveMutationVersion = liveMutationVersionRef.current;
    try {
      const page = await api.fetchCompletedTasks(projectId, 50, cursor, request.sort);
      if (!completedRequestIsCurrent(request)) return;
      mergeCompletedPage(page.tasks, requestLiveMutationVersion);
      completedNextCursorRef.current = page.nextCursor ?? null;
      if (liveMutationVersionRef.current === requestLiveMutationVersion) {
        completedTotalRef.current = page.total;
        setCompletedTotal(page.total);
        setCompletedCounts(page.counts ?? { byColumn: {}, byWorkflow: {} });
        setCompletedHasMore(page.hasMore);
      } else {
        setCompletedHasMore(page.hasMore || completedTasksRef.current.length < completedTotalRef.current);
      }
    } finally {
      if (completedRequestIsCurrent(request)) {
        completedLoadingMoreRef.current = false;
        setCompletedLoadingMore(false);
      }
    }
  }, [completedHasMore, completedRequestIsCurrent, mergeCompletedPage, projectId]);

  /*
  FNXC:DonePagination 2026-09-04-19:28:
  A Done sort change resets the accumulated server pages before adopting page zero in the new order.
  The generation fence rejects an older Show-more response, while the shared refresh keeps current
  lanes and the exact Done total synchronized in one authoritative snapshot.
  */
  const changeCompletedSortMode = useCallback(async (mode: TaskColumnSortMode) => {
    if (completedSortModeRef.current === mode) return;
    completedSortModeRef.current = mode;
    setCompletedSortMode(mode);
    completedRequestGenerationRef.current++;
    completedTasksRef.current = [];
    completedNextCursorRef.current = null;
    completedLoadingMoreRef.current = false;
    setCompletedLoadingMore(false);
    setCompletedHasMore(false);
    await refreshTasks({ resetCompletedPages: true });
  }, [refreshTasks]);

  // Debounced search effect - separate from refreshTasks to avoid dependency cycle
  const prevSearchQueryRef = useRef<string | undefined>(searchQuery);
  useEffect(() => {
    // Skip only the initial mount when query has never been set; the visibility
    // effect handles the first fetch. Going from a defined value back to
    // undefined/"" must still trigger a refetch so the filter is cleared.
    if (searchQuery === undefined && prevSearchQueryRef.current === undefined) return;
    prevSearchQueryRef.current = searchQuery;
    const timer = setTimeout(() => {
      void refreshTasks({ searchQueryOverride: searchQuery });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]); // intentionally NOT including refreshTasks in deps

  useEffect(() => {
    if (!projectId) {
      return;
    }

    const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
    const cachedTasks = readCache<Task[]>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
    if (Array.isArray(cachedTasks)) {
      if (cachedTasks.length > 0 && !loggedTaskCacheHitProjects.has(projectId)) {
        loggedTaskCacheHitProjects.add(projectId);
        console.info("[swr-cache] hit tasks=", cachedTasks.length, "projectId=", projectId);
      }
      const nextTasks = filterActiveTasks(cachedTasks.map(normalizeNonBoardTask));
      tasksRef.current = nextTasks;
      tasksProjectIdRef.current = projectId;
      setTasks(nextTasks);
      /*
      FNXC:MobileTabDiscard 2026-07-26-14:18:
      A project switch replaces `tasks` with the new project's snapshot, so the freshness clock must
      be replaced too — the previous project's fetch time no longer describes these rows. Only set it
      when a snapshot was actually hydrated: on a cache miss the previous project's rows stay on
      screen (stale-while-revalidate), and their real fetch time remains the honest answer. This runs
      before the mount/refresh effect below, so the fetch that resolves next still wins.
      */
      lastFetchTimeMs.current = readCacheSavedAt(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      // FNXC:MobileTabDiscard 2026-07-26-16:40: these rows come from cache, not the server — an SSE
      // event must not stamp them as measured-from-now until this project's fetch confirms them.
      boardFetchConfirmedRef.current = false;
    } else if (tasksProjectIdRef.current !== projectId) {
      // Never retain another project's stale rows when this project's snapshot is absent.
      tasksRef.current = [];
      tasksProjectIdRef.current = projectId;
      setTasks([]);
      lastFetchTimeMs.current = undefined;
      boardFetchConfirmedRef.current = false;
    }
    setIsStale(true);
  }, [projectId]);

  // Fetch initial tasks and recover when the tab becomes visible again.
  /*
  FNXC:MobileTabDiscard 2026-07-26-10:55:
  The mandatory half of stale-while-revalidate. Runs once per mount (and per projectId change) with no
  freshness shortcut, so a board hydrated from an hours-old snapshot is always corrected by exactly one
  immediate fetch, and `isStale` marks the window so the revalidating indicator is visible meanwhile.
  */
  useEffect(() => {
    setIsStale(true);
    void refreshTasks({ clearOnError: true });
    projectChangeRefreshPendingRef.current = false;
    completedRequestGenerationRef.current++;
    completedNextCursorRef.current = null;
    completedLoadingMoreRef.current = false;
    completedTasksRef.current = [];
    completedTotalRef.current = 0;
    setCompletedTotal(0);
    setCompletedCounts({ byColumn: {}, byWorkflow: {} });
    setCompletedHasMore(false);
    setCompletedLoadingMore(false);

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        contextVersionAtLastVisibilityRef.current = projectContextVersionRef.current;
        return;
      }

      const previousContextVersion = contextVersionAtLastVisibilityRef.current;
      const contextChangedWhileHidden = previousContextVersion !== projectContextVersionRef.current;
      contextVersionAtLastVisibilityRef.current = projectContextVersionRef.current;

      if (contextChangedWhileHidden) {
        lastVisibilityRefreshRef.current = Date.now();
        pushTrace("useTasks", "visibility-context-version-changed", {
          projectId,
          previousContextVersion,
          currentContextVersion: projectContextVersionRef.current,
        });
        revalidateAfterResume("visibility", "context-version-changed");
        return;
      }

      const now = Date.now();
      const timeSinceLastRefresh = now - lastVisibilityRefreshRef.current;
      if (timeSinceLastRefresh < VISIBILITY_REFRESH_DEBOUNCE_MS) {
        return;
      }

      lastVisibilityRefreshRef.current = now;
      revalidateAfterResume("visibility", "debounced-refresh");
    };

    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        revalidateAfterResume("focus", "focus-return");
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (document.visibilityState !== "hidden") {
        revalidateAfterResume("pageshow", event.persisted ? "bfcache-restore" : "browser-restore");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      // Effects clean up before a project replacement or unmount. Invalidate the captured request
      // so a late server response cannot write to the next context (or a disposed hook).
      fetchVersionRef.current++;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [refreshTasks, revalidateAfterResume]);

  // SSE live updates
  // Note: SSE events from stale project contexts are ignored via projectContextVersionRef.
  // This prevents tasks from the previous project from appearing during project switches.
  // Connection lifecycle (reconnect + heartbeat) is owned by sse-bus so all
  // /api/events consumers share one underlying EventSource.
  // When sseEnabled is false, the subscription is skipped to free browser connection slots.
  useEffect(() => {
    if (sseEnabled === false) return;

    let contextVersionAtStart = projectContextVersionRef.current;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;
    const traceDroppedStaleEvent = () => {
      droppedStaleEventsRef.current += 1;
      pushTrace("useTasks", "dropped-stale-event", {
        count: droppedStaleEventsRef.current,
        contextVersionAtStart,
        currentContextVersion: projectContextVersionRef.current,
        projectId,
      });
    };
    // Guards against reconnect callbacks firing after the effect has cleaned up
    // (e.g., sseEnabled flipped to false during a pending reconnect timer in sse-bus).
    let active = true;
    const readScopedEvent = <T,>(event: MessageEvent): T | null => {
      const payload = JSON.parse(event.data) as T;
      const eventProjectId = readTaskEventProjectId(payload);
      if (!isForeignTaskEvent(eventProjectId, projectId)) return stripTaskEventProjectId(payload);
      pushTrace("useTasks", "dropped-foreign-project-event", {
        eventProjectId,
        projectId,
        id: typeof payload === "object" && payload !== null && "id" in payload
          ? (payload as { id?: unknown }).id
          : undefined,
      });
      return null;
    };

    // Guard against stale callbacks: when sseEnabled flips false or the
    // effect unmounts, these handlers must not fire refreshTasks into a
    // missions-only view where the SSE should be inactive.
    const recordLiveMutation = (task: Task, deleted: boolean) => {
      const version = ++liveMutationVersionRef.current;
      liveTaskMutationsRef.current.set(task.id, { version, deleted, task: deleted ? undefined : task });
    };
    const applyLiveTasks = (update: (current: Task[]) => Task[]) => {
      const nextTasks = update(tasksRef.current);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
    };
    const isCompletedTask = (task: Task, column: ColumnId = task.column): boolean => (
      resolveColumnFlagsRef.current?.({ ...task, column })?.complete === true || column === "done"
    );
    const syncCompletedMembership = (
      task: Task,
      previousTask: Task | undefined,
      previousColumn: ColumnId | undefined,
      currentColumn: ColumnId | undefined,
      options?: { countUnknownEntry?: boolean },
    ) => {
      const previouslyCompleted = previousTask !== undefined && previousColumn !== undefined
        ? isCompletedTask(previousTask, previousColumn)
        : false;
      const currentlyCompleted = currentColumn !== undefined && isCompletedTask(task, currentColumn);
      const currentIndex = completedTasksRef.current.findIndex((candidate) => candidate.id === task.id);
      if (currentlyCompleted) {
        completedTasksRef.current = currentIndex === -1
          ? [task, ...completedTasksRef.current]
          : completedTasksRef.current.map((candidate, index) => index === currentIndex ? task : candidate);
      } else if (currentIndex !== -1) {
        completedTasksRef.current = completedTasksRef.current.filter((candidate) => candidate.id !== task.id);
      }

      const previousWorkflowId = previousTask ? resolveWorkflowIdRef.current?.(previousTask) : undefined;
      const currentWorkflowId = currentlyCompleted ? resolveWorkflowIdRef.current?.(task) : undefined;
      setCompletedCounts((current) => {
        const byColumn = { ...current.byColumn };
        const byWorkflow = { ...current.byWorkflow };
        const adjust = (column: ColumnId | undefined, workflowId: string | undefined, delta: number) => {
          if (!column) return;
          byColumn[column] = Math.max(0, (byColumn[column] ?? 0) + delta);
          if (!workflowId) return;
          const workflowCounts = { ...(byWorkflow[workflowId] ?? {}) };
          workflowCounts[column] = Math.max(0, (workflowCounts[column] ?? 0) + delta);
          byWorkflow[workflowId] = workflowCounts;
        };
        if (previouslyCompleted) adjust(previousColumn, previousWorkflowId, -1);
        if (currentlyCompleted && (previousTask !== undefined || options?.countUnknownEntry !== false)) {
          adjust(currentColumn, currentWorkflowId, 1);
        }
        return { byColumn, byWorkflow };
      });

      const countedCurrentMembership = currentlyCompleted
        && (previousTask !== undefined || options?.countUnknownEntry !== false);
      const delta = Number(countedCurrentMembership) - Number(previouslyCompleted);
      if (delta !== 0) {
        setCompletedTotal((current) => {
          const next = Math.max(0, current + delta);
          completedTotalRef.current = next;
          setCompletedHasMore(completedTasksRef.current.length < next);
          return next;
        });
      }
    };
    const handleCreated = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      const payload = readScopedEvent<Task>(e);
      if (!payload) return;
      const task = normalizeTask(stripTransientReleaseGate(payload));
      recordLiveMutation(task, isSoftDeleted(task));
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const existingCreatedTask = tasksRef.current.find((candidate) => candidate.id === task.id);
      if (isSoftDeleted(task)) {
        if (existingCreatedTask) syncCompletedMembership(task, existingCreatedTask, existingCreatedTask.column, undefined);
        applyLiveTasks((prev) => prev.filter((candidate) => candidate.id !== task.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:created", id: task.id });
        return;
      }
      syncCompletedMembership(task, existingCreatedTask, existingCreatedTask?.column, task.column);
      applyLiveTasks((prev) => {
        const existingIndex = prev.findIndex((candidate) => candidate.id === task.id);
        if (existingIndex === -1) {
          return [...prev, task];
        }

        const current = prev[existingIndex]!;
        const merged = mergeIncomingTask(current, task);
        if (merged === current) {
          return prev;
        }

        const next = [...prev];
        next[existingIndex] = merged;
        return next;
      });
      advanceFreshnessClockForLiveUpdate();
    };

    const handleMoved = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      // #1403: the move event carries `ColumnId` (custom column ids admitted).
      const payload = readScopedEvent<{ task: Task; from: ColumnId; to: ColumnId }>(e);
      if (searchQueryRef.current && payload) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      if (!payload) return;
      const { task, from, to } = payload;
      const normalizedTask = normalizeTask(stripTransientReleaseGate(task));
      if (isSoftDeleted(normalizedTask)) {
        recordLiveMutation(normalizedTask, true);
        syncCompletedMembership(normalizedTask, tasksRef.current.find((candidate) => candidate.id === normalizedTask.id) ?? normalizedTask, from, undefined);
        applyLiveTasks((prev) => prev.filter((candidate) => candidate.id !== normalizedTask.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:moved", id: normalizedTask.id });
        return;
      }
      // Preserve a custom (non-legacy) target id verbatim; only coerce empty/garbage
      // back to the task's current column. The old normalizeColumn (deleted in U12) would drop custom ids.
      const nextColumn: ColumnId = typeof to === "string" && to ? to : normalizedTask.column;
      const movedTask = { ...normalizedTask, column: nextColumn };
      recordLiveMutation(movedTask, false);
      syncCompletedMembership(movedTask, tasksRef.current.find((candidate) => candidate.id === movedTask.id) ?? normalizedTask, from, nextColumn);
      applyLiveTasks((prev) => {
        const existingIndex = prev.findIndex((t) => t.id === movedTask.id);
        if (existingIndex === -1) {
          // SSE created event was missed (e.g., reconnect gap); upsert so the
          // task becomes visible instead of being silently dropped.
          return [...prev, movedTask];
        }
        const current = prev[existingIndex]!;
        const merged = mergeIncomingTask(current, movedTask, {
          authoritativeMove: true,
          authoritativeLifecycle: true,
        });
        if (merged === current) return prev;
        const next = [...prev];
        next[existingIndex] = merged;
        return next;
      });
      advanceFreshnessClockForLiveUpdate();
    };

    const handleUpdated = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      const payload = readScopedEvent<Task>(e);
      if (searchQueryRef.current && payload) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      if (!payload) return;
      const incoming = normalizeTask(stripTransientReleaseGate(payload));
      const previousUpdatedTask = tasksRef.current.find((candidate) => candidate.id === incoming.id);
      if (isSoftDeleted(incoming)) {
        recordLiveMutation(incoming, true);
        // FN-5135: treat deletedAt-bearing task:updated payloads as delete-equivalent.
        if (previousUpdatedTask) syncCompletedMembership(incoming, previousUpdatedTask, previousUpdatedTask.column, undefined);
        applyLiveTasks((prev) => prev.filter((candidate) => candidate.id !== incoming.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:updated", id: incoming.id });
        return;
      }
      const authoritativeTask = previousUpdatedTask
        ? mergeIncomingTask(previousUpdatedTask, incoming, { authoritativeLifecycle: true })
        : incoming;
      if (authoritativeTask === previousUpdatedTask) return;
      /*
      FNXC:DonePagination 2026-09-08-23:16:
      Server counts already include unloaded Done rows, so a task:updated event may expose such a row without adding another membership delta. For loaded rows, derive the delta only after snapshot freshness accepts the event; a stale payload must change neither the card nor its exact server-backed counts.
      */
      recordLiveMutation(authoritativeTask, false);
      syncCompletedMembership(
        authoritativeTask,
        previousUpdatedTask,
        previousUpdatedTask?.column,
        authoritativeTask.column,
        { countUnknownEntry: false },
      );
      applyLiveTasks((prev) => {
        const existingIndex = prev.findIndex((task) => task.id === authoritativeTask.id);
        if (existingIndex === -1) return [...prev, authoritativeTask];
        const next = [...prev];
        next[existingIndex] = authoritativeTask;
        return next;
      });
      advanceFreshnessClockForLiveUpdate();
    };

    const handleDeleted = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      const payload = readScopedEvent<Task>(e);
      if (!payload) return;
      if (searchQueryRef.current) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      const task = normalizeTask(stripTransientReleaseGate(payload));
      const previousDeletedTask = tasksRef.current.find((candidate) => candidate.id === task.id);
      recordLiveMutation(task, true);
      syncCompletedMembership(task, previousDeletedTask ?? task, previousDeletedTask?.column ?? task.column, undefined);
      applyLiveTasks((prev) => prev.filter((t) => t.id !== task.id));
    };

    const handleMerged = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      const payload = readScopedEvent<{ task: Task }>(e);
      if (searchQueryRef.current && payload) {
        void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
        return;
      }
      if (!payload) return;
      const { task } = payload;
      const normalizedTask = normalizeTask(stripTransientReleaseGate(task));
      if (isSoftDeleted(normalizedTask)) {
        recordLiveMutation(normalizedTask, true);
        applyLiveTasks((prev) => prev.filter((candidate) => candidate.id !== normalizedTask.id));
        pushTrace("useTasks", "soft-deleted-task-suppressed", { event: "task:merged", id: normalizedTask.id });
        return;
      }
      const mergedTask = { ...normalizedTask, column: "done" as Column };
      const previousMergedTask = tasksRef.current.find((candidate) => candidate.id === mergedTask.id);
      recordLiveMutation(mergedTask, false);
      syncCompletedMembership(mergedTask, previousMergedTask, previousMergedTask?.column, mergedTask.column);
      applyLiveTasks((prev) => {
        const existingIndex = prev.findIndex((t) => t.id === mergedTask.id);
        if (existingIndex === -1) {
          return [...prev, mergedTask];
        }
        const next = [...prev];
        next[existingIndex] = mergedTask;
        return next;
      });
    };

    const handleAgentLog = (e: MessageEvent) => {
      if (isStale()) {
        traceDroppedStaleEvent();
        return;
      }
      const entry = readScopedEvent<AgentLogActivityEvent>(e);
      if (searchQueryRef.current) return;
      if (!entry || !entry.taskId || !entry.timestamp) return;
      setTasks((prev) => {
        let changed = false;
        const next = prev.map((task) => {
          const cleared = clearInReviewStallForFreshAgentLog(task, entry);
          const updated = addRecentPlannerActivityForFreshAgentLog(cleared, entry, resolveColumnFlags?.(cleared));
          if (updated !== task) changed = true;
          return updated;
        });
        return changed ? next : prev;
      });
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "task:created": handleCreated,
        "task:moved": handleMoved,
        "task:updated": handleUpdated,
        "task:deleted": handleDeleted,
        "task:merged": handleMerged,
        "agent:log": handleAgentLog,
      },
      // Guard onReconnect against stale SSE callbacks: do not call refreshTasks
      // if the SSE was disabled or the effect unmounted while reconnect was pending.
      onReconnect: () => {
        if (!active) return;
        if (isStale()) {
          traceDroppedStaleEvent();
          return;
        }
        contextVersionAtStart = projectContextVersionRef.current;
        revalidateAfterResume("sse-reconnect", "stream-reopened");
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId, sseEnabled, revalidateAfterResume]);

  const createTask = useCallback(async (input: TaskCreateInput): Promise<Task> => {
    const task = normalizeNonBoardTask(await api.createTask(input, projectId));
    setTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      return [...prev, task];
    });
    return task;
  }, [projectId]);

  /*
  FNXC:DashboardTaskReconciliation 2026-08-30-01:40:
  Start and Reset must publish their server-confirmed rows before SSE or polling so every task host
  immediately shows the new column. A stale card invited a second Start that could hard-cancel work,
  so lifecycle mutations share one reconciliation seam rather than waiting for an eventual refresh.
  */
  const reconcileConfirmedTask = useCallback((confirmedTask: Task): Task => {
    const normalizedConfirmedRow = normalizeNonBoardTask(confirmedTask);
    // Preserve cleared lifecycle fields as own `undefined` properties so every downstream
    // snapshot host can distinguish the confirmed deletion from an unrelated sparse update.
    const confirmedRow: Task = {
      ...normalizedConfirmedRow,
      paused: normalizedConfirmedRow.paused,
      userPaused: normalizedConfirmedRow.userPaused,
      pausedByAgentId: normalizedConfirmedRow.pausedByAgentId,
      pausedReason: normalizedConfirmedRow.pausedReason,
      status: normalizedConfirmedRow.status,
    };
    const currentTask = tasksRef.current.find((task) => task.id === confirmedRow.id);
    // A live event that arrived while the mutation was pending may be newer than its response.
    // Start from the confirmed row so equal clocks retain the mutation, then admit only newer state.
    const updatedTask = currentTask ? mergeIncomingTask(confirmedRow, currentTask) : confirmedRow;
    fetchVersionRef.current++;
    const replaceConfirmedTask = (currentTasks: Task[]) =>
      currentTasks.map((task) => task.id === updatedTask.id ? mergeIncomingTask(updatedTask, task) : task);

    if (projectId) {
      const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
      const cachedTasks = readCache<unknown>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (Array.isArray(cachedTasks)) {
        const cacheContainsOnlyTaskRows = cachedTasks.every((task) =>
          Boolean(task && typeof task === "object" && typeof (task as Task).id === "string"),
        );
        if (cacheContainsOnlyTaskRows) {
          const nextCachedTasks = cachedTasks.map((task) =>
            (task as Task).id === updatedTask.id ? updatedTask : normalizeTask(task as Task),
          );
          writeTaskCacheSnapshot(cacheKey, nextCachedTasks);
        } else {
          clearCache(cacheKey);
        }
      } else if (cachedTasks === null) {
        writeTaskCacheSnapshot(cacheKey, replaceConfirmedTask(tasksRef.current));
      } else {
        clearCache(cacheKey);
      }
    }

    setTasks((previousTasks) => {
      const nextTasks = replaceConfirmedTask(previousTasks);
      tasksRef.current = nextTasks;
      return nextTasks;
    });
    return updatedTask;
  }, [projectId]);

  const moveTask = useCallback(async (
    id: string,
    column: ColumnId,
    optionsOrPosition?: { preserveProgress?: boolean; expectedColumn?: string } | number,
  ): Promise<Task> => {
    return reconcileConfirmedTask(await api.moveTask(id, column, projectId, optionsOrPosition));
  }, [projectId, reconcileConfirmedTask]);

  const pauseTask = useCallback(async (id: string): Promise<Task> => {
    return reconcileConfirmedTask(await api.pauseTask(id, projectId));
  }, [projectId, reconcileConfirmedTask]);

  const unpauseTask = useCallback(async (id: string): Promise<Task> => {
    return reconcileConfirmedTask(await api.unpauseTask(id, projectId));
  }, [projectId, reconcileConfirmedTask]);

  const deleteTask = useCallback(async (
    id: string,
    options?: {
      removeDependencyReferences?: boolean;
      removeLineageReferences?: boolean;
      githubIssueAction?: GithubIssueAction;
      allowResurrection?: boolean;
    },
  ): Promise<Task> => {
    const deletedTask = normalizeNonBoardTask(await api.deleteTask(id, projectId, options));
    /*
    FNXC:TaskDeletion 2026-06-29-18:52:
    Local deletes must update the shared useTasks array immediately because the Board and right-dock Tasks list both render from this state and should not wait for SSE or a refetch after the API confirms deletion.

    FNXC:TaskDeletionCache 2026-06-29-20:11:
    Project-scoped SWR hydration must remove the deleted task after the API confirms deletion, otherwise an immediate remount can hydrate a stale row before the next fetch. Only the active project's task cache key is touched; if the cached envelope has an unexpected shape, clear that key instead of writing possibly stale data.

    FNXC:TaskDeletionCache 2026-06-29-21:04:
    Delete success must also invalidate refreshes that began before the API call completed; otherwise a late pre-delete snapshot can rehydrate the removed card in Board and the right-dock Tasks list until the next live update.
    */
    // Invalidate refreshes that started before the delete succeeded so an older
    // server snapshot cannot overwrite the locally removed row after this point.
    fetchVersionRef.current++;

    if (projectId) {
      const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
      const cachedTasks = readCache<unknown>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (Array.isArray(cachedTasks)) {
        const nextCachedTasks = cachedTasks.filter((task): task is Task => {
          return Boolean(task && typeof task === "object" && (task as Task).id !== id);
        });
        writeCache(cacheKey, nextCachedTasks, { maxBytes: 500_000 });
      } else if (cachedTasks === null) {
        const nextCurrentTasks = tasksRef.current.filter((task) => task.id !== id);
        writeCache(cacheKey, nextCurrentTasks.length > 500 ? nextCurrentTasks.slice(0, 500) : nextCurrentTasks, { maxBytes: 500_000 });
      } else {
        clearCache(cacheKey);
      }
    }
    setTasks((prev) => prev.filter((task) => task.id !== id));
    return deletedTask;
  }, [projectId]);

  const mergeTask = useCallback(async (id: string): Promise<MergeResult> => {
    return api.mergeTask(id, projectId);
  }, [projectId]);

  const retryTask = useCallback(async (id: string): Promise<Task> => {
    const retriedTask = normalizeNonBoardTask(await api.retryTask(id, projectId));
    /*
    FNXC:DashboardTaskRetry 2026-06-30-12:57:
    Manual retry success is a user-visible state boundary. Replace matching rows in shared hook state and the project SWR cache as soon as the retry API returns so Board/List/detail/right-dock retry affordances do not depend on later SSE, polling, remount, or route re-entry to clear stale failed/stuck state.

    FNXC:DashboardTaskRetry 2026-06-30-12:58:
    Retry success also invalidates refreshes that began before the API returned; a late pre-retry fetch snapshot must not rehydrate the failed card after the operator has already received server confirmation for the retry.
    */
    fetchVersionRef.current++;

    const projectUpdatedTasks = (currentTasks: Task[]) => currentTasks.map((task) => (task.id === id ? retriedTask : task));

    if (projectId) {
      const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
      const cachedTasks = readCache<unknown>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (Array.isArray(cachedTasks)) {
        const cacheContainsOnlyTaskRows = cachedTasks.every((task) => Boolean(task && typeof task === "object" && typeof (task as Task).id === "string"));
        if (cacheContainsOnlyTaskRows) {
          const nextCachedTasks = cachedTasks.map((task) => ((task as Task).id === id ? retriedTask : normalizeTask(task as Task)));
          writeCache(cacheKey, nextCachedTasks.length > 500 ? nextCachedTasks.slice(0, 500) : nextCachedTasks, { maxBytes: 500_000 });
        } else {
          clearCache(cacheKey);
        }
      } else if (cachedTasks === null) {
        const nextCurrentTasks = projectUpdatedTasks(tasksRef.current);
        writeCache(cacheKey, nextCurrentTasks.length > 500 ? nextCurrentTasks.slice(0, 500) : nextCurrentTasks, { maxBytes: 500_000 });
      } else {
        clearCache(cacheKey);
      }
    }

    setTasks((prev) => {
      const next = projectUpdatedTasks(prev);
      tasksRef.current = next;
      return next;
    });
    return retriedTask;
  }, [projectId]);

  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Operator review-lane bypass action (FN-7720), mirroring retryTask's success-state
  wiring so the affordance does not depend on SSE/polling to clear the stale
  failed-step indicator after the operator receives server confirmation.
  */
  const bypassReview = useCallback(async (id: string, reason: string): Promise<Task> => {
    const bypassedTask = normalizeNonBoardTask(await api.bypassReview(id, reason, projectId));
    fetchVersionRef.current++;

    const projectUpdatedTasks = (currentTasks: Task[]) => currentTasks.map((task) => (task.id === id ? bypassedTask : task));

    if (projectId) {
      const cacheKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`;
      const cachedTasks = readCache<unknown>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
      if (Array.isArray(cachedTasks)) {
        const cacheContainsOnlyTaskRows = cachedTasks.every((task) => Boolean(task && typeof task === "object" && typeof (task as Task).id === "string"));
        if (cacheContainsOnlyTaskRows) {
          const nextCachedTasks = cachedTasks.map((task) => ((task as Task).id === id ? bypassedTask : normalizeTask(task as Task)));
          writeCache(cacheKey, nextCachedTasks.length > 500 ? nextCachedTasks.slice(0, 500) : nextCachedTasks, { maxBytes: 500_000 });
        } else {
          clearCache(cacheKey);
        }
      } else if (cachedTasks === null) {
        const nextCurrentTasks = projectUpdatedTasks(tasksRef.current);
        writeCache(cacheKey, nextCurrentTasks.length > 500 ? nextCurrentTasks.slice(0, 500) : nextCurrentTasks, { maxBytes: 500_000 });
      } else {
        clearCache(cacheKey);
      }
    }

    setTasks((prev) => {
      const next = projectUpdatedTasks(prev);
      tasksRef.current = next;
      return next;
    });
    return bypassedTask;
  }, [projectId]);

  const resetTask = useCallback(async (id: string, options?: TaskResetOptions): Promise<Task> => {
    return reconcileConfirmedTask(await api.resetTask(id, options, projectId));
  }, [projectId, reconcileConfirmedTask]);

  const duplicateTask = useCallback(async (id: string, options?: { workflowId?: string }): Promise<Task> => {
    const task = normalizeNonBoardTask(await api.duplicateTask(id, options, projectId));
    setTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      return [...prev, task];
    });
    return task;
  }, [projectId]);

  const updateTask = useCallback(async (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean; githubTracking?: { enabled?: boolean } }
  ): Promise<Task> => {
    const previousTask = tasksRef.current.find((t) => t.id === id);
    const optimisticTask = previousTask
      ? { ...previousTask, ...updates, updatedAt: new Date().toISOString() }
      : undefined;

    if (optimisticTask) {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? optimisticTask : t))
      );
    }

    try {
      const updatedTask = normalizeNonBoardTask(await api.updateTask(id, updates, projectId));
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? updatedTask : t))
      );
      return updatedTask;
    } catch (err) {
      if (previousTask) {
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? previousTask : t))
        );
      }
      throw err;
    }
  }, [projectId]);

  /*
  FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
  Client-side `revertTask` op. Deliberately does NOT patch the source task's
  column/status in local state — the git/AI-undo route never moves the
  source task backward (see the `FNXC:TaskRevert` route contract). On success
  (either a clean git revert producing a new commit, or an AI-undo task being
  created) we re-fetch via `refreshTasksRef` so the board picks up the new
  AI-undo task / any lineage changes without us guessing at the shape of the
  update ourselves.
  */
  const revertTask = useCallback(async (
    id: string,
    body?: api.RevertTaskOptions,
  ): Promise<api.RevertTaskResult> => {
    const result = await api.revertTask(id, projectId, body);
    void refreshTasksRef.current?.();
    return result;
  }, [projectId]);

  const ingestCreatedTasks = useCallback((incomingTasks: Task[]): void => {
    if (incomingTasks.length === 0) {
      return;
    }

    if (searchQueryRef.current) {
      void refreshTasksRef.current({ searchQueryOverride: searchQueryRef.current });
      return;
    }

    const normalizedTasks = filterActiveTasks(incomingTasks.map(normalizeNonBoardTask));
    setTasks((prev) => {
      let next = prev;

      for (const task of normalizedTasks) {
        const existingIndex = next.findIndex((candidate) => candidate.id === task.id);
        if (existingIndex === -1) {
          if (next === prev) {
            next = [...prev];
          }
          next.push(task);
          continue;
        }

        const current = next[existingIndex]!;
        const merged = mergeIncomingTask(current, task);
        if (merged === current) {
          continue;
        }

        if (next === prev) {
          next = [...prev];
        }
        next[existingIndex] = merged;
      }

      return next;
    });
    advanceFreshnessClockForLiveUpdate();
  }, [advanceFreshnessClockForLiveUpdate]);

  return { tasks, isStale, lastRefreshErrorAt, createTask, moveTask, pauseTask, unpauseTask, deleteTask, mergeTask, retryTask, bypassReview, resetTask, duplicateTask, updateTask, revertTask, loadMoreCurrentTasks, currentTasksTotal, currentTasksHasMore, currentTasksLoadingMore, loadMoreCompletedTasks, completedSortMode, changeCompletedSortMode, completedTotal, completedCounts, completedHasMore, completedLoadingMore, refreshTasks, ingestCreatedTasks, lastFetchTimeMs: lastFetchTimeMs.current };
}
