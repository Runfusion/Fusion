import type { TaskStore } from "@fusion/core";
import { UsageLimitPauser } from "@fusion/engine";
import type { RuntimeLogger } from "./runtime-logger.js";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  type AuthStorageLike,
  type ProviderUsage,
} from "./usage.js";

const PROVIDER_RATE_LIMIT_PREFIX = "provider-rate-limit:";
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 3_600_000;
const CHECKS_BEFORE_BACKOFF = 5;
const INDEPENDENTLY_METERED_PROVIDERS = new Set([
  "anthropic",
  "anthropic-subscription",
  "openai-codex",
]);

export type ProviderHealthProbe = (
  providerId: string,
  authStorage?: AuthStorageLike,
) => Promise<ProviderUsage | null>;

export interface ProviderHealthMonitorOptions {
  getStores: () => Iterable<TaskStore>;
  authStorage?: AuthStorageLike;
  logger: RuntimeLogger;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  probe?: ProviderHealthProbe;
  supportsProbe?: (providerId: string) => boolean;
  now?: () => number;
}

interface ProviderMonitorState {
  status: "unavailable" | "available";
  failedChecks: number;
  nextCheckAt: number;
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export function providerIdFromRateLimitReason(reason: string | undefined): string | null {
  if (reason === "provider-rate-limit") return "unknown";
  if (!reason?.startsWith(PROVIDER_RATE_LIMIT_PREFIX)) return null;
  const providerId = normalizeProviderId(reason.slice(PROVIDER_RATE_LIMIT_PREFIX.length));
  return providerId || null;
}

export function hasIndependentProviderHealthProbe(providerId: string): boolean {
  return INDEPENDENTLY_METERED_PROVIDERS.has(normalizeProviderId(providerId));
}

/**
 * A successful auth check is not enough: a provider can serve its usage API
 * while an enforced session, weekly, or model-specific window is exhausted.
 */
export function hasUsableProviderCapacity(usage: ProviderUsage | null): boolean {
  return usage?.status === "ok"
    && usage.windows.length > 0
    && usage.windows.every((window) => window.percentUsed < 100 && window.percentLeft > 0);
}

export function providerHealthProbeDelayMs(
  failedChecks: number,
  baseIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxIntervalMs = DEFAULT_MAX_POLL_INTERVAL_MS,
): number {
  if (failedChecks < CHECKS_BEFORE_BACKOFF) return baseIntervalMs;
  const exponent = failedChecks - CHECKS_BEFORE_BACKOFF + 1;
  return Math.min(baseIntervalMs * (2 ** exponent), maxIntervalMs);
}

export async function probeMeteredProviderHealth(
  providerId: string,
  authStorage?: AuthStorageLike,
): Promise<ProviderUsage | null> {
  switch (normalizeProviderId(providerId)) {
    case "anthropic":
    case "anthropic-subscription":
      return fetchClaudeUsage(authStorage);
    case "openai-codex":
      return fetchCodexUsage();
    default:
      return null;
  }
}

/**
 * Daemon-owned provider recovery monitor.
 *
 * It probes only providers that currently own persisted rate-limit parks. A
 * single provider check is shared across every project store, and task model
 * execution is never used as the health probe.
 */
export class ProviderHealthMonitor {
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly probe: ProviderHealthProbe;
  private readonly supportsProbe: (providerId: string) => boolean;
  private readonly now: () => number;
  private readonly states = new Map<string, ProviderMonitorState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly options: ProviderHealthMonitorOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    this.probe = options.probe ?? probeMeteredProviderHealth;
    this.supportsProbe = options.supportsProbe
      ?? (options.probe ? () => true : hasIndependentProviderHealthProbe);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runAndSchedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async checkNow(): Promise<void> {
    const stores = Array.from(new Set(this.options.getStores()));
    const providers = new Set<string>();

    await Promise.all(stores.map(async (store) => {
      try {
        const tasks = await store.listTasks();
        for (const task of tasks) {
          if (task.paused !== true || task.userPaused === true) continue;
          const providerId = providerIdFromRateLimitReason(task.pausedReason);
          if (providerId) providers.add(providerId);
        }
      } catch (error: unknown) {
        this.options.logger.warn("Failed to list tasks for provider health scan", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));

    for (const knownProvider of Array.from(this.states.keys())) {
      if (!providers.has(knownProvider)) this.states.delete(knownProvider);
    }

    await Promise.all(Array.from(providers, async (providerId) => {
      const state = this.states.get(providerId);
      const checkedAt = this.now();
      if (state && state.nextCheckAt > checkedAt) return;

      /*
      FNXC:ProviderRateLimitRecovery 2026-07-21-21:30:
      A provider without an independent quota meter must never be parked forever. Give it one normal poll interval as a cooldown, then requeue its exact provider-qualified parks so ordinary execution can confirm that capacity returned. Legacy unqualified parks use the same bounded fallback under the synthetic "unknown" provider id.

      FNXC:ProviderRateLimitRecovery 2026-07-21-21:50:
      Cooldown recovery is isolated per project store so one unavailable database cannot prevent healthy projects or other providers from resuming.
      */
      if (!this.supportsProbe(providerId)) {
        if (!state || state.status !== "unavailable") {
          this.states.set(providerId, {
            status: "unavailable",
            failedChecks: 1,
            nextCheckAt: checkedAt + this.pollIntervalMs,
          });
          this.options.logger.warn("Provider has no independent health probe; applying bounded cooldown", {
            providerId,
          });
          return;
        }

        const recoveredCounts = await Promise.all(stores.map(async (store) => {
          try {
            return await new UsageLimitPauser(store).onProviderAvailable(providerId);
          } catch (error: unknown) {
            this.options.logger.warn("Failed to recover tasks after provider cooldown", {
              providerId,
              error: error instanceof Error ? error.message : String(error),
            });
            return 0;
          }
        }));
        const recoveredTasks = recoveredCounts.reduce((total, count) => total + count, 0);
        this.states.set(providerId, {
          status: "available",
          failedChecks: 0,
          nextCheckAt: checkedAt + this.pollIntervalMs,
        });
        if (recoveredTasks > 0) {
          this.options.logger.info("Provider cooldown elapsed; resumed provider-paused tasks", {
            providerId,
            recoveredTasks,
          });
        }
        return;
      }

      const usage = await this.probe(providerId, this.options.authStorage).catch((error: unknown) => {
        this.options.logger.warn("Provider health probe failed", {
          providerId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

      if (!hasUsableProviderCapacity(usage)) {
        const failedChecks = (state?.failedChecks ?? 0) + 1;
        const retryDelayMs = providerHealthProbeDelayMs(
          failedChecks,
          this.pollIntervalMs,
          this.maxPollIntervalMs,
        );
        if (state?.status !== "unavailable") {
          this.options.logger.warn("Provider unavailable; rate-limited tasks remain paused", {
            providerId,
            status: usage?.status ?? "unsupported",
            error: usage?.error,
          });
        }
        this.states.set(providerId, {
          status: "unavailable",
          failedChecks,
          nextCheckAt: checkedAt + retryDelayMs,
        });
        return;
      }

      /*
      FNXC:ProviderRateLimitRecovery 2026-07-19-20:15:
      Recovery is driven by an authenticated daemon-side usage/capacity transition, not by waking a parked task and spending a model call as a probe. The persisted pause reason seeds this monitor after restart; one provider probe fans out only to exact matching parks across project engines.
      Provider probes start at a five-minute cadence; after five failed checks each provider backs off independently to 10/20/40/60 minutes. This bounds subscription API traffic without permanently stranding parks during a long outage.
      */
      const recoveredCounts = await Promise.all(stores.map(async (store) => {
        try {
          return await new UsageLimitPauser(store).onProviderAvailable(providerId);
        } catch (error: unknown) {
          this.options.logger.warn("Failed to recover tasks for available provider", {
            providerId,
            error: error instanceof Error ? error.message : String(error),
          });
          return 0;
        }
      }));
      const recoveredTasks = recoveredCounts.reduce((total, count) => total + count, 0);
      this.states.set(providerId, {
        status: "available",
        failedChecks: 0,
        nextCheckAt: checkedAt + this.pollIntervalMs,
      });
      if (recoveredTasks > 0) {
        this.options.logger.info("Provider available again; resumed provider-paused tasks", {
          providerId,
          recoveredTasks,
        });
      }
    }));
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.checkNow();
    } catch (error: unknown) {
      this.options.logger.warn("Provider health reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => void this.runAndSchedule(), this.pollIntervalMs);
        this.timer.unref?.();
      }
    }
  }
}
