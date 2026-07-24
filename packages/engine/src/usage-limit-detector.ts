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
import {
  resolveExecutorSessionModel,
  resolveMergerSessionModel,
  resolvePlanningSessionModel,
  resolveValidatorSessionModel,
} from "./agent-session-helpers.js";
import { createLogger } from "./logger.js";

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
  constructor(private store: TaskStore) {}

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
  ): boolean {
    const providersByActiveLane = agentType === "triage"
      ? (task.column === "triage" ? [
          resolvePlanningSessionModel(task.planningModelProvider, task.planningModelId, settings).provider,
          resolveValidatorSessionModel(task.validatorModelProvider, task.validatorModelId, settings).provider,
        ] : [])
      : agentType === "executor"
        ? (task.column === "in-progress" ? [
            resolveExecutorSessionModel(task.modelProvider, task.modelId, settings).provider,
            resolveValidatorSessionModel(task.validatorModelProvider, task.validatorModelId, settings).provider,
          ] : [])
        : agentType === "merger"
          ? (task.column === "in-review" ? [resolveMergerSessionModel(settings, undefined, task).provider] : [])
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
    const affectedTasks = tasks.filter((task) =>
      task.column !== "done"
      && task.column !== "archived"
      && task.paused !== true
      && providerId !== "unknown"
      && this.taskUsesProvider(task, providerId, settings, agentType));

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
