import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth/auth-storage.js";

const LEGACY_TOKEN = "legacy-shadow-access-token";
const SELECTED_TOKEN = "selected-instance-access-token";

function writeAuth(homeDir: string, credentials: Record<string, unknown>): void {
  mkdirSync(join(homeDir, ".fusion", "agent"), { recursive: true });
  writeFileSync(getFusionAuthPath(homeDir), JSON.stringify(credentials));
}

function writeGlobalSettings(homeDir: string, settings: Record<string, unknown>): void {
  mkdirSync(join(homeDir, ".fusion"), { recursive: true });
  writeFileSync(join(homeDir, ".fusion", "settings.json"), JSON.stringify(settings));
}

function oauth(access: string, expires = Date.now() + 60 * 60_000) {
  return { type: "oauth", access, refresh: `${access}-refresh`, expires };
}

describe("Anthropic legacy OAuth precedence", () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-anthropic-legacy-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    globalThis.fetch = originalFetch;
  });

  it.each([undefined, "api-key", "subscription"])("uses the selected subscription instance instead of a legacy OAuth shadow row with %s preference", async (preference) => {
    writeAuth(homeDir, {
      anthropic: oauth(LEGACY_TOKEN),
      "anthropic-subscription[work]": oauth(SELECTED_TOKEN),
      __fusionDefaultInstances: { "anthropic-subscription": "work" },
    });
    if (preference) writeGlobalSettings(homeDir, { anthropicAuthPreference: preference });

    const storage = createFusionAuthStorage();

    await expect(storage.getApiKey("anthropic")).resolves.toBe(SELECTED_TOKEN);
    await expect(storage.getApiKey("anthropic-subscription")).resolves.toBe(SELECTED_TOKEN);
  });

  it("uses the default subscription pointer even when the legacy credential expires later", async () => {
    writeAuth(homeDir, {
      anthropic: oauth(LEGACY_TOKEN, Date.now() + 24 * 60 * 60_000),
      "anthropic-subscription[work]": oauth(SELECTED_TOKEN),
      "anthropic-subscription[personal]": oauth("personal-instance-access-token"),
      __fusionDefaultInstances: { "anthropic-subscription": "work" },
    });
    const storage = createFusionAuthStorage();

    await expect(storage.getApiKey("anthropic")).resolves.toBe(SELECTED_TOKEN);
    await storage.setDefaultInstance({ providerId: "anthropic-subscription", instanceId: "personal" });
    await expect(storage.getApiKey("anthropic")).resolves.toBe("personal-instance-access-token");
    await expect(storage.getApiKey("anthropic", { providerId: "anthropic", instanceId: "default" })).resolves.toBe(LEGACY_TOKEN);
  });

  it("keeps raw-key preference ordering while never using a legacy OAuth row with a subscription", async () => {
    writeAuth(homeDir, {
      anthropic: { type: "api_key", key: "raw-api-key" },
      "anthropic-subscription": oauth(SELECTED_TOKEN),
    });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "api-key" });
    await expect(createFusionAuthStorage().getApiKey("anthropic")).resolves.toBe("raw-api-key");

    writeGlobalSettings(homeDir, { anthropicAuthPreference: "subscription" });
    await expect(createFusionAuthStorage().getApiKey("anthropic")).resolves.toBe(SELECTED_TOKEN);
  });

  it.each(["api-key", "subscription"])("keeps the legacy OAuth fallback when no subscription is stored with %s preference", async (preference) => {
    writeAuth(homeDir, { anthropic: oauth(LEGACY_TOKEN) });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: preference });
    await expect(createFusionAuthStorage().getApiKey("anthropic")).resolves.toBe(LEGACY_TOKEN);
  });

  it("does not use the legacy OAuth token when a stored subscription is unusable", async () => {
    writeAuth(homeDir, {
      anthropic: oauth(LEGACY_TOKEN),
      "anthropic-subscription": { type: "oauth", access: "expired-subscription", expires: Date.now() - 1 },
    });
    const storage = createFusionAuthStorage();

    await expect(storage.getApiKey("anthropic")).resolves.toBeUndefined();
    await storage.set("anthropic", { type: "api_key", key: "raw-api-key" });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "subscription" });
    await expect(createFusionAuthStorage().getApiKey("anthropic")).resolves.toBe("raw-api-key");
  });

  it("refreshes the selected subscription instance without replacing it with a fresher legacy row", async () => {
    writeAuth(homeDir, {
      anthropic: oauth(LEGACY_TOKEN, Date.now() + 24 * 60 * 60_000),
      "anthropic-subscription[work]": oauth("expired-selected-token", Date.now() - 60_000),
      __fusionDefaultInstances: { "anthropic-subscription": "work" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        access_token: "refreshed-selected-token",
        refresh_token: "rotated-selected-refresh",
        expires_in: 3600,
      }),
    } as Response);
    globalThis.fetch = fetchMock as typeof fetch;

    const storage = createFusionAuthStorage();
    await expect(storage.getApiKey("anthropic")).resolves.toBe("refreshed-selected-token");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      refresh_token: "expired-selected-token-refresh",
    });
    const persisted = JSON.parse(readFileSync(getFusionAuthPath(homeDir), "utf8"));
    expect(persisted.anthropic.access).toBe(LEGACY_TOKEN);
    expect(persisted["anthropic-subscription[work]"]).toMatchObject({
      access: "refreshed-selected-token",
      refresh: "rotated-selected-refresh",
    });
  });

  it("falls through after a failed subscription refresh instead of returning the legacy token", async () => {
    writeAuth(homeDir, {
      anthropic: oauth(LEGACY_TOKEN),
      "anthropic-subscription": oauth("expired-subscription", Date.now() - 60_000),
    });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "subscription" });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, text: async () => "denied" }) as typeof fetch;

    await expect(createFusionAuthStorage().getApiKey("anthropic")).resolves.toBeUndefined();
  });
});
