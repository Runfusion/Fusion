// PR node handlers for the unified PR-entity review loop (U3).
//
// Three first-class node kinds whose handlers own the PR side effects and emit
// outcomes the graph routes on:
//   - pr-create  : open (or reuse) the PR and write the entity to `open` /`failed`
//   - pr-respond : run the review-response loop body (U5 fills the real body;
//                  U3 delegates to an injected callback defaulting to a no-op)
//   - pr-merge   : tool-side merge with `expectedHeadOid` (reconcile, U4,
//                  corroborates the terminal `merged` write — the node never does)
//
// All handlers are idempotent, fast (no indefinite waits — those are holds, U4),
// and fail-closed. The engine NEVER imports the dashboard GitHubClient: every
// GitHub side effect is an injected callback wired from the CLI composition layer
// (mirroring how `createGroupPr`/`syncGroupPr` are wired). That keeps the engine
// free of the dashboard dependency (FN-3049: static imports only, no dashboard
// client) and unit-testable with fakes.

import {
  isPrEntityActionable,
  isPrEntityAutoMergeReady,
  type PrEntity,
  type PrEntityCreateInput,
  type PrEntityUpdate,
  type PrInfo,
  type TaskDetail,
  type WorkflowIrNode,
} from "@fusion/core";

import type { WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import {
  runPrResponseRun,
  type PrResponseRunDeps,
  type PrResponseRunStore,
  type PrReviewThread,
  type PrPushResult,
} from "./pr-response-run.js";
import { makePrResponseAgentRunner, makePrResponseGitOps } from "./pr-response-run-ops.js";

/**
 * The narrow slice of the store the PR node handlers need. Declared structurally
 * (not as the full `TaskStore`) so the engine stays decoupled from the concrete
 * store and the handlers stay trivially fakeable in tests.
 */
export interface PrNodeStore extends PrResponseRunStore {
  /** Create-or-reuse the single non-terminal entity for a source (AE6 idempotency). */
  ensurePrEntityForSource(input: PrEntityCreateInput): Promise<PrEntity>;
  getPrEntity(id: string): Promise<PrEntity | null>;
  getActivePrEntityBySource(sourceType: PrEntity["sourceType"], sourceId: string): Promise<PrEntity | null>;
  updatePrEntity(id: string, patch: PrEntityUpdate): Promise<PrEntity>;
  updatePrInfo?(id: string, prInfo: PrInfo | null): Promise<unknown>;
}

/**
 * Resolve the single live PR entity backing a task: prefer the task-keyed entity,
 * then fall back to the branch-group entity. Branch-group PR entities are keyed by
 * the branch GROUP id (sourceId = branch_groups.id, per migration 113), which the
 * task carries on `branchContext.groupId` — NOT the task id. Falling back on
 * `task.id` can never match a branch-group entity, so a shared-mode task would
 * spuriously resolve to no-entity.
 */
async function resolveActivePrEntity(store: PrNodeStore, task: TaskDetail): Promise<PrEntity | null> {
  const taskEntity = await store.getActivePrEntityBySource("task", task.id);
  if (taskEntity) return taskEntity;
  const groupId = task.branchContext?.groupId;
  if (!groupId) return null;
  return store.getActivePrEntityBySource("branch-group", groupId);
}

/** Identity of the PR an entity is created for, resolved from the task + node. */
export type PrSourceDescriptor = PrEntityCreateInput;

/** Input for the injected `createPr` callback (the dashboard GitHubClient wrapper). */
export interface PrCreateCallInput {
  task: TaskDetail;
  node: WorkflowIrNode;
  entity: PrEntity;
}

/** Result of a successful PR creation — the GitHub-mirror fields the node persists. */
export interface PrCreateCallResult {
  prNumber: number;
  prUrl: string;
  /** Resolved head commit OID, persisted so `pr-merge` can pass `expectedHeadOid`. */
  headOid?: string;
}

/** Input for the injected `mergePr` callback. */
export interface PrMergeCallInput {
  task: TaskDetail;
  node: WorkflowIrNode;
  entity: PrEntity;
  /** The head OID the merge is gated on (defeats the push/merge race, U2/U6). */
  expectedHeadOid?: string;
}

/**
 * Discriminated result of the injected `mergePr` callback. The callback wraps the
 * dashboard `mergePr`, which throws `PrStaleHeadError` on a head-moved race; the
 * wrapper catches it and returns `{ status: "stale-head" }` so the engine never
 * imports the dashboard error class. Any other failure should be thrown so the
 * handler classifies it as a benign retryable outcome.
 */
export type PrMergeCallResult =
  | { status: "merged-requested" }
  | { status: "stale-head" };

/** Input for the injected `respond` callback (U5 implements the real body). */
export interface PrRespondCallInput {
  task: TaskDetail;
  node: WorkflowIrNode;
  entity: PrEntity;
  context: Record<string, unknown>;
}

/**
 * Result of the injected `respond` callback. `outcome` is the routing value the
 * `pr-respond` node emits (drives the bounded-rework edge back to await-review):
 *   - "fixed"          : a fix was pushed; loop back to await-review
 *   - "disagreed-only" : nothing actionable / all threads disagreed; leave open
 */
export interface PrRespondCallResult {
  value: "fixed" | "disagreed-only";
  contextPatch?: Record<string, unknown>;
}

/**
 * Dependencies the PR node handlers close over. All injected from the CLI
 * composition layer where importing the dashboard GitHubClient IS allowed; the
 * engine receives only plain callbacks + a structural store accessor.
 */
export interface PrNodeDeps {
  /** Structural store accessor (the engine already owns the store instance). */
  getStore(): PrNodeStore;
  /**
   * Resolve the PR source identity for a `pr-create` node from the task + node.
   * The CLI wiring derives sourceType/sourceId (task id or branch-group id),
   * repo, and head/base branch from the task's branch-naming + tracking config.
   */
  resolvePrSource(task: TaskDetail, node: WorkflowIrNode): Promise<PrSourceDescriptor> | PrSourceDescriptor;
  /** Open the PR on GitHub. Throws on failure (the node records `failed`). */
  createPr(input: PrCreateCallInput): Promise<PrCreateCallResult>;
  /** Merge the PR tool-side with `expectedHeadOid`. Returns a discriminated result. */
  mergePr(input: PrMergeCallInput): Promise<PrMergeCallResult>;
  /**
   * Run the review-response body (U5). Defaults to a no-op returning
   * `disagreed-only` when omitted, so U3 ships a routable-but-inert pr-respond.
   */
  respond?: (input: PrRespondCallInput) => Promise<PrRespondCallResult>;
  /** Optional audit sink, called with a stable reason on every routable failure. */
  audit?: (reason: string, detail: string) => void;
}

/**
 * The CLI-injected slice of {@link PrNodeDeps}: only the GitHub side-effect
 * callbacks (which close over the dashboard `GitHubClient`) plus the source
 * resolver and audit sink. The engine binds `getStore` itself (it owns the store
 * instance) via {@link buildPrNodeDeps}, so the CLI layer never needs a store
 * reference. Mirrors how `createGroupPr`/`syncGroupPr` are injected as plain
 * callbacks from the CLI composition layer.
 */
export interface PrNodeGithubOps {
  resolvePrSource: PrNodeDeps["resolvePrSource"];
  createPr: PrNodeDeps["createPr"];
  mergePr: PrNodeDeps["mergePr"];
  /**
   * Pre-built respond callback (rarely used directly; tests/specialized wiring).
   * Prefer {@link respondOps}, which lets the engine bind the store + audit.
   */
  respond?: PrNodeDeps["respond"];
  /**
   * The CLI-injected GitHub/git/agent ops backing the U5 review-response run.
   * When present, {@link buildPrNodeDeps} constructs the `respond` callback from
   * these + the engine-owned store, so the CLI layer never holds a store
   * reference. The slice excludes `entity`/`store`/`audit`/`signal`, which the
   * engine supplies per run.
   */
  respondOps?: PrRespondGithubOps;
  audit?: PrNodeDeps["audit"];
}

/**
 * The CLI-injected slice for the U5 review-response run: the GitHub-client thread
 * ops (which close over the dashboard `GitHubClient`, kept out of the engine) and
 * a `getCwd` resolver mapping an entity to its PR-branch worktree path. The
 * engine builds the git ops + agent runner itself ({@link buildRespondCallback}
 * via {@link makePrResponseGitOps}/{@link makePrResponseAgentRunner}), so the CLI
 * layer never holds the store/settings/session-helper concerns. Optional
 * overrides (bot denylist, secret scanner, cap) pass through.
 */
export interface PrRespondGithubOps {
  getReviewThreads: PrResponseRunDeps["getReviewThreads"];
  getViewerLogin: PrResponseRunDeps["getViewerLogin"];
  checkPrStillOpen: PrResponseRunDeps["checkPrStillOpen"];
  replyToThread: PrResponseRunDeps["replyToThread"];
  resolveThread: PrResponseRunDeps["resolveThread"];
  /** Resolve the PR-branch worktree path for an entity (drives git ops + agent). */
  getCwd: (entity: PrEntity) => string;
  /** Resolve the task id used for the agent session / token accounting. */
  getTaskId: (entity: PrEntity) => string;
  /** Optional bot-denylist override (default `*[bot]`). */
  isBot?: PrResponseRunDeps["isBot"];
  /** Optional secret-scanner override. */
  scanSecrets?: PrResponseRunDeps["scanSecrets"];
  /** Optional iteration-cap override (R8). */
  maxResponseRounds?: number;
}

/**
 * Build the `respond` callback (U5) from the engine-owned store + CLI-injected
 * GitHub ops. Assembles the git ops + mutating-agent runner here (engine-side,
 * with store/settings/session helpers). Detached-turn safe:
 * {@link runPrResponseRun} never throws, so this maps its result to the node's
 * `{ value }` shape (the routing value the `pr-respond` node emits).
 */
export function buildRespondCallback(
  getStore: () => PrNodeStore,
  ops: PrRespondGithubOps,
  audit?: PrNodeDeps["audit"],
  /*
   * FNXC:GrokCliRouting 2026-07-15-09:58:
   * Forward the engine PluginRunner into the PR-response agent runner so grok-cli/no-key models use the same plugin-runtime path as chat/executor/merge.
   */
  pluginRunner?: import("../plugins/plugin-runner.js").PluginRunner,
): NonNullable<PrNodeDeps["respond"]> {
  return async ({ entity }) => {
    const store = getStore();
    // The engine owns a concrete TaskStore behind the structural PrNodeStore; the
    // agent runner + git ops need its settings + worktree. Resolve at run time.
    const fullStore = store as unknown as import("@fusion/core").TaskStore;
    const settings = await fullStore.getSettings();

    // U18 (R15): auto-resolution of review comments is a first-class, configurable,
    // default-ON capability. When disabled, the loop is inert — it dispatches no
    // agent, pushes nothing, and replies to no thread; review threads are left for a
    // human. This is INDEPENDENT of the auto-merge gate (a separate graph node): with
    // resolution on but auto-merge off, threads are still resolved but the PR is not
    // merged. Default true preserves today's always-on behavior. `disagreed-only` is
    // the benign routing value (loops back to await-review like the U3 inert default),
    // so a disabled loop never advances the PR on its own.
    if (settings.autoResolveReviewComments === false) {
      audit?.(
        "pr-respond-auto-resolve-disabled",
        `entity ${entity.id}: autoResolveReviewComments off; leaving review threads for a human`,
      );
      return { value: "disagreed-only" };
    }

    const taskId = ops.getTaskId(entity);
    /*
     * FNXC:PrMergeAutoMerge 2026-07-17-19:18 (gh-4):
     * Resolve the review-response run cwd from the task's recorded worktree first.
     * The CLI-injected ops.getCwd defaults to process.cwd() (no CLI composition
     * site wires getTaskWorktree), which in a centrally-installed multi-project
     * server is the install dir — git ops and the response agent would run outside
     * the project repo. The engine owns the store, so it recovers the worktree
     * here; ops.getCwd stays the fallback ONLY for structural stores without
     * getTask (PrNodeStore does not declare it — tests/specialized wiring). A
     * real getTask rejection (store failure, deleted task) propagates instead:
     * the pr-respond node maps it to a routable `respond-error`, which beats
     * running a mutating agent + git push in a cwd that may not even be the
     * project repo. Structural stores are also withheld from the agent runner,
     * whose store parameter is optional but assumed to have getTask.
     */
    const hasGetTask = typeof (fullStore as Partial<typeof fullStore>).getTask === "function";
    const respondTask: { worktree?: string } | null = hasGetTask
      ? await fullStore.getTask(taskId)
      : null;
    const cwd = respondTask?.worktree || ops.getCwd(entity);
    const gitOps = makePrResponseGitOps(() => cwd);
    const runAgent = makePrResponseAgentRunner(
      settings,
      taskId,
      cwd,
      hasGetTask ? fullStore : undefined,
      pluginRunner,
    );

    const result = await runPrResponseRun({
      entity,
      store,
      getReviewThreads: ops.getReviewThreads,
      getViewerLogin: ops.getViewerLogin,
      checkPrStillOpen: ops.checkPrStillOpen,
      replyToThread: ops.replyToThread,
      resolveThread: ops.resolveThread,
      runAgent: ({ prompt, systemPrompt, threads, signal }) =>
        runAgent({ prompt, systemPrompt, threads, signal }),
      getChangedContent: gitOps.getChangedContent,
      getWorktreeHeadOid: gitOps.getWorktreeHeadOid,
      fetchAndFastForwardPush: gitOps.fetchAndFastForwardPush,
      isBot: ops.isBot,
      scanSecrets: ops.scanSecrets,
      maxResponseRounds: ops.maxResponseRounds,
      audit: audit ? (reason, detail) => audit(reason, detail) : undefined,
    });
    return { value: result.value };
  };
}

// Touch imported types so they participate in the public surface (re-exported via
// index.ts) without an unused-import diagnostic when only referenced indirectly.
export type { PrReviewThread, PrPushResult };

/**
 * Assemble full {@link PrNodeDeps} from the engine-owned store + the CLI-injected
 * GitHub ops. Used by the runtime/executor wiring so the CLI layer stays free of
 * any store reference and the engine never imports the dashboard client.
 */
export function buildPrNodeDeps(
  getStore: () => PrNodeStore,
  ops: PrNodeGithubOps,
  /*
   * FNXC:GrokCliRouting 2026-07-15-09:58:
   * Optional PluginRunner from the in-process runtime so PR-respond sessions can resolve grok-cli via getRuntimeById("grok").
   */
  pluginRunner?: import("../plugins/plugin-runner.js").PluginRunner,
): PrNodeDeps {
  // U5: when the CLI injects `respondOps`, build the real review-response run
  // callback here (the engine binds the store + audit). An explicit `respond`
  // takes precedence (tests/specialized wiring); absent both → inert default.
  const respond = ops.respond
    ?? (ops.respondOps ? buildRespondCallback(getStore, ops.respondOps, ops.audit, pluginRunner) : undefined);
  return {
    getStore,
    resolvePrSource: ops.resolvePrSource,
    createPr: ops.createPr,
    mergePr: ops.mergePr,
    respond,
    audit: ops.audit,
  };
}

function classifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the three PR node handlers from injected deps. Mirrors the seam-injection
 * pattern (`createStepReviewHandler` / `createParseStepsHandler`): the engine
 * graph layer stays engine-agnostic and unit-testable with fakes.
 */
export function createPrNodeHandlers(deps: PrNodeDeps): Record<
  "pr-create" | "pr-respond" | "pr-merge",
  WorkflowNodeHandler
> {
  const audit = (reason: string, detail: string): void => {
    try {
      deps.audit?.(reason, detail);
    } catch {
      // Audit must never affect the run.
    }
  };

  // ── pr-create ──────────────────────────────────────────────────────────────
  // Ensure the entity in `creating`, call GitHub, flip to `open` on success or
  // `failed` (routable, NOT a thrown error) on failure. Re-entry on an already
  // open entity is a no-op emitting value:"open" (AE6 create-or-reuse idempotency).
  const prCreate: WorkflowNodeHandler = async (node, ctx) => {
    const store = deps.getStore();

    let source: PrSourceDescriptor;
    try {
      source = await deps.resolvePrSource(ctx.task, node);
    } catch (err) {
      const detail = `pr-create node '${node.id}' could not resolve PR source: ${classifyError(err)}`;
      audit("pr-create-source-error", detail);
      // No entity yet → fail closed with a routable outcome.
      return { outcome: "failure", value: "source-error" };
    }

    // Create-or-reuse the single live entity (the store enforces the partial
    // unique index, so re-entry never mints a second entity).
    const entity = await store.ensurePrEntityForSource({
      ...source,
      state: source.state ?? "creating",
    });

    // Idempotent re-entry: an already-open entity with a persisted PR is a no-op.
    if (entity.state === "open" && entity.prNumber != null) {
      return { outcome: "success", value: "open" };
    }

    // Ensure the row is in `creating` before the side effect (so a crash mid-flight
    // leaves a recoverable state, not a stale `failed`).
    const creating = entity.state === "creating" ? entity : await store.updatePrEntity(entity.id, { state: "creating" });

    let created: PrCreateCallResult;
    try {
      created = await deps.createPr({ task: ctx.task, node, entity: creating });
    } catch (err) {
      const reason = classifyError(err);
      audit("pr-create-failed", `pr-create node '${node.id}' creation failed: ${reason}`);
      // Failure is a ROUTABLE outcome — the graph routes on value:"failed". Record
      // the classified reason and the failed state; never throw.
      void store.updatePrEntity(creating.id, { state: "failed", failureReason: reason });
      return { outcome: "success", value: "failed" };
    }

    await store.updatePrEntity(creating.id, {
      state: "open",
      prNumber: created.prNumber,
      prUrl: created.prUrl,
      headOid: created.headOid ?? null,
    });
    /*
     * FNXC:WorkflowPrPolicy 2026-06-29-16:42:
     * PRs opened by workflow PR nodes must become first-class Fusion task state immediately. The dashboard already renders `task.prInfo`/`task.prInfos`; linking the created PR here keeps manual PR review lanes visible on task cards/details and lets PR monitoring attach when the workflow moves into review.
     */
    try {
      await store.updatePrInfo?.(ctx.task.id, {
        url: created.prUrl,
        number: created.prNumber,
        status: "open",
        title: ctx.task.title ?? `Task ${ctx.task.id}`,
        headBranch: creating.headBranch,
        baseBranch: creating.baseBranch ?? "main",
        commentCount: 0,
        manual: true,
      });
    } catch (err) {
      audit("pr-create-task-link-failed", `pr-create node '${node.id}' opened PR but could not link task ${ctx.task.id}: ${classifyError(err)}`);
    }
    return { outcome: "success", value: "open" };
  };

  // ── pr-merge ───────────────────────────────────────────────────────────────
  // Merge tool-side with `expectedHeadOid` from the entity. Does NOT write the
  // terminal `merged` state — the reconcile (U4) corroborates that from GitHub.
  // A stale-head race emits value:"stale-head" leaving the entity open; a clean
  // merge request emits value:"merged-requested".
  const prMerge: WorkflowNodeHandler = async (node, ctx) => {
    const store = deps.getStore();
    const entity = await resolveActivePrEntity(store, ctx.task);

    if (!entity) {
      audit("pr-merge-no-entity", `pr-merge node '${node.id}' found no live PR entity for task ${ctx.task.id}`);
      return { outcome: "failure", value: "no-entity" };
    }

    // Unverified entities (imported legacy state GitHub has not corroborated) are
    // a hard gate (R19): never merge on stale state — emit a benign outcome.
    if (!isPrEntityActionable(entity)) {
      audit("pr-merge-not-actionable", `pr-merge node '${node.id}' entity ${entity.id} not actionable (unverified/terminal)`);
      return { outcome: "success", value: "not-actionable" };
    }

    let result: PrMergeCallResult;
    try {
      result = await deps.mergePr({
        task: ctx.task,
        node,
        entity,
        expectedHeadOid: entity.headOid,
      });
    } catch (err) {
      // A non-stale merge error is benign/retryable — never throw out of the
      // handler, and never write `merged`. Route a routable failure value.
      const reason = classifyError(err);
      audit("pr-merge-error", `pr-merge node '${node.id}' merge failed: ${reason}`);
      return { outcome: "failure", value: "merge-error" };
    }

    if (result.status === "stale-head") {
      // The head moved since we read `expectedHeadOid`; leave the entity open so a
      // re-evaluation merges against the new head. Never write `merged`.
      return { outcome: "success", value: "stale-head" };
    }

    // Merge requested cleanly. Do NOT write `merged` here — reconcile corroborates.
    return { outcome: "success", value: "merged-requested" };
  };

  // ── pr-respond ─────────────────────────────────────────────────────────────
  // Delegate to the injected `respond` callback (U5 implements the real body).
  // Defaults to a no-op returning value:"disagreed-only". Increments the entity's
  // responseRounds (the R8 iteration-cap counter, survives restart).
  const prRespond: WorkflowNodeHandler = async (node, ctx) => {
    const store = deps.getStore();
    const entity = await resolveActivePrEntity(store, ctx.task);

    if (!entity) {
      audit("pr-respond-no-entity", `pr-respond node '${node.id}' found no live PR entity for task ${ctx.task.id}`);
      return { outcome: "failure", value: "no-entity" };
    }

    // Unverified/terminal entities are not responded to (R19 hard gate).
    if (!isPrEntityActionable(entity)) {
      audit("pr-respond-not-actionable", `pr-respond node '${node.id}' entity ${entity.id} not actionable (unverified/terminal)`);
      return { outcome: "success", value: "not-actionable" };
    }

    // Bump the rework-cycle counter (R8 cap backing; persisted). Forward the
    // POST-update entity so runPrResponseRun's cap check (`responseRounds > cap`)
    // sees this round's count — passing the stale pre-increment entity fires the
    // cap one round too late.
    const updatedEntity = await store.updatePrEntity(entity.id, { responseRounds: entity.responseRounds + 1 });

    if (!deps.respond) {
      // U3 default: inert but routable. U5 wires the real review-response run.
      return { outcome: "success", value: "disagreed-only" };
    }

    let result: PrRespondCallResult;
    try {
      result = await deps.respond({ task: ctx.task, node, entity: updatedEntity, context: ctx.context });
    } catch (err) {
      const reason = classifyError(err);
      audit("pr-respond-error", `pr-respond node '${node.id}' response run failed: ${reason}`);
      return { outcome: "failure", value: "respond-error" };
    }

    return { outcome: "success", value: result.value, contextPatch: result.contextPatch };
  };

  return {
    "pr-create": prCreate,
    "pr-respond": prRespond,
    "pr-merge": prMerge,
  };
}

/**
 * Auto-merge gate handler (U6, R10). Placed after the approval step. It
 * re-evaluates the LIVE PR entity each time (never trusts a cached/SSE copy) and
 * routes:
 *
 *   - `outcome:auto-on`  → toward `pr-merge`, when {@link isPrEntityAutoMergeReady}
 *     (opted in + approved + all checks concluded success + mergeable clean +
 *     verified).
 *   - `outcome:auto-off` → park for a manual-release merge, for EVERY non-ready
 *     case: not opted in, pending/failed checks, UNKNOWN/conflicting mergeability,
 *     unverified entity, or no live entity at all. The gate never blocks the run.
 *
 * Reuses the gate-routing contract (`{ outcome: "success", value }` consumed by
 * `outcome:` edges in shouldTraverseEdge) rather than forking a parallel routing
 * mechanism. The store/entity lookup is injected via {@link PrNodeDeps} so the
 * engine stays dashboard-import-free. The `auto-merge ready` predicate lives in
 * @fusion/core so the gate, the dashboard, and the reconcile share one
 * definition and cannot drift.
 */
export function createAutoMergeGateHandler(deps: Pick<PrNodeDeps, "getStore" | "audit">): WorkflowNodeHandler {
  const audit = (reason: string, detail: string): void => {
    try {
      deps.audit?.(reason, detail);
    } catch {
      // Audit must never affect the run.
    }
  };
  return async (node, ctx) => {
    const store = deps.getStore();
    const entity = await resolveActivePrEntity(store, ctx.task);

    if (!entity) {
      // No live entity → cannot auto-merge; park for manual handling (never block).
      audit("auto-merge-gate-no-entity", `auto-merge gate '${node.id}' found no live PR entity for task ${ctx.task.id}`);
      return { outcome: "success", value: "auto-off" };
    }

    // Re-fetch authoritative state: the entity row IS the live copy here (store
    // read), so pending checks / UNKNOWN mergeable / unverified / not-opted-in all
    // fall to auto-off via the shared predicate.
    if (isPrEntityAutoMergeReady(entity)) {
      return { outcome: "success", value: "auto-on" };
    }
    return { outcome: "success", value: "auto-off" };
  };
}
