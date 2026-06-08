import type { Settings, TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
  parseWorkflowIr,
  type WorkflowIrResolverStore,
} from "@fusion/core";

import {
  WorkflowGraphExecutor,
  type WorkflowGraphExecutorDeps,
  type WorkflowNodeHandler,
  type WorkflowNodeOutcome,
} from "./workflow-graph-executor.js";
import {
  createDefaultNodeHandlers,
  type WorkflowCustomNodeRunner,
  type WorkflowLegacySeams,
} from "./workflow-node-handlers.js";

export type WorkflowTaskRuntimeDisposition = "completed" | "failed";

export interface WorkflowTaskRuntimeResult {
  disposition: WorkflowTaskRuntimeDisposition;
  outcome: WorkflowNodeOutcome;
  visitedNodeIds: string[];
  context: Record<string, unknown>;
  reason?: string;
}

export interface WorkflowTaskRuntimeDeps extends Omit<WorkflowGraphExecutorDeps, "seams" | "runCustomNode"> {
  store: WorkflowIrResolverStore;
  seams: WorkflowLegacySeams;
  runCustomNode: WorkflowCustomNodeRunner;
  onEvent?: (event: { type: "start" | "terminal"; taskId: string; detail: string }) => void;
}

/**
 * WorkflowTaskRuntime is the workflow-engine execution facade.
 *
 * It always resolves a task to a workflow IR: explicit selections resolve to
 * their selected workflow, and tasks without a selection resolve to the built-in
 * coding workflow. This is intentionally
 * different from `WorkflowGraphTaskRunner`, whose current contract still models
 * "no selection" as legacy fallback.
 */
export class WorkflowTaskRuntime {
  public constructor(private readonly deps: WorkflowTaskRuntimeDeps) {}

  private emit(type: "start" | "terminal", taskId: string, detail: string): void {
    try {
      this.deps.onEvent?.({ type, taskId, detail });
    } catch {
      // Diagnostics must never affect execution.
    }
  }

  public async run(
    task: TaskDetail,
    settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  ): Promise<WorkflowTaskRuntimeResult> {
    this.emit("start", task.id, "resolve-workflow");

    let target: WorkflowRuntimeTarget;
    try {
      target = await this.resolveRuntimeTarget(task.id);
    } catch (err) {
      const reason = `workflow-resolution-error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit("terminal", task.id, `failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: [],
        context: {},
        reason,
      };
    }

    const invoked: string[] = [];
    const executor = new WorkflowGraphExecutor({
      ...this.deps,
      handlers: this.recordingHandlers(invoked),
      // WorkflowTaskRuntime is the execution engine, so internally the graph
      // executor is authoritative even before the old feature flag plumbing is
      // deleted from legacy entry points.
      runId: this.deps.runId ?? `${task.id}:${target.workflowId}`,
    });

    const runtimeSettings = forceWorkflowGraphExecutor(settings);
    let result: Awaited<ReturnType<WorkflowGraphExecutor["run"]>>;
    try {
      result = await executor.run(task, runtimeSettings, target.ir);
    } catch (err) {
      const reason = `workflow-execution-error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit("terminal", task.id, `failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: invoked,
        context: {},
        reason,
      };
    }
    const disposition: WorkflowTaskRuntimeDisposition = result.outcome === "success" ? "completed" : "failed";
    this.emit("terminal", task.id, disposition);
    return {
      disposition,
      outcome: result.outcome,
      visitedNodeIds: result.visitedNodeIds,
      context: result.context,
    };
  }

  private async resolveRuntimeTarget(taskId: string): Promise<WorkflowRuntimeTarget> {
    let workflowId: string | undefined;
    try {
      workflowId = this.deps.store.getTaskWorkflowSelection(taskId)?.workflowId;
    } catch {
      return builtinCodingTarget();
    }

    if (!workflowId) return builtinCodingTarget();

    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      if (!builtin) return builtinCodingTarget();
      const ir = typeof builtin.ir === "string" ? parseWorkflowIr(builtin.ir) : builtin.ir;
      return { workflowId, ir };
    }

    try {
      const def = await this.deps.store.getWorkflowDefinition(workflowId);
      if (!def) return builtinCodingTarget();
      const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
      return { workflowId, ir };
    } catch {
      return builtinCodingTarget();
    }
  }

  private recordingHandlers(invoked: string[]): Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>> {
    const defaultHandlers = createDefaultNodeHandlers(this.deps.seams, this.deps.runCustomNode, {
      parseSteps: this.deps.parseStepsDeps,
      runCode: this.deps.runCode,
      prNodes: this.deps.prNodes,
    });
    const handlers = { ...defaultHandlers, ...(this.deps.handlers ?? {}) };
    const wrapped: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>> = {};
    for (const [kind, handler] of Object.entries(handlers) as Array<[WorkflowIrNode["kind"], WorkflowNodeHandler]>) {
      wrapped[kind] = async (node, context) => {
        invoked.push(node.id);
        return handler(node, context);
      };
    }
    return wrapped;
  }
}

interface WorkflowRuntimeTarget {
  workflowId: string;
  ir: WorkflowIr;
}

function builtinCodingTarget(): WorkflowRuntimeTarget {
  return { workflowId: "builtin:coding", ir: BUILTIN_CODING_WORKFLOW_IR };
}

function forceWorkflowGraphExecutor(
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
): Pick<Settings, "experimentalFeatures"> & Partial<Settings> {
  return {
    ...(settings ?? {}),
    experimentalFeatures: {
      ...(settings?.experimentalFeatures ?? {}),
      workflowGraphExecutor: true,
    },
  };
}
