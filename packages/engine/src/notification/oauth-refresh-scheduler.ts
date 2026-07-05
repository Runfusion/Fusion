import { schedulerLog } from "../logger.js";

/*
FNXC:ClaudeOAuth 2026-07-05-00:00:
FN-7574: healthy subscriptions must not lapse waiting for a reactive refresh. A stored
OAuth credential's access token was previously only ever refreshed when something
actively requested a runtime API key (model execution, or the dashboard's best-effort
refresh-on-expiry check) — if nothing asked for a key in the window between "about to
expire" and "expired", the token simply expired and forced a manual re-login.

OAuthRefreshScheduler runs as an independent, engine-side background loop (separate from
OAuthExpiryMonitor's detect-and-notify concern, per the task's File Scope "pick ONE and
justify": keeping detection/notification and refresh as separate, independently
toggleable responsibilities is easier to test and reason about than folding a refresh
side effect into the monitor's `check()`). On each tick it reloads auth storage and asks
for a fresh API key for every known OAuth provider (plus the Anthropic subscription
alias); `authStorage.getApiKey(id)` already contains the refresh-if-due logic — see
`shouldRefreshOAuthCredential`/`refreshProviderOAuthCredential` in `auth-storage.ts` — so
this scheduler deliberately reuses that instead of duplicating the token HTTP call.

Never logs or persists access/refresh token material: only `providerId`, `providerName`,
and `expiresAt` (ISO) are ever referenced for observability.
*/

const DEFAULT_INTERVAL_MS = 5 * 60_000;

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

export interface OAuthRefreshAuthStorageLike {
  reload?(): void;
  getOAuthProviders?(): OAuthProviderInfo[];
  get?(providerId: string): OAuthCredential | undefined;
  getApiKey?(providerId: string): Promise<string | null | undefined> | string | null | undefined;
}

export interface OAuthRefreshSchedulerOptions {
  authStorage: OAuthRefreshAuthStorageLike;
  intervalMs?: number;
  clock?: () => number;
}

export class OAuthRefreshScheduler {
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OAuthRefreshSchedulerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = opts.clock ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
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

  private getRefreshCandidateIds(providers: OAuthProviderInfo[]): string[] {
    const ids = new Set<string>();
    for (const provider of providers) {
      ids.add(provider.id);
      if (provider.id === ANTHROPIC_OAUTH_PROVIDER_ID) {
        // The dashboard-facing subscription alias is stored/refreshed under its own id
        // (see selectAnthropicSubscriptionCredential in auth-storage.ts) and is never
        // returned by getOAuthProviders() itself, so it must be attempted explicitly.
        ids.add(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
      }
    }
    return Array.from(ids);
  }

  private async tick(): Promise<void> {
    this.opts.authStorage.reload?.();

    const providers = this.opts.authStorage.getOAuthProviders?.();
    if (!providers?.length || !this.opts.authStorage.getApiKey) {
      return;
    }

    for (const providerId of this.getRefreshCandidateIds(providers)) {
      try {
        const before = this.opts.authStorage.get?.(providerId);
        const beforeExpires = before?.type === "oauth" && typeof before.expires === "number" && Number.isFinite(before.expires)
          ? before.expires
          : undefined;

        /*
        FNXC:ClaudeOAuth 2026-07-05-00:00:
        Always attempt getApiKey() for every known oauth-provider id (rather than
        pre-filtering on whether this scheduler's own `get()` snapshot already shows a
        credential): the Anthropic subscription alias legitimately resolves through a
        legacy-row fallback inside auth-storage.ts's own selection logic, so a naive
        "skip if this exact id has no direct row" check would silently skip refreshing
        a legacy-row subscription credential. getApiKey() is a cheap no-op when no
        credential exists for that id (see resolveStoredCredentialApiKey/getApiKey).
        */
        await this.opts.authStorage.getApiKey(providerId);

        const after = this.opts.authStorage.get?.(providerId);
        if (
          after?.type === "oauth"
          && typeof after.expires === "number"
          && Number.isFinite(after.expires)
          && (beforeExpires === undefined || after.expires > beforeExpires)
        ) {
          const providerName = providers.find((p) => p.id === providerId)?.name ?? providerId;
          schedulerLog.log(
            `OAuth credential proactively refreshed provider=${providerId} name=${providerName} expiresAt=${new Date(after.expires).toISOString()}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        schedulerLog.warn(`OAuth proactive refresh failed provider=${providerId}: ${message}`);
      }
    }
  }
}
