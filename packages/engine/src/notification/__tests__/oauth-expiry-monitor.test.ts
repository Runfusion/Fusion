import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthAlertStateStore } from "../oauth-alert-state.js";
import { OAuthExpiryMonitor, type AuthStorageLike } from "../oauth-expiry-monitor.js";

const tempDirs: string[] = [];

function createStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "oauth-expiry-monitor-"));
  tempDirs.push(dir);
  return join(dir, "oauth-alert-state.json");
}

type TestCredential = { type?: string; expires?: number };

function createAuthStorage(initialCredential?: TestCredential): AuthStorageLike & {
  credential: TestCredential | undefined;
} {
  return {
    credential: initialCredential,
    reload: vi.fn(),
    getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
    get(providerId: string) {
      if (providerId !== "openai-codex") {
        return undefined;
      }
      return this.credential;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("OAuthExpiryMonitor", () => {
  it("fires once when an OAuth credential is expired", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1_000 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "oauth-token-expired",
      expect.objectContaining({
        event: "oauth-token-expired",
        metadata: expect.objectContaining({
          providerId: "openai-codex",
          providerName: "OpenAI Codex",
        }),
      }),
    );
    monitor.stop();
  });

  /*
  FNXC:ProviderAuth 2026-07-11-18:00:
  Regression coverage for FN-7821: GitHub Copilot's stored OAuth access token is intentionally short-lived and can look expired on an OAuthExpiryMonitor interval tick even though getApiKey() can silently refresh it. The monitor must attempt that refresh and re-check before dispatching so ntfy and OAuthReloginBanner do not disagree.
  */
  it("does not fire for github-copilot when getApiKey refreshes the expired credential", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    let credential: TestCredential | undefined = { type: "oauth", expires: now - 1_000 };
    const getApiKey = vi.fn(async () => {
      credential = { type: "oauth", expires: now + 60_000 };
      return "opaque-github-copilot-access-token";
    });
    const dispatch = vi.fn(async () => undefined);
    const authStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [{ id: "github-copilot", name: "GitHub Copilot" }],
      get: (providerId: string) => providerId === "github-copilot" ? credential : undefined,
      getApiKey,
    };

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(getApiKey).toHaveBeenCalledWith("github-copilot");
    expect(dispatch).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("still fires exactly once for github-copilot when refresh throws and never logs token material in metadata", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const getApiKey = vi.fn(async () => {
      throw new Error("refresh failed");
    });
    const dispatch = vi.fn(async () => undefined);
    const authStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [{ id: "github-copilot", name: "GitHub Copilot" }],
      get: (providerId: string) => providerId === "github-copilot"
        ? { type: "oauth", expires: now - 1_000 }
        : undefined,
      getApiKey,
    };

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(getApiKey).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "oauth-token-expired",
      expect.objectContaining({
        metadata: {
          providerId: "github-copilot",
          providerName: "GitHub Copilot",
          expiresAt: new Date(now - 1_000).toISOString(),
        },
      }),
    );
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("opaque-github-copilot-access-token");
    monitor.stop();
  });

  it("still fires for openai-codex when refresh leaves the credential expired", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1_000 });
    const getApiKey = vi.fn(async () => "opaque-openai-codex-access-token");
    authStorage.getApiKey = getApiKey;
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(getApiKey).toHaveBeenCalledWith("openai-codex");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("opaque-openai-codex-access-token");
    monitor.stop();
  });

  /*
  FNXC:ClaudeOAuth 2026-07-08-20:55:
  Regression: getOAuthProviders() only yields base `anthropic`, and get("anthropic") can
  return a STALE legacy row (e.g. ~/.pi/agent/auth.json) while the fresh, actually-used
  token lives under `anthropic-subscription`. The monitor must evaluate the freshest of
  the two aliased ids and NOT fire a false "expired" alert when the subscription token is
  live. Reproduces the user-reported false ntfy while the token had refreshed successfully.
  */
  it("does not fire for a stale legacy anthropic row when anthropic-subscription is fresh", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const dispatch = vi.fn(async () => undefined);
    const authStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      get: (providerId: string) => {
        if (providerId === "anthropic") {
          return { type: "oauth", expires: now - 60 * 24 * 60 * 60 * 1000 }; // stale (~60d ago)
        }
        if (providerId === "anthropic-subscription") {
          return { type: "oauth", expires: now + 5 * 60 * 60 * 1000 }; // fresh (+5h)
        }
        return undefined;
      },
    };

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(dispatch).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("does not fire for anthropic when getApiKey refreshes the effective subscription alias", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const dispatch = vi.fn(async () => undefined);
    const credentials: Record<string, TestCredential | undefined> = {
      anthropic: { type: "oauth", expires: now - 60 * 24 * 60 * 60 * 1000 },
      "anthropic-subscription": { type: "oauth", expires: now - 1_000 },
    };
    const getApiKey = vi.fn(async () => {
      credentials["anthropic-subscription"] = { type: "oauth", expires: now + 5 * 60 * 60 * 1000 };
      return "opaque-anthropic-subscription-token";
    });
    const authStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      get: (providerId: string) => credentials[providerId],
      getApiKey,
    };

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(getApiKey).toHaveBeenCalledWith("anthropic");
    expect(dispatch).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("still fires for anthropic when both the legacy row and the subscription alias are expired", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const dispatch = vi.fn(async () => undefined);
    const authStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      get: (providerId: string) => {
        if (providerId === "anthropic") {
          return { type: "oauth", expires: now - 60 * 24 * 60 * 60 * 1000 };
        }
        if (providerId === "anthropic-subscription") {
          return { type: "oauth", expires: now - 1_000 }; // also expired
        }
        return undefined;
      },
    };

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "oauth-token-expired",
      expect.objectContaining({ metadata: expect.objectContaining({ providerId: "anthropic" }) }),
    );
    monitor.stop();
  });

  it("does not fire for non-expired/non-oauth credentials", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => undefined);
    const now = Date.now();

    const cases: Array<{ type?: string; expires?: number } | undefined> = [
      { type: "api_key" },
      { type: "oauth" },
      { type: "oauth", expires: Number.NaN },
      { type: "oauth", expires: now + 60_000 },
      undefined,
    ];

    for (const credential of cases) {
      const authStorage = createAuthStorage(credential);
      const monitor = new OAuthExpiryMonitor({
        authStorage,
        notificationService: { dispatch } as any,
        intervalMs: 100,
        clock: () => now,
        alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
      });

      await monitor.start();
      await vi.runOnlyPendingTimersAsync();
      monitor.stop();
    }

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("deduplicates dispatches for same provider and expiry", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(dispatch).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it("re-fires after credential is replaced with a new expiry that later expires", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await monitor.start();
    expect(dispatch).toHaveBeenCalledTimes(1);

    authStorage.credential = { type: "oauth", expires: now + 1_000 };
    await vi.advanceTimersByTimeAsync(100);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledTimes(1);

    now += 12 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("throttles changed expiries until min notify interval elapses across restarts", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const firstMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await firstMonitor.start();
    firstMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    now += 500;
    authStorage.credential = { type: "oauth", expires: now - 2 };
    const restartedMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await restartedMonitor.start();
    restartedMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    now += 500;
    authStorage.credential = { type: "oauth", expires: now - 3 };
    await restartedMonitor.start();
    restartedMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not persist lastAlertAt when dispatch fails", async () => {
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => {
      throw new Error("boom");
    });

    const firstMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await firstMonitor.start();
    firstMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const secondDispatch = vi.fn(async () => undefined);
    now += 100;
    const restartedMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch: secondDispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await restartedMonitor.start();
    restartedMonitor.stop();

    expect(secondDispatch).toHaveBeenCalledTimes(1);
  });

  it("clears persisted state when providers disappear", async () => {
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const firstMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await firstMonitor.start();
    firstMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const noProviderStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [],
      get: () => undefined,
    };
    const clearingMonitor = new OAuthExpiryMonitor({
      authStorage: noProviderStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await clearingMonitor.start();
    clearingMonitor.stop();

    now += 100;
    const restartedMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await restartedMonitor.start();
    restartedMonitor.stop();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("stop cancels the interval", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    monitor.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
