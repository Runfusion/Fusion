/**
 * C1–C5 model-catalog invariant: refresh state is keyed by each registry instance; request
 * timeouts retain an independently tracked underlying refresh; credential mutations monotonically
 * bump rather than delete state; the engine exposes the one underlying promise; and successful
 * freshness is settled-time while failed retry is attempt-time. These route-level assertions prove
 * the auth registrar applies that invariant to the same registry read by `/api/models`.
 */
/*
FNXC:ModelCatalog 2026-08-12-05:27:
Cache-only tests invoke invalidation directly and would still pass if registerAuthRoutes stopped
wiring credential mutations to the shared model registry. Exercise both real registrars on one
handler router so a mutation during an uncancellable refresh proves generation bumping preserves
its in-flight slot and rejects late old-generation freshness.
*/
import { readFileSync } from "node:fs";
import type { Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetModelRegistryRefreshCacheForTests } from "../model-registry-refresh-cache.js";
import { registerAuthRoutes } from "../routes/register-auth-routes.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const rows = [{ provider: "openai", id: "gpt-test", name: "Retained", reasoning: true, contextWindow: 8_192 }];
type Handler = (req: { body?: Record<string, unknown>; params?: Record<string, string> }, res: { json: (body: unknown) => void }) => Promise<void>;
type Registry = { refresh: () => Promise<void>; getAvailable: () => typeof rows };
type Mutation = "login" | "manual-code" | "logout" | "save-api-key" | "delete-api-key" | "default-instance" | "delete-instance" | "rename-instance";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response() {
  const json = vi.fn();
  return { json, body: () => json.mock.calls[0]?.[0] as Record<string, unknown> };
}

function register(registry: Registry, { withAuthRoutes = true, loginWaitsForManualCode = false } = {}) {
  const handlers = new Map<string, Handler>();
  const bind = (method: string) => vi.fn((path: string, handler: Handler) => handlers.set(`${method} ${path}`, handler));
  const router = { get: bind("GET"), post: bind("POST"), delete: bind("DELETE"), put: bind("PUT") } as unknown as Router;
  const warn = vi.fn();
  const login = vi.fn(async (_provider: string, callbacks: { onAuth: (info: { url: string }) => void; onManualCodeInput?: () => Promise<string> }) => {
    callbacks.onAuth({ url: "https://auth.example.test" });
    if (loginWaitsForManualCode) await callbacks.onManualCodeInput?.();
  });
  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: () => [{ id: "anthropic" }],
    hasAuth: vi.fn(() => true),
    hasApiKey: vi.fn(() => true),
    getApiKeyProviders: () => [{ id: "openai", name: "OpenAI" }],
    login,
    logout: vi.fn().mockResolvedValue(undefined),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    clearApiKey: vi.fn().mockResolvedValue(undefined),
    getInstance: vi.fn(() => ({ type: "api_key", key: "sk-test" })),
    setDefaultInstance: vi.fn().mockResolvedValue(undefined),
    removeInstance: vi.fn().mockResolvedValue(undefined),
    renameInstance: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    router,
    store: { getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }), getSettingsFast: vi.fn().mockResolvedValue({}) },
    runtimeLogger: { child: vi.fn(() => ({ warn })) },
    options: { modelRegistry: registry, authStorage },
    getScopedStore: vi.fn(),
    rethrowAsApiError: (error: unknown) => { throw error; },
  };
  registerModelRoutes(context as never);
  if (withAuthRoutes) registerAuthRoutes(context as never);
  const handler = (method: string, path: string) => handlers.get(`${method} ${path}`)!;
  return { models: handler("GET", "/models"), handler, warn };
}

async function invoke(handler: Handler, req: Parameters<Handler>[0] = {}) {
  const res = response();
  await handler(req, res);
  return res.body();
}

async function getModels(handler: Handler) {
  await expect(invoke(handler)).resolves.toMatchObject({ models: rows });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function mutate(fixture: ReturnType<typeof register>, mutation: Mutation) {
  const routes: Record<Mutation, [string, string, Parameters<Handler>[0]]> = {
    login: ["POST", "/auth/login", { body: { provider: "anthropic" } }],
    "manual-code": ["POST", "/auth/manual-code", { body: { provider: "anthropic", code: "callback-code" } }],
    logout: ["POST", "/auth/logout", { body: { provider: "anthropic" } }],
    "save-api-key": ["POST", "/auth/api-key", { body: { provider: "openai", apiKey: "sk-test" } }],
    "delete-api-key": ["DELETE", "/auth/api-key", { body: { provider: "openai" } }],
    "default-instance": ["POST", "/auth/providers/:provider/default-instance", { params: { provider: "openai" }, body: { instance: "secondary" } }],
    "delete-instance": ["DELETE", "/auth/providers/:provider/instances/:instance", { params: { provider: "openai", instance: "secondary" } }],
    "rename-instance": ["POST", "/auth/providers/:provider/instances/:instance/rename", { params: { provider: "openai", instance: "secondary" }, body: { label: "Renamed" } }],
  };
  const [method, path, request] = routes[mutation];
  await invoke(fixture.handler(method, path), request);
}

async function startManualLogin(fixture: ReturnType<typeof register>) {
  const pending = invoke(fixture.handler("POST", "/auth/login"), { body: { provider: "anthropic" } });
  await expect(pending).resolves.toMatchObject({ url: "https://auth.example.test" });
}

const bumpingMutations: Mutation[] = ["login", "manual-code", "logout", "save-api-key", "delete-api-key", "default-instance", "delete-instance"];

describe("model registry cross-route invalidation", () => {
  beforeEach(() => __resetModelRegistryRefreshCacheForTests());
  afterEach(() => vi.useRealTimers());

  it("preserves a hung flight across POST /auth/api-key and discards its late old-generation success", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const refresh = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce(undefined);
    const fixture = register({ refresh, getAvailable: () => rows });

    const initial = invoke(fixture.models);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(initial).resolves.toMatchObject({ models: rows });
    expect(refresh).toHaveBeenCalledOnce();

    await mutate(fixture, "save-api-key");
    await getModels(fixture.models);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith(expect.stringContaining("stale_in_flight"));

    first.resolve();
    await flush();
    await getModels(fixture.models);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps cache state scoped to the registry instance used by each router", async () => {
    const refreshA = vi.fn().mockResolvedValue(undefined);
    const refreshB = vi.fn().mockResolvedValue(undefined);
    const a = register({ refresh: refreshA, getAvailable: () => rows });
    const b = register({ refresh: refreshB, getAvailable: () => rows });
    await getModels(a.models);
    await getModels(b.models);
    await mutate(a, "save-api-key");
    await getModels(a.models);
    await getModels(b.models);
    expect(refreshA).toHaveBeenCalledTimes(2);
    expect(refreshB).toHaveBeenCalledOnce();
  });

  it.each(bumpingMutations)("%s bumps completed freshness and preserves a hung in-flight slot", async (mutation) => {
    const completedRefresh = vi.fn().mockResolvedValue(undefined);
    const completed = register({ refresh: completedRefresh, getAvailable: () => rows }, { loginWaitsForManualCode: mutation === "manual-code" });
    if (mutation === "manual-code") await startManualLogin(completed);
    await getModels(completed.models);
    await mutate(completed, mutation);
    await flush();
    await getModels(completed.models);
    expect(completedRefresh).toHaveBeenCalledTimes(2);

    __resetModelRegistryRefreshCacheForTests();
    const hanging = deferred<void>();
    const hungRefresh = vi.fn(() => hanging.promise);
    const hung = register({ refresh: hungRefresh, getAvailable: () => rows }, { loginWaitsForManualCode: mutation === "manual-code" });
    if (mutation === "manual-code") await startManualLogin(hung);
    void invoke(hung.models);
    // Model-route settings resolution is async; wait until it has claimed the shared flight.
    await flush();
    await mutate(hung, mutation);
    await getModels(hung.models);
    expect(hungRefresh).toHaveBeenCalledOnce();
    expect(hung.warn).toHaveBeenCalledWith(expect.stringContaining("stale_in_flight"));
  });

  it("leaves label-only instance rename on its existing generation", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fixture = register({ refresh, getAvailable: () => rows });
    await getModels(fixture.models);
    await mutate(fixture, "rename-instance");
    await getModels(fixture.models);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("requires the auth registrar for a credential mutation to change the generation", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fixture = register({ refresh, getAvailable: () => rows }, { withAuthRoutes: false });
    await getModels(fixture.models);
    await getModels(fixture.models);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fixture.handler("POST", "/auth/api-key")).toBeUndefined();
  });

  it("ratchets that model routes never directly call registry.refresh", () => {
    const source = readFileSync(new URL("../routes/register-model-routes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.refresh\(/);
  });
});
