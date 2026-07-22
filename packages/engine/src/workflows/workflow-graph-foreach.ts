import type { TaskDetail, TaskStep, WorkflowIrEdge, WorkflowIrNode } from "@fusion/core";
import { WorkflowIrError, instanceNodeId, resolveMaxReworkCycles } from "@fusion/core";

import type { WorkflowNodeOutcome, WorkflowNodeResult } from "./workflow-graph-executor.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  INTEGRATION_CONFLICT_CONTEXT_KEY,
  type ForeachActiveContext,
} from "./workflow-node-handlers.js";
import {
  IntegrationQueue,
  type IntegrationGitOps,
  type IntegrationProjection,
} from "../execution/step-integration.js";
import { schedulerLog } from "../logger.js";

/**
 * Foreach region expansion + instance sub-walk (step-inversion KTD-3/KTD-5, U3).
 *
 * When the sequential walker reaches a `foreach` node it does NOT recurse through
 * the main `walk` (whose `inStack` cycle detector intentionally throws on any
 * back-edge). Instead it hands control here, which:
 *
 *   - reads `Task.steps[]` and pins the count at expansion time;
 *   - for each step `i` in order, runs the inline template subgraph as an
 *     **iterative region sub-walk** (a `for(;;)` over `currentId`, modeled on
 *     `walkBranch` in workflow-graph-branches.ts), from the template entry to its
 *     exit, materializing deterministic instance node ids
 *     `<foreachId>#<i>:<templateNodeId>` purely as walk state (the IR/nodeMap are
 *     never mutated);
 *   - permits `kind: "rework"` edges as the only legal cycles — each traversal
 *     decrements a per-instance budget seeded from `config.maxReworkCycles`
 *     (default 3, defensively clamped to ≤10); exhaustion emits the
 *     `outcome:rework-exhausted` outcome from the foreach node;
 *   - threads the active instance under the reserved `foreach:active` context key
 *     so template handlers (step-execute now; step-review in U5) know which step
 *     they operate on, clearing it on instance exit;
 *   - honors the abort signal between nodes (existing posture).
 *
 * Only sequential + shared physics are implemented here (concurrency 1). The
 * scheduler is intentionally a runnable-set loop running one instance at a time
 * so U10 can extend it to parallel/worktree without restructuring. Parallel mode
 * is guarded to a clean failure (U10 replaces it).
 */

// Rework budget default + clamp live in @fusion/core (DEFAULT_MAX_REWORK_CYCLES /
// MAX_REWORK_CYCLES_CAP / resolveMaxReworkCycles) so the foreach sub-walk and the
// top-level PR review loop (U6) share one definition and cannot drift.
/** Default parallel concurrency (KTD-3). */
const DEFAULT_CONCURRENCY = 2;
/** Hard cap on parallel concurrency (KTD-3). */
const CONCURRENCY_CAP = 8;

/** The foreach node's config shape this module reads (subset of WorkflowForeachConfig). */
interface ForeachConfig {
  source?: unknown;
  maxReworkCycles?: number;
  mode?: "sequential" | "parallel";
  concurrency?: number;
  isolation?: "shared" | "worktree";
  template?: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
}

/**
 * Narrow persistence hook for foreach instance run-state (KTD-6, U3 stub).
 *
 * The real SQLite-backed adapter lands in U4 (executor half); this interface is
 * shaped so that wiring is a pure additive change. All methods are optional and
 * default to no-ops — the sub-walk calls them at instance start / completion /
 * each rework pass, but a fully in-memory run (tests, flag-off, pre-U4 store)
 * needs none of them. Instance identity is deterministic
 * (`<foreachNodeId>#<stepIndex>`), so a future resume can seed the sub-walk
 * position directly from a loaded `currentNodeId` + `reworkCount` (KTD-6) —
 * this hook is the seam where that seeding will plug in.
 */
export interface WorkflowStepInstanceState {
  taskId: string;
  runId: string;
  foreachNodeId: string;
  stepIndex: number;
  pinnedStepCount: number;
  /** Template node id (NOT the materialized instance id) the instance is at. */
  currentNodeId: string;
  status: "in-progress" | "awaiting-integration" | "completed" | "failed";
  baselineSha?: string;
  checkpointId?: string;
  reworkCount: number;
  /** Latest authoritative step-review verdict (KTD-4/KTD-6, U5). */
  verdict?: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  /** Worktree-isolation (KTD-11, U10): the instance's own branch name; null/absent
   *  under shared isolation. */
  branchName?: string;
  /** Worktree-isolation (KTD-11, U10): ISO timestamp the branch integrated; absent
   *  until the ordered integration stage lands it. */
  integratedAt?: string;
}

export interface WorkflowStepInstancePersistence {
  /** Idempotent upsert keyed by (taskId, runId, foreachNodeId, stepIndex). */
  saveInstanceState?(state: WorkflowStepInstanceState): void | Promise<void>;
  /** Load any persisted instance states for a run (used on resume — U4). */
  loadInstanceStates?(
    taskId: string,
    runId: string,
  ): WorkflowStepInstanceState[] | Promise<WorkflowStepInstanceState[]>;
  /** Prune stale instance rows for a task, keeping only `keepRunId` (U4). */
  clearStaleInstanceStates?(taskId: string, keepRunId: string): void | Promise<void>;
}

/**
 * Await a persistence call inside a guard so a Promise-returning impl cannot
 * escape as an unhandled rejection, and a persistence failure never kills
 * instance execution (log-and-continue). Mirrors `persistBranchState`.
 */
async function persistInstanceState(
  persistence: WorkflowStepInstancePersistence | undefined,
  state: WorkflowStepInstanceState,
): Promise<void> {
  try {
    await persistence?.saveInstanceState?.(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulerLog.warn(
      `saveInstanceState failed for task ${state.taskId} run ${state.runId} foreach ${state.foreachNodeId} step ${state.stepIndex}: ${message}`,
    );
  }
}

export interface ForeachEnvironment {
  task: TaskDetail;
  runId: string;
  /** Fresh step list (KTD-3: read at expansion, count pinned). */
  steps: TaskStep[];
  /** Optional live step projection reader used during restart/replay checks. */
  getLiveSteps?: () => Promise<TaskStep[]> | TaskStep[];
  /** The shared walk context; the active-instance key is threaded in/out of it. */
  context: Record<string, unknown>;
  /**
   * Runs one template node through the executor's executeNodeWithRetries (so
   * per-node maxRetries still applies inside the sub-walk). The node passed is
   * the ORIGINAL template node; the executor reads/writes the supplied context,
   * which carries `foreach:active` for the current instance.
   *
   * `contextOverride` lets a worktree-isolated instance run on its OWN context
   * object (KTD-11): under parallel scheduling concurrent instances must NOT share
   * the single `foreach:active` slot, so each gets an isolated context clone. When
   * omitted the shared `env.context` is used (shared-isolation sequential path —
   * unchanged behavior).
   */
  runTemplateNode: (
    node: WorkflowIrNode,
    signal?: AbortSignal,
    contextOverride?: Record<string, unknown>,
  ) => Promise<WorkflowNodeResult>;
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean;
  persistence?: WorkflowStepInstancePersistence;
  /**
   * RETHINK reset-on-rework hook (KTD-4, U5). Invoked BEFORE re-entering the
   * instance's step-execute node when the rework edge being traversed was
   * triggered by an `outcome:rethink` (the verdict that resets to baseline). The
   * production wiring (executor.ts) calls `resetStepToBaseline` with the
   * instance's persisted `baselineSha`/`checkpointId`; tests inject a fake. Other
   * rework outcomes (e.g. `revise`) do NOT call this — they revise in place
   * (today's REVISE semantics). Optional with a no-op default.
   */
  onReworkReset?: (
    active: ForeachActiveContext,
    reason: string,
  ) => void | Promise<void>;
  /** Honored between nodes (existing posture). */
  signal?: AbortSignal;

  // ── Worktree isolation + parallel scheduling (KTD-11, U10) ────────────────
  /**
   * Allocate the instance's OWN worktree + branch off the current integration
   * base (the task's main branch tip at instance start). Production wires this to
   * the worktree pool / `createWorktree` with a canonical
   * `fusion/<task>-step-<i>` branch name; tests inject a fake. Required when
   * `isolation: "worktree"`; absent under shared isolation. The integration base
   * is the SAME for sibling instances scheduled together (they branch from the
   * common tip), and is the UPDATED main tip when an instance re-runs after an
   * integration-conflict rework.
   */
  allocateInstanceWorktree?: (
    stepIndex: number,
    integrationBase: string | undefined,
  ) => Promise<{ worktreePath: string; branchName: string }>;
  /** Resolve the current integration base (main branch tip). Re-read before each
   *  (re)allocation so a rework lands on the UPDATED base (KTD-11). Optional —
   *  defaults to undefined (the allocator's own default base). */
  resolveIntegrationBase?: () => Promise<string | undefined>;
  /** Ordered-integration git mechanics (KTD-11). Required when `isolation:
   *  "worktree"`; the queue uses it to land branches in step order. */
  integrationGitOps?: IntegrationGitOps;
  /**
   * Projection + instance-row writes the integration stage performs on a clean
   * integration (KTD-7 projection-first ordering). `markStepDone` flips the step
   * `done` via `updateStep(source:"graph")`; `markInstanceIntegrated` flips the
   * row to `completed`/`integratedAt`. Required when `isolation: "worktree"`.
   */
  integrationProjection?: IntegrationProjection;
  /**
   * Non-blocking semaphore availability accessor for parallel scheduling (KTD-11):
   * how many slots are free for IMMEDIATE acquisition right now. The scheduler
   * runs up to `min(concurrency, availability)` instances concurrently and
   * degrades to fewer/sequential under contention — it NEVER hold-and-waits on
   * slots while blocking integration (each instance acquires its own lease inside
   * the step-execute seam like a normal session). Defaults to "unbounded" (the
   * concurrency cap governs) when absent. A returned value ≤ 0 degrades to 1
   * (always make forward progress; never deadlock).
   */
  semaphoreAvailability?: () => number;
  /**
   * Crash-resume reconciliation hook (KTD-11, U10). Before scheduling, the
   * worktree scheduler reconciles each step instance against git/persistence truth:
   *   - integrated (row `completed`/`integratedAt`)        → mark INTEGRATED (skip);
   *   - branch exists but not integrated (`awaiting-integration`) → RE-ENTER the
   *     integration queue (the branch is already built);
   *   - branch missing                                     → RE-RUN the instance.
   * Returns a per-step disposition; absent → all instances run fresh (cold start).
   * The full self-healing sweep across runs is out of scope (handoff). `pinned` is
   * the count this expansion pinned so the hook can reject a `pin-mismatch`.
   */
  resumeReconcile?: (
    pinned: number,
  ) =>
    | Promise<Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }>>
    | Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }>;
  /**
   * Optional task-level log sink (FIX 4 — context gap). When an integration
   * conflict routes a step instance to rework, the re-running agent has no record
   * of WHY its base changed. Wiring this to the engine's task log path
   * (`store.logEntry`) writes a visible entry so the rework is explicable. Best
   * effort: a logging failure must never affect the run. Absent under tests / a
   * foreach env without a logging dep (the conflict still logs to schedulerLog).
   */
  logTaskEntry?: (summary: string, detail?: string) => void | Promise<void>;
}

export interface ForeachRunResult {
  /** Foreach node outcome: success when all instances completed; otherwise the
   *  routed outcome value (e.g. "rework-exhausted") with a failure outcome unless
   *  the caller routes it. */
  outcome: WorkflowNodeOutcome;
  /** Outcome value for `outcome:` edge routing (e.g. "rework-exhausted"). */
  value?: string;
  /** Materialized instance node ids visited, for the executor's visited list. */
  visitedNodeIds: string[];
}

// `instanceNodeId` now lives in `@fusion/core` (column-agent plan KTD-2) so the
// instance-id format has exactly one owner. Re-exported here (the imported binding)
// for back-compat with any local callers; the format is unchanged.
export { instanceNodeId };

/** Resolve the foreach config, validating the bits this module relies on. */
function resolveForeachConfig(node: WorkflowIrNode): {
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
  maxReworkCycles: number;
  mode: "sequential" | "parallel";
  isolation: "shared" | "worktree";
  concurrency: number;
} {
  const cfg = (node.config ?? {}) as ForeachConfig;
  const template = cfg.template;
  if (!template || !Array.isArray(template.nodes) || !Array.isArray(template.edges)) {
    throw new WorkflowIrError(`foreach node '${node.id}' has no template subgraph`);
  }
  const maxReworkCycles = resolveMaxReworkCycles(cfg.maxReworkCycles);
  const mode = cfg.mode === "parallel" ? "parallel" : "sequential";
  // Default isolation: worktree for parallel mode, shared for sequential (KTD-3).
  // (Core validation rejects parallel+shared; this default mirrors that intent.)
  const isolation: "shared" | "worktree" =
    cfg.isolation === "worktree"
      ? "worktree"
      : cfg.isolation === "shared"
      ? "shared"
      : mode === "parallel"
      ? "worktree"
      : "shared";
  const rawConc =
    typeof cfg.concurrency === "number" && Number.isFinite(cfg.concurrency)
      ? Math.floor(cfg.concurrency)
      : DEFAULT_CONCURRENCY;
  // Concurrency only meaningful in parallel mode; sequential pins to 1 (KTD-3).
  const concurrency = mode === "parallel" ? Math.max(1, Math.min(CONCURRENCY_CAP, rawConc)) : 1;
  return { template, maxReworkCycles, mode, isolation, concurrency };
}

/** The 0-indexed predecessor step indices instance `stepIndex` depends on. A step
 *  with no annotation implicitly depends on the previous step (KTD-3), so an
 *  unannotated plan is fully sequential regardless of mode. An explicit empty
 *  array means no dependencies. */
function resolveDependsOn(steps: TaskStep[], stepIndex: number): number[] {
  const deps = steps[stepIndex]?.dependsOn;
  /*
  FNXC:WorkflowSteps 2026-06-29-22:51:
  Empty dependency arrays are planner-authored independence, while missing `dependsOn` remains legacy sequential fallback. The scheduler must branch on array presence rather than length to avoid serializing explicit roots.
  */
  if (Array.isArray(deps)) return deps;
  return stepIndex > 0 ? [stepIndex - 1] : [];
}

/**
 * Validate the dependency DAG at expansion (KTD-3): every dependsOn index must be
 * in range and strictly earlier (a step may only depend on lower indices), and
 * the graph must be acyclic. Returns a refusal reason on violation, else null.
 * Because dependsOn entries reference lower indices only, a forward-reference or
 * self-reference is the cycle signature we reject.
 */
function validateDependencyDag(steps: TaskStep[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const deps = steps[i]?.dependsOn;
    if (!Array.isArray(deps)) continue;
    for (const d of deps) {
      if (!Number.isInteger(d) || d < 0 || d >= steps.length) {
        return `step ${i} depends on out-of-range step ${d}`;
      }
      if (d >= i) {
        // A dependency on an equal/later index is the only way to form a cycle
        // when edges always point to lower indices; reject it as an audited cycle.
        return `dependency cycle: step ${i} depends on step ${d} (>= itself)`;
      }
    }
  }
  return null;
}

/** Find the single template entry node (no non-rework incoming edge). */
function findTemplateEntry(
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
  foreachId: string,
): WorkflowIrNode {
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind === "rework") continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const entries = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new WorkflowIrError(
      `foreach node '${foreachId}' template must have exactly one entry node (found ${entries.length})`,
    );
  }
  return entries[0];
}

/** Compiled template state shared across instances (built once per expansion). */
interface TemplatePlan {
  templateById: Map<string, WorkflowIrNode>;
  templateOutgoing: Map<string, WorkflowIrEdge[]>;
  entry: WorkflowIrNode;
  /** Whether the template routes an explicit `outcome:integration-conflict` edge
   *  from any node (overrides the default rework routing — KTD-11). */
  hasExplicitIntegrationConflictEdge: boolean;
  templateHasStepReview: boolean;
}

function compileTemplate(
  foreachNode: WorkflowIrNode,
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] },
): TemplatePlan {
  const templateById = new Map(template.nodes.map((n) => [n.id, n]));
  const templateOutgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of template.edges) {
    const list = templateOutgoing.get(edge.from) ?? [];
    list.push(edge);
    templateOutgoing.set(edge.from, list);
  }
  const entry = findTemplateEntry(template.nodes, template.edges, foreachNode.id);
  const hasExplicitIntegrationConflictEdge = template.edges.some(
    (e) => e.condition === "outcome:integration-conflict",
  );
  const templateHasStepReview = template.nodes.some((n) => n.kind === "step-review");
  return { templateById, templateOutgoing, entry, hasExplicitIntegrationConflictEdge, templateHasStepReview };
}

/**
 * Expand a foreach node and run its instances. Returns the foreach node's
 * aggregate outcome (KTD-3). Dispatches on the two orthogonal axes (KTD-11):
 *   - shared isolation (default sequential): the unchanged step-order loop —
 *     work lands in the task's main worktree, done at step completion;
 *   - worktree isolation (sequential OR parallel): per-instance branches off the
 *     integration base, dependency-aware scheduling up to `min(concurrency, free
 *     semaphore slots)`, ordered integration in step order, integration-conflict
 *     routed as rework on the updated base.
 */
export async function runForeach(
  foreachNode: WorkflowIrNode,
  env: ForeachEnvironment,
): Promise<ForeachRunResult> {
  const config = resolveForeachConfig(foreachNode);

  // Pin the count at expansion (KTD-3). Zero steps → success edge (no instances).
  const pinnedStepCount = env.steps.length;
  const visitedNodeIds: string[] = [];
  if (pinnedStepCount === 0) {
    return { outcome: "success", visitedNodeIds };
  }

  // Dependency-cycle / out-of-range rejection at expansion (KTD-3, audited).
  const dagViolation = validateDependencyDag(env.steps);
  if (dagViolation) {
    schedulerLog.warn(
      `foreach ${foreachNode.id} for task ${env.task.id}: ${dagViolation} — failing expansion (dependency-cycle)`,
    );
    return { outcome: "failure", value: "dependency-cycle", visitedNodeIds };
  }

  const plan = compileTemplate(foreachNode, config.template);

  if (config.isolation === "worktree") {
    return runForeachWorktree(foreachNode, env, config, plan, pinnedStepCount, visitedNodeIds);
  }

  // ── shared isolation (default sequential) — UNCHANGED U3 behavior ──────────
  for (let stepIndex = 0; stepIndex < pinnedStepCount; stepIndex++) {
    if (env.signal?.aborted) {
      return { outcome: "failure", value: "aborted", visitedNodeIds };
    }

    /*
    FNXC:WorkflowResume 2026-06-29-08:49:
    The workflow graph owns step replay after engine restarts. A shared-isolation foreach pins the step count at expansion, but must read the live projection before each instance so a completed task does not re-run a stale step snapshot and fail on an already-finished `step-execute` node.
    */
    const liveSteps = await Promise.resolve(env.getLiveSteps?.() ?? env.steps).catch(() => env.steps);
    const stepStatus = liveSteps[stepIndex]?.status ?? env.steps[stepIndex]?.status;
    if (stepStatus === "done" || stepStatus === "skipped") {
      schedulerLog.log(
        `foreach ${foreachNode.id} for task ${env.task.id}: skipping step ${stepIndex} — already ${stepStatus}`,
      );
      continue;
    }

    const instanceResult = await runInstance(
      foreachNode,
      stepIndex,
      pinnedStepCount,
      plan.entry,
      plan.templateById,
      plan.templateOutgoing,
      config.maxReworkCycles,
      env,
      visitedNodeIds,
      plan.templateHasStepReview,
    );

    if (instanceResult.outcome === "failure") {
      // Rework exhaustion routes a dedicated outcome; other failures propagate.
      return {
        outcome: "failure",
        value: instanceResult.value,
        visitedNodeIds,
      };
    }
  }

  // All instances completed → foreach success edge (KTD-3).
  return { outcome: "success", visitedNodeIds };
}

// ── Worktree isolation + dependency scheduler + ordered integration (KTD-11) ──

type InstanceState = "pending" | "running" | "awaiting-integration" | "integrated" | "failed";

interface WorktreeInstance {
  stepIndex: number;
  state: InstanceState;
  /** Per-instance rework budget — survives integration-conflict re-executions. */
  reworkBudget: number;
  reworkCount: number;
  /** The instance's allocated branch (set on each run). */
  branchName?: string;
  worktreePath?: string;
  baselineSha?: string;
  checkpointId?: string;
  verdict?: ForeachActiveContext["verdict"];
}

/**
 * Worktree-isolation foreach (KTD-11, U10): per-instance branches off the
 * integration base, dependency-aware scheduling up to `min(concurrency, free
 * semaphore slots)`, ordered integration in step order, integration-conflict
 * routed as rework on the updated base.
 *
 * Scheduling: an instance is runnable when all of its `dependsOn` steps are
 * INTEGRATED (not merely completed). The runnable set runs concurrently up to the
 * clamped slot count; each instance acquires its own semaphore lease inside the
 * step-execute seam (we only READ availability non-blockingly to decide how many
 * to launch — never hold-and-wait, so a starved semaphore degrades to sequential
 * without deadlock). Completion enqueues the branch as `awaiting-integration`;
 * after each batch the integration queue drains in step order.
 */
async function runForeachWorktree(
  foreachNode: WorkflowIrNode,
  env: ForeachEnvironment,
  config: ReturnType<typeof resolveForeachConfig>,
  plan: TemplatePlan,
  pinnedStepCount: number,
  visitedNodeIds: string[],
): Promise<ForeachRunResult> {
  if (!env.allocateInstanceWorktree || !env.integrationGitOps || !env.integrationProjection) {
    // Worktree isolation requires the full wiring; fail cleanly (routable) rather
    // than silently running shared-mode physics.
    return { outcome: "failure", value: "worktree-isolation-unwired", visitedNodeIds };
  }

  const instances: WorktreeInstance[] = Array.from({ length: pinnedStepCount }, (_, i) => ({
    stepIndex: i,
    state: "pending",
    reworkBudget: config.maxReworkCycles,
    reworkCount: 0,
  }));

  const queue = new IntegrationQueue(
    env.integrationGitOps,
    env.integrationProjection,
    pinnedStepCount,
    // Single source of truth for the instance-row identity (KTD-6/KTD-11): the
    // REAL runId + foreachNodeId the sub-walk persisted rows under, so integration
    // flips the SAME row instead of writing an orphan.
    { runId: env.runId, foreachNodeId: foreachNode.id },
  );

  // Crash-resume reconciliation (KTD-11): integrated → skip; branch-exists → re-enter
  // the integration queue; branch-missing → re-run. Cold start (no hook) runs fresh.
  if (env.resumeReconcile) {
    try {
      const dispositions = await env.resumeReconcile(pinnedStepCount);
      for (const d of dispositions) {
        const inst = instances[d.stepIndex];
        if (!inst) continue;
        if (d.disposition === "integrated") {
          inst.state = "integrated";
        } else if (d.disposition === "reintegrate" && d.branchName) {
          // Branch already built — enqueue for ordered integration without re-running.
          inst.state = "awaiting-integration";
          inst.branchName = d.branchName;
          queue.enqueue(d.stepIndex, d.branchName);
        }
        // "rerun" leaves the instance pending (default).
      }
    } catch (err) {
      schedulerLog.warn(
        `foreach ${foreachNode.id} for task ${env.task.id}: resume reconcile failed, running cold: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const isIntegrated = (i: number): boolean => instances[i].state === "integrated";
  const depsIntegrated = (i: number): boolean =>
    resolveDependsOn(env.steps, i).every((d) => isIntegrated(d));

  // Track instances whose worktree/branch has been released so a terminal sweep
  // (and the integration queue) never double-discards. The integration queue
  // releases integrated/conflicted branches itself; this set covers the branches
  // we release directly (failed / aborted / stuck instances that allocated a
  // worktree but the queue never resolved). discardBranch is best-effort either
  // way, but the guard keeps the release "exactly once" contract honest (FIX 2).
  const released = new Set<number>();
  const releaseInstanceWorktree = async (inst: WorktreeInstance): Promise<void> => {
    if (!inst.branchName) return; // never allocated.
    if (released.has(inst.stepIndex)) return;
    released.add(inst.stepIndex);
    try {
      await env.integrationGitOps!.discardBranch(inst.branchName, inst.stepIndex);
    } catch (err) {
      schedulerLog.warn(
        `foreach ${foreachNode.id} step ${inst.stepIndex}: worktree release failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  // Terminal cleanup: release every allocated instance the integration queue did
  // NOT own. The queue itself releases `integrated` (post-integration discard) and
  // `awaiting-integration` (via discardAllPending on the abort/fail/stuck paths)
  // and conflicted branches (marked in `released`). This sweep covers the
  // remainder — `failed` / `running` / `pending` instances that allocated a
  // worktree — so failure / rework-exhausted / abort / scheduler-stuck never leak
  // an allocated worktree+branch. The `released` guard keeps it exactly once.
  const releaseUnresolvedAllocated = async (): Promise<void> => {
    await Promise.all(
      instances
        .filter(
          (i) =>
            i.branchName &&
            i.state !== "integrated" &&
            i.state !== "awaiting-integration",
        )
        .map((i) => releaseInstanceWorktree(i)),
    );
  };

  // Run one instance's sub-walk in an isolated context + freshly-allocated
  // worktree off the CURRENT integration base. Returns awaiting-integration (with
  // the branch) on a clean sub-walk, or a failure outcome (rework-exhausted etc.).
  const runOneInstance = async (inst: WorktreeInstance): Promise<{ outcome: WorkflowNodeOutcome; value?: string }> => {
    const integrationBase = env.resolveIntegrationBase
      ? await env.resolveIntegrationBase().catch(() => undefined)
      : undefined;
    let allocation: { worktreePath: string; branchName: string };
    try {
      allocation = await env.allocateInstanceWorktree!(inst.stepIndex, integrationBase);
    } catch (err) {
      schedulerLog.warn(
        `foreach ${foreachNode.id} step ${inst.stepIndex}: worktree allocation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { outcome: "failure", value: "worktree-alloc-failed" };
    }
    inst.branchName = allocation.branchName;
    inst.worktreePath = allocation.worktreePath;
    // Fresh allocation: this instance now holds a live, un-released worktree again
    // (a prior conflict/rework may have flagged it released). Clear the marker so a
    // later failure of THIS run releases the new worktree exactly once.
    released.delete(inst.stepIndex);

    return runWorktreeInstanceSubWalk(foreachNode, env, plan, pinnedStepCount, visitedNodeIds, inst);
  };

  // Schedule + integrate loop.
  for (;;) {
    if (env.signal?.aborted) {
      await queue.discardAllPending();
      await releaseUnresolvedAllocated();
      return { outcome: "failure", value: "aborted", visitedNodeIds };
    }

    // Runnable = pending instances whose deps are all integrated.
    const runnable = instances.filter((i) => i.state === "pending" && depsIntegrated(i.stepIndex));
    const running = instances.filter((i) => i.state === "running").length;

    if (runnable.length > 0) {
      // Clamp concurrency by free semaphore slots (non-blocking, KTD-11). Degrade
      // to at least 1 so we never deadlock waiting for slots we don't hold: a
      // starved semaphore (availability ≤ 0) still launches one at a time.
      const rawAvail = env.semaphoreAvailability ? env.semaphoreAvailability() : config.concurrency;
      const avail = Math.max(1, rawAvail);
      let slots = Math.min(config.concurrency, avail) - running;
      // Force forward progress when nothing is running (never block on slots held).
      if (slots <= 0 && running === 0) slots = 1;
      const toLaunch = slots > 0 ? runnable.slice(0, slots) : [];

      if (toLaunch.length > 0) {
        for (const inst of toLaunch) inst.state = "running";
        await Promise.all(
          toLaunch.map(async (inst) => {
            const result = await runOneInstance(inst);
            if (result.outcome === "success") {
              inst.state = "awaiting-integration";
              queue.enqueue(inst.stepIndex, inst.branchName!);
            } else {
              inst.state = "failed";
              // A failed instance is skipped in the ordered queue so the cursor can
              // advance past it; the foreach reports the failure value below. Release
              // its allocated worktree+branch immediately (FIX 2 — the queue never
              // sees a failed instance, so it would otherwise leak).
              queue.skip(inst.stepIndex);
              await releaseInstanceWorktree(inst);
              (inst as WorktreeInstance & { failValue?: string }).failValue = result.value;
            }
          }),
        );
        continue; // re-evaluate runnable set + drain after the batch.
      }
    }

    // Drain the integration queue in step order; route conflicts to rework.
    const outcomes = await queue.drain();
    const progressed = outcomes.length > 0;
    for (const outcome of outcomes) {
      const inst = instances[outcome.stepIndex];
      if (outcome.status === "integrated") {
        inst.state = "integrated";
      } else {
        // integration-conflict: the queue's drain() already discarded the
        // conflicting branch (safeDiscard) before reporting the conflict, so the
        // branch is released — record it so the terminal sweep never double-discards.
        released.add(inst.stepIndex);
        // Route as rework on the UPDATED base (KTD-11). The explicit
        // `outcome:integration-conflict` edge (if authored) is honored by the
        // sub-walk; the DEFAULT here is the rework path (re-execute on the updated
        // base, budget-counted). Either way we re-run the instance.
        if (inst.reworkBudget <= 0) {
          inst.state = "failed";
          queue.skip(inst.stepIndex);
          (inst as WorktreeInstance & { failValue?: string }).failValue = "rework-exhausted";
        } else {
          inst.reworkBudget -= 1;
          inst.reworkCount += 1;
          inst.state = "pending"; // re-enter scheduling; re-allocates off updated base.
          // Default routing IS the rework path (re-execute the step on the updated
          // base, budget-counted — KTD-11). When the template authors an explicit
          // `outcome:integration-conflict` edge, the re-run surfaces the conflict
          // signal in the instance context so the author's node can branch on it
          // (the edge overrides the implicit "from entry" rework).
          (inst as WorktreeInstance & { lastIntegrationConflict?: boolean }).lastIntegrationConflict =
            plan.hasExplicitIntegrationConflictEdge;
          const conflictedFiles =
            outcome.status === "conflict" && Array.isArray(outcome.conflictedFiles)
              ? outcome.conflictedFiles
              : [];
          schedulerLog.log(
            `foreach ${foreachNode.id} step ${inst.stepIndex}: integration-conflict — reworking on updated base (budget left ${inst.reworkBudget})`,
          );
          // Task-level audit so the re-running agent sees WHY its base moved
          // (FIX 4). Best-effort; a logging failure never affects the run.
          try {
            const filesNote = conflictedFiles.length > 0 ? ` (files: ${conflictedFiles.join(", ")})` : "";
            await env.logTaskEntry?.(
              `integration conflict on step ${inst.stepIndex}: reworking on updated base${filesNote}`,
              conflictedFiles.length > 0 ? `Conflicted files:\n${conflictedFiles.map((f) => `- ${f}`).join("\n")}` : undefined,
            );
          } catch { /* log is best-effort */ }
        }
      }
    }

    // Terminal conditions.
    const failed = instances.find((i) => i.state === "failed");
    if (failed) {
      await queue.discardAllPending();
      await releaseUnresolvedAllocated();
      const value = (failed as WorktreeInstance & { failValue?: string }).failValue ?? "instance-failed";
      return { outcome: "failure", value, visitedNodeIds };
    }
    if (instances.every((i) => i.state === "integrated")) {
      return { outcome: "success", visitedNodeIds };
    }

    // No progress and nothing runnable/running → stuck (shouldn't happen with a
    // valid DAG, but guard against a livelock).
    const anyActive = instances.some((i) => i.state === "running" || i.state === "awaiting-integration");
    const anyRunnable = instances.some((i) => i.state === "pending" && depsIntegrated(i.stepIndex));
    if (!progressed && !anyActive && !anyRunnable) {
      await queue.discardAllPending();
      await releaseUnresolvedAllocated();
      return { outcome: "failure", value: "scheduler-stuck", visitedNodeIds };
    }
  }
}

/**
 * Run one worktree-isolated instance's iterative sub-walk in an ISOLATED context
 * (its own `foreach:active` slot — required for concurrency), against the
 * instance's own worktree/branch. Returns success (sub-walk reached the exit;
 * the caller enqueues the branch for ordered integration — does NOT mark done
 * here, KTD-11) or failure (rework-exhausted / aborted / node failure).
 *
 * RETHINK under worktree isolation is branch-scoped (KTD-11): `onReworkReset`
 * resets the instance's OWN branch (the executor wires it to resetStepToBaseline
 * against this instance's worktree), so the blast-radius guard is structural.
 */
async function runWorktreeInstanceSubWalk(
  foreachNode: WorkflowIrNode,
  env: ForeachEnvironment,
  plan: TemplatePlan,
  pinnedStepCount: number,
  visitedNodeIds: string[],
  inst: WorktreeInstance,
): Promise<{ outcome: WorkflowNodeOutcome; value?: string }> {
  const stepIndex = inst.stepIndex;
  // Isolated per-instance context (NOT the shared env.context) so concurrent
  // instances never collide on the `foreach:active` slot. Seeded from the shared
  // context so handlers still see prior walk context (read-only-ish).
  const instanceContext: Record<string, unknown> = { ...env.context };
  const active: ForeachActiveContext = {
    foreachNodeId: foreachNode.id,
    stepIndex,
    instanceId: `${foreachNode.id}#${stepIndex}`,
    deferDoneToReview: plan.templateHasStepReview,
    worktreePath: inst.worktreePath,
    branchName: inst.branchName,
    baselineSha: inst.baselineSha,
    checkpointId: inst.checkpointId,
    verdict: inst.verdict,
  };
  instanceContext[FOREACH_ACTIVE_CONTEXT_KEY] = active;
  // Surface a prior integration-conflict to the author's nodes when the template
  // authored an explicit `outcome:integration-conflict` edge (KTD-11 override).
  // Consume the one-shot signal here: clear it on the instance so a LATER clean
  // rework (e.g. a fresh rethink with no conflict) does not re-surface a stale
  // conflict on the seeded context.
  const conflictHolder = inst as WorktreeInstance & { lastIntegrationConflict?: boolean };
  if (conflictHolder.lastIntegrationConflict) {
    instanceContext[INTEGRATION_CONFLICT_CONTEXT_KEY] = true;
    conflictHolder.lastIntegrationConflict = false;
  }

  const persist = (status: WorkflowStepInstanceState["status"], currentNodeId: string): Promise<void> =>
    persistInstanceState(env.persistence, {
      taskId: env.task.id,
      runId: env.runId,
      foreachNodeId: foreachNode.id,
      stepIndex,
      pinnedStepCount,
      currentNodeId,
      status,
      baselineSha: active.baselineSha,
      checkpointId: active.checkpointId,
      reworkCount: inst.reworkCount,
      verdict: active.verdict,
      branchName: inst.branchName,
    });

  await persist("in-progress", plan.entry.id);

  let currentId = plan.entry.id;
  let lastResult: WorkflowNodeResult = { outcome: "success" };

  for (;;) {
    if (env.signal?.aborted) {
      await persist("failed", currentId);
      return { outcome: "failure", value: "aborted" };
    }

    const node = plan.templateById.get(currentId);
    if (!node) throw new WorkflowIrError(`Unknown foreach template node: ${currentId}`);

    visitedNodeIds.push(instanceNodeId(foreachNode.id, stepIndex, currentId));

    lastResult = await env.runTemplateNode(node, env.signal, instanceContext);
    syncActiveFromContext(instanceContext, active);
    // Persist captured baseline/checkpoint back onto the instance (survives rework).
    inst.baselineSha = active.baselineSha;
    inst.checkpointId = active.checkpointId;
    inst.verdict = active.verdict;

    if (lastResult.outcome === "failure") {
      await persist("failed", currentId);
      return { outcome: "failure", value: lastResult.value };
    }

    const next = chooseNextEdge(currentId, plan.templateOutgoing, lastResult, env.shouldTraverseEdge);
    if (!next) {
      // Sub-walk exit — work complete on the branch; AWAIT INTEGRATION (not done).
      await persist("awaiting-integration", currentId);
      return { outcome: "success" };
    }

    if (next.kind === "rework") {
      if (inst.reworkBudget <= 0) {
        await persist("failed", currentId);
        return { outcome: "failure", value: "rework-exhausted" };
      }
      inst.reworkBudget -= 1;
      inst.reworkCount += 1;

      if (lastResult.value === "rethink" && env.onReworkReset) {
        try {
          // Branch-scoped RETHINK: resets THIS instance's branch only (KTD-11).
          await env.onReworkReset(active, "rethink");
          syncActiveFromContext(instanceContext, active);
          inst.baselineSha = active.baselineSha;
          inst.checkpointId = active.checkpointId;
        } catch (err) {
          schedulerLog.warn(
            `onReworkReset failed for task ${env.task.id} foreach ${foreachNode.id} step ${stepIndex}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await persist("in-progress", next.to);
    }

    currentId = next.to;
  }
}

interface InstanceResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
}

/**
 * Run one foreach instance (step `stepIndex`) as an iterative region sub-walk.
 * Threads `foreach:active` into the shared context on entry and clears it on
 * exit. Rework edges loop `currentId` back, bounded by the per-instance budget.
 */
async function runInstance(
  foreachNode: WorkflowIrNode,
  stepIndex: number,
  pinnedStepCount: number,
  entry: WorkflowIrNode,
  templateById: Map<string, WorkflowIrNode>,
  templateOutgoing: Map<string, WorkflowIrEdge[]>,
  maxReworkCycles: number,
  env: ForeachEnvironment,
  visitedNodeIds: string[],
  templateHasStepReview: boolean,
): Promise<InstanceResult> {
  // Per-instance rework budget (KTD-5) — NOT shared across instances.
  let reworkBudget = maxReworkCycles;
  let reworkCount = 0;

  // Active-instance context (KTD-3). baselineSha/checkpointId start undefined and
  // are captured by step-execute (U3) into this same object so later template
  // nodes (step-review/reset, U5) can read them. deferDoneToReview tells the
  // step-execute seam to leave the step in-progress when a review will decide
  // done-ness (U6/KTD-4).
  const active: ForeachActiveContext = {
    foreachNodeId: foreachNode.id,
    stepIndex,
    instanceId: `${foreachNode.id}#${stepIndex}`,
    deferDoneToReview: templateHasStepReview,
  };
  env.context[FOREACH_ACTIVE_CONTEXT_KEY] = active;

  await persistInstanceState(env.persistence, {
    taskId: env.task.id,
    runId: env.runId,
    foreachNodeId: foreachNode.id,
    stepIndex,
    pinnedStepCount,
    currentNodeId: entry.id,
    status: "in-progress",
    baselineSha: active.baselineSha,
    checkpointId: active.checkpointId,
    reworkCount,
    verdict: active.verdict,
  });

  try {
    let currentId = entry.id;
    let lastResult: WorkflowNodeResult = { outcome: "success" };

    for (;;) {
      if (env.signal?.aborted) {
        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: currentId,
          status: "failed",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
        return { outcome: "failure", value: "aborted" };
      }

      const node = templateById.get(currentId);
      if (!node) throw new WorkflowIrError(`Unknown foreach template node: ${currentId}`);

      visitedNodeIds.push(instanceNodeId(foreachNode.id, stepIndex, currentId));

      lastResult = await env.runTemplateNode(node, env.signal);
      // step-execute (and U5 nodes) write captured baseline/checkpoint into the
      // active context via their contextPatch; mirror them onto `active` so the
      // reserved key stays the single source of truth for later nodes.
      syncActiveFromContext(env.context, active);

      if (lastResult.outcome === "failure") {
        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: currentId,
          status: "failed",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
        return { outcome: "failure", value: lastResult.value };
      }

      // Pick the next edge. Rework edges are the only legal back-edges.
      const next = chooseNextEdge(currentId, templateOutgoing, lastResult, env.shouldTraverseEdge);
      if (!next) {
        // No outgoing edge matched → template exit reached. Instance complete.
        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: currentId,
          status: "completed",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
        return { outcome: "success" };
      }

      if (next.kind === "rework") {
        if (reworkBudget <= 0) {
          // Budget exhausted (KTD-5): emit rework-exhausted from the foreach node.
          await persistInstanceState(env.persistence, {
            taskId: env.task.id,
            runId: env.runId,
            foreachNodeId: foreachNode.id,
            stepIndex,
            pinnedStepCount,
            currentNodeId: currentId,
            status: "failed",
            baselineSha: active.baselineSha,
            checkpointId: active.checkpointId,
            reworkCount,
            verdict: active.verdict,
          });
          return { outcome: "failure", value: "rework-exhausted" };
        }
        reworkBudget -= 1;
        reworkCount += 1;

        // RETHINK reset-on-rework (KTD-4, U5): when the rework edge was triggered
        // by an `outcome:rethink` verdict, reset the step to its per-step baseline
        // (git reset + session rewind + step→pending) BEFORE re-entering the
        // step-execute node. REVISE-driven rework revises in place — no reset.
        if (lastResult.value === "rethink" && env.onReworkReset) {
          try {
            await env.onReworkReset(active, "rethink");
            // The reset may have rewound the session; re-sync captured state.
            syncActiveFromContext(env.context, active);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            schedulerLog.warn(
              `onReworkReset failed for task ${env.task.id} foreach ${foreachNode.id} step ${stepIndex}: ${message}`,
            );
          }
        }

        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: next.to,
          status: "in-progress",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
      }

      currentId = next.to;
    }
  } finally {
    // Clear the active-instance context on exit (KTD-3): absent outside instances.
    delete env.context[FOREACH_ACTIVE_CONTEXT_KEY];
  }
}

/** Sync baseline/checkpoint a handler wrote into the shared `foreach:active`
 *  context object back onto our local `active` snapshot. Handlers that patch the
 *  reserved key (step-execute) update the SAME object reference, but a handler
 *  could replace it via contextPatch — re-read defensively. */
function syncActiveFromContext(
  context: Record<string, unknown>,
  active: ForeachActiveContext,
): void {
  const fromContext = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
  if (fromContext && fromContext !== active) {
    active.baselineSha = fromContext.baselineSha ?? active.baselineSha;
    active.checkpointId = fromContext.checkpointId ?? active.checkpointId;
    active.verdict = fromContext.verdict ?? active.verdict;
    // Keep the canonical object reference stable for later nodes.
    context[FOREACH_ACTIVE_CONTEXT_KEY] = active;
  }
}

/**
 * Choose the single next edge from `nodeId`. A rework edge wins only when no
 * non-rework edge matches the outcome (rework is the explicit loop-back, not a
 * primary forward edge); among matching forward edges the lowest `to` id wins
 * (deterministic, mirrors walkBranch/traverseChildren ordering).
 */
function chooseNextEdge(
  nodeId: string,
  templateOutgoing: Map<string, WorkflowIrEdge[]>,
  source: WorkflowNodeResult,
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean,
): WorkflowIrEdge | undefined {
  const edges = (templateOutgoing.get(nodeId) ?? []).filter((e) => shouldTraverseEdge(e, source));
  if (edges.length === 0) return undefined;
  const forward = edges.filter((e) => e.kind !== "rework").sort((a, b) => a.to.localeCompare(b.to));
  if (forward.length > 0) return forward[0];
  const rework = edges.filter((e) => e.kind === "rework").sort((a, b) => a.to.localeCompare(b.to));
  return rework[0];
}
