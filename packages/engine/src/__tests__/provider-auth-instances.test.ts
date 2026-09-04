import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FusionAuthStorage } from "../auth/auth-storage.js";
import { wrapAuthStorageWithApiKeyProviders } from "../auth/provider-auth.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function storageFixture() {
  const credential = { type: "api_key" as const, key: "secret", label: "Second account" };
  return {
    reload: vi.fn(), getOAuthProviders: vi.fn(() => []), hasAuth: vi.fn(() => false),
    login: vi.fn(), logout: vi.fn(), getApiKey: vi.fn(), getApiKeyProviders: vi.fn(() => []),
    set: vi.fn(), remove: vi.fn(), get: vi.fn(), getAll: vi.fn(() => ({})), list: vi.fn(() => []),
    modify: vi.fn(), setModelRuntime: vi.fn(), hasApiKey: vi.fn(() => false),
    listInstances: vi.fn(() => [{ providerId: "brave", instanceId: "acct-two" }]),
    getInstance: vi.fn(() => credential), setInstance: vi.fn(), removeInstance: vi.fn(),
    getDefaultInstance: vi.fn(), setDefaultInstance: vi.fn(),
  };
}

describe("DashboardAuthStorage instance facade", () => {
  it("clears an API-key credential without deleting its named instance", async () => {
    const storage = storageFixture();
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await facade.clearInstanceApiKey?.({ providerId: "brave", instanceId: "acct-two" });
    expect(storage.setInstance).toHaveBeenCalledWith(
      { providerId: "brave", instanceId: "acct-two" },
      { type: "api_key", key: "", label: "Second account" },
    );
    expect(storage.removeInstance).not.toHaveBeenCalled();
  });

  it("delegates explicit removal to removeInstance rather than credential clear", async () => {
    const storage = storageFixture();
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await facade.removeInstance?.({ providerId: "brave", instanceId: "acct-two" });
    expect(storage.removeInstance).toHaveBeenCalledWith({ providerId: "brave", instanceId: "acct-two" });
    expect(storage.setInstance).not.toHaveBeenCalled();
  });

  it("makes a first named OAuth login the default without retaining adapter default", async () => {
    const credentials = new Map<string, { type: "oauth"; expires: number }>();
    let defaultId: string | undefined;
    const storage = {
      ...storageFixture(),
      getDefaultInstance: vi.fn(() => defaultId ? { providerId: "openai-codex", instanceId: defaultId } : undefined),
      getInstance: vi.fn((ref: { instanceId: string }) => credentials.get(ref.instanceId)),
      get: vi.fn(() => defaultId ? credentials.get(defaultId) : undefined),
      login: vi.fn(async () => {
        defaultId = "default";
        credentials.set("default", { type: "oauth", expires: Date.now() + 60_000 });
      }),
      setInstance: vi.fn(async (ref: { instanceId: string }, credential: { type: "oauth"; expires: number }) => {
        credentials.set(ref.instanceId, credential);
      }),
      removeInstance: vi.fn(async (ref: { instanceId: string }) => {
        credentials.delete(ref.instanceId);
        if (defaultId === ref.instanceId) defaultId = undefined;
      }),
      setDefaultInstance: vi.fn(async (ref: { instanceId: string }) => { defaultId = ref.instanceId; }),
    };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await facade.loginInstance?.({ providerId: "openai-codex", instanceId: "acct-first" }, {} as never);
    expect(credentials.has("default")).toBe(false);
    expect(defaultId).toBe("acct-first");
  });

  /*
  FNXC:ProviderAuth 2026-08-15-21:46:
  Regression for GitHub #3462: instance-scoped Anthropic subscription login must reach the
  upstream runtime as `anthropic` and persist the OAuth result under the `anthropic-subscription`
  storage row. Passing the storage row id to the runtime login fails with
  `Unknown provider: anthropic-subscription` because pi never registers that id as a provider.
  */
  it("refuses an Anthropic second account when consent re-authorizes the stored account", async () => {
    const subscriptionRows = new Map([["acct-a", { type: "oauth", access: "A-access", refresh: "A-refresh", expires: Date.now() + 60_000, label: "Account A" }]]);
    let defaultId = "acct-a";
    const rawRows = new Map<string, { type: string; access?: string; refresh?: string; expires?: number }>();
    const storage = {
      ...storageFixture(),
      getDefaultInstance: vi.fn((providerId: string) => providerId === "anthropic-subscription"
        ? { providerId, instanceId: defaultId }
        : undefined),
      listInstances: vi.fn((providerId: string) => providerId === "anthropic-subscription"
        ? Array.from(subscriptionRows.keys(), (instanceId) => ({ providerId, instanceId }))
        : []),
      getInstance: vi.fn((ref: { instanceId: string }) => subscriptionRows.get(ref.instanceId)),
      get: vi.fn((providerId: string) => rawRows.get(providerId)),
      login: vi.fn(async () => {
        // The provider wrote the already-authorized account through its bare upstream slot.
        rawRows.set("anthropic", { type: "oauth", access: "A-access", refresh: "A-refresh", expires: Date.now() + 60_000 });
      }),
      set: vi.fn(async (_providerId: string, credential: { type: string; access?: string; refresh?: string; expires?: number }) => {
        subscriptionRows.set(defaultId, credential);
      }),
      remove: vi.fn(async (providerId: string) => { rawRows.delete(providerId); }),
      setInstance: vi.fn(async (ref: { instanceId: string }, credential: typeof subscriptionRows extends Map<string, infer Value> ? Value : never) => {
        subscriptionRows.set(ref.instanceId, credential);
      }),
    };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);

    await expect(facade.loginInstance?.({ providerId: "anthropic", instanceId: "acct-b" }, {} as never, "Second account"))
      .rejects.toThrow("Account A");
    expect(subscriptionRows.has("acct-b")).toBe(false);
    expect(subscriptionRows.get("acct-a")?.refresh).toBe("A-refresh");
    expect(defaultId).toBe("acct-a");
  });

  it("accepts first named login and removes the adapter ghost default", async () => {
    const credentials = new Map<string, { type: "oauth"; access: string; refresh: string; expires: number }>();
    let defaultId: string | undefined;
    const storage = {
      ...storageFixture(),
      getDefaultInstance: vi.fn((providerId: string) => defaultId ? { providerId, instanceId: defaultId } : undefined),
      listInstances: vi.fn((providerId: string) => Array.from(credentials.keys(), (instanceId) => ({ providerId, instanceId }))),
      getInstance: vi.fn((ref: { instanceId: string }) => credentials.get(ref.instanceId)),
      get: vi.fn((_providerId: string) => defaultId ? credentials.get(defaultId) : undefined),
      login: vi.fn(async () => {
        defaultId = "default";
        credentials.set("default", { type: "oauth", access: "first-access", refresh: "first-refresh", expires: Date.now() + 60_000 });
      }),
      setInstance: vi.fn(async (ref: { instanceId: string }, credential: { type: "oauth"; access: string; refresh: string; expires: number }) => credentials.set(ref.instanceId, credential)),
      removeInstance: vi.fn(async (ref: { instanceId: string }) => { credentials.delete(ref.instanceId); if (defaultId === ref.instanceId) defaultId = undefined; }),
      setDefaultInstance: vi.fn(async (ref: { instanceId: string }) => { defaultId = ref.instanceId; }),
    };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await expect(facade.loginInstance?.({ providerId: "openai-codex", instanceId: "acct-first" }, {} as never)).resolves.toBeUndefined();
    expect(credentials.get("acct-first")?.refresh).toBe("first-refresh");
    expect(credentials.has("default")).toBe(false);
    expect(defaultId).toBe("acct-first");
  });

  it("uses the minted credential and restores the overwritten previous default", async () => {
    const credentials = new Map<string, { type: "oauth"; access: string; refresh: string; expires: number }>([
      ["acct-a", { type: "oauth", access: "A-access", refresh: "A-refresh", expires: Date.now() + 60_000 }],
    ]);
    let defaultId = "acct-a";
    const storage = {
      ...storageFixture(),
      getDefaultInstance: vi.fn((providerId: string) => ({ providerId, instanceId: defaultId })),
      listInstances: vi.fn((providerId: string) => Array.from(credentials.keys(), (instanceId) => ({ providerId, instanceId }))),
      getInstance: vi.fn((ref: { instanceId: string }) => credentials.get(ref.instanceId)),
      get: vi.fn((_providerId: string) => credentials.get(defaultId)),
      login: vi.fn(async () => credentials.set(defaultId, { type: "oauth", access: "B-access", refresh: "B-refresh", expires: Date.now() + 60_000 })),
      setInstance: vi.fn(async (ref: { instanceId: string }, credential: { type: "oauth"; access: string; refresh: string; expires: number }) => credentials.set(ref.instanceId, credential)),
    };
    const fallback = { reload: vi.fn(), hasAuth: vi.fn(() => true), getApiKey: vi.fn(), get: vi.fn(() => ({ type: "oauth", access: "fallback-access", refresh: "fallback-refresh", expires: Date.now() + 120_000 })), getAll: vi.fn(() => ({})), list: vi.fn(() => []) };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry, [fallback]);
    await facade.loginInstance?.({ providerId: "openai-codex", instanceId: "acct-b" }, {} as never);
    expect(credentials.get("acct-b")?.refresh).toBe("B-refresh");
    expect(credentials.get("acct-a")?.refresh).toBe("A-refresh");
  });

  it("allows same-instance reauthorization but refuses a different pre-existing account", async () => {
    const credentials = new Map<string, { type: "oauth"; access: string; refresh: string; expires: number; label?: string }>([
      ["acct-a", { type: "oauth", access: "A", refresh: "A-refresh", expires: Date.now() + 60_000 }],
      ["acct-c", { type: "oauth", access: "C", refresh: "C-refresh", expires: Date.now() + 60_000, label: "Account C" }],
    ]);
    let defaultId = "acct-a";
    let reauthorizeAsC = false;
    const storage = {
      ...storageFixture(),
      getDefaultInstance: vi.fn((providerId: string) => ({ providerId, instanceId: defaultId })),
      listInstances: vi.fn((providerId: string) => Array.from(credentials.keys(), (instanceId) => ({ providerId, instanceId }))),
      getInstance: vi.fn((ref: { instanceId: string }) => credentials.get(ref.instanceId)),
      get: vi.fn(() => credentials.get(defaultId)),
      login: vi.fn(async () => {
        if (!reauthorizeAsC) return;
        credentials.set(defaultId, { type: "oauth", access: "C", refresh: "C-refresh", expires: Date.now() + 60_000 });
      }),
      setInstance: vi.fn(async (ref: { instanceId: string }, credential: { type: "oauth"; access: string; refresh: string; expires: number; label?: string }) => credentials.set(ref.instanceId, credential)),
    };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await expect(facade.loginInstance?.({ providerId: "openai-codex", instanceId: "acct-a" }, {} as never)).resolves.toBeUndefined();
    reauthorizeAsC = true;
    await expect(facade.loginInstance?.({ providerId: "openai-codex", instanceId: "acct-a" }, {} as never))
      .rejects.toThrow("Account C");
    expect(credentials.get("acct-a")?.refresh).toBe("A-refresh");
  });

  it("does nothing when login yields no credential and skips unreadable or API-key rows", async () => {
    const oauth = { type: "oauth", access: "new-access", refresh: "new-refresh", expires: Date.now() + 60_000 } as const;
    const credentials = new Map<string, typeof oauth>([["acct-a", oauth]]);
    const storage = {
      ...storageFixture(),
      getDefaultInstance: vi.fn(() => ({ providerId: "openai-codex", instanceId: "acct-a" })),
      listInstances: vi.fn(() => [
        { providerId: "openai-codex", instanceId: "acct-a" },
        { providerId: "openai-codex", instanceId: "unreadable" },
        { providerId: "openai-codex", instanceId: "api-key" },
      ]),
      getInstance: vi.fn((ref: { instanceId: string }) => ref.instanceId === "unreadable"
        ? undefined
        : ref.instanceId === "api-key"
          ? { type: "api_key", key: "secret" }
          : credentials.get(ref.instanceId)),
      get: vi.fn(() => undefined),
      login: vi.fn(async () => {}),
      setInstance: vi.fn(async (ref: { instanceId: string }, credential: typeof oauth) => credentials.set(ref.instanceId, credential)),
    };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await expect(facade.loginInstance?.({ providerId: "openai-codex", instanceId: "acct-b" }, {} as never)).resolves.toBeUndefined();
    expect(credentials.has("acct-b")).toBe(false);
  });

  it("serializes concurrent instance logins per provider in either request order", async () => {
    for (const [firstId, secondId] of [["acct-b", "acct-c"], ["acct-c", "acct-b"]]) {
      const credentials = new Map<string, { type: "oauth"; access: string; refresh: string; expires: number }>([
        ["acct-a", { type: "oauth", access: "A-access", refresh: "A-refresh", expires: Date.now() + 60_000 }],
      ]);
      let defaultId = "acct-a";
      const gates = [
        deferred<{ type: "oauth"; access: string; refresh: string; expires: number }>(),
        deferred<{ type: "oauth"; access: string; refresh: string; expires: number }>(),
      ];
      let loginCount = 0;
      const storage = {
        ...storageFixture(),
        getDefaultInstance: vi.fn((providerId: string) => ({ providerId, instanceId: defaultId })),
        listInstances: vi.fn((providerId: string) => Array.from(credentials.keys(), (instanceId) => ({ providerId, instanceId }))),
        getInstance: vi.fn((ref: { instanceId: string }) => credentials.get(ref.instanceId)),
        get: vi.fn(() => credentials.get(defaultId)),
        login: vi.fn(async () => {
          const gate = gates[loginCount++];
          const credential = await gate!.promise;
          credentials.set(defaultId, credential);
        }),
        setInstance: vi.fn(async (ref: { instanceId: string }, credential: { type: "oauth"; access: string; refresh: string; expires: number }) => credentials.set(ref.instanceId, credential)),
      };
      const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
      const firstLogin = facade.loginInstance?.({ providerId: "openai-codex", instanceId: firstId }, {} as never);
      await Promise.resolve();
      const secondLogin = facade.loginInstance?.({ providerId: "openai-codex", instanceId: secondId }, {} as never);
      await Promise.resolve();
      expect(storage.login).toHaveBeenCalledTimes(1);

      gates[0]!.resolve({ type: "oauth", access: "B-access", refresh: "B-refresh", expires: Date.now() + 60_000 });
      await firstLogin;
      await Promise.resolve();
      expect(storage.login).toHaveBeenCalledTimes(2);

      gates[1]!.resolve({ type: "oauth", access: "C-access", refresh: "C-refresh", expires: Date.now() + 60_000 });
      await secondLogin;
      expect(credentials.get(firstId)?.refresh).toBe("B-refresh");
      expect(credentials.get(secondId)?.refresh).toBe("C-refresh");
      expect(credentials.get("acct-a")?.refresh).toBe("A-refresh");
    }
  });

  it("routes Anthropic subscription instance login through the upstream anthropic provider", async () => {
    const rows = new Map<string, { type: string; key?: string; expires?: number }>();
    const storage = {
      ...storageFixture(),
      login: vi.fn(async (providerId: string) => {
        rows.set(providerId, { type: "oauth", expires: Date.now() + 60_000 });
      }),
      get: vi.fn((providerId: string) => rows.get(providerId)),
      set: vi.fn(async (providerId: string, credential: { type: string }) => {
        rows.set(providerId, credential as never);
      }),
      remove: vi.fn(async (providerId: string) => { rows.delete(providerId); }),
      getDefaultInstance: vi.fn(() => undefined),
      getInstance: vi.fn(() => undefined),
      setInstance: vi.fn(),
    };
    const facade = wrapAuthStorageWithApiKeyProviders(storage as unknown as FusionAuthStorage, {} as ModelRegistry);
    await facade.loginInstance?.({ providerId: "anthropic", instanceId: "default" }, {} as never);
    expect(storage.login).toHaveBeenCalledTimes(1);
    expect(storage.login.mock.calls[0]?.[0]).toBe("anthropic");
    expect(storage.setInstance).toHaveBeenCalledWith(
      { providerId: "anthropic-subscription", instanceId: "default" },
      expect.objectContaining({ type: "oauth" }),
    );
  });
});
