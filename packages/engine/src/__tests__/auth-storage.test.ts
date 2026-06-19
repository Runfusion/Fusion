import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth-storage.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function createJwt(payload: Record<string, unknown>): string {
  return [
    encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    encodeBase64Url(JSON.stringify(payload)),
    "signature",
  ].join(".");
}

describe("createFusionAuthStorage", () => {
  // HOME override required — createFusionAuthStorage() has no dir parameter
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-engine-auth-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true });
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("writes to Fusion auth and reads legacy Pi auth as fallback", async () => {
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        openrouter: { type: "api_key", key: "legacy-openrouter-key" },
        minimax: { type: "api_key", key: "legacy-minimax-key" },
      }),
    );

    const authStorage = createFusionAuthStorage();
    authStorage.set("openrouter", { type: "api_key", key: "fusion-openrouter-key" });

    expect(await authStorage.getApiKey("openrouter")).toBe("fusion-openrouter-key");
    expect(await authStorage.getApiKey("minimax")).toBe("legacy-minimax-key");
    expect(authStorage.get("minimax")).toEqual({ type: "api_key", key: "legacy-minimax-key" });
    expect(existsSync(getFusionAuthPath(homeDir))).toBe(true);
  });

  it("reads non-expired legacy Pi OAuth credentials as fallback", async () => {
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "legacy-access-token",
          refresh: "legacy-refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
    );

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openai-codex")).toBe("legacy-access-token");
  });

  it("does not use expired legacy Pi OAuth credentials", async () => {
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "expired-access-token",
          refresh: "legacy-refresh-token",
          expires: Date.now() - 60_000,
        },
      }),
    );

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openai-codex")).toBeUndefined();
  });

  it("does not create missing legacy Pi auth files", async () => {
    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openrouter")).toBeUndefined();
    expect(existsSync(join(homeDir, ".pi", "agent", "auth.json"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi", "auth.json"))).toBe(false);
  });

  it("reads valid Codex CLI OAuth credentials from ~/.codex/auth.json", async () => {
    const codexDir = join(homeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const accessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_codex",
      },
    });

    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "codex-refresh-token",
        },
      }),
    );

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openai-codex")).toBe(accessToken);
    expect(authStorage.get("openai-codex")).toEqual({
      type: "oauth",
      access: accessToken,
      refresh: "codex-refresh-token",
      expires: expect.any(Number),
      accountId: "acct_codex",
    });
  });

  it("reads valid Claude OAuth credentials from Claude credential files", async () => {
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access-token",
          refreshToken: "claude-refresh-token",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("anthropic")).toBe("claude-access-token");
    expect(authStorage.get("anthropic")).toEqual({
      type: "oauth",
      access: "claude-access-token",
      refresh: "claude-refresh-token",
      expires: expect.any(Number),
    });
  });

  it("refreshes and persists expired Claude OAuth credentials from Claude credential files", async () => {
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-claude-access-token",
          refreshToken: "claude-refresh-token",
          expiresAt: Date.now() - 60_000,
          scopes: ["user:profile", "org:create_api_key"],
        },
      }),
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "refreshed-claude-access-token",
        refresh_token: "rotated-claude-refresh-token",
        expires_in: 3600,
        scope: "user:profile org:create_api_key",
      }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("anthropic")).toBe("refreshed-claude-access-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.claude.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("\"scope\":\"user:profile org:create_api_key\""),
      }),
    );
    expect(authStorage.get("anthropic")).toEqual({
      type: "oauth",
      access: "refreshed-claude-access-token",
      refresh: "rotated-claude-refresh-token",
      expires: expect.any(Number),
      scopes: ["user:profile", "org:create_api_key"],
    });

    const persisted = JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8"));
    expect(persisted.anthropic).toEqual({
      type: "oauth",
      access: "refreshed-claude-access-token",
      refresh: "rotated-claude-refresh-token",
      expires: expect.any(Number),
      scopes: ["user:profile", "org:create_api_key"],
    });
  });

  it("does not persist an invalid Claude OAuth refresh response", async () => {
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-claude-access-token",
          refreshToken: "claude-refresh-token",
          expiresAt: Date.now() - 60_000,
        },
      }),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_in: 3600 }),
    } as Response) as typeof fetch;

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    const persisted = JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8"));
    expect(persisted.anthropic).toBeUndefined();
  });

  it("cooldowns failed Claude OAuth refresh attempts", async () => {
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-claude-access-token",
          refreshToken: "claude-refresh-token",
          expiresAt: Date.now() - 60_000,
        },
      }),
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8"));
    expect(persisted.anthropic).toBeUndefined();
  });

  it("coalesces concurrent Claude OAuth refresh attempts", async () => {
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-claude-access-token",
          refreshToken: "claude-refresh-token",
          expiresAt: Date.now() - 60_000,
        },
      }),
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "refreshed-claude-access-token",
        expires_in: 3600,
      }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();

    await expect(Promise.all([
      authStorage.getApiKey("anthropic"),
      authStorage.getApiKey("anthropic"),
      authStorage.getApiKey("anthropic"),
    ])).resolves.toEqual([
      "refreshed-claude-access-token",
      "refreshed-claude-access-token",
      "refreshed-claude-access-token",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale Claude OAuth refresh overwrite a newer login", async () => {
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-claude-access-token",
          refreshToken: "claude-refresh-token",
          expiresAt: Date.now() - 60_000,
        },
      }),
    );

    let resolveJson: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise((resolve) => {
        resolveJson = resolve;
      }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();
    const pendingRefresh = authStorage.getApiKey("anthropic");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    authStorage.set("anthropic", {
      type: "oauth",
      access: "fresh-login-access-token",
      refresh: "fresh-login-refresh-token",
      expires: Date.now() + 3_600_000,
    });

    resolveJson?.({
      access_token: "stale-refresh-access-token",
      refresh_token: "stale-refresh-refresh-token",
      expires_in: 3600,
    });

    await expect(pendingRefresh).resolves.toBe("fresh-login-access-token");
    expect(authStorage.get("anthropic")).toEqual({
      type: "oauth",
      access: "fresh-login-access-token",
      refresh: "fresh-login-refresh-token",
      expires: expect.any(Number),
    });
  });

  it("hydrates newer Codex CLI OAuth credentials into Fusion auth on reload", async () => {
    const fusionAgentDir = join(homeDir, ".fusion", "agent");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(fusionAgentDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    const olderAccessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    writeFileSync(
      getFusionAuthPath(homeDir),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: olderAccessToken,
          refresh: "old-refresh-token",
          expires: Date.now() + 900_000,
        },
      }),
    );

    const newerAccessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_newer",
      },
    });
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: newerAccessToken,
          refresh_token: "new-refresh-token",
        },
      }),
    );

    const authStorage = createFusionAuthStorage();
    authStorage.reload();

    expect(await authStorage.getApiKey("openai-codex")).toBe(newerAccessToken);
    expect(authStorage.get("openai-codex")).toEqual({
      type: "oauth",
      access: newerAccessToken,
      refresh: "new-refresh-token",
      expires: expect.any(Number),
      accountId: "acct_newer",
    });
  });

  describe("models.json API key fallback", () => {
    it("returns API key from models.json when not in auth.json", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": {
              api: "openai-completions",
              apiKey: "kimi-api-key-123",
              baseUrl: "https://api.kimi.com/coding/v1",
              models: [],
            },
          },
        }),
      );

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("kimi-coding")).toBe("kimi-api-key-123");
    });

    it("returns hasAuth=true for provider with key only in models.json", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": {
              api: "openai-completions",
              apiKey: "kimi-api-key-123",
              baseUrl: "https://api.kimi.com/coding/v1",
              models: [],
            },
          },
        }),
      );

      const authStorage = createFusionAuthStorage();

      expect(authStorage.hasAuth("kimi-coding")).toBe(true);
    });

    it("includes models.json providers in list()", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "auth.json"),
        JSON.stringify({
          openrouter: { type: "api_key", key: "openrouter-key" },
        }),
      );
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": { apiKey: "kimi-key" },
            lmstudio: { apiKey: "lm-key" },
          },
        }),
      );

      const authStorage = createFusionAuthStorage();
      const providers = authStorage.list();

      expect(providers).toContain("openrouter");
      expect(providers).toContain("kimi-coding");
      expect(providers).toContain("lmstudio");
    });

    it("auth.json keys take precedence over models.json keys", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "auth.json"),
        JSON.stringify({
          "kimi-coding": { type: "api_key", key: "auth-json-key" },
        }),
      );
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": { apiKey: "models-json-key" },
          },
        }),
      );

      const authStorage = createFusionAuthStorage();

      // auth.json key should take precedence
      expect(await authStorage.getApiKey("kimi-coding")).toBe("auth-json-key");
    });

    it("reload() picks up changes to models.json", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });

      // Initially no models.json
      const authStorage = createFusionAuthStorage();
      expect(await authStorage.getApiKey("kimi-coding")).toBeUndefined();

      // Write models.json and reload
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": { apiKey: "new-kimi-key" },
          },
        }),
      );

      authStorage.reload();

      expect(await authStorage.getApiKey("kimi-coding")).toBe("new-kimi-key");
    });

    it("reads from Fusion models.json before legacy paths", async () => {
      // Create both Fusion and legacy models.json
      const fusionAgentDir = join(homeDir, ".fusion", "agent");
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(fusionAgentDir, { recursive: true });
      mkdirSync(legacyAgentDir, { recursive: true });

      writeFileSync(
        join(fusionAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": { apiKey: "fusion-models-key" },
          },
        }),
      );
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "kimi-coding": { apiKey: "legacy-models-key" },
          },
        }),
      );

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("kimi-coding")).toBe("fusion-models-key");
    });

    it("has() returns true for provider with key only in models.json", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            ollama: { apiKey: "ollama-key" },
          },
        }),
      );

      const authStorage = createFusionAuthStorage();

      expect(authStorage.has("ollama")).toBe(true);
    });

    it("forwards setFallbackResolver to the underlying AuthStorage", async () => {
      const authStorage = createFusionAuthStorage();

      // Set a fallback resolver (this is what ModelRegistry does in its constructor)
      // Without the Proxy `set` trap, this would write to the Proxy object instead
      // of the underlying AuthStorage, making the resolver invisible to getApiKey().
      (authStorage as any).setFallbackResolver((provider: string) => {
        if (provider === "dynamic-provider") return "dynamic-api-key";
        return undefined;
      });

      expect(await authStorage.getApiKey("dynamic-provider")).toBe("dynamic-api-key");
      expect(await authStorage.getApiKey("unknown-provider")).toBeUndefined();
      expect(authStorage.hasAuth("dynamic-provider")).toBe(true);
    });
  });

  describe("logout with supplemental credentials", () => {
    it("hides supplemental Claude credentials after logout", async () => {
      const claudeDir = join(homeDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );

      const authStorage = createFusionAuthStorage();

      // Before logout, supplemental credentials are visible
      expect(authStorage.has("anthropic")).toBe(true);
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(await authStorage.getApiKey("anthropic")).toBe("claude-access-token");

      // Log out
      authStorage.logout("anthropic");

      // After logout, supplemental credentials are hidden
      expect(authStorage.has("anthropic")).toBe(false);
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      expect(authStorage.get("anthropic")).toBeUndefined();
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    });

    it("does not resurrect supplemental credentials on reload after logout", async () => {
      const claudeDir = join(homeDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );

      const authStorage = createFusionAuthStorage();
      authStorage.logout("anthropic");

      // reload() should NOT bring back the supplemental credential
      authStorage.reload();

      expect(authStorage.has("anthropic")).toBe(false);
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    });

    it("excludes logged-out providers from getAll()", async () => {
      const claudeDir = join(homeDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );

      const authStorage = createFusionAuthStorage();
      authStorage.logout("anthropic");

      const all = authStorage.getAll();
      expect("anthropic" in all).toBe(false);
    });

    it("excludes logged-out providers from list()", async () => {
      const claudeDir = join(homeDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );

      const authStorage = createFusionAuthStorage();
      authStorage.logout("anthropic");

      expect(authStorage.list()).not.toContain("anthropic");
    });

    it("re-enables supplemental credentials after re-authentication via set()", async () => {
      const claudeDir = join(homeDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );

      const authStorage = createFusionAuthStorage();
      authStorage.logout("anthropic");

      // Re-authenticate
      authStorage.set("anthropic", { type: "api_key", key: "new-key" });

      // Provider is visible again
      expect(authStorage.has("anthropic")).toBe(true);
      expect(await authStorage.getApiKey("anthropic")).toBe("new-key");
    });

    it("only hides the logged-out provider, not other supplemental providers", async () => {
      const claudeDir = join(homeDir, ".claude");
      const legacyDir = join(homeDir, ".pi", "agent");
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(legacyDir, { recursive: true });

      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );
      writeFileSync(
        join(legacyDir, "auth.json"),
        JSON.stringify({
          openrouter: { type: "api_key", key: "legacy-openrouter-key" },
        }),
      );

      const authStorage = createFusionAuthStorage();
      authStorage.logout("anthropic");

      // anthropic is hidden
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      // openrouter is still visible
      expect(authStorage.hasAuth("openrouter")).toBe(true);
      expect(await authStorage.getApiKey("openrouter")).toBe("legacy-openrouter-key");
    });
  });
});
