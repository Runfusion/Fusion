import { WorkflowIrError, instanceNodeId } from "@fusion/core";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "./workflow-graph-executor.js";
import { createPrNodeHandlers, createAutoMergeGateHandler, type PrNodeDeps } from "./pr-nodes.js";
import {
  primitiveNodeContext,
  type WorkflowPrimitiveContext,
  type WorkflowRuntimePrimitives,
} from "./runtime-primitives.js";
import { createGateHandler } from "./workflow-node-runners/gate-runner.js";
import {
  createParseStepsHandler,
  type ParseStepsHandlerDeps,
} from "./workflow-node-runners/parse-steps-runner.js";
import {
  createCodeNodeHandler,
  type CodeNodeRunnerDelegate as CodeNodeRunner,
} from "./workflow-node-runners/code-runner.js";
import {
  createNotifyHandler,
  type WorkflowNotifyDispatch,
} from "./workflow-node-runners/notify-runner.js";
import {
  createMergeAttemptHandler,
  createMergeGateHandler,
} from "./workflow-node-runners/merge-runner.js";
import { createExitGateHandler } from "./workflow-node-runners/exit-gate-runner.js";

export { createGateHandler } from "./workflow-node-runners/gate-runner.js";
export {
  createParseStepsHandler,
  PARSE_STEPS_DEFAULT_ARTIFACT,
  type ParseStepsHandlerDeps,
} from "./workflow-node-runners/parse-steps-runner.js";
export {
  createCodeNodeHandler,
  type CodeNodeRunnerDelegate as CodeNodeRunner,
} from "./workflow-node-runners/code-runner.js";
export {
  createNotifyHandler,
  type WorkflowNotifyDispatch,
} from "./workflow-node-runners/notify-runner.js";
export {
  createExitGateHandler,
  type WorkflowExitGateConfig,
} from "./workflow-node-runners/exit-gate-runner.js";

// FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) — the `workflow-step` seam
// was removed. Workflow quality gates run as the graph's own optional-group /
// gate nodes (builtin:coding replaced its `workflow-step` seam node with
// optional-group nodes) which record into `task.workflowStepResults` (U2). An IR
// node still declaring `config.seam: "workflow-step"` is no longer a recognized
// seam: `resolveSeamName` throws a WorkflowIrError for it (fails loud, never a
// silent no-op).
export const SEAM_THINKING_LEVEL_CONTEXT_KEY = "workflow:seamThinkingLevel";

export type WorkflowSeamName =
  | "planning"
  | "execute"
  | "review"
  | "review-handoff"
  | "merge"
  | "schedule"
  | "step-execute";

export interface WorkflowLegacySeams {
  /** Planning/spec stage. Built-in triage runs upstream of the interpreter
   *  today, so the default engine seam is a no-op for already-specified tasks;
   *  custom planning behavior is expressed as a custom prompt node. */
  planning: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  execute: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  review: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  "review-handoff"?: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /** FNXC:WorkflowCancellation 2026-07-15-10:42: `signal` carries graph cancellation into the legacy merge seam, which — like the merge primitive — otherwise blocks on its own 30-minute timeout and cannot observe a hard-cancel. Optional so seam fakes need not implement it. */
  merge: (task: TaskDetail, context: Record<string, unknown>, signal?: AbortSignal) => Promise<WorkflowNodeResult>;
  schedule: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-2/KTD-4, U3): run exactly the foreach-active step inside
   * the task's session/worktree. Only invoked for `step-execute` prompt nodes
   * inside a foreach template, where `context["foreach:active"]` carries the
   * active instance's `stepIndex`. Optional — a workflow that never uses a
   * foreach/step-execute node needs no implementation (the noop seams omit it,
   * and a step-execute node reached without this wired fails cleanly rather than
   * silently no-opping). The engine wires this to `runTaskStep` (executor.ts
   * createGraphSeams); it returns the per-step `baselineSha`/`checkpointId` in
   * its `contextPatch` so a later RETHINK (U5) can reset the step.
   */
  stepExecute?: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-4, U5): review the foreach-active step. Only invoked for
   * `step-review` nodes inside a foreach template, where `context["foreach:active"]`
   * carries the active instance. The seam calls `reviewStep` (reviewer.ts) under
   * `semaphore.runNested` against the instance's step + the task's PROMPT content
   * (the same way `fn_review_step` does), and — on an authoritative (non-advisory)
   * APPROVE — marks the step `done` through the projection (`updateStep(source:"graph")`,
   * KTD-7). It persists the verdict back into the active context so the foreach
   * sub-walk can write it into the instance row (KTD-6). It returns the raw verdict;
   * the {@link createStepReviewHandler} handler maps it to the outcome value the
   * `outcome:approve|revise|rethink|unavailable` edges route on. Optional — a
   * workflow without a step-review node needs no implementation.
   *
   * @param advisory when true (the node is inside a `split` branch — single-writer
   *   rule, KTD-4) the seam must NOT write the projection and only logs an audit
   *   note; the verdict is advisory and never routes the authoritative instance.
   */
  stepReview?: (
    task: TaskDetail,
    context: Record<string, unknown>,
    config: StepReviewConfig,
  ) => Promise<StepReviewSeamResult>;
}

/** Config a `step-review` node carries (KTD-4). */
export interface StepReviewConfig {
  type: "plan" | "code";
  model?: string;
  /** Optional per-node reasoning-effort override for the review session. */
  thinkingLevel?: string;
  /** Single-writer rule (KTD-4): true when the node is inside a split branch, so
   *  the review is advisory-only — no projection write, no authoritative verdict. */
  advisory?: boolean;
}

/** Verdict surface the step-review seam returns (mirrors reviewer.ts ReviewResult). */
export interface StepReviewSeamResult {
  verdict: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  review?: string;
  summary?: string;
}

/** The reserved context key carrying the active foreach instance (KTD-3, U3).
 *  Template node handlers (step-execute now; step-review in U5) read it to learn
 *  which step they operate on and the per-instance baseline/checkpoint state. */
export const FOREACH_ACTIVE_CONTEXT_KEY = "foreach:active";

/**
 * Reserved context key carrying the GOVERNING graph node id into the legacy
 * coding seams (column-agent plan U4, R4). The execute seam reads the seam node's
 * own id; the step-execute seam reads the foreach INSTANCE node id
 * (`<foreachId>#<i>:<templateNodeId>`) so the core column-agent resolver can map
 * it through template inheritance to the governing column's binding. The seam
 * stamps it into a per-run executor slot before driving the implementation pass,
 * so the binding the session runs under keys off the node's DECLARED IR column
 * — never the task's current board lane. Custom (non-seam) nodes never use this:
 * runGraphCustomNode receives its binding directly as a parameter (U3).
 */
export const SEAM_GOVERNING_NODE_CONTEXT_KEY = "workflow:seam-governing-node-id";

/**
 * Reserved context marker set by the split sub-walk (`runSplitJoin`) for the
 * duration of its branches' execution and cleared at the join (KTD-4, U5). A
 * `step-review` node that reads this as `true` is running inside a split branch,
 * so its verdict is **advisory-only** (single-writer rule): it never writes the
 * projection nor authors the routing verdict. `step-execute` is validator-forbidden
 * in splits, so only step-review needs to consult this.
 */
export const SPLIT_ACTIVE_CONTEXT_KEY = "split:active";

/**
 * Reserved context marker (KTD-11) the worktree-isolation foreach seeds into an
 * instance's context for ONE re-run after an integration-conflict, when the
 * template authored an explicit `outcome:integration-conflict` edge. Author nodes
 * read it to branch on the conflict; the sub-walk clears it after seeding so a
 * later clean rework does not re-surface a stale conflict signal.
 */
export const INTEGRATION_CONFLICT_CONTEXT_KEY = "integration:conflict";

/** Reserved graph context key for the current workflow run id. */
export const WORKFLOW_RUN_ID_CONTEXT_KEY = "workflow:run-id";

/** Reserved graph context key for the current workflow id. */
export const WORKFLOW_ID_CONTEXT_KEY = "workflow:id";

/** Shape of the value stored under {@link FOREACH_ACTIVE_CONTEXT_KEY}. */
export interface ForeachActiveContext {
  foreachNodeId: string;
  stepIndex: number;
  instanceId: string;
  baselineSha?: string;
  checkpointId?: string;
  /** Latest authoritative step-review verdict for this instance (KTD-4/KTD-6, U5).
   *  Written by the step-review handler (non-advisory only); the foreach sub-walk
   *  persists it into the instance row. */
  verdict?: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  /**
   * True when the foreach template contains a `step-review` node (U6/KTD-4), so a
   * successful `step-execute` must NOT mark the step done — the review's APPROVE
   * verdict is the single authority that does (`markDoneOnSuccess: false`). The
   * foreach sub-walk sets this at instance entry; the step-execute seam reads it.
   */
  deferDoneToReview?: boolean;
  /**
   * Worktree-isolation (KTD-11, U10): the instance's OWN worktree path, branched
   * off the integration base. Set by the foreach sub-walk at instance entry under
   * `isolation: "worktree"`; the step-execute / step-review / RETHINK seams run
   * against THIS path instead of the task's main worktree. Absent under
   * `isolation: "shared"` (work lands directly in the main worktree). The file-scope
   * guard still fires for anything the instance session commits in this worktree
   * (the session machinery is unchanged — see executor stepExecute seam).
   */
  worktreePath?: string;
  /** Worktree-isolation (KTD-11, U10): the instance's OWN branch name (e.g.
   *  `fusion/<task>-step-<i>`). Set with {@link worktreePath}; the ordered
   *  integration stage lands this branch onto the task's main branch. */
  branchName?: string;
}

/**
 * Runs a custom (non-seam) prompt/script/gate node for a task — typically by
 * delegating to the WorkflowStep prompt-session/script machinery. Injected so
 * the graph layer stays engine-agnostic and unit-testable with fakes.
 */
export type WorkflowCustomNodeRunner = (
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
) => Promise<WorkflowNodeResult>;

/*
FNXC:WorkflowCancellation 2026-07-15-10:42:
`signal` is the graph walk's cancellation signal, taken from the node's own `WorkflowNodeExecutionContext.signal`. It was previously dropped here, leaving primitives unable to observe a graph abort — see {@link WorkflowPrimitiveContext.signal} for the 30-minute merge stall that caused. Every call site must forward its exec-context signal; a primitive that receives `undefined` cannot be cancelled.
*/
function primitiveContextForNode(
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
  attempt?: number,
  signal?: AbortSignal,
): WorkflowPrimitiveContext {
  return primitiveNodeContext(
    {
      runId: typeof context[WORKFLOW_RUN_ID_CONTEXT_KEY] === "string"
        ? context[WORKFLOW_RUN_ID_CONTEXT_KEY]
        : `${task.id}:workflow`,
      taskId: task.id,
      workflowId: typeof context[WORKFLOW_ID_CONTEXT_KEY] === "string"
        ? context[WORKFLOW_ID_CONTEXT_KEY]
        : "unknown",
    },
    node,
    {
      attempt,
      context,
      effectivePrincipalId:
        typeof context["workflow:effective-principal-id"] === "string"
          ? context["workflow:effective-principal-id"]
          : undefined,
    },
    signal,
  );
}

/** Resolve a node's seam name, or undefined for custom (non-seam) nodes. */
export function resolveSeamName(node: { config?: Record<string, unknown> }): WorkflowSeamName | undefined {
  const seam = node.config?.seam;
  if (seam === undefined) return undefined;
  if (
    seam === "planning" ||
    seam === "execute" ||
    seam === "review" ||
    seam === "review-handoff" ||
    seam === "merge" ||
    seam === "schedule" ||
    seam === "step-execute"
  ) {
    return seam;
  }
  throw new WorkflowIrError(`Unsupported workflow seam: ${String(seam)}`);
}

/**
 * Prompt/script handler: seam-configured nodes delegate to the legacy seam;
 * custom nodes run through the injected custom-node runner.
 */
export function createPromptLikeHandler(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): WorkflowNodeHandler {
  return async (node, context) => {
    const seam = resolveSeamName(node);
    if (seam === "step-execute") {
      // Step-inversion (U3): step-execute resolves the active foreach instance
      // from the reserved context key and runs exactly that step. The active
      // context is set by the executor's foreach sub-walk on instance entry.
      const active = context.context[FOREACH_ACTIVE_CONTEXT_KEY] as
        | ForeachActiveContext
        | undefined;
      if (!active || typeof active.stepIndex !== "number") {
        throw new WorkflowIrError(
          `step-execute node '${node.id}' reached without an active foreach instance context`,
        );
      }
      if (!seams.stepExecute) {
        // Fail closed: a step-execute node with no seam wired must NOT silently
        // succeed — that would merge a task with no step work done.
        return { outcome: "failure", value: "step-execute-unwired" };
      }
      // Column-agent seam wiring (U4, R4): the GOVERNING node for a step-execute
      // session is the foreach INSTANCE node id, so the core resolver can map it
      // through template inheritance to the enclosing foreach's bound column (or
      // the template node's own column when it declares one). The template node id
      // is THIS node's id; the foreach node id + step index come from the active
      // instance context. Stamped so the seam threads it into the session build.
      context.context[SEAM_GOVERNING_NODE_CONTEXT_KEY] = instanceNodeId(
        active.foreachNodeId,
        active.stepIndex,
        node.id,
      );
      /*
       * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
       * Step-execute nodes carry per-node reasoning effort through workflow context so the implementation session can resolve node/step > task > settings precedence.
       */
      if (typeof node.config?.thinkingLevel === "string") {
        context.context[SEAM_THINKING_LEVEL_CONTEXT_KEY] = node.config.thinkingLevel;
      } else {
        delete context.context[SEAM_THINKING_LEVEL_CONTEXT_KEY];
      }
      return seams.stepExecute(context.task, context.context);
    }
    if (seam) {
      // Column-agent seam wiring (U4, R4): for the execute seam the governing node
      // IS the seam node, so its declared column drives the binding. (Other seams
      // — planning/review/merge/schedule — stamp it too; only execute reads it.)
      context.context[SEAM_GOVERNING_NODE_CONTEXT_KEY] = node.id;
      if (typeof node.config?.thinkingLevel === "string") {
        context.context[SEAM_THINKING_LEVEL_CONTEXT_KEY] = node.config.thinkingLevel;
      } else {
        delete context.context[SEAM_THINKING_LEVEL_CONTEXT_KEY];
      }
      return seams[seam]!(context.task, context.context);
    }
    if (!runCustomNode) {
      throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
    }
    return runCustomNode(node, context.task, context.context);
  };
}

export function createPrimitivePromptLikeHandler(
  primitives: WorkflowRuntimePrimitives,
  runCustomNode?: WorkflowCustomNodeRunner,
): WorkflowNodeHandler {
  return async (node, context) => {
    const seam = resolveSeamName(node);
    if (seam === "step-execute") {
      const active = context.context[FOREACH_ACTIVE_CONTEXT_KEY] as
        | ForeachActiveContext
        | undefined;
      if (!active || typeof active.stepIndex !== "number") {
        throw new WorkflowIrError(
          `step-execute node '${node.id}' reached without an active foreach instance context`,
        );
      }
      context.context[SEAM_GOVERNING_NODE_CONTEXT_KEY] = instanceNodeId(
        active.foreachNodeId,
        active.stepIndex,
        node.id,
      );
      const result = await primitives.runTaskStep(
        primitiveContextForNode(node, context.task, context.context, undefined, context.signal),
        context.task,
        active.stepIndex,
      );
      active.baselineSha = result.baselineSha;
      active.checkpointId = result.checkpointId;
      return {
        outcome: result.outcome,
        value: result.outcome === "success" ? "step-done" : "step-failed",
        contextPatch: {
          [FOREACH_ACTIVE_CONTEXT_KEY]: active,
        },
      };
    }
    if (seam) {
      context.context[SEAM_GOVERNING_NODE_CONTEXT_KEY] = node.id;
      const primitiveCtx = primitiveContextForNode(node, context.task, context.context, undefined, context.signal);
      if (seam === "planning") {
        const result = await primitives.runPlanningSession(primitiveCtx, context.task);
        return { outcome: result.outcome, value: result.value, contextPatch: result.contextPatch };
      }
      if (seam === "execute") {
        const prepared = await primitives.prepareWorktree(primitiveCtx, context.task);
        if (prepared.outcome !== "success" || !prepared.data) {
          return {
            outcome: prepared.outcome === "success" ? "failure" : prepared.outcome,
            value: prepared.value ?? "prepare-worktree-failed",
            contextPatch: prepared.contextPatch,
          };
        }
        const result = await primitives.runCodingSession(primitiveCtx, context.task, prepared.data);
        const sessionPatch: Record<string, unknown> = {};
        if (result.data?.modifiedFiles && result.data.modifiedFiles.length > 0) {
          sessionPatch.modifiedFiles = result.data.modifiedFiles;
        } else if (prepared.data.modifiedFiles && prepared.data.modifiedFiles.length > 0) {
          sessionPatch.modifiedFiles = prepared.data.modifiedFiles;
        }
        if (result.data?.summary) {
          sessionPatch.summary = result.data.summary;
        }
        const contextPatch = prepared.contextPatch || result.contextPatch || Object.keys(sessionPatch).length > 0
          ? {
              ...(prepared.contextPatch ?? {}),
              ...(result.contextPatch ?? {}),
              ...sessionPatch,
            }
          : undefined;
        return {
          outcome: result.outcome,
          value: result.value,
          contextPatch: {
            ...(contextPatch ?? {}),
            "workflow:worktree-path": prepared.data.worktreePath,
          },
        };
      }
      if (seam === "review") {
        const result = await primitives.runReview(primitiveCtx, context.task, { type: "code" });
        return { outcome: result.outcome, value: result.value, contextPatch: result.contextPatch };
      }
      if (seam === "review-handoff") {
        const result = await primitives.transitionTask(primitiveCtx, context.task, {
          column: "in-review",
          status: null,
          reason: "workflow-review-handoff",
          preserveProgress: true,
        });
        return { outcome: result.outcome, value: result.value, contextPatch: result.contextPatch };
      }
      if (seam === "merge") {
        const result = await primitives.requestMerge(primitiveCtx, context.task);
        return { outcome: result.outcome, value: result.value, contextPatch: result.contextPatch };
      }
      if (seam === "schedule") {
        const result = await primitives.transitionTask(primitiveCtx, context.task, {
          reason: "workflow-schedule",
          preserveProgress: true,
        });
        return { outcome: result.outcome, value: result.value, contextPatch: result.contextPatch };
      }
    }
    if (!runCustomNode) {
      throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
    }
    return runCustomNode(node, context.task, context.context);
  };
}

/** Per-step-review-node cap on UNAVAILABLE retries before routing the
 *  `outcome:unavailable` edge (KTD-4 — mirrors the in-session
 *  `planSpecUnavailableCounts` limiter posture, executor.ts ~7297). */
const STEP_REVIEW_UNAVAILABLE_RETRY_CAP = 2;

/** Resolve a step-review node's config (KTD-4). Defaults `type` to `code` (the
 *  enforcing review level — matches the legacy code-review authority). */
function resolveStepReviewConfig(node: WorkflowIrNode, advisory: boolean): StepReviewConfig {
  const raw = (node.config ?? {}) as { type?: unknown; model?: unknown; thinkingLevel?: unknown };
  const type = raw.type === "plan" ? "plan" : "code";
  const model = typeof raw.model === "string" ? raw.model : undefined;
  /*
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * step-review nodes persist their own `config.thinkingLevel` (WorkflowNodeEditor); without
   * reading it here the executor.ts seam's node-level-override precedence was dead code — the
   * config object it receives never carried the node's pinned reasoning effort.
   */
  const thinkingLevel = typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : undefined;
  return { type, model, thinkingLevel, advisory };
}

/**
 * Handler for the `step-review` node kind (KTD-4, U5). Resolves the active
 * foreach instance from {@link FOREACH_ACTIVE_CONTEXT_KEY}, detects the
 * single-writer/advisory posture from {@link SPLIT_ACTIVE_CONTEXT_KEY}, delegates
 * the actual review to `seams.stepReview` (which calls `reviewStep` under the
 * semaphore and — on an authoritative APPROVE — marks the step done through the
 * projection), and maps the verdict to the outcome value the
 * `outcome:approve|revise|rethink|unavailable` edges route on:
 *
 *   - APPROVE     → `value: "approve"`  (seam already marked the step done)
 *   - REVISE      → `value: "revise"`   (rework edge, no reset — revise in place)
 *   - RETHINK     → `value: "rethink"`  (rework edge whose traversal resets, U5 foreach)
 *   - UNAVAILABLE → bounded retry (cap {@link STEP_REVIEW_UNAVAILABLE_RETRY_CAP});
 *                   still unavailable → `value: "unavailable"`
 *
 * The verdict + reworkCount are persisted via the foreach sub-walk: the handler
 * writes the latest verdict back onto the active context so the sub-walk's
 * `saveInstanceState` carries it into the instance row (KTD-6).
 */
export function createStepReviewHandler(seams: WorkflowLegacySeams): WorkflowNodeHandler {
  return async (node, ctx) => {
    const active = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
    if (!active || typeof active.stepIndex !== "number") {
      throw new WorkflowIrError(
        `step-review node '${node.id}' reached without an active foreach instance context`,
      );
    }
    if (!seams.stepReview) {
      // Fail closed: a step-review node with no seam wired must NOT silently pass
      // — that would let an unreviewed step route forward (mirrors step-execute).
      return { outcome: "failure", value: "step-review-unwired" };
    }

    const advisory = ctx.context[SPLIT_ACTIVE_CONTEXT_KEY] === true;
    const config = resolveStepReviewConfig(node, advisory);

    // UNAVAILABLE bounded retry (KTD-4): re-invoke the reviewer up to the cap,
    // mirroring the in-session planSpecUnavailableCounts limiter. A usable verdict
    // short-circuits; exhaustion routes outcome:unavailable.
    let result: StepReviewSeamResult = { verdict: "UNAVAILABLE" };
    for (let attempt = 0; attempt <= STEP_REVIEW_UNAVAILABLE_RETRY_CAP; attempt++) {
      result = await seams.stepReview(ctx.task, ctx.context, config);
      if (result.verdict !== "UNAVAILABLE") break;
    }

    // Persist the verdict onto the active context so the foreach sub-walk writes
    // it into the instance row (KTD-6). Advisory (split-branch) reviews record the
    // verdict for audit but never become the authoritative instance verdict.
    if (!advisory) {
      active.verdict = result.verdict;
    }
    const patch: Record<string, unknown> = {
      [FOREACH_ACTIVE_CONTEXT_KEY]: active,
      [`node:${node.id}:verdict`]: result.verdict,
    };

    const value =
      result.verdict === "APPROVE"
        ? "approve"
        : result.verdict === "REVISE"
        ? "revise"
        : result.verdict === "RETHINK"
        ? "rethink"
        : "unavailable";

    return { outcome: "success", value, contextPatch: patch };
  };
}

export function createPrimitiveStepReviewHandler(primitives: WorkflowRuntimePrimitives): WorkflowNodeHandler {
  return async (node, ctx) => {
    const active = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
    if (!active || typeof active.stepIndex !== "number") {
      throw new WorkflowIrError(
        `step-review node '${node.id}' reached without an active foreach instance context`,
      );
    }

    const advisory = ctx.context[SPLIT_ACTIVE_CONTEXT_KEY] === true;
    const config = resolveStepReviewConfig(node, advisory);
    let result: StepReviewSeamResult = {
      verdict: "UNAVAILABLE",
    };
    let primitivePatch: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt <= STEP_REVIEW_UNAVAILABLE_RETRY_CAP; attempt++) {
      const primitiveResult = await primitives.runReview(
        primitiveContextForNode(node, ctx.task, ctx.context, attempt + 1, ctx.signal),
        ctx.task,
        {
          type: config.type,
          stepIndex: active.stepIndex,
          baselineSha: config.type === "code" ? active.baselineSha : undefined,
        },
      );
      if (primitiveResult.outcome !== "success") {
        return {
          outcome: primitiveResult.outcome,
          value: primitiveResult.value,
          contextPatch: primitiveResult.contextPatch,
        };
      }
      primitivePatch = primitiveResult.contextPatch;
      result = primitiveResult.data ?? { verdict: "UNAVAILABLE" as const };
      if (result.verdict !== "UNAVAILABLE") break;
    }

    if (!advisory) {
      active.verdict = result.verdict;
    }
    const patch: Record<string, unknown> = {
      ...(primitivePatch ?? {}),
      [FOREACH_ACTIVE_CONTEXT_KEY]: active,
      [`node:${node.id}:verdict`]: result.verdict,
    };

    const value =
      result.verdict === "APPROVE"
        ? "approve"
        : result.verdict === "REVISE"
        ? "revise"
        : result.verdict === "RETHINK"
        ? "rethink"
        : "unavailable";

    return { outcome: "success", value, contextPatch: patch };
  };
}

export interface DefaultNodeHandlerDeps {
  /** Workflow-native runtime primitives. When present they replace legacy seams. */
  primitives?: WorkflowRuntimePrimitives;
  /** parse-steps node deps (U12). When absent, a parse-steps node fails cleanly. */
  parseSteps?: ParseStepsHandlerDeps;
  /** code node runner (U14). When absent, a code node fails cleanly. */
  runCode?: CodeNodeRunner;
  /** notify node dispatch callback. When absent, notify nodes succeed with notify-skipped. */
  notifyDispatch?: WorkflowNotifyDispatch;
  /** PR node deps (U3). When absent, the three pr-* kinds fail cleanly. */
  prNodes?: PrNodeDeps;
}

export function createDefaultNodeHandlers(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
  deps?: DefaultNodeHandlerDeps,
): Record<
  | "prompt"
  | "script"
  | "gate"
  | "step-review"
  | "parse-steps"
  | "code"
  | "notify"
  | "merge-gate"
  | "merge-attempt"
  | "manual-merge-hold"
  | "retry-backoff"
  | "recovery-router"
  | "branch-group-member-integration"
  | "branch-group-promotion"
  | "pr-create"
  | "pr-respond"
  | "pr-merge"
  | "ask-user"
  | "exit-gate",
  WorkflowNodeHandler
> {
  const promptLike = deps?.primitives
    ? createPrimitivePromptLikeHandler(deps.primitives, runCustomNode)
    : createPromptLikeHandler(seams, runCustomNode);
  // parse-steps without deps fails closed (would otherwise have no handler at
  // all and throw "No handler registered"); a clean failure is the safe posture.
  const parseSteps: WorkflowNodeHandler = deps?.parseSteps
    ? createParseStepsHandler(deps.parseSteps)
    : async () => ({ outcome: "failure", value: "parse-steps-unwired" });
  // PR nodes without deps fail closed (mirrors parse-steps): a pr-* node reached
  // without GitHub wiring must NOT silently succeed — it would route an
  // unverified PR side effect forward.
  const prNodes: Record<"pr-create" | "pr-respond" | "pr-merge", WorkflowNodeHandler> = deps?.prNodes
    ? createPrNodeHandlers(deps.prNodes)
    : {
        "pr-create": async () => ({ outcome: "failure", value: "pr-nodes-unwired" }),
        "pr-respond": async () => ({ outcome: "failure", value: "pr-nodes-unwired" }),
        "pr-merge": async () => ({ outcome: "failure", value: "pr-nodes-unwired" }),
      };
  // Auto-merge gate (U6): a `gate` node carrying `config.gate === "auto-merge"`
  // routes on live PR-entity state (outcome:auto-on/auto-off) instead of the
  // generic context/executable gate. Wired only when PR deps are present; absent
  // them it falls back to the generic gate (fail-closed, no silent auto-merge).
  const genericGate = createGateHandler(runCustomNode);
  const autoMergeGate = deps?.prNodes ? createAutoMergeGateHandler(deps.prNodes) : undefined;
  const gate: WorkflowNodeHandler = autoMergeGate
    ? (node, ctx) =>
        node.config?.gate === "auto-merge" ? autoMergeGate(node, ctx) : genericGate(node, ctx)
    : genericGate;
  return {
    prompt: promptLike,
    script: promptLike,
    // FNXC:WorkflowAskUser 2026-07-05-00:00: `ask-user` is a first-class node
    // kind over the SAME custom-node seam as prompt/script — it carries no
    // seam config, so it always falls through to the injected custom-node
    // runner (runGraphCustomNode in executor.ts), which special-cases
    // `node.kind === "ask-user"` onto the existing await-input park/resume path.
    "ask-user": promptLike,
    // FNXC:WorkflowExitGate 2026-07-05-00:00: dedicated small runner (mirrors
    // notify-runner's shape) — no legacy seam, no custom-node execution.
    "exit-gate": createExitGateHandler(),
    gate,
    "step-review": deps?.primitives
      ? createPrimitiveStepReviewHandler(deps.primitives)
      : createStepReviewHandler(seams),
    "parse-steps": parseSteps,
    code: createCodeNodeHandler(deps?.runCode),
    notify: createNotifyHandler(deps?.notifyDispatch),
    "merge-gate": createMergeGateHandler(),
    "merge-attempt": createMergeAttemptHandler({
      primitives: deps?.primitives,
      seams,
      buildPrimitiveContext: (node, ctx, attempt) =>
        primitiveContextForNode(node, ctx.task, ctx.context, attempt, ctx.signal),
    }),
    "manual-merge-hold": async () => ({ outcome: "failure", value: "manual-required" }),
    "retry-backoff": async () => ({ outcome: "success" }),
    "recovery-router": async (_node, ctx) => ({
      outcome: "success",
      value: typeof ctx.context.recoveryOutcome === "string" ? ctx.context.recoveryOutcome : "wake-merge",
    }),
    "branch-group-member-integration": async () => ({ outcome: "success" }),
    "branch-group-promotion": async () => ({ outcome: "success" }),
    ...prNodes,
  };
}

/** Back-compat export: the original context-only gate handler. */
export const gateNodeHandler: WorkflowNodeHandler = createGateHandler();

export function createNoopLegacySeams(): WorkflowLegacySeams {
  const success = async (): Promise<WorkflowNodeResult> => ({ outcome: "success" });
  return {
    planning: success,
    execute: success,
    // U4 (KTD-2): no `workflow-step` seam — workflow gates run as graph nodes.
    review: success,
    "review-handoff": success,
    merge: success,
    schedule: success,
  };
}
