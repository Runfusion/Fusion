/*
FNXC:ProviderAuth 2026-07-24-17:05:
Regression tests for the operator-selectable Anthropic credential precedence.

Reported symptom class: an operator holding BOTH a raw Anthropic API key and a Claude
subscription OAuth login always ran on the raw key, because runtime resolution put it first
unconditionally. When that saved key was stale or revoked, every lane that calls the Anthropic
endpoint directly failed with `401 invalid x-api-key` while the subscription card still showed
"Active" — and nothing in the product explained which credential was in use.

Invariant: `anthropicAuthPreference` decides which credential wins WHEN BOTH EXIST, and
never removes a source — with only one credential configured, resolution reaches it under
either setting. Default stays "api-key" so upgrades do not silently move traffic.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth/auth-storage.js";

const RAW_API_KEY = "sk-ant-api03-raw-key-from-settings-card";
const SUBSCRIPTION_ACCESS_TOKEN = "sk-ant-oat01-subscription-access-token";

function writeAuth(homeDir: string, credentials: Record<string, unknown>): void {
  mkdirSync(join(homeDir, ".fusion", "agent"), { recursive: true });
  writeFileSync(getFusionAuthPath(homeDir), JSON.stringify(credentials));
}

function writeGlobalSettings(homeDir: string, settings: Record<string, unknown>): void {
  mkdirSync(join(homeDir, ".fusion"), { recursive: true });
  writeFileSync(join(homeDir, ".fusion", "settings.json"), JSON.stringify(settings));
}

/** A subscription OAuth credential that is still valid, so no refresh is attempted. */
function liveSubscriptionCredential() {
  return {
    type: "oauth",
    access: SUBSCRIPTION_ACCESS_TOKEN,
    refresh: "sk-ant-ort01-refresh-token",
    expires: Date.now() + 60 * 60_000,
  };
}

describe("Anthropic credential precedence (anthropicAuthPreference)", () => {
  const originalHome = process.env.HOME;
  const originalApiKeyEnv = process.env.ANTHROPIC_API_KEY;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-anthropic-pref-"));
    process.env.HOME = homeDir;
    // The env key is a separate fallback source; keep it out of these assertions.
    delete process.env.ANTHROPIC_API_KEY;
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
    if (originalApiKeyEnv === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKeyEnv;
    }
  });

  it("defaults to the raw API key when both credentials exist and no preference is stored", async () => {
    writeAuth(homeDir, {
      anthropic: { type: "api_key", key: RAW_API_KEY },
      "anthropic-subscription": liveSubscriptionCredential(),
    });

    const storage = createFusionAuthStorage();

    // Historical precedence (FN-7391/FN-7396) — upgrading must not move traffic.
    await expect(storage.getApiKey("anthropic")).resolves.toBe(RAW_API_KEY);
  });

  it("keeps the raw API key first when the preference is explicitly api-key", async () => {
    writeAuth(homeDir, {
      anthropic: { type: "api_key", key: RAW_API_KEY },
      "anthropic-subscription": liveSubscriptionCredential(),
    });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "api-key" });

    const storage = createFusionAuthStorage();

    await expect(storage.getApiKey("anthropic")).resolves.toBe(RAW_API_KEY);
  });

  it("resolves the subscription token over a stale saved key when the operator prefers subscription", async () => {
    writeAuth(homeDir, {
      anthropic: { type: "api_key", key: RAW_API_KEY },
      "anthropic-subscription": liveSubscriptionCredential(),
    });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "subscription" });

    const storage = createFusionAuthStorage();

    /*
    The exact reported failure: with the raw key winning, this returned a key that pi-ai
    sends as `x-api-key` (it lacks the `sk-ant-oat` marker) and Anthropic rejects with
    `401 invalid x-api-key`. The OAuth token routes as a Bearer credential instead.
    */
    await expect(storage.getApiKey("anthropic")).resolves.toBe(SUBSCRIPTION_ACCESS_TOKEN);
  });

  it("still falls back to the raw key under the subscription preference when no OAuth credential exists", async () => {
    writeAuth(homeDir, { anthropic: { type: "api_key", key: RAW_API_KEY } });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "subscription" });

    const storage = createFusionAuthStorage();

    // The preference disambiguates; it must never remove the only credential present.
    await expect(storage.getApiKey("anthropic")).resolves.toBe(RAW_API_KEY);
  });

  it("resolves the subscription token under the api-key preference when no raw key exists", async () => {
    writeAuth(homeDir, { "anthropic-subscription": liveSubscriptionCredential() });
    writeGlobalSettings(homeDir, { anthropicAuthPreference: "api-key" });

    const storage = createFusionAuthStorage();

    await expect(storage.getApiKey("anthropic")).resolves.toBe(SUBSCRIPTION_ACCESS_TOKEN);
  });

  it("honors the preference stored in a legacy global settings dir", async () => {
    writeAuth(homeDir, {
      anthropic: { type: "api_key", key: RAW_API_KEY },
      "anthropic-subscription": liveSubscriptionCredential(),
    });
    /*
    Operators who never migrated off the pre-rename global dir keep settings.json under
    ~/.pi/fusion. Reading only ~/.fusion would silently ignore their choice and fall back to
    raw-key precedence — the exact silent fallback this preference exists to remove.
    */
    mkdirSync(join(homeDir, ".pi", "fusion"), { recursive: true });
    writeFileSync(
      join(homeDir, ".pi", "fusion", "settings.json"),
      JSON.stringify({ anthropicAuthPreference: "subscription" }),
    );

    const storage = createFusionAuthStorage();

    await expect(storage.getApiKey("anthropic")).resolves.toBe(SUBSCRIPTION_ACCESS_TOKEN);
  });

  it("falls back to the historical precedence when the settings file is unreadable", async () => {
    writeAuth(homeDir, {
      anthropic: { type: "api_key", key: RAW_API_KEY },
      "anthropic-subscription": liveSubscriptionCredential(),
    });
    mkdirSync(join(homeDir, ".fusion"), { recursive: true });
    writeFileSync(join(homeDir, ".fusion", "settings.json"), "{ this is not json");

    const storage = createFusionAuthStorage();

    // A corrupt settings file must not strand credential resolution.
    await expect(storage.getApiKey("anthropic")).resolves.toBe(RAW_API_KEY);
  });
});
