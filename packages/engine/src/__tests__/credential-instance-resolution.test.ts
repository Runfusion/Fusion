import { describe, expect, it } from "vitest";
import type { FusionAuthStorage } from "../auth-storage.js";
import { CredentialInstanceResolutionError, createFusionCredentialStore, resolveCredentialInstanceRef } from "../auth-storage.js";

function storage(): FusionAuthStorage {
  const values = new Map([
    ["openai[work]", { type: "api_key", key: "work-key" }],
    ["openai[personal]", { type: "api_key", key: "personal-key" }],
    ["fallback", { type: "api_key", key: "fallback-key" }],
  ]);
  const ref = (providerId: string, instanceId: string) => ({ providerId, instanceId });
  return {
    reload() {}, get: provider => values.get(provider), getAll: () => ({}), list: () => ["openai", "fallback"], has: () => true, hasAuth: () => true,
    listInstances: provider => provider === "openai" ? [ref("openai", "work"), ref("openai", "personal")] : [],
    getInstance: item => values.get(`${item.providerId}[${item.instanceId}]`), setInstance: async (item, credential) => { values.set(`${item.providerId}[${item.instanceId}]`, credential); }, removeInstance: async () => {},
    getDefaultInstance: provider => provider === "openai" ? ref("openai", "work") : undefined, setDefaultInstance: async () => {},
    set: async () => {}, remove: async () => {}, logout: async () => {}, getApiKey: async () => undefined, getOAuthProviders: () => [], login: async () => {}, modify: async () => undefined, setModelRuntime: () => {},
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
    const noDefault = { ...auth, getDefaultInstance: () => undefined };
    expect(() => resolveCredentialInstanceRef(noDefault, "openai", "deleted")).toThrow(CredentialInstanceResolutionError);
  });
});
