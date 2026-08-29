import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthRefreshScheduler } from "../oauth-refresh-scheduler.js";

describe("OAuthRefreshScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("proactively refreshes an OAuth credential nearing expiry via getApiKey", async () => {
    const now = Date.now();
    const credentials: Record<string, { type: string; access: string; refresh: string; expires: number }> = {
      anthropic: { type: "oauth", access: "old-token", refresh: "refresh", expires: now + 60_000 },
    };

    const getApiKey = vi.fn(async (providerId: string) => {
      const cred = credentials[providerId];
      if (!cred) return undefined;
      // Simulate the real auth-storage.ts refresh-if-due behavior: rotates the token
      // and pushes expiry forward when getApiKey is called while near expiry.
      credentials[providerId] = { ...cred, access: "rotated-token", expires: now + 3_600_000 };
      return "rotated-token";
    });

    const authStorage = {
      reload: vi.fn(),
      getOAuthProviders: vi.fn(() => [{ id: "anthropic", name: "Anthropic" }]),
      get: vi.fn((providerId: string) => credentials[providerId]),
      getApiKey,
    };

    const scheduler = new OAuthRefreshScheduler({ authStorage, clock: () => now });
    await scheduler.start();
    scheduler.stop();

    expect(getApiKey).toHaveBeenCalledWith("anthropic");
    expect(getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(credentials.anthropic.expires).toBe(now + 3_600_000);
  });

  it("also attempts refresh for the anthropic-subscription alias even though it is never returned by getOAuthProviders", async () => {
    const now = Date.now();
    const credentials: Record<string, { type: string; access: string; refresh: string; expires: number }> = {
      "anthropic-subscription": { type: "oauth", access: "old-token", refresh: "refresh", expires: now + 30_000 },
    };

    const getApiKey = vi.fn(async (providerId: string) => {
      const cred = credentials[providerId];
      if (!cred) return undefined;
      credentials[providerId] = { ...cred, access: "rotated", expires: now + 3_600_000 };
      return "rotated";
    });

    const authStorage = {
      reload: vi.fn(),
      getOAuthProviders: vi.fn(() => [{ id: "anthropic", name: "Anthropic" }]),
      get: vi.fn((providerId: string) => credentials[providerId]),
      getApiKey,
    };

    const scheduler = new OAuthRefreshScheduler({ authStorage, clock: () => now });
    await scheduler.start();
    scheduler.stop();

    expect(getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(credentials["anthropic-subscription"].expires).toBe(now + 3_600_000);
  });

  it("attempts a cheap no-op refresh for a provider with no stored oauth credential", async () => {
    const authStorage = {
      reload: vi.fn(),
      getOAuthProviders: vi.fn(() => [{ id: "github-copilot", name: "GitHub Copilot" }]),
      get: vi.fn(() => undefined),
      getApiKey: vi.fn(async () => undefined),
    };

    const scheduler = new OAuthRefreshScheduler({ authStorage });
    await scheduler.start();
    scheduler.stop();

    // getApiKey() is a cheap no-op for a provider with no stored credential, so the
    // scheduler still calls it (rather than special-casing "no credential yet") but
    // there's nothing to refresh.
    expect(authStorage.getApiKey).toHaveBeenCalledWith("github-copilot");
  });

  it("swallows per-provider refresh failures and continues with other providers", async () => {
    const now = Date.now();
    const credentials: Record<string, { type: string; access: string; refresh: string; expires: number }> = {
      "anthropic-subscription": { type: "oauth", access: "old-token", refresh: "refresh", expires: now + 30_000 },
      github: { type: "oauth", access: "gh-token", refresh: "gh-refresh", expires: now + 30_000 },
    };

    const getApiKey = vi.fn(async (providerId: string) => {
      if (providerId === "anthropic" || providerId === "anthropic-subscription") {
        throw new Error("revoked refresh token");
      }
      const cred = credentials[providerId];
      if (!cred) return undefined;
      credentials[providerId] = { ...cred, expires: now + 3_600_000 };
      return "rotated";
    });

    const authStorage = {
      reload: vi.fn(),
      getOAuthProviders: vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
        { id: "github", name: "GitHub" },
      ]),
      get: vi.fn((providerId: string) => credentials[providerId]),
      getApiKey,
    };

    const scheduler = new OAuthRefreshScheduler({ authStorage, clock: () => now });
    await expect(scheduler.start()).resolves.toBeUndefined();
    scheduler.stop();

    expect(credentials.github.expires).toBe(now + 3_600_000);
  });

  it("reloads auth storage and repeats on its interval", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = {
      reload: vi.fn(),
      getOAuthProviders: vi.fn(() => [{ id: "github-copilot", name: "GitHub Copilot" }]),
      get: vi.fn(() => undefined),
      getApiKey: vi.fn(async () => undefined),
    };

    const scheduler = new OAuthRefreshScheduler({ authStorage, intervalMs: 1_000, clock: () => now });
    await scheduler.start();
    expect(authStorage.reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(authStorage.reload).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(authStorage.reload).toHaveBeenCalledTimes(2);
  });
});
