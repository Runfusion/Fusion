import { schedulerLog } from "../logger.js";
import { resolveEffectiveOAuthCredential, type AuthStorageLike } from "./oauth-expiry-monitor.js";
import { OAuthAlertStateStore } from "./oauth-alert-state.js";

const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MIN_ALERT_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface OAuthValidityLoggerOptions {
  authStorage: AuthStorageLike;
  intervalMs?: number;
  clock?: () => number;
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
  alertState?: OAuthAlertStateStore;
  minAlertIntervalMs?: number;
}

export class OAuthValidityLogger {
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly logger: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly alertState: OAuthAlertStateStore;
  private readonly minAlertIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OAuthValidityLoggerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = opts.clock ?? Date.now;
    this.logger = opts.logger ?? ((message, meta) => schedulerLog.warn(message, meta));
    this.alertState = opts.alertState ?? new OAuthAlertStateStore({ clock: this.clock });
    this.minAlertIntervalMs = opts.minAlertIntervalMs ?? DEFAULT_MIN_ALERT_INTERVAL_MS;
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

  async check(): Promise<void> {
    this.opts.authStorage.reload?.();
    const providers = this.opts.authStorage.getOAuthProviders?.() ?? [];
    const now = this.clock();

    for (const provider of providers) {
      try {
        // FNXC:ClaudeOAuth 2026-07-08-20:55: evaluate the freshest aliased Anthropic
        // credential (anthropic / anthropic-subscription) so a stale legacy row does not
        // log a false expiry while the subscription token is fresh. See the monitor.
        const credential = resolveEffectiveOAuthCredential(this.opts.authStorage, provider.id);
        if (credential?.type !== "oauth" || typeof credential.expires !== "number") {
          continue;
        }
        if (credential.expires > now) {
          continue;
        }

        const previousAlertAt = this.alertState.getLastAlertAt(provider.id);
        if (typeof previousAlertAt === "number" && now - previousAlertAt < this.minAlertIntervalMs) {
          continue;
        }

        this.logger("oauth credential expired — provider re-login required", {
          providerId: provider.id,
          providerName: provider.name,
          expiresAt: new Date(credential.expires).toISOString(),
        });
        this.alertState.recordAlert(provider.id, credential.expires, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        schedulerLog.warn(`OAuth validity logger failed for provider=${provider.id}: ${message}`);
      }
    }
  }
}
