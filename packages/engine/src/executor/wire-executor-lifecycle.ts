/**
 * FNXC:CodeOrganization 2026-08-03-22:40:
 * TaskExecutor constructor lifecycle wiring peeled from executor.ts (U4).
 *
 * Registers the task-move disposer and task:moved / task:deleted /
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
  registerTaskMoveDisposer,
  resolveEffectiveAgent,
} from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { resolveExecutorSessionModel } from "../agents/agent-session-helpers.js";
import { executorLog } from "../logger.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import type { TaskExecutorOptions, ActiveExecutorSessionState } from "./task-executor-options.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import type { StepSessionExecutor } from "../execution/step-session-executor.js";
import { extractOwnSettings } from "./agent-binding-pure.js";
import { formatCommentForInjection } from "./execution-prompt.js";
import { detectReviewHandoffIntent } from "./pseudo-pause.js";
import { createSeenSteeringIds } from "./task-predicates.js";
import { facadeFields, facadeMethods } from "./facade-methods.js";
import { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";

/**
 * FNXC:WorkspaceWorktree 2026-08-23-06:25:
 * An acquisition registry entry mirrors a durable acquire lease. Owner disappearance
 * must release both immediately, but this deliberately excludes land/ai-merge records
 * because completed and review lanes may still own their merge critical section.
 */
async function releaseWorkspaceAcquireClaims(store: TaskStore, taskId: string): Promise<void> {
  for (const entry of activeSessionRegistry.entriesByKind("workspace-repo-acquire")) {
    if (entry.taskId === taskId) activeSessionRegistry.unregisterPath(entry.path);
  }
  const inspect = (store as Partial<TaskStore>).inspectWorkspaceLeases;
  const release = (store as Partial<TaskStore>).releaseWorkspaceLease;
  if (typeof inspect !== "function" || typeof release !== "function") return;
  const leases = await inspect.call(store, { taskId });
  await Promise.all(leases
    .filter((lease) => lease.kind === "acquire" && lease.status === "held")
    .map((lease) => release.call(store, lease)));
}

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
  "resetMergeStateIfNeeded", "resolveResumeLanes",
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
  resetMergeStateIfNeeded: (task: Task, from: string) => Promise<Task>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveResumeLanes: (...args: any[]) => Promise<any>;
  terminateAllChildren: (taskId: string) => Promise<void>;
  trackTaskDisposal: (taskId: string, disposal: Promise<void>) => void;
};

export type WireExecutorLifecycleResult = {
  unregisterTaskMoveDisposer: (() => void) | undefined;
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
  /*
  FNXC:WorkflowResolvedColumns 2026-08-22-00:13:
  Task-move emitters resolve lifecycle lanes before synchronous listener dispatch and the lane cache
  preserves the last authoritative answer. WIP and Hold routing therefore supports renamed workflows
  without awaiting inside this ordering-sensitive listener; cold-cache callers use legacy fallbacks.
  */
  deps.store.on("task:moved", ({ task, from, to, source, lanes }) => {
    /*
    FNXC:Diagnostics 2026-08-10-18:32:
    Per-move tracing is DEBUG. This listener fires on every task:moved event — every dispatch,
    rebound, requeue, and self-healing move across every task — so at `log` level it was the
    single loudest line in engine output and buried the events an operator actually needs to see.
    The information is still available at debug level; nothing here is an operator-actionable signal
    on its own.
    */
    executorLog.debug(`[event:task:moved] ${task.id}: ${from} → ${to}`);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-21:30 (fleet):
    Lanes come from the EMITTER (see `moves.ts`), not from a resolver called here.

    This listener is synchronous and its branches start execution, dispose worktrees and release
    sessions, so its prologue is load-bearing — an await ahead of those branches would defer the
    `execute()` dispatch itself. The sync IR resolver is not an option either: it answers with the
    DEFAULT workflow under PostgreSQL, so a guard written through it is inert.

    Fail-soft to the legacy ids when the emit path could not resolve, matching every other consumer
    of this payload. `wipLane`/`holdLane` are read as SINGLE ids rather than sets
    because each branch below is a lane-identity test on one column, which is what the literals were.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-08-22-00:13:
    Optional payload lanes win, then the store's synchronous TTL cache preserves the last real
    answer after an emitter resolution miss; literals are only the cold-cache compatibility tier.
    Runtime/project bridges re-emit on their own EventEmitters, not TaskStore, so they cannot feed
    this listener and intentionally remain outside this contract.
    */
    const effectiveLanes = lanes ?? deps.store.laneCache?.get(task.id);
    /* FNXC:WorkflowResolvedColumns 2026-08-22-00:28: fall back only when no lane answer exists; an answer with an absent role must not invent a legacy role-named column. */
    const wipLane = effectiveLanes ? effectiveLanes.wip : "in-progress";
    const holdLane = effectiveLanes ? effectiveLanes.hold : "todo";
    if (to === wipLane) {
      deps.userCanceledTaskIds.delete(task.id);
      if (deps.recoveringCompleted.has(task.id)) {
        executorLog.debug(`[event:task:moved] Skipping execute() for ${task.id} — completed-task recovery in progress`);
        return;
      }
      deps.clearWorkflowRerunWatchdog(task.id);
      executorLog.debug(`[event:task:moved] Initiating execute() for ${task.id}`);
      void (async () => {
        // FN-5256: if the prior session is still being torn down (because the
        // task was just moved away from in-progress), wait for the worktree-
        // bound shells to reap before we acquire/create a new worktree. Without
        // this, a fast bounce (in-progress → todo → in-progress) races the
        // executor's own conflict cleanup against a still-live shell.
        const pending = deps.pendingTaskDisposals.get(task.id);
        if (pending) {
          executorLog.debug(`[event:task:moved] Awaiting pending disposal for ${task.id} before dispatch`);
          await pending;
        }
        const taskForExecution = await deps.resetMergeStateIfNeeded(task, from);
        await deps.execute(taskForExecution);
      })().catch((err) =>
        executorLog.error(`Failed to start ${task.id}:`, err),
      );
    } else if (deps.isBackwardMoveOutOfPlanning(task.id, from, to, effectiveLanes)) {
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
        }).then(async () => {
          await releaseWorkspaceAcquireClaims(deps.store, task.id);
          await deps.releasePreExecutionWorktree(task.id, `moved to ${to}`);
        }),
      );
    } else if (from === wipLane) {
      if (deps.workflowLifecycleMovesInFlight.has(task.id) && deps.graphRouting.has(task.id)) {
        executorLog.debug(
          `[event:task:moved] Preserving graph run for ${task.id} across its own ${from} → ${to} boundary`,
        );
        return;
      }
      deps.trackTaskDisposal(
        task.id,
        deps.awaitAbortInFlightTaskWork(task.id, `parent moved from in-progress to ${to}`, {
          userCanceled: source === "user" && to === holdLane,
        }).then(() => releaseWorkspaceAcquireClaims(deps.store, task.id)),
      );
    }
  });

  deps.store.on("task:deleted", (task) => {
    deps.approvalSuspended.delete(task.id);
    deps.approvalResumeAfterUnwind.delete(task.id);
    deps.trackTaskDisposal(
      task.id,
      deps.awaitAbortInFlightTaskWork(task.id, "task soft-deleted", { userCanceled: true })
        .then(() => releaseWorkspaceAcquireClaims(deps.store, task.id)),
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
