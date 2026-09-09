import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth/auth-storage.js";

const validExpiry = Date.now() + 60 * 60 * 1000;

function oauth(access: string, refresh: string, label: string, accountId?: string) {
  return { type: "oauth", access, refresh, expires: validExpiry, label, ...(accountId ? { accountId } : {}) };
}

function codexJwt(accountId: string, expiresInSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}

describe("default-instance credential clobber regression", () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fusion-auth-default-clobber-"));
    process.env.HOME = home;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    globalThis.fetch = originalFetch;
  });

  const authPath = () => getFusionAuthPath(home);
  const seed = (data: Record<string, unknown>) => {
    mkdirSync(join(home, ".fusion", "agent"), { recursive: true });
    writeFileSync(authPath(), JSON.stringify(data));
  };

  it("a valid, not-near-expiry credential read performs no disk write", async () => {
    seed({
      anthropic: { type: "api_key", key: "raw-key" },
      "anthropic-subscription": oauth("subscription-access", "subscription-refresh", "subscription"),
      "openai-codex": oauth("codex-access", "codex-refresh", "codex"),
      "github-copilot": oauth("copilot-access", "copilot-refresh", "copilot"),
    });
    const before = readFileSync(authPath(), "utf8");
    const beforeMtime = statSync(authPath()).mtimeMs;
    const storage = createFusionAuthStorage();

    expect(await storage.getApiKey("anthropic")).toBe("raw-key");
    expect(await storage.getApiKey("anthropic-subscription")).toBe("subscription-access");
    expect(await storage.getApiKey("openai-codex")).toBe("codex-access");
    expect(await storage.getApiKey("github-copilot")).toBe("copilot-access");
    expect(readFileSync(authPath(), "utf8")).toBe(before);
    expect(statSync(authPath()).mtimeMs).toBe(beforeMtime);
  });

  it("a refresh of a named subscription instance is persisted to that instance, not to the current default", async () => {
    const work = { ...oauth("work-access", "work-refresh", "work"), expires: Date.now() - 1 };
    const personal = oauth("personal-access", "personal-refresh", "personal");
    seed({
      "anthropic-subscription[work]": work,
      "anthropic-subscription[personal]": personal,
      __fusionDefaultInstances: { "anthropic-subscription": "work" },
    });
    globalThis.fetch = (async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: "work-rotated", refresh_token: "work-rotated-refresh", expires_in: 3600 }),
    })) as typeof fetch;
    const storage = createFusionAuthStorage();

    expect(await storage.getApiKey("anthropic")).toBe("work-rotated");
    const persisted = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(persisted["anthropic-subscription[work]"]).toMatchObject({ access: "work-rotated", refresh: "work-rotated-refresh" });
    expect(persisted["anthropic-subscription[personal]"]).toEqual(personal);
  });

  it("a default-pointer switch mid-refresh does not land the rotated token in the newly selected row", async () => {
    const work = { ...oauth("work-access", "work-refresh", "work"), expires: Date.now() - 1 };
    const personal = oauth("personal-access", "personal-refresh", "personal");
    seed({
      "anthropic-subscription[work]": work,
      "anthropic-subscription[personal]": personal,
      __fusionDefaultInstances: { "anthropic-subscription": "work" },
    });
    const responseText = Promise.withResolvers<string>();
    const fetchStarted = Promise.withResolvers<void>();
    globalThis.fetch = vi.fn(async () => {
      fetchStarted.resolve();
      return { ok: true, text: async () => responseText.promise } as Response;
    }) as typeof fetch;
    const sessionStorage = createFusionAuthStorage();
    const pendingKey = sessionStorage.getApiKey("anthropic");
    await fetchStarted.promise;

    const settingsStorage = createFusionAuthStorage();
    await settingsStorage.setDefaultInstance({ providerId: "anthropic-subscription", instanceId: "personal" });
    responseText.resolve(JSON.stringify({ access_token: "work-rotated", refresh_token: "work-rotated-refresh", expires_in: 3600 }));

    expect(await pendingKey).toBe("personal-access");
    const persisted = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(persisted["anthropic-subscription[personal]"]).toEqual(personal);
    expect(persisted.__fusionDefaultInstances["anthropic-subscription"]).toBe("personal");
  });

  it("an OAuth refresh does not overwrite a raw Anthropic API-key row", async () => {
    const rawKey = { type: "api_key", key: "raw-anthropic-key" };
    const expiredSubscription = { ...oauth("subscription-access", "subscription-refresh", "subscription"), expires: Date.now() - 1 };
    seed({ anthropic: rawKey, "anthropic-subscription": expiredSubscription });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: "subscription-rotated", refresh_token: "subscription-rotated-refresh", expires_in: 3600 }),
    })) as typeof fetch;
    const storage = createFusionAuthStorage();

    expect(await storage.getApiKey("anthropic-subscription")).toBe("subscription-rotated");
    expect(JSON.parse(readFileSync(authPath(), "utf8")).anthropic).toEqual(rawKey);
  });

  it("refuses a newer same-row login injected after refresh reaches its material-fenced write", async () => {
    const expired = { ...oauth("old-access", "old-refresh", "work"), expires: Date.now() - 1 };
    const newerLogin = oauth("new-login-access", "new-login-refresh", "work");
    seed({ "anthropic-subscription[work]": expired, __fusionDefaultInstances: { "anthropic-subscription": "work" } });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: "stale-rotated-access", refresh_token: "stale-rotated-refresh", expires_in: 3600 }),
    })) as typeof fetch;

    const sessionStorage = createFusionAuthStorage();
    const settingsStorage = createFusionAuthStorage();
    const guardedStorage = sessionStorage as unknown as {
      setInstanceIfMaterialMatches: (ref: { providerId: string; instanceId: string }, expected: unknown, next: unknown) => Promise<boolean>;
    };
    const originalCompareAndSet = guardedStorage.setInstanceIfMaterialMatches.bind(guardedStorage);
    vi.spyOn(guardedStorage, "setInstanceIfMaterialMatches").mockImplementation(async (ref, expected, next) => {
      /*
      FNXC:ProviderAuth 2026-09-09-14:20:
      An independent auth owner can commit a newer login after refresh preparation but before the
      refresh write obtains the file lock. The production refresh entry must preserve that login.
      */
      await settingsStorage.setInstance(ref, newerLogin);
      return originalCompareAndSet(ref, expected, next);
    });

    await expect(sessionStorage.getApiKey("anthropic")).resolves.toBe("new-login-access");
    expect(JSON.parse(readFileSync(authPath(), "utf8"))["anthropic-subscription[work]"]).toEqual(newerLogin);
  });

  it("refreshes GitHub Copilot through ModelRuntime without reintroducing write-on-read", async () => {
    const expired = { ...oauth("old-copilot-access", "old-copilot-refresh", "copilot"), expires: Date.now() - 1 };
    seed({ "github-copilot": expired });
    const storage = createFusionAuthStorage();
    const getAuth = vi.fn(async (providerId: string) => {
      expect(providerId).toBe("github-copilot");
      await storage.set("github-copilot", oauth("rotated-copilot-access", "rotated-copilot-refresh", "copilot"));
      return {};
    });
    storage.setModelRuntime({ getAuth } as never);

    await expect(storage.getApiKey("github-copilot")).resolves.toBe("rotated-copilot-access");
    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(authPath(), "utf8"))["github-copilot"]).toMatchObject({ access: "rotated-copilot-access" });
  });

  it("observes another instance's default switch without an explicit reload", async () => {
    const first = createFusionAuthStorage();
    await first.setInstance({ providerId: "provider", instanceId: "a" }, { type: "api_key", key: "key-a" });
    await first.setInstance({ providerId: "provider", instanceId: "b" }, { type: "api_key", key: "key-b" });
    await first.setDefaultInstance({ providerId: "provider", instanceId: "a" });
    const second = createFusionAuthStorage();
    expect(second.get("provider")).toEqual({ type: "api_key", key: "key-a" });

    await first.setDefaultInstance({ providerId: "provider", instanceId: "b" });
    expect(second.get("provider")).toEqual({ type: "api_key", key: "key-b" });
    expect(second.getDefaultInstance("provider")).toEqual({ providerId: "provider", instanceId: "b" });
    expect(await second.getApiKey("provider")).toBe("key-b");
  });

  it("does not resurrect a removed credential from a stale snapshot", async () => {
    const first = createFusionAuthStorage();
    await first.setInstance({ providerId: "provider", instanceId: "account" }, { type: "api_key", key: "key" });
    const second = createFusionAuthStorage();
    expect(second.get("provider")).toEqual({ type: "api_key", key: "key" });

    await first.removeInstance({ providerId: "provider", instanceId: "account" });
    expect(second.get("provider")).toBeUndefined();
  });

  it("does not create an absent auth file while revalidating reads", () => {
    const storage = createFusionAuthStorage();
    // Construction creates Fusion's owned file; remove it to verify revalidation itself is passive.
    const path = authPath();
    unlinkSync(path);
    expect(storage.get("provider")).toBeUndefined();
    expect(storage.getDefaultInstance("provider")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses supplemental hydration for named and multi-instance targets", async () => {
    const first = oauth("first-access", "first-refresh", "first", "first-account");
    const second = oauth("second-access", "second-refresh", "second", "second-account");
    seed({
      "openai-codex[first]": first,
      "openai-codex[second]": second,
      __fusionDefaultInstances: { "openai-codex": "first" },
    });
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ tokens: {
      access_token: codexJwt("different-account", 7200), refresh_token: "cli-refresh",
    } }));

    const storage = createFusionAuthStorage();
    await storage.getApiKey("openai-codex");
    const persisted = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(persisted["openai-codex[first]"]).toEqual(first);
    expect(persisted["openai-codex[second]"]).toEqual(second);
    expect(persisted.__fusionDefaultInstances["openai-codex"]).toEqual("first");
  });

  it("refuses supplemental hydration over a single bare row with a different account id", async () => {
    const stored = oauth("stored-access", "stored-refresh", "stored", "stored-account");
    seed({ "openai-codex": stored });
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ tokens: {
      access_token: codexJwt("different-account", 7200), refresh_token: "cli-refresh",
    } }));

    const storage = createFusionAuthStorage();
    await storage.getApiKey("openai-codex");
    expect(JSON.parse(readFileSync(authPath(), "utf8"))["openai-codex"]).toEqual(stored);
  });

  it("a stale session must not copy the previous default account's credential into the newly selected row", async () => {
    const accountA = oauth("access-a", "refresh-a", "A");
    const accountB = oauth("access-b", "refresh-b", "B");
    seed({
      "anthropic-subscription[acct-a]": accountA,
      "anthropic-subscription[acct-b]": accountB,
      __fusionDefaultInstances: { "anthropic-subscription": "acct-a" },
    });

    const sessionStorage = createFusionAuthStorage();
    expect(await sessionStorage.getApiKey("anthropic")).toBe("access-a");

    const settingsStorage = createFusionAuthStorage();
    await settingsStorage.setDefaultInstance({ providerId: "anthropic-subscription", instanceId: "acct-b" });

    expect(await sessionStorage.getApiKey("anthropic")).toBe("access-b");
    const persisted = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(persisted["anthropic-subscription[acct-a]"]).toEqual(accountA);
    expect(persisted["anthropic-subscription[acct-b]"]).toEqual(accountB);
    expect(persisted.__fusionDefaultInstances["anthropic-subscription"]).toBe("acct-b");
  });
});
