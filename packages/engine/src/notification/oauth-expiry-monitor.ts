import type { NotificationPayload } from "@fusion/core";
import { schedulerLog } from "../logger.js";
import { OAuthAlertStateStore } from "./oauth-alert-state.js";
import type { NotificationService } from "./notification-service.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MIN_NOTIFY_INTERVAL_MS = 12 * 60 * 60 * 1000;

const ANTHROPIC_OAUTH_PROVIDER_ID = "anthropic";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";

interface OAuthProviderInfo {
  id: string;
  name: string;
}

interface OAuthCredential {
  type?: string;
  expires?: number;
}

export interface AuthStorageLike {
  reload?(): void;
  getOAuthProviders?(): OAuthProviderInfo[];
  get?(providerId: string): OAuthCredential | undefined;
  getApiKey?(providerId: string): Promise<string | null | undefined> | string | null | undefined;
}

/*
FNXC:ClaudeOAuth 2026-07-08-20:55:
`getOAuthProviders()` is NOT aliased by the engine auth-storage proxy, so it only yields the base id `anthropic`. But the Anthropic subscription token the runtime actually uses/refreshes lives under `anthropic-subscription`, while `get("anthropic")` can still return a STALE legacy row (e.g. a months-old credential in ~/.pi/agent/auth.json). Evaluating `get("anthropic")` alone made the expiry monitor and validity logger fire a false "Anthropic OAuth expired" alert even though the subscription token had refreshed successfully. Resolve the FRESHEST of the two aliased ids so a live subscription token suppresses the false alert — mirroring the refresh scheduler's alias handling (getRefreshCandidateIds in oauth-refresh-scheduler.ts).

FNXC:ClaudeOAuth 2026-07-11-18:00:
OAuthExpiryMonitor must refresh-then-recheck before firing `oauth-token-expired` so ntfy observes the same manual re-login truth as `/api/auth/status`, which already calls `getApiKey()` and recomputes expiry for OAuthReloginBanner. The FN-7574 start-refresher-before-monitor ordering only protected the startup check; short-lived auto-refreshing credentials such as GitHub Copilot's ephemeral token can still expire between interval ticks and silently refresh moments later, so dispatching from the stored timestamp alone creates false pushes with no matching banner.
*/
export function resolveEffectiveOAuthCredential(
  authStorage: AuthStorageLike,
  providerId: string,
): OAuthCredential | undefined {
  const direct = authStorage.get?.(providerId);
  if (providerId !== ANTHROPIC_OAUTH_PROVIDER_ID) {
    return direct;
  }
  const subscription = authStorage.get?.(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
  const candidates = [direct, subscription].filter(
    (c): c is OAuthCredential => c?.type === "oauth" && typeof c.expires === "number" && Number.isFinite(c.expires),
  );
  if (candidates.length === 0) {
    return direct;
  }
  return candidates.reduce((latest, c) => (c.expires! > latest.expires! ? c : latest));
}

export interface OAuthExpiryMonitorOptions {
  authStorage: AuthStorageLike;
  notificationService: NotificationService;
  intervalMs?: number;
  clock?: () => number;
  warnBeforeMs?: number;
  minNotifyIntervalMs?: number;
  alertState?: OAuthAlertStateStore;
}

export class OAuthExpiryMonitor {
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly warnBeforeMs: number;
  private readonly minNotifyIntervalMs: number;
  private readonly alertState: OAuthAlertStateStore;
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatchedExpiryKeys = new Set<string>();

  constructor(private readonly opts: OAuthExpiryMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = opts.clock ?? Date.now;
    this.warnBeforeMs = opts.warnBeforeMs ?? 0;
    this.minNotifyIntervalMs = opts.minNotifyIntervalMs ?? DEFAULT_MIN_NOTIFY_INTERVAL_MS;
    this.alertState = opts.alertState ?? new OAuthAlertStateStore({ clock: this.clock });
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<void> {
    this.opts.authStorage.reload?.();

    const providers = this.opts.authStorage.getOAuthProviders?.();
    if (!providers?.length) {
      this.dispatchedExpiryKeys.clear();
      this.alertState.clear();
      return;
    }

    const now = this.clock();
    const activeExpiryKeys = new Set<string>();

    for (const provider of providers) {
      let credential = resolveEffectiveOAuthCredential(this.opts.authStorage, provider.id);
      if (credential?.type !== "oauth" || typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) {
        this.alertState.clear([provider.id]);
        continue;
      }

      let expiryKey = `${provider.id}:${credential.expires}`;
      if (now + this.warnBeforeMs < credential.expires) {
        activeExpiryKeys.add(expiryKey);
        continue;
      }
      if (this.dispatchedExpiryKeys.has(expiryKey)) {
        activeExpiryKeys.add(expiryKey);
        continue;
      }

      if (this.opts.authStorage.getApiKey) {
        try {
          /*
          FNXC:ClaudeOAuth 2026-07-11-18:00:
          The expiry monitor must reuse authStorage.getApiKey() as the single refresh side effect and then reload/re-resolve the effective credential before notifying. This keeps `oauth-token-expired` aligned with the banner-driving `/api/auth/status` route without duplicating provider-specific token refresh code or logging token material.
          */
          await this.opts.authStorage.getApiKey(provider.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          schedulerLog.warn(`OAuth expiry refresh-before-notify failed provider=${provider.id}: ${message}`);
        }

        this.opts.authStorage.reload?.();
        credential = resolveEffectiveOAuthCredential(this.opts.authStorage, provider.id);
        if (credential?.type !== "oauth" || typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) {
          this.alertState.clear([provider.id]);
          continue;
        }

        expiryKey = `${provider.id}:${credential.expires}`;
        if (now + this.warnBeforeMs < credential.expires) {
          activeExpiryKeys.add(expiryKey);
          continue;
        }
        if (this.dispatchedExpiryKeys.has(expiryKey)) {
          activeExpiryKeys.add(expiryKey);
          continue;
        }
      }

      activeExpiryKeys.add(expiryKey);

      const previousNotificationAt = this.alertState.getLastAlertAt(provider.id);
      if (
        typeof previousNotificationAt === "number" &&
        now - previousNotificationAt < this.minNotifyIntervalMs
      ) {
        continue;
      }

      const payload: NotificationPayload = {
        event: "oauth-token-expired",
        metadata: {
          providerId: provider.id,
          providerName: provider.name,
          expiresAt: new Date(credential.expires).toISOString(),
        },
      };

      try {
        await this.opts.notificationService.dispatch("oauth-token-expired", payload);
        this.dispatchedExpiryKeys.add(expiryKey);
        this.alertState.recordAlert(provider.id, credential.expires, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        schedulerLog.warn(`OAuth expiry notification dispatch failed provider=${provider.id}: ${message}`);
      }
    }

    for (const key of this.dispatchedExpiryKeys) {
      if (!activeExpiryKeys.has(key)) {
        this.dispatchedExpiryKeys.delete(key);
      }
    }
  }
}
