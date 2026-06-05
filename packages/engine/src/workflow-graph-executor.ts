import type { Settings, TaskDetail, TaskStep, WorkflowIr, WorkflowIrEdge, WorkflowIrNode } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR, WorkflowIrError, isExperimentalFeatureEnabled } from "@fusion/core";

import {
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  SPLIT_ACTIVE_CONTEXT_KEY,
  type CodeNodeRunner,
  type ForeachActiveContext,
  type ParseStepsHandlerDeps,
  type WorkflowCustomNodeRunner,
  type WorkflowLegacySeams,
} from "./workflow-node-handlers.js";
import {
  runSplitJoin,
  type BranchEnvironment,
  type WorkflowBranchPersistence,
  type WorkflowBranchProgress,
  type WorkflowBranchRunState,
  type WorkflowBranchSemaphore,
} from "./workflow-graph-branches.js";
import {
  runForeach,
  type ForeachEnvironment,
  type WorkflowStepInstancePersistence,
} from "./workflow-graph-foreach.js";

export type WorkflowNodeOutcome = "success" | "failure";

export interface WorkflowNodeResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  contextPatch?: Record<string, unknown>;
}

export interface WorkflowNodeExecutionContext {
  task: TaskDetail;
  settings: Pick<Settings, "experimentalFeatures"> | undefined;
  context: Record<string, unknown>;
  /** Set during concurrent branch execution; fail-fast aborts via this signal.
   *  Undefined on the sequential path (zero behavior change for linear graphs). */
  signal?: AbortSignal;
}

export type WorkflowNodeHandler = (node: WorkflowIrNode, context: WorkflowNodeExecutionContext) => Promise<WorkflowNodeResult>;

export interface WorkflowGraphExecutorDeps {
  handlers?: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;
  seams?: WorkflowLegacySeams;
  /** Executes custom (non-seam) prompt/script/gate nodes. */
  runCustomNode?: WorkflowCustomNodeRunner;
  /** Step-inversion (U12, KTD-12): dependencies for the `parse-steps` node
   *  handler (artifact read, projection write, pin-protection probe, audit).
   *  Absent → a parse-steps node fails cleanly. */
  parseStepsDeps?: ParseStepsHandlerDeps;
  /** Step-inversion (U14, KTD-15): runner for the `code` node (esbuild compile +
   *  child-process execution). Absent → a code node fails cleanly. */
  runCode?: CodeNodeRunner;
  maxRetriesPerNode?: number;
  /** Per-branch run-state persistence (U13). Optional — fully in-memory without it. */
  branchPersistence?: WorkflowBranchPersistence;
  /** Bounds concurrent branch-node execution. Omit when the semaphore is
   *  enforced beneath runCustomNode (the session layer) to avoid double-acquire. */
  branchSemaphore?: WorkflowBranchSemaphore;
  /** Live per-branch progress (dashboard badges). */
  onBranchProgress?: (progress: WorkflowBranchProgress) => void;
  /** Stable identifier for this run, used to key persisted branch state. */
  runId?: string;
  /**
   * Step-inversion (KTD-3, U3): fresh `Task.steps[]` accessor used by a `foreach`
   * node at expansion time. Defaults to reading `task.steps` off the run's task.
   * A production caller may inject a fresh store fetch so the count reflects the
   * planning seam's latest write; tests inject a fixed list.
   */
  getTaskSteps?: (task: TaskDetail) => Promise<TaskStep[]> | TaskStep[];
  /**
   * Step-inversion (KTD-6, U3 stub): per-instance run-state persistence for
   * foreach instances. Optional with no-op default — the real SQLite adapter is
   * U4's executor-half wiring; the sub-walk already calls into this so that
   * wiring is purely additive.
   */
  stepInstancePersistence?: WorkflowStepInstancePersistence;
  /**
   * Step-inversion (KTD-4, U5): RETHINK reset-on-rework hook passed through to the
   * foreach sub-walk. Invoked before re-entering step-execute when a rework edge
   * was triggered by an `outcome:rethink` verdict. Optional with a no-op default
   * (REVISE-driven rework never calls it).
   */
  onReworkReset?: (
    active: ForeachActiveContext,
    reason: string,
  ) => void | Promise<void>;
  /**
   * Step-inversion (U3): top-level abort signal honored between foreach instance
   * nodes (existing posture, mirrors the branch path's per-branch signal). When a
   * run is cancelled (pause/abort), the in-flight instance stops cleanly between
   * nodes and the foreach fails with `value: "aborted"`. Undefined on normal
   * runs (zero behavior change for non-foreach graphs).
   */
  signal?: AbortSignal;
  /** Step-inversion (KTD-11, U10): per-instance worktree/branch allocation off the
   *  integration base, for `isolation: "worktree"`. Absent → worktree isolation
   *  fails cleanly (shared isolation is unaffected). */
  allocateInstanceWorktree?: ForeachEnvironment["allocateInstanceWorktree"];
  /** Step-inversion (KTD-11, U10): resolve the current integration base (main tip)
   *  so reworks land on the updated base. */
  resolveIntegrationBase?: ForeachEnvironment["resolveIntegrationBase"];
  /** Step-inversion (KTD-11, U10): ordered-integration git mechanics (rebase /
   *  cherry-pick + conflict detection via merger helpers). */
  integrationGitOps?: ForeachEnvironment["integrationGitOps"];
  /** Step-inversion (KTD-11, U10): projection-first integration writes
   *  (updateStep done, then instance row). */
  integrationProjection?: ForeachEnvironment["integrationProjection"];
  /** Step-inversion (KTD-11, U10): non-blocking free-semaphore-slot accessor for
   *  parallel scheduling (clamps concurrency without hold-and-wait). */
  semaphoreAvailability?: ForeachEnvironment["semaphoreAvailability"];
  /** Step-inversion (KTD-11, U10): crash-resume reconciliation hook. */
  resumeReconcile?: ForeachEnvironment["resumeReconcile"];
  /** FIX 4 (context gap): task-level log sink for integration-conflict rework. */
  logTaskEntry?: ForeachEnvironment["logTaskEntry"];
}

export interface WorkflowGraphExecutorResult {
  executed: boolean;
  outcome: WorkflowNodeOutcome;
  context: Record<string, unknown>;
  visitedNodeIds: string[];
}

const TERMINAL_FAILURE: WorkflowGraphExecutorResult = {
  executed: false,
  outcome: "failure",
  context: {},
  visitedNodeIds: [],
};

export class WorkflowGraphExecutor {
  private readonly maxRetriesPerNode: number;

  private readonly handlers: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;

  public constructor(private readonly deps: WorkflowGraphExecutorDeps) {
    this.maxRetriesPerNode = Math.max(1, Math.floor(deps.maxRetriesPerNode ?? 2));
    this.handlers = {
      ...createDefaultNodeHandlers(deps.seams ?? createNoopLegacySeams(), deps.runCustomNode, {
        parseSteps: deps.parseStepsDeps,
        runCode: deps.runCode,
      }),
      ...(deps.handlers ?? {}),
    };
  }

  public async run(
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    ir: WorkflowIr = BUILTIN_CODING_WORKFLOW_IR,
  ): Promise<WorkflowGraphExecutorResult> {
    if (!isExperimentalFeatureEnabled(settings, "workflowGraphExecutor")) {
      return TERMINAL_FAILURE;
    }

    const startNode = ir.nodes.find((node) => node.kind === "start");
    if (!startNode) throw new WorkflowIrError("Workflow IR missing start node");

    const nodeMap = new Map(ir.nodes.map((node) => [node.id, node]));
    const outgoingMap = new Map<string, WorkflowIrEdge[]>();
    for (const edge of ir.edges) {
      if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
        throw new WorkflowIrError(`Workflow IR edge references unknown node: ${edge.from} -> ${edge.to}`);
      }
      const list = outgoingMap.get(edge.from) ?? [];
      list.push(edge);
      outgoingMap.set(edge.from, list);
    }

    const context: Record<string, unknown> = {};
    const visitedNodeIds: string[] = [];
    const inStack = new Set<string>();
    const runId = this.deps.runId ?? `${task.id}:run`;

    // On resume, completed branch nodes (from a prior crashed run) are skipped
    // so their handlers do not re-fire (idempotency).
    let completedNodeIds: Set<string> | undefined;
    const persisted = await this.deps.branchPersistence?.loadBranchStates?.(task.id, runId);
    if (persisted && persisted.length > 0) {
      completedNodeIds = new Set(
        persisted
          .filter((s: WorkflowBranchRunState) => s.status === "completed")
          .map((s) => s.currentNodeId),
      );
    }

    // Prune prior-run branch rows on run start (#1412). Done after the resume
    // load so this run's own (taskId, runId) rows survive while every stale run
    // is removed. Never throws into the run.
    await this.pruneStaleBranches(task.id, runId);
    // Same posture for foreach step-instance rows (KTD-6, U4): prune every stale
    // run's instance rows, keeping only this run's, so the table does not
    // accumulate historical runs for a long-lived task. The resume reconcile path
    // (foreach worktree scheduler) loads THIS run's rows, which survive.
    await this.pruneStaleInstances(task.id, runId);

    // Shared branch environment: built lazily so the sequential path pays nothing.
    const branchEnv = (): BranchEnvironment => ({
      task,
      settings,
      runId,
      nodeMap,
      outgoingMap,
      runBranchNode: (node, signal) => this.executeNodeWithRetries(node, task, settings, context, signal),
      shouldTraverseEdge: (edge, source) => this.shouldTraverseEdge(edge, source),
      persistence: this.deps.branchPersistence,
      semaphore: this.deps.branchSemaphore,
      onBranchProgress: this.deps.onBranchProgress,
      completedNodeIds,
    });

    const walk = async (nodeId: string): Promise<WorkflowNodeResult> => {
      const node = nodeMap.get(nodeId);
      if (!node) throw new WorkflowIrError(`Unknown workflow node: ${nodeId}`);
      if (inStack.has(nodeId)) throw new WorkflowIrError(`Cycle detected at node: ${nodeId}`);
      inStack.add(nodeId);
      visitedNodeIds.push(nodeId);

      try {
        if (node.kind === "start") {
          return await traverseChildren(node, { outcome: "success" });
        }
        if (node.kind === "end") {
          return { outcome: "success" };
        }

        if (node.kind === "split") {
          // Concurrent fan-out: branches run in parallel up to their join, which
          // synchronizes per its config. The card stays in the split's column for
          // the whole window (no handler-driven move happens in here). Execution
          // then continues sequentially from the join node.
          //
          // Single-writer rule (KTD-4, U5): mark the shared context "inside a
          // split" for the branch window so a step-review node inside a branch is
          // advisory-only (no projection write, no authoritative verdict). The
          // marker is set before launching branches and cleared at the join;
          // step-execute is validator-forbidden in splits, so only step-review
          // consults it. Restore the prior value to support balanced nesting.
          const priorSplitActive = context[SPLIT_ACTIVE_CONTEXT_KEY];
          context[SPLIT_ACTIVE_CONTEXT_KEY] = true;
          let splitResult: Awaited<ReturnType<typeof runSplitJoin>>;
          try {
            splitResult = await runSplitJoin(node, branchEnv());
          } finally {
            if (priorSplitActive === undefined) delete context[SPLIT_ACTIVE_CONTEXT_KEY];
            else context[SPLIT_ACTIVE_CONTEXT_KEY] = priorSplitActive;
          }
          visitedNodeIds.push(...splitResult.visitedNodeIds);
          context[`node:${node.id}:outcome`] = splitResult.outcome;
          context[`node:${splitResult.joinNodeId}:outcome`] = splitResult.outcome;
          context[`node:${splitResult.joinNodeId}:branchOutcomes`] = splitResult.branchOutcomes;
          if (!inStack.has(splitResult.joinNodeId)) visitedNodeIds.push(splitResult.joinNodeId);
          return await traverseChildren(
            nodeMap.get(splitResult.joinNodeId)!,
            { outcome: splitResult.outcome },
          );
        }

        if (node.kind === "foreach") {
          // Step-inversion (KTD-3/KTD-5, U3): expand the foreach into per-step
          // instances run through an iterative region sub-walk. The recursive
          // walk's inStack cycle detector is untouched — rework loops are
          // expressed inside the sub-walk only. The foreach node's own outcome
          // routes its outgoing edges (success / outcome:rework-exhausted / ...).
          const steps = await this.resolveTaskSteps(task);
          const foreachResult = await runForeach(node, {
            task,
            runId,
            steps,
            context,
            runTemplateNode: (tNode, sig, contextOverride) =>
              this.executeNodeWithRetries(tNode, task, settings, contextOverride ?? context, sig),
            shouldTraverseEdge: (edge, src) => this.shouldTraverseEdge(edge, src),
            persistence: this.deps.stepInstancePersistence,
            onReworkReset: this.deps.onReworkReset,
            signal: this.deps.signal,
            // Worktree isolation + parallel scheduling (KTD-11, U10).
            allocateInstanceWorktree: this.deps.allocateInstanceWorktree,
            resolveIntegrationBase: this.deps.resolveIntegrationBase,
            integrationGitOps: this.deps.integrationGitOps,
            integrationProjection: this.deps.integrationProjection,
            semaphoreAvailability: this.deps.semaphoreAvailability,
            resumeReconcile: this.deps.resumeReconcile,
            logTaskEntry: this.deps.logTaskEntry,
          });
          visitedNodeIds.push(...foreachResult.visitedNodeIds);
          const result: WorkflowNodeResult = {
            outcome: foreachResult.outcome,
            value: foreachResult.value,
          };
          context[`node:${node.id}:outcome`] = result.outcome;
          if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;
          return await traverseChildren(node, result);
        }

        const result = await this.executeNodeWithRetries(node, task, settings, context);
        if (result.contextPatch) Object.assign(context, result.contextPatch);
        context[`node:${node.id}:outcome`] = result.outcome;
        if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;

        return await traverseChildren(node, result);
      } finally {
        inStack.delete(nodeId);
      }
    };

    const traverseChildren = async (node: WorkflowIrNode, sourceResult: WorkflowNodeResult): Promise<WorkflowNodeResult> => {
      const edges = outgoingMap.get(node.id) ?? [];
      if (edges.length === 0) {
        return sourceResult;
      }

      const matching = edges.filter((edge) => this.shouldTraverseEdge(edge, sourceResult));
      if (matching.length === 0) {
        return sourceResult;
      }

      let aggregate: WorkflowNodeResult = sourceResult;
      for (const edge of matching.sort((a, b) => a.to.localeCompare(b.to))) {
        const target = nodeMap.get(edge.to);
        if (target?.kind === "end") {
          aggregate = sourceResult;
          continue;
        }
        const child = await walk(edge.to);
        if (child.outcome === "failure") {
          aggregate = child;
          break;
        }
        aggregate = child;
      }
      return aggregate;
    };

    const terminal = await walk(startNode.id);
    // Prune again on run completion (#1412): keeps only this run's rows so the
    // table does not accumulate historical runs for a long-lived task.
    await this.pruneStaleBranches(task.id, runId);
    await this.pruneStaleInstances(task.id, runId);
    return {
      executed: true,
      outcome: terminal.outcome,
      context,
      visitedNodeIds,
    };
  }

  /**
   * Resolve the task's step list for a foreach expansion (KTD-3). Defaults to
   * the steps already on the run's task; a caller may inject `getTaskSteps` to
   * fetch fresh state (e.g. after the planning seam populated steps).
   */
  private async resolveTaskSteps(task: TaskDetail): Promise<TaskStep[]> {
    if (this.deps.getTaskSteps) {
      return await this.deps.getTaskSteps(task);
    }
    return task.steps ?? [];
  }

  /** Best-effort prune of stale-run branch rows; never throws into the run. */
  private async pruneStaleBranches(taskId: string, keepRunId: string): Promise<void> {
    try {
      await this.deps.branchPersistence?.clearStaleBranchStates?.(taskId, keepRunId);
    } catch {
      // Pruning is additive bookkeeping — a failure must not affect the run.
    }
  }

  /** Best-effort prune of stale-run foreach instance rows (KTD-6, U4); identical
   *  keepRunId posture as {@link pruneStaleBranches}. Never throws into the run. */
  private async pruneStaleInstances(taskId: string, keepRunId: string): Promise<void> {
    try {
      await this.deps.stepInstancePersistence?.clearStaleInstanceStates?.(taskId, keepRunId);
    } catch {
      // Pruning is additive bookkeeping — a failure must not affect the run.
    }
  }

  private shouldTraverseEdge(edge: WorkflowIrEdge, sourceResult: WorkflowNodeResult): boolean {
    if (!edge.condition) return sourceResult.outcome === "success";
    if (edge.condition === "success") return sourceResult.outcome === "success";
    if (edge.condition === "failure") return sourceResult.outcome === "failure";
    if (edge.condition.startsWith("outcome:")) {
      return sourceResult.value === edge.condition.slice("outcome:".length);
    }
    throw new WorkflowIrError(`Unsupported edge condition: ${edge.condition}`);
  }

  private async executeNodeWithRetries(
    node: WorkflowIrNode,
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    context: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowNodeResult> {
    const handler = this.handlers[node.kind];
    if (!handler) {
      throw new WorkflowIrError(`No handler registered for node kind: ${node.kind}`);
    }

    // Per-node override: config.maxRetries beats the executor-wide default.
    const configured = Number(node.config?.maxRetries);
    const maxAttempts = Number.isFinite(configured) && configured >= 1
      ? Math.min(10, Math.floor(configured))
      : this.maxRetriesPerNode;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Fail-fast cancellation: a branch aborted mid-retry stops re-trying.
      if (signal?.aborted) return { outcome: "failure", value: "aborted" };
      try {
        return await handler(node, { task, settings, context, signal });
      } catch (error) {
        lastError = error;
      }
    }

    return {
      outcome: "failure",
      value: "exception",
      contextPatch: {
        [`node:${node.id}:error`]: lastError instanceof Error ? lastError.message : String(lastError),
      },
    };
  }
}
