/**
 * FNXC:CodeOrganization 2026-08-03-22:40:
 * TaskExecutor constructor lifecycle wiring peeled from executor.ts (U4).
 *
 * Registers task-move/archive disposers and task:moved / task:deleted /
 * task:updated / settings:updated listeners. Free function so the class
 * constructor stays a thin wire-up of deps.
 *
 * FNXC:CodeOrganization 2026-08-04-04:00:
 * buildWireExecutorLifecycleDeps owns the field/method name lists so TaskExecutor's
 * constructor is a one-liner (store/rootDir/options + facadeFields/Methods bag).
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Task, TaskStore, TaskMoveLanes, RunMutationContext } from "@fusion/core";
import {
  canonicalizeWorktreePath,
  registerArchiveWorkspaceWorktreeDisposer,
  registerArchiveWorktreeDisposer,
  registerTaskMoveDisposer,
  resolveEffectiveAgent,
} from "@fusion/core";
import { RemovalReason, removeWorktree } from "../worktree/worktree-pool.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { resolveExecutorSessionModel } from "../agents/agent-session-helpers.js";
import { executorLog } from "../logger.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskExecutorOptions, ActiveExecutorSessionState } from "./task-executor-options.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import type { StepSessionExecutor } from "../execution/step-session-executor.js";
import { extractOwnSettings } from "./agent-binding-pure.js";
import { formatCommentForInjection } from "./execution-prompt.js";
import { detectReviewHandoffIntent } from "./pseudo-pause.js";
import { createSeenSteeringIds } from "./task-predicates.js";
import { facadeFields, facadeMethods } from "./facade-methods.js";
import { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";

const execFileAsync = promisify(execFile);

/** Field names collected from TaskExecutor for lifecycle listeners. */
const WIRE_LIFECYCLE_FIELDS = [
  "activeConfiguredCommandControllers", "activeSessions", "activeStepExecutorSeenSteeringIds",
  "activeStepExecutors", "activeSubagentSessions", "activeWorkflowGraphAbortControllers",
  "activeWorkflowStepSessionSeenSteeringIds", "activeWorkflowStepSessions",
  "approvalResumeAfterUnwind", "approvalSuspended", "effectiveColumnAgentByTask", "executing",
  "graphColumnAgentResolver", "graphRouting", "graphSeamGoverningNodeId", "loopRecoveryState",
  "pendingTaskDisposals", "recoveringCompleted", "spawnedAgents", "stuckAborted",
  "userCanceledTaskIds", "workflowLifecycleMovesInFlight",
] as const;

/** Method names bound from TaskExecutor for lifecycle listeners. */
const WIRE_LIFECYCLE_METHODS = [
  "awaitAbortInFlightTaskWork", "clearWorkflowRerunWatchdog", "deleteActiveWorkflowStepSession",
  "dispatchUnpauseResume", "disposeSubagentsForTask", "execute", "executeReviewHandoff",
  "getAssignedAgentRuntimeConfig", "getModelRegistry", "getRunContextFor",
  "isBackwardMoveOutOfPlanning", "markPausedAborted", "releasePreExecutionWorktree",
  "removeOwnWorktreeWithReconcile", "resetMergeStateIfNeeded", "resolveResumeLanes",
  "terminateAllChildren", "trackTaskDisposal",
] as const;

export type WireExecutorLifecycleDeps = {
  store: TaskStore;
  rootDir: string;
  options: TaskExecutorOptions;
  // Mutable maps/sets owned by TaskExecutor (mutated by listeners)
  activeConfiguredCommandControllers: Map<string, Set<AbortController>>;
  activeSessions: Map<string, ActiveExecutorSessionState>;
  activeStepExecutorSeenSteeringIds: Map<string, Set<string>>;
  activeStepExecutors: Map<string, StepSessionExecutor>;
  activeSubagentSessions: Map<string, Set<AgentSession>>;
  activeWorkflowGraphAbortControllers: Map<string, AbortController>;
  activeWorkflowStepSessionSeenSteeringIds: Map<string, Set<string>>;
  activeWorkflowStepSessions: Map<string, AgentSession>;
  approvalResumeAfterUnwind: Set<string>;
  approvalSuspended: Set<string>;
  effectiveColumnAgentByTask: Map<string, string>;
  executing: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host maps typed on TaskExecutor
  graphColumnAgentResolver: Map<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host routing set
  graphRouting: any;
  graphSeamGoverningNodeId: Map<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host loop recovery map
  loopRecoveryState: Map<string, any>;
  pendingTaskDisposals: Map<string, Promise<void>>;
  recoveringCompleted: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host spawned map
  spawnedAgents: Map<string, any>;
  stuckAborted: Map<string, boolean>;
  userCanceledTaskIds: Set<string>;
  workflowLifecycleMovesInFlight: Set<string>;
  // Methods
   
  awaitAbortInFlightTaskWork: (...args: any[]) => Promise<void>;
  clearWorkflowRerunWatchdog: (taskId: string) => void;
  deleteActiveWorkflowStepSession: (taskId: string) => void;
  dispatchUnpauseResume: (task: Task) => Promise<boolean>;
  disposeSubagentsForTask: (taskId: string, reason: string) => void;
  execute: (task: Task) => Promise<void>;
   
  executeReviewHandoff: (...args: any[]) => Promise<unknown>;
   
  getAssignedAgentRuntimeConfig: (...args: any[]) => Promise<Record<string, unknown> | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getModelRegistry: () => Promise<any>;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
  isBackwardMoveOutOfPlanning: (taskId: string, from: string, to: string, lanes: TaskMoveLanes | undefined) => boolean;
  markPausedAborted: (taskId: string, provenance?: PausedAbortProvenance, source?: string) => void;
   
  releasePreExecutionWorktree: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeOwnWorktreeWithReconcile: (input: any) => Promise<void>;
  resetMergeStateIfNeeded: (task: Task, from: string) => Promise<Task>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveResumeLanes: (...args: any[]) => Promise<any>;
  terminateAllChildren: (taskId: string) => Promise<void>;
  trackTaskDisposal: (taskId: string, disposal: Promise<void>) => void;
};

export type WireExecutorLifecycleResult = {
  unregisterTaskMoveDisposer: (() => void) | undefined;
  unregisterArchiveWorktreeDisposer: (() => void) | undefined;
  unregisterArchiveWorkspaceWorktreeDisposer: (() => void) | undefined;
};

/**
 * Build lifecycle deps from a TaskExecutor-shaped host (store/rootDir/options + maps/methods).
 * Keeps the constructor free of the field/method name lists.
 * Host is `object` because TaskExecutor's store/rootDir/options are private constructor params
 * and are not publicly assignable to a structural type with those property names.
 */
export function buildWireExecutorLifecycleDeps(host: object): WireExecutorLifecycleDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private TaskExecutor surface
  const h = host as any;
  return {
    store: h.store as TaskStore,
    rootDir: h.rootDir as string,
    options: h.options as TaskExecutorOptions,
    ...facadeFields(host, WIRE_LIFECYCLE_FIELDS),
    ...facadeMethods(host, WIRE_LIFECYCLE_METHODS),
  } as WireExecutorLifecycleDeps;
}

export function wireExecutorLifecycle(deps: WireExecutorLifecycleDeps): WireExecutorLifecycleResult {
  /*
  FNXC:EngineDiagnostics 2026-07-26-09:39:
  Executor bookkeeping that fires on every dispatch/session (construct, execute() entry, worktree ready, session create/register, prompt start, graph event stream, column-boundary warns-as-info, model/plugin setup, skip/duplicate/no-op guards) is debug-only (FUSION_DEBUG=executor). Keep log/warn/error for lifecycle outcomes operators act on: Starting task, ✓/✗ completion, failures, requeues, handoffs, stuck kills, verification failures, real moves.
  */
  executorLog.debug(`TaskExecutor constructed (rootDir=${deps.rootDir}, hasSemaphore=${!!deps.options.semaphore}, hasStuckDetector=${!!deps.options.stuckTaskDetector})`);
  const unregisterTaskMoveDisposer = registerTaskMoveDisposer(deps.store, async (task) => {
    // Start both paths without awaiting between them. Each synchronously
    // detaches its current targets before its first await, fencing late
    // cleanup from a replacement execution after the move timeout expires.
    const children = deps.terminateAllChildren(task.id);
    const activeWork = deps.awaitAbortInFlightTaskWork(task.id, "user moved task from in-progress to todo", {
      userCanceled: true,
    });
    await Promise.all([children, activeWork]);
  });
  /* FNXC:WorkflowLifecycle 2026-07-16-10:00: Executor replaces the baseline only for its own TaskStore, so archive awaits abort/sweep/removal before branch deletion without cross-store coupling. */
  const unregisterArchiveWorktreeDisposer = registerArchiveWorktreeDisposer(deps.store, async (task) => {
    /*
    FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
    Operator-owned external checkouts must never be removed on archive.
    */
    const externalExecutionRoute = await resolveExternalExecutionCheckoutRoute(task);
    if (externalExecutionRoute.configured) return;
    if (!task.worktree || await canonicalizeWorktreePath(task.worktree) === await canonicalizeWorktreePath(deps.rootDir)) return;
    await deps.awaitAbortInFlightTaskWork(task.id, "task archived");
    for (const path of activeSessionRegistry.pathsForTask(task.id)) activeSessionRegistry.unregisterPath(path);
    await deps.removeOwnWorktreeWithReconcile({worktreePath: task.worktree, settings: await deps.store.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose});
    task.worktree = undefined;
  });
  const unregisterArchiveWorkspaceWorktreeDisposer = registerArchiveWorkspaceWorktreeDisposer(deps.store, async (task, plan) => {
    const removed: string[] = [];
    const failed: {repoRel: string; error: unknown}[] = [];
    await deps.awaitAbortInFlightTaskWork(task.id, "workspace task archived");
    for (const entry of plan) {
      try {
        if (await canonicalizeWorktreePath(entry.worktreePath) === await canonicalizeWorktreePath(entry.repoRootDir)) throw new Error("Refusing to remove workspace repository root");
        activeSessionRegistry.unregisterPath(entry.worktreePath);
        await removeWorktree({worktreePath: entry.worktreePath, rootDir: entry.repoRootDir, settings: await deps.store.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose, force: true});
        /* FNXC:WorkflowLifecycle 2026-07-16-16:00: Archive metadata can contain valid Git refs with shell metacharacters. Pass the ref as an argv value so cleanup never evaluates it as shell code. */
        await execFileAsync("git", ["branch", "-D", entry.branch], {cwd: entry.repoRootDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024});
        if (task.workspaceWorktrees) for (const repoRel of [entry.repoRel, ...entry.aliasRepoRels]) delete task.workspaceWorktrees[repoRel];
        removed.push(entry.repoRel);
      } catch (error) { failed.push({repoRel: entry.repoRel, error}); }
    }
    return {removed, failed};
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:20 (was FLAGGED AND LEFT COUNTED; RESOLVED below —
  still do NOT convert with `resolveTaskWorkflowIrSync` / `resolvePlannerLanes`):

  Four lifecycle literals live in this listener and they are genuinely wrong on a renamed board:
  execution never starts on a move INTO the board's own wip lane, terminal session release never
  runs on a move into its archive lane, and the two `from` guards never fire, so in-flight work is
  not aborted when a card leaves implementation. Nothing errors; the engine simply stops reacting.

  THE OBVIOUS FIX IS INERT, AND THAT IS NOW PROVED RATHER THAN ARGUED. `task:moved` is emitted
  synchronously, so an await here reorders this handler against every other subscriber — which
  points at the sync IR path. That path cannot answer for a renamed board, for TWO independent
  reasons (`sync-workflow-ir-second-blocker.test.ts`):

    1. `getTaskWorkflowSelectionImpl` returns `undefined` unconditionally under PostgreSQL, so
       `resolveTaskWorkflowIrSync` always takes its `!workflowId` branch;
    2. even with a selection, the CUSTOM-workflow branch loads its IR through `store.db`, whose
       implementation is an unconditional throw — so it falls into the catch and returns the
       DEFAULT IR anyway.

  A renamed lane IS a custom workflow, so (2) alone is decisive: the sync path can never serve this
  listener's case. `check-inert-sync-lane-conversions` already baselines twenty guards in exactly
  that state in `scheduler.ts`; these four must not join them.

  They stay literal and COUNTED, which is the honest state — an unconverted literal is visible to
  the census, while an inert conversion leaves the backlog and takes the evidence with it.

  THE CRITERION IS NARROWER THAN "THE LISTENER IS SYNC", and I got this wrong first time elsewhere:
  what blocks a guard is whether ITS ANSWER IS CONSUMED SYNCHRONOUSLY, not whether it happens to sit
  inside a synchronous function. In `self-healing.ts`'s fan-out, three of four guards only gated work
  the listener already `void`s, so they were reachable by the async resolver all along and are now
  converted. These four are NOT that case, for two independent reasons:

    A. `trackTaskDisposal` writes `pendingTaskDisposals` in THIS tick, and the `to === wip` branch
       above READS that map to serialise a fast bounce (in-progress -> todo -> in-progress; the
       FN-5256 note it carries). Deferring the branch selection to a microtask lets the second
       event's prologue read the map before the first event's write lands — which reopens exactly
       the race that comment exists to close.
    B. This is an if / else-if CHAIN, so the guards are entangled: converting one changes which
       branch a move falls into. They convert together or not at all, and (A) blocks the set.

  UNBLOCKING therefore needs the async resolver reachable from a SYNCHRONOUS consumer, which means
  either a sync reader that answers for custom workflows AND survives a writer on another node, or
  restructuring the disposal bookkeeping so nothing is read in-tick — the constraints are written up
  in `sync-workflow-ir-second-blocker.test.ts`.

  FNXC:WorkflowResolvedColumns 2026-07-31-23:55 — RESOLVED BY A THIRD ROUTE, and the analysis above
  is kept because it is what rules the other two out.

  The block reduces to "no resolver can be CALLED here". It never required that the answer be
  unavailable — only that this listener cannot go and fetch it. So the lanes are resolved ONCE by
  the emitter, which is already async, and ride along on the event payload (`moves.ts`). Every
  objection above is about calling a resolver in-tick, so none of them survive the move:

    - (2)/the PostgreSQL sync-IR dead end: no sync resolver is used, so neither blocker applies.
    - (A) the in-tick `pendingTaskDisposals` race: NO await is introduced. Destructuring one more
      field is as synchronous as reading `to`, so branch selection still happens in this tick and
      the FN-5256 fast-bounce serialisation is untouched.
    - (B) the entangled if / else-if chain: satisfied rather than dodged — all four convert in
      this one commit, so no move can fall into a different branch than before.

  THE RESIDUAL RISK MOVES TO THE EMITTER, AND IT IS NOT YET CLOSED — stated plainly because the
  tempting version of this note is the false one. `lanes` is OPTIONAL on the payload
  (`store.ts`: `lanes?: TaskMoveLanes`) and the fallback below is the LEGACY LITERAL, so a
  `task:moved` published without it leaves these four guards exactly as inert as before, on a
  renamed board, with nothing failing. The conversion is only as good as the emitters.

  That is a strictly better position than the flagged state — the fallback is reached on one path
  instead of every path, and `moves.ts` (the move path these branches actually serve) does pass
  lanes — but it is NOT the compile-time guarantee it would be if the field were required.
  Requiring it is the right end state and is deliberately NOT done here: it retypes every
  `task:moved` emitter, which is its own change with its own blast radius, and bundling it would
  put a mechanical retype in the same commit as this behavior change.

  FOLLOW-UP, tracked with the emitter-side work: either make `lanes` required, or add a gate that
  asserts every `task:moved` emit site supplies it. Until one of those lands, treat the fallback
  as a live inertness path rather than defensive dead code.
  */
  deps.store.on("task:moved", ({ task, from, to, source, lanes }) => {
    executorLog.log(`[event:task:moved] ${task.id}: ${from} → ${to}`);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-21:30 (fleet):
    Lanes come from the EMITTER (see `moves.ts`), not from a resolver called here.

    This listener is synchronous and its branches start execution, dispose worktrees and release
    sessions, so its prologue is load-bearing — an await ahead of those branches would defer the
    `execute()` dispatch itself. The sync IR resolver is not an option either: it answers with the
    DEFAULT workflow under PostgreSQL, so a guard written through it is inert.

    Fail-soft to the legacy ids when the emit path could not resolve, matching every other consumer
    of this payload. `wipLane`/`archivedLane`/`holdLane` are read as SINGLE ids rather than sets
    because each branch below is a lane-identity test on one column, which is what the literals were.
    */
    const wipLane = lanes?.wip ?? "in-progress";
    const archivedLane = lanes?.archived ?? "archived";
    const holdLane = lanes?.hold ?? "todo";
    if (to === wipLane) {
      deps.userCanceledTaskIds.delete(task.id);
      if (deps.recoveringCompleted.has(task.id)) {
        executorLog.debug(`[event:task:moved] Skipping execute() for ${task.id} — completed-task recovery in progress`);
        return;
      }
      deps.clearWorkflowRerunWatchdog(task.id);
      executorLog.log(`[event:task:moved] Initiating execute() for ${task.id}`);
      void (async () => {
        // FN-5256: if the prior session is still being torn down (because the
        // task was just moved away from in-progress), wait for the worktree-
        // bound shells to reap before we acquire/create a new worktree. Without
        // this, a fast bounce (in-progress → todo → in-progress) races the
        // executor's own conflict cleanup against a still-live shell.
        const pending = deps.pendingTaskDisposals.get(task.id);
        if (pending) {
          executorLog.log(`[event:task:moved] Awaiting pending disposal for ${task.id} before dispatch`);
          await pending;
        }
        const taskForExecution = await deps.resetMergeStateIfNeeded(task, from);
        await deps.execute(taskForExecution);
      })().catch((err) =>
        executorLog.error(`Failed to start ${task.id}:`, err),
      );
    } else if (to === archivedLane) {
      /*
      FNXC:WorkflowLifecycle 2026-07-09-00:05:
      Archived is terminal, so it must release every active-session registry entry the
      task holds. Plan Review / other workflow-step and step-session sessions run while
      the task is in triage/planning/todo (not in-progress), so the old
      `from === "in-progress"`-only disposal branch below never fired for them — the
      registry entry (activeSessions / activeStepExecutors / activeWorkflowStepSessions,
      keyed on the shared project browse root) leaked past archive and blocked a
      successor task from acquiring the same session path with
      ActiveSessionPathHeldByForeignTaskError (FN-7717 / NEXT-508 -> NEXT-433). We
      deliberately do NOT do this for to === "done" / "in-review": those columns
      legitimately hold ai-merge / workspace-repo-land merge leases that must survive
      the transition (FN-6736 / Phase C/D merge-lease guarantees).

      This branch is checked BEFORE `from === "in-progress"` (and handles it too — a
      task can be archived directly from in-progress via fn_task_archive, a single
      `task:moved` event with no intermediate todo hop). Ordering the plain
      `from === "in-progress"`-only branch first would let that direct
      in-progress → archived transition fall into the narrower branch and skip the
      leaked-entry sweep below, re-opening the exact class of leak this fix closes for
      that one origin column. `awaitAbortInFlightTaskWork` here is the same call the
      in-progress branch makes (superset of its cleanup), so no case regresses.
      */
      deps.trackTaskDisposal(
        task.id,
        deps.awaitAbortInFlightTaskWork(task.id, "task archived").then(() => {
          // Belt-and-suspenders sweep: clear any registry entry that survived the
          // abort above because its in-memory session map was already empty
          // (a leaked entry with no live session to abort).
          for (const path of activeSessionRegistry.pathsForTask(task.id)) {
            activeSessionRegistry.unregisterPath(path);
          }
        }),
      );
    } else if (deps.isBackwardMoveOutOfPlanning(task.id, from, to, lanes)) {
      /*
      FNXC:PlanningEvacuation 2026-07-25-23:00:
      A card pulled BACKWARD out of a planner lane (the reported case: todo → Ideas) must stop all
      engine work on it, not just its planning session. Plan Review and other pre-execution graph
      nodes run while the card sits in todo/triage, so without this branch the reviewer kept
      streaming against a card the operator had withdrawn. Forward transitions are excluded — those
      are the card advancing, and their own lanes own the handoff. Also release the pre-execution
      worktree acquired at planning time so a withdrawn card leaves nothing behind on disk.
      */
      deps.trackTaskDisposal(
        task.id,
        deps.awaitAbortInFlightTaskWork(task.id, `task moved out of planning to ${to}`, {
          userCanceled: source === "user",
        }).then(async () => { await deps.releasePreExecutionWorktree(task.id, `moved to ${to}`); }),
      );
    } else if (from === wipLane) {
      if (deps.workflowLifecycleMovesInFlight.has(task.id) && deps.graphRouting.has(task.id)) {
        executorLog.log(
          `[event:task:moved] Preserving graph run for ${task.id} across its own ${from} → ${to} boundary`,
        );
        return;
      }
      deps.trackTaskDisposal(
        task.id,
        deps.awaitAbortInFlightTaskWork(task.id, `parent moved from in-progress to ${to}`, {
          userCanceled: source === "user" && to === holdLane,
        }),
      );
    }
  });

  deps.store.on("task:deleted", (task) => {
    deps.approvalSuspended.delete(task.id);
    deps.approvalResumeAfterUnwind.delete(task.id);
    deps.trackTaskDisposal(
      task.id,
      deps.awaitAbortInFlightTaskWork(task.id, "task soft-deleted", { userCanceled: true }),
    );
  });

  // When a task is paused while executing, terminate the agent session.
  // When steering comments are added during execution, inject them into the running session.
  //
  // Real-time steering comment injection mechanism:
  // 1. When execution starts, we initialize seenSteeringIds with all existing comment IDs
  // 2. On each task:updated event, we check if there are new comments not in seenSteeringIds
  // 3. New comments are injected via session.steer() which queues them for delivery
  //    after the current assistant turn completes (before the next LLM call)
  // 4. Comments are marked as seen BEFORE injection to prevent retry loops on failure
  // 5. Each injection is logged to the task for user visibility
  deps.store.on("task:updated", async (task) => {
    try {
      // FN-5256: handle pause by synchronously reaping every active session
      // surface in one shot. Awaiting the abort ensures spawned shells are
      // disposed before any re-dispatch can race the worktree.
      if (
        task.paused
        && (
          deps.activeSessions.has(task.id)
          || deps.activeStepExecutors.has(task.id)
          || deps.activeWorkflowStepSessions.has(task.id)
          || deps.activeConfiguredCommandControllers.has(task.id)
        )
      ) {
        executorLog.log(`Pausing ${task.id} — awaiting in-flight session disposal`);
        await deps.awaitAbortInFlightTaskWork(task.id, "task paused");
        return;
      }

      // Handle unpause of an in-progress task with no active session.
      // Approval can be decided while the old session is still unwinding;
      // remember that edge instead of losing the only task:updated event.
      /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): both checks in this listener ask "is
         this card still in the wip lane?"; one snapshot for the pair. With the literal neither fired on a
         renamed board — an unpaused card with no active session was never resumed. */
      const unpauseWipLane = (await deps.resolveResumeLanes(task.id)).wip;
      if (!task.paused && task.column === unpauseWipLane && deps.approvalSuspended.has(task.id)) {
        if (
          deps.executing.has(task.id)
          || deps.activeSessions.has(task.id)
          || deps.activeStepExecutors.has(task.id)
          || deps.activeWorkflowStepSessions.has(task.id)
        ) {
          deps.approvalResumeAfterUnwind.add(task.id);
          executorLog.log(`${task.id}: approval decision received during session unwind — deferred one resume`);
          return;
        }
      }

      // Explicit unpause updates and non-failed orphan updates can resume here;
      // startup failed-orphan recovery is owned by resumeOrphaned().
      // dispatchUnpauseResume owns the terminal-failure and duplicate guards.
      if (
        !task.paused
        && task.column === unpauseWipLane
        && !deps.activeSessions.has(task.id)
        && !deps.activeStepExecutors.has(task.id)
        && !deps.activeWorkflowStepSessions.has(task.id)
      ) {
        await deps.dispatchUnpauseResume(task);
        return;
      }

      // Column-agent restart-invalidation (plan U5, R7/KTD-4). A workflow-
      // definition edit (re-pointing a column's agent) or an agent runtimeConfig
      // change mutates NOTHING the task-field diff below observes — the watcher
      // would never see it. KTD-4's primary mechanism is event-driven invalidation,
      // but no `workflow:updated`/`agent:updated` store event exists on TaskStore
      // today (only task:/settings: events). Per the unit's documented fallback, we
      // re-resolve the column-effective agent/model on each `task:updated` tick for
      // GRAPH-MODE active entries ONLY (those whose session adopted a column agent —
      // `lastEffectiveColumnAgentId != null`). This is bounded by the active session
      // count, and only graph runs with a real column binding pay any cost. The
      // weaker guarantee (vs an arbitrary-time diff) is that a stale session
      // restarts on the next tick, not instantly — acceptable per the Risks note.
      //
      // agent-DELETED → fall back per R8 (no restart; the running session finishes
      // on its current model). agent-CHANGED (different effective agent OR same
      // agent with a new runtimeConfig model) → hot-swap, same path as a
      // task.modelProvider change.
      if (
        deps.activeSessions.has(task.id)
        && !task.paused
        && (deps.activeSessions.get(task.id)!.lastEffectiveColumnAgentId ?? null) !== null
        && deps.graphSeamGoverningNodeId.has(task.id)
        && deps.graphColumnAgentResolver.has(task.id)
      ) {
        const activeEntry = deps.activeSessions.get(task.id)!;
        const governingNodeId = deps.graphSeamGoverningNodeId.get(task.id)!;
        const resolveBinding = deps.graphColumnAgentResolver.get(task.id)!;
        const binding = resolveBinding(governingNodeId);
        const effective = binding
          ? resolveEffectiveAgent({ binding, ...extractOwnSettings(task) })
          : undefined;
        if (!effective || effective.source !== "column-agent") {
          // Binding RELEASED (PR #1432 review): a workflow edit removed the
          // binding, or `defer` now resolves to the task's own settings. Hand the
          // session back to normal resolution: hot-swap to the assigned/task
          // model (the same resolution the legacy block below owns), clear the
          // column-agent tracking, and release the reverse heartbeat guard so
          // isAgentEffectivelyExecuting() stops blocking the OLD agent.
          executorLog.log(`${task.id}: column-agent binding released — reverting session to own-settings resolution`);
          activeEntry.lastEffectiveColumnAgentId = null;
          deps.effectiveColumnAgentByTask.delete(task.id);
          // Fire-and-forget audit (matches the deletion-fallback posture above).
          deps.store.logEntry(
            task.id,
            "Column-agent binding released — session reverts to its own model/agent resolution",
            undefined,
            deps.getRunContextFor(task.id),
          ).catch((err: unknown) => executorLog.warn(`${task.id}: failed to log column-agent release: ${err instanceof Error ? err.message : String(err)}`));
          const settings = await deps.store.getSettings();
          const assignedRuntimeConfig = await deps.getAssignedAgentRuntimeConfig(task.assignedAgentId);
          const { provider: ownProvider, modelId: ownModelId } = resolveExecutorSessionModel(
            task.modelProvider,
            task.modelId,
            settings,
            assignedRuntimeConfig,
          );
          const providerChanged = ownProvider !== activeEntry.lastResolvedModelProvider;
          const modelIdChanged = ownModelId !== activeEntry.lastResolvedModelId;
          if ((providerChanged || modelIdChanged) && ownProvider && ownModelId) {
            activeEntry.lastResolvedModelProvider = ownProvider;
            activeEntry.lastResolvedModelId = ownModelId;
            try {
              const model = (await deps.getModelRegistry()).find(ownProvider, ownModelId);
              if (model) {
                await activeEntry.session.setModel(model);
                executorLog.log(`${task.id}: binding released — model reverted to ${ownProvider}/${ownModelId}`);
              }
            } catch (err: unknown) {
              executorLog.error(`${task.id}: failed to revert model after binding release: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else {
          {
            // Fetch the (possibly changed) effective column agent, best-effort.
            const newAgent = await deps.options.agentStore?.getAgent(effective.agentId).catch(() => null) ?? null;
            if (!newAgent) {
              // agent-DELETED (R8): fall back, NO restart. The running session
              // keeps its current model; the NEXT resolution falls back. Update the
              // tracked id so we stop probing for the missing agent every tick.
              if (activeEntry.lastEffectiveColumnAgentId !== null) {
                executorLog.log(`${task.id}: column agent '${effective.agentId}' deleted mid-session — falling back, no restart (R8)`);
                // Fire-and-forget audit (matches the rework-log posture at ~3582):
                // a logEntry failure must not abort this task:updated tick and skip
                // the model-change detection below.
                deps.store.logEntry(
                  task.id,
                  `Column agent '${effective.agentId}' deleted mid-session — falling back to current model, no restart (R8)`,
                  undefined,
                  deps.getRunContextFor(task.id),
                ).catch((err: unknown) => executorLog.warn(`${task.id}: failed to log column-agent deletion fallback: ${err instanceof Error ? err.message : String(err)}`));
                activeEntry.lastEffectiveColumnAgentId = null;
                // Release the reverse heartbeat guard for the deleted agent
                // (PR #1432 review): isAgentEffectivelyExecuting() must not keep
                // blocking an agent that no longer governs this session.
                deps.effectiveColumnAgentByTask.delete(task.id);
              }
            } else {
              const settings = await deps.store.getSettings();
              /*
              FNXC:ColumnAgentModel 2026-06-27-10:05:
              Override column agents own the active session model even when a mid-flight task edit adds its own modelProvider/modelId; ignore task-level model fields during column-agent re-resolution so the watcher cannot clobber the governing agent's runtime model.
              */
              const overrideColumnGoverns = binding!.mode === "override";
              const { provider: newProvider, modelId: newModelId } = resolveExecutorSessionModel(
                overrideColumnGoverns ? undefined : task.modelProvider,
                overrideColumnGoverns ? undefined : task.modelId,
                settings,
                (newAgent.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
              );
              const agentChanged = (activeEntry.lastEffectiveColumnAgentId ?? null) !== newAgent.id;
              const providerChanged = newProvider !== activeEntry.lastResolvedModelProvider;
              const modelIdChanged = newModelId !== activeEntry.lastResolvedModelId;
              if (agentChanged || providerChanged || modelIdChanged) {
                activeEntry.lastEffectiveColumnAgentId = newAgent.id;
                // Re-key the reverse heartbeat guard to the NEW agent (PR #1432
                // review): the old agent stops being blocked, the new one starts.
                deps.effectiveColumnAgentByTask.set(task.id, newAgent.id);
                activeEntry.lastResolvedModelProvider = newProvider;
                activeEntry.lastResolvedModelId = newModelId;
                if (newProvider && newModelId) {
                  try {
                    const model = (await deps.getModelRegistry()).find(newProvider, newModelId);
                    if (model) {
                      await activeEntry.session.setModel(model);
                      executorLog.log(`${task.id}: column-agent hot-swap → agent '${newAgent.id}' model ${newProvider}/${newModelId}`);
                      await deps.store.logEntry(task.id, `Column agent changed — model now ${newProvider}/${newModelId} (agent ${newAgent.id})`, undefined, deps.getRunContextFor(task.id));
                    } else {
                      executorLog.log(`${task.id}: column-agent model ${newProvider}/${newModelId} not found in registry for hot-swap`);
                    }
                  } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    executorLog.error(`${task.id}: failed to column-agent hot-swap: ${errorMessage}`);
                    // Fire-and-forget audit (see ~3582): a logEntry failure here must
                    // not abort the tick and skip later model-change detection.
                    deps.store.logEntry(task.id, `Column-agent change failed: ${errorMessage}`, undefined, deps.getRunContextFor(task.id))
                      .catch((logErr: unknown) => executorLog.warn(`${task.id}: failed to log column-agent change failure: ${logErr instanceof Error ? logErr.message : String(logErr)}`));
                  }
                }
              }
            }
          }
        }
      }

      // Handle executor model hot-swap on active single-session executions
      if (deps.activeSessions.has(task.id) && !task.paused) {
        const activeEntry = deps.activeSessions.get(task.id)!;
        // R3 guard: when an OVERRIDE column agent governs this running session, the
        // column-agent watcher block above OWNS the model (override supersedes the
        // task's own model/assigned-agent settings). The legacy task-model hot-swap
        // would otherwise resolve a model from task.assignedAgentId's runtimeConfig
        // and clobber the column agent's model on a mid-flight task edit. Skip it
        // entirely when override governs; defer-resolved-to-own-settings (or no
        // binding) keeps the legacy behavior identical.
        let overrideColumnGoverns = false;
        if ((activeEntry.lastEffectiveColumnAgentId ?? null) !== null) {
          const governingNodeId = deps.graphSeamGoverningNodeId.get(task.id);
          const resolveBinding = deps.graphColumnAgentResolver.get(task.id);
          if (governingNodeId && resolveBinding) {
            const binding = resolveBinding(governingNodeId);
            if (binding?.mode === "override") overrideColumnGoverns = true;
          }
        }

        const taskModelProviderChanged = task.modelProvider !== activeEntry.lastTaskModelProvider;
        const taskModelIdChanged = task.modelId !== activeEntry.lastTaskModelId;
        const assignedAgentChanged = (task.assignedAgentId ?? null) !== (activeEntry.lastAssignedAgentId ?? null);

        if (!overrideColumnGoverns && (taskModelProviderChanged || taskModelIdChanged || assignedAgentChanged)) {
          activeEntry.lastTaskModelProvider = task.modelProvider;
          activeEntry.lastTaskModelId = task.modelId;
          activeEntry.lastAssignedAgentId = task.assignedAgentId ?? null;

          const settings = await deps.store.getSettings();
          const assignedRuntimeConfig = await deps.getAssignedAgentRuntimeConfig(task.assignedAgentId);
          const { provider: newProvider, modelId: newModelId } = resolveExecutorSessionModel(
            task.modelProvider,
            task.modelId,
            settings,
            assignedRuntimeConfig,
          );

          const providerChanged = newProvider !== activeEntry.lastResolvedModelProvider;
          const modelIdChanged = newModelId !== activeEntry.lastResolvedModelId;
          if (!providerChanged && !modelIdChanged) {
            return;
          }
          activeEntry.lastResolvedModelProvider = newProvider;
          activeEntry.lastResolvedModelId = newModelId;

          if (newProvider && newModelId) {
            try {
              const model = (await deps.getModelRegistry()).find(newProvider, newModelId);
              if (model) {
                await activeEntry.session.setModel(model);
                executorLog.log(`${task.id}: executor model hot-swapped to ${newProvider}/${newModelId}`);
                await deps.store.logEntry(task.id, `Model changed to ${newProvider}/${newModelId}`, undefined, deps.getRunContextFor(task.id));
              } else {
                executorLog.log(`${task.id}: model ${newProvider}/${newModelId} not found in registry for hot-swap`);
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              executorLog.error(`${task.id}: failed to hot-swap model: ${errorMessage}`);
              await deps.store.logEntry(task.id, `Model change failed: ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
            }
          }
        }
      }

      // Handle steering comments - inject new ones into whichever execution
      // surface currently owns the task: legacy single-session, step-session
      // executor (including graph-pinned/workflow stepwise runs), or an
      // individual workflow step AgentSession.
      if (task.steeringComments) {
        const injectionTargets: Array<{
          kind: "legacy" | "step-session" | "workflow-step";
          seenSteeringIds: Set<string>;
          inject: (message: string, comment: import("@fusion/core").SteeringComment) => Promise<"injected" | "queued">;
          legacySession?: AgentSession;
          legacyState?: ActiveExecutorSessionState;
        }> = [];

        const activeSession = deps.activeSessions.get(task.id);
        if (activeSession) {
          injectionTargets.push({
            kind: "legacy",
            seenSteeringIds: activeSession.seenSteeringIds,
            inject: async (message) => {
              await activeSession.session.steer(message);
              return "injected";
            },
            legacySession: activeSession.session,
            legacyState: activeSession,
          });
        }

        const stepExecutor = deps.activeStepExecutors.get(task.id);
        if (stepExecutor) {
          /*
          FNXC:TaskDetailChat 2026-06-17-13:24:
          Task-detail chat comments must reach the running LLM thread immediately across legacy, step-session, and workflow-step surfaces. Step-session runs can be between per-step AgentSessions when a comment arrives, so keep the executor's task snapshot current and treat zero-session fan-out as a next-prompt fallback while preserving seenSteeringIds exactly-once delivery.
          */
          stepExecutor.updateSteeringComments?.(task.steeringComments);
          const seenSteeringIds = deps.activeStepExecutorSeenSteeringIds.get(task.id) ?? createSeenSteeringIds(task);
          deps.activeStepExecutorSeenSteeringIds.set(task.id, seenSteeringIds);
          injectionTargets.push({
            kind: "step-session",
            seenSteeringIds,
            inject: async (message, comment) => {
              const steeredSessionCount = await stepExecutor.steerActiveSessions(message);
              if (steeredSessionCount > 0) {
                stepExecutor.markSteeringCommentsDelivered?.([comment.id]);
                return "injected";
              }
              return "queued";
            },
          });
        }

        const workflowSession = deps.activeWorkflowStepSessions.get(task.id);
        if (workflowSession) {
          const seenSteeringIds = deps.activeWorkflowStepSessionSeenSteeringIds.get(task.id) ?? createSeenSteeringIds(task);
          deps.activeWorkflowStepSessionSeenSteeringIds.set(task.id, seenSteeringIds);
          injectionTargets.push({
            kind: "workflow-step",
            seenSteeringIds,
            inject: async (message) => {
              await workflowSession.steer(message);
              return "injected";
            },
          });
        }

        const loggedCommentIds = new Set<string>();
        let legacyReviewHandoff: {
          comments: import("@fusion/core").SteeringComment[];
          session: AgentSession;
          state: ActiveExecutorSessionState;
        } | undefined;

        for (const target of injectionTargets) {
          // Find new steering comments that haven't been seen by this running surface yet.
          const newComments = task.steeringComments.filter(c => !target.seenSteeringIds.has(c.id));
          if (newComments.length === 0) continue;

          for (const comment of newComments) {
            const summary = comment.text.length > 80
              ? comment.text.slice(0, 80) + "..."
              : comment.text;

            // Mark as seen BEFORE attempting injection to prevent retry loops on failure.
            target.seenSteeringIds.add(comment.id);

            const commentMessage = formatCommentForInjection(comment);
            try {
              executorLog.log(`Injecting comment into ${task.id} (${target.kind}): ${summary}`);
              const delivery = await target.inject(commentMessage, comment);
              if (delivery === "queued") {
                executorLog.log(`Queued comment for next ${target.kind} prompt in ${task.id}`);
              } else {
                executorLog.log(`Successfully injected comment into ${task.id} (${target.kind})`);
              }

              // Log to the task once per comment/tick even if multiple active surfaces exist.
              if (!loggedCommentIds.has(comment.id)) {
                await deps.store.logEntry(
                  task.id,
                  `Comment received mid-execution: ${summary}`,
                  `by ${comment.author}`
                );
                loggedCommentIds.add(comment.id);
              }
            } catch (err) {
              executorLog.error(`Failed to inject comment for ${task.id} (${target.kind}):`, err);
              // Comment is already marked as seen - we won't retry to avoid spamming
              // the agent with failed injections. The error is logged for debugging.
            }
          }

          if (target.kind === "legacy" && target.legacySession && target.legacyState) {
            legacyReviewHandoff = {
              comments: newComments,
              session: target.legacySession,
              state: target.legacyState,
            };
          }
        }

        // After injecting comments, check for review handoff intent on the legacy
        // session path. Step-session/workflow-step runs do not have the legacy
        // review handoff state required by executeReviewHandoff.
        if (legacyReviewHandoff) {
          // Only detect handoff in agent-authored comments when policy is enabled.
          // Merge per-task effective workflow settings (U3, KTD-3) so
          // reviewHandoffPolicy resolves from the workflow. Behavior-inert by default.
          const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());
          if (settings.reviewHandoffPolicy === "comment-triggered") {
            const agentComments = legacyReviewHandoff.comments.filter(c => c.author !== "user");
            for (const comment of agentComments) {
              if (detectReviewHandoffIntent(comment.text)) {
                executorLog.log(`Review handoff detected in ${task.id}: ${comment.text.slice(0, 50)}...`);
                await deps.executeReviewHandoff(task, legacyReviewHandoff.session, legacyReviewHandoff.state);
                return; // Exit early - handoff handles session disposal
              }
            }
          }
        }
      }
    } catch (err) {
      executorLog.error("Uncaught error in task:updated listener:", err);
    }
  });

  // When globalPause transitions from false → true, terminate all active agent sessions.
  deps.store.on("settings:updated", ({ settings, previous }) => {
    if (settings.globalPause && !previous.globalPause) {
      for (const [taskId, controllers] of deps.activeConfiguredCommandControllers) {
        executorLog.log(`Global pause — aborting configured command(s) for ${taskId}`);
        deps.markPausedAborted(taskId, "global-pause", "global-pause:configured-command");
        deps.options.stuckTaskDetector?.untrackTask(taskId);
        for (const controller of controllers) {
          controller.abort();
        }
        deps.activeConfiguredCommandControllers.delete(taskId);
        deps.loopRecoveryState.delete(taskId);
        deps.spawnedAgents.delete(taskId);
        deps.stuckAborted.delete(taskId);
      }
      // Dispose every reviewer subagent across every task. The per-task loops
      // below handle main + step sessions; reviewers live in their own map
      // and would otherwise outlive the global pause.
      for (const taskId of [...deps.activeSubagentSessions.keys()]) {
        deps.disposeSubagentsForTask(taskId, "global pause");
      }
      for (const [taskId, { session }] of deps.activeSessions) {
        executorLog.log(`Global pause — terminating agent session for ${taskId}`);
        deps.markPausedAborted(taskId, "global-pause", "global-pause:agent-session");
        deps.options.stuckTaskDetector?.untrackTask(taskId);
        // abort() interrupts any in-flight LLM stream / tool call;
        // dispose() then releases session resources.
        const sessionWithAbort = session as unknown as { abort?: () => Promise<void> };
        if (typeof sessionWithAbort.abort === "function") {
          void sessionWithAbort.abort().catch((err) => {
            executorLog.warn(`Failed to abort agent session for ${taskId}: ${err}`);
          });
        }
        session.dispose();
        // Clean up all in-memory state so nothing leaks when tasks are later unpaused
        deps.loopRecoveryState.delete(taskId);
        deps.spawnedAgents.delete(taskId);
        deps.stuckAborted.delete(taskId);
      }
      for (const [taskId, stepExecutor] of deps.activeStepExecutors) {
        executorLog.log(`Global pause — terminating step sessions for ${taskId}`);
        deps.markPausedAborted(taskId, "global-pause", "global-pause:step-session");
        deps.options.stuckTaskDetector?.untrackTask(taskId);
        stepExecutor.terminateAllSessions().catch(err =>
          executorLog.warn(`Failed to terminate step sessions for global pause ${taskId}: ${err}`)
        );
        // Clean up all in-memory state so nothing leaks when tasks are later unpaused
        deps.loopRecoveryState.delete(taskId);
        deps.spawnedAgents.delete(taskId);
        deps.stuckAborted.delete(taskId);
      }
      for (const [taskId, workflowSession] of deps.activeWorkflowStepSessions) {
        executorLog.log(`Global pause — terminating workflow step session for ${taskId}`);
        deps.markPausedAborted(taskId, "global-pause", "global-pause:workflow-step-session");
        deps.options.stuckTaskDetector?.untrackTask(taskId);
        const sessionWithAbort = workflowSession as AgentSession & { abort?: () => Promise<void> };
        if (typeof sessionWithAbort.abort === "function") {
          void sessionWithAbort.abort().catch((err) => {
            executorLog.warn(`Failed to abort workflow step session for ${taskId}: ${err}`);
          });
        }
        workflowSession.dispose();
        deps.deleteActiveWorkflowStepSession(taskId);
        deps.loopRecoveryState.delete(taskId);
        deps.spawnedAgents.delete(taskId);
        deps.stuckAborted.delete(taskId);
      }
      for (const [taskId, controller] of deps.activeWorkflowGraphAbortControllers) {
        executorLog.log(`Global pause — aborting workflow graph runner for ${taskId}`);
        deps.markPausedAborted(taskId, "global-pause", "global-pause:workflow-graph");
        deps.options.stuckTaskDetector?.untrackTask(taskId);
        controller.abort();
        deps.activeWorkflowGraphAbortControllers.delete(taskId);
        deps.loopRecoveryState.delete(taskId);
        deps.spawnedAgents.delete(taskId);
        deps.stuckAborted.delete(taskId);
      }
    }
  });

  return {
    unregisterTaskMoveDisposer,
    unregisterArchiveWorktreeDisposer,
    unregisterArchiveWorkspaceWorktreeDisposer,
  };
}

/*
FNXC:CodeOrganization 2026-08-04-07:25:
Apply wireExecutorLifecycle disposer handles onto a TaskExecutor-shaped host so the
class constructor stays a two-line super()+apply wire-up (U4 densify). Host is object
because disposer fields are protected on TaskExecutorState.
*/
export function applyWireExecutorLifecycleDisposers(
  host: object,
  wired: WireExecutorLifecycleResult,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected TaskExecutorState disposer fields
  const h = host as any;
  h.unregisterTaskMoveDisposer = wired.unregisterTaskMoveDisposer;
  h.unregisterArchiveWorktreeDisposer = wired.unregisterArchiveWorktreeDisposer;
  h.unregisterArchiveWorkspaceWorktreeDisposer = wired.unregisterArchiveWorkspaceWorktreeDisposer;
}

/*
FNXC:CodeOrganization 2026-08-04-07:30:
One-shot constructor wire: build deps, register lifecycle listeners, apply disposer
handles. TaskExecutor constructor is then super()+wireTaskExecutorLifecycle(this).
*/
export function wireTaskExecutorLifecycle(host: object): void {
  // FNXC:WorkflowAgentRouting 2026-08-07-03:38: init capacity before listeners so graph admission tests see the field post-construct.
  const h = host as { options?: TaskExecutorOptions; workflowAgentCapacity?: WorkflowAgentCapacity };
  h.workflowAgentCapacity = new WorkflowAgentCapacity(h.options?.agentStore ?? undefined);
  applyWireExecutorLifecycleDisposers(host, wireExecutorLifecycle(buildWireExecutorLifecycleDeps(host)));
}
