/**
 * FNXC:CodeOrganization 2026-08-03-14:20:
 * createAuthoritativeWorkflowSeams peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowExecutionOwnership 2026-07-27-16:25 / 2026-07-28-20:25:
 * Seam return vocabulary is the ownership boundary; exit events announce without changing outcomes.
 */
import type { AgentStore, Settings, TaskStore, ThinkingLevel, WorkspaceConfig } from "@fusion/core";
import { emitWorkflowLifecycleEvent, THINKING_LEVELS } from "@fusion/core";
import type { ImplementationExit } from "./implementation-exit.js";
import type { WorkflowLegacySeams } from "../workflows/workflow-node-handlers.js";
import type { AgentSemaphore } from "../concurrency/concurrency.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  SEAM_GOVERNING_NODE_CONTEXT_KEY,
  SEAM_SKILL_NAME_CONTEXT_KEY,
  SEAM_THINKING_LEVEL_CONTEXT_KEY,

  type ForeachActiveContext,
} from "../workflows/workflow-node-handlers.js";
import { graphActiveContextKey } from "./task-predicates.js";
import { WorkflowReviewService } from "../workflows/workflow-review-service.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { resolveReviewCheckoutCwd } from "../execution/review-checkout.js";
import { logReviewCheckoutRouting } from "./review-checkout-routing.js";
import { selectUserCommentsForAgentContext } from "../agents/agent-user-comments.js";
import {
  resolveValidatorThinkingLevel,
  resolveValidatorFallbackThinkingLevel,
} from "../agents/agent-session-helpers.js";
import type { ReviewVerdict } from "../execution/reviewer.js";
import {
  buildReviewUnavailableMessage,
  buildPlanVerifiedMessage,
  buildReviewVerdictMessage,
  emitProactiveStatus,
  sanitizeFailureReason,
} from "../project/proactive-status.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog, reviewerLog } from "../logger.js";

const WORKFLOW_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface
type AnyFn = (...args: any[]) => any;

export type CreateAuthoritativeWorkflowSeamsDeps = {
  store: TaskStore;
  rootDir: string;
  options: {
    agentStore?: AgentStore | null;
    pluginRunner?: unknown;
    semaphore?: AgentSemaphore;
    mergeRequester?: unknown;
    [k: string]: unknown;
  };
  workspaceConfig: WorkspaceConfig | null | undefined;
  activeWorkflowPrincipals: Map<string, { agentId: string; nodeInstanceId: string; agent?: import("@fusion/core").Agent }>;
  graphSeamGoverningNodeId: Map<string, string>;
  graphSeamThinkingLevel: Map<string, ThinkingLevel>;
  graphStepActiveContext: Map<string, unknown>;
  graphRethinkNarrations: Map<string, unknown>;
  pausedAborted: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mergeRequester?: ((taskId: string, opts?: any) => Promise<any>) | null;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  persistTokenUsage: AnyFn;
  runImplementationPhase: AnyFn;
  handoffTaskToReview: AnyFn;
  ensureWorkflowMergeBoundaryTask: AnyFn;
  getWorkflowMergeImplementationProofFailure: AnyFn;
  runProjectedGraphTaskStep: AnyFn;
  updateStepGraph: AnyFn;
  reviewWorkspacePerRepo: AnyFn;
  registerSubagentSession: AnyFn;
  unregisterSubagentSession: AnyFn;
};

export function createAuthoritativeWorkflowSeams(
  deps: CreateAuthoritativeWorkflowSeamsDeps,
  _settings: Settings,
): WorkflowLegacySeams {
    return {
      // Built-in triage/spec generation runs upstream of the interpreter today,
      // so planning is a no-op for already-specified tasks. Custom planning
      // behavior is expressed as a custom prompt node before the execute seam.
      planning: async () => ({ outcome: "success", value: "pre-specified" }),
      execute: async (seamTask, context) => {
        // Column-agent seam wiring (U4, R4): record the governing node id (the
        // execute-seam prompt node, stamped into context by createPromptLikeHandler)
        // so execute()'s session build can resolve the column-agent binding for the
        // node's DECLARED column. Cleared after the pass so a later seam without a
        // binding cannot inherit a stale node id.
        const governingNodeId = context?.[SEAM_GOVERNING_NODE_CONTEXT_KEY];
        if (typeof governingNodeId === "string") {
          deps.graphSeamGoverningNodeId.set(seamTask.id, governingNodeId);
        }
        const seamThinkingLevel = context?.[SEAM_THINKING_LEVEL_CONTEXT_KEY];
        if (typeof seamThinkingLevel === "string" && WORKFLOW_THINKING_LEVEL_SET.has(seamThinkingLevel)) {
          deps.graphSeamThinkingLevel.set(seamTask.id, seamThinkingLevel as ThinkingLevel);
        }
        let result: { taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit };
        try {
          result = await deps.runImplementationPhase(seamTask);
        } finally {
          deps.graphSeamGoverningNodeId.delete(seamTask.id);
          deps.graphSeamThinkingLevel.delete(seamTask.id);
        }
        /*
        FNXC:WorkflowExecutionOwnership 2026-07-27-16:25 (U8 / R4):
        THIS BOOLEAN IS THE OWNERSHIP BOUNDARY, and it is too narrow. `runImplementation` has
        28 measured ways of disposing of a task (16 column moves, 3 review handoffs, 9 terminal
        parks — counted by `executor-lifecycle-ownership-ledger.test.ts`) and exactly 3 ways of
        telling the graph anything, all of which collapse to `taskDone: true` here.

        The consequence is not a missing feature, it is a second lifecycle owner. Because the
        seam has no value for "the agent stopped because a step is blocked on a pending review"
        or "the session was paused after the work was already complete", the implementation
        phase performs those transitions ITSELF (`executor-exit-while-review-pending`,
        `paused-after-completion`) and the graph learns about them afterwards — which is why
        `handleGraphFailure` carries `alreadyFinalizedToReview` / `completionFinalized`
        classifiers whose whole job is to recognise a move the graph did not make.

        U8's direction: widen this vocabulary so a disposition is REPORTED here and the graph
        routes it, rather than performed upstream and compensated for downstream. The
        compensating classifiers are the acceptance test — they become unreachable, and then
        deletable, exactly when the last out-of-band transition is gone.
        */
        /*
        FNXC:WorkflowExecutionOwnership 2026-07-28-20:25 (U8 / R4, R5):
        Announce the exit on the U3 lifecycle bus. Until this, the two out-of-band review
        handoffs left NO trace anywhere that the executor — not the graph — moved the card;
        they surfaced as an ordinary `implementation-incomplete` failure that
        `handleGraphFailure` then quietly compensated for. An operator could not tell the two
        apart, and neither could a test.

        Emission is deliberately AFTER the phase and BEFORE the return, and it changes nothing:
        the outcome/value below are byte-identical to what this seam returned before, for every
        exit, which `executor-implementation-exit-events.test.ts` pins by driving each exit and
        asserting the seam's return. Per R5 an exit id is a REACTION — dropping every subscriber
        must change no execution outcome, and that is asserted too.
        */
        emitWorkflowLifecycleEvent({
          type: "NodeCompleted",
          taskId: seamTask.id,
          at: new Date().toISOString(),
          runId: deps.getRunContextFor(seamTask.id)?.runId,
          nodeId: typeof governingNodeId === "string" ? governingNodeId : "execute",
          outcome: result.taskDone ? "success" : "failure",
          ...(result.exit ? { exit: result.exit } : {}),
        });
        if (result.taskDone) {
          return { outcome: "success", value: "implemented" };
        }
        // Distinguish pause/abort from genuine implementation failure so the
        // failure handler can leave paused tasks to the pause machinery.
        let paused = deps.pausedAborted.has(seamTask.id);
        if (!paused) {
          try {
            paused = Boolean((await deps.store.getTask(seamTask.id)).paused);
          } catch {
            // Best-effort pause probe; fall through to the failure value.
          }
        }
        return {
          outcome: "failure",
          value: paused ? "implementation-paused" : "implementation-incomplete",
        };
      },
      // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) — the legacy
      // `workflowStep` seam was removed. Workflow quality gates run as the graph's
      // own optional-group / gate nodes (builtin:coding replaced its `workflow-step`
      // seam node with optional-group nodes) which record into
      // `task.workflowStepResults` (U2). `WorkflowLegacySeams.workflowStep` no
      // longer exists, and `resolveSeamName` no longer recognizes the
      // `workflow-step` seam (an IR node still declaring it now fails loudly via
      // WorkflowIrError rather than silently no-opping).
      review: async (seamTask) => {
        // The legacy "review" stage is the in-review handoff: the in-review column is
        // the staging state the merge queue consumes.
        const live = await deps.store.getTask(seamTask.id);
        await deps.persistTokenUsage(seamTask.id);
        await deps.handoffTaskToReview(live, "workflow-graph-review");
        return { outcome: "success", value: "in-review" };
      },
      "review-handoff": async (seamTask) => {
        /*
         * FNXC:WorkflowPrPolicy 2026-06-29-16:42:
         * Compound Engineering can run an optional manual PR review lane after implementation. That lane must start from the review column without invoking the generic reviewer again; this seam is a pure lifecycle handoff so PR creation/feedback nodes run while the card is visibly in review.
         */
        const live = await deps.store.getTask(seamTask.id);
        await deps.persistTokenUsage(seamTask.id);
        await deps.handoffTaskToReview(live, "workflow-graph-review-handoff");
        return { outcome: "success", value: "in-review" };
      },
      merge: async (seamTask, _context, signal) => {
        if (!deps.mergeRequester) {
          return { outcome: "failure", value: "merge-unavailable" };
        }
        // FNXC:WorkflowCancellation 2026-07-15-10:42: fail fast before the boundary-task mutation and the merge request — an abandoned walk must not enqueue a merge. Mirrors the `requestMerge` primitive.
        if (signal?.aborted) {
          return { outcome: "failure", value: "merge-cancelled" };
        }
        const mergeTask = await deps.ensureWorkflowMergeBoundaryTask(seamTask, {
          reason: "workflow-merge-boundary",
          nodeId: "legacy-merge-seam",
          workflowId: "legacy-seams",
          runId: deps.getRunContextFor(seamTask.id)?.runId ?? "legacy-seam",
        });
        const missingImplementationProof = await deps.getWorkflowMergeImplementationProofFailure(mergeTask);
        if (missingImplementationProof) {
          await deps.store.logEntry(
            mergeTask.id,
            `Workflow merge blocked before requester: ${missingImplementationProof}`,
            undefined,
            deps.getRunContextFor(mergeTask.id),
          );
          return { outcome: "failure", value: "implementation-incomplete" };
        }
        // Bound the wait: a wedged merge queue must not strand the graph walk
        // holding the routing claim. On timeout the run fails cleanly and the
        // task is parked for human review; the queue can still finish later.
        // FNXC:WorkflowCancellation 2026-07-15-10:42: the timeout is the wedged-queue bound, `signal` is the cancellation path — both must stay live. See the `requestMerge` primitive for the stall this prevents.
        const GRAPH_MERGE_TIMEOUT_MS = 30 * 60 * 1000;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), GRAPH_MERGE_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });
        let onGraphAbort: (() => void) | undefined;
        const cancelled = new Promise<"cancelled">((resolve) => {
          if (!signal) return;
          onGraphAbort = () => resolve("cancelled");
          signal.addEventListener("abort", onGraphAbort, { once: true });
        });
        try {
          const result = await Promise.race([deps.mergeRequester(mergeTask.id, signal ? { signal } : undefined), timeout, cancelled]);
          if (result === "cancelled") {
            executorLog.warn(`${mergeTask.id}: graph merge seam cancelled by graph abort`);
            return { outcome: "failure", value: "merge-cancelled" };
          }
          if (result === "timeout") {
            executorLog.warn(`${mergeTask.id}: graph merge seam timed out after ${GRAPH_MERGE_TIMEOUT_MS}ms`);
            return { outcome: "failure", value: "merge-timeout" };
          }
          if (result.merged || result.noOp) {
            return { outcome: "success", value: result.noOp ? "merge-noop" : "merged" };
          }
          return { outcome: "failure", value: result.reason ?? result.error ?? "merge-failed" };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (onGraphAbort) signal?.removeEventListener("abort", onGraphAbort);
        }
      },
      schedule: async () => ({ outcome: "success" }),
      // Step-inversion (KTD-2/KTD-4, U3): run exactly the foreach-active step.
      // The foreach sub-walk has set `foreach:active` with the step index; here
      // we drive runTaskStep (step-runner.ts) over the task's worktree, then
      // capture the per-step baselineSha/checkpointId back INTO the active
      // context object so a later RETHINK (U5) can reset the step. The full
      // single-step session physics (a StepSessionExecutor scoped to one step)
      // is U5/U7 territory; U3 wires the seam and the context capture, using the
      // existing implementation phase as the single-pass step driver.
      stepExecute: async (seamTask, context) => {
        const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        if (!active || typeof active.stepIndex !== "number") {
          return { outcome: "failure", value: "no-active-step-instance" };
        }
        const live = await deps.store.getTask(seamTask.id);
        // Worktree isolation (KTD-11, U10): run the instance's session in ITS OWN
        // worktree when the foreach allocated one; otherwise the task's main
        // worktree (shared isolation — unchanged). The file-scope guard the session
        // machinery installs applies to either worktree unchanged (not bypassed).
        // Stamp the active instance so `runGraphTaskStep` can honor
        // `deferDoneToReview` when judging a non-terminal step (FIX 3).
        deps.graphStepActiveContext.set(graphActiveContextKey(seamTask.id, active.instanceId), active);
        // Column-agent seam wiring (U4, R4): the governing node id — the foreach
        // INSTANCE node id (`<foreachId>#<i>:<templateNodeId>`) stamped into
        // context by createPromptLikeHandler — threads INTO runGraphTaskStep,
        // which stamps the per-task slot only when it CREATES the memoized
        // implementation pass and clears it when that pass settles (PR #1432
        // review). One step-session pass serves every instance, so the
        // session-identity binding is deterministically the pass-initiating
        // instance's; per-invocation set/delete here would race under parallel
        // foreach (overwrite mid-build, or clear while the shared pass is live).
        const stepGoverningNodeId = context[SEAM_GOVERNING_NODE_CONTEXT_KEY];
        const seamThinkingLevel = context[SEAM_THINKING_LEVEL_CONTEXT_KEY];
        const seamSkillName = context[SEAM_SKILL_NAME_CONTEXT_KEY];
        const result = await deps.runProjectedGraphTaskStep(
          seamTask,
          live,
          active.stepIndex,
          active,
          typeof stepGoverningNodeId === "string" ? stepGoverningNodeId : undefined,
          typeof seamThinkingLevel === "string" && WORKFLOW_THINKING_LEVEL_SET.has(seamThinkingLevel)
            ? (seamThinkingLevel as ThinkingLevel)
            : undefined,
          typeof seamSkillName === "string" && seamSkillName.trim() ? seamSkillName.trim() : undefined,
        );
        // Capture baseline/checkpoint back into the reserved active context so the
        // foreach sub-walk threads them to later template nodes (step-review/reset).
        active.baselineSha = result.baselineSha;
        active.checkpointId = result.checkpointId;
        /*
        FNXC:WorkflowExecutionOwnership 2026-07-29-11:30 (U8 / R4):
        `step-done` / `step-failed` was a two-value flattening of every possible ending, and it
        is why the pending-review ending could never reach an edge on the stepwise shape. A
        blocked-on-pending-review pass is a WAIT, not a step defect: the outcome stays `failure`
        (the step genuinely did not complete) while the VALUE names the ending, which is what the
        foreach propagates upward — `runForeach` returns a failing instance's value as its own —
        so the `steps` node can carry an `outcome:review-pending` edge to the park node.
        Every other ending keeps `step-failed` exactly as before.
        */
        const failureValue = result.exit === "review-handoff-pending-review" ? "review-pending" : "step-failed";
        return {
          outcome: result.outcome,
          value: result.outcome === "success" ? "step-done" : failureValue,
          contextPatch: {
            [FOREACH_ACTIVE_CONTEXT_KEY]: active,
          },
        };
      },
      // Step-inversion (KTD-4, U5): review the foreach-active step. Mirrors the
      // legacy in-session review call (deleted in U10): run
      // reviewStep under semaphore.runNested against the instance's step number/
      // name and the task's PROMPT content. On an authoritative (non-advisory)
      // APPROVE, mark the step done through the projection (updateStep, KTD-7) —
      // the step-execute seam left it in-progress (markDoneOnSuccess:false) so the
      // review is the single done authority. The handler maps the returned verdict
      // to outcome edges and applies the UNAVAILABLE bounded-retry limiter.
      stepReview: async (seamTask, context, config) => {
        const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        if (!active || typeof active.stepIndex !== "number") {
          // No active instance — surface UNAVAILABLE so the handler routes it
          // rather than fabricating an authoritative verdict.
          return { verdict: "UNAVAILABLE", review: "no active step instance" };
        }
        const stepIndex = active.stepIndex;
        const detail = await deps.store.getTask(seamTask.id);
        // Worktree isolation (KTD-11): review the instance's OWN worktree when set.
        const worktreePath = active.worktreePath || detail.worktree || deps.rootDir;
        const reviewCwd = resolveReviewCheckoutCwd(detail, worktreePath);
        logReviewCheckoutRouting(seamTask.id, detail, reviewCwd, worktreePath);
        const stepName = detail.steps[stepIndex]?.name ?? `Step ${stepIndex}`;
        const promptContent = detail.prompt ?? "";
        const userComments = selectUserCommentsForAgentContext(detail, { limit: null });
        // Merge per-task effective workflow settings (U3, KTD-3) so the validator
        // model-lane reads below pick up workflow values. Behavior-inert by default.
        const settings = await mergeEffectiveSettings(deps.store, detail, await deps.store.getSettings());

        /*
        FNXC:AgentSteering 2026-06-30-12:37:
        Workflow graph step-review nodes are optional or mandatory reviewer gates. Pass canonical user comments and legacy steering into each per-cwd reviewer so workspace aggregation never drops operator requirements.

        FNXC:AgentSteering 2026-06-30-13:20:
        Graph reviewer gates request uncapped comment context because every user-authored requirement can affect approval, including older steering retained on long-running tasks.
        */
        const sem = deps.options.semaphore;
        // FNXC:Workspace 2026-06-22-00:30: KTD3 — step-inversion review seam loops per sub-repo.
        // `reviewStep` stays single-cwd; THIS CALLER loops. Single-cwd by default reviews
        // `worktreePath`; in workspace mode that is the browse-only non-git root, so we instead spawn
        // one reviewer per acquired sub-repo (cwd = repo.worktreePath) via reviewWorkspacePerRepo and
        // aggregate as a conjunction. `invokeReviewerForCwd` is the per-cwd reviewStep call both modes share.
        const reviewService = new WorkflowReviewService();
        const invokeReviewerForCwd = (cwd: string) =>
          reviewService.reviewStep({
            cwd,
            taskId: seamTask.id,
            stepIndex,
            stepName,
            type: config.type,
            promptContent,
            // Code reviews diff against the per-step baseline captured at
            // step-execute; plan reviews pass no baseline (advisory).
            baselineSha: config.type === "code" ? active.baselineSha : undefined,
            options: {
              defaultProvider: settings.defaultProvider,
              defaultModelId: settings.defaultModelId,
              fallbackProvider: settings.fallbackProvider,
              fallbackModelId: settings.fallbackModelId,
              /*
               * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
               * Step-review model sessions honor per-node `config.thinkingLevel` before the task validator override, then shared task thinking, validator workflow lane, global lane, and default thinking settings.
               */
              defaultThinkingLevel: resolveValidatorThinkingLevel(
                typeof config.thinkingLevel === "string" && WORKFLOW_THINKING_LEVEL_SET.has(config.thinkingLevel)
                  ? (config.thinkingLevel as ThinkingLevel)
                  : detail.validatorThinkingLevel ?? detail.thinkingLevel,
                settings,
              ),
              fallbackThinkingLevel: resolveValidatorFallbackThinkingLevel(
                typeof config.thinkingLevel === "string" && WORKFLOW_THINKING_LEVEL_SET.has(config.thinkingLevel)
                  ? (config.thinkingLevel as ThinkingLevel)
                  : detail.validatorThinkingLevel ?? detail.thinkingLevel,
                settings,
              ),
              taskValidatorProvider: detail.validatorModelProvider,
              taskValidatorModelId: detail.validatorModelId,
              taskValidatorCredentialInstanceId: detail.validatorCredentialInstanceId,
              projectValidatorProvider: settings.validatorProvider,
              projectValidatorModelId: settings.validatorModelId,
              projectValidatorFallbackProvider: settings.validatorFallbackProvider,
              projectValidatorFallbackModelId: settings.validatorFallbackModelId,
              globalValidatorProvider: settings.validatorGlobalProvider,
              globalValidatorModelId: settings.validatorGlobalModelId,
              projectDefaultOverrideProvider: settings.defaultProviderOverride,
              projectDefaultOverrideModelId: settings.defaultModelIdOverride,
              store: deps.store,
              taskId: seamTask.id,
              task: detail,
              userComments: userComments.length > 0 ? userComments : undefined,
              agentPrompts: settings.agentPrompts,
              agentStore: deps.options.agentStore ?? undefined,
              rootDir: deps.rootDir,
              settings,
              /* FNXC:WorkflowAgentRouting 2026-08-07-04:45: reviewer sessions inherit the exact graph-fenced principal, including a node-local override. */
              agentId: deps.activeWorkflowPrincipals.get(seamTask.id)?.agentId,
              onSessionCreated: (s) => deps.registerSubagentSession(seamTask.id, s),
              onSessionEnded: (s) => deps.unregisterSubagentSession(seamTask.id, s),
            },
          });
        const runForCwd = (cwd: string): Promise<{ verdict: ReviewVerdict; review: string; summary: string }> => {
          const invoke = () => invokeReviewerForCwd(cwd);
          return sem ? sem.runNested(invoke) : invoke();
        };
        const invokeReviewer = () =>
          deps.workspaceConfig && reviewCwd === worktreePath
            ? deps.reviewWorkspacePerRepo(detail, (cwd: string) => runForCwd(cwd))
            : runForCwd(reviewCwd);

        let review: { verdict: ReviewVerdict; review: string; summary: string };
        try {
          review = await invokeReviewer();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reviewerLog.error(`${seamTask.id}: step-review failed: ${message}`);
          const narration = buildReviewUnavailableMessage(err);
          void emitProactiveStatus(deps.store, seamTask.id, narration, "reviewer", sanitizeFailureReason(err));
          return { verdict: "UNAVAILABLE", review: `reviewer error: ${message}` };
        }

        await deps.store.logEntry(
          seamTask.id,
          `${config.type} step-review Step ${stepIndex}: ${review.verdict}${config.advisory ? " (advisory)" : ""}`,
          review.summary,
        );
        const narration = config.type === "plan" && review.verdict === "APPROVE"
          ? buildPlanVerifiedMessage()
          : review.verdict === "UNAVAILABLE"
            ? buildReviewUnavailableMessage(review.summary)
            : buildReviewVerdictMessage(review.verdict, review.summary);
        if (review.verdict === "RETHINK") {
          // RETHINK's rollback claim is emitted by applyGraphRethinkReset only after reset succeeds.
          deps.graphRethinkNarrations.set(graphActiveContextKey(seamTask.id, active.instanceId), review.summary);
        } else {
          void emitProactiveStatus(deps.store, seamTask.id, narration, "reviewer", narration ? sanitizeFailureReason(review.summary) : undefined);
        }

        // Single-writer rule (KTD-4): advisory (split-branch) reviews never write
        // the projection — they are fan-out checks that cannot clobber the
        // authoritative verdict. Only an on-path APPROVE marks the step done.
        if (review.verdict === "APPROVE" && !config.advisory) {
          try {
            const cur = await deps.store.getTask(seamTask.id);
            const status = cur.steps[stepIndex]?.status;
            if (stepIndex >= 0 && stepIndex < cur.steps.length && status !== "done" && status !== "skipped") {
              await deps.updateStepGraph(seamTask.id, stepIndex, "done");
              await deps.store.logEntry(
                seamTask.id,
                `Step ${stepIndex} (${stepName}) marked done by step-review APPROVE (graph)`,
              );
            }
          } catch (err) {
            reviewerLog.warn(
              `${seamTask.id}: failed to mark Step ${stepIndex} done after APPROVE: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        return { verdict: review.verdict, review: review.review, summary: review.summary };
      },
    };
}
