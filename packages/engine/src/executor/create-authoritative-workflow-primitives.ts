/**
 * FNXC:CodeOrganization 2026-08-03-14:15:
 * createAuthoritativeWorkflowPrimitivesFromExecutor peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowExecution 2026-06-23-11:49 / 2026-06-23-22:31:
 * prepareWorktree must not re-acquire; only trust live rows for the same task id.
 *
 * FNXC:WorkflowExecutionOwnership 2026-07-29-16:20:
 * runCodingSession is the live implementation owner and announces NodeCompleted exits.
 */
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import { emitWorkflowLifecycleEvent, resolveTaskLifecycleColumns } from "@fusion/core";
import type { ImplementationExit } from "./implementation-exit.js";
import type {
  AuditPrimitiveInput,
  PreparedWorktree,
  WorkflowPrimitiveContext,
  WorkflowRuntimePrimitives,
} from "../execution/runtime-primitives.js";
import { WorkflowPlanningService } from "../workflows/workflow-planning-service.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  SEAM_GOVERNING_NODE_CONTEXT_KEY,
  SEAM_SKILL_NAME_CONTEXT_KEY,
  SPLIT_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
} from "../workflows/workflow-node-handlers.js";
import { graphActiveContextKey } from "./task-predicates.js";
import { hasNonTerminalWorkflowSteps } from "./workflow-step-satisfaction.js";
import { makeAncestryBlastRadiusGuard, resetStepToBaseline } from "../execution/step-runner.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { createRunAuditor, type EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface without re-typing the class
type AnyFn = (...args: any[]) => any;

export type CreateAuthoritativeWorkflowPrimitivesDeps = {
  store: TaskStore;
  rootDir: string;
  graphSeamGoverningNodeId: Map<string, string>;
  graphStepActiveContext: Map<string, unknown>;
  pausedAborted: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- merge requester accepts optional signal bag
  mergeRequester?: ((taskId: string, opts?: any) => Promise<any>) | null;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  buildParseStepsDeps: AnyFn;
  createAuthoritativeWorkflowSeams: AnyFn;
  ensureWorkflowMergeBoundaryTask: AnyFn;
  getWorkflowMergeImplementationProofFailure: AnyFn;
  handoffTaskToReview: AnyFn;
  markPausedAborted: AnyFn;
  persistTokenUsage: AnyFn;
  runImplementationPhase: AnyFn;
  runProjectedGraphTaskStep: AnyFn;
};

export function createAuthoritativeWorkflowPrimitivesFromExecutor(
  deps: CreateAuthoritativeWorkflowPrimitivesDeps,
  settings: Settings,
): WorkflowRuntimePrimitives {
    const logAudit = async (taskId: string | undefined, input: AuditPrimitiveInput): Promise<void> => {
      if (!taskId) return;
      try {
        await deps.store.logEntry(taskId, input.message, input.metadata ? JSON.stringify(input.metadata) : undefined);
      } catch {
        // Audit is diagnostic-only and must not affect workflow execution.
      }
    };
    const planningService = new WorkflowPlanningService();

    return {
      prepareWorktree: async (_ctx, task) => {
        const live = await deps.store.getTask(task.id).catch(() => null);
        const liveTask = live?.id === task.id ? live : null;
        const routedTask = liveTask ?? task;
        const externalRoute = await resolveExternalExecutionCheckoutRoute(routedTask);
        if (externalRoute.configured && !externalRoute.valid) {
          return {
            outcome: "failure",
            value: `external-execution-checkout-invalid: ${externalRoute.reason ?? "unknown error"}`,
          };
        }
        /*
        FNXC:WorkflowExecution 2026-06-23-11:49:
        The workflow execute node must not perform a second worktree acquisition ahead of the authoritative executor. Passing the repo root as a prepared worktree makes the inner execute() reject a valid fresh-worktree task as repo-root reuse; pass only an existing task worktree and let execute() acquire when none exists.

        FNXC:WorkflowExecution 2026-06-23-22:31:
        Upgrade safety requires the graph primitive to tolerate older or minimal stores that return null or a mismatched row during startup/cutover. Only trust the live row when it is for the requested task; otherwise fall back to the runner snapshot.

        FNXC:ExternalExecutionCheckout 2026-08-09-23:53:
        Operator-routed external checkouts supply the prepared path/branch when configured.
        */
        const prepared: PreparedWorktree = {
          worktreePath: externalRoute.configured
            ? externalRoute.checkoutPath ?? ""
            : liveTask?.worktree || task.worktree || "",
          branchName: externalRoute.configured
            ? externalRoute.branch
            : liveTask?.branch || task.branch,
        };
        return { outcome: "success", value: "worktree-ready", data: prepared };
      },
      readArtifact: async (_ctx, task, key) => {
        const parseDeps = deps.buildParseStepsDeps(`${task.id}:artifact-read`);
        return parseDeps.readArtifact(task, key);
      },
      writeArtifact: async (ctx, task, key, content) => {
        const writer = (deps.store as unknown as {
          writeTaskDocument?: (taskId: string, key: string, content: string) => Promise<void>;
        }).writeTaskDocument;
        if (!writer) {
          await logAudit(task.id, {
            type: "artifact-write-unavailable",
            message: `Workflow node ${ctx.node.node.id} could not write artifact ${key}: store writer unavailable`,
          });
          return { outcome: "failure", value: "artifact-write-unavailable" };
        }
        await writer.call(deps.store, task.id, key, content);
        return { outcome: "success", value: "artifact-written", data: { key } };
      },
      runPlanningSession: (ctx, task) => planningService.runPlanningSession(ctx, task),
      runCodingSession: async (ctx, task, prepared) => {
        const governingNodeId = ctx.node.context?.[SEAM_GOVERNING_NODE_CONTEXT_KEY];
        if (typeof governingNodeId === "string") {
          deps.graphSeamGoverningNodeId.set(task.id, governingNodeId);
        }
        let result: { taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit };
        try {
          result = await deps.runImplementationPhase(task, prepared);
        } finally {
          deps.graphSeamGoverningNodeId.delete(task.id);
        }
        /*
        FNXC:WorkflowExecutionOwnership 2026-07-29-16:20 (U8 / R4, R5):
        THIS is the live implementation node, not the identically-shaped `execute` entry in
        `createAuthoritativeWorkflowSeams`. `createDefaultNodeHandlers` prefers the PRIMITIVES
        handler whenever `deps.primitives` is set, and `executeWorkflowGraph` always sets it — so
        the legacy-seams prompt handler is unreachable for prompt nodes and anything wired only
        there never runs. The exit announcement was wired only there; it is announced here now.

        Measured, not assumed: instrumenting the seam and `createPromptLikeHandler` produced no
        output for a graph run that demonstrably visited `steps#0:step-execute`, while a
        module-load write from the same file appeared — so the negative was real and not swallowed
        output.
        */
        emitWorkflowLifecycleEvent({
          type: "NodeCompleted",
          taskId: task.id,
          at: new Date().toISOString(),
          runId: deps.getRunContextFor(task.id)?.runId,
          nodeId: typeof governingNodeId === "string" ? governingNodeId : ctx.node.node.id,
          outcome: result.taskDone ? "success" : "failure",
          ...(result.exit ? { exit: result.exit } : {}),
        });
        if (result.taskDone) {
          return { outcome: "success", value: "implemented", data: result };
        }
        let paused = deps.pausedAborted.has(task.id);
        if (!paused) {
          try {
            paused = Boolean((await deps.store.getTask(task.id)).paused);
          } catch {
            // Best-effort pause probe; fall through to the failure value.
          }
        }
        /*
        FNXC:WorkflowExecutionOwnership 2026-07-29-18:45 (U8 / R4):
        THE PENDING-REVIEW ENDING IS A ROUTED OUTCOME, not a transition this phase performs. The
        implementation phase used to call `handoffTaskToReview` itself and let the graph discover
        the move afterwards; it now reports and stops, and this value routes the run to the
        workflow's `review-pending-handoff` node, which performs the handoff and ends the run —
        the same two effects in the same order, with the graph as the owner. Checked before the
        pause probe because a pending-review stop is not a pause.
        */
        if (result.exit === "review-handoff-pending-review") {
          return { outcome: "failure", value: "review-pending", data: result };
        }
        return {
          outcome: "failure",
          value: paused ? "implementation-paused" : "implementation-incomplete",
          data: result,
        };
      },
      runTaskStep: async (ctx, task, stepIndex) => {
        const context = ctx.node.context ?? {};
        const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        if (!active || typeof active.stepIndex !== "number") {
          return { outcome: "failure" };
        }
        const live = await deps.store.getTask(task.id);
        /*
        FNXC:WorkflowResume 2026-06-29-08:53:
        `step-execute` is a workflow node and must be idempotent on replay. If the live projection already says this foreach instance is terminal, return success before invoking the step runner so retries/restarts cannot fail a fully completed task on a stale step snapshot.
        */
        const liveStatus = live.steps[stepIndex]?.status;
        if (liveStatus === "done" || liveStatus === "skipped") {
          return {
            outcome: "success",
            value: "step-already-terminal",
            data: { status: liveStatus },
          };
        }
        deps.graphStepActiveContext.set(graphActiveContextKey(task.id, active.instanceId), active);
        const stepGoverningNodeId = context[SEAM_GOVERNING_NODE_CONTEXT_KEY];
        const seamSkillName = context[SEAM_SKILL_NAME_CONTEXT_KEY];
        return await deps.runProjectedGraphTaskStep(
          task,
          live,
          stepIndex,
          active,
          typeof stepGoverningNodeId === "string" ? stepGoverningNodeId : undefined,
          undefined,
          typeof seamSkillName === "string" && seamSkillName.trim() ? seamSkillName.trim() : undefined,
        );
      },
      resetTaskStep: async (ctx, task, stepIndex, baselineSha, checkpointId) => {
        const active = ctx.node.context?.[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        const branchScoped = typeof active?.worktreePath === "string" && active.worktreePath.length > 0;
        let worktreePath = active?.worktreePath ?? deps.rootDir;
        if (!branchScoped) {
          try {
            worktreePath = (await deps.store.getTask(task.id)).worktree || deps.rootDir;
          } catch {
            // Best-effort worktree resolution; fall back to rootDir.
          }
        }
        const liveSteps = await deps.store.getTask(task.id).then((t) => t.steps).catch(() => []);
        return await resetStepToBaseline(
          {
            store: deps.store,
            worktreePath,
            sessionRef: { current: null },
            reviewType: "code",
            blastRadiusGuard: branchScoped
              ? undefined
              : makeAncestryBlastRadiusGuard({
                  worktreePath,
                  task: { id: task.id, steps: liveSteps },
                  stepIndex,
                }),
          },
          { id: task.id, steps: liveSteps },
          stepIndex,
          baselineSha,
          checkpointId,
        );
      },
      runReview: async (ctx, task, input) => {
        if (typeof input.stepIndex === "number") {
          const context = ctx.node.context ?? {};
          const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
          if (!active || typeof active.stepIndex !== "number") {
            return {
              outcome: "success",
              value: "unavailable",
              data: { verdict: "UNAVAILABLE", review: "no active step instance" },
            };
          }
          const config = {
            type: input.type,
            advisory: context[SPLIT_ACTIVE_CONTEXT_KEY] === true,
          } as const;
          const seamResult = await deps.createAuthoritativeWorkflowSeams(settings).stepReview?.(
            task,
            context,
            config,
          );
          return {
            outcome: "success",
            value: seamResult?.verdict === "APPROVE" ? "approve" : seamResult?.verdict === "REVISE" ? "revise" : seamResult?.verdict === "RETHINK" ? "rethink" : "unavailable",
            data: seamResult ?? { verdict: "UNAVAILABLE", review: "step review unavailable" },
          };
        }
        const live = await deps.store.getTask(task.id);
        await deps.persistTokenUsage(task.id);
        await deps.handoffTaskToReview(live, "workflow-graph-review");
        return {
          outcome: "success",
          value: "in-review",
          data: { verdict: "APPROVE", summary: "Task handed off for merge review" },
        };
      },
      runVerification: async () => ({ outcome: "success", value: "verification-skipped", data: {
        verdict: "skipped",
      } }),
      // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) — the legacy
      // `runWorkflowStep` primitive + the `workflow-step` seam it served were
      // removed. Workflow quality gates run as the graph's own optional-group /
      // gate nodes (builtin:coding already routes through them), which record
      // results into `task.workflowStepResults` directly (U2). No `runWorkflowStep`
      // primitive remains in `WorkflowRuntimePrimitives`.
      updateSteps: async (_ctx, task, steps) => {
        await deps.store.updateTask(task.id, { steps });
        return { outcome: "success", value: "steps-updated", data: { count: steps.length } };
      },
      transitionTask: async (_ctx, task, input) => {
        const taskStore = deps.store;
        const patch: Partial<TaskDetail> = {};
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
        Resolve a requested ROLE to this task's own column, because the seam that asks cannot.

        `workflow-node-handlers.ts`'s review-handoff seam is a pure function over an IR node and a
        task — no store — so it could only name `in-review`. Post-U12 `moveTask` REJECTS a destination
        the workflow does not declare, so on a renamed review lane that transition threw
        `TransitionRejectionError` and killed the walk mid-run. Not a silent wrong answer for once: a
        hard failure in the middle of a workflow, which is why it outranked the rest of the backlog.

        Resolved per task from its OWN selection, so there is one authority — the mistake that took
        #2843 five review rounds was answering one question with two reads. `column` still wins when
        both are supplied, and an unresolvable role falls back to the legacy id rather than failing
        the transition, which is exactly the behaviour callers had before.
        */
        let targetColumn = input.column;
        if (targetColumn === undefined && input.columnRole === "review") {
          targetColumn = (await resolveTaskLifecycleColumns(taskStore, task.id))?.review ?? "in-review";
        }
        /*
        FNXC:WorkflowNotifications 2026-06-29-08:50:
        Workflow graph lifecycle transitions must use TaskStore move semantics, not raw `updateTask({ column })`, because ntfy/webhook notification delivery is subscribed to `task:moved`. Direct column writes make graph-owned tasks invisible to in-review/done lifecycle notifications and bypass column hooks.
        */
        if (targetColumn !== undefined) {
          const moveOptions = {
            preserveProgress: input.preserveProgress,
            moveSource: "engine" as const,
            workflowMoveSource: "workflow-graph",
            workflowMoveMetadata: {
              reason: input.reason,
              nodeId: _ctx.node.node.id,
              workflowId: _ctx.run.workflowId,
              runId: _ctx.run.runId,
            },
          };
          const storeWithMove = taskStore as typeof taskStore & {
            moveTask?: typeof taskStore.moveTask;
          };
          if (typeof storeWithMove.moveTask === "function") {
            await storeWithMove.moveTask(task.id, targetColumn, moveOptions);
          } else {
            patch.column = targetColumn;
          }
        }
        if (input.status !== undefined && input.status !== null) patch.status = input.status;
        if (Object.keys(patch).length > 0) {
          await taskStore.updateTask(task.id, patch);
        }
        return { outcome: "success", value: input.reason };
      },
      requestMerge: async (ctx, task) => {
        if (!deps.mergeRequester) {
          return { outcome: "failure", value: "merge-unavailable", data: { status: "failed", reason: "merge-unavailable" } };
        }
        /*
        FNXC:WorkflowCancellation 2026-07-15-10:42:
        Fail fast on an already-cancelled walk BEFORE any side effect. `ensureWorkflowMergeBoundaryTask` mutates the task row and the requester enqueues a real merge; neither may run for a walk the engine has already abandoned. `merge-cancelled` is deliberately not `data.status: "failed"` — `classifyMergeFailure` would read an unknown reason as `merge-failed` and route a cancellation into bounded auto-merge retry.
        */
        if (ctx.signal?.aborted) {
          return { outcome: "failure", value: "merge-cancelled" };
        }
        const mergeTask = await deps.ensureWorkflowMergeBoundaryTask(task, {
          reason: "workflow-merge-boundary",
          nodeId: ctx.node.node.id,
          workflowId: ctx.run.workflowId,
          runId: ctx.run.runId,
        });
        /*
        FNXC:WorkflowMerge 2026-06-29-23:18:
        FN-7261 reached the merge node in fast mode with every legacy implementation step still pending, producing a no-op merge proof for work that never ran. A graph-native workflow may project its checklist at the merge boundary only when node workflow results prove implementation completed; otherwise incomplete legacy steps are authoritative and merge must fail before the merger can create stale no-op proof.

        FNXC:WorkflowMerge 2026-06-30-00:38:
        Fast default Coding tasks must still execute implementation work. FN-7260/FN-7271 reached merge with no parsed task steps, no foreach instances, and no implementation proof, then finalized through no-op merge. The workflow merge boundary must fail before requesting merge when a coding workflow has not produced implementation evidence; fast mode only bypasses review/verification gates.
        */
        const missingImplementationProof = await deps.getWorkflowMergeImplementationProofFailure(mergeTask);
        if (missingImplementationProof) {
          await deps.store.logEntry(
            mergeTask.id,
            `Workflow merge blocked before requester: ${missingImplementationProof}`,
            undefined,
            deps.getRunContextFor(mergeTask.id),
          );
          return {
            outcome: "failure",
            value: "implementation-incomplete",
            data: { status: "failed", reason: "implementation-incomplete" },
          };
        }
        if (hasNonTerminalWorkflowSteps(mergeTask)) {
          await deps.store.logEntry(
            mergeTask.id,
            "Workflow merge blocked before requester: implementation steps are incomplete",
            undefined,
            deps.getRunContextFor(mergeTask.id),
          );
          return {
            outcome: "failure",
            value: "implementation-incomplete",
            data: { status: "failed", reason: "implementation-incomplete" },
          };
        }
        /*
        FNXC:WorkflowCancellation 2026-07-15-10:42:
        The timeout bounds a wedged merge queue; it is NOT the cancellation path. `ctx.signal` (graph abort) is linked in via `AbortSignal.any` so a hard-cancel collapses the merge node immediately instead of after the full timeout, and is raced separately so the walk returns rather than waiting on a requester that may not settle on abort. Keep both signals live: dropping the timeout re-strands the walk behind a wedged queue, dropping the cancel link restores the 30-minute stall.
        */
        const GRAPH_MERGE_TIMEOUT_MS = 30 * 60 * 1000;
        const controller = new AbortController();
        const mergeSignal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            resolve("timeout");
          }, GRAPH_MERGE_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });
        let onGraphAbort: (() => void) | undefined;
        const cancelled = new Promise<"cancelled">((resolve) => {
          if (!ctx.signal) return;
          onGraphAbort = () => resolve("cancelled");
          ctx.signal.addEventListener("abort", onGraphAbort, { once: true });
        });
        try {
          const result = await Promise.race([deps.mergeRequester(mergeTask.id, { signal: mergeSignal }), timeout, cancelled]);
          if (result === "cancelled") {
            executorLog.warn(`${mergeTask.id}: workflow merge primitive cancelled by graph abort`);
            return { outcome: "failure", value: "merge-cancelled" };
          }
          if (result === "timeout") {
            executorLog.warn(`${mergeTask.id}: workflow merge primitive timed out after ${GRAPH_MERGE_TIMEOUT_MS}ms`);
            return { outcome: "failure", value: "merge-timeout", data: { status: "timeout" } };
          }
          if (result.merged || result.noOp) {
            /*
            FNXC:WorkflowMerge 2026-06-29-09:24:
            The workflow merge primitive owns the normal lifecycle transition after a graph merge node succeeds. Finalize the proven landed task here so `mergeConfirmed` cannot strand a card in `in-progress`; executor preflight recovery is only a fallback for rows already stranded by older runs.
            */
            const finalization = await finalizeProvenAutoMergeTask({
              store: deps.store,
              taskId: mergeTask.id,
              result,
              rootDir: deps.rootDir,
              audit: createRunAuditor(deps.store, {
                runId: ctx.run.runId,
                agentId: "executor",
                taskId: mergeTask.id,
                taskLineageId: mergeTask.lineageId,
                phase: "workflow-merge",
              }),
              auditAgentId: "executor",
              auditPhase: "workflow-merge",
              source: "workflow-graph-merge-finalize",
              log: (message) => executorLog.warn(message),
            });
            if (finalization.outcome === "blocked" || finalization.outcome === "missing") {
              return {
                outcome: "failure",
                value: `merge-finalize-${finalization.outcome}`,
                data: { status: "failed", reason: finalization.reason ?? finalization.outcome },
              };
            }
            return {
              outcome: "success",
              value: result.noOp ? "merge-noop" : "merged",
              data: { status: "merged", noOp: result.noOp },
            };
          }
          return {
            outcome: "failure",
            value: result.reason ?? result.error ?? "merge-failed",
            data: { status: "failed", reason: result.reason ?? result.error ?? "merge-failed" },
          };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          // FNXC:WorkflowCancellation 2026-07-15-10:42: the graph signal outlives this node; leaving the listener attached leaks one per merge attempt across a retry loop.
          if (onGraphAbort) ctx.signal?.removeEventListener("abort", onGraphAbort);
          await logAudit(mergeTask.id, {
            type: "merge-requested",
            message: `Workflow node ${ctx.node.node.id} requested merge`,
          });
        }
      },
      abortRun: async (_ctx, task, input) => {
        if (input.hardCancel) {
          deps.markPausedAborted(task.id, "merge-seam", "workflow-abort-run:merge-seam");
        }
        await deps.store.updateTask(task.id, {
          paused: true,
          pausedReason: input.reason,
        } as Partial<TaskDetail>);
        return { outcome: "success", value: "aborted" };
      },
      audit: async (ctx: WorkflowPrimitiveContext, input) => {
        await logAudit(ctx.run.taskId, input);
      },
    };
}
