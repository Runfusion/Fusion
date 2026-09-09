/**
 * Usage Limit Detector — classifies API errors as usage-limit-related and
 * parks only the task routed through the unavailable provider.
 *
 * Usage-limit errors indicate provider-local conditions (rate limits, quota
 * exceeded, billing issues, overloaded APIs). Continued retrying the affected
 * task is wasteful, but unrelated providers must remain available. Transient
 * server errors (500, timeout, connection refused) are NOT classified as usage-
 * limit errors — they are temporary and may resolve on their own via per-session
 * retry.
 */

import type { Task, TaskStore } from "@fusion/core";
import type { CredentialInstanceRotator } from "../credential-instance-rotation.js";
// FNXC:WorkflowLifecycleColumns 2026-07-30-11:00: `agentType` is an AGENT ROLE, not a column.
// The planner lane is named `triage` and keeps that name; only the COLUMN was removed by U11.
import { PLANNER_AGENT_ROLE, resolveTaskLifecycleColumns, type WorkflowIr } from "@fusion/core";
import {
  resolveExecutorSessionModel,
  resolveMergerSessionModel,
  resolvePlanningSessionModel,
  resolveValidatorSessionModel,
} from "../agents/agent-session-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("usage-limit");

/**
 * Patterns that indicate API usage/capacity/billing limits.
 * These are checked case-insensitively against error messages.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate[_\s]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b529\b/,
  /quota/i,
  /billing/i,
  /\bcredit/i,
  /insufficient.*(quota|credit|balance|fund)/i,
];

/**
 * Classify whether an error message indicates a usage-limit condition.
 *
 * Returns `true` for rate limits, overloaded errors, and quota/billing issues.
 * Returns `false` for transient server errors (500/502/503/504, timeout,
 * connection refused) that may resolve on their own.
 */
export function isUsageLimitError(errorMessage: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Lightweight coordinator that agents call when they detect usage-limit errors.
 * It parks only the task that reached the unavailable provider. A provider-local
 * outage must never activate the project-wide emergency stop because doing so
 * also kills healthy Codex/Claude/Grok work routed through other providers.
 */
/**
 * Check if an agent session resolved with an error after exhausting retries.
 *
 * pi-coding-agent's `session.prompt()` does **not** throw when retries are
 * exhausted — it resolves normally and stores the error on
 * `session.state.errorMessage` (was `session.state.error` prior to
 * pi-coding-agent 0.70). Call this immediately after every
 * `await session.prompt(...)` to re-raise the swallowed error so existing
 * `catch` blocks (with `isUsageLimitError` checks) can detect rate-limit
 * conditions and trigger `UsageLimitPauser`.
 *
 * @param session — The agent session (or any object with `state.errorMessage?: string`)
 * @throws {Error} If `session.state.errorMessage` is set and non-empty
 */
export function checkSessionError(session: { state: { errorMessage?: string; error?: string } }): void {
  const state = session.state;
  const error = state?.errorMessage ?? state?.error;
  if (error) {
    throw new Error(error);
  }
}

export class UsageLimitPauser {
  constructor(
    private store: TaskStore,
    private readonly options: { credentialRotator?: CredentialInstanceRotator } = {},
  ) {}

  /** Rebinds an externally supplied pauser to the runtime-owned cooldown map. */
  setCredentialRotator(credentialRotator: CredentialInstanceRotator | undefined): void {
    (this.options as { credentialRotator?: CredentialInstanceRotator }).credentialRotator = credentialRotator;
  }

  private normalizeProviderId(provider: string): string {
    return provider.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  }

  /**
   * Clear only parks created for a provider whose independent health probe has
   * transitioned back to usable. Manual/user pauses and every other provider
   * reason remain untouched.
   */
  async onProviderAvailable(provider: string): Promise<number> {
    const providerId = this.normalizeProviderId(provider);
    if (!providerId) return 0;

    const pausedReason = `provider-rate-limit:${providerId}`;
    /*
    FNXC:CredentialInstanceRotation 2026-08-01-06:21:
    Provider recovery clears the runtime-shared, process-local cooldown hint before
    resuming existing rate-limit parks. Parking remains the fallback after rotation,
    and remains the first response for a single configured instance.
    */
    this.options.credentialRotator?.clearCooldowns(providerId);
    // FNXC:ArchitectureHotPath 2026-07-22-17:20: listTasks() must be explicit about payload shape (architecture-hot-paths contract). Recovery only reads scalar pause fields, so request slim rows to avoid loading heavy log/steps/comments for every task.
    const tasks = await this.store.listTasks({ slim: true });
    const recoverableTasks = tasks.filter((task) =>
      task.paused === true
      && task.userPaused !== true
      && (task.pausedReason === pausedReason
        || (providerId === "unknown" && task.pausedReason === "provider-rate-limit")));

    /*
    FNXC:ProviderRateLimitRecovery 2026-07-19-20:15:
    Provider recovery is a health-state transition, never a task call used as a probe. The daemon's independent authenticated usage/capacity monitor invokes this seam only after positive health, and this exact-reason filter ensures recovery cannot clear manual parks, unrelated failure reasons, or another provider's outage.
    */
    await Promise.all(recoverableTasks.map(async (task) => {
      await this.store.logEntry(task.id, `Provider ${providerId} is available again; resuming task`);
      await this.store.pauseTask(task.id, false);
    }));

    if (recoverableTasks.length > 0) {
      log.log(`Provider ${providerId} recovered; resumed ${recoverableTasks.length} task(s)`);
    }
    return recoverableTasks.length;
  }

  private taskUsesProvider(
    task: Task,
    provider: string,
    settings: Awaited<ReturnType<TaskStore["getSettings"]>>,
    agentType: string,
    preImplementationColumns?: ReadonlySet<string>,
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-22:10:
    The WIP and REVIEW lanes of this task's own workflow, resolved by the caller from the same per-workflow
    IR cache as `preImplementationColumns`. Optional so an unresolvable workflow keeps the legacy literals.
    */
    activeLanes?: { wip?: string; review?: string },
  ): boolean {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-15:20 (P0 audit after the Planning-column merge):
    The planning lane was identified by the LITERAL `triage`. The default coding lineage no
    longer declares that column, so this comparison stopped matching for every default-workflow
    card — silently. Nothing throws; the lane simply resolves to no providers, so when a provider
    hits a usage limit during a PLANNING session the fan-out that pauses other tasks on that same
    provider skips every default card, and they keep hammering the rate-limited provider. The
    triggering task is still paused by the explicit fallback below, so no card is stranded — what
    is lost is the blast-radius containment.

    A planning session runs while the card is PRE-IMPLEMENTATION. The caller has already excluded
    `done`/`archived`, so that is exactly "not the implementation column and not the review
    column" — which matches `todo`, `triage`, `ideas`, and a renamed planner alike. The two
    literals that remain here name the wip and review lanes and belong to the executor/scheduler
    vocabulary conversion, not to this fix.
    */
    const isPreImplementation = preImplementationColumns?.has(task.column) === true;
    const providersByActiveLane = agentType === PLANNER_AGENT_ROLE
      ? (isPreImplementation ? [
          resolvePlanningSessionModel(task.planningModelProvider, task.planningModelId, settings).provider,
          resolveValidatorSessionModel(task.validatorModelProvider, task.validatorModelId, settings).provider,
        ] : [])
      : agentType === "executor"
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-31-22:15:
        THE EXECUTOR AND MERGER LANES ARE RESOLVED TOO. The note above describes exactly this failure for the
        PLANNER lane and says it was fixed there — these two were left as literals, so the same silent hole
        stayed open one lane over: on a renamed board an actively-executing card in the WIP column resolved NO
        providers, so a provider rate limit never paused it and the engine kept hammering the limited provider
        with that card.

        MEASURED before the fix, renamed board (`building` = wip), executor limit on a peer card: only the
        TRIGGERING task was paused, and that only because of the always-include-the-trigger fallback below.
        The peer executing on the same rate-limited provider was left running.

            FNXC:WorkflowLifecycleColumns 2026-07-31-23:10 (PR #2672 review, greptile P1):
        THE FALLBACK IS PER ROLE, not per object. My first version keyed it on whether `activeLanes` existed
        at all, so a workflow that RESOLVES but declares no wip (or no review) column suppressed the legacy
        id and resolved no providers — reintroducing this very bug for the partial-vocabulary case. A missing
        ROLE is not the same fact as a missing WORKFLOW, and only the second one means "no basis".

        Falling back per role can only ADD pauses, for a card sitting in a legacy-named column on a board that
        declares no such role — which is the safe direction here and the one the note above states: the cost
        of a wrong include is pausing work that was fine.
        */
        ? (((activeLanes?.wip ?? "in-progress") === task.column) ? [
            resolveExecutorSessionModel(task.modelProvider, task.modelId, settings).provider,
            resolveValidatorSessionModel(task.validatorModelProvider, task.validatorModelId, settings).provider,
          ] : [])
        : agentType === "merger"
          ? (((activeLanes?.review ?? "in-review") === task.column)
            ? [resolveMergerSessionModel(settings, undefined, task).provider]
            : [])
          : [];
    const resolvedProviders = providersByActiveLane;
    return resolvedProviders.some((candidate) => candidate?.trim().toLowerCase() === provider);
  }

  /**
   * Called by agents when a usage-limit error is detected after retries are exhausted.
   * Parks the affected task while leaving every other provider lane running.
   *
   * @param agentType - The type of agent that hit the limit (e.g., "executor", "triage", "merger")
   * @param taskId - The task that was being processed when the limit was hit
   * @param errorMessage - The error message from the API
   * @param provider - Best-effort provider identifier used in the pause reason
   */
  async onUsageLimitHit(agentType: string, taskId: string, errorMessage: string, provider?: string): Promise<void> {
    const providerId = this.normalizeProviderId(provider ?? "unknown") || "unknown";
    const pausedReason = `provider-rate-limit:${providerId}`;

    /*
    FNXC:ProviderRateLimitIsolation 2026-07-19-19:10:
    A 429 is provider-local, not a project emergency. Park only the task that exhausted retries on that provider so healthy provider lanes continue executing. Keep the provider id in structured pause provenance when the caller can identify it; never persist the full provider response as pause metadata.
    */
    log.warn(`${agentType} hit usage limit${providerId ? ` for ${providerId}` : ""} on ${taskId}: ${errorMessage}`);
    log.warn(`Matched pattern in error: "${errorMessage.slice(0, 200)}"`);

    // Log the triggering error on the task
    await this.store.logEntry(
      taskId,
      `Usage limit detected (${agentType}${providerId ? `/${providerId}` : ""}): ${errorMessage}`,
    );

    const [settings, tasks] = await Promise.all([
      this.store.getSettings(),
      // FNXC:ArchitectureHotPath 2026-07-22-17:20: slim payload — this scan only reads column/pause/model-provider scalars, never heavy detail fields.
      this.store.listTasks({ slim: true }),
    ]);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-20:50 (P0 audit, PR #2572 review — greptile):
    The planning lane is resolved PER TASK from its own workflow, not inferred by excluding two
    literals. "Not `in-progress` and not `in-review`" reads any custom non-terminal column — a
    second processing lane, a manual hold, a bespoke review stage — as pre-implementation, so a
    planning-provider limit would pause cards that are nowhere near planning. Trait-derived
    intake/hold is the only answer that holds for a workflow this code has never seen.

    One IR read per WORKFLOW, not per task: the cache is caller-owned (the U1 contract) and shared
    across the whole fan-out, so a 400-card board spanning three workflows reads three IRs. A task
    whose workflow cannot be resolved yields an empty set and is skipped rather than guessed into
    the lane — conservative, because the cost of a wrong include is pausing work that was fine.
    */
    const irCache = new Map<string, WorkflowIr>();
    const preImplementationByTask = new Map<string, ReadonlySet<string>>();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-22:20:
    Resolved for EVERY agent type, because the executor and merger lanes need it and only the
    pre-implementation lane is planner-only. Shares `irCache`, so this is still one IR read per WORKFLOW
    across the whole fan-out — a task whose workflow cannot be resolved yields `undefined` and the callee
    keeps the legacy literal for it.
    */
    const activeLanesByTask = new Map<string, { wip?: string; review?: string } | undefined>();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-23:20 (PR #2672 review, greptile P2):
    RESOLVE ONLY THE CANDIDATES. The first version resolved every task on the board before filtering, so a
    rate limit on a 400-card board paid 400 resolutions to pause a handful — and terminal or paused cards,
    which can never be affected, were resolved too. The cheap predicates run first now, so the resolution
    cost tracks the number of plausible tasks rather than the size of the board.

    KNOWN AND UNCHANGED: concurrent misses on the same workflow can still both read, because `irCache` fills
    after the await. That is a property this path shares with the planner-lane resolution above it, and
    serialising to fix it would trade a bounded duplicate read for latency on the pause — which is the
    operation an operator is waiting on. Named rather than silently accepted.
    */
    /*
    DELIBERATE-LITERAL — a cheap SUPERSET prefilter, kept literal on purpose (#2672 review).

    Its only job is to avoid resolving the whole board. Keeping the Done literal is safe because a renamed board declares no Done id, so every plausible card is still resolved.
    */
    const laneCandidates = tasks.filter((task) =>
      task.paused !== true && task.column !== "done");
    await Promise.all(laneCandidates.map(async (task) => {
      const columns = await resolveTaskLifecycleColumns(this.store, task.id, irCache).catch(() => undefined);
      activeLanesByTask.set(task.id, columns ? { wip: columns.wip, review: columns.review } : undefined);
    }));
    if (agentType === PLANNER_AGENT_ROLE) {
      await Promise.all(tasks.map(async (task) => {
        const columns = await resolveTaskLifecycleColumns(this.store, task.id, irCache).catch(() => undefined);
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-29-22:10 (PR #2572 review — greptile, 2nd):
        INTAKE ONLY. `hold` is not a synonym for "planning": a workflow may carry a hold trait on
        a MID-PIPELINE wait — manual release, timed, dependency, external event — and a card
        parked there is downstream of implementation, not queued for planning. Including hold
        would pause it on a planning-provider limit, which is the same over-classification as the
        literal-exclusion predicate this replaced, just further along.

        The planning session is the one that runs on an intake card, so intake is the lane. When a
        workflow's hold column IS its pre-implementation queue it is normally the same column as
        intake (the merged Planning lane declares both traits) and is covered by that; where they
        differ, the hold column is a wait and is deliberately excluded.
        */
        const lanes = new Set<string>();
        if (columns?.intake) lanes.add(columns.intake);
        preImplementationByTask.set(task.id, lanes);
      }));
    }
    /*
    DELIBERATE-LITERAL — REVIEWED AND PROVEN REDUNDANT, not overlooked.

    This is a documented FALSE POSITIVE for the lifecycle-column census, and it has now drawn in two
    separate workers, which is why the marker is going on rather than only the prose above. A card in
    a renamed terminal lane is ALREADY excluded downstream: `taskUsesProvider` resolves the task's
    active lane, and a finished card matches no active lane, so it resolves no providers and cannot
    be affected. The test suite states the same thing and pins it
    (`pauses a PEER executing in the renamed WIP column` asserts `FN-SHIPPED` is not paused).

    So converting this changes NOTHING at runtime — it would be pure churn that lowers the census
    count while the behaviour is identical, which is the shape this program keeps warning about. The
    marker removes it from the work order so the next reader does not re-derive all of the above.
    */
    const affectedTasks = tasks.filter((task) =>
      task.column !== "done"
      && task.paused !== true
      && providerId !== "unknown"
      && this.taskUsesProvider(
        task,
        providerId,
        settings,
        agentType,
        preImplementationByTask.get(task.id),
        activeLanesByTask.get(task.id),
      ));

    // Always include the task that produced the 429 even if its actual provider
    // came from a runtime fallback not represented in persisted task settings.
    if (!affectedTasks.some((task) => task.id === taskId)) {
      const triggeringTask = await this.store.getTask(taskId).catch(() => null);
      if (triggeringTask && triggeringTask.paused !== true) affectedTasks.push(triggeringTask);
    }

    await Promise.all(affectedTasks.map(async (task) => {
      if (task.id !== taskId) {
        await this.store.logEntry(
          task.id,
          `Paused because provider ${providerId} reached a usage limit on ${taskId}`,
        );
      }
      await this.store.pauseTask(task.id, true, undefined, { pausedReason });
    }));
    log.warn(`Paused ${affectedTasks.length} task(s) routed through ${providerId}; other provider lanes remain active`);
  }
}
