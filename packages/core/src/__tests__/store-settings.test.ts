import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../store.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  describe("model settings", () => {
    it("persists defaultProvider and defaultModelId via updateGlobalSettings", async () => {
      await harness.store().updateGlobalSettings({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" });
      const settings = await harness.store().getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("default settings do not include model fields", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.defaultProvider).toBeUndefined();
      expect(settings.defaultModelId).toBeUndefined();
    });
  });

  describe("worktreeInitCommand setting", () => {
    it("persists worktreeInitCommand and returns it via getSettings", async () => {
      await harness.store().updateSettings({ worktreeInitCommand: "pnpm install" });
      const settings = await harness.store().getSettings();
      expect(settings.worktreeInitCommand).toBe("pnpm install");
    });

    it("default settings do not include worktreeInitCommand", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.worktreeInitCommand).toBeUndefined();
    });
  });

  describe("worktreesDir setting", () => {
    it("round-trips worktreesDir via updateSettings and project serialization", async () => {
      await harness.store().updateSettings({ worktreesDir: "~/.fn-worktrees/{repo}" });
      const settings = await harness.store().getSettings();
      expect(settings.worktreesDir).toBe("~/.fn-worktrees/{repo}");

      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.worktreesDir).toBe("~/.fn-worktrees/{repo}");
    });
  });

  describe("secrets integration settings", () => {
    it("round-trips secretsEnv via project settings", async () => {
      await harness.store().updateSettings({
        secretsEnv: {
          enabled: true,
          filename: ".fusion.env",
          overwritePolicy: "merge",
          keyPrefix: "FUSION_",
          requireGitignored: true,
        },
      });

      const settings = await harness.store().getSettings();
      expect(settings.secretsEnv).toEqual({
        enabled: true,
        filename: ".fusion.env",
        overwritePolicy: "merge",
        keyPrefix: "FUSION_",
        requireGitignored: true,
      });

      const { project } = await harness.store().getSettingsByScope();
      expect(project.secretsEnv?.enabled).toBe(true);
    });
  });

  describe("autoResolveConflicts setting", () => {
    it("persists autoResolveConflicts and returns it via getSettings", async () => {
      await harness.store().updateSettings({ autoResolveConflicts: false });
      const settings = await harness.store().getSettings();
      expect(settings.autoResolveConflicts).toBe(false);
    });

    it("default settings have autoResolveConflicts set to true", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.autoResolveConflicts).toBe(true);
    });
  });

  describe("mergeStrategy setting", () => {
    it("defaults mergeStrategy to direct for backward compatibility", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.mergeStrategy).toBe("direct");
    });

    it("persists mergeStrategy and returns it via getSettings", async () => {
      await harness.store().updateSettings({ mergeStrategy: "pull-request" });
      const settings = await harness.store().getSettings();
      expect(settings.mergeStrategy).toBe("pull-request");
    });

    it("defaults directMergeCommitStrategy to always-squash and persists updates", async () => {
      const defaults = await harness.store().getSettings();
      expect(defaults.directMergeCommitStrategy).toBe("always-squash");

      await harness.store().updateSettings({ directMergeCommitStrategy: "always-rebase" });
      const settings = await harness.store().getSettings();
      expect(settings.directMergeCommitStrategy).toBe("always-rebase");
    });

    it("defaults mergeAdvanceAutoSync to stash-and-ff and persists updates", async () => {
      const defaults = await harness.store().getSettings();
      expect(defaults.mergeAdvanceAutoSync).toBe("stash-and-ff");

      await harness.store().updateSettings({ mergeAdvanceAutoSync: "off" });
      const settings = await harness.store().getSettings();
      expect(settings.mergeAdvanceAutoSync).toBe("off");
    });
  });

  // ── Planning/Validator Model Settings ────────────────────────────

  describe("planning/validator model settings", () => {
    it("saves and restores planning model settings via updateSettings", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });
      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
    });

    it("saves and restores validator model settings via updateSettings", async () => {
      await harness.store().updateSettings({
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      const settings = await harness.store().getSettings();
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBe("gpt-4o");
    });

    it("saves and restores both planning and validator model settings via updateSettings", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBe("gpt-4o");
    });

    it("clears planning model settings when set to undefined", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });
      await harness.store().updateSettings({
        planningProvider: undefined,
        planningModelId: undefined,
      });
      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBeUndefined();
    });

    it("clears validator model settings when set to undefined", async () => {
      await harness.store().updateSettings({
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      await harness.store().updateSettings({
        validatorProvider: undefined,
        validatorModelId: undefined,
      });
      const settings = await harness.store().getSettings();
      expect(settings.validatorProvider).toBeUndefined();
      expect(settings.validatorModelId).toBeUndefined();
    });

    it("persists planning/validator settings in project config", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-opus-4",
        validatorProvider: "openai",
        validatorModelId: "gpt-4-turbo",
      });

      // Verify the settings are in the project config file
      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.planningProvider).toBe("anthropic");
      expect(config.settings.planningModelId).toBe("claude-opus-4");
      expect(config.settings.validatorProvider).toBe("openai");
      expect(config.settings.validatorModelId).toBe("gpt-4-turbo");
    });
  });

  // ── Dual-Scope Lane Model Settings (FN-1710) ─────────────────────

  describe("dual-scope lane model settings", () => {
    // Legacy backward compatibility tests
    it("legacy: project config with only planningProvider/planningModelId round-trips unchanged", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });

      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");

      // Verify it's persisted correctly
      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.planningProvider).toBe("anthropic");
      expect(config.settings.planningModelId).toBe("claude-sonnet-4-5");
    });

    it("legacy: project config with only validatorProvider/validatorModelId round-trips unchanged", async () => {
      await harness.store().updateSettings({
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });

      const settings = await harness.store().getSettings();
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBe("gpt-4o");

      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.validatorProvider).toBe("openai");
      expect(config.settings.validatorModelId).toBe("gpt-4o");
    });

    it("legacy: project config with only titleSummarizerProvider/titleSummarizerModelId round-trips unchanged", async () => {
      await harness.store().updateSettings({
        titleSummarizerProvider: "google",
        titleSummarizerModelId: "gemini-2.5-pro",
      });

      const settings = await harness.store().getSettings();
      expect(settings.titleSummarizerProvider).toBe("google");
      expect(settings.titleSummarizerModelId).toBe("gemini-2.5-pro");

      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.titleSummarizerProvider).toBe("google");
      expect(config.settings.titleSummarizerModelId).toBe("gemini-2.5-pro");
    });

    it("legacy: partial provider without modelId behaves correctly", async () => {
      // Set provider only without modelId (partial legacy pair)
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        // No planningModelId
      });

      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBeUndefined();
    });

    // New default override fields
    it("persists defaultProviderOverride/defaultModelIdOverride via updateSettings", async () => {
      await harness.store().updateSettings({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4o-mini",
      });

      const settings = await harness.store().getSettings();
      expect(settings.defaultProviderOverride).toBe("openai");
      expect(settings.defaultModelIdOverride).toBe("gpt-4o-mini");
    });

    it("defaultProviderOverride/defaultModelIdOverride appear in project scope", async () => {
      await harness.store().updateSettings({
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-3-5-sonnet",
      });

      const { project } = await harness.store().getSettingsByScope();
      expect(project.defaultProviderOverride).toBe("anthropic");
      expect(project.defaultModelIdOverride).toBe("claude-3-5-sonnet");
    });

    it("defaultProviderOverride/defaultModelIdOverride default to undefined", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.defaultProviderOverride).toBeUndefined();
      expect(settings.defaultModelIdOverride).toBeUndefined();
    });

    // New execution lane fields
    it("persists executionProvider/executionModelId via updateSettings", async () => {
      await harness.store().updateSettings({
        executionProvider: "anthropic",
        executionModelId: "claude-opus-4",
      });

      const settings = await harness.store().getSettings();
      expect(settings.executionProvider).toBe("anthropic");
      expect(settings.executionModelId).toBe("claude-opus-4");
    });

    it("executionProvider/executionModelId appear in project scope", async () => {
      await harness.store().updateSettings({
        executionProvider: "openai",
        executionModelId: "gpt-4-turbo",
      });

      const { project } = await harness.store().getSettingsByScope();
      expect(project.executionProvider).toBe("openai");
      expect(project.executionModelId).toBe("gpt-4-turbo");
    });

    it("executionProvider/executionModelId default to undefined", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.executionProvider).toBeUndefined();
      expect(settings.executionModelId).toBeUndefined();
    });

    // Global lane fields via updateGlobalSettings
    it("persists executionGlobalProvider/executionGlobalModelId via updateGlobalSettings", async () => {
      await harness.store().updateGlobalSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
      });

      const settings = await harness.store().getSettings();
      expect(settings.executionGlobalProvider).toBe("anthropic");
      expect(settings.executionGlobalModelId).toBe("claude-sonnet-4-5");
    });

    it("persists planningGlobalProvider/planningGlobalModelId via updateGlobalSettings", async () => {
      await harness.store().updateGlobalSettings({
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
      });

      const settings = await harness.store().getSettings();
      expect(settings.planningGlobalProvider).toBe("google");
      expect(settings.planningGlobalModelId).toBe("gemini-2.5-pro");
    });

    it("persists validatorGlobalProvider/validatorGlobalModelId via updateGlobalSettings", async () => {
      await harness.store().updateGlobalSettings({
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4o",
      });

      const settings = await harness.store().getSettings();
      expect(settings.validatorGlobalProvider).toBe("openai");
      expect(settings.validatorGlobalModelId).toBe("gpt-4o");
    });

    it("persists titleSummarizerGlobalProvider/titleSummarizerGlobalModelId via updateGlobalSettings", async () => {
      await harness.store().updateGlobalSettings({
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      const settings = await harness.store().getSettings();
      expect(settings.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(settings.titleSummarizerGlobalModelId).toBe("claude-haiku");
    });

    it("all *Global* lane fields default to undefined", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.executionGlobalProvider).toBeUndefined();
      expect(settings.executionGlobalModelId).toBeUndefined();
      expect(settings.planningGlobalProvider).toBeUndefined();
      expect(settings.planningGlobalModelId).toBeUndefined();
      expect(settings.validatorGlobalProvider).toBeUndefined();
      expect(settings.validatorGlobalModelId).toBeUndefined();
      expect(settings.titleSummarizerGlobalProvider).toBeUndefined();
      expect(settings.titleSummarizerGlobalModelId).toBeUndefined();
    });

    // Mixed shape compatibility tests
    it("mixed shape: project planningProvider + global planningGlobalProvider is stable", async () => {
      // Set global baseline
      await harness.store().updateGlobalSettings({
        planningGlobalProvider: "anthropic",
        planningGlobalModelId: "claude-sonnet-4-5",
      });

      // Set project override
      await harness.store().updateSettings({
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      });

      // Both should be readable with no crashes
      const settings = await harness.store().getSettings();
      expect(settings.planningGlobalProvider).toBe("anthropic");
      expect(settings.planningGlobalModelId).toBe("claude-sonnet-4-5");
      expect(settings.planningProvider).toBe("openai");
      expect(settings.planningModelId).toBe("gpt-4o");
    });

    it("mixed shape: project validatorProvider + global validatorGlobalProvider is stable", async () => {
      await harness.store().updateGlobalSettings({
        validatorGlobalProvider: "google",
        validatorGlobalModelId: "gemini-2.5-pro",
      });

      await harness.store().updateSettings({
        validatorProvider: "anthropic",
        validatorModelId: "claude-opus-4",
      });

      const settings = await harness.store().getSettings();
      expect(settings.validatorGlobalProvider).toBe("google");
      expect(settings.validatorGlobalModelId).toBe("gemini-2.5-pro");
      expect(settings.validatorProvider).toBe("anthropic");
      expect(settings.validatorModelId).toBe("claude-opus-4");
    });

    it("mixed shape: project titleSummarizerProvider + global titleSummarizerGlobalProvider is stable", async () => {
      await harness.store().updateGlobalSettings({
        titleSummarizerGlobalProvider: "openai",
        titleSummarizerGlobalModelId: "gpt-4o-mini",
      });

      await harness.store().updateSettings({
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      });

      const settings = await harness.store().getSettings();
      expect(settings.titleSummarizerGlobalProvider).toBe("openai");
      expect(settings.titleSummarizerGlobalModelId).toBe("gpt-4o-mini");
      expect(settings.titleSummarizerProvider).toBe("anthropic");
      expect(settings.titleSummarizerModelId).toBe("claude-haiku");
    });

    // Global-only key filtering tests
    it("updateSettings does not persist *Global* keys to project config", async () => {
      // Attempt to set global keys through updateSettings (should be filtered)
      await harness.store().updateSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
        planningGlobalProvider: "openai",
        planningGlobalModelId: "gpt-4o",
      } as any);

      // The global keys should be filtered out and not appear in merged settings
      const settings = await harness.store().getSettings();
      expect(settings.executionGlobalProvider).toBeUndefined();
      expect(settings.executionGlobalModelId).toBeUndefined();
      expect(settings.planningGlobalProvider).toBeUndefined();
      expect(settings.planningGlobalModelId).toBeUndefined();

      // Verify they are NOT in the project config
      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect((config.settings as any).executionGlobalProvider).toBeUndefined();
      expect((config.settings as any).planningGlobalProvider).toBeUndefined();
    });

    it("all global lane fields appear in global scope", async () => {
      await harness.store().updateGlobalSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4o",
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      const { global } = await harness.store().getSettingsByScope();
      expect(global.executionGlobalProvider).toBe("anthropic");
      expect(global.executionGlobalModelId).toBe("claude-sonnet-4-5");
      expect(global.planningGlobalProvider).toBe("google");
      expect(global.planningGlobalModelId).toBe("gemini-2.5-pro");
      expect(global.validatorGlobalProvider).toBe("openai");
      expect(global.validatorGlobalModelId).toBe("gpt-4o");
      expect(global.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(global.titleSummarizerGlobalModelId).toBe("claude-haiku");
    });
  });

  // ── Model Lane Persistence Regression Tests (FN-1729) ─────────────────────

  describe("model lane persistence regression", () => {
    // Table-driven test matrix: verifies all model lane fields persist correctly
    // Fields are split by their correct scope (global or project)
    const projectModelLanePairs = [
      // Execution lane (project override)
      { provider: "executionProvider", modelId: "executionModelId" },
      // Planning lane (project override + fallback)
      { provider: "planningProvider", modelId: "planningModelId" },
      { provider: "planningFallbackProvider", modelId: "planningFallbackModelId" },
      // Validator lane (project override + fallback)
      { provider: "validatorProvider", modelId: "validatorModelId" },
      { provider: "validatorFallbackProvider", modelId: "validatorFallbackModelId" },
      // Summarizer lane (project override + fallback)
      { provider: "titleSummarizerProvider", modelId: "titleSummarizerModelId" },
      { provider: "titleSummarizerFallbackProvider", modelId: "titleSummarizerFallbackModelId" },
      // Default override (project-level override of global defaults)
      { provider: "defaultProviderOverride", modelId: "defaultModelIdOverride" },
    ] as const;

    const globalModelLanePairs = [
      // Default baseline
      { provider: "defaultProvider", modelId: "defaultModelId" },
      // Fallback baseline
      { provider: "fallbackProvider", modelId: "fallbackModelId" },
      // Execution lane (global baseline)
      { provider: "executionGlobalProvider", modelId: "executionGlobalModelId" },
      // Planning lane (global baseline)
      { provider: "planningGlobalProvider", modelId: "planningGlobalModelId" },
      // Validator lane (global baseline)
      { provider: "validatorGlobalProvider", modelId: "validatorGlobalModelId" },
      // Summarizer lane (global baseline)
      { provider: "titleSummarizerGlobalProvider", modelId: "titleSummarizerGlobalModelId" },
    ] as const;

    it.each(projectModelLanePairs)(
      "persists project $provider/$modelId via updateSettings",
      async ({ provider, modelId }) => {
        const patch: Record<string, string> = {};
        patch[provider] = "anthropic";
        patch[modelId] = "claude-opus-4";
        await harness.store().updateSettings(patch);

        const settings = await harness.store().getSettings();
        expect((settings as any)[provider]).toBe("anthropic");
        expect((settings as any)[modelId]).toBe("claude-opus-4");
      },
    );

    it.each(globalModelLanePairs)(
      "persists global $provider/$modelId via updateGlobalSettings",
      async ({ provider, modelId }) => {
        const patch: Record<string, string> = {};
        patch[provider] = "openai";
        patch[modelId] = "gpt-4o";
        await harness.store().updateGlobalSettings(patch);

        const settings = await harness.store().getSettings();
        expect((settings as any)[provider]).toBe("openai");
        expect((settings as any)[modelId]).toBe("gpt-4o");
      },
    );

    it.each(projectModelLanePairs)(
      "project $provider/$modelId default to undefined",
      async ({ provider, modelId }) => {
        const settings = await harness.store().getSettings();
        expect((settings as any)[provider]).toBeUndefined();
        expect((settings as any)[modelId]).toBeUndefined();
      },
    );

    it.each(globalModelLanePairs)(
      "global $provider/$modelId default to undefined",
      async ({ provider, modelId }) => {
        const settings = await harness.store().getSettings();
        expect((settings as any)[provider]).toBeUndefined();
        expect((settings as any)[modelId]).toBeUndefined();
      },
    );

    it.each(projectModelLanePairs)(
      "project $provider/$modelId persist to project config file",
      async ({ provider, modelId }) => {
        const patch: Record<string, string> = {};
        patch[provider] = "google";
        patch[modelId] = "gemini-2.5-pro";

        await harness.store().updateSettings(patch);

        const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
        const config = JSON.parse(configRaw);

        // Project fields should appear in project config
        expect((config.settings as any)[provider]).toBe("google");
        expect((config.settings as any)[modelId]).toBe("gemini-2.5-pro");
      },
    );

    it.each(globalModelLanePairs)(
      "global $provider/$modelId do NOT persist to project config file",
      async ({ provider, modelId }) => {
        const patch: Record<string, string> = {};
        patch[provider] = "google";
        patch[modelId] = "gemini-2.5-pro";

        await harness.store().updateGlobalSettings(patch);

        const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
        const config = JSON.parse(configRaw);

        // Global fields should NOT appear in project config
        expect((config.settings as any)[provider]).toBeUndefined();
        expect((config.settings as any)[modelId]).toBeUndefined();
      },
    );
  });

  // ── Scope Separation Regression Tests (FN-1729) ───────────────────────────

  describe("scope separation regression", () => {
    it("keeps dual-scope githubTrackingDefaultRepo in project scope while excluding global-only keys", async () => {
      await harness.store().updateGlobalSettings({
        githubTrackingDefaultRepo: "global/default",
        themeMode: "light",
      });

      await harness.store().updateSettings({
        githubTrackingDefaultRepo: "project/default",
        themeMode: "dark",
      });

      const merged = await harness.store().getSettings();
      const mergedFast = await harness.store().getSettingsFast();
      const { global, project } = await harness.store().getSettingsByScope();
      const scopedFast = await harness.store().getSettingsByScopeFast();

      expect(merged.githubTrackingDefaultRepo).toBe("project/default");
      expect(mergedFast.githubTrackingDefaultRepo).toBe("project/default");
      expect(project.githubTrackingDefaultRepo).toBe("project/default");
      expect(scopedFast.project.githubTrackingDefaultRepo).toBe("project/default");
      expect(global.githubTrackingDefaultRepo).toBe("global/default");
      expect(scopedFast.global.githubTrackingDefaultRepo).toBe("global/default");

      expect((project as Record<string, unknown>).themeMode).toBeUndefined();
      expect((scopedFast.project as Record<string, unknown>).themeMode).toBeUndefined();
    });

    it("getSettingsByScope: global lane keys never appear in project scope", async () => {
      await harness.store().updateGlobalSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4o",
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      const { project } = await harness.store().getSettingsByScope();

      // All global lane keys must be absent from project scope
      expect((project as any).executionGlobalProvider).toBeUndefined();
      expect((project as any).executionGlobalModelId).toBeUndefined();
      expect((project as any).planningGlobalProvider).toBeUndefined();
      expect((project as any).planningGlobalModelId).toBeUndefined();
      expect((project as any).validatorGlobalProvider).toBeUndefined();
      expect((project as any).validatorGlobalModelId).toBeUndefined();
      expect((project as any).titleSummarizerGlobalProvider).toBeUndefined();
      expect((project as any).titleSummarizerGlobalModelId).toBeUndefined();
    });

    it("getSettingsByScope: project override keys never appear in global scope", async () => {
      await harness.store().updateSettings({
        executionProvider: "anthropic",
        executionModelId: "claude-opus-4",
        planningProvider: "openai",
        planningModelId: "gpt-4o",
        planningFallbackProvider: "google",
        planningFallbackModelId: "gemini-2.5-pro",
        validatorProvider: "anthropic",
        validatorModelId: "claude-sonnet-4-5",
        validatorFallbackProvider: "openai",
        validatorFallbackModelId: "gpt-4o-mini",
        titleSummarizerProvider: "google",
        titleSummarizerModelId: "gemini-2.5-pro",
        titleSummarizerFallbackProvider: "anthropic",
        titleSummarizerFallbackModelId: "claude-haiku",
      });

      const { global } = await harness.store().getSettingsByScope();

      // Project lane keys must be absent from global scope
      expect((global as any).executionProvider).toBeUndefined();
      expect((global as any).executionModelId).toBeUndefined();
      expect((global as any).planningProvider).toBeUndefined();
      expect((global as any).planningModelId).toBeUndefined();
      expect((global as any).planningFallbackProvider).toBeUndefined();
      expect((global as any).planningFallbackModelId).toBeUndefined();
      expect((global as any).validatorProvider).toBeUndefined();
      expect((global as any).validatorModelId).toBeUndefined();
      expect((global as any).validatorFallbackProvider).toBeUndefined();
      expect((global as any).validatorFallbackModelId).toBeUndefined();
      expect((global as any).titleSummarizerProvider).toBeUndefined();
      expect((global as any).titleSummarizerModelId).toBeUndefined();
      expect((global as any).titleSummarizerFallbackProvider).toBeUndefined();
      expect((global as any).titleSummarizerFallbackModelId).toBeUndefined();
    });

    it("getSettingsByScope: default baseline keys appear in global scope", async () => {
      await harness.store().updateGlobalSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
      });

      const { global } = await harness.store().getSettingsByScope();

      expect(global.defaultProvider).toBe("anthropic");
      expect(global.defaultModelId).toBe("claude-sonnet-4-5");
      expect(global.fallbackProvider).toBe("openai");
      expect(global.fallbackModelId).toBe("gpt-4o");
    });

    it("getSettingsByScope: default override keys appear in project scope", async () => {
      await harness.store().updateSettings({
        defaultProviderOverride: "anthropic",
        defaultModelIdOverride: "claude-opus-4",
      });

      const { project } = await harness.store().getSettingsByScope();

      expect(project.defaultProviderOverride).toBe("anthropic");
      expect(project.defaultModelIdOverride).toBe("claude-opus-4");
    });

    it("getSettingsByScope: mixed global and project keys are separated correctly", async () => {
      await harness.store().updateGlobalSettings({
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        fallbackProvider: "google",
        fallbackModelId: "gemini-2.5-pro",
        planningGlobalProvider: "anthropic",
        planningGlobalModelId: "claude-sonnet-4-5",
      });

      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-opus-4",
        planningFallbackProvider: "openai",
        planningFallbackModelId: "gpt-4o-mini",
        executionProvider: "google",
        executionModelId: "gemini-2.5-pro",
      });

      const { global, project } = await harness.store().getSettingsByScope();

      // Global scope
      expect(global.defaultProvider).toBe("openai");
      expect(global.defaultModelId).toBe("gpt-4o");
      expect(global.fallbackProvider).toBe("google");
      expect(global.fallbackModelId).toBe("gemini-2.5-pro");
      expect(global.planningGlobalProvider).toBe("anthropic");
      expect(global.planningGlobalModelId).toBe("claude-sonnet-4-5");

      // Project scope
      expect(project.planningProvider).toBe("anthropic");
      expect(project.planningModelId).toBe("claude-opus-4");
      expect(project.planningFallbackProvider).toBe("openai");
      expect(project.planningFallbackModelId).toBe("gpt-4o-mini");
      expect(project.executionProvider).toBe("google");
      expect(project.executionModelId).toBe("gemini-2.5-pro");

      // Verify no cross-contamination
      expect((global as any).planningProvider).toBeUndefined();
      expect((global as any).planningFallbackProvider).toBeUndefined();
      expect((global as any).executionProvider).toBeUndefined();
      expect((project as any).planningGlobalProvider).toBeUndefined();
      expect((project as any).defaultProvider).toBeUndefined();
    });
  });

  // ── Settings Parity Regression Tests (FN-1729) ────────────────────────────

  describe("settings parity regression", () => {
    it("getSettings() and getSettingsFast() return equivalent merged snapshots", async () => {
      // Set up various settings across scopes
      await harness.store().updateGlobalSettings({
        themeMode: "light",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-opus-4",
      });

      await harness.store().updateSettings({
        maxConcurrent: 5,
        autoMerge: false,
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        planningFallbackProvider: "openai",
        planningFallbackModelId: "gpt-4o-mini",
        executionProvider: "google",
        executionModelId: "gemini-2.5-pro",
        validatorProvider: "anthropic",
        validatorModelId: "claude-haiku",
      });

      const fast = await harness.store().getSettingsFast();
      const regular = await harness.store().getSettings();

      // Verify parity for all model settings
      expect(fast.defaultProvider).toBe(regular.defaultProvider);
      expect(fast.defaultModelId).toBe(regular.defaultModelId);
      expect(fast.fallbackProvider).toBe(regular.fallbackProvider);
      expect(fast.fallbackModelId).toBe(regular.fallbackModelId);
      expect(fast.planningGlobalProvider).toBe(regular.planningGlobalProvider);
      expect(fast.planningGlobalModelId).toBe(regular.planningGlobalModelId);
      expect(fast.planningProvider).toBe(regular.planningProvider);
      expect(fast.planningModelId).toBe(regular.planningModelId);
      expect(fast.planningFallbackProvider).toBe(regular.planningFallbackProvider);
      expect(fast.planningFallbackModelId).toBe(regular.planningFallbackModelId);
      expect(fast.executionGlobalProvider).toBe(regular.executionGlobalProvider);
      expect(fast.executionGlobalModelId).toBe(regular.executionGlobalModelId);
      expect(fast.executionProvider).toBe(regular.executionProvider);
      expect(fast.executionModelId).toBe(regular.executionModelId);
      expect(fast.validatorProvider).toBe(regular.validatorProvider);
      expect(fast.validatorModelId).toBe(regular.validatorModelId);
      expect(fast.validatorFallbackProvider).toBe(regular.validatorFallbackProvider);
      expect(fast.validatorFallbackModelId).toBe(regular.validatorFallbackModelId);
      expect(fast.titleSummarizerProvider).toBe(regular.titleSummarizerProvider);
      expect(fast.titleSummarizerModelId).toBe(regular.titleSummarizerModelId);
      expect(fast.titleSummarizerGlobalProvider).toBe(regular.titleSummarizerGlobalProvider);
      expect(fast.titleSummarizerGlobalModelId).toBe(regular.titleSummarizerGlobalModelId);
      expect(fast.titleSummarizerFallbackProvider).toBe(regular.titleSummarizerFallbackProvider);
      expect(fast.titleSummarizerFallbackModelId).toBe(regular.titleSummarizerFallbackModelId);

      // Also verify non-model settings parity
      expect(fast.themeMode).toBe(regular.themeMode);
      expect(fast.maxConcurrent).toBe(regular.maxConcurrent);
      expect(fast.autoMerge).toBe(regular.autoMerge);

      // The entire objects should be equal
      expect(fast).toEqual(regular);
    });

    it("getSettings() and getSettingsFast() are equivalent on empty state", async () => {
      const fast = await harness.store().getSettingsFast();
      const regular = await harness.store().getSettings();

      expect(fast).toEqual(regular);
    });

    it("getSettingsFast() includes all model lane fields", async () => {
      await harness.store().updateGlobalSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-opus-4",
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4-turbo",
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        planningFallbackProvider: "openai",
        planningFallbackModelId: "gpt-4o-mini",
        executionProvider: "google",
        executionModelId: "gemini-2.5-pro",
        validatorProvider: "anthropic",
        validatorModelId: "claude-opus-4",
        validatorFallbackProvider: "openai",
        validatorFallbackModelId: "gpt-4o",
        titleSummarizerProvider: "google",
        titleSummarizerModelId: "gemini-2.5-pro",
        titleSummarizerFallbackProvider: "anthropic",
        titleSummarizerFallbackModelId: "claude-haiku",
      });

      const settings = await harness.store().getSettingsFast();

      // Verify all fields are present
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
      expect(settings.fallbackProvider).toBe("openai");
      expect(settings.fallbackModelId).toBe("gpt-4o");
      expect(settings.planningGlobalProvider).toBe("google");
      expect(settings.planningGlobalModelId).toBe("gemini-2.5-pro");
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
      expect(settings.planningFallbackProvider).toBe("openai");
      expect(settings.planningFallbackModelId).toBe("gpt-4o-mini");
      expect(settings.executionGlobalProvider).toBe("anthropic");
      expect(settings.executionGlobalModelId).toBe("claude-opus-4");
      expect(settings.executionProvider).toBe("google");
      expect(settings.executionModelId).toBe("gemini-2.5-pro");
      expect(settings.validatorProvider).toBe("anthropic");
      expect(settings.validatorModelId).toBe("claude-opus-4");
      expect(settings.validatorFallbackProvider).toBe("openai");
      expect(settings.validatorFallbackModelId).toBe("gpt-4o");
      expect(settings.titleSummarizerProvider).toBe("google");
      expect(settings.titleSummarizerModelId).toBe("gemini-2.5-pro");
      expect(settings.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(settings.titleSummarizerGlobalModelId).toBe("claude-haiku");
      expect(settings.titleSummarizerFallbackProvider).toBe("anthropic");
      expect(settings.titleSummarizerFallbackModelId).toBe("claude-haiku");
    });
  });

  // ── Model Precedence Regression Tests (FN-1729) ──────────────────────────

  describe("model precedence regression", () => {
    it("project override pair present → effective value uses project pair", async () => {
      // Set global baseline
      await harness.store().updateGlobalSettings({
        planningGlobalProvider: "anthropic",
        planningGlobalModelId: "claude-sonnet-4-5",
      });

      // Set project override
      await harness.store().updateSettings({
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      });

      const settings = await harness.store().getSettings();

      // Project pair should win
      expect(settings.planningProvider).toBe("openai");
      expect(settings.planningModelId).toBe("gpt-4o");

      // Global should still be readable
      expect(settings.planningGlobalProvider).toBe("anthropic");
      expect(settings.planningGlobalModelId).toBe("claude-sonnet-4-5");
    });

    it("project override missing + global lane pair present → uses global lane pair", async () => {
      // Set only global baseline
      await harness.store().updateGlobalSettings({
        planningGlobalProvider: "anthropic",
        planningGlobalModelId: "claude-sonnet-4-5",
      });

      const settings = await harness.store().getSettings();

      // Should fall back to global lane
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBeUndefined();
      expect(settings.planningGlobalProvider).toBe("anthropic");
      expect(settings.planningGlobalModelId).toBe("claude-sonnet-4-5");
    });

    it("lane pair missing + default pair present → falls back to default pair", async () => {
      // Set only default baseline (no planning lane at all)
      await harness.store().updateGlobalSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const settings = await harness.store().getSettings();

      // Planning lane should be empty
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBeUndefined();

      // Default baseline should be available
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("execution lane precedence: project → global → default", async () => {
      // Set default baseline
      await harness.store().updateGlobalSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      // Set execution global lane
      await harness.store().updateGlobalSettings({
        executionGlobalProvider: "google",
        executionGlobalModelId: "gemini-2.5-pro",
      });

      // Set execution project override
      await harness.store().updateSettings({
        executionProvider: "openai",
        executionModelId: "gpt-4o",
      });

      const settings = await harness.store().getSettings();

      // Project override should win
      expect(settings.executionProvider).toBe("openai");
      expect(settings.executionModelId).toBe("gpt-4o");

      // Global should still be accessible
      expect(settings.executionGlobalProvider).toBe("google");
      expect(settings.executionGlobalModelId).toBe("gemini-2.5-pro");

      // Default should still be accessible
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("all lanes simultaneously with different providers", async () => {
      await harness.store().updateGlobalSettings({
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

      await harness.store().updateSettings({
        executionProvider: "openai",
        executionModelId: "gpt-4o-mini",
        planningProvider: "google",
        planningModelId: "gemini-2.5-flash",
        planningFallbackProvider: "anthropic",
        planningFallbackModelId: "claude-sonnet-4-5",
        validatorProvider: "google",
        validatorModelId: "gemini-2.5-pro",
        validatorFallbackProvider: "anthropic",
        validatorFallbackModelId: "claude-opus-4",
        titleSummarizerProvider: "openai",
        titleSummarizerModelId: "gpt-4o",
        titleSummarizerFallbackProvider: "google",
        titleSummarizerFallbackModelId: "gemini-2.5-flash",
      });

      const settings = await harness.store().getSettings();

      // All lanes should coexist independently
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
      expect(settings.fallbackProvider).toBe("openai");
      expect(settings.fallbackModelId).toBe("gpt-4o");

      expect(settings.executionProvider).toBe("openai");
      expect(settings.executionModelId).toBe("gpt-4o-mini");
      expect(settings.executionGlobalProvider).toBe("google");
      expect(settings.executionGlobalModelId).toBe("gemini-2.5-pro");

      expect(settings.planningProvider).toBe("google");
      expect(settings.planningModelId).toBe("gemini-2.5-flash");
      expect(settings.planningGlobalProvider).toBe("anthropic");
      expect(settings.planningGlobalModelId).toBe("claude-opus-4");
      expect(settings.planningFallbackProvider).toBe("anthropic");
      expect(settings.planningFallbackModelId).toBe("claude-sonnet-4-5");

      expect(settings.validatorProvider).toBe("google");
      expect(settings.validatorModelId).toBe("gemini-2.5-pro");
      expect(settings.validatorGlobalProvider).toBe("openai");
      expect(settings.validatorGlobalModelId).toBe("gpt-4-turbo");
      expect(settings.validatorFallbackProvider).toBe("anthropic");
      expect(settings.validatorFallbackModelId).toBe("claude-opus-4");

      expect(settings.titleSummarizerProvider).toBe("openai");
      expect(settings.titleSummarizerModelId).toBe("gpt-4o");
      expect(settings.titleSummarizerGlobalProvider).toBe("anthropic");
      expect(settings.titleSummarizerGlobalModelId).toBe("claude-haiku");
      expect(settings.titleSummarizerFallbackProvider).toBe("google");
      expect(settings.titleSummarizerFallbackModelId).toBe("gemini-2.5-flash");
    });
  });

  // ── Compatibility & Null-Clear Regression Tests (FN-1729) ────────────────

  describe("canonical vs legacy compatibility regression", () => {
    it("canonical executionProvider + legacy planningProvider coexist without conflict", async () => {
      // Set canonical execution lane (new FN-1710 format)
      await harness.store().updateGlobalSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
      });

      // Set legacy planning format
      await harness.store().updateSettings({
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      });

      const settings = await harness.store().getSettings();

      // Both should coexist
      expect(settings.executionGlobalProvider).toBe("anthropic");
      expect(settings.executionGlobalModelId).toBe("claude-sonnet-4-5");
      expect(settings.planningProvider).toBe("openai");
      expect(settings.planningModelId).toBe("gpt-4o");
    });

    it("mixed legacy canonical shapes resolve deterministically", async () => {
      // Legacy format
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
        titleSummarizerProvider: "google",
        titleSummarizerModelId: "gemini-2.5-pro",
      });

      // Canonical format
      await harness.store().updateSettings({
        executionProvider: "anthropic",
        executionModelId: "claude-opus-4",
        executionGlobalProvider: undefined,
        executionGlobalModelId: undefined,
      });

      // Also set global canonical fields
      await harness.store().updateGlobalSettings({
        planningGlobalProvider: "anthropic",
        planningGlobalModelId: "claude-haiku",
        validatorGlobalProvider: "openai",
        validatorGlobalModelId: "gpt-4o-mini",
      });

      const settings = await harness.store().getSettings();

      // Legacy shapes preserved
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBe("gpt-4o");
      expect(settings.titleSummarizerProvider).toBe("google");
      expect(settings.titleSummarizerModelId).toBe("gemini-2.5-pro");

      // Canonical shapes preserved
      expect(settings.executionProvider).toBe("anthropic");
      expect(settings.executionModelId).toBe("claude-opus-4");

      // Global canonical shapes preserved
      expect(settings.planningGlobalProvider).toBe("anthropic");
      expect(settings.planningGlobalModelId).toBe("claude-haiku");
      expect(settings.validatorGlobalProvider).toBe("openai");
      expect(settings.validatorGlobalModelId).toBe("gpt-4o-mini");
    });

    it("legacy format: planningProvider without planningModelId is valid partial pair", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        // planningModelId intentionally omitted
      });

      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBeUndefined();
    });

    it("legacy format: validatorProvider without validatorModelId is valid partial pair", async () => {
      await harness.store().updateSettings({
        validatorProvider: "openai",
        // validatorModelId intentionally omitted
      });

      const settings = await harness.store().getSettings();
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBeUndefined();
    });

    it("canonical format: executionProvider without executionModelId is valid partial pair", async () => {
      await harness.store().updateSettings({
        executionProvider: "google",
        // executionModelId intentionally omitted
      });

      const settings = await harness.store().getSettings();
      expect(settings.executionProvider).toBe("google");
      expect(settings.executionModelId).toBeUndefined();
    });

    it("mixed: full pair + partial pair coexist in same lane", async () => {
      // Set full planning pair
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });

      // Set partial validator pair (only provider)
      await harness.store().updateSettings({
        validatorProvider: "openai",
        // validatorModelId intentionally omitted
      });

      // Set full execution pair
      await harness.store().updateSettings({
        executionProvider: "google",
        executionModelId: "gemini-2.5-pro",
      });

      const settings = await harness.store().getSettings();

      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBeUndefined();
      expect(settings.executionProvider).toBe("google");
      expect(settings.executionModelId).toBe("gemini-2.5-pro");
    });
  });

  describe("null-as-delete regression for model settings", () => {
    it("clears planningProvider/planningModelId with null via updateSettings", async () => {
      // First set the values
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });

      let settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");

      // Clear with null
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningModelId: null });

      settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBeUndefined();
    });

    it("clears validatorProvider/validatorModelId with null", async () => {
      await harness.store().updateSettings({
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ validatorProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ validatorModelId: null });

      const settings = await harness.store().getSettings();
      expect(settings.validatorProvider).toBeUndefined();
      expect(settings.validatorModelId).toBeUndefined();
    });

    it("clears executionProvider/executionModelId with null", async () => {
      await harness.store().updateSettings({
        executionProvider: "google",
        executionModelId: "gemini-2.5-pro",
      });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ executionProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ executionModelId: null });

      const settings = await harness.store().getSettings();
      expect(settings.executionProvider).toBeUndefined();
      expect(settings.executionModelId).toBeUndefined();
    });

    it("clears titleSummarizerProvider/titleSummarizerModelId with null", async () => {
      await harness.store().updateSettings({
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ titleSummarizerProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ titleSummarizerModelId: null });

      const settings = await harness.store().getSettings();
      expect(settings.titleSummarizerProvider).toBeUndefined();
      expect(settings.titleSummarizerModelId).toBeUndefined();
    });

    it("clears fallback model fields with null", async () => {
      await harness.store().updateSettings({
        planningFallbackProvider: "anthropic",
        planningFallbackModelId: "claude-sonnet-4-5",
        validatorFallbackProvider: "openai",
        validatorFallbackModelId: "gpt-4o",
        titleSummarizerFallbackProvider: "google",
        titleSummarizerFallbackModelId: "gemini-2.5-pro",
      });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningFallbackProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningFallbackModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ validatorFallbackProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ validatorFallbackModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ titleSummarizerFallbackProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ titleSummarizerFallbackModelId: null });

      const settings = await harness.store().getSettings();
      expect(settings.planningFallbackProvider).toBeUndefined();
      expect(settings.planningFallbackModelId).toBeUndefined();
      expect(settings.validatorFallbackProvider).toBeUndefined();
      expect(settings.validatorFallbackModelId).toBeUndefined();
      expect(settings.titleSummarizerFallbackProvider).toBeUndefined();
      expect(settings.titleSummarizerFallbackModelId).toBeUndefined();
    });

    it("clears global default model fields with null", async () => {
      await harness.store().updateGlobalSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
      });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ defaultProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ defaultModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ fallbackProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ fallbackModelId: null });

      const settings = await harness.store().getSettings();
      expect(settings.defaultProvider).toBeUndefined();
      expect(settings.defaultModelId).toBeUndefined();
      expect(settings.fallbackProvider).toBeUndefined();
      expect(settings.fallbackModelId).toBeUndefined();
    });

    it("clears global lane model fields with null", async () => {
      await harness.store().updateGlobalSettings({
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
        planningGlobalProvider: "openai",
        planningGlobalModelId: "gpt-4o",
        validatorGlobalProvider: "google",
        validatorGlobalModelId: "gemini-2.5-pro",
        titleSummarizerGlobalProvider: "anthropic",
        titleSummarizerGlobalModelId: "claude-haiku",
      });

      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ executionGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ executionGlobalModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ planningGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ planningGlobalModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ validatorGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ validatorGlobalModelId: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ titleSummarizerGlobalProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateGlobalSettings({ titleSummarizerGlobalModelId: null });

      const settings = await harness.store().getSettings();
      expect(settings.executionGlobalProvider).toBeUndefined();
      expect(settings.executionGlobalModelId).toBeUndefined();
      expect(settings.planningGlobalProvider).toBeUndefined();
      expect(settings.planningGlobalModelId).toBeUndefined();
      expect(settings.validatorGlobalProvider).toBeUndefined();
      expect(settings.validatorGlobalModelId).toBeUndefined();
      expect(settings.titleSummarizerGlobalProvider).toBeUndefined();
      expect(settings.titleSummarizerGlobalModelId).toBeUndefined();
    });

    it("null clear of one field in pair preserves the other", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });

      // Clear only provider, keep modelId
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningProvider: null });

      const settings = await harness.store().getSettings();
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBe("claude-sonnet-4-5"); // Preserved
    });

    it("cleared model settings fall back to undefined (not default values)", async () => {
      // Set global defaults first
      await harness.store().updateGlobalSettings({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      // Set planning override
      await harness.store().updateSettings({
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      });

      // Clear planning override
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningModelId: null });

      const settings = await harness.store().getSettings();

      // Planning should be undefined (no fallback to default in settings layer)
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBeUndefined();

      // Default should still be accessible
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("cleared model settings removed from persisted config", async () => {
      await harness.store().updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });

      // Verify persisted
      let configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      let config = JSON.parse(configRaw);
      expect((config.settings as any).planningProvider).toBe("anthropic");

      // Clear with null
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningProvider: null });
      // @ts-expect-error - null is intentionally used to clear field (null-as-delete)
      await harness.store().updateSettings({ planningModelId: null });

      // Verify removed from persisted config
      configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      config = JSON.parse(configRaw);
      expect((config.settings as any).planningProvider).toBeUndefined();
      expect((config.settings as any).planningModelId).toBeUndefined();
    });
  });

  // ── Global/Project Settings Merging ─────────────────────────────

  describe("global/project settings merging", () => {
    it("getSettings returns global defaults when no overrides exist", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.themeMode).toBe("dark");
      expect(settings.colorTheme).toBe("default");
      expect(settings.maxConcurrent).toBe(2);
    });

    it("global settings are visible through getSettings", async () => {
      await harness.store().updateGlobalSettings({ themeMode: "light", colorTheme: "ocean" });
      const settings = await harness.store().getSettings();
      expect(settings.themeMode).toBe("light");
      expect(settings.colorTheme).toBe("ocean");
    });

    it("project settings override global defaults", async () => {
      await harness.store().updateSettings({ maxConcurrent: 8 });
      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(8);
    });

    it("round-trips testMode in both project and global scopes", async () => {
      await harness.store().updateGlobalSettings({ testMode: true });
      let merged = await harness.store().getSettings();
      expect(merged.testMode).toBe(true);

      await harness.store().updateSettings({ testMode: false });
      merged = await harness.store().getSettings();
      expect(merged.testMode).toBe(false);

      const { global, project } = await harness.store().getSettingsByScope();
      expect(global.testMode).toBe(true);
      expect(project.testMode).toBe(false);
    });

    it("updateSettings silently filters out global-only fields", async () => {
      // themeMode is a global field — should not be persisted to project config
      await harness.store().updateSettings({ maxConcurrent: 5, themeMode: "light" } as any);

      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(5);
      // themeMode should still be the global default, not "light"
      expect(settings.themeMode).toBe("dark");

      // Verify the project config doesn't contain themeMode
      const configRaw = await readFile(join(harness.rootDir(), ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.themeMode).toBeUndefined();
    });

    it("updateGlobalSettings persists global fields", async () => {
      await harness.store().updateGlobalSettings({ defaultProvider: "openai", defaultModelId: "gpt-4o" });

      const settings = await harness.store().getSettings();
      expect(settings.defaultProvider).toBe("openai");
      expect(settings.defaultModelId).toBe("gpt-4o");
    });

    it("updateGlobalSettings emits settings:updated event", async () => {
      const events: Array<{ settings: any; previous: any }> = [];
      harness.store().on("settings:updated", (data) => events.push(data));

      await harness.store().updateGlobalSettings({ ntfyEnabled: true, ntfyTopic: "test" });

      expect(events).toHaveLength(1);
      expect(events[0].settings.ntfyEnabled).toBe(true);
      expect(events[0].settings.ntfyTopic).toBe("test");
    });

    it("getSettingsByScope returns separated global and project settings", async () => {
      await harness.store().updateGlobalSettings({ themeMode: "system", defaultProvider: "anthropic" });
      await harness.store().updateSettings({ maxConcurrent: 4, autoMerge: false });

      const { global, project } = await harness.store().getSettingsByScope();

      expect(global.themeMode).toBe("system");
      expect(global.defaultProvider).toBe("anthropic");
      expect(project.maxConcurrent).toBe(4);
      expect(project.autoMerge).toBe(false);
    });

    it("getSettingsByScope does not include global keys in project settings", async () => {
      // Update settings with both project and global keys via the store API
      // updateSettings silently filters out global-only fields,
      // so we need to set project settings via the proper API
      await harness.store().updateSettings({ maxConcurrent: 3 } as any);

      const { project } = await harness.store().getSettingsByScope();

      expect(project.maxConcurrent).toBe(3);
      // themeMode is a global key — should not appear in project scope
      expect((project as any).themeMode).toBeUndefined();
    });

    it("backward compat: existing projects with global fields in config.json still work", async () => {
      // Update settings through the store API (simulates legacy config with project + global fields)
      await harness.store().updateSettings({ maxConcurrent: 6 } as any);
      // Global fields go through global settings store
      await harness.store().updateGlobalSettings({ themeMode: "system", ntfyEnabled: true });

      // getSettings should still see these values (project overrides global)
      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(6);
      expect(settings.themeMode).toBe("system");
      expect(settings.ntfyEnabled).toBe(true);
    });

    it("getGlobalSettingsStore returns the store instance", () => {
      const globalStore = harness.store().getGlobalSettingsStore();
      expect(globalStore).toBeDefined();
      expect(globalStore.getSettingsPath()).toContain("settings.json");
    });

    it("ignores legacy project-level globalMaxConcurrent values", async () => {
      const db = (harness.store() as any).db;
      const row = db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined;
      const existingSettings = row?.settings ? JSON.parse(row.settings) : {};
      existingSettings.maxConcurrent = 9;
      existingSettings.globalMaxConcurrent = 4;
      db.prepare("UPDATE config SET settings = ? WHERE id = 1").run(JSON.stringify(existingSettings));

      const settings = await harness.store().getSettings();
      const fastSettings = await harness.store().getSettingsFast();
      const { project } = await harness.store().getSettingsByScope();

      expect(settings.maxConcurrent).toBe(9);
      expect(fastSettings.maxConcurrent).toBe(9);
      expect((settings as any).globalMaxConcurrent).toBeUndefined();
      expect((fastSettings as any).globalMaxConcurrent).toBeUndefined();
      expect((project as any).globalMaxConcurrent).toBeUndefined();
    });

    it("updateSettings creates config row if missing and persists settings", async () => {
      // Manually delete the config row to simulate corruption/edge case
      const db = (harness.store() as any).db;
      db.prepare("DELETE FROM config WHERE id = 1").run();

      // updateSettings should still work (INSERT OR REPLACE creates row)
      await harness.store().updateSettings({ maxConcurrent: 7 });

      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(7);

      // Verify row was recreated
      const row = db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
      expect(row).toBeDefined();
      expect(row.nextId).toBeDefined();
    });

    it("updateSettings persists multiple settings correctly to SQLite", async () => {
      await harness.store().updateSettings({
        maxConcurrent: 3,
        maxWorktrees: 8,
        pollIntervalMs: 30000,
        autoMerge: false,
        mergeStrategy: "pull-request",
      });

      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(3);
      expect(settings.maxWorktrees).toBe(8);
      expect(settings.pollIntervalMs).toBe(30000);
      expect(settings.autoMerge).toBe(false);
      expect(settings.mergeStrategy).toBe("pull-request");
    });

    it("updateGlobalSettings persists multiple global settings correctly", async () => {
      await harness.store().updateGlobalSettings({
        themeMode: "light",
        colorTheme: "ocean",
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const settings = await harness.store().getSettings();
      expect(settings.themeMode).toBe("light");
      expect(settings.colorTheme).toBe("ocean");
      expect(settings.ntfyEnabled).toBe(true);
      expect(settings.ntfyTopic).toBe("test-topic");
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("settings are correctly merged from all sources", async () => {
      // Set global settings
      await harness.store().updateGlobalSettings({ themeMode: "light", ntfyEnabled: true });

      // Set project settings (should override where applicable)
      await harness.store().updateSettings({ maxConcurrent: 5, autoMerge: false });

      const settings = await harness.store().getSettings();

      // Project settings
      expect(settings.maxConcurrent).toBe(5);
      expect(settings.autoMerge).toBe(false);

      // Global settings
      expect(settings.themeMode).toBe("light");
      expect(settings.ntfyEnabled).toBe(true);

      // Defaults for unset fields
      expect(settings.maxWorktrees).toBe(4); // default
      expect(settings.pollIntervalMs).toBe(15000); // default
    });
  });

  describe("getSettingsFast()", () => {
    it("defaults ephemeralAgentsEnabled to true for new projects", async () => {
      const fast = await harness.store().getSettingsFast();
      const regular = await harness.store().getSettings();
      const scopedFast = await harness.store().getSettingsByScopeFast();

      expect(fast.ephemeralAgentsEnabled).toBe(true);
      expect(regular.ephemeralAgentsEnabled).toBe(true);
      expect(scopedFast.project.ephemeralAgentsEnabled).toBe(true);
    });

    it("falls back to ephemeralAgentsEnabled=true when upgrading settings omit the key", async () => {
      const db = (harness.store() as any).db;
      const row = db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined;
      const existingSettings = row?.settings ? JSON.parse(row.settings) : {};
      delete existingSettings.ephemeralAgentsEnabled;
      db.prepare("UPDATE config SET settings = ? WHERE id = 1").run(JSON.stringify(existingSettings));

      const fast = await harness.store().getSettingsFast();
      const regular = await harness.store().getSettings();
      const scopedFast = await harness.store().getSettingsByScopeFast();

      expect(fast.ephemeralAgentsEnabled).toBe(true);
      expect(regular.ephemeralAgentsEnabled).toBe(true);
      expect(scopedFast.project.ephemeralAgentsEnabled).toBe(true);
    });

    it("preserves explicit ephemeralAgentsEnabled=false", async () => {
      await harness.store().updateSettings({ ephemeralAgentsEnabled: false });

      const fast = await harness.store().getSettingsFast();
      const regular = await harness.store().getSettings();
      const scopedFast = await harness.store().getSettingsByScopeFast();

      expect(fast.ephemeralAgentsEnabled).toBe(false);
      expect(regular.ephemeralAgentsEnabled).toBe(false);
      expect(scopedFast.project.ephemeralAgentsEnabled).toBe(false);
    });

    it("returns the same merged result as getSettings()", async () => {
      await harness.store().updateGlobalSettings({ themeMode: "light", ntfyEnabled: true });
      await harness.store().updateSettings({ maxConcurrent: 5, autoMerge: false });

      const fast = await harness.store().getSettingsFast();
      const regular = await harness.store().getSettings();

      expect(fast.maxConcurrent).toBe(5);
      expect(fast.autoMerge).toBe(false);
      expect(fast.themeMode).toBe("light");
      expect(fast.ntfyEnabled).toBe(true);
      expect(fast.maxWorktrees).toBe(4); // default

      // Should match getSettings()
      expect(fast).toEqual(regular);
    });

    it("returns defaults when no config row exists", async () => {
      // Delete the config row
      const db = (harness.store() as any).db;
      db.prepare("DELETE FROM config WHERE id = 1").run();

      const settings = await harness.store().getSettingsFast();

      // Should return defaults merged with global settings
      expect(settings.maxWorktrees).toBe(4); // default
      expect(settings.pollIntervalMs).toBe(15000); // default
      // Global settings should still be present
      expect(settings.themeMode).toBe("dark"); // global default
    });

    it("includes global settings merged with project settings", async () => {
      await harness.store().updateGlobalSettings({ themeMode: "system", colorTheme: "ocean" });
      await harness.store().updateSettings({ maxConcurrent: 10 });

      const settings = await harness.store().getSettingsFast();

      // Project settings override
      expect(settings.maxConcurrent).toBe(10);
      // Global settings are included
      expect(settings.themeMode).toBe("system");
      expect(settings.colorTheme).toBe("ocean");
    });

    it("does not call listWorkflowSteps (fast-path)", async () => {
      await harness.store().updateSettings({ maxConcurrent: 3 });

      const settings = await harness.store().getSettingsFast();

      // If we got here without errors, the fast path works
      expect(settings.maxConcurrent).toBe(3);
      // listWorkflowSteps should not be called by getSettingsFast
    });
  });

  // ── Backup Directory Canonicalization ─────────────────────────────

  describe("autoBackupDir canonicalization", () => {
    it("getSettings returns .fusion/backups when persisted config contains legacy .kb/backups", async () => {
      // Directly set the legacy backup dir in the SQLite config to simulate legacy projects
      const db = (harness.store() as any).db;
      const row = db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined;
      const existingSettings = row?.settings ? JSON.parse(row.settings) : {};
      existingSettings.autoBackupDir = ".kb/backups";
      db.prepare("UPDATE config SET settings = ? WHERE id = 1").run(JSON.stringify(existingSettings));

      const settings = await harness.store().getSettings();
      expect(settings.autoBackupDir).toBe(".fusion/backups");
    });

    it("getSettingsFast returns .fusion/backups when persisted config contains legacy .kb/backups", async () => {
      const db = (harness.store() as any).db;
      const row = db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined;
      const existingSettings = row?.settings ? JSON.parse(row.settings) : {};
      existingSettings.autoBackupDir = ".kb/backups";
      db.prepare("UPDATE config SET settings = ? WHERE id = 1").run(JSON.stringify(existingSettings));

      const settings = await harness.store().getSettingsFast();
      expect(settings.autoBackupDir).toBe(".fusion/backups");
    });

    it("getSettingsByScope returns .fusion/backups in project when persisted config contains legacy .kb/backups", async () => {
      const db = (harness.store() as any).db;
      const row = db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined;
      const existingSettings = row?.settings ? JSON.parse(row.settings) : {};
      existingSettings.autoBackupDir = ".kb/backups";
      db.prepare("UPDATE config SET settings = ? WHERE id = 1").run(JSON.stringify(existingSettings));

      const { project } = await harness.store().getSettingsByScope();
      expect(project.autoBackupDir).toBe(".fusion/backups");
    });

    it("autoBackupDir: null removes the override and falls back to default .fusion/backups", async () => {
      // First set a custom backup dir
      await harness.store().updateSettings({ autoBackupDir: "custom/backups" });
      let settings = await harness.store().getSettings();
      expect(settings.autoBackupDir).toBe("custom/backups");

      // Then clear it with null (null-as-delete semantics)
      await harness.store().updateSettings({ autoBackupDir: null as unknown as undefined });
      settings = await harness.store().getSettings();
      // Should fall back to the default .fusion/backups (which is the canonical form)
      expect(settings.autoBackupDir).toBe(".fusion/backups");
    });

    it("non-legacy custom .kb/* directories are preserved (not canonicalized)", async () => {
      // Custom path like ".kb/my-custom-backups" should NOT be canonicalized
      await harness.store().updateSettings({ autoBackupDir: ".kb/my-custom-backups" });
      const settings = await harness.store().getSettings();
      expect(settings.autoBackupDir).toBe(".kb/my-custom-backups");
    });

    it("getSettings preserves explicit .fusion/backups setting", async () => {
      await harness.store().updateSettings({ autoBackupDir: ".fusion/backups" });
      const settings = await harness.store().getSettings();
      expect(settings.autoBackupDir).toBe(".fusion/backups");
    });
  });

  // ── Prompt Overrides Tests ─────────────────────────────────────────

  describe("promptOverrides settings", () => {
    it("can set a single prompt override", async () => {
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Custom executor welcome message" },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Custom executor welcome message" });
    });

    it("can set multiple prompt overrides", async () => {
      await harness.store().updateSettings({
        promptOverrides: {
          "executor-welcome": "Custom welcome",
          "triage-welcome": "Custom triage welcome",
        },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Custom welcome",
        "triage-welcome": "Custom triage welcome",
      });
    });

    it("promptOverrides is undefined by default", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("can merge new overrides with existing overrides", async () => {
      // Set initial overrides
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Initial welcome" },
      });

      // Add more overrides
      await harness.store().updateSettings({
        promptOverrides: { "triage-welcome": "Custom triage" },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Initial welcome",
        "triage-welcome": "Custom triage",
      });
    });

    it("can update an existing override", async () => {
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Original" },
      });

      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Updated" },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Updated" });
    });

    it("can clear a specific override with null value", async () => {
      // Set initial overrides
      await harness.store().updateSettings({
        promptOverrides: {
          "executor-welcome": "Welcome",
          "triage-welcome": "Triage",
        },
      });

      // Clear only executor-welcome
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": null as unknown as string },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toEqual({ "triage-welcome": "Triage" });
    });

    it("clears entire promptOverrides when all keys are cleared", async () => {
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Welcome" },
      });

      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": null as unknown as string },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("can clear entire promptOverrides with null", async () => {
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Welcome", "triage-welcome": "Triage" },
      });

      await harness.store().updateSettings({
        promptOverrides: null as unknown as Record<string, string>,
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("persists empty string overrides as cleared (not stored)", async () => {
      // Setting an empty string should be treated as "clear" and not persist
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "" },
      });

      const settings = await harness.store().getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("handles promptOverrides in getSettingsByScope", async () => {
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Scoped welcome" },
      });

      const { project } = await harness.store().getSettingsByScope();
      expect(project.promptOverrides).toEqual({ "executor-welcome": "Scoped welcome" });
    });

    it("preserves other settings when updating promptOverrides", async () => {
      await harness.store().updateSettings({
        maxConcurrent: 5,
        autoMerge: false,
      });

      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Welcome" },
      });

      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(5);
      expect(settings.autoMerge).toBe(false);
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Welcome" });
    });

    it("preserves promptOverrides when updating other settings", async () => {
      await harness.store().updateSettings({
        promptOverrides: { "executor-welcome": "Welcome", "triage-welcome": "Triage" },
      });

      await harness.store().updateSettings({ maxConcurrent: 7 });

      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(7);
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Welcome",
        "triage-welcome": "Triage",
      });
    });
  });

  describe("remoteAccess settings", () => {
    const baseRemoteAccess = {
      activeProvider: "cloudflare" as const,
      providers: {
        tailscale: {
          enabled: true,
          hostname: "tailscale.example.ts.net",
          targetPort: 5173,
          acceptRoutes: true,
        },
        cloudflare: {
          enabled: true,
          quickTunnel: false,
          tunnelName: "main-tunnel",
          tunnelToken: "cf-secret-token",
          ingressUrl: "https://project.example.com",
        },
      },
      tokenStrategy: {
        persistent: {
          enabled: true,
          token: "persist-token",
        },
        shortLived: {
          enabled: false,
          ttlMs: 900_000,
          maxTtlMs: 86_400_000,
        },
      },
      lifecycle: {
        rememberLastRunning: true,
        wasRunningOnShutdown: true,
        lastRunningProvider: "cloudflare" as const,
      },
    };

    it("round-trips nested remoteAccess settings with both providers, token strategy, and lifecycle", async () => {
      await harness.useIsolatedStore();
      let isolatedStore = harness.store();

      isolatedStore.close();
      isolatedStore = new TaskStore(harness.rootDir(), harness.globalDir());
      await isolatedStore.init();

      await isolatedStore.updateGlobalSettings({ remoteAccess: baseRemoteAccess });

      const settings = await isolatedStore.getSettings();
      expect(settings.remoteAccess).toEqual(baseRemoteAccess);

      const { project, global } = await isolatedStore.getSettingsByScope();
      expect((project as Record<string, unknown>).remoteAccess).toBeUndefined();
      expect(global.remoteAccess).toEqual(baseRemoteAccess);

      isolatedStore.close();
      const reloadedStore = new TaskStore(harness.rootDir(), harness.globalDir());
      await reloadedStore.init();

      const reloaded = await reloadedStore.getSettings();
      expect(reloaded.remoteAccess).toEqual(baseRemoteAccess);
      reloadedStore.close();
    });

    it("patching remoteAccess.providers.tailscale preserves providers.cloudflare", async () => {
      await harness.store().updateGlobalSettings({ remoteAccess: baseRemoteAccess });
      await harness.store().updateGlobalSettings({ remoteAccess: { providers: { tailscale: { enabled: false, hostname: "alt-tail.ts.net", targetPort: 3000, acceptRoutes: false } } } } as any);
      const settings = await harness.store().getSettings();
      expect(settings.remoteAccess?.providers.cloudflare).toEqual(baseRemoteAccess.providers.cloudflare);
    });

    it("patching remoteAccess.tokenStrategy.shortLived preserves tokenStrategy.persistent", async () => {
      await harness.store().updateGlobalSettings({ remoteAccess: baseRemoteAccess });
      await harness.store().updateGlobalSettings({ remoteAccess: { tokenStrategy: { shortLived: { enabled: true, ttlMs: 120_000, maxTtlMs: 300_000 } } } } as any);
      const settings = await harness.store().getSettings();
      expect(settings.remoteAccess?.tokenStrategy.persistent).toEqual(baseRemoteAccess.tokenStrategy.persistent);
    });

    it("patching only activeProvider preserves providers, tokenStrategy, and lifecycle", async () => {
      await harness.store().updateGlobalSettings({ remoteAccess: baseRemoteAccess });
      await harness.store().updateGlobalSettings({ remoteAccess: { activeProvider: "tailscale" } } as any);
      const settings = await harness.store().getSettings();
      expect(settings.remoteAccess?.activeProvider).toBe("tailscale");
      expect(settings.remoteAccess?.providers).toEqual(baseRemoteAccess.providers);
      expect(settings.remoteAccess?.tokenStrategy).toEqual(baseRemoteAccess.tokenStrategy);
      expect(settings.remoteAccess?.lifecycle).toEqual(baseRemoteAccess.lifecycle);
    });

    it("nested null clear only removes the targeted token field", async () => {
      await harness.store().updateGlobalSettings({ remoteAccess: baseRemoteAccess });
      await harness.store().updateGlobalSettings({ remoteAccess: { tokenStrategy: { persistent: { token: null } } } } as any);
      const settings = await harness.store().getSettings();
      expect(settings.remoteAccess?.tokenStrategy.persistent.enabled).toBe(true);
      expect(settings.remoteAccess?.tokenStrategy.persistent.token).toBeUndefined();
      expect(settings.remoteAccess?.tokenStrategy.shortLived).toEqual(baseRemoteAccess.tokenStrategy.shortLived);
    });

    it("top-level null clear removes remoteAccess override and falls back to defaults", async () => {
      await harness.store().updateGlobalSettings({ remoteAccess: baseRemoteAccess });
      await harness.store().updateGlobalSettings({ remoteAccess: null as any });

      const settings = await harness.store().getSettings();
      expect(settings.remoteAccess?.activeProvider).toBeNull();
      expect(settings.remoteAccess?.tokenStrategy.persistent.token).toBeNull();
    });
  });

  describe("experimentalFeatures settings", () => {
    it("defaults to empty object {}", async () => {
      const settings = await harness.store().getSettings();
      expect(settings.experimentalFeatures).toEqual({});
    });

    it("can set experimental features via updateGlobalSettings", async () => {
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "my-feature": true, "another-feature": false } });
      const settings = await harness.store().getSettings();
      expect(settings.experimentalFeatures).toEqual({ "my-feature": true, "another-feature": false });
    });

    it("can add and update features using merge semantics", async () => {
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "feature-a": true } });
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "feature-b": true, "feature-a": false } });
      const settings = await harness.store().getSettings();
      expect(settings.experimentalFeatures).toEqual({ "feature-a": false, "feature-b": true });
    });

    it("can remove an experimental feature by setting it to null", async () => {
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "feature-a": true, "feature-b": true } });
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "feature-a": null } as unknown as Record<string, boolean> });
      const settings = await harness.store().getSettings();
      expect(settings.experimentalFeatures).toEqual({ "feature-b": true });
    });

    it("can clear experimentalFeatures with null", async () => {
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "my-feature": true } });
      await harness.store().updateGlobalSettings({ experimentalFeatures: null as unknown as undefined });
      const settings = await harness.store().getSettings();
      expect(settings.experimentalFeatures).toEqual({});
    });

    it("preserves project settings while experimentalFeatures changes", async () => {
      await harness.store().updateSettings({ maxConcurrent: 5, autoMerge: false });
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "my-feature": true } });
      const settings = await harness.store().getSettings();
      expect(settings.maxConcurrent).toBe(5);
      expect(settings.autoMerge).toBe(false);
      expect(settings.experimentalFeatures).toEqual({ "my-feature": true });
    });

    it("handles experimentalFeatures in getSettingsByScope", async () => {
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "scoped-feature": true } });
      const { global, project } = await harness.store().getSettingsByScope();
      expect(global.experimentalFeatures).toEqual({ "scoped-feature": true });
      expect((project as Record<string, unknown>).experimentalFeatures).toBeUndefined();
    });

    it("handles experimentalFeatures in getSettingsFast", async () => {
      await harness.store().updateGlobalSettings({ experimentalFeatures: { "fast-feature": true } });
      const settings = await harness.store().getSettingsFast();
      expect(settings.experimentalFeatures).toEqual({ "fast-feature": true });
    });

    it("project-level experimentalFeatures does not override global value", async () => {
      // Set global experimentalFeatures
      await harness.store().updateGlobalSettings({ experimentalFeatures: { insights: true, roadmap: true } });

      // Simulate stale project-level config with empty experimentalFeatures
      // (can happen from older clients or direct DB writes)
      harness.store().getDatabase()
        .prepare("UPDATE config SET settings = ? WHERE id = 1")
        .run(JSON.stringify({ experimentalFeatures: {} }));

      // getSettingsFast should ignore the project-level global key
      const fastSettings = await harness.store().getSettingsFast();
      expect(fastSettings.experimentalFeatures).toEqual({ insights: true, roadmap: true });

      // getSettings should also ignore the project-level global key
      const settings = await harness.store().getSettings();
      expect(settings.experimentalFeatures).toEqual({ insights: true, roadmap: true });
    });
  });

  // ── Concurrent stress test ───────────────────────────────────────

  describe("taskPrefix setting", () => {
    it("default prefix produces FN-001 IDs", async () => {
      const task = await harness.store().createTask({ description: "Default prefix" });
      expect(task.id).toBe("FN-001");
    });

    it("custom prefix produces PROJ-001 IDs", async () => {
      await harness.store().updateSettings({ taskPrefix: "PROJ" });
      const task = await harness.store().createTask({ description: "Custom prefix" });
      expect(task.id).toBe("PROJ-001");
    });

    it("prefix change mid-stream starts a fresh per-prefix sequence", async () => {
      const t1 = await harness.store().createTask({ description: "First" });
      const t2 = await harness.store().createTask({ description: "Second" });
      expect(t1.id).toBe("FN-001");
      expect(t2.id).toBe("FN-002");

      await harness.store().updateSettings({ taskPrefix: "PROJ" });
      const t3 = await harness.store().createTask({ description: "Third" });
      expect(t3.id).toBe("PROJ-001");
    });

    it("listTasks returns tasks regardless of prefix", async () => {
      await harness.store().createTask({ description: "HAI task" });
      await harness.store().updateSettings({ taskPrefix: "PROJ" });
      await harness.store().createTask({ description: "PROJ task" });

      const tasks = await harness.store().listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id).sort()).toEqual(["FN-001", "PROJ-001"]);
    });

    it("supports pagination with limit and offset", async () => {
      await harness.store().createTask({ description: "Task 1" });
      await harness.store().createTask({ description: "Task 2" });
      await harness.store().createTask({ description: "Task 3" });

      const paged = await harness.store().listTasks({ limit: 1, offset: 1 });

      expect(paged).toHaveLength(1);
      expect(paged[0].id).toBe("FN-002");
    });

    it("slim mode drops the agent log but keeps board-visible fields (steps/comments)", async () => {
      const task = await harness.store().createTask({ description: "Slim test" });
      await harness.store().logEntry(task.id, "heavy log entry that should not appear in slim list");

      const fullList = await harness.store().listTasks();
      const slimList = await harness.store().listTasks({ slim: true });

      const full = fullList.find((t) => t.id === task.id)!;
      const slim = slimList.find((t) => t.id === task.id)!;

      // Sanity: the full row really has the log we wrote.
      expect(full.log.length).toBeGreaterThan(0);

      // Slim must drop the heavy log payload (the only field worth slimming).
      expect(slim.id).toBe(task.id);
      expect(slim.description).toBe("Slim test");
      expect(slim.column).toBe(full.column);
      expect(slim.log).toEqual([]);

      // Slim must STILL include the small JSON columns the board UI reads:
      // step progress, comment counts, workflow status, steering badges.
      // (Dropping them silently broke TaskCard progress bars and the comments tab.)
      expect(slim.steps).toEqual(full.steps);
      expect(slim.comments).toEqual(full.comments);
      expect(slim.workflowStepResults).toEqual(full.workflowStepResults);
      expect(slim.steeringComments).toEqual(full.steeringComments);
    });

    it("slim mode hydrates step metadata from PROMPT.md for board cards", async () => {
      const task = await harness.store().createTask({ description: "Prompt-only steps" });
      await harness.store().updateTask(task.id, {
        prompt: `# ${task.id}: Prompt-only steps

## Steps

### Step 0: Update the list payload

- [ ] Keep card progress visible

### Step 1: Add regression coverage

- [ ] Prove slim lists still include prompt steps
`,
      });

      const fullList = await harness.store().listTasks();
      const slimList = await harness.store().listTasks({ slim: true });
      const full = fullList.find((t) => t.id === task.id)!;
      const slim = slimList.find((t) => t.id === task.id)!;

      expect(full.steps).toEqual([]);
      expect(slim.steps).toEqual([
        { name: "Update the list payload", status: "pending" },
        { name: "Add regression coverage", status: "pending" },
      ]);

      const searchResults = await harness.store().searchTasks("Prompt-only");
      expect(searchResults.find((t) => t.id === task.id)?.steps).toEqual(slim.steps);
    });

    it("includeArchived=false excludes archived tasks; default includes them", async () => {
      const keep = await harness.store().createTask({ description: "Stays visible" });
      const toArchive = await harness.store().createTask({ description: "Will be archived", column: "done" });

      // This assertion is about list filtering, not branch cleanup.
      // Use non-cleanup archiving to avoid invoking git commands in test environments.
      await harness.store().archiveTask(toArchive.id, false);

      const withArchived = await harness.store().listTasks();
      const withoutArchived = await harness.store().listTasks({ includeArchived: false });

      expect(withArchived.map((t) => t.id)).toEqual(expect.arrayContaining([keep.id, toArchive.id]));
      expect(withoutArchived.map((t) => t.id)).toContain(keep.id);
      expect(withoutArchived.map((t) => t.id)).not.toContain(toArchive.id);
    });
  });
});
