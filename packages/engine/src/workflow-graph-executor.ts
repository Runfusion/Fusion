import type {
  Settings,
  TaskDetail,
  TaskStep,
  WorkflowIr,
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrNodeKind,
  WorkflowNodeExtensionResult,
  WorkflowStepResult,
} from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR, PLAN_REVIEW_GROUP_ID, WorkflowIrError, getWorkflowExtensionRegistry, resolveMaxReworkCycles, isExperimentalFeatureEnabled, GRAPH_NATIVE_POST_MERGE_FLAG } from "@fusion/core";

import {
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  SPLIT_ACTIVE_CONTEXT_KEY,
  WORKFLOW_ID_CONTEXT_KEY,
  WORKFLOW_RUN_ID_CONTEXT_KEY,
  type CodeNodeRunner,
  type ForeachActiveContext,
  type ParseStepsHandlerDeps,
  type WorkflowNotifyDispatch,
  type WorkflowCustomNodeRunner,
  type WorkflowLegacySeams,
} from "./workflow-node-handlers.js";
import type { WorkflowRuntimePrimitives } from "./runtime-primitives.js";
import type { PrNodeDeps } from "./pr-nodes.js";
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
import { runLoop, runOptionalGroup } from "./workflow-graph-loop.js";

export type WorkflowNodeOutcome = "success" | "failure";

export type WorkflowNodeAbortKind = "engine-pause";

export const WORKFLOW_INTERRUPTED_NODE_ID_CONTEXT_KEY = "workflow:interruptedNodeId";
export const WORKFLOW_INTERRUPTED_NODE_ABORT_KIND_CONTEXT_KEY = "workflow:interruptedNodeAbortKind";
export const WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND: WorkflowNodeAbortKind = "engine-pause";

export interface WorkflowNodeResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  contextPatch?: Record<string, unknown>;
}

interface PreMergeOptionalStepFailureContext {
  stepName: string;
  feedback: string;
  phase: WorkflowStepResult["phase"];
  status: WorkflowStepResult["status"];
  verdict?: string;
  nodeId?: string;
  maxRevisions?: unknown;
}

export interface WorkflowTaskProjection {
  modifiedFiles?: string[];
  mergeDetails?: {
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
  };
  summary?: string;
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

export interface WorkflowNodePreparationRequirement {
  requiresWorktree: boolean;
  reason?: string;
}

export interface WorkflowGraphExecutorDeps {
  handlers?: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;
  /** Workflow-native runtime primitives. When present, default nodes call these
   *  directly instead of legacy executor/reviewer/merge seams. */
  primitives?: WorkflowRuntimePrimitives;
  seams?: WorkflowLegacySeams;
  /** Executes custom (non-seam) prompt/script/gate nodes. */
  runCustomNode?: WorkflowCustomNodeRunner;
  /*
   * FNXC:WorkflowExecution 2026-06-29-09:43:
   * Workflow nodes own lifecycle prerequisites. The graph classifies a node's execution requirements (for example a coding/script node needing a task worktree) before dispatching the handler; executor adapters only fulfill that request with concrete git/session mechanics.
   */
  prepareNodeExecution?: (
    node: WorkflowIrNode,
    task: TaskDetail,
    requirement: WorkflowNodePreparationRequirement,
  ) => void | Promise<void>;
  /** Step-inversion (U12, KTD-12): dependencies for the `parse-steps` node
   *  handler (artifact read, projection write, pin-protection probe, audit).
   *  Absent → a parse-steps node fails cleanly. */
  parseStepsDeps?: ParseStepsHandlerDeps;
  /** Step-inversion (U14, KTD-15): runner for the `code` node (esbuild compile +
   *  child-process execution). Absent → a code node fails cleanly. */
  runCode?: CodeNodeRunner;
  /** notify node dispatch callback. Absent → notify nodes succeed with notify-skipped. */
  notifyDispatch?: WorkflowNotifyDispatch;
  /** PR-entity nodes (U3): deps for `pr-create`/`pr-respond`/`pr-merge` (injected
   *  GitHub callbacks + store accessor). Absent → the pr-* kinds fail cleanly. */
  prNodes?: PrNodeDeps;
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
  /** Test seam for bounded loop timeout checks. Defaults to Date.now. */
  runLoopNowForTests?: () => number;
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
  /*
   * FNXC:WorkflowStepResults 2026-06-25-12:00:
   * Fail-soft persistence sink for an ENABLED optional-group node's outcome
   * (plan U2, KTD-1/KTD-2). The graph upserts each enabled group's result into the
   * EXISTING `task.workflowStepResults` field keyed by `node.id` so the unified
   * progress bar (`getUnifiedTaskProgress`) reflects graph-run steps. Optional: when
   * absent the executor records NOTHING (keeps in-memory tests byte-inert), so a
   * disabled group and an unwired store both record nothing. The upsert-by-id +
   * `store.updateTask({workflowStepResults})` wiring lives in the executor adapter;
   * this seam only forwards the terminal/pending entry.
   */
  recordWorkflowStepResult?: (taskId: string, result: WorkflowStepResult) => void | Promise<void>;
  /*
   * FNXC:WorkflowOptionalStepFix 2026-06-26-16:20:
   * Enabled PRE-merge optional workflow steps that return REVISE must offer the executor one remediation path before normal advisory/gate fall-through. The graph forwards the optional-group node id and per-step `maxRevisions` override so the executor can resolve the budget against `maxPostReviewFixes` or honor `"unbounded"`; absent or false preserves prior byte-inert behavior for in-memory tests and exhausted budgets.
   */
  requestPreMergeOptionalStepFix?: (taskId: string, info: {
    stepName: string;
    feedback: string;
    phase: WorkflowStepResult["phase"];
    status: WorkflowStepResult["status"];
    verdict?: string;
    nodeId?: string;
    maxRevisions?: unknown;
  }) => Promise<boolean> | boolean;
  /** Project node-published task metadata onto the task row for dispatcher/UI. */
  publishTaskProjection?: (taskId: string, patch: WorkflowTaskProjection, source: { nodeId: string; nodeKind: WorkflowIrNode["kind"] }) => void | Promise<void>;
  /** @deprecated use publishTaskProjection. Kept for older callers. */
  publishTouchedFiles?: (taskId: string, files: string[], source: { nodeId: string; nodeKind: WorkflowIrNode["kind"] }) => void | Promise<void>;
}

export interface WorkflowGraphExecutorResult {
  executed: boolean;
  outcome: WorkflowNodeOutcome;
  context: Record<string, unknown>;
  visitedNodeIds: string[];
}

/**
 * Engine-local mirror of core's workflow-owned merge/retry/recovery primitive
 * region. Until the workflow interpreter owns merge policy end-to-end, graph
 * execution treats any entry into this region as the terminal legacy `merge`
 * seam so observable lifecycle behavior stays byte-identical with the legacy
 * executor. Consolidate with a core export when one exists.
 */
export const MERGE_REGION_KINDS = new Set<WorkflowIrNodeKind>([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
]);

function isMergeRegionKind(kind: WorkflowIrNodeKind): boolean {
  return MERGE_REGION_KINDS.has(kind);
}

function optionalStepFailureContextKey(stepId: string): string {
  return `workflow:optional-step-failure:${stepId}`;
}

function normalizeTouchedFile(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value && typeof value === "object" && "path" in value) {
    return normalizeTouchedFile((value as { path?: unknown }).path);
  }
  return undefined;
}

function extractTouchedFiles(contextPatch: Record<string, unknown> | undefined): string[] {
  if (!contextPatch) return [];
  const raw = contextPatch.modifiedFiles ?? contextPatch.touchedFiles ?? contextPatch.changedFiles;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(normalizeTouchedFile).filter((file): file is string => file !== undefined))].sort();
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function extractTaskProjection(contextPatch: Record<string, unknown> | undefined): WorkflowTaskProjection {
  if (!contextPatch) return {};
  const patch: WorkflowTaskProjection = {};
  const files = extractTouchedFiles(contextPatch);
  if (files.length > 0) patch.modifiedFiles = files;

  const mergeDetails = objectRecord(contextPatch.mergeDetails);
  const safeMergeDetails = {
    filesChanged: finiteCount(contextPatch.filesChanged ?? mergeDetails?.filesChanged),
    insertions: finiteCount(mergeDetails?.insertions),
    deletions: finiteCount(mergeDetails?.deletions),
  };
  if (
    safeMergeDetails.filesChanged !== undefined
    || safeMergeDetails.insertions !== undefined
    || safeMergeDetails.deletions !== undefined
  ) {
    patch.mergeDetails = Object.fromEntries(
      Object.entries(safeMergeDetails).filter(([, value]) => value !== undefined),
    ) as NonNullable<WorkflowTaskProjection["mergeDetails"]>;
  }

  if (typeof contextPatch.summary === "string") patch.summary = contextPatch.summary;
  return patch;
}

function hasTaskProjection(patch: WorkflowTaskProjection): boolean {
  return Object.keys(patch).length > 0;
}

export class WorkflowGraphExecutor {
  private readonly maxRetriesPerNode: number;

  private readonly handlers: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;

  public constructor(private readonly deps: WorkflowGraphExecutorDeps) {
    this.maxRetriesPerNode = Math.max(1, Math.floor(deps.maxRetriesPerNode ?? 2));
    this.handlers = {
      ...createDefaultNodeHandlers(deps.seams ?? createNoopLegacySeams(), deps.runCustomNode, {
        primitives: deps.primitives,
        parseSteps: deps.parseStepsDeps,
        runCode: deps.runCode,
        notifyDispatch: deps.notifyDispatch,
        prNodes: deps.prNodes,
      }),
      ...(deps.handlers ?? {}),
    };
  }

  public async run(
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    ir: WorkflowIr = BUILTIN_CODING_WORKFLOW_IR,
  ): Promise<WorkflowGraphExecutorResult> {
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

    const runId = this.deps.runId ?? `${task.id}:run`;
    const context: Record<string, unknown> = {
      [WORKFLOW_RUN_ID_CONTEXT_KEY]: runId,
      [WORKFLOW_ID_CONTEXT_KEY]: ir.name || "unknown",
    };
    /*
     * FNXC:WorkflowPostMerge 2026-06-26-15:30:
     * Graph-native post-merge steps, gated by the DEFAULT-ON `graphNativePostMerge`
     * experimental flag (in DEFAULT_ON_EXPERIMENTAL_FEATURES; an explicit `false`
     * opts out). The merge-policy region is collapsed into ONE legacy merge
     * seam (see `runLegacyMergeSeam` + the `isMergeRegionKind` branch in
     * `traverseChildren`), so a node wired off `merge-attempt` success is normally
     * never traversed. With the flag ON (the default) we let traversal continue past a
     * SUCCESSFUL merge to those post-merge entry nodes; an explicit opt-out (`false`)
     * leaves the set empty and skips the post-merge hop.
     *
     * `postMergeEntryNodeIds` = the (deterministic, id-sorted) set of edge targets `t`
     * such that an edge leaves a merge-region node to `t`, where `t` is itself NOT a
     * merge-region node and NOT `end`, the edge is not a rework back-edge, and the edge
     * routes on success (no condition or `condition: "success"`). Full built-ins can now
     * expose the default-off `post-merge-verification` optional group here, so workflow
     * definitions own the post-merge verification policy while the merge seam still
     * provides proof before the hop. When the flag is OFF the set is left empty and
     * post-merge nodes are skipped for compatibility; normal merge failure/manual/retry
     * routing remains unchanged.
     */
    const postMergeEnabled = isExperimentalFeatureEnabled(settings, GRAPH_NATIVE_POST_MERGE_FLAG);
    const postMergeEntryNodeIds: string[] = (() => {
      if (!postMergeEnabled) return [];
      const ids = new Set<string>();
      for (const [from, edges] of outgoingMap) {
        const fromNode = nodeMap.get(from);
        if (!fromNode || !isMergeRegionKind(fromNode.kind)) continue;
        for (const edge of edges) {
          if (edge.kind === "rework") continue;
          if (edge.condition && edge.condition !== "success") continue;
          const target = nodeMap.get(edge.to);
          if (!target || target.kind === "end" || isMergeRegionKind(target.kind)) continue;
          ids.add(edge.to);
        }
      }
      return [...ids].sort();
    })();
    const visitedNodeIds: string[] = [];
    const inStack = new Set<string>();
    const syntheticMergeNode: WorkflowIrNode = {
      id: "merge",
      kind: "prompt",
      column: "in-review",
      config: { seam: "merge" },
    };

    // Bounded-rework generalization (U6). A `kind: "rework"` edge is the only
    // legal cycle: it loops back to a "rework region head" (the edge's `to` node).
    // The same mechanism the foreach sub-walk uses (bounded budget, exhaustion
    // routes `outcome:rework-exhausted`) is lifted to the top-level walk so the PR
    // review loop (await-review → pr-respond → rework → await-review) is legal and
    // bounded. Every NON-rework back-edge still throws "Cycle detected" below.
    //
    //  - reworkHeads: every node that is the target of a rework edge.
    //  - reworkBudget: per-head remaining traversals, seeded lazily from the head
    //    node's `config.maxReworkCycles` (shared default + clamp from core).
    //  - The loop is iterative at the head frame: when a downstream node takes its
    //    rework edge back to a head currently on the stack, the head's walk frame
    //    catches a REWORK_SIGNAL sentinel and re-iterates (under budget) instead of
    //    recursing — so `inStack` never sees the head re-entered as a cycle.
    const reworkHeads = new Set<string>();
    for (const edge of ir.edges) {
      if (edge.kind === "rework") reworkHeads.add(edge.to);
    }
    const reworkBudget = new Map<string, number>();
    const reworkBudgetFor = (headId: string): number => {
      const existing = reworkBudget.get(headId);
      if (existing !== undefined) return existing;
      const head = nodeMap.get(headId);
      const seeded = resolveMaxReworkCycles(head?.config?.maxReworkCycles);
      reworkBudget.set(headId, seeded);
      return seeded;
    };
    // Sentinel a downstream rework edge returns up the recursion to its loop head.
    interface ReworkSignal {
      readonly __rework: true;
      readonly headId: string;
      /** The source node's result, carried so the head re-runs against fresh state. */
      readonly source: WorkflowNodeResult;
    }
    const isReworkSignal = (r: WorkflowNodeResult | ReworkSignal): r is ReworkSignal =>
      (r as ReworkSignal).__rework === true;

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
      runBranchNode: (node, signal) => this.executeNodeWithRetries(node, task, settings, context, ir, signal),
      shouldTraverseEdge: (edge, source) => this.shouldTraverseEdge(edge, source),
      persistence: this.deps.branchPersistence,
      semaphore: this.deps.branchSemaphore,
      onBranchProgress: this.deps.onBranchProgress,
      completedNodeIds,
    });

    // Execute one node and traverse its outgoing edges. May return a ReworkSignal
    // (a rework back-edge fired); the caller frame propagates or consumes it.
    const runNodeAndTraverse = async (
      node: WorkflowIrNode,
    ): Promise<WorkflowNodeResult | ReworkSignal> => {
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
            getLiveSteps: () => this.resolveTaskSteps(task),
            context,
            runTemplateNode: (tNode, sig, contextOverride) =>
              this.executeNodeWithRetries(tNode, task, settings, contextOverride ?? context, ir, sig),
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

        if (node.kind === "loop") {
          const loopResult = await runLoop(node, {
            context,
            runTemplateNode: (tNode, sig, contextOverride) =>
              this.executeNodeWithRetries(tNode, task, settings, contextOverride ?? context, ir, sig),
            shouldTraverseEdge: (edge, src) => this.shouldTraverseEdge(edge, src),
            signal: this.deps.signal,
            now: this.deps.runLoopNowForTests,
          });
          visitedNodeIds.push(...loopResult.visitedNodeIds);
          const result: WorkflowNodeResult = {
            outcome: loopResult.outcome,
            value: loopResult.value,
          };
          context[`node:${node.id}:outcome`] = result.outcome;
          if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;
          return await traverseChildren(node, result);
        }

        if (node.kind === "optional-group") {
          /*
           * FNXC:WorkflowOptionalGroup 2026-06-21-14:05:
           * Run-once-or-bypass dispatch. The enable decision is read from the
           * per-task `enabledWorkflowSteps` facet, keyed by THIS group node's id
           * (KTD-2). Enabled → walk the template subgraph EXACTLY ONCE via
           * `runOptionalGroup` (single pass, no iteration/rework). Disabled →
           * pass through: traverse the group's children with a synthetic
           * success result WITHOUT executing any template node, so a disabled
           * group is byte-inert vs the group not being there. Two tasks
           * identical except `enabledWorkflowSteps` therefore diverge here:
           * the enabled one runs the body, the disabled one runs none and
           * still reaches the same downstream node.
           */
          /*
           * FNXC:WorkflowOptionalSteps 2026-06-29-03:43:
           * Distinguish an explicit empty toggle list from a missing one. Quick Add
           * and task forms persist `[]` when an operator unchecks Plan/Code Review,
           * so that must keep bypassing the group. Imported/legacy/resumed tasks may
           * have no `enabledWorkflowSteps` field at all; for those, honor the
           * workflow-authored `defaultOn` so default Coding still runs Plan Review
           * before execution and Code Review before merge.
           */
          const enabled = Array.isArray(task.enabledWorkflowSteps)
            ? task.enabledWorkflowSteps.includes(node.id)
            : node.config?.defaultOn === true;
          if (!enabled) {
            // FNXC:WorkflowOptionalGroup 2026-06-21-16:30: record the group's own
            // outcome on bypass too (mirrors the enabled path + every other node
            // kind), so a downstream node reading `node:<id>:outcome` from context
            // sees "success" rather than undefined — disabled is fully inert, not
            // just edge-routing-inert.
            context[`node:${node.id}:outcome`] = "success";
            // FNXC:WorkflowOptionalGroup 2026-06-22-09:00: route a disabled group
            // as a plain success with NO distinguishing value — a non-empty value
            // could let an `outcome:*` edge preempt the success edge in
            // traverseChildren, breaking the "disabled == node absent" inertness
            // invariant. (Code review: CodeRabbit.)
            return await traverseChildren(node, { outcome: "success" });
          }
          /*
           * FNXC:WorkflowStepResults 2026-06-25-12:00:
           * Record an enabled optional-group's outcome into the EXISTING
           * `task.workflowStepResults` field keyed by `node.id` (plan U2,
           * KTD-1/KTD-2/KTD-3) + emit `[pre-merge]` logs at parity with the legacy
           * `runWorkflowSteps`. A `pending` entry (with `startedAt`) is written when
           * the enabled group STARTS so the dashboard can show live status; after
           * `runOptionalGroup` returns, the entry is UPSERT-replaced by the terminal
           * record (same `startedAt`, plus `completedAt`). Disabled groups take the
           * bypass branch above and record NOTHING (byte-inert). Recording is
           * fail-soft via the optional `recordWorkflowStepResult` dep — absent → no
           * record (in-memory tests unchanged).
           */
          const groupName = typeof node.config?.name === "string" && node.config.name.trim()
            ? node.config.name.trim()
            : node.id;
          /*
          FNXC:PlanReview 2026-06-29-02:40:
          Triage runs Plan Review before releasing a task to execution so the task stays in the triage column during review. When the execution graph later reaches the same optional group, treat an existing passed Plan Review result as satisfied and do not launch a duplicate reviewer session.
          */
          if (
            node.id === PLAN_REVIEW_GROUP_ID
            && task.workflowStepResults?.some(
              (result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.status === "passed",
            )
          ) {
            context[`node:${node.id}:outcome`] = "success";
            this.deps.logTaskEntry?.("[pre-merge] Workflow step already passed: Plan Review");
            return await traverseChildren(node, { outcome: "success", value: "already-passed" });
          }
          const repairedPlanReview = node.id === PLAN_REVIEW_GROUP_ID
            ? recoverPassedPlanReviewFromLatestLog(task)
            : undefined;
          if (repairedPlanReview) {
            await this.recordOptionalGroupStepResult(task.id, repairedPlanReview);
            context[`node:${node.id}:outcome`] = "success";
            this.deps.logTaskEntry?.("[pre-merge] Workflow step already passed: Plan Review");
            return await traverseChildren(node, { outcome: "success", value: "already-passed" });
          }
          /*
           * FNXC:WorkflowPostMerge 2026-06-26-09:00:
           * Phase is read from the optional-group node's `config.phase` (defaults to
           * "pre-merge", so every existing group is byte-identical). A
           * `postMergeOptionalGroupNode` carries `phase: "post-merge"`; recorded
           * `WorkflowStepResult.phase` + the `[pre-merge]`/`[post-merge]` log prefix
           * both follow it. Post-merge groups only become reachable via the
           * flag-gated post-merge hop below; the recording/log shape is otherwise
           * identical to the pre-merge path.
           */
          const stepPhase: WorkflowStepResult["phase"] =
            node.config?.phase === "post-merge" ? "post-merge" : "pre-merge";
          const logPrefix = stepPhase === "post-merge" ? "[post-merge]" : "[pre-merge]";
          const stepStartedAt = new Date().toISOString();
          await this.recordOptionalGroupStepResult(task.id, {
            workflowStepId: node.id,
            workflowStepName: groupName,
            phase: stepPhase,
            status: "pending",
            startedAt: stepStartedAt,
          });
          this.deps.logTaskEntry?.(`${logPrefix} Starting workflow step: ${groupName}`);

          const groupResult = await runOptionalGroup(node, {
            context,
            runTemplateNode: (tNode, sig, contextOverride) =>
              this.executeNodeWithRetries(tNode, task, settings, contextOverride ?? context, ir, sig),
            shouldTraverseEdge: (edge, src) => this.shouldTraverseEdge(edge, src),
            signal: this.deps.signal,
          });
          // Map the group outcome → a WorkflowStepResult status (mirrors
          // `mapWorkflowStatus` in taskProgress.ts): a `failure` outcome (gate REVISE
          // or hard failure) → "failed"; an advisory REVISE (success outcome, REVISE
          // verdict) → "advisory_failure" (non-blocking); otherwise → "passed".
          const exitResult = groupResult.exitStepRecord;
          const verdictRaw = typeof (exitResult?.value ?? groupResult.value) === "string"
            ? (exitResult?.value ?? groupResult.value) as string
            : undefined;
          const verdict =
            verdictRaw === "APPROVE" || verdictRaw === "APPROVE_WITH_NOTES" || verdictRaw === "REVISE"
              ? verdictRaw
              : undefined;
          let stepStatus: WorkflowStepResult["status"];
          if (groupResult.outcome === "failure") stepStatus = "failed";
          else if (groupResult.value === "advisory_failure") stepStatus = "advisory_failure";
          else if (verdict === "REVISE") stepStatus = "advisory_failure";
          else stepStatus = "passed";
          const exitContextPatch = exitResult?.contextPatch;
          const stepOutput = typeof exitContextPatch?.output === "string" ? exitContextPatch.output : undefined;
          const stepNotes = typeof exitContextPatch?.notes === "string" ? exitContextPatch.notes : undefined;
          await this.recordOptionalGroupStepResult(task.id, {
            workflowStepId: node.id,
            workflowStepName: groupName,
            phase: stepPhase,
            status: stepStatus,
            ...(verdict ? { verdict } : {}),
            ...(stepOutput !== undefined ? { output: stepOutput } : {}),
            ...(stepNotes !== undefined ? { notes: stepNotes } : {}),
            startedAt: stepStartedAt,
            completedAt: new Date().toISOString(),
          });
          // `[pre-merge]`/`[post-merge]` terminal logs at parity with the legacy path
          // (executor.ts runWorkflowSteps: "completed" / "requested revision" /
          // "failed" + the advisory variant).
          if (stepStatus === "passed") {
            this.deps.logTaskEntry?.(`${logPrefix} Workflow step completed: ${groupName}`);
          } else if (stepStatus === "advisory_failure") {
            this.deps.logTaskEntry?.(`${logPrefix} Workflow step requested revision: ${groupName}`, stepOutput);
            this.deps.logTaskEntry?.(`${logPrefix} Advisory workflow step failed: ${groupName}`);
          } else if (verdict === "REVISE") {
            this.deps.logTaskEntry?.(`${logPrefix} Workflow step requested revision: ${groupName}`, stepOutput);
          } else {
            this.deps.logTaskEntry?.(`${logPrefix} Workflow step failed: ${groupName}`, stepOutput);
          }
          visitedNodeIds.push(...groupResult.visitedNodeIds);
          const result: WorkflowNodeResult = {
            outcome: groupResult.outcome,
            value: groupResult.value,
          };
          context[`node:${node.id}:outcome`] = result.outcome;
          if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;
          /*
           * FNXC:PlanReviewReplan 2026-06-29-00:41:
           * Plan Review sits between specification and execution. A REVISE verdict
           * or hard failure at this node means PROMPT.md needs another planning pass,
           * not executor remediation. Forward the failure into the same pre-merge fix
           * seam with a synthesized REVISE verdict so the executor can route it back
           * to triage and then let approved replans continue through todo/execution.
           */
          /*
           * FNXC:PlanReview 2026-06-29-02:05:
           * Plan Review should send a task back to triage only for an actual
           * REVISE verdict or a hard step failure. A malformed advisory result is
           * visible as `advisory_failure`, but it must not fabricate a plan-rewrite
           * request after the reviewer already approved or failed to emit JSON.
           */
          const shouldRequestPreMergeFix =
            stepPhase === "pre-merge"
            && (stepStatus === "advisory_failure" || stepStatus === "failed")
            && (verdict === "REVISE" || (node.id === PLAN_REVIEW_GROUP_ID && stepStatus === "failed"));
          if (shouldRequestPreMergeFix) {
            const feedback = stepOutput?.trim()
              || stepNotes?.trim()
              || (node.id === PLAN_REVIEW_GROUP_ID
                ? "Plan Review failed before execution. Re-run triage to revise PROMPT.md before implementation continues."
                : "(no feedback captured)");
            const failureContext: PreMergeOptionalStepFailureContext = {
              stepName: groupName,
              feedback,
              phase: stepPhase,
              status: stepStatus,
              verdict: verdict ?? (node.id === PLAN_REVIEW_GROUP_ID ? "REVISE" : undefined),
              nodeId: node.id,
              maxRevisions: node.config?.maxRevisions,
            };
            context[optionalStepFailureContextKey(node.id)] = failureContext;
            /*
             * FNXC:WorkflowRemediation 2026-06-29-16:22:
             * New built-in and custom workflows can author an explicit failure edge
             * from an optional review gate to a remediation/replan node. When such a
             * node exists, traversal owns the handoff so the workflow definition shows
             * the lifecycle policy. Older stored specs without that node keep the
             * compatibility scheduler here.
             */
            const remediationRouteSource: WorkflowNodeResult = { outcome: "failure", value: result.value };
            const explicitWorkflowRemediationRoute = (outgoingMap.get(node.id) ?? []).some((edge) => {
              if (!this.shouldTraverseEdge(edge, remediationRouteSource)) return false;
              const target = nodeMap.get(edge.to);
              const action = target?.config?.workflowAction;
              return action === "plan-replan" || action === "pre-merge-remediation";
            });
            if (explicitWorkflowRemediationRoute) {
              return await traverseChildren(node, remediationRouteSource);
            }
            const fixScheduled = await this.deps.requestPreMergeOptionalStepFix?.(task.id, failureContext);
            if (fixScheduled) {
              context[`node:${node.id}:fixScheduled`] = true;
              return { outcome: "success", value: "pre-merge-optional-step-fix-scheduled" };
            }
          }
          return await traverseChildren(node, result);
        }

        const workflowAction = node.config?.workflowAction;
        if (workflowAction === "plan-replan" || workflowAction === "pre-merge-remediation") {
          const stepId = typeof node.config?.forWorkflowStepId === "string"
            ? node.config.forWorkflowStepId
            : undefined;
          const failureContext = stepId
            ? context[optionalStepFailureContextKey(stepId)] as PreMergeOptionalStepFailureContext | undefined
            : undefined;
          if (!failureContext) {
            return { outcome: "failure", value: "missing-remediation-context" };
          }
          const scheduled = await this.deps.requestPreMergeOptionalStepFix?.(task.id, failureContext);
          if (!scheduled) {
            return { outcome: "failure", value: "remediation-not-scheduled" };
          }
          /*
           * FNXC:WorkflowRemediation 2026-06-29-16:27:
           * A remediation/replan node schedules asynchronous task work rather than
           * fixing the branch inside this graph call. Stop traversal after a successful
           * handoff so the rerun starts from fresh task state instead of immediately
           * re-reviewing unchanged PROMPT.md or unchanged code.
           */
          if (failureContext.nodeId) context[`node:${failureContext.nodeId}:fixScheduled`] = true;
          context[`node:${node.id}:outcome`] = "success";
          context[`node:${node.id}:value`] = "remediation-scheduled";
          return { outcome: "success", value: "remediation-scheduled" };
        }

        const result = await this.executeNodeWithRetries(node, task, settings, context, ir, this.deps.signal);
        if (result.contextPatch) Object.assign(context, result.contextPatch);
        context[`node:${node.id}:outcome`] = result.outcome;
        if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;

        return await traverseChildren(node, result);
    };

    // Recursive walk into a node. A rework region head (target of a `kind:
    // "rework"` edge) is wrapped in an iterative loop: while a downstream rework
    // edge fires back to it (returned as a ReworkSignal under budget) the head
    // re-runs; budget exhaustion re-routes the head with an
    // `outcome:rework-exhausted` source so its forward edge carries the flow out.
    // Every NON-rework back-edge still hits the cycle detector and throws.
    const walk = async (nodeId: string): Promise<WorkflowNodeResult | ReworkSignal> => {
      const node = nodeMap.get(nodeId);
      if (!node) throw new WorkflowIrError(`Unknown workflow node: ${nodeId}`);
      if (inStack.has(nodeId)) throw new WorkflowIrError(`Cycle detected at node: ${nodeId}`);
      inStack.add(nodeId);
      visitedNodeIds.push(nodeId);

      try {
        const isReworkHead = reworkHeads.has(nodeId);
        for (;;) {
          const outcome = await runNodeAndTraverse(node);
          if (!isReworkSignal(outcome)) return outcome;
          // A rework back-edge fired. It must target THIS head (the deepest
          // enclosing rework head); a signal for an outer head propagates up.
          if (!isReworkHead || outcome.headId !== nodeId) return outcome;
          const remaining = reworkBudgetFor(nodeId);
          if (remaining > 0) {
            reworkBudget.set(nodeId, remaining - 1);
            continue; // re-run the head node fresh (await-review re-evaluates)
          }
          // Budget exhausted: route the head's `outcome:rework-exhausted` forward
          // edge (mirrors the foreach node's `{outcome:"failure", value:
          // "rework-exhausted"}`). The `failure` outcome is deliberate so the
          // exhausted re-route does NOT also satisfy the head's generic
          // `condition:"success"` forward edge (which would re-enter the loop body
          // and never terminate). Never loops forever; never throws "Cycle
          // detected" for the legal rework edge.
          const exhausted = await traverseChildren(node, { outcome: "failure", value: "rework-exhausted" });
          // If no `outcome:rework-exhausted` edge exists the source bubbles back
          // (a failure outcome) — a finite, routable terminal, never an infinite loop.
          return exhausted;
        }
      } finally {
        inStack.delete(nodeId);
      }
    };

    const runLegacyMergeSeam = async (): Promise<WorkflowNodeResult> => {
      // The merge-policy primitive region is interpreter-owned policy. While the
      // legacy lifecycle remains authoritative, reaching any of its node kinds is
      // the terminal merge boundary: dispatch the same prompt/seam handler a
      // legacy `config.seam: "merge"` node used, but record it under the stable
      // legacy node id `merge` and never expose raw merge-region primitive ids.
      visitedNodeIds.push(syntheticMergeNode.id);
      const result = await this.executeNodeWithRetries(
        syntheticMergeNode,
        task,
        settings,
        context,
        ir,
        this.deps.signal,
      );
      if (result.contextPatch) Object.assign(context, result.contextPatch);
      context[`node:${syntheticMergeNode.id}:outcome`] = result.outcome;
      if (result.value !== undefined) context[`node:${syntheticMergeNode.id}:value`] = result.value;
      return result;
    };

    const traverseChildren = async (
      node: WorkflowIrNode,
      sourceResult: WorkflowNodeResult,
    ): Promise<WorkflowNodeResult | ReworkSignal> => {
      const edges = outgoingMap.get(node.id) ?? [];
      if (edges.length === 0) {
        return sourceResult;
      }

      const outcomeMatching = edges.filter((edge) =>
        edge.condition?.startsWith("outcome:") && this.shouldTraverseEdge(edge, sourceResult)
      );
      const matching = outcomeMatching.length > 0
        ? outcomeMatching
        : edges.filter((edge) => this.shouldTraverseEdge(edge, sourceResult));
      if (matching.length === 0) {
        return sourceResult;
      }

      let aggregate: WorkflowNodeResult = sourceResult;
      // Forward edges first, deterministic by target id (matches prior ordering);
      // a rework edge is a loop-back and is handled distinctly below.
      for (const edge of matching.sort((a, b) => a.to.localeCompare(b.to))) {
        // Rework back-edge: do NOT recurse (the head is on the stack — that would
        // be a cycle). Bubble a ReworkSignal up to the head's iterative loop.
        if (edge.kind === "rework" && inStack.has(edge.to)) {
          return { __rework: true, headId: edge.to, source: sourceResult } satisfies ReworkSignal;
        }
        const target = nodeMap.get(edge.to);
        if (target?.kind === "end") {
          aggregate = sourceResult;
          continue;
        }
        if (target && isMergeRegionKind(target.kind)) {
          aggregate = await runLegacyMergeSeam();
          if (aggregate.outcome === "failure") break;
          /*
           * FNXC:WorkflowPostMerge 2026-06-26-09:00:
           * Flag-gated post-merge hop. The merge already finished (the seam awaited the
           * merge Promise), so this runs strictly AFTER a successful merge. Walk each
           * post-merge entry node via the normal `walk` path (optional-group recording
           * with phase:"post-merge"). Advisory post-merge failures are NON-BLOCKING —
           * they record a result but DO NOT mutate `aggregate`, so the merged task still
           * completes with the merge-success outcome (matching legacy post-merge
           * semantics). Explicit gate-mode post-merge failures do block final graph
           * success so configured post-merge verification can prevent final done. When
           * the flag is OFF, `postMergeEntryNodeIds` is empty and this loop is inert, so
           * the merge region stays exactly as collapsed before.
           */
          for (const entryId of postMergeEntryNodeIds) {
            /*
             * FNXC:WorkflowPostMerge 2026-06-29-11:47:
             * Post-merge verification has two policies: advisory checks keep the
             * legacy non-blocking behavior, while explicit gate-mode checks are allowed
             * to block final workflow success after merge proof. Traversal errors remain
             * logged/non-blocking because a malformed post-merge authoring path should
             * not overwrite already-proven merge state.
             */
            try {
              const postMerge = await walk(entryId);
              // A post-merge entry node is never an enclosing rework head, so a
              // ReworkSignal here would be malformed IR; ignore it rather than bubble a
              // rework loop out of the merge boundary.
              if (!isReworkSignal(postMerge) && postMerge.outcome === "failure") {
                aggregate = postMerge;
                break;
              }
            } catch (err) {
              this.deps.logTaskEntry?.(
                `[post-merge] traversal error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (aggregate.outcome === "failure") break;
          continue;
        }
        const child = await walk(edge.to);
        // A ReworkSignal propagated from deeper: bubble it further up unchanged.
        if (isReworkSignal(child)) return child;
        if (child.outcome === "failure") {
          aggregate = child;
          break;
        }
        aggregate = child;
      }
      return aggregate;
    };

    const terminal = await walk(startNode.id);
    if (isReworkSignal(terminal)) {
      // A rework edge whose target is not an enclosing head on the stack — i.e. a
      // rework edge pointing at a node never entered as a loop head. Malformed IR.
      throw new WorkflowIrError(`Rework edge targets a node that is not a region head: ${terminal.headId}`);
    }
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

  /*
   * FNXC:WorkflowStepResults 2026-06-25-12:00:
   * Fail-soft forward to the `recordWorkflowStepResult` persistence sink (plan U2).
   * Recording is additive visibility bookkeeping — a sink failure (or absent sink)
   * must NEVER affect graph execution, so swallow errors and no-op when unwired.
   */
  private async recordOptionalGroupStepResult(taskId: string, result: WorkflowStepResult): Promise<void> {
    if (!this.deps.recordWorkflowStepResult) return;
    try {
      await this.deps.recordWorkflowStepResult(taskId, result);
    } catch {
      // Result recording is additive — a failure must not affect the run.
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

  private normalizePluginNodeResult(result: WorkflowNodeExtensionResult): WorkflowNodeResult {
    if (result.outcome === "success" || result.outcome === "failure") {
      return result;
    }
    return {
      outcome: "success",
      value: result.value ?? result.outcome.slice("outcome:".length),
      contextPatch: result.contextPatch,
    };
  }

  private async executePluginNodeHandler(
    node: WorkflowIrNode,
    task: TaskDetail,
    workflow: WorkflowIr,
    context: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowNodeResult | undefined> {
    const extensionIds = Object.keys(node.extensions ?? {});
    if (extensionIds.length === 0) return undefined;

    const registry = getWorkflowExtensionRegistry();
    for (const extensionId of extensionIds) {
      const definition = registry.get(extensionId);
      const extension = definition?.extension;
      if (!definition || definition.degraded || extension?.kind !== "node-handler" || !extension.handle) continue;
      if (extension.nodeKind && extension.nodeKind !== node.kind) continue;
      try {
        const result = await extension.handle({
          task,
          workflow,
          node,
          context,
          signal,
        });
        return this.normalizePluginNodeResult(result);
      } catch (error) {
        if (extension.fallback === "degradeToDefault") {
          try {
            registry.degrade(
              [definition.id],
              "runtime-fault",
              error instanceof Error ? error.message : String(error),
            );
          } catch {
            // Degradation is best-effort; falling through to the default node
            // handler is still the correct fallback for this invocation.
          }
          continue;
        }
        return {
          outcome: "failure",
          value: "plugin-node-handler-error",
          contextPatch: {
            [`node:${node.id}:error`]: error instanceof Error ? error.message : String(error),
            [`node:${node.id}:extensionId`]: extensionId,
          },
        };
      }
    }

    return undefined;
  }

  private async executeNodeWithRetries(
    node: WorkflowIrNode,
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    context: Record<string, unknown>,
    workflow: WorkflowIr,
    signal?: AbortSignal,
  ): Promise<WorkflowNodeResult> {
    const handler = this.handlers[node.kind];

    // Per-node override: config.maxRetries beats the executor-wide default.
    const configured = Number(node.config?.maxRetries);
    const maxAttempts = Number.isFinite(configured) && configured >= 1
      ? Math.min(10, Math.floor(configured))
      : this.maxRetriesPerNode;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Fail-fast cancellation: a branch or top-level graph abort mid-retry stops re-trying.
      if (signal?.aborted) return this.withEnginePauseAbortContext(node, { outcome: "failure", value: "aborted" });
      try {
        await this.prepareNodeExecution(node, task);
        const pluginResult = await this.executePluginNodeHandler(node, task, workflow, context, signal);
        if (pluginResult) {
          const projected = await this.publishTaskProjectionFromResult(task.id, node, pluginResult);
          return signal?.aborted || this.isAbortNodeResult(projected)
            ? this.withEnginePauseAbortContext(node, projected)
            : projected;
        }
        if (!handler) {
          throw new WorkflowIrError(`No handler registered for node kind: ${node.kind}`);
        }
        const result = await handler(node, { task, settings, context, signal });
        const projected = await this.publishTaskProjectionFromResult(task.id, node, result);
        return signal?.aborted || this.isAbortNodeResult(projected)
          ? this.withEnginePauseAbortContext(node, projected)
          : projected;
      } catch (error) {
        if (signal?.aborted) return this.withEnginePauseAbortContext(node, { outcome: "failure", value: "aborted" });
        lastError = error;
      }
    }

    if (signal?.aborted) {
      return this.withEnginePauseAbortContext(node, { outcome: "failure", value: "aborted" });
    }

    return {
      outcome: "failure",
      value: "exception",
      contextPatch: {
        [`node:${node.id}:error`]: lastError instanceof Error ? lastError.message : String(lastError),
      },
    };
  }

  private async prepareNodeExecution(node: WorkflowIrNode, task: TaskDetail): Promise<void> {
    const requirement = this.classifyNodePreparation(node);
    if (!requirement.requiresWorktree) return;
    await this.deps.prepareNodeExecution?.(node, task, requirement);
  }

  private classifyNodePreparation(node: WorkflowIrNode): WorkflowNodePreparationRequirement {
    const cfg = node.config ?? {};
    const executorKind = typeof cfg.executor === "string" ? cfg.executor : "model";
    const hasScriptName = typeof cfg.scriptName === "string" && cfg.scriptName.trim().length > 0;
    const hasCliCommand = executorKind === "cli" && typeof cfg.cliCommand === "string" && cfg.cliCommand.trim().length > 0;
    const requiresWorktree =
      cfg.toolMode === "coding"
      || node.kind === "script"
      || executorKind === "cli-agent"
      || hasScriptName
      || hasCliCommand;
    return {
      requiresWorktree,
      reason: requiresWorktree ? "write-capable-node" : undefined,
    };
  }

  private isAbortNodeResult(result: WorkflowNodeResult): boolean {
    return result.outcome === "failure" && result.value === "aborted";
  }

  private withEnginePauseAbortContext(node: WorkflowIrNode, result: WorkflowNodeResult): WorkflowNodeResult {
    /*
    FNXC:WorkflowLifecycle 2026-06-28-18:15:
    FN-7214 requires engine-pause aborts of in-flight workflow nodes to be re-entrant at the node boundary. Stamp a typed abort marker on the node result so executor recovery can re-run the graph without conflating this interruption with genuine node failures such as REVISE, projection errors, or exceptions.
    */
    return {
      ...result,
      outcome: "failure",
      value: result.value ?? "aborted",
      contextPatch: {
        ...(result.contextPatch ?? {}),
        [`node:${node.id}:abortKind`]: WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND,
        [WORKFLOW_INTERRUPTED_NODE_ID_CONTEXT_KEY]: node.id,
        [WORKFLOW_INTERRUPTED_NODE_ABORT_KIND_CONTEXT_KEY]: WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND,
      },
    };
  }

  private async publishTaskProjectionFromResult(
    taskId: string,
    node: WorkflowIrNode,
    result: WorkflowNodeResult,
  ): Promise<WorkflowNodeResult> {
    const patch = extractTaskProjection(result.contextPatch);
    if (!hasTaskProjection(patch)) return result;
    const source = { nodeId: node.id, nodeKind: node.kind };
    try {
      await this.deps.publishTaskProjection?.(taskId, patch, source);
    } catch (error) {
      return {
        outcome: "failure",
        value: "projection-error",
        contextPatch: {
          ...(result.contextPatch ?? {}),
          [`node:${node.id}:projectionError`]: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (patch.modifiedFiles && patch.modifiedFiles.length > 0) {
      try {
        await this.deps.publishTouchedFiles?.(taskId, patch.modifiedFiles, source);
      } catch {
        // Deprecated compatibility hook; primary projection persistence owns node outcome.
      }
    }
    return result;
  }
}

function recoverPassedPlanReviewFromLatestLog(task: TaskDetail): WorkflowStepResult | undefined {
  /*
   * FNXC:WorkflowLifecycle 2026-06-29-03:55:
   * FN-7228 exposed persisted tasks where Plan Review completed successfully but
   * later cleanup erased `workflowStepResults`, leaving the dashboard with an
   * enabled Plan Review step and no status. Trust only the latest Plan Review
   * terminal log: completed repairs the missing projection; failed still blocks
   * and reruns/replans through the normal path.
   */
  let latest: { status: "passed" | "failed"; timestamp?: string; outcome?: string } | undefined;
  for (const entry of task.log ?? []) {
    if (entry.action === "[pre-merge] Workflow step completed: Plan Review") {
      latest = { status: "passed", timestamp: entry.timestamp, outcome: entry.outcome };
    } else if (entry.action === "[pre-merge] Workflow step failed: Plan Review") {
      latest = { status: "failed", timestamp: entry.timestamp, outcome: entry.outcome };
    }
  }
  if (latest?.status !== "passed") return undefined;
  return {
    workflowStepId: PLAN_REVIEW_GROUP_ID,
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    status: "passed",
    verdict: "APPROVE",
    ...(latest.outcome ? { notes: latest.outcome } : {}),
    startedAt: latest.timestamp,
    completedAt: latest.timestamp,
  };
}
