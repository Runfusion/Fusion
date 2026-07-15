import {
  BUILTIN_CODING_WORKFLOW_IR,
  WORKFLOW_INTERPRETER_AUTHORITATIVE_FLAG,
  evaluateInterpreterCutoverReadiness,
  isExperimentalFeatureEnabled,
  type Settings,
  type Task,
  type TaskDetail,
  type WorkflowDefinition,
  type WorkflowParitySummary,
} from "@fusion/core";

import type { TaskExecutor } from "./executor.js";
import { executorLog } from "./logger.js";
import { WorkflowGraphTaskRunner, type WorkflowGraphTaskRunResult } from "./workflow-graph-task-runner.js";
import type { StepReviewSeamResult, WorkflowLegacySeams } from "./workflow-node-handlers.js";
import type { PreparedWorktree, WorkflowRuntimePrimitives } from "./runtime-primitives.js";

const AUTHORITATIVE_WORKFLOW_ID = "workflow-interpreter-authoritative";

export interface WorkflowAuthoritativeDriverStore {
  getSettings(): Promise<Settings>;
  getTask(taskId: string): Promise<TaskDetail>;
  getTaskWorkflowSelection?(taskId: string): { workflowId: string; stepIds: string[] } | undefined;
  getTaskWorkflowSelectionAsync?(taskId: string): Promise<{ workflowId: string; stepIds: string[] } | undefined>;
  getWorkflowParitySummary?(options?: { since?: string; limit?: number }): WorkflowParitySummary;
}

export interface WorkflowAuthoritativeDriverDeps {
  store: WorkflowAuthoritativeDriverStore;
  executor: Pick<TaskExecutor, "createAuthoritativeWorkflowSeams"> & Partial<Pick<TaskExecutor, "createAuthoritativeWorkflowPrimitives">>;
  minimumObservedRuns?: number;
}

export interface WorkflowAuthoritativeDriverResult {
  handled: boolean;
  disposition: "completed" | "failed" | "fell-back";
  reason?: string;
  readinessReasons: string[];
  graphResult?: WorkflowGraphTaskRunResult;
}

function buildAuthoritativeSettings(settings: Settings): Settings {
  return {
    ...settings,
    experimentalFeatures: {
      ...(settings.experimentalFeatures ?? {}),
      [WORKFLOW_INTERPRETER_AUTHORITATIVE_FLAG]: true,
    },
  };
}

function primitivesFromLegacySeams(seams: WorkflowLegacySeams): WorkflowRuntimePrimitives {
  const mapStepReviewValue = (verdict: StepReviewSeamResult["verdict"] | undefined): string => {
    switch (verdict) {
      case "APPROVE":
        return "approve";
      case "REVISE":
        return "revise";
      case "RETHINK":
        return "rethink";
      default:
        return "unavailable";
    }
  };

  // Legacy seams do not consume PreparedWorktree; filesystem/session state is
  // still owned inside the seam implementation they delegate to.
  const prepared: PreparedWorktree = { worktreePath: "" };
  return {
    prepareWorktree: async () => ({ outcome: "success", data: prepared }),
    readArtifact: async () => undefined,
    writeArtifact: async (_ctx, _task, key) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async (ctx, task) => {
      const result = await seams.planning(task, ctx.node.context ?? {});
      return { ...result, data: { approved: result.outcome === "success", artifactKeys: [] } };
    },
    runCodingSession: async (ctx, task) => {
      const result = await seams.execute(task, ctx.node.context ?? {});
      return {
        ...result,
        data: { taskDone: result.outcome === "success", modifiedFiles: [] },
      };
    },
    runTaskStep: async (ctx, task) => {
      const result = await seams.stepExecute?.(task, ctx.node.context ?? {});
      return { outcome: result?.outcome ?? "failure" };
    },
    resetTaskStep: async () => ({ ok: true }),
    runReview: async (ctx, task, input) => {
      if (typeof input.stepIndex === "number") {
        const result = await seams.stepReview?.(task, ctx.node.context ?? {}, { type: input.type });
        return {
          outcome: "success",
          value: mapStepReviewValue(result?.verdict),
          data: result ?? { verdict: "UNAVAILABLE" },
        };
      }
      const result = await seams.review(task, ctx.node.context ?? {});
      return { ...result, data: { verdict: result.outcome === "success" ? "APPROVE" : "REVISE" } };
    },
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) — the `runWorkflowStep`
    // primitive + `workflow-step` seam were removed. Workflow gates run as graph
    // optional-group / gate nodes that record into task.workflowStepResults (U2);
    // this driver no longer adapts a workflow-step seam.
    updateSteps: async (_ctx, _task, steps) => ({ outcome: "success", data: { count: steps.length } }),
    transitionTask: async (ctx, task) => seams.schedule(task, ctx.node.context ?? {}),
    requestMerge: async (ctx, task) => {
      const result = await seams.merge(task, ctx.node.context ?? {});
      return {
        ...result,
        data: result.outcome === "success"
          ? { status: "merged" as const }
          : { status: "failed" as const, reason: result.value ?? "merge-failed" },
      };
    },
    abortRun: async () => ({ outcome: "success" }),
    audit: () => undefined,
  };
}

export class WorkflowAuthoritativeDriver {
  public constructor(private readonly deps: WorkflowAuthoritativeDriverDeps) {}

  public async maybeRun(task: Task): Promise<WorkflowAuthoritativeDriverResult> {
    let settings: Settings;
    let paritySummary: WorkflowParitySummary | undefined;
    try {
      settings = await this.deps.store.getSettings();
      paritySummary = this.deps.store.getWorkflowParitySummary?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executorLog.warn(`[workflow-authoritative] ${task.id}: readiness probe failed — falling back to legacy (${message})`);
      return {
        handled: false,
        disposition: "fell-back",
        reason: `store-unavailable: ${message}`,
        readinessReasons: ["workflow parity readiness probe unavailable"],
      };
    }
    const authoritativeFlagEnabled = isExperimentalFeatureEnabled(
      settings,
      WORKFLOW_INTERPRETER_AUTHORITATIVE_FLAG,
    );
    /*
    FNXC:WorkflowInterpreterCutover 2026-06-23-21:59:
    The retired workflowInterpreterDualObserve flag must remain inert in the authoritative driver. Historical/current parity summaries from the store are the readiness evidence source; do not probe or re-enable the hidden shadow observer here.
    */
    const readiness = evaluateInterpreterCutoverReadiness({
      authoritativeFlagEnabled,
      paritySummary,
      minimumObservedRuns: this.deps.minimumObservedRuns,
    });
    if (!readiness.ready) {
      return {
        handled: false,
        disposition: "fell-back",
        reason: readiness.reasons.join("; "),
        readinessReasons: readiness.reasons,
      };
    }

    /*
    FNXC:WorkflowSelection 2026-07-14-17:06:
    The authoritative cutover guard must await PostgreSQL workflow-selection storage before deciding a task is unselected. Keep the synchronous branch only for narrow legacy/in-memory driver doubles.
    */
    const existingSelection = this.deps.store.getTaskWorkflowSelectionAsync
      ? await this.deps.store.getTaskWorkflowSelectionAsync(task.id)
      : this.deps.store.getTaskWorkflowSelection?.(task.id);
    if (existingSelection) {
      return {
        handled: false,
        disposition: "fell-back",
        reason: `workflow selection already present (${existingSelection.workflowId})`,
        readinessReasons: [],
      };
    }

    let liveTask: TaskDetail;
    try {
      liveTask = await this.deps.store.getTask(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executorLog.warn(`[workflow-authoritative] ${task.id}: failed to load live task — falling back to legacy (${message})`);
      return {
        handled: false,
        disposition: "fell-back",
        reason: `task-load-failed: ${message}`,
        readinessReasons: [],
      };
    }
    const seams = this.deps.executor.createAuthoritativeWorkflowSeams(settings);
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: AUTHORITATIVE_WORKFLOW_ID, stepIds: [] }),
        getWorkflowDefinition: async () => ({
          id: AUTHORITATIVE_WORKFLOW_ID,
          name: "Workflow interpreter authoritative cutover",
          ir: BUILTIN_CODING_WORKFLOW_IR,
        } satisfies Pick<WorkflowDefinition, "id" | "name" | "ir"> as WorkflowDefinition),
      },
      primitives: this.deps.executor.createAuthoritativeWorkflowPrimitives?.(settings) ?? primitivesFromLegacySeams(seams),
      seams,
      /*
      FNXC:WorkflowInterpreterCutover 2026-07-01-21:05:
      BUILTIN_CODING_WORKFLOW_IR graduated to carry default-on/always-on custom
      lifecycle nodes: the plan-review/code-review/browser-verification/post-merge
      optional groups (bypassed at their group node when a task disables them via
      enabledWorkflowSteps) and an ALWAYS-ON `completion-summary` prompt node
      (kind:"prompt", summaryTarget:"task") that records the pre-review summary.
      The transitional authoritative driver validates SEAM-LEVEL parity
      (planning/execute/review/merge/schedule) against the legacy executor; it does
      not reproduce custom-node side effects. Previously runCustomNode threw on any
      custom node, so the always-on completion-summary aborted every clean run
      before it could reach review→merge. Pass built-in auxiliary custom nodes
      (task-summary nodes and bypassable optional groups) through as success so the
      seam pipeline completes, mirroring the main executor's completion path for
      parity purposes. Genuinely unexpected custom nodes still fail loudly.
      */
      runCustomNode: async (node) => {
        const isBuiltinAuxiliaryNode =
          node.config?.summaryTarget === "task" || node.kind === "optional-group";
        if (isBuiltinAuxiliaryNode) {
          executorLog.log(
            `[workflow-authoritative] ${task.id}: passing auxiliary custom node '${node.id}' through as success (seam-parity run)`,
          );
          return { outcome: "success" };
        }
        throw new Error(`unexpected custom node in builtin authoritative workflow: ${node.id}`);
      },
      onEvent: (event) => {
        executorLog.log(`[workflow-authoritative] ${event.type} ${event.taskId}: ${event.detail}`);
      },
    });

    const graphResult = await runner.run(liveTask, buildAuthoritativeSettings(settings));
    if (graphResult.disposition === "fell-back") {
      return {
        handled: false,
        disposition: "fell-back",
        reason: graphResult.reason,
        readinessReasons: [],
        graphResult,
      };
    }

    return {
      handled: true,
      disposition: graphResult.disposition,
      reason: graphResult.reason,
      readinessReasons: [],
      graphResult,
    };
  }
}
