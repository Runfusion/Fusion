import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GlobalSettingsStore, defaultGlobalDir } from "../global-settings.js";
import { DEFAULT_GLOBAL_SETTINGS } from "../types.js";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-global-settings-test-"));
}

/** Temporarily clear VITEST to test default GlobalSettingsStore resolution. */
async function withDefaultGlobalSettingsStore<T>(
  fn: (store: GlobalSettingsStore) => Promise<T>,
): Promise<T> {
  const savedVitest = process.env.VITEST;
  delete process.env.VITEST;

  try {
    const store = new GlobalSettingsStore();
    return await fn(store);
  } finally {
    if (savedVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = savedVitest;
    }
  }
}

describe("GlobalSettingsStore", () => {
  let dir: string;
  let store: GlobalSettingsStore;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new GlobalSettingsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  describe("init()", () => {
    it("creates the directory and settings.json if missing", async () => {
      const nested = join(dir, "nested", "deep");
      const nestedStore = new GlobalSettingsStore(nested);

      const created = await nestedStore.init();

      expect(created).toBe(true);
      expect(existsSync(join(nested, "settings.json"))).toBe(true);
    });

    it("creates settings.json with defaults on first init", async () => {
      await store.init();

      const raw = await readFile(join(dir, "settings.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.themeMode).toBe("dark");
      expect(parsed.colorTheme).toBe("default");
      expect(parsed.ntfyEnabled).toBe(false);
    });

    it("returns false if settings.json already exists", async () => {
      await store.init(); // creates file
      const created = await store.init(); // second call
      expect(created).toBe(false);
    });

    it("preserves existing settings on re-init", async () => {
      await store.init();
      await store.updateSettings({ themeMode: "light" });

      const created = await store.init();
      expect(created).toBe(false);

      const settings = await store.getSettings();
      expect(settings.themeMode).toBe("light");
    });

    it("adopts the legacy ~/.pi/kb directory when ~/.fusion does not exist", async () => {
      const homeDir = makeTmpDir();
      process.env.HOME = homeDir;

      const legacyDir = join(homeDir, ".pi", "kb");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "settings.json"),
        JSON.stringify({ themeMode: "light" }),
      );

      try {
        await withDefaultGlobalSettingsStore(async (defaultStore) => {
          await defaultStore.init();

          expect(defaultStore.getSettingsPath()).toBe(join(defaultGlobalDir(), "settings.json"));
          expect(existsSync(join(homeDir, ".fusion", "settings.json"))).toBe(true);
          expect(existsSync(join(homeDir, ".pi", "kb"))).toBe(false);

          const settings = await defaultStore.getSettings();
          expect(settings.themeMode).toBe("light");
        });
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    });

    it("adopts the legacy ~/.pi/fusion directory when ~/.fusion does not exist", async () => {
      const homeDir = makeTmpDir();
      process.env.HOME = homeDir;

      // Create the legacy ~/.pi/fusion directory with settings
      const legacyDir = join(homeDir, ".pi", "fusion");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "settings.json"),
        JSON.stringify({ themeMode: "light" }),
      );

      // Verify legacy exists and new does not
      expect(existsSync(join(homeDir, ".pi", "fusion", "settings.json"))).toBe(true);
      expect(existsSync(join(homeDir, ".fusion"))).toBe(false);

      try {
        await withDefaultGlobalSettingsStore(async (defaultStore) => {
          await defaultStore.init();

          // Verify migration happened
          expect(defaultStore.getSettingsPath()).toBe(join(defaultGlobalDir(), "settings.json"));
          expect(existsSync(join(homeDir, ".fusion", "settings.json"))).toBe(true);
          expect(existsSync(join(homeDir, ".pi", "fusion"))).toBe(false);

          // Verify settings were preserved
          const settings = await defaultStore.getSettings();
          expect(settings.themeMode).toBe("light");
        });
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe("getSettings()", () => {
    it("returns defaults when file does not exist", async () => {
      const settings = await store.getSettings();

      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });

    it("returns persisted values merged with defaults", async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ themeMode: "light", colorTheme: "ocean" }),
      );

      const settings = await store.getSettings();

      expect(settings.themeMode).toBe("light");
      expect(settings.colorTheme).toBe("ocean");
      // Defaults are filled in for missing fields
      expect(settings.ntfyEnabled).toBe(false);
      expect(settings.ntfyBaseUrl).toBeUndefined();
      expect(settings.defaultProvider).toBeUndefined();
    });

    it("returns defaults on invalid JSON", async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "settings.json"), "not-json{{{");

      const settings = await store.getSettings();

      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });

    it("returns defaults when directory does not exist", async () => {
      const nonExistent = new GlobalSettingsStore(join(dir, "nope", "nada"));
      const settings = await nonExistent.getSettings();

      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });
  });

  describe("updateSettings()", () => {
    it("persists a partial update and returns merged settings", async () => {
      await store.init();

      const updated = await store.updateSettings({ themeMode: "system" });

      expect(updated.themeMode).toBe("system");
      expect(updated.colorTheme).toBe("default"); // unchanged default

      // Verify persistence
      const raw = await readFile(join(dir, "settings.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.themeMode).toBe("system");
    });

    it("merges multiple updates without losing fields", async () => {
      await store.init();

      await store.updateSettings({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" });
      await store.updateSettings({ ntfyEnabled: true, ntfyTopic: "my-topic" });

      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
      expect(settings.ntfyEnabled).toBe(true);
      expect(settings.ntfyTopic).toBe("my-topic");
      expect(settings.themeMode).toBe("dark"); // preserved default
    });

    it("creates directory if missing", async () => {
      const nested = join(dir, "auto", "create");
      const nestedStore = new GlobalSettingsStore(nested);

      await nestedStore.updateSettings({ themeMode: "light" });

      expect(existsSync(join(nested, "settings.json"))).toBe(true);
      const settings = await nestedStore.getSettings();
      expect(settings.themeMode).toBe("light");
    });

    it("can clear a field by setting it to null (null-as-delete semantics)", async () => {
      await store.init();
      await store.updateSettings({ defaultProvider: "anthropic" });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ defaultProvider: null });

      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBeUndefined();
    });

    it("clearing ntfyTopic with null removes it from disk and returns undefined", async () => {
      await store.init();
      await store.updateSettings({ ntfyEnabled: true, ntfyTopic: "my-topic" });

      // Verify it was persisted
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.ntfyTopic).toBe("my-topic");

      // Clear the topic with null
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ ntfyTopic: null });

      // Verify it was removed from disk
      const rawAfter = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(rawAfter.ntfyTopic).toBeUndefined();

      // Verify getSettings returns undefined
      const settings = await store.getSettings();
      expect(settings.ntfyTopic).toBeUndefined();
    });

    it("clearing ntfyDashboardHost with null removes it from disk", async () => {
      await store.init();
      await store.updateSettings({ ntfyDashboardHost: "https://dashboard.example.com" });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ ntfyDashboardHost: null });

      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.ntfyDashboardHost).toBeUndefined();

      const settings = await store.getSettings();
      expect(settings.ntfyDashboardHost).toBeUndefined();
    });

    it("clearing ntfyBaseUrl with null removes it from disk and falls back to default behavior", async () => {
      await store.init();
      await store.updateSettings({ ntfyBaseUrl: "https://ntfy.internal.example" });

      const rawBefore = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(rawBefore.ntfyBaseUrl).toBe("https://ntfy.internal.example");

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ ntfyBaseUrl: null });

      const rawAfter = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(rawAfter.ntfyBaseUrl).toBeUndefined();

      const settings = await store.getSettings();
      expect(settings.ntfyBaseUrl).toBeUndefined();
    });

    it("persists custom ntfy event lists including planning-awaiting-input", async () => {
      await store.init();

      await store.updateSettings({ ntfyEvents: ["planning-awaiting-input", "failed"] });

      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.ntfyEvents).toEqual(["planning-awaiting-input", "failed"]);

      const settings = await store.getSettings();
      expect(settings.ntfyEvents).toEqual(["planning-awaiting-input", "failed"]);
    });

    it("clearing ntfyEvents with null resets to default on read", async () => {
      await store.init();
      await store.updateSettings({ ntfyEvents: ["in-review", "failed"] });

      // Verify it was persisted with custom value
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.ntfyEvents).toEqual(["in-review", "failed"]);

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ ntfyEvents: null });

      // After clear, reading back gives the default value
      // (either undefined on disk with default applied, or default written directly)
      const settings = await store.getSettings();
      expect(settings.ntfyEvents).toEqual(["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review", "planning-awaiting-input", "gridlock"]);
    });

    it("handles concurrent updates safely via locking", async () => {
      await store.init();

      // Fire 10 concurrent updates
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.updateSettings({ ntfyTopic: `topic-${i}` }),
      );
      await Promise.all(promises);

      // The final value should be one of the submitted values (last writer wins)
      const settings = await store.getSettings();
      expect(settings.ntfyTopic).toMatch(/^topic-\d$/);
    });
  });

  describe("schema protection", () => {
    it("preserves unknown keys during updateSettings", async () => {
      await store.init();

      // Simulate a setting that existed in an older schema version
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      raw.legacyCustomField = "preserve-me";
      raw.anotherRemovedSetting = 42;
      await writeFile(join(dir, "settings.json"), JSON.stringify(raw, null, 2));

      // Update a known field — unknown keys must survive the write cycle
      await store.updateSettings({ ntfyEnabled: true });

      const ondisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(ondisk.legacyCustomField).toBe("preserve-me");
      expect(ondisk.anotherRemovedSetting).toBe(42);
      expect(ondisk.ntfyEnabled).toBe(true);
    });

    it("readRaw returns all keys including unknown ones", async () => {
      await store.init();

      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      raw.futureField = "hello";
      await writeFile(join(dir, "settings.json"), JSON.stringify(raw, null, 2));

      const result = await store.readRaw();
      expect(result.futureField).toBe("hello");
      expect(result.themeMode).toBe("dark");
    });

    it("readRaw returns empty object for missing file", async () => {
      const emptyStore = new GlobalSettingsStore(join(dir, "nonexistent"));
      const result = await emptyStore.readRaw();
      expect(result).toEqual({});
    });

    it("preserves unknown keys across multiple save cycles", async () => {
      await store.init();

      // Inject an unknown key
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      raw.removedFeatureHost = "http://example.com";
      await writeFile(join(dir, "settings.json"), JSON.stringify(raw, null, 2));

      // Multiple save cycles with different known fields
      await store.updateSettings({ ntfyEnabled: true });
      await store.updateSettings({ ntfyTopic: "test-topic" });
      await store.updateSettings({ themeMode: "light" });

      const ondisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(ondisk.removedFeatureHost).toBe("http://example.com");
      expect(ondisk.ntfyEnabled).toBe(true);
      expect(ondisk.ntfyTopic).toBe("test-topic");
      expect(ondisk.themeMode).toBe("light");
    });
  });

  describe("getSettingsPath()", () => {
    it("returns the path to settings.json", () => {
      const path = store.getSettingsPath();
      expect(path).toBe(join(dir, "settings.json"));
    });
  });

  describe("atomic writes", () => {
    it("does not leave tmp files after a successful write", async () => {
      await store.init();
      await store.updateSettings({ themeMode: "light" });

      const tmpPath = join(dir, "settings.json.tmp");
      expect(existsSync(tmpPath)).toBe(false);
    });
  });

  describe("in-memory cache", () => {
    it("returns cached result on second getSettings() call without reading disk", async () => {
      await store.init();
      await writeFile(join(dir, "settings.json"), JSON.stringify({ themeMode: "light" }));

      // First call reads from disk
      const first = await store.getSettings();
      expect(first.themeMode).toBe("light");

      // Modify the file externally
      await writeFile(join(dir, "settings.json"), JSON.stringify({ themeMode: "dark" }));

      // Second call should return cached result (light), not the new disk value (dark)
      const second = await store.getSettings();
      expect(second.themeMode).toBe("light");
    });

    it("updateSettings() updates the cache", async () => {
      await store.init();

      // First call populates cache
      const first = await store.getSettings();
      expect(first.themeMode).toBe("dark");

      // Update settings
      await store.updateSettings({ themeMode: "light" });

      // getSettings should return updated cached value
      const second = await store.getSettings();
      expect(second.themeMode).toBe("light");
    });

    it("invalidateCache() forces re-read from disk", async () => {
      await store.init();
      await writeFile(join(dir, "settings.json"), JSON.stringify({ themeMode: "light" }));

      // First call reads from disk
      const first = await store.getSettings();
      expect(first.themeMode).toBe("light");

      // Modify the file externally
      await writeFile(join(dir, "settings.json"), JSON.stringify({ themeMode: "system" }));

      // Without invalidation, should return cached value
      const cached = await store.getSettings();
      expect(cached.themeMode).toBe("light");

      // After invalidation, should re-read from disk
      store.invalidateCache();
      const afterInvalidate = await store.getSettings();
      expect(afterInvalidate.themeMode).toBe("system");
    });
  });

  // ── Global Lane Model Settings (FN-1710) ──────────────────────────

  describe("global lane model settings", () => {
    it("all *Global* lane fields default to undefined", async () => {
      const settings = await store.getSettings();
      expect(settings.executionGlobalProvider).toBeUndefined();
      expect(settings.executionGlobalModelId).toBeUndefined();
      expect(settings.planningGlobalProvider).toBeUndefined();
      expect(settings.planningGlobalModelId).toBeUndefined();
      expect(settings.validatorGlobalProvider).toBeUndefined();
      expect(settings.validatorGlobalModelId).toBeUndefined();
      expect(settings.titleSummarizerGlobalProvider).toBeUndefined();
      expect(settings.titleSummarizerGlobalModelId).toBeUndefined();
    });

    it("persists executionGlobalProvider/executionGlobalModelId", async () => {
      await store.updateSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
      });

      const settings = await store.getSettings();
      expect(settings.executionGlobalProvider).toBe("anthropic");
      expect(settings.executionGlobalModelId).toBe("claude-sonnet-4-5");

      // Verify persistence
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.executionGlobalProvider).toBe("anthropic");
      expect(raw.executionGlobalModelId).toBe("claude-sonnet-4-5");
    });

    it("persists planningGlobalProvider/planningGlobalModelId", async () => {
      await store.updateSettings({
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
      });

      const settings = await store.getSettings();
      expect(settings.planningGlobalProvider).toBe("google");
      expect(settings.planningGlobalModelId).toBe("gemini-2.5-pro");
    });

    it("persists validatorGlobalProvider/validatorGlobalModelId", async () => {
      await store.updateSettings({
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4o",
      });

      const settings = await store.getSettings();
      expect(settings.validatorGlobalProvider).toBe("openai");
      expect(settings.validatorGlobalModelId).toBe("gpt-4o");
    });

    it("persists titleSummarizerGlobalProvider/titleSummarizerGlobalModelId", async () => {
      await store.updateSettings({
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      const settings = await store.getSettings();
      expect(settings.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(settings.titleSummarizerGlobalModelId).toBe("claude-haiku");
    });

    it("persists all global lane fields together", async () => {
      await store.updateSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-opus-4",
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4-turbo",
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-sonnet-4-5",
      });

      const settings = await store.getSettings();
      expect(settings.executionGlobalProvider).toBe("anthropic");
      expect(settings.executionGlobalModelId).toBe("claude-opus-4");
      expect(settings.planningGlobalProvider).toBe("google");
      expect(settings.planningGlobalModelId).toBe("gemini-2.5-pro");
      expect(settings.validatorGlobalProvider).toBe("openai");
      expect(settings.validatorGlobalModelId).toBe("gpt-4-turbo");
      expect(settings.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(settings.titleSummarizerGlobalModelId).toBe("claude-sonnet-4-5");
    });

    it("can clear global lane fields with null", async () => {
      await store.updateSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
      });

      // Clear them
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ executionGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ executionGlobalModelId: null });

      const settings = await store.getSettings();
      expect(settings.executionGlobalProvider).toBeUndefined();
      expect(settings.executionGlobalModelId).toBeUndefined();
    });

    it("merges global lane fields without losing other fields", async () => {
      await store.updateSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
      });

      await store.updateSettings({
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
      });

      const settings = await store.getSettings();
      // Both should be present
      expect(settings.executionGlobalProvider).toBe("anthropic");
      expect(settings.executionGlobalModelId).toBe("claude-sonnet-4-5");
      expect(settings.planningGlobalProvider).toBe("google");
      expect(settings.planningGlobalModelId).toBe("gemini-2.5-pro");
    });
  });

  // ── Model Baseline/Fallback Round-Trip Regression (FN-1729) ──────────────

  describe("model baseline/fallback round-trip regression (FN-1729)", () => {
    it("defaultProvider/defaultModelId round-trips with defaults + persisted values", async () => {
      // Persist default baseline
      await store.updateSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      let settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");

      // Verify persistence
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.defaultProvider).toBe("anthropic");
      expect(raw.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("fallbackProvider/fallbackModelId round-trips with defaults + persisted values", async () => {
      await store.updateSettings({
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
      });

      let settings = await store.getSettings();
      expect(settings.fallbackProvider).toBe("openai");
      expect(settings.fallbackModelId).toBe("gpt-4o");

      // Verify persistence
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.fallbackProvider).toBe("openai");
      expect(raw.fallbackModelId).toBe("gpt-4o");
    });

    it("all global model lanes round-trip correctly", async () => {
      await store.updateSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
        executionGlobalProvider: "google",
        executionGlobalModelId: "gemini-2.5-pro",
        planningGlobalProvider: "anthropic",
        planningGlobalModelId: "claude-opus-4",
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4-turbo",
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      // Verify all values
      let settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
      expect(settings.fallbackProvider).toBe("openai");
      expect(settings.fallbackModelId).toBe("gpt-4o");
      expect(settings.executionGlobalProvider).toBe("google");
      expect(settings.executionGlobalModelId).toBe("gemini-2.5-pro");
      expect(settings.planningGlobalProvider).toBe("anthropic");
      expect(settings.planningGlobalModelId).toBe("claude-opus-4");
      expect(settings.validatorGlobalProvider).toBe("openai");
      expect(settings.validatorGlobalModelId).toBe("gpt-4-turbo");
      expect(settings.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(settings.titleSummarizerGlobalModelId).toBe("claude-haiku");

      // Verify persistence
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.defaultProvider).toBe("anthropic");
      expect(raw.defaultModelId).toBe("claude-sonnet-4-5");
      expect(raw.fallbackProvider).toBe("openai");
      expect(raw.fallbackModelId).toBe("gpt-4o");
      expect(raw.executionGlobalProvider).toBe("google");
      expect(raw.executionGlobalModelId).toBe("gemini-2.5-pro");
      expect(raw.planningGlobalProvider).toBe("anthropic");
      expect(raw.planningGlobalModelId).toBe("claude-opus-4");
      expect(raw.validatorGlobalProvider).toBe("openai");
      expect(raw.validatorGlobalModelId).toBe("gpt-4-turbo");
      expect(raw.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(raw.titleSummarizerGlobalModelId).toBe("claude-haiku");

      // Clear and verify empty
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ defaultProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ defaultModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ fallbackProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ fallbackModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ executionGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ executionGlobalModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ planningGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ planningGlobalModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ validatorGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ validatorGlobalModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ titleSummarizerGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await store.updateSettings({ titleSummarizerGlobalModelId: null });

      settings = await store.getSettings();
      expect(settings.defaultProvider).toBeUndefined();
      expect(settings.defaultModelId).toBeUndefined();
      expect(settings.fallbackProvider).toBeUndefined();
      expect(settings.fallbackModelId).toBeUndefined();
      expect(settings.executionGlobalProvider).toBeUndefined();
      expect(settings.executionGlobalModelId).toBeUndefined();
      expect(settings.planningGlobalProvider).toBeUndefined();
      expect(settings.planningGlobalModelId).toBeUndefined();
      expect(settings.validatorGlobalProvider).toBeUndefined();
      expect(settings.validatorGlobalModelId).toBeUndefined();
      expect(settings.titleSummarizerGlobalProvider).toBeUndefined();
      expect(settings.titleSummarizerGlobalModelId).toBeUndefined();

      // Verify cleared from persistence
      const rawAfter = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(rawAfter.defaultProvider).toBeUndefined();
      expect(rawAfter.defaultModelId).toBeUndefined();
      expect(rawAfter.fallbackProvider).toBeUndefined();
      expect(rawAfter.fallbackModelId).toBeUndefined();
      expect(rawAfter.executionGlobalProvider).toBeUndefined();
      expect(rawAfter.executionGlobalModelId).toBeUndefined();
      expect(rawAfter.planningGlobalProvider).toBeUndefined();
      expect(rawAfter.planningGlobalModelId).toBeUndefined();
      expect(rawAfter.validatorGlobalProvider).toBeUndefined();
      expect(rawAfter.validatorGlobalModelId).toBeUndefined();
      expect(rawAfter.titleSummarizerGlobalProvider).toBeUndefined();
      expect(rawAfter.titleSummarizerGlobalModelId).toBeUndefined();
    });

    it("model baseline/fallback defaults do not persist until explicitly set", async () => {
      // Initialize the store to create settings file with defaults
      await store.init();

      // Don't set any model settings
      const settings = await store.getSettings();

      // All should be undefined (not default values)
      expect(settings.defaultProvider).toBeUndefined();
      expect(settings.defaultModelId).toBeUndefined();
      expect(settings.fallbackProvider).toBeUndefined();
      expect(settings.fallbackModelId).toBeUndefined();

      // Settings file should exist with defaults but no model fields persisted
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      // Only default theme fields should be present
      expect(raw.themeMode).toBe("dark");
      expect(raw.colorTheme).toBe("default");
      // Model fields should not be persisted
      expect(raw.defaultProvider).toBeUndefined();
      expect(raw.defaultModelId).toBeUndefined();
      expect(raw.fallbackProvider).toBeUndefined();
      expect(raw.fallbackModelId).toBeUndefined();
    });

    it("partial provider without modelId is valid and persists correctly", async () => {
      // Set provider without modelId
      await store.updateSettings({
        defaultProvider: "anthropic",
        // defaultModelId intentionally omitted
      });

      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBeUndefined();

      // Verify partial pair persisted
      const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
      expect(raw.defaultProvider).toBe("anthropic");
      expect(raw.defaultModelId).toBeUndefined();
    });
  });
});
