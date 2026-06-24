import type {
  Settings,
  TaskDetail,
  TaskStep,
  WorkflowIr,
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrNodeKind,
  WorkflowNodeExtensionResult,
} from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR, WorkflowIrError, getWorkflowExtensionRegistry, resolveMaxReworkCycles } from "@fusion/core";

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

export interface WorkflowNodeResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  contextPatch?: Record<string, unknown>;
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

export interface WorkflowGraphExecutorDeps {
  handlers?: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;
  /** Workflow-native runtime primitives. When present, default nodes call these
   *  directly instead of legacy executor/reviewer/merge seams. */
  primitives?: WorkflowRuntimePrimitives;
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
          const enabled = task.enabledWorkflowSteps?.includes(node.id) ?? false;
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
          const groupResult = await runOptionalGroup(node, {
            context,
            runTemplateNode: (tNode, sig, contextOverride) =>
              this.executeNodeWithRetries(tNode, task, settings, contextOverride ?? context, ir, sig),
            shouldTraverseEdge: (edge, src) => this.shouldTraverseEdge(edge, src),
            signal: this.deps.signal,
          });
          visitedNodeIds.push(...groupResult.visitedNodeIds);
          const result: WorkflowNodeResult = {
            outcome: groupResult.outcome,
            value: groupResult.value,
          };
          context[`node:${node.id}:outcome`] = result.outcome;
          if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;
          return await traverseChildren(node, result);
        }

        const result = await this.executeNodeWithRetries(node, task, settings, context, ir);
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
      // Fail-fast cancellation: a branch aborted mid-retry stops re-trying.
      if (signal?.aborted) return { outcome: "failure", value: "aborted" };
      try {
        const pluginResult = await this.executePluginNodeHandler(node, task, workflow, context, signal);
        if (pluginResult) {
          return await this.publishTaskProjectionFromResult(task.id, node, pluginResult);
        }
        if (!handler) {
          throw new WorkflowIrError(`No handler registered for node kind: ${node.kind}`);
        }
        const result = await handler(node, { task, settings, context, signal });
        return await this.publishTaskProjectionFromResult(task.id, node, result);
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
