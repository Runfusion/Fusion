import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { createFusionAuthStorage, createFusionCredentialStore, getFusionAuthPath } from "../auth/auth-storage.js";

/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7646: multiple independent Fusion processes on one machine (a CLI-served web app and a
desktop app, or two CLI processes) each construct their own createFusionAuthStorage()
instance over the SAME shared ~/.fusion/agent/auth.json. The vendored
@earendil-works/pi-coding-agent FileAuthStorageBackend coordinates concurrent writers via
proper-lockfile + a per-provider read-modify-merge (persistProviderChange /
refreshOAuthTokenWithLock re-read the file under a lock and spread
{...currentData, [provider]: credential}) — so a write from one process must never flush
a stale full-snapshot view that clobbers another process's provider credentials. These
tests reproduce the reported symptom (API keys saved in the web app vanish after the
desktop app runs) as a real interleaved-writer scenario over a temp auth.json and assert
survival both on disk and via a freshly constructed instance. They intentionally do NOT
assert on raw token material — only presence/absence and provider ids/types.
*/

function readAuthFile(homeDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf-8")) as Record<string, unknown>;
}

describe("createFusionAuthStorage — concurrent cross-process coordination", () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-engine-auth-concurrency-"));
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

  async function releaseHeldLockAfter(path: string, holdMs = 40): Promise<void> {
    const release = await lockfile.lock(path, { realpath: false });
    setTimeout(() => { void release(); }, holdMs);
  }

  it("waits for an independently held lock before set persists the credential", async () => {
    const storage = createFusionAuthStorage();
    const authPath = getFusionAuthPath(homeDir);
    await releaseHeldLockAfter(authPath);

    await expect(storage.set("openrouter", { type: "api_key", key: "held-lock-key" })).resolves.toBeUndefined();

    const onDisk = readAuthFile(homeDir);
    expect((onDisk.openrouter as { type?: string } | undefined)?.type).toBe("api_key");
    const freshStorage = createFusionAuthStorage();
    expect(freshStorage.has("openrouter")).toBe(true);
  });

  it("waits for held locks before remove and CredentialStore.delete", async () => {
    const storage = createFusionAuthStorage();
    const authPath = getFusionAuthPath(homeDir);
    await storage.set("openrouter", { type: "api_key", key: "present" });
    await storage.set("groq", { type: "api_key", key: "present" });

    await releaseHeldLockAfter(authPath);
    await expect(storage.remove("openrouter")).resolves.toBeUndefined();

    const credentialStore = createFusionCredentialStore(storage);
    await releaseHeldLockAfter(authPath);
    await expect(credentialStore.delete("groq")).resolves.toBeUndefined();

    const onDisk = readAuthFile(homeDir);
    expect(onDisk.openrouter).toBeUndefined();
    expect(onDisk.groq).toBeUndefined();
  });

  it("releases the per-path queue after a failed lock acquisition", async () => {
    const storage = createFusionAuthStorage();
    const lockSpy = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(new Error("injected lock failure"));

    await expect(storage.set("openrouter", { type: "api_key", key: "fails" })).rejects.toThrow("injected lock failure");
    lockSpy.mockRestore();
    await expect(storage.set("openrouter", { type: "api_key", key: "succeeds" })).resolves.toBeUndefined();

    expect(storage.has("openrouter")).toBe(true);
  });

  it("survives an unrelated oauth set from a second instance (missing-file baseline)", async () => {
    // Baseline: no auth.json exists yet when both instances are constructed.
    const instanceA = createFusionAuthStorage();
    await instanceA.set("openai", { type: "api_key", key: "web-openai-key" });
    await instanceA.set("openrouter", { type: "api_key", key: "web-openrouter-key" });

    // Instance B (e.g. the desktop app) constructs its own storage AFTER A's writes
    // are already on disk, then writes an unrelated provider's OAuth credential.
    const instanceB = createFusionAuthStorage();
    await instanceB.set("anthropic-subscription", {
      type: "oauth",
      access: "desktop-access",
      refresh: "desktop-refresh",
      expires: Date.now() + 3_600_000,
    });

    const onDisk = readAuthFile(homeDir);
    expect(onDisk.openai).toEqual({ type: "api_key", key: "web-openai-key" });
    expect(onDisk.openrouter).toEqual({ type: "api_key", key: "web-openrouter-key" });
    expect((onDisk["anthropic-subscription"] as { type: string }).type).toBe("oauth");

    const instanceC = createFusionAuthStorage();
    expect(await instanceC.getApiKey("openai")).toBe("web-openai-key");
    expect(await instanceC.getApiKey("openrouter")).toBe("web-openrouter-key");
  });

  it("survives instance B writing a NEW provider after loading a stale snapshot", async () => {
    const instanceA = createFusionAuthStorage();
    await instanceA.set("openai", { type: "api_key", key: "web-openai-key" });

    // B constructs (and thus snapshots) BEFORE A's second write below.
    const instanceB = createFusionAuthStorage();

    // A saves a new provider key while B is alive holding a stale in-memory snapshot —
    // this is the exact "web app writing while the desktop process is alive" scenario.
    await instanceA.set("openrouter", { type: "api_key", key: "web-openrouter-key" });

    // B performs its own write for a THIRD, different provider. Historically a
    // whole-file snapshot flush from B would wipe out A's mid-session write.
    await instanceB.set("groq", { type: "api_key", key: "desktop-groq-key" });

    const onDisk = readAuthFile(homeDir);
    expect(onDisk.openai).toEqual({ type: "api_key", key: "web-openai-key" });
    expect(onDisk.openrouter).toEqual({ type: "api_key", key: "web-openrouter-key" });
    expect(onDisk.groq).toEqual({ type: "api_key", key: "desktop-groq-key" });

    const instanceC = createFusionAuthStorage();
    expect(await instanceC.getApiKey("openai")).toBe("web-openai-key");
    expect(await instanceC.getApiKey("openrouter")).toBe("web-openrouter-key");
    expect(await instanceC.getApiKey("groq")).toBe("desktop-groq-key");
  });

  it("survives instance B's logout(\"anthropic\") for unrelated providers", async () => {
    const instanceA = createFusionAuthStorage();
    await instanceA.set("openai", { type: "api_key", key: "web-openai-key" });
    await instanceA.set("openrouter", { type: "api_key", key: "web-openrouter-key" });

    const instanceB = createFusionAuthStorage();
    await instanceA.set("groq", { type: "api_key", key: "web-groq-key" });

    // B logs out of a provider it never touched via A — this exercises the remove()
    // proxy trap's persistProviderChange path.
    await instanceB.logout("anthropic");

    const onDisk = readAuthFile(homeDir);
    expect(onDisk.openai).toEqual({ type: "api_key", key: "web-openai-key" });
    expect(onDisk.openrouter).toEqual({ type: "api_key", key: "web-openrouter-key" });
    expect(onDisk.groq).toEqual({ type: "api_key", key: "web-groq-key" });
    expect(onDisk.anthropic).toBeUndefined();

    const instanceC = createFusionAuthStorage();
    expect(await instanceC.getApiKey("openai")).toBe("web-openai-key");
    expect(await instanceC.getApiKey("openrouter")).toBe("web-openrouter-key");
    expect(await instanceC.getApiKey("groq")).toBe("web-groq-key");
  });

  it("survives instance B's remove() call for an unrelated provider (empty-file baseline)", async () => {
    // Start from an explicit empty auth.json (empty-file data-state surface).
    mkdirSync(join(homeDir, ".fusion", "agent"), { recursive: true });
    writeFileSync(getFusionAuthPath(homeDir), "{}");

    const instanceA = createFusionAuthStorage();
    await instanceA.set("openai", { type: "api_key", key: "web-openai-key" });

    const instanceB = createFusionAuthStorage();
    await instanceA.set("mistral", { type: "api_key", key: "web-mistral-key" });

    await instanceB.set("anthropic-subscription", {
      type: "oauth",
      access: "desktop-access",
      refresh: "desktop-refresh",
      expires: Date.now() + 3_600_000,
    });
    await instanceB.remove("anthropic-subscription");

    const onDisk = readAuthFile(homeDir);
    expect(onDisk.openai).toEqual({ type: "api_key", key: "web-openai-key" });
    expect(onDisk.mistral).toEqual({ type: "api_key", key: "web-mistral-key" });
    expect(onDisk["anthropic-subscription"]).toBeUndefined();
  });

  it("survives a supplemental-sync-triggered write from instance B", async () => {
    // Supplemental credential source (.pi legacy auth.json, OAuth) that
    // syncSupplementalOauthCredentials() hydrates into the primary store on
    // construction/reload — only OAuth candidates are auto-hydrated
    // (shouldHydrateStoredCredential requires candidate.type === "oauth"; a
    // supplemental api_key is read as a fallback but is never written to primary).
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "legacy-codex-access",
          refresh: "legacy-codex-refresh",
          expires: Date.now() + 3_600_000,
        },
      }),
    );

    const instanceA = createFusionAuthStorage();
    await instanceA.set("openai", { type: "api_key", key: "web-openai-key" });

    // B constructs after A's write; construction runs syncSupplementalOauthCredentials(),
    // which itself calls primary.set() for the hydrated legacy OAuth provider — this is
    // the "supplemental sync" write path that must not clobber A's provider.
    const instanceB = createFusionAuthStorage();
    void instanceB;

    const onDisk = readAuthFile(homeDir);
    expect(onDisk.openai).toEqual({ type: "api_key", key: "web-openai-key" });
    expect((onDisk["openai-codex"] as { type?: string } | undefined)?.type).toBe("oauth");
  });

  it("[same-provider] instance B's older in-flight OAuth refresh does not overwrite instance A's newer login for the same provider", async () => {
    const now = Date.now();

    // A logs in to Anthropic OAuth with a credential that is already due for refresh
    // (past the 5-minute proactive-refresh buffer).
    const instanceA = createFusionAuthStorage();
    await instanceA.set("anthropic", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: now + 1_000, // within the refresh buffer window
    });

    // B constructs and snapshots the OLD credential in memory.
    const instanceB = createFusionAuthStorage();

    // The user re-logs in via A with a fresh, long-lived credential AFTER B snapshotted.
    await instanceA.set("anthropic", {
      type: "oauth",
      access: "new-access-from-relogin",
      refresh: "new-refresh-from-relogin",
      expires: now + 3_600_000,
    });

    // B's in-flight refresh (still keyed off its stale "old-*" snapshot) resolves.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "refreshed-from-stale-old-token",
        refresh_token: "refreshed-from-stale-old-refresh",
        expires_in: 3600,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const refreshedKey = await instanceB.getApiKey("anthropic");

    // B must not have flushed a refresh derived from the stale credential over A's
    // newer login. Either B returns A's newer key directly, or (at minimum) the
    // newer credential must still be what's on disk afterward.
    const onDisk = readAuthFile(homeDir);
    const persisted = onDisk.anthropic as { access?: string };
    expect(persisted.access).toBe("new-access-from-relogin");
    expect(refreshedKey).not.toBe("refreshed-from-stale-old-token");

    const instanceC = createFusionAuthStorage();
    expect(await instanceC.getApiKey("anthropic")).not.toBe("refreshed-from-stale-old-token");
  });

  it("single-flights a rotating Anthropic refresh token across auth storage instances", async () => {
    const now = Date.now();
    const instanceA = createFusionAuthStorage();
    await instanceA.set("anthropic-subscription", {
      type: "oauth",
      access: "expiring-access",
      refresh: "single-use-refresh",
      expires: now + 1_000,
    });

    // Each agent session constructs its own auth storage instance. Anthropic refresh
    // tokens rotate, so concurrent refresh requests using the same token cannot both
    // succeed: the second request observes an already-consumed refresh token.
    const instanceB = createFusionAuthStorage();
    let refreshConsumed = false;
    const fetchMock = vi.fn(async () => {
      if (refreshConsumed) {
        return {
          ok: false,
          text: async () => JSON.stringify({ error: "invalid_grant" }),
        };
      }
      refreshConsumed = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: "rotated-access",
          refresh_token: "next-single-use-refresh",
          expires_in: 3600,
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const [keyA, keyB] = await Promise.all([
      instanceA.getApiKey("anthropic"),
      instanceB.getApiKey("anthropic"),
    ]);

    expect(keyA).toBe("rotated-access");
    expect(keyB).toBe("rotated-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readAuthFile(homeDir)["anthropic-subscription"]).toMatchObject({
      type: "oauth",
      access: "rotated-access",
      refresh: "next-single-use-refresh",
    });
  });

  it("single-flights one rotating token across legacy and subscription Anthropic aliases", async () => {
    const instanceA = createFusionAuthStorage();
    await instanceA.set("anthropic", {
      type: "oauth",
      access: "legacy-expiring-access",
      refresh: "shared-alias-refresh",
      expires: Date.now() + 1_000,
    });
    const instanceB = createFusionAuthStorage();

    let refreshConsumed = false;
    const fetchMock = vi.fn(async () => {
      if (refreshConsumed) {
        return { ok: false, text: async () => JSON.stringify({ error: "invalid_grant" }) };
      }
      refreshConsumed = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: "alias-rotated-access",
          refresh_token: "next-alias-refresh",
          expires_in: 3600,
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(Promise.all([
      instanceA.getApiKey("anthropic"),
      instanceB.getApiKey("anthropic-subscription"),
    ])).resolves.toEqual(["alias-rotated-access", "alias-rotated-access"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
