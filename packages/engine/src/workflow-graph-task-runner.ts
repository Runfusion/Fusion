import type { Settings, TaskDetail, WorkflowDefinition, WorkflowStepResult } from "@fusion/core";
import { getBuiltinWorkflow, isBuiltinWorkflowId } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeOutcome, type WorkflowTaskProjection } from "./workflow-graph-executor.js";
import type {
  CodeNodeRunner,
  ForeachActiveContext,
  ParseStepsHandlerDeps,
  WorkflowNotifyDispatch,
  WorkflowCustomNodeRunner,
  WorkflowLegacySeams,
} from "./workflow-node-handlers.js";
import type {
  WorkflowBranchPersistence,
  WorkflowBranchProgress,
  WorkflowBranchSemaphore,
} from "./workflow-graph-branches.js";
import type { ForeachEnvironment, WorkflowStepInstancePersistence } from "./workflow-graph-foreach.js";
import type { PrNodeDeps } from "./pr-nodes.js";
import type { WorkflowPrimitiveContext, WorkflowRuntimePrimitives } from "./runtime-primitives.js";
// (Both types are also used as values in the side-effect tracking wrappers below.)

/**
 * Terminal disposition of an interpreter-driven task run.
 * - "completed"  — the graph ran to its end node successfully.
 * - "failed"     — the graph ran and terminated on a failure outcome.
 * - "fell-back"  — the interpreter did not (or could not) own this task;
 *                  the caller must run the legacy pipeline instead.
 */
export type WorkflowGraphRunDisposition = "completed" | "failed" | "fell-back";

export interface WorkflowGraphTaskRunResult {
  disposition: WorkflowGraphRunDisposition;
  outcome?: WorkflowNodeOutcome;
  visitedNodeIds: string[];
  /** Why the runner fell back (flag-off, no-selection, workflow-missing, interpreter-error). */
  reason?: string;
  /** Shared graph context after the run (node outcomes/values). */
  context?: Record<string, unknown>;
}

/** The minimal store surface the runner needs — keeps tests fake-friendly. */
export interface WorkflowGraphRunnerStore {
  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined;
  getWorkflowDefinition(id: string): Promise<WorkflowDefinition | undefined>;
}

export interface WorkflowGraphTaskRunnerDeps {
  store: WorkflowGraphRunnerStore;
  seams: WorkflowLegacySeams;
  primitives?: WorkflowRuntimePrimitives;
  runCustomNode: WorkflowCustomNodeRunner;
  maxRetriesPerNode?: number;
  /** Optional diagnostics hook (audit/log emission). Never throws into the run. */
  onEvent?: (event: { type: "start" | "terminal" | "fallback"; taskId: string; detail: string }) => void;
  /** Per-branch run-state persistence + resume (U13). Additive; in-memory without it. */
  branchPersistence?: WorkflowBranchPersistence;
  /** Bounds concurrent branch-node execution (U13); omit when the semaphore is
   *  enforced beneath runCustomNode at the session layer. */
  branchSemaphore?: WorkflowBranchSemaphore;
  /** Live per-branch progress for dashboard badges (U9/U13). */
  onBranchProgress?: (progress: WorkflowBranchProgress) => void;
  /** Step-inversion (KTD-6, U3/U4): per-instance run-state persistence for
   *  foreach instances. Additive; in-memory without it. */
  stepInstancePersistence?: WorkflowStepInstancePersistence;
  /** Step-inversion (KTD-4, U5): RETHINK reset-on-rework hook — invoked before
   *  re-entering step-execute when a rework edge was triggered by an
   *  `outcome:rethink`. Wired to `resetStepToBaseline` in production. */
  onReworkReset?: (active: ForeachActiveContext, reason: string) => void | Promise<void>;
  /** Step-inversion (U12, KTD-12): `parse-steps` node handler deps. Additive;
   *  a workflow with no parse-steps node never invokes it. */
  parseStepsDeps?: ParseStepsHandlerDeps;
  /** Step-inversion (U14, KTD-15): `code` node runner. Additive; a workflow with
   *  no code node never invokes it. */
  runCode?: CodeNodeRunner;
  /** notify node dispatch callback. Additive; absent → notify nodes are skipped. */
  notifyDispatch?: WorkflowNotifyDispatch;
  /** PR-entity nodes (U3): deps for `pr-create`/`pr-respond`/`pr-merge`. Additive;
   *  a workflow with no pr-* node never invokes them; absent → they fail closed. */
  prNodes?: PrNodeDeps;
  /** Step-inversion (KTD-11, U10): worktree-isolation + parallel-scheduling deps.
   *  Additive; a shared-isolation foreach never invokes them. */
  allocateInstanceWorktree?: ForeachEnvironment["allocateInstanceWorktree"];
  resolveIntegrationBase?: ForeachEnvironment["resolveIntegrationBase"];
  integrationGitOps?: ForeachEnvironment["integrationGitOps"];
  integrationProjection?: ForeachEnvironment["integrationProjection"];
  semaphoreAvailability?: ForeachEnvironment["semaphoreAvailability"];
  resumeReconcile?: ForeachEnvironment["resumeReconcile"];
  /** FIX 4 (context gap): task-level log sink for integration-conflict rework. */
  logTaskEntry?: ForeachEnvironment["logTaskEntry"];
  /** Plan U2 (KTD-1/KTD-2): fail-soft sink that upserts an enabled optional-group
   *  node's outcome into `task.workflowStepResults` keyed by node id. Additive;
   *  absent → graph records nothing (disabled groups + unwired stores byte-inert). */
  recordWorkflowStepResult?: (taskId: string, result: WorkflowStepResult) => void | Promise<void>;
  /** Project node-published task metadata onto the task row for dispatcher/UI. */
  publishTaskProjection?: (taskId: string, patch: WorkflowTaskProjection, source: { nodeId: string; nodeKind: string }) => void | Promise<void>;
  /** @deprecated use publishTaskProjection. */
  publishTouchedFiles?: (taskId: string, files: string[], source: { nodeId: string; nodeKind: string }) => void | Promise<void>;
  /**
   * Step-inversion (KTD-6): the production run id, threaded from the caller so it
   * is the SINGLE source of truth shared with the executor-side persistence deps
   * (`buildParseStepsDeps` / `buildForeachWorktreeDeps` probe and flip rows under
   * the SAME id). When omitted the runner derives `${task.id}:${definition.id}` —
   * the same formula — so a caller that does not thread it keeps prior behavior.
   */
  runId?: string;
}

/**
 * Drives a task's lifecycle from its selected workflow graph. The runner owns
 * SEQUENCING only — seam nodes delegate to the legacy engine implementations
 * (execute/review/merge), custom nodes run via the injected runner. Any
 * interpreter-level error yields a "fell-back" disposition so the caller can
 * run the legacy pipeline; a task is never stranded by interpreter bugs.
 */
export class WorkflowGraphTaskRunner {
  /** Latest per-branch progress, keyed by branchId. Store/dashboard-readable
   *  (U9 badges). Reset at the start of each run; the card never moves during a
   *  parallel window (KTD-11) so this is purely presentational state. */
  private readonly branchProgress = new Map<string, WorkflowBranchProgress>();

  public constructor(private readonly deps: WorkflowGraphTaskRunnerDeps) {}

  /** Snapshot of current per-branch progress (branchId, nodeId, status). */
  public getBranchProgress(): WorkflowBranchProgress[] {
    return [...this.branchProgress.values()];
  }

  private emit(type: "start" | "terminal" | "fallback", taskId: string, detail: string): void {
    try {
      this.deps.onEvent?.({ type, taskId, detail });
    } catch {
      // Diagnostics must never affect the run.
    }
  }

  private fallBack(taskId: string, reason: string): WorkflowGraphTaskRunResult {
    this.emit("fallback", taskId, reason);
    return { disposition: "fell-back", reason, visitedNodeIds: [] };
  }

  public async run(
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
  ): Promise<WorkflowGraphTaskRunResult> {
    let selection: { workflowId: string; stepIds: string[] } | undefined;
    try {
      selection = this.deps.store.getTaskWorkflowSelection(task.id);
    } catch (err) {
      return this.fallBack(task.id, `selection-error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!selection) {
      return this.fallBack(task.id, "no-selection");
    }

    let definition: WorkflowDefinition | undefined;
    try {
      definition = isBuiltinWorkflowId(selection.workflowId)
        ? getBuiltinWorkflow(selection.workflowId)
        : await this.deps.store.getWorkflowDefinition(selection.workflowId);
    } catch (err) {
      return this.fallBack(task.id, `workflow-load-error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!definition) {
      return this.fallBack(task.id, `workflow-missing: ${selection.workflowId}`);
    }

    this.emit("start", task.id, definition.id);
    this.branchProgress.clear();

    // Track whether any node side effects ran. A pre-run interpreter error
    // (bad IR structure, wiring) can safely fall back to the legacy pipeline;
    // a mid-run error cannot — re-running legacy would repeat the implementation
    // session — so it terminates as "failed" for the caller to park instead.
    let sideEffectsRan = false;
    const invoked: string[] = [];
    const seams = this.deps.seams;
    const wrappedSeams: WorkflowLegacySeams = {
      planning: (t, c) => ((sideEffectsRan = true), invoked.push("planning"), seams.planning(t, c)),
      execute: (t, c) => ((sideEffectsRan = true), invoked.push("execute"), seams.execute(t, c)),
      workflowStep: (t, c) => {
        sideEffectsRan = true;
        invoked.push("workflow-step");
        return seams.workflowStep?.(t, c) ?? Promise.resolve({ outcome: "success", value: "workflow-step-skipped" });
      },
      review: (t, c) => ((sideEffectsRan = true), invoked.push("review"), seams.review(t, c)),
      merge: (t, c) => ((sideEffectsRan = true), invoked.push("merge"), seams.merge(t, c)),
      schedule: (t, c) => ((sideEffectsRan = true), invoked.push("schedule"), seams.schedule(t, c)),
      // Step-inversion seams (U3/U5) — forwarded only when wired so a workflow
      // without foreach/step-review keeps the omitted-optional posture.
      ...(seams.stepExecute
        ? { stepExecute: (t, c) => ((sideEffectsRan = true), invoked.push("step-execute"), seams.stepExecute!(t, c)) }
        : {}),
      ...(seams.stepReview
        ? { stepReview: (t, c, cfg) => ((sideEffectsRan = true), invoked.push("step-review"), seams.stepReview!(t, c, cfg)) }
        : {}),
    };
    const wrappedRunCustomNode: WorkflowCustomNodeRunner = (node, t, c) => {
      sideEffectsRan = true;
      invoked.push(node.id);
      return this.deps.runCustomNode(node, t, c);
    };
    const wrappedPrimitives = this.deps.primitives
      ? new Proxy(this.deps.primitives, {
          get: (target, prop, receiver) => {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              sideEffectsRan = true;
              const ctx = args[0] as WorkflowPrimitiveContext | undefined;
              invoked.push(ctx?.node?.node?.id ?? String(prop));
              return value.apply(target, args);
            };
          },
        }) as WorkflowRuntimePrimitives
      : undefined;

    try {
      const executor = new WorkflowGraphExecutor({
        seams: wrappedSeams,
        primitives: wrappedPrimitives,
        runCustomNode: wrappedRunCustomNode,
        maxRetriesPerNode: this.deps.maxRetriesPerNode,
        branchPersistence: this.deps.branchPersistence,
        branchSemaphore: this.deps.branchSemaphore,
        stepInstancePersistence: this.deps.stepInstancePersistence,
        onReworkReset: this.deps.onReworkReset,
        parseStepsDeps: this.deps.parseStepsDeps,
        runCode: this.deps.runCode,
        notifyDispatch: this.deps.notifyDispatch,
        prNodes: this.deps.prNodes,
        // Step-inversion (KTD-11, U10): worktree isolation + parallel scheduling.
        allocateInstanceWorktree: this.deps.allocateInstanceWorktree,
        resolveIntegrationBase: this.deps.resolveIntegrationBase,
        integrationGitOps: this.deps.integrationGitOps,
        integrationProjection: this.deps.integrationProjection,
        semaphoreAvailability: this.deps.semaphoreAvailability,
        resumeReconcile: this.deps.resumeReconcile,
        logTaskEntry: this.deps.logTaskEntry,
        recordWorkflowStepResult: this.deps.recordWorkflowStepResult,
        publishTaskProjection: this.deps.publishTaskProjection,
        publishTouchedFiles: this.deps.publishTouchedFiles,
        // Single source of truth (KTD-6): prefer the caller-threaded run id so the
        // executor's persistence deps probe/flip rows under the SAME id; fall back
        // to the canonical derivation when unthreaded.
        runId: this.deps.runId ?? `${task.id}:${definition.id}`,
        onBranchProgress: (progress) => {
          this.branchProgress.set(progress.branchId, progress);
          try {
            this.deps.onBranchProgress?.(progress);
          } catch {
            // Progress reporting must never affect the run.
          }
        },
      });
      const result = await executor.run(task, settings, definition.ir);
      if (!result.executed) {
        return this.fallBack(task.id, "not-executed");
      }
      const disposition: WorkflowGraphRunDisposition = result.outcome === "success" ? "completed" : "failed";
      this.emit("terminal", task.id, `${definition.id}:${disposition}`);
      return {
        disposition,
        outcome: result.outcome,
        visitedNodeIds: result.visitedNodeIds,
        context: result.context,
      };
    } catch (err) {
      const reason = `interpreter-error: ${err instanceof Error ? err.message : String(err)}`;
      if (sideEffectsRan) {
        // Too late to fall back — the caller parks the task for human review.
        this.emit("terminal", task.id, `${definition.id}:failed (${reason})`);
        return { disposition: "failed", outcome: "failure", reason, visitedNodeIds: invoked };
      }
      this.emit("fallback", task.id, reason);
      return { disposition: "fell-back", reason, visitedNodeIds: invoked };
    }
  }
}
