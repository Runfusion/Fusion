import { describe, expect, it } from "vitest";
import type { FusionAuthStorage } from "../auth/auth-storage.js";
import {
  CredentialInstanceResolutionError,
  createFusionCredentialStore,
  findRenamedProviderDefaultInstance,
  resolveCredentialInstanceRef,
} from "../auth/auth-storage.js";

function storage(overrides?: Partial<FusionAuthStorage> & {
  values?: Map<string, { type: string; key: string }>;
  listProviders?: string[];
  defaults?: Record<string, { providerId: string; instanceId: string } | undefined>;
}): FusionAuthStorage {
  const values = overrides?.values ?? new Map([
    ["openai[work]", { type: "api_key", key: "work-key" }],
    ["openai[personal]", { type: "api_key", key: "personal-key" }],
    ["fallback", { type: "api_key", key: "fallback-key" }],
  ]);
  const listProviders = overrides?.listProviders ?? ["openai", "fallback"];
  const defaults = overrides?.defaults ?? { openai: { providerId: "openai", instanceId: "work" } };
  const ref = (providerId: string, instanceId: string) => ({ providerId, instanceId });
  return {
    reload() {},
    get: provider => values.get(provider) as never,
    getAll: () => ({}),
    list: () => listProviders,
    has: () => true,
    hasAuth: () => true,
    listInstances: provider => provider === "openai" ? [ref("openai", "work"), ref("openai", "personal")] : [],
    getInstance: item => {
      const named = values.get(`${item.providerId}[${item.instanceId}]`);
      if (named) return named as never;
      if (item.instanceId === "default") return values.get(item.providerId) as never;
      return undefined;
    },
    setInstance: async (item, credential) => { values.set(`${item.providerId}[${item.instanceId}]`, credential as never); },
    removeInstance: async () => {},
    getDefaultInstance: provider => defaults[provider] ?? (values.has(provider) ? ref(provider, "default") : undefined),
    setDefaultInstance: async () => {},
    set: async () => {},
    remove: async () => {},
    logout: async () => {},
    getApiKey: async () => undefined,
    getOAuthProviders: () => [],
    login: async () => {},
    modify: async () => undefined,
    setModelRuntime: () => {},
    ...overrides,
  };
}

describe("credential instance resolution", () => {
  it("uses the explicit instance while fallback providers keep their default behavior", async () => {
    const auth = storage();
    const resolution = resolveCredentialInstanceRef(auth, "openai", "personal");
    expect(resolution).toMatchObject({ ref: { providerId: "openai", instanceId: "personal" }, missing: false });
    const credentials = createFusionCredentialStore(auth, resolution.ref);
    expect(await credentials.read("openai")).toMatchObject({ key: "personal-key" });
    expect(await credentials.read("fallback")).toMatchObject({ key: "fallback-key" });
  });

  it("keeps Anthropic on the instance-aware getApiKey indirection", async () => {
    const auth = storage();
    const getApiKey = async (provider: string, instance?: { providerId: string; instanceId: string }) => {
      expect(provider).toBe("anthropic");
      expect(instance).toEqual({ providerId: "anthropic", instanceId: "personal" });
      return "instance-token";
    };
    const credentials = createFusionCredentialStore({ ...auth, getApiKey }, { providerId: "anthropic", instanceId: "personal" });
    expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "instance-token" });
  });

  it("audits a missing or malformed name by resolving only the provider default", () => {
    const auth = storage();
    expect(resolveCredentialInstanceRef(auth, "openai", "deleted")).toMatchObject({ ref: { instanceId: "work" }, missing: true });
    expect(resolveCredentialInstanceRef(auth, "openai", "bad name")).toMatchObject({ ref: { instanceId: "work" }, missing: true });
    const noDefault = storage({
      getDefaultInstance: () => undefined,
      listProviders: ["openai"],
      defaults: {},
    });
    expect(() => resolveCredentialInstanceRef(noDefault, "openai", "deleted")).toThrow(CredentialInstanceResolutionError);
  });

  /*
  FNXC:ProviderAuth 2026-08-03-17:35:
  Custom-provider rename leaves auth under a punctuation-variant slug while the model
  catalog uses the collapsed form. Exact alphanumeric collapse must self-heal when unique.
  */
  it("self-heals slug punctuation renames (umans-api ↔ umansapi)", () => {
    const auth = storage({
      values: new Map([["umans-api", { type: "api_key", key: "k" }]]),
      listProviders: ["umans-api"],
      getDefaultInstance: (provider) => (provider === "umans-api" ? { providerId: "umans-api", instanceId: "default" } : undefined),
    });
    expect(findRenamedProviderDefaultInstance(auth, "umansapi")).toEqual({ providerId: "umans-api", instanceId: "default" });
    expect(resolveCredentialInstanceRef(auth, "umansapi", "default")).toMatchObject({
      ref: { providerId: "umans-api", instanceId: "default" },
      missing: true,
      renamedProvider: true,
    });
  });

  it("does not cross-wire unrelated providers that share a prefix", () => {
    const auth = storage({
      values: new Map([
        ["openai", { type: "api_key", key: "a" }],
        ["openai-codex", { type: "api_key", key: "b" }],
      ]),
      listProviders: ["openai", "openai-codex"],
      // No default for a missing sibling slug — only the two real providers exist.
      getDefaultInstance: (provider) => (
        provider === "openai" || provider === "openai-codex"
          ? { providerId: provider, instanceId: "default" }
          : undefined
      ),
    });
    expect(findRenamedProviderDefaultInstance(auth, "openai-extra")).toBeUndefined();
    expect(() => resolveCredentialInstanceRef(auth, "openai-extra", "default")).toThrow(CredentialInstanceResolutionError);
  });

  it("throws when no auth default and no unique collapse rename match exist", () => {
    const auth = storage({
      values: new Map([["umans", { type: "api_key", key: "umans-key" }]]),
      listProviders: ["umans"],
      getDefaultInstance: (provider) => (provider === "umans" ? { providerId: "umans", instanceId: "default" } : undefined),
    });
    // umans vs umansapi do not collapse equal — session soft-heal covers this case via legacy path
    expect(findRenamedProviderDefaultInstance(auth, "umansapi")).toBeUndefined();
    expect(() => resolveCredentialInstanceRef(auth, "umansapi", "default")).toThrow(CredentialInstanceResolutionError);
  });
});
