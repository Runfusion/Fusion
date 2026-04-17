import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyAuthFileStorage, mergeAuthStorageReads, wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";

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


  it("reads legacy auth JSON without creating missing files", async () => {
    const tempDir = join(tmpdir(), `fusion-provider-auth-${process.pid}-${Date.now()}`);
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
    const tempDir = join(tmpdir(), `fusion-provider-auth-oauth-${process.pid}-${Date.now()}`);
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
});
