import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempWorkspace } from "@fusion/test-utils";
import { createReadOnlyAuthFileStorage, mergeAuthStorageReads, wrapAuthStorageWithApiKeyProviders } from "../provider-auth.js";

function makeAuthStorage(credentials: Record<string, { type: string; key?: string; access?: string; refresh?: string; expires?: number }> = {}) {
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    hasAuth: vi.fn((provider: string) => Boolean(credentials[provider])),
    login: vi.fn(),
    logout: vi.fn(),
    set: vi.fn((provider: string, credential: { type: string; key?: string }) => {
      credentials[provider] = credential;
    }),
    remove: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    get: vi.fn((provider: string) => credentials[provider]),
    getAll: vi.fn(() => ({ ...credentials })),
    list: vi.fn(() => Object.keys(credentials)),
    getApiKey: vi.fn(async (provider: string) => credentials[provider]?.key),
  } as any;
}

describe("wrapAuthStorageWithApiKeyProviders", () => {
  it("reads API keys from Fusion auth first and legacy auth fallbacks second", async () => {
    const fusionAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "fusion-key" },
    });
    const legacyAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "legacy-openrouter-key" },
      minimax: { type: "api_key", key: "legacy-minimax-key" },
    });
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [legacyAuth]);

    expect(await wrapped.getApiKey("openrouter")).toBe("fusion-key");
    expect(await wrapped.getApiKey("minimax")).toBe("legacy-minimax-key");
    expect(wrapped.hasApiKey("minimax")).toBe(true);
    expect(wrapped.get("minimax")).toEqual({ type: "api_key", key: "legacy-minimax-key" });
  });

  it("writes API keys only to Fusion auth storage", () => {
    const fusionAuth = makeAuthStorage();
    const legacyAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "legacy-key" },
    });
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [legacyAuth]);
    wrapped.setApiKey("openrouter", "fusion-key");

    expect(fusionAuth.set).toHaveBeenCalledWith("openrouter", { type: "api_key", key: "fusion-key" });
    expect(legacyAuth.set).not.toHaveBeenCalled();
  });

  it("reloads all read stores so status reflects both locations", () => {
    const fusionAuth = makeAuthStorage();
    const legacyAuth = makeAuthStorage();
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [legacyAuth]);
    wrapped.reload();

    expect(fusionAuth.reload).toHaveBeenCalledTimes(1);
    expect(legacyAuth.reload).toHaveBeenCalledTimes(1);
  });

  it("creates an AuthStorage-compatible merged reader for ModelRegistry", async () => {
    const fusionAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "fusion-key" },
    });
    const legacyAuth = makeAuthStorage({
      minimax: { type: "api_key", key: "legacy-minimax-key" },
    });

    const merged = mergeAuthStorageReads(fusionAuth, [legacyAuth]);

    expect(await merged.getApiKey("openrouter")).toBe("fusion-key");
    expect(await merged.getApiKey("minimax")).toBe("legacy-minimax-key");
    expect(merged.get("minimax")).toEqual({ type: "api_key", key: "legacy-minimax-key" });
    expect(merged.list()).toEqual(expect.arrayContaining(["openrouter", "minimax"]));
  });

  it("excludes pi-claude-cli models from API key providers", () => {
    const fusionAuth = makeAuthStorage();
    const modelRegistry = {
      getAll: vi.fn(() => [
        { provider: "pi-claude-cli", id: "claude-cli/sonnet" },
        { provider: "openrouter", id: "openrouter/auto" },
      ]),
    } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toContain("openrouter");
    expect(providerIds).not.toContain("pi-claude-cli");
  });

  it("includes research-only API-key providers", () => {
    const fusionAuth = makeAuthStorage();
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toContain("brave");
    expect(providerIds).toContain("tavily");
  });

  it("always includes opencode-go when registry has no opencode models", () => {
    const fusionAuth = makeAuthStorage();
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toContain("opencode-go");
  });

  it("filters opencode-go from API key providers when OAuth provider id collides", () => {
    const fusionAuth = makeAuthStorage();
    fusionAuth.getOAuthProviders = vi.fn(() => [{ id: "opencode-go", name: "Opencode Go OAuth" }]);
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).not.toContain("opencode-go");
  });

  it("reads legacy auth JSON without creating missing files", async () => {
    const tempDir = tempWorkspace("fusion-provider-auth-");
    const legacyAgentDir = join(tempDir, ".pi", "agent");
    const legacyAgentAuth = join(legacyAgentDir, "auth.json");
    const missingLegacyAuth = join(tempDir, ".pi", "auth.json");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(legacyAgentAuth, JSON.stringify({ openrouter: { type: "api_key", key: "legacy-key" } }));

    const storage = createReadOnlyAuthFileStorage([legacyAgentAuth, missingLegacyAuth]);

    expect(await storage.getApiKey("openrouter")).toBe("legacy-key");
    expect(existsSync(missingLegacyAuth)).toBe(false);
  });

  it("reads non-expired OAuth credentials from legacy auth JSON", async () => {
    const tempDir = tempWorkspace("fusion-provider-auth-oauth-");
    const legacyAgentDir = join(tempDir, ".pi", "agent");
    const legacyAgentAuth = join(legacyAgentDir, "auth.json");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      legacyAgentAuth,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "legacy-access-token",
          refresh: "legacy-refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
    );

    const storage = createReadOnlyAuthFileStorage([legacyAgentAuth]);

    expect(await storage.getApiKey("openai-codex")).toBe("legacy-access-token");
  });

  describe("Anthropic provider classification", () => {
    it("keeps anthropic in getOAuthProviders when upstream reports it as OAuth", () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
        { id: "github-copilot", name: "GitHub Copilot" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      const oauthProviders = wrapped.getOAuthProviders();

      const oauthIds = oauthProviders.map((p) => p.id);
      expect(oauthIds).toContain("anthropic");
      expect(oauthIds).toContain("github-copilot");
    });

    it("does not duplicate anthropic in getApiKeyProviders when OAuth-backed", () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      const apiKeyProviders = wrapped.getApiKeyProviders();

      const anthropic = apiKeyProviders.find((p) => p.id === "anthropic");
      expect(anthropic).toBeUndefined();
    });

    it("stores anthropic credentials as api_key type", () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      wrapped.setApiKey("anthropic", "sk-ant-api03-test-key");

      expect(fusionAuth.set).toHaveBeenCalledWith("anthropic", {
        type: "api_key",
        key: "sk-ant-api03-test-key",
      });
    });

    it("detects anthropic as authenticated via hasApiKey after storing API key", () => {
      const fusionAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "sk-ant-api03-test" },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);

      expect(wrapped.hasApiKey("anthropic")).toBe(true);
    });
  });

  describe("logout with fallback credentials", () => {
    it("hides fallback credentials after logout", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);

      // Before logout, fallback credentials are visible
      expect(merged.has("anthropic")).toBe(true);
      expect(merged.hasAuth("anthropic")).toBe(true);
      expect(merged.get("anthropic")).toEqual({ type: "api_key", key: "claude-access-token" });

      // Log out
      merged.logout("anthropic");

      // After logout, fallback credentials are hidden
      expect(merged.has("anthropic")).toBe(false);
      expect(merged.hasAuth("anthropic")).toBe(false);
      expect(merged.get("anthropic")).toBeUndefined();
    });

    it("does not resurrect fallback credentials on reload after logout", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // reload() should NOT bring back the fallback credential
      merged.reload();

      expect(merged.has("anthropic")).toBe(false);
      expect(merged.hasAuth("anthropic")).toBe(false);
    });

    it("excludes logged-out providers from getAll()", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
        openrouter: { type: "api_key", key: "openrouter-key" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      const all = merged.getAll();
      expect("anthropic" in all).toBe(false);
      expect("openrouter" in all).toBe(true);
    });

    it("excludes logged-out providers from list()", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
        openrouter: { type: "api_key", key: "openrouter-key" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      expect(merged.list()).not.toContain("anthropic");
      expect(merged.list()).toContain("openrouter");
    });

    it("hides fallback getApiKey after logout", async () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);

      expect(await merged.getApiKey("anthropic")).toBe("claude-access-token");

      merged.logout("anthropic");

      expect(await merged.getApiKey("anthropic")).toBeUndefined();
    });

    it("re-enables fallback credentials after re-authentication via set()", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // Re-authenticate
      merged.set("anthropic", { type: "api_key", key: "new-key" });

      // Provider is visible again (from primary storage)
      expect(merged.has("anthropic")).toBe(true);
    });

    it("only hides the logged-out provider, not other fallback providers", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
        openrouter: { type: "api_key", key: "openrouter-key" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // anthropic is hidden
      expect(merged.hasAuth("anthropic")).toBe(false);
      // openrouter is still visible
      expect(merged.hasAuth("openrouter")).toBe(true);
    });

    it("returns false for hasAuth even when underlying storage reports auth via env var", () => {
      // Simulate the real AuthStorage which checks env vars in hasAuth
      const fusionAuth = makeAuthStorage();
      fusionAuth.hasAuth = vi.fn(() => true); // env var would make this true
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // Even though the underlying storage reports hasAuth=true (env var),
      // the logged-out provider must still return false
      expect(merged.hasAuth("anthropic")).toBe(false);
      expect(merged.has("anthropic")).toBe(false);
    });
  });
});
