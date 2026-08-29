import type { Settings, TaskDetail, WorkflowIrEdge, WorkflowIrNode } from "@fusion/core";
import { WorkflowIrError } from "@fusion/core";

import type { WorkflowNodeOutcome, WorkflowNodeResult } from "./workflow-graph-executor.js";
import { schedulerLog } from "../logger.js";

/**
 * Concurrent fan-out/join branch execution (U13, KTD-11, R21).
 *
 * When the sequential walker reaches a `split` node, every outgoing edge becomes
 * a branch that walks concurrently up to the matching `join`. The join then
 * synchronizes per its config (`all | any | quorum(n)`) and either fails fast
 * (cancelling siblings via an AbortSignal) or collects all branch outcomes.
 *
 * This module owns ONLY the parallel window: it is handed a `runBranchNode`
 * callback that reuses the executor's per-node retry logic, and a small set of
 * graph lookups. The card's board position never forks — that invariant is
 * upheld by the executor (no handler-driven column moves happen here).
 */

/** Per-branch persisted run state (ADR-0001 reconstructible). */
export interface WorkflowBranchRunState {
  taskId: string;
  runId: string;
  branchId: string;
  /** Node the branch is currently at / last completed. */
  currentNodeId: string;
  status: "running" | "completed" | "failed" | "aborted";
}

/**
 * Persistence callback surface. Kept as an injected interface so the executor
 * stays DI-pure and fake-friendly; the SQLite-backed implementation is wired
 * separately (see workflow_run_branches table). All methods are optional so a
 * fully in-memory run (tests, flag-off) needs no persistence at all.
 */
export interface WorkflowBranchPersistence {
  /** Idempotent upsert of a branch's progress, keyed by (taskId, runId, branchId). */
  saveBranchState?(state: WorkflowBranchRunState): void | Promise<void>;
  /** Load any persisted branch states for a run (used on resume). */
  loadBranchStates?(taskId: string, runId: string): WorkflowBranchRunState[] | Promise<WorkflowBranchRunState[]>;
  /**
   * Prune stale branch rows for a task, keeping only `keepRunId` (#1412).
   * Called on run start and run completion to bound unbounded growth across a
   * long-lived task's repeated runs.
   */
  clearStaleBranchStates?(taskId: string, keepRunId: string): void | Promise<void>;
}

/**
 * Await a `saveBranchState` call inside a guard so a Promise-returning impl
 * cannot escape as an unhandled rejection, and so a persistence failure never
 * kills branch execution (log-and-continue). For a synchronous impl this
 * preserves the prior behavior (the write completes before the caller proceeds).
 */
async function persistBranchState(
  persistence: WorkflowBranchPersistence | undefined,
  state: WorkflowBranchRunState,
): Promise<void> {
  try {
    await persistence?.saveBranchState?.(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulerLog.warn(
      `saveBranchState failed for task ${state.taskId} run ${state.runId} branch ${state.branchId}: ${message}`,
    );
  }
}

/** Minimal semaphore shape — structurally compatible with AgentSemaphore. */
export interface WorkflowBranchSemaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** Snapshot of a single branch's progress, surfaced for dashboard badges (U9). */
export interface WorkflowBranchProgress {
  branchId: string;
  nodeId: string;
  status: WorkflowBranchRunState["status"];
}

export interface BranchEnvironment {
  task: TaskDetail;
  settings: Pick<Settings, "experimentalFeatures"> | undefined;
  runId: string;
  nodeMap: Map<string, WorkflowIrNode>;
  outgoingMap: Map<string, WorkflowIrEdge[]>;
  /** Reuses the executor's executeNodeWithRetries (+ context bookkeeping). */
  runBranchNode: (
    node: WorkflowIrNode,
    signal: AbortSignal,
  ) => Promise<WorkflowNodeResult>;
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean;
  persistence?: WorkflowBranchPersistence;
  semaphore?: WorkflowBranchSemaphore;
  /** Reports live per-branch progress for the card (no column move). */
  onBranchProgress?: (progress: WorkflowBranchProgress) => void;
  /** Node IDs already completed in a prior (crashed) run — skipped on resume. */
  completedNodeIds?: Set<string>;
}

export interface SplitJoinResult {
  /** The join node where branches converged. */
  joinNodeId: string;
  /** Join outcome: success if the mode was satisfied, else failure. */
  outcome: WorkflowNodeOutcome;
  /** Per-branch outcomes, exposed so the join's outgoing edge conditions can read them. */
  branchOutcomes: { branchId: string; outcome: WorkflowNodeOutcome; nodeId: string }[];
  /** Node IDs visited across all branches (for the executor's visited list). */
  visitedNodeIds: string[];
}

interface ResolvedJoinConfig {
  mode: "all" | "any" | { quorum: number };
  onBranchFailure: "fail-fast" | "collect";
}

function resolveJoinConfig(join: WorkflowIrNode): ResolvedJoinConfig {
  const rawMode = join.config?.mode;
  let mode: ResolvedJoinConfig["mode"] = "all";
  if (rawMode === "all" || rawMode === "any") mode = rawMode;
  else if (rawMode && typeof rawMode === "object" && "quorum" in rawMode) {
    const n = (rawMode as { quorum: unknown }).quorum;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) mode = { quorum: n };
    else throw new WorkflowIrError(`join '${join.id}' quorum must be a positive integer`);
  }
  const rawFail = join.config?.onBranchFailure;
  const onBranchFailure: ResolvedJoinConfig["onBranchFailure"] =
    rawFail === "collect" ? "collect" : "fail-fast";
  return { mode, onBranchFailure };
}

/** How many successful completions satisfy this join mode for `branchCount` branches. */
function requiredCompletions(mode: ResolvedJoinConfig["mode"], branchCount: number): number {
  if (mode === "all") return branchCount;
  if (mode === "any") return 1;
  return Math.min(mode.quorum, branchCount);
}

/**
 * Execute a split's branches concurrently and synchronize at the join.
 *
 * Returns once the join is satisfied (or definitively cannot be). Sibling
 * branches are aborted on fail-fast via the shared AbortSignal; on collect they
 * are awaited. Nested splits recurse: a branch walk that itself hits a `split`
 * calls back into this function for its inner window.
 */
export async function runSplitJoin(
  split: WorkflowIrNode,
  env: BranchEnvironment,
): Promise<SplitJoinResult> {
  const branchEdges = (env.outgoingMap.get(split.id) ?? []).filter(
    (e) => env.shouldTraverseEdge(e, { outcome: "success" }),
  );
  if (branchEdges.length === 0) {
    throw new WorkflowIrError(`split '${split.id}' has no traversable branches`);
  }

  const join = findMatchingJoin(branchEdges[0].to, env);
  if (!join) throw new WorkflowIrError(`split '${split.id}' has no reachable matching join`);
  const joinConfig = resolveJoinConfig(env.nodeMap.get(join)!);

  const controller = new AbortController();
  const branchCount = branchEdges.length;
  const required = requiredCompletions(joinConfig.mode, branchCount);

  const visitedNodeIds: string[] = [];
  const branchOutcomes: SplitJoinResult["branchOutcomes"] = [];
  let succeeded = 0;
  let failed = 0;
  let settled = false;
  let resolveJoin!: (outcome: WorkflowNodeOutcome) => void;
  const joinReached = new Promise<WorkflowNodeOutcome>((res) => {
    resolveJoin = res;
  });

  const settle = (outcome: WorkflowNodeOutcome): void => {
    if (settled) return;
    settled = true;
    resolveJoin(outcome);
  };

  // Re-evaluate the join after each branch settles. `lastWasFailure` only
  // affects fail-fast (one failure cancels siblings immediately).
  const evaluateJoin = (lastWasFailure: boolean): void => {
    if (settled) return;
    if (joinConfig.onBranchFailure === "fail-fast" && lastWasFailure) {
      controller.abort();
      settle("failure");
      return;
    }
    if (succeeded >= required) {
      // Mode satisfied. Fail-fast cancels any laggards; collect lets them finish.
      if (joinConfig.onBranchFailure === "fail-fast") controller.abort();
      settle("success");
      return;
    }
    if (succeeded + failed >= branchCount) {
      // All branches settled but the mode is unmet.
      settle("failure");
    }
  };

  const branchPromises = branchEdges.map((edge) => {
    const branchId = edge.to;
    return walkBranch(branchId, join, env, controller.signal, visitedNodeIds)
      .then((result) => {
        branchOutcomes.push({ branchId, outcome: result.outcome, nodeId: result.lastNodeId });
        if (result.outcome === "success") succeeded += 1;
        else failed += 1;
        evaluateJoin(result.outcome === "failure");
      })
      .catch((err) => {
        // An aborted branch settles silently; any other throw fails the join.
        if (controller.signal.aborted) {
          branchOutcomes.push({ branchId, outcome: "failure", nodeId: branchId });
          return;
        }
        failed += 1;
        branchOutcomes.push({ branchId, outcome: "failure", nodeId: branchId });
        evaluateJoin(true);
        void err;
      });
  });

  // Wait for the join to resolve, then let in-flight branches settle so collect
  // semantics (and persistence writes) complete before we return.
  const outcome = await joinReached;
  await Promise.allSettled(branchPromises);

  return { joinNodeId: join, outcome, branchOutcomes, visitedNodeIds };
}

interface BranchWalkResult {
  outcome: WorkflowNodeOutcome;
  lastNodeId: string;
}

/**
 * Walk a single branch from `startNodeId` up to (but not including) the join.
 * Reuses the injected per-node runner; supports nested splits by recursing into
 * runSplitJoin. Honors the AbortSignal (fail-fast cancellation) and skips nodes
 * already completed in a prior run (crash resume idempotency).
 */
async function walkBranch(
  startNodeId: string,
  joinId: string,
  env: BranchEnvironment,
  signal: AbortSignal,
  visitedNodeIds: string[],
): Promise<BranchWalkResult> {
  let currentId = startNodeId;
  let lastResult: WorkflowNodeResult = { outcome: "success" };

  for (;;) {
    if (signal.aborted) return { outcome: "failure", lastNodeId: currentId };
    if (currentId === joinId) return { outcome: lastResult.outcome, lastNodeId: currentId };

    const node = env.nodeMap.get(currentId);
    if (!node) throw new WorkflowIrError(`Unknown workflow node: ${currentId}`);

    if (node.kind === "split") {
      // Nested split: resolve its inner window, then continue from the inner join.
      const inner = await runSplitJoin(node, env);
      visitedNodeIds.push(...inner.visitedNodeIds);
      lastResult = { outcome: inner.outcome };
      const next = nextEdge(inner.joinNodeId, env, lastResult);
      if (!next) return { outcome: inner.outcome, lastNodeId: inner.joinNodeId };
      currentId = next;
      continue;
    }

    visitedNodeIds.push(currentId);

    const alreadyDone = env.completedNodeIds?.has(currentId) ?? false;
    if (alreadyDone) {
      lastResult = { outcome: "success" };
    } else {
      const exec = async (): Promise<WorkflowNodeResult> => env.runBranchNode(node, signal);
      lastResult = env.semaphore ? await env.semaphore.run(exec) : await exec();
      await persistBranchState(env.persistence, {
        taskId: env.task.id,
        runId: env.runId,
        branchId: startNodeId,
        currentNodeId: currentId,
        status: lastResult.outcome === "success" ? "running" : "failed",
      });
      env.onBranchProgress?.({
        branchId: startNodeId,
        nodeId: currentId,
        status: lastResult.outcome === "success" ? "running" : "failed",
      });
    }

    if (lastResult.outcome === "failure") {
      await persistBranchState(env.persistence, {
        taskId: env.task.id,
        runId: env.runId,
        branchId: startNodeId,
        currentNodeId: currentId,
        status: "failed",
      });
      return { outcome: "failure", lastNodeId: currentId };
    }

    const next = nextEdge(currentId, env, lastResult);
    if (!next) {
      // Dead-end before the join — treat as branch completion.
      return { outcome: lastResult.outcome, lastNodeId: currentId };
    }
    if (next === joinId) {
      await persistBranchState(env.persistence, {
        taskId: env.task.id,
        runId: env.runId,
        branchId: startNodeId,
        currentNodeId: currentId,
        status: "completed",
      });
      env.onBranchProgress?.({ branchId: startNodeId, nodeId: currentId, status: "completed" });
      return { outcome: lastResult.outcome, lastNodeId: currentId };
    }
    currentId = next;
  }
}

/** The next node along a matching outgoing edge, or undefined if none matches. */
function nextEdge(
  nodeId: string,
  env: BranchEnvironment,
  source: WorkflowNodeResult,
): string | undefined {
  const edges = (env.outgoingMap.get(nodeId) ?? [])
    .filter((e) => env.shouldTraverseEdge(e, source))
    .sort((a, b) => a.to.localeCompare(b.to));
  return edges[0]?.to;
}

/**
 * Find the join node a branch starting at `startNodeId` converges on. Walks
 * forward through the (non-failure) edges; recurses one level for nested splits
 * so balanced nesting resolves to the correct outer join.
 */
function findMatchingJoin(startNodeId: string, env: BranchEnvironment): string | undefined {
  const seen = new Set<string>();
  let currentId: string | undefined = startNodeId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const node = env.nodeMap.get(currentId);
    if (!node) return undefined;
    if (node.kind === "join") return currentId;
    if (node.kind === "split") {
      const innerJoin = findMatchingJoin(
        (env.outgoingMap.get(currentId) ?? [])[0]?.to ?? "",
        env,
      );
      if (!innerJoin) return undefined;
      currentId = (env.outgoingMap.get(innerJoin) ?? []).find((e) => e.condition !== "failure")?.to;
      continue;
    }
    const out = env.outgoingMap.get(currentId) ?? [];
    currentId = out.find((e) => e.condition !== "failure")?.to ?? out[0]?.to;
  }
  return undefined;
}
