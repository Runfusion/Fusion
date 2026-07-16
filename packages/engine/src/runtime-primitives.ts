import type { TaskDetail, TaskStep, WorkflowIrNode } from "@fusion/core";

import type { PrMergeCallResult } from "./pr-nodes.js";
import type { RunTaskStepResult, ResetStepResult } from "./step-runner.js";
import type { WorkflowNodeOutcome } from "./workflow-graph-executor.js";

export type RuntimePrimitiveName =
  | "prepare-worktree"
  | "read-artifact"
  | "write-artifact"
  | "planning-session"
  | "coding-session"
  | "step-session"
  | "reset-step"
  | "review"
  | "verification"
  | "transition"
  | "merge"
  | "abort"
  | "audit";

export interface WorkflowRuntimeRunContext {
  runId: string;
  taskId: string;
  workflowId: string;
  /** True after any primitive with task/git/session side effects starts. */
  sideEffectsStarted?: boolean;
  recoveryEventId?: string;
}

export interface WorkflowRuntimeNodeContext {
  node: Pick<WorkflowIrNode, "id" | "kind" | "column" | "config">;
  effectivePrincipalId?: string;
  attempt?: number;
  context?: Record<string, unknown>;
}

export interface WorkflowPrimitiveContext {
  run: WorkflowRuntimeRunContext;
  node: WorkflowRuntimeNodeContext;
  /*
  FNXC:WorkflowCancellation 2026-07-15-10:42:
  Graph cancellation must reach long-running primitives, not just node handlers. Before this existed, a hard-cancel (user cancel, engine restart, pause/resume) aborted the graph controller but the in-flight `merge` primitive never saw it: it raced the merge only against its own 30-minute timeout, so the walk sat inside the merge node for the full timeout before discovering it had been cancelled half an hour earlier. The timeout's abort then killed the still-running AI merge mid-flight ("Manual-merge failed: Request was aborted"), which could land between merger-ai's `worktree: null` write and `mergeConfirmed`, stranding the card as `no-worktree-no-merge-confirmed`.

  Mirrors `WorkflowNodeExecutionContext.signal` (workflow-graph-executor.ts) and is threaded by `primitiveContextForNode`. Undefined on the sequential/uncancellable path. A primitive that can block on I/O for more than a few seconds MUST honor it — link it into any local timeout controller via `AbortSignal.any` rather than replacing it, so both cancellation and the timeout stay live.
  */
  signal?: AbortSignal;
}

export interface RuntimePrimitiveResult<TValue = unknown> {
  outcome: WorkflowNodeOutcome;
  value?: string;
  data?: TValue;
  contextPatch?: Record<string, unknown>;
}

export interface PreparedWorktree {
  worktreePath: string;
  branchName?: string;
  baseCommitSha?: string;
  modifiedFiles?: string[];
}

export interface PlanningSessionResult {
  approved: boolean;
  artifactKeys: string[];
  createdTaskIds?: string[];
  feedback?: string;
}

export interface CodingSessionResult {
  taskDone: boolean;
  modifiedFiles: string[];
  summary?: string;
}

export interface ReviewPrimitiveResult {
  verdict: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  review?: string;
  summary?: string;
}

export interface VerificationPrimitiveResult {
  verdict: "approve" | "revise" | "failed" | "advisory-failed" | "skipped";
  feedback?: string;
  stepName?: string;
}

// FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) — the `runWorkflowStep`
// primitive and its `WorkflowStepPrimitiveInput`/`WorkflowStepPrimitiveResult`
// shapes were removed. Workflow quality gates run as the graph's own
// optional-group / gate nodes which record into `task.workflowStepResults` (U2);
// there is no dedicated workflow-step runtime primitive.

export interface TransitionPrimitiveInput {
  column?: string;
  status?: string | null;
  reason: string;
  preserveProgress?: boolean;
}

export interface MergePrimitiveInput {
  expectedHeadOid?: string;
  manualAllowed?: boolean;
}

export type MergePrimitiveResult =
  | { status: "merged"; noOp?: boolean }
  | { status: "manual-required"; reason?: string }
  | { status: "failed"; reason: string }
  | { status: "timeout" }
  | PrMergeCallResult;

export interface AbortPrimitiveInput {
  reason: string;
  hardCancel?: boolean;
}

export interface AuditPrimitiveInput {
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRuntimePrimitives {
  prepareWorktree(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
  ): Promise<RuntimePrimitiveResult<PreparedWorktree>>;

  readArtifact(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    key: string,
  ): Promise<string | undefined>;

  writeArtifact(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    key: string,
    content: string,
  ): Promise<RuntimePrimitiveResult<{ key: string }>>;

  runPlanningSession(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
  ): Promise<RuntimePrimitiveResult<PlanningSessionResult>>;

  runCodingSession(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    prepared: PreparedWorktree,
  ): Promise<RuntimePrimitiveResult<CodingSessionResult>>;

  runTaskStep(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    stepIndex: number,
  ): Promise<RunTaskStepResult>;

  resetTaskStep(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    stepIndex: number,
    baselineSha?: string,
    checkpointId?: string,
  ): Promise<ResetStepResult>;

  runReview(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input: { type: "plan" | "code"; stepIndex?: number; baselineSha?: string },
  ): Promise<RuntimePrimitiveResult<ReviewPrimitiveResult>>;

  runVerification(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    prepared: PreparedWorktree,
  ): Promise<RuntimePrimitiveResult<VerificationPrimitiveResult>>;

  updateSteps(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    steps: TaskStep[],
  ): Promise<RuntimePrimitiveResult<{ count: number }>>;

  transitionTask(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input: TransitionPrimitiveInput,
  ): Promise<RuntimePrimitiveResult>;

  requestMerge(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input?: MergePrimitiveInput,
  ): Promise<RuntimePrimitiveResult<MergePrimitiveResult>>;

  abortRun(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input: AbortPrimitiveInput,
  ): Promise<RuntimePrimitiveResult>;

  audit(ctx: WorkflowPrimitiveContext, input: AuditPrimitiveInput): Promise<void> | void;
}

export function markSideEffectsStarted(ctx: WorkflowPrimitiveContext): WorkflowPrimitiveContext {
  return {
    ...ctx,
    run: {
      ...ctx.run,
      sideEffectsStarted: true,
    },
  };
}

export function primitiveNodeContext(
  run: WorkflowRuntimeRunContext,
  node: WorkflowRuntimeNodeContext["node"],
  extras: Omit<WorkflowRuntimeNodeContext, "node"> = {},
  /** FNXC:WorkflowCancellation 2026-07-15-10:42: graph cancellation signal — see {@link WorkflowPrimitiveContext.signal}. */
  signal?: AbortSignal,
): WorkflowPrimitiveContext {
  return {
    run,
    node: {
      ...extras,
      node,
    },
    signal,
  };
}

