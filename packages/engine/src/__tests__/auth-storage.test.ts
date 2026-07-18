import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, createFusionCredentialStore, getFusionAuthPath } from "../auth-storage.js";

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

function writeFusionAuth(homeDir: string, credentials: Record<string, unknown>): void {
  const fusionAgentDir = join(homeDir, ".fusion", "agent");
  mkdirSync(fusionAgentDir, { recursive: true });
  writeFileSync(getFusionAuthPath(homeDir), JSON.stringify(credentials));
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
    await authStorage.set("openrouter", { type: "api_key", key: "fusion-openrouter-key" });

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

    // Restored v0.51.0 behavior: a Claude subscription OAuth token resolves for the
    // direct `anthropic` provider (pi-ai POSTs it to /v1 with Claude Code impersonation).
    expect(await authStorage.getApiKey("anthropic")).toBe("claude-access-token");
    expect(authStorage.get("anthropic")).toEqual({
      type: "oauth",
      access: "claude-access-token",
      refresh: "claude-refresh-token",
      expires: expect.any(Number),
    });
  });

  describe("Anthropic subscription runtime auth alias", () => {
    it("returns undefined for Anthropic model runtime auth when no credential exists", async () => {
      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
      expect(authStorage.hasAuth("anthropic")).toBe(false);
    });

    it("preserves Anthropic fallback resolver auth when no stored credential exists", async () => {
      const authStorage = createFusionAuthStorage();
      (authStorage as unknown as { setFallbackResolver(resolver: (provider: string) => string | undefined): void })
        .setFallbackResolver((provider) => (provider === "anthropic" ? "fallback-anthropic-runtime-key" : undefined));

      expect(await authStorage.getApiKey("anthropic")).toBe("fallback-anthropic-runtime-key");
      expect(authStorage.hasAuth("anthropic")).toBe(true);
    });

    it("suppresses Anthropic fallback resolver auth after raw provider logout", async () => {
      const authStorage = createFusionAuthStorage();
      (authStorage as unknown as { setFallbackResolver(resolver: (provider: string) => string | undefined): void })
        .setFallbackResolver((provider) => (provider === "anthropic" ? "fallback-anthropic-runtime-key" : undefined));

      expect(await authStorage.getApiKey("anthropic")).toBe("fallback-anthropic-runtime-key");

      await authStorage.logout("anthropic");

      expect(authStorage.hasAuth("anthropic")).toBe(false);
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    });

    it("uses raw Anthropic API-key credentials for model runtime auth", async () => {
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
      });

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic")).toBe("sk-ant-api03-runtime-key");
      expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-api03-runtime-key" });
      expect(authStorage.hasAuth("anthropic")).toBe(true);
    });

    // FNXC:ProviderAuth 2026-07-17-06:30 — Symptom Verification for the pi >=0.80.8 ModelRuntime.getAuth
    // regression. Original symptom: a subscription-only Anthropic login (stored only under
    // `anthropic-subscription`) failed every task with "Provider is not configured: anthropic" and then
    // fell back, because pi-ai's resolveProviderAuth reads credentials.read("anthropic") directly and
    // refreshes an OAuth credential via credentials.modify("anthropic") — but fusion has no raw
    // `anthropic` row, so the refresh callback saw `current === undefined` and bailed. Fix: read("anthropic")
    // resolves through fusion's getApiKey (refresh + subscription/raw precedence) and returns a ready
    // api_key credential carrying the OAuth token (which pi-ai routes as OAuth by its sk-ant-oat prefix).
    it("resolves Anthropic subscription auth into a ready api_key credential via read('anthropic')", async () => {
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "sk-ant-oat01-subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();
      const credentialStore = createFusionCredentialStore(authStorage);

      // pi-ai's resolveProviderAuth reads provider `anthropic` directly; it must get a usable credential
      // whose token still carries the sk-ant-oat prefix so the anthropic-messages layer routes it as OAuth.
      expect(await credentialStore.read("anthropic")).toEqual({
        type: "api_key",
        key: "sk-ant-oat01-subscription-access-token",
      });
    });

    it("prefers a raw Anthropic credential over the subscription alias in read('anthropic')", async () => {
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
        "anthropic-subscription": {
          type: "oauth",
          access: "sk-ant-oat01-subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();
      const credentialStore = createFusionCredentialStore(authStorage);

      // Raw api_key wins (getApiKey precedence); the subscription token only fills the gap otherwise.
      expect(await credentialStore.read("anthropic")).toEqual({
        type: "api_key",
        key: "sk-ant-api03-runtime-key",
      });
    });

    it("read('anthropic') is undefined when no Anthropic credential of any kind exists", async () => {
      const authStorage = createFusionAuthStorage();
      const credentialStore = createFusionCredentialStore(authStorage);

      expect(await credentialStore.read("anthropic")).toBeUndefined();
    });

    it("uses Anthropic subscription OAuth for direct model runtime auth when no raw API key exists", async () => {
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();

      // The direct `anthropic` provider resolves the separated subscription OAuth token.
      expect(await authStorage.getApiKey("anthropic")).toBe("subscription-access-token");
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("subscription-access-token");
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(authStorage.list()).toEqual(expect.arrayContaining(["anthropic", "anthropic-subscription"]));
    });

    it("exposes legacy Anthropic OAuth through the subscription provider without raw direct auth", async () => {
      writeFusionAuth(homeDir, {
        anthropic: {
          type: "oauth",
          access: "legacy-subscription-access-token",
          refresh: "legacy-subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();

      // Legacy `anthropic` OAuth rows still drive the direct provider at runtime.
      expect(await authStorage.getApiKey("anthropic")).toBe("legacy-subscription-access-token");
      expect(authStorage.get("anthropic-subscription")).toEqual({
        type: "oauth",
        access: "legacy-subscription-access-token",
        refresh: "legacy-subscription-refresh-token",
        expires: expect.any(Number),
      });
      expect(authStorage.hasAuth("anthropic-subscription")).toBe(true);
      expect(authStorage.list()).toEqual(expect.arrayContaining(["anthropic", "anthropic-subscription"]));
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("legacy-subscription-access-token");
    });

    it("restores the subscription card when re-login writes the credential under the legacy anthropic id", async () => {
      // Repro of FN: interactive subscription login persists OAuth under `anthropic`,
      // but the settings card / status read is keyed on `anthropic-subscription`.
      // After an in-session logout the subscription id is suppressed; a successful
      // re-login must clear that suppression on BOTH aliases or the card is stuck
      // reporting "Login did not complete" despite a valid stored credential.
      const authStorage = createFusionAuthStorage();

      await authStorage.logout("anthropic-subscription");
      expect(authStorage.hasAuth("anthropic-subscription")).toBe(false);

      // `set` under the legacy id mirrors what interactive login persists.
      await authStorage.set("anthropic", {
        type: "oauth",
        access: "relogin-access-token",
        refresh: "relogin-refresh-token",
        expires: Date.now() + 3_600_000,
      });

      expect(authStorage.hasAuth("anthropic-subscription")).toBe(true);
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("relogin-access-token");
    });

    it("restores the subscription card when re-auth writes under the subscription id", async () => {
      const authStorage = createFusionAuthStorage();

      await authStorage.logout("anthropic-subscription");
      expect(authStorage.hasAuth("anthropic-subscription")).toBe(false);

      await authStorage.set("anthropic-subscription", {
        type: "oauth",
        access: "subscription-relogin-token",
        refresh: "subscription-relogin-refresh",
        expires: Date.now() + 3_600_000,
      });

      expect(authStorage.hasAuth("anthropic-subscription")).toBe(true);
    });

    it("does not revive a logged-out subscription card from a raw anthropic API key", async () => {
      // A raw `anthropic` API key belongs to its own card and must not alias into
      // the subscription's logged-out state — only OAuth credentials do.
      const authStorage = createFusionAuthStorage();

      await authStorage.logout("anthropic-subscription");
      await authStorage.set("anthropic", { type: "api_key", key: "sk-ant-api03-raw-key" });

      expect(authStorage.hasAuth("anthropic-subscription")).toBe(false);
    });

    it("refreshes legacy Anthropic OAuth in place for direct runtime auth", async () => {
      writeFusionAuth(homeDir, {
        anthropic: {
          type: "oauth",
          access: "expired-legacy-subscription-access-token",
          refresh: "legacy-subscription-refresh-token",
          expires: Date.now() - 60_000,
          scopes: ["user:profile"],
        },
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          access_token: "refreshed-legacy-access-token",
          refresh_token: "rotated-legacy-refresh-token",
          expires_in: 3600,
          scope: "user:profile",
        }),
      } as Response);
      globalThis.fetch = fetchMock as typeof fetch;

      const authStorage = createFusionAuthStorage();

      // A legacy `anthropic` OAuth row refreshes and persists back under `anthropic`
      // (the v0.51.0 direct-provider path); it is not re-homed into a subscription slot.
      expect(await authStorage.getApiKey("anthropic")).toBe("refreshed-legacy-access-token");
      expect(authStorage.get("anthropic")).toEqual({
        type: "oauth",
        access: "refreshed-legacy-access-token",
        refresh: "rotated-legacy-refresh-token",
        expires: expect.any(Number),
        scopes: ["user:profile"],
      });
    });

    it("keeps raw Anthropic API-key precedence when subscription OAuth also exists", async () => {
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
        "anthropic-subscription": {
          type: "oauth",
          access: "subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic")).toBe("sk-ant-api03-runtime-key");
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("subscription-access-token");
    });

    it("keeps raw Anthropic API-key precedence over legacy OAuth hydration", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "auth.json"),
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "legacy-subscription-access-token",
            refresh: "legacy-subscription-refresh-token",
            expires: Date.now() + 3_600_000,
          },
        }),
      );
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
      });

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic")).toBe("sk-ant-api03-runtime-key");
    });

    it("refreshes expired Anthropic subscription OAuth and persists it under the subscription storage id", async () => {
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "expired-subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() - 60_000,
          scopes: ["user:profile", "org:create_api_key"],
        },
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          access_token: "refreshed-subscription-access-token",
          refresh_token: "rotated-subscription-refresh-token",
          expires_in: 3600,
          scope: "user:profile org:create_api_key",
        }),
      } as Response);
      globalThis.fetch = fetchMock as typeof fetch;

      const authStorage = createFusionAuthStorage();

      // Refreshed subscription OAuth drives the direct provider and persists under the
      // subscription id only — the raw `anthropic` slot stays empty.
      expect(await authStorage.getApiKey("anthropic")).toBe("refreshed-subscription-access-token");
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("refreshed-subscription-access-token");
      // FNXC:ClaudeOAuth 2026-07-05-18:52: the refresh request MUST NOT send `scope`.
      // Per RFC 6749 §6 an included scope re-issues the token with exactly that scope
      // (never broader), which previously narrowed refreshed tokens to profile-only and
      // stripped `user:inference` — leaving the account "logged in" yet 403ing on every
      // model call. Omitting scope makes Anthropic preserve the originally-granted scopes.
      expect(fetchMock).toHaveBeenCalledWith(
        "https://platform.claude.com/v1/oauth/token",
        expect.objectContaining({
          method: "POST",
          body: expect.not.stringContaining("\"scope\""),
        }),
      );
      const refreshRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(refreshRequest?.body))).toMatchObject({
        grant_type: "refresh_token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        refresh_token: "subscription-refresh-token",
      });
      expect(authStorage.get("anthropic-subscription")).toEqual({
        type: "oauth",
        access: "refreshed-subscription-access-token",
        refresh: "rotated-subscription-refresh-token",
        expires: expect.any(Number),
        scopes: ["user:profile", "org:create_api_key"],
      });
      expect(authStorage.get("anthropic")).toBeUndefined();

      const persisted = JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8"));
      expect(persisted["anthropic-subscription"]).toEqual({
        type: "oauth",
        access: "refreshed-subscription-access-token",
        refresh: "rotated-subscription-refresh-token",
        expires: expect.any(Number),
        scopes: ["user:profile", "org:create_api_key"],
      });
      expect(persisted.anthropic).toBeUndefined();
    });

    /*
    FNXC:ClaudeOAuth 2026-07-05-00:00:
    FN-7574 symptom verification: a healthy subscription OAuth credential that is still
    within its validity window but nearing expiry must be refreshed proactively —
    BEFORE it actually expires — the first time something reads it (e.g. the periodic
    OAuthRefreshScheduler tick), not only reactively once it has already lapsed.
    */
    it("proactively refreshes subscription OAuth nearing expiry, ahead of actual expiration", async () => {
      const now = Date.now();
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "soon-to-expire-access-token",
          refresh: "subscription-refresh-token",
          // Still valid for another 2 minutes — inside the widened proactive-refresh
          // window, but not yet actually expired.
          expires: now + 120_000,
        },
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          access_token: "proactively-refreshed-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
      } as Response);
      globalThis.fetch = fetchMock as typeof fetch;

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("proactively-refreshed-access-token");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const refreshed = authStorage.get("anthropic-subscription");
      expect(refreshed).toMatchObject({ access: "proactively-refreshed-access-token" });
      expect((refreshed as { expires: number }).expires).toBeGreaterThan(now + 120_000);
    });

    it("does not proactively refresh subscription OAuth that is not yet within the refresh window", async () => {
      const now = Date.now();
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "still-fresh-access-token",
          refresh: "subscription-refresh-token",
          // Comfortably outside the proactive-refresh buffer.
          expires: now + 3_600_000,
        },
      });

      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("still-fresh-access-token");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not resurrect stale Anthropic subscription OAuth after failed refresh", async () => {
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "expired-subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() - 60_000,
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_grant" }),
      } as Response) as typeof fetch;

      const authStorage = createFusionAuthStorage();

      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
      const persisted = JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8"));
      expect(persisted["anthropic-subscription"]).toEqual({
        type: "oauth",
        access: "expired-subscription-access-token",
        refresh: "subscription-refresh-token",
        expires: expect.any(Number),
      });
    });

    it("keeps subscription OAuth available for runtime auth after raw Anthropic logout", async () => {
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
        "anthropic-subscription": {
          type: "oauth",
          access: "subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();
      await authStorage.logout("anthropic");

      // Raw-key logout removes only the raw slot; subscription OAuth still powers
      // the direct `anthropic` runtime provider.
      expect(authStorage.get("anthropic")).toBeUndefined();
      expect(authStorage.has("anthropic")).toBe(true);
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(authStorage.list()).toEqual(expect.arrayContaining(["anthropic", "anthropic-subscription"]));
      expect(await authStorage.getApiKey("anthropic")).toBe("subscription-access-token");
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("subscription-access-token");
    });

    it("uses a newly set subscription credential for runtime auth after raw Anthropic logout", async () => {
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
      });

      const authStorage = createFusionAuthStorage();
      await authStorage.logout("anthropic");
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();

      await authStorage.set("anthropic-subscription", {
        type: "oauth",
        access: "subscription-access-token",
        refresh: "subscription-refresh-token",
        expires: Date.now() + 3_600_000,
      });

      expect(authStorage.get("anthropic")).toBeUndefined();
      expect(await authStorage.getApiKey("anthropic")).toBe("subscription-access-token");
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("subscription-access-token");
    });

    it("keeps raw Anthropic API keys visible when subscription logout suppresses OAuth aliases", async () => {
      writeFusionAuth(homeDir, {
        anthropic: { type: "api_key", key: "sk-ant-api03-runtime-key" },
        "anthropic-subscription": {
          type: "oauth",
          access: "subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();
      await authStorage.logout("anthropic-subscription");

      expect(authStorage.get("anthropic-subscription")).toBeUndefined();
      expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-api03-runtime-key" });
      expect(await authStorage.getApiKey("anthropic")).toBe("sk-ant-api03-runtime-key");
    });

    it("suppresses legacy Anthropic OAuth after subscription logout", async () => {
      writeFusionAuth(homeDir, {
        anthropic: {
          type: "oauth",
          access: "legacy-subscription-access-token",
          refresh: "legacy-subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();
      // Before logout the legacy OAuth row drives direct runtime auth…
      expect(await authStorage.getApiKey("anthropic")).toBe("legacy-subscription-access-token");

      await authStorage.logout("anthropic-subscription");

      // …and subscription logout suppresses the legacy OAuth alias everywhere.
      expect(authStorage.get("anthropic")).toBeUndefined();
      expect(authStorage.has("anthropic")).toBe(false);
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      expect(authStorage.list()).not.toContain("anthropic");
      expect(authStorage.getAll()).not.toHaveProperty("anthropic");
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    });

    it("suppresses supplemental legacy Anthropic OAuth status after subscription logout", async () => {
      const legacyAgentDir = join(homeDir, ".pi", "agent");
      mkdirSync(legacyAgentDir, { recursive: true });
      writeFileSync(
        join(legacyAgentDir, "auth.json"),
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "legacy-subscription-access-token",
            refresh: "legacy-subscription-refresh-token",
            expires: Date.now() + 3_600_000,
          },
        }),
      );

      const authStorage = createFusionAuthStorage();
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(authStorage.list()).toContain("anthropic");

      await authStorage.logout("anthropic-subscription");

      expect(authStorage.get("anthropic")).toBeUndefined();
      expect(authStorage.has("anthropic")).toBe(false);
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      expect(authStorage.list()).not.toContain("anthropic");
      expect(authStorage.getAll()).not.toHaveProperty("anthropic");
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    });

    it("keeps models.json Anthropic fallback visible after subscription logout", async () => {
      const fusionAgentDir = join(homeDir, ".fusion", "agent");
      mkdirSync(fusionAgentDir, { recursive: true });
      writeFileSync(
        join(fusionAgentDir, "models.json"),
        JSON.stringify({ providers: { anthropic: { apiKey: "models-runtime-key" } } }),
      );
      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });

      const authStorage = createFusionAuthStorage();
      await authStorage.logout("anthropic-subscription");

      expect(authStorage.has("anthropic")).toBe(true);
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(authStorage.list()).toContain("anthropic");
      expect(authStorage.get("anthropic")).toBeUndefined();
      expect(await authStorage.getApiKey("anthropic")).toBe("models-runtime-key");
    });

    it("suppresses models.json Anthropic fallback after raw provider logout", async () => {
      const fusionAgentDir = join(homeDir, ".fusion", "agent");
      mkdirSync(fusionAgentDir, { recursive: true });
      writeFileSync(
        join(fusionAgentDir, "models.json"),
        JSON.stringify({ providers: { anthropic: { apiKey: "models-runtime-key" } } }),
      );

      const authStorage = createFusionAuthStorage();
      expect(authStorage.has("anthropic")).toBe(true);
      expect(await authStorage.getApiKey("anthropic")).toBe("models-runtime-key");

      await authStorage.logout("anthropic");

      expect(authStorage.has("anthropic")).toBe(false);
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      expect(authStorage.list()).not.toContain("anthropic");
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    });

    it("reloads Anthropic subscription OAuth alias state for model runtime auth", async () => {
      writeFusionAuth(homeDir, {});
      const authStorage = createFusionAuthStorage();
      expect(await authStorage.getApiKey("anthropic")).toBeUndefined();

      writeFusionAuth(homeDir, {
        "anthropic-subscription": {
          type: "oauth",
          access: "subscription-access-token",
          refresh: "subscription-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      });
      authStorage.reload();

      expect(await authStorage.getApiKey("anthropic")).toBe("subscription-access-token");
      expect(await authStorage.getApiKey("anthropic-subscription")).toBe("subscription-access-token");
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
      text: async () => JSON.stringify({
        access_token: "refreshed-claude-access-token",
        refresh_token: "rotated-claude-refresh-token",
        expires_in: 3600,
        scope: "user:profile org:create_api_key",
      }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("anthropic")).toBe("refreshed-claude-access-token");
    // FNXC:ClaudeOAuth 2026-07-05-18:52: refresh must omit `scope` so Anthropic preserves
    // the original grant (RFC 6749 §6); sending it previously stripped `user:inference`.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.claude.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.not.stringContaining("\"scope\""),
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
      text: async () => JSON.stringify({ expires_in: 3600 }),
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

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
    // Failed refresh is attempted once, then cooled down (second call does not re-hit the endpoint).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const persisted = existsSync(getFusionAuthPath(homeDir)) ? JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8")) : {};
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
      text: async () => JSON.stringify({
        access_token: "refreshed-claude-access-token",
        refresh_token: "rotated-claude-refresh-token",
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

    let resolveText: ((value: string) => void) | undefined;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => new Promise<string>((resolve) => {
        resolveText = resolve;
      }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const authStorage = createFusionAuthStorage();
    const pendingRefresh = authStorage.getApiKey("anthropic");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await authStorage.set("anthropic", {
      type: "oauth",
      access: "fresh-login-access-token",
      refresh: "fresh-login-refresh-token",
      expires: Date.now() + 3_600_000,
    });

    resolveText?.(JSON.stringify({
      access_token: "stale-refresh-access-token",
      refresh_token: "stale-refresh-refresh-token",
      expires_in: 3600,
    }));

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

      // Before logout, supplemental credentials are visible and drive runtime auth
      expect(authStorage.has("anthropic")).toBe(true);
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(await authStorage.getApiKey("anthropic")).toBe("claude-access-token");

      // Log out
      await authStorage.logout("anthropic");

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
      await authStorage.logout("anthropic");

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
      await authStorage.logout("anthropic");

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
      await authStorage.logout("anthropic");

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
      await authStorage.logout("anthropic");

      // Re-authenticate
      await authStorage.set("anthropic", { type: "api_key", key: "new-key" });

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
      await authStorage.logout("anthropic");

      // anthropic is hidden
      expect(authStorage.hasAuth("anthropic")).toBe(false);
      // openrouter is still visible
      expect(authStorage.hasAuth("openrouter")).toBe(true);
      expect(await authStorage.getApiKey("openrouter")).toBe("legacy-openrouter-key");
    });
  });
});
