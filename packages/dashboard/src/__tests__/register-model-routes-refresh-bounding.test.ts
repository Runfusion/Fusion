/*
FNXC:ModelCatalog 2026-08-12-01:27:
FN-8902 requires production-shaped route coverage, not cache-only assertions: a credential save
must invalidate the same registry while a refresh is hung without losing its single-flight slot.
Changing the active credential instance is also a credential mutation, so it must invalidate the
same cache before `/api/models` can reuse its successful window. These direct handler fixtures
preserve the API boundary while keeping the 300-second regression
reproduction deterministic with fake timers. Cached requests must also run the supplemental-model
registration branch so their live rows match a completed-refresh response.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import {
  MODEL_REGISTRY_REFRESH_FAILURE_RETRY_MS,
  __resetModelRegistryRefreshCacheForTests,
} from "../model-registry-refresh-cache.js";
import { registerAuthRoutes } from "../routes/register-auth-routes.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const rows = [{ provider: "openai", id: "gpt-test", name: "Retained", reasoning: true, contextWindow: 8_192 }];

type Handler = (req: { body?: Record<string, unknown>; params?: Record<string, string> }, res: { json: (body: unknown) => void }) => Promise<void>;
type Registry = { refresh: () => Promise<void>; getAvailable: () => typeof rows };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function register(registry?: Registry, configuredOAuthProviders: string[] = []) {
  const getHandlers = new Map<string, Handler>();
  const postHandlers = new Map<string, Handler>();
  const router = {
    get: vi.fn((path: string, handler: Handler) => getHandlers.set(path, handler)),
    post: vi.fn((path: string, handler: Handler) => postHandlers.set(path, handler)),
    delete: vi.fn(),
    put: vi.fn(),
  } as unknown as Router;
  const warn = vi.fn();
  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: () => configuredOAuthProviders.map((id) => ({ id })),
    hasAuth: (provider: string) => configuredOAuthProviders.includes(provider),
    hasApiKey: (provider: string) => provider === "openai",
    getApiKeyProviders: () => [{ id: "openai", name: "OpenAI" }],
    setApiKey: vi.fn().mockResolvedValue(undefined),
    getInstance: vi.fn(() => ({ type: "api_key", key: "sk-test" })),
    setDefaultInstance: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    router,
    store: {
      getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
      getSettingsFast: vi.fn().mockResolvedValue({}),
    },
    runtimeLogger: { child: vi.fn(() => ({ warn })) },
    options: registry ? {
      modelRegistry: registry,
      authStorage: {
        ...authStorage,
        hasAuth: (provider: string) => configuredOAuthProviders.includes(provider),
      },
    } : { authStorage },
    getScopedStore: vi.fn(),
    rethrowAsApiError: (error: unknown) => { throw error; },
  };
  registerModelRoutes(context as never);
  registerAuthRoutes(context as never);
  return {
    handler: getHandlers.get("/models")!,
    refreshCatalog: postHandlers.get("/models/refresh")!,
    saveApiKey: postHandlers.get("/auth/api-key")!,
    setDefaultInstance: postHandlers.get("/auth/providers/:provider/default-instance")!,
    warn,
    authStorage,
  };
}

async function request(handler: Handler): Promise<{ models: typeof rows }> {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0]?.[0] as { models: typeof rows };
}

async function refreshCatalog(handler: Handler): Promise<Record<string, unknown>> {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0]?.[0] as Record<string, unknown>;
}

async function saveApiKey(handler: Handler) {
  const json = vi.fn();
  await handler({ body: { provider: "openai", apiKey: "sk-test" } }, { json });
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
}

async function setDefaultInstance(handler: Handler) {
  const json = vi.fn();
  await handler({ params: { provider: "openai" }, body: { instance: "secondary" } }, { json });
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
}

async function flushSettlements() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("registerModelRoutes refresh bounding", () => {
  beforeEach(() => __resetModelRegistryRefreshCacheForTests());
  afterEach(() => vi.useRealTimers());

  it("returns retained rows when a registry refresh never settles", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => new Promise<void>(() => {}));
    const { handler } = register({ refresh, getAvailable: () => rows });
    const pending = request(handler);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("never overlaps hung registry refreshes across sequential and concurrent requests", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => new Promise<void>(() => {}));
    const { handler } = register({ refresh, getAvailable: () => rows });
    const first = request(handler);
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    await Promise.all(Array.from({ length: 10 }, () => request(handler)));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("invalidates through POST /auth/api-key without overlapping an old hung refresh", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const { handler, saveApiKey: save, warn } = register({ refresh, getAvailable: () => rows });

    const initial = request(handler);
    await saveApiKey(save);
    // A new credential generation cannot start alongside the uncancellable old refresh.
    await expect(request(handler)).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale_in_flight"));

    first.resolve();
    await flushSettlements();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(initial).resolves.toMatchObject({ models: rows });
    // The old generation's late success is discarded, so this is a real current-generation refresh.
    await expect(request(handler)).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("uses the failure retry window at the route boundary and refreshes after it expires", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
    const { handler } = register({ refresh, getAvailable: () => rows });

    await expect(request(handler)).resolves.toMatchObject({ models: rows });
    await flushSettlements();
    await expect(request(handler)).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(MODEL_REGISTRY_REFRESH_FAILURE_RETRY_MS);
    await expect(request(handler)).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps registry freshness instance-scoped when a credential mutation invalidates one router", async () => {
    const refreshA = vi.fn().mockResolvedValue(undefined);
    const refreshB = vi.fn().mockResolvedValue(undefined);
    const first = register({ refresh: refreshA, getAvailable: () => rows });
    const second = register({ refresh: refreshB, getAvailable: () => rows });

    await request(first.handler);
    await request(second.handler);
    await saveApiKey(first.saveApiKey);
    await request(first.handler);
    await request(second.handler);

    expect(refreshA).toHaveBeenCalledTimes(2);
    expect(refreshB).toHaveBeenCalledOnce();
  });

  it("invalidates the successful catalog window when the default credential instance changes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { handler, setDefaultInstance: setDefault } = register({ refresh, getAvailable: () => rows });

    await request(handler);
    await setDefaultInstance(setDefault);
    await request(handler);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("runs supplemental registrations for cached requests as it does after a refresh", async () => {
    const registeredProviders = new Map<string, { models: Array<Record<string, unknown>> }>([
      ["openai-codex", { models: [] }],
    ]);
    const registry = {
      refresh: vi.fn().mockResolvedValue(undefined),
      registeredProviders,
      registerProvider: vi.fn((provider: string, config: { models: Array<Record<string, unknown>> }) => {
        registeredProviders.set(provider, { models: config.models });
      }),
      getAll: () => [...registeredProviders.entries()].flatMap(([provider, config]) => config.models.map((model) => ({
        ...model,
        provider,
      }))),
      getAvailable: () => [
        ...rows,
        ...registeredProviders.get("openai-codex")!.models.map((model) => ({
          provider: "openai-codex",
          id: String(model.id),
          name: String(model.name),
          reasoning: Boolean(model.reasoning),
          contextWindow: Number(model.contextWindow),
        })),
      ],
    };
    const { handler } = register(registry as never, ["openai-codex"]);

    const fresh = await request(handler);
    expect(fresh.models.filter((model) => model.provider === "openai-codex").map((model) => model.id)).toEqual(expect.arrayContaining([
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    ]));

    // Simulate a catalog replacement between polls; the cached path must reapply supplements.
    registeredProviders.set("openai-codex", { models: [] });
    const cached = await request(handler);
    expect(registry.refresh).toHaveBeenCalledOnce();
    expect(cached.models).toEqual(fresh.models);
  });

  it("forces a fresh built-in catalog and exposes refreshed rows through GET /models", async () => {
    let availableRows = rows;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const registered = register({ refresh, getAvailable: () => availableRows });

    await expect(request(registered.handler)).resolves.toMatchObject({ models: rows });
    availableRows = [{ ...rows[0], id: "gpt-refreshed", name: "Refreshed" }];

    await expect(refreshCatalog(registered.refreshCatalog)).resolves.toEqual({ outcome: "completed" });
    expect(refresh).toHaveBeenCalledTimes(2);
    await expect(request(registered.handler)).resolves.toMatchObject({ models: availableRows });
  });

  it("reports an unavailable registry without pretending a refresh ran", async () => {
    const { refreshCatalog: refresh } = register();

    await expect(refreshCatalog(refresh)).resolves.toEqual({
      outcome: "failed",
      error: "Model registry unavailable",
    });
  });

  it("retains the last catalog after a failed manual refresh", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("catalog unavailable"));
    const registered = register({ refresh, getAvailable: () => rows });

    await request(registered.handler);
    await expect(refreshCatalog(registered.refreshCatalog)).resolves.toEqual(expect.objectContaining({ outcome: "failed" }));
    await expect(request(registered.handler)).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retains the last catalog after a timed-out manual refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registered = register({ refresh, getAvailable: () => rows });

    await request(registered.handler);
    const pending = refreshCatalog(registered.refreshCatalog);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ outcome: "timed_out" });
    await expect(request(registered.handler)).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("fences a manual refresh behind an older in-flight generation", async () => {
    const first = deferred<void>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const registered = register({ refresh, getAvailable: () => rows });

    const initial = request(registered.handler);
    await flushSettlements();
    await expect(refreshCatalog(registered.refreshCatalog)).resolves.toEqual({ outcome: "stale_in_flight" });
    first.resolve();
    await initial;
    await flushSettlements();

    await expect(refreshCatalog(registered.refreshCatalog)).resolves.toEqual({ outcome: "completed" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("preserves route dedupe and the absent-registry empty-list branch", async () => {
    const duplicateRows = [...rows, { ...rows[0] }];
    const { handler } = register({
      refresh: vi.fn().mockResolvedValue(undefined),
      getAvailable: () => duplicateRows,
    } as never);
    await expect(request(handler)).resolves.toMatchObject({ models: rows });
    const absent = register();
    await expect(request(absent.handler)).resolves.toMatchObject({ models: [] });
  });
});
