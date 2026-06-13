import type { Settings, TaskDetail, WorkflowIr, WorkflowIrNode, WorkflowWorkItem, WorkflowWorkItemState } from "@fusion/core";
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
  WORKFLOW_ID_CONTEXT_KEY,
  WORKFLOW_RUN_ID_CONTEXT_KEY,
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  type WorkflowCustomNodeRunner,
} from "./workflow-node-handlers.js";
import type { WorkflowRuntimePrimitives } from "./runtime-primitives.js";

export type WorkflowTaskRuntimeDisposition = "completed" | "failed" | "manual-required";

export interface WorkflowTaskRuntimeResult {
  disposition: WorkflowTaskRuntimeDisposition;
  outcome: WorkflowNodeOutcome;
  visitedNodeIds: string[];
  context: Record<string, unknown>;
  reason?: string;
}

export interface WorkflowTaskRuntimeDeps extends Omit<WorkflowGraphExecutorDeps, "seams" | "runCustomNode"> {
  store: WorkflowIrResolverStore & {
    getTask?: (taskId: string) => Promise<TaskDetail>;
    transitionWorkflowWorkItem?: (
      id: string,
      state: WorkflowWorkItemState,
      patch?: { now?: string; lastError?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null },
    ) => WorkflowWorkItem;
  };
  primitives: WorkflowRuntimePrimitives;
  runCustomNode: WorkflowCustomNodeRunner;
  onEvent?: (event: { type: "start" | "terminal"; taskId: string; detail: string }) => void;
}

/**
 * WorkflowTaskRuntime is the workflow-engine execution facade.
 *
 * It always resolves a task to a workflow IR: explicit selections resolve only
 * to their selected workflow, and tasks without a selection resolve to the
 * built-in coding workflow. This is intentionally different from
 * `WorkflowGraphTaskRunner`, whose current contract still models "no selection"
 * as legacy fallback.
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
      primitives: this.deps.primitives,
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

  public async runWorkItem(
    workItem: WorkflowWorkItem,
    settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  ): Promise<WorkflowTaskRuntimeResult> {
    if (!this.deps.store.getTask || !this.deps.store.transitionWorkflowWorkItem) {
      const reason = "workflow-work-item-store-unwired";
      this.emit("terminal", workItem.taskId, `work-item:failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: [],
        context: {},
        reason,
      };
    }
    if (workItem.state !== "running") {
      return this.failWorkItem(workItem, `workflow-work-item-not-running:${workItem.state}`);
    }

    let task: TaskDetail;
    try {
      task = await this.deps.store.getTask(workItem.taskId);
    } catch (err) {
      return this.failWorkItem(workItem, `workflow-work-item-task-missing:${err instanceof Error ? err.message : String(err)}`);
    }

    let target: WorkflowRuntimeTarget;
    try {
      target = await this.resolveRuntimeTarget(workItem.taskId);
    } catch (err) {
      return this.failWorkItem(workItem, `workflow-resolution-error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const node = target.ir.nodes.find((candidate) => candidate.id === workItem.nodeId);
    if (!node) {
      return this.failWorkItem(workItem, `workflow-work-item-node-missing:${workItem.nodeId}`);
    }

    const invoked: string[] = [];
    const handler = this.recordingHandlers(invoked)[node.kind];
    if (!handler && node.kind !== "start" && node.kind !== "end") {
      return this.failWorkItem(workItem, `workflow-work-item-node-unhandled:${node.kind}`);
    }

    const runtimeSettings = forceWorkflowGraphExecutor(settings);
    let outcome: WorkflowNodeOutcome = "success";
    let reason: string | undefined;
    let context: Record<string, unknown> = {
      [WORKFLOW_RUN_ID_CONTEXT_KEY]: workItem.runId,
      [WORKFLOW_ID_CONTEXT_KEY]: target.workflowId,
      "workflow:work-item-id": workItem.id,
      "workflow:work-item-kind": workItem.kind,
      "workflow:work-item-attempt": workItem.attempt,
    };

    try {
      const result = handler
        ? await handler(node, { task, settings: runtimeSettings, context })
        : { outcome: "success" as const };
      outcome = result.outcome;
      if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;
      context = { ...context, ...(result.contextPatch ?? {}) };
      reason = result.outcome === "failure" ? result.value ?? "workflow-work-item-node-failed" : undefined;
    } catch (err) {
      outcome = "failure";
      reason = `workflow-work-item-node-error:${err instanceof Error ? err.message : String(err)}`;
    }

    const disposition: WorkflowTaskRuntimeDisposition = outcome === "success"
      ? "completed"
      : reason === "manual-required"
        ? "manual-required"
        : "failed";
    const terminalState: WorkflowWorkItemState = disposition === "completed"
      ? "succeeded"
      : disposition === "manual-required"
        ? "manual-required"
        : "failed";
    this.deps.store.transitionWorkflowWorkItem(workItem.id, terminalState, {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason ?? null,
    });
    this.emit("terminal", workItem.taskId, `work-item:${disposition}`);
    return {
      disposition,
      outcome,
      visitedNodeIds: invoked.length > 0 ? invoked : [node.id],
      context,
      reason,
    };
  }

  private failWorkItem(workItem: WorkflowWorkItem, reason: string): WorkflowTaskRuntimeResult {
    this.deps.store.transitionWorkflowWorkItem!(workItem.id, "failed", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason,
    });
    this.emit("terminal", workItem.taskId, `work-item:failed:${reason}`);
    return {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: {},
      reason,
    };
  }

  private async resolveRuntimeTarget(taskId: string): Promise<WorkflowRuntimeTarget> {
    let workflowId: string | undefined;
    try {
      workflowId = this.deps.store.getTaskWorkflowSelection(taskId)?.workflowId;
    } catch (err) {
      throw new Error(`workflow-selection-failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!workflowId) return builtinCodingTarget();

    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      if (!builtin) throw new Error(`workflow-missing: ${workflowId}`);
      const ir = typeof builtin.ir === "string" ? parseWorkflowIr(builtin.ir) : builtin.ir;
      return { workflowId, ir };
    }

    const def = await this.deps.store.getWorkflowDefinition(workflowId);
    if (!def) throw new Error(`workflow-missing: ${workflowId}`);
    const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
    return { workflowId, ir };
  }

  private recordingHandlers(invoked: string[]): Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>> {
    const defaultHandlers = createDefaultNodeHandlers(createNoopLegacySeams(), this.deps.runCustomNode, {
      primitives: this.deps.primitives,
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
