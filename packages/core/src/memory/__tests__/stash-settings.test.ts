/**
 * FNXC:RUFU121StashSettingsInCore 2026-08-18-19:53:
 * RUFU-121 Step 3: resolveStashMemorySettings() at its new CORE location —
 * behavior pinned to the RUFU-068 contract (fail-closed, never throws, row-UUID
 * secret resolution). The engine re-exports this function and its suite
 * (executor-memory-capture.test.ts) covers it through the re-export; these
 * cases prove the moved implementation directly at the new module path.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveStashMemorySettings,
  STASH_SECRET_KEY,
  STASH_SECRET_SCOPE,
} from "../stash-settings.js";

const stashSettings = () => ({
  memoryEnabled: true,
  memoryBackendType: "stash",
  stashUrl: "http://127.0.0.1:9999",
});

describe("resolveStashMemorySettings (core, RUFU-121)", () => {
  it("leaves settings untouched when memory is disabled", async () => {
    const getSecretsStore = vi.fn();
    const settings = { memoryEnabled: false, memoryBackendType: "stash" as const };
    await expect(resolveStashMemorySettings({ getSecretsStore }, settings)).resolves.toBe(settings);
    expect(getSecretsStore).not.toHaveBeenCalled();
  });

  it("leaves settings untouched for non-stash backends", async () => {
    const getSecretsStore = vi.fn();
    const settings = { memoryEnabled: true, memoryBackendType: "qmd" };
    await expect(resolveStashMemorySettings({ getSecretsStore }, settings)).resolves.toBe(settings);
    expect(getSecretsStore).not.toHaveBeenCalled();
  });

  it("keeps an explicit settings.stashApiKey override without reading secrets", async () => {
    const getSecretsStore = vi.fn();
    const settings = { ...stashSettings(), stashApiKey: "explicit-key" };
    await expect(resolveStashMemorySettings({ getSecretsStore }, settings)).resolves.toBe(settings);
    expect(getSecretsStore).not.toHaveBeenCalled();
  });

  it("resolves the secret by row UUID via listSecrets for a stash backend", async () => {
    const inner = {
      listSecrets: vi.fn(async (scope?: string) => [
        { id: "row-uuid-1", key: STASH_SECRET_KEY },
        { id: "row-uuid-2", key: "other" },
      ]),
      revealSecret: vi.fn(async (id: string, scope: string) => ({ plaintextValue: "resolved-key" })),
    };
    const store = { getSecretsStore: vi.fn(async () => inner) };
    const resolved = await resolveStashMemorySettings(store, stashSettings());
    expect(resolved?.stashApiKey).toBe("resolved-key");
    expect(store.getSecretsStore).toHaveBeenCalledTimes(1);
    expect(inner.listSecrets).toHaveBeenCalledWith(STASH_SECRET_SCOPE);
    expect(inner.revealSecret).toHaveBeenCalledWith(
      "row-uuid-1",
      STASH_SECRET_SCOPE,
      { agentId: "executor" },
    );
  });

  it("degrades to the original settings (empty key, no throw) when reveal fails", async () => {
    const settings = stashSettings();
    const store = {
      getSecretsStore: vi.fn(async () => ({
        revealSecret: vi.fn(async () => {
          throw new Error("Secret not found");
        }),
      })),
    };
    const resolved = await resolveStashMemorySettings(store, settings);
    expect(resolved).toBe(settings); // no stashApiKey added
  });

  it("degrades to the original settings when the store has no secrets store", async () => {
    const settings = stashSettings();
    const resolved = await resolveStashMemorySettings({}, settings);
    expect(resolved).toBe(settings);
  });
});
