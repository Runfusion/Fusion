import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FusionAuthStorage } from "../auth/auth-storage.js";
import { wrapAuthStorageWithApiKeyProviders } from "../auth/provider-auth.js";

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
