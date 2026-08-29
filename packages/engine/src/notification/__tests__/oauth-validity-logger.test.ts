import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthAlertStateStore } from "../oauth-alert-state.js";
import { OAuthValidityLogger } from "../oauth-validity-logger.js";
import type { AuthStorageLike } from "../oauth-expiry-monitor.js";

const tempDirs: string[] = [];

function createStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "oauth-validity-logger-"));
  tempDirs.push(dir);
  return join(dir, "oauth-alert-state.json");
}

function createAuthStorage(providers: Array<{ id: string; name: string }>, credentials: Record<string, any>): AuthStorageLike {
  return {
    reload: vi.fn(),
    getOAuthProviders: () => providers,
    get: (providerId: string) => credentials[providerId],
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("OAuthValidityLogger", () => {
  it("logs one line per expired oauth credential on start", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const logger = vi.fn();
    const authStorage = createAuthStorage(
      [
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "claude", name: "Claude" },
      ],
      {
        "openai-codex": { type: "oauth", expires: now - 1_000 },
        claude: { type: "oauth", expires: now - 500 },
      },
    );

    const validityLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      intervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });
    await validityLogger.start();

    expect(logger).toHaveBeenCalledTimes(2);
    validityLogger.stop();
  });

  it("skips repeated logs within the throttle window", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage(
      [{ id: "openai-codex", name: "OpenAI Codex" }],
      { "openai-codex": { type: "oauth", expires: now - 1_000 } },
    );

    const validityLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      intervalMs: 100,
      minAlertIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await validityLogger.start();
    now += 500;
    await validityLogger.check();

    expect(logger).toHaveBeenCalledTimes(1);
    validityLogger.stop();
  });

  it("persists the throttle across a restart and logs again after the window elapses", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage(
      [{ id: "openai-codex", name: "OpenAI Codex" }],
      { "openai-codex": { type: "oauth", expires: now - 1_000 } },
    );

    const firstLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      minAlertIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await firstLogger.check();
    expect(logger).toHaveBeenCalledTimes(1);

    const restartedLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      minAlertIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await restartedLogger.check();
    expect(logger).toHaveBeenCalledTimes(1);

    now += 1_001;
    await restartedLogger.check();
    expect(logger).toHaveBeenCalledTimes(2);
  });

  it("does not log for valid oauth, api key, or missing expires", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const logger = vi.fn();
    const authStorage = createAuthStorage(
      [
        { id: "valid-oauth", name: "Valid OAuth" },
        { id: "api-key-provider", name: "API Key" },
        { id: "missing-expiry", name: "Missing Expiry" },
      ],
      {
        "valid-oauth": { type: "oauth", expires: now + 10_000 },
        "api-key-provider": { type: "api_key" },
        "missing-expiry": { type: "oauth" },
      },
    );

    const validityLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      intervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });
    await validityLogger.start();

    expect(logger).not.toHaveBeenCalled();
    validityLogger.stop();
  });

  it("stop cancels the interval", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const logger = vi.fn();
    const authStorage = createAuthStorage(
      [{ id: "openai-codex", name: "OpenAI Codex" }],
      { "openai-codex": { type: "oauth", expires: now - 1_000 } },
    );

    const validityLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      intervalMs: 1_000,
      minAlertIntervalMs: 500,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });
    await validityLogger.start();
    validityLogger.stop();
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("continues iterating when one provider throws", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const logger = vi.fn();
    const authStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [
        { id: "broken", name: "Broken" },
        { id: "claude", name: "Claude" },
      ],
      get: (providerId: string) => {
        if (providerId === "broken") {
          throw new Error("boom");
        }
        return { type: "oauth", expires: now - 100 };
      },
    };

    const validityLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      intervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });
    await validityLogger.start();

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "oauth credential expired — provider re-login required",
      expect.objectContaining({ providerId: "claude" }),
    );
    validityLogger.stop();
  });

  it("never includes token material in log metadata", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const logger = vi.fn();
    const authStorage = createAuthStorage(
      [{ id: "openai-codex", name: "OpenAI Codex" }],
      {
        "openai-codex": {
          type: "oauth",
          expires: now - 1_000,
          accessToken: "secret-access",
          refreshToken: "secret-refresh",
        },
      },
    );

    const validityLogger = new OAuthValidityLogger({
      authStorage,
      logger,
      intervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });
    await validityLogger.start();

    const [, meta] = logger.mock.calls[0] ?? [];
    expect(Object.keys(meta ?? {}).sort()).toEqual(["expiresAt", "providerId", "providerName"]);
    validityLogger.stop();
  });

  it("covers empty, undefined, and populated provider states", async () => {
    const logger = vi.fn();
    const now = Date.now();
    const cases: AuthStorageLike[] = [
      {
        reload: vi.fn(),
        getOAuthProviders: () => [],
        get: () => undefined,
      },
      {
        reload: vi.fn(),
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        get: () => undefined,
      },
      createAuthStorage(
        [{ id: "openai-codex", name: "OpenAI Codex" }],
        { "openai-codex": { type: "oauth", expires: now - 1 } },
      ),
    ];

    for (const [index, authStorage] of cases.entries()) {
      const validityLogger = new OAuthValidityLogger({
        authStorage,
        logger,
        clock: () => now,
        alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now + index }),
      });
      await validityLogger.check();
    }

    expect(logger).toHaveBeenCalledTimes(1);
  });
});
