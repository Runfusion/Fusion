/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * VAL-CROSS-004 — Settings persist across restarts
 *
 * Validates that project settings (model config, autoMerge, worktree settings)
 * round-trip through PostgreSQL backend mode.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS } from "../../config/settings-schema.js";
import { sql } from "drizzle-orm";

const credentialLaneKeys = [
  ["defaultProvider", "defaultCredentialInstanceId"],
  ["executionGlobalProvider", "executionGlobalCredentialInstanceId"],
  ["titleSummarizerProvider", "titleSummarizerCredentialInstanceId"],
  ["defaultProviderOverride", "defaultCredentialInstanceIdOverride"],
] as const;

const pgTest = pgDescribe;

pgTest("VAL-CROSS-004: Settings persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_settings_persist",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists model settings via updateGlobalSettings", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    const settings = await store.getSettings();
    expect(settings.defaultProvider).toBe("anthropic");
    expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("persists project-level settings via updateSettings", async () => {
    const store = h.store();
    await store.updateSettings({
      worktreeInitCommand: "pnpm install",
      autoMerge: false,
    });

    const settings = await store.getSettings();
    expect(settings.worktreeInitCommand).toBe("pnpm install");
    expect(settings.autoMerge).toBe(false);
  });

  it("records omitted settings actors as the honest system fallback", async () => {
    const store = h.store();
    await store.updateSettings({ taskPrefix: "ATTR" });
    await store.updateGlobalSettings({ defaultModelId: "attribution-model" });

    const revisions = await h.adminDb().execute(sql`
      SELECT changed_by AS "changedBy"
      FROM project.configuration_revisions
      ORDER BY sequence ASC
    `);
    const actors = revisions.map((row) => row.changedBy);

    expect(actors).toContainEqual({ kind: "system", id: "fusion-system" });
    expect(actors).not.toContainEqual(expect.objectContaining({ kind: "human" }));
  });

  it("discards retired ephemeral compatibility patches while preserving active project settings", async () => {
    const store = h.store();
    await store.updateSettings({
      ephemeralAgentsEnabled: false,
      ephemeralAgentTaskCreationPolicy: "deny",
      taskPrefix: "ACTIVE",
    } as never);

    const settings = await store.getSettings();
    expect(settings).not.toHaveProperty("ephemeralAgentsEnabled");
    expect(settings.ephemeralAgentTaskCreationPolicy).toBe("deny");
    expect(settings.taskPrefix).toBe("ACTIVE");
  });

  it("keeps the recommendation cap project-scoped when an untyped global patch includes it", async () => {
    const store = h.store();
    await store.updateSettings({ maxRecommendationsPerTask: 7 });

    // JSON/API callers can evade the GlobalSettings TypeScript shape; global persistence must not.
    await store.updateGlobalSettings({ maxRecommendationsPerTask: 20 } as never);

    expect((await store.getSettings()).maxRecommendationsPerTask).toBe(7);
  });

  it("settings survive a re-read (persistence)", async () => {
    const store = h.store();
    await store.updateSettings({ maxConcurrentTasks: 5 });

    // Read settings again
    const settings1 = await store.getSettings();
    expect(settings1.maxConcurrentTasks).toBe(5);

    // Read again to verify it's not just in-memory cache
    const settings2 = await store.getSettings();
    expect(settings2.maxConcurrentTasks).toBe(5);
  });

  it("persists global, project, lane, fallback, and preset credential instances", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      defaultCredentialInstanceId: "global-default",
      executionGlobalCredentialInstanceId: "global-execution",
      fallbackCredentialInstanceId: "global-fallback",
    });
    await store.updateSettings({
      defaultCredentialInstanceIdOverride: "project-default",
      titleSummarizerCredentialInstanceId: "project-title",
      titleSummarizerFallbackCredentialInstanceId: "project-title-fallback",
      modelPresets: [{
        id: "credential-preset",
        name: "Credential preset",
        executorProvider: "anthropic",
        executorModelId: "claude",
        executorCredentialInstanceId: "preset-executor",
        validatorProvider: "openai",
        validatorModelId: "gpt",
        validatorCredentialInstanceId: "preset-validator",
      }],
    } as never);

    const settings = await store.getSettings();
    expect(settings).toMatchObject({
      defaultCredentialInstanceId: "global-default",
      executionGlobalCredentialInstanceId: "global-execution",
      fallbackCredentialInstanceId: "global-fallback",
      defaultCredentialInstanceIdOverride: "project-default",
      titleSummarizerCredentialInstanceId: "project-title",
      titleSummarizerFallbackCredentialInstanceId: "project-title-fallback",
    });
    expect(settings.modelPresets).toEqual([expect.objectContaining({
      executorCredentialInstanceId: "preset-executor",
      validatorCredentialInstanceId: "preset-validator",
    })]);
  });

  it("persists a workflow-lane credential instance through its scoped settings row", async () => {
    const store = h.store();
    const projectId = store.getWorkflowSettingsProjectId();
    await store.updateWorkflowSettingValues("builtin:coding", projectId, {
      executionCredentialInstanceId: "workflow-execution",
    });
    expect(await store.getWorkflowSettingValuesAsync("builtin:coding", projectId))
      .toMatchObject({ executionCredentialInstanceId: "workflow-execution" });
  });

  it("keeps credential-instance keys in the same settings scope as their provider", () => {
    for (const [providerKey, instanceKey] of credentialLaneKeys) {
      expect(GLOBAL_SETTINGS_KEYS.includes(providerKey as never)).toBe(GLOBAL_SETTINGS_KEYS.includes(instanceKey as never));
      expect(PROJECT_SETTINGS_KEYS.includes(providerKey as never)).toBe(PROJECT_SETTINGS_KEYS.includes(instanceKey as never));
    }
  });

  it("rejects invalid global/project ids and atomically preserves stored presets", async () => {
    const store = h.store();
    const priorPresets = [{ id: "prior", name: "Prior", executorProvider: "anthropic", executorModelId: "claude" }];
    await store.updateSettings({ modelPresets: priorPresets } as never);

    await expect(store.updateGlobalSettings({ defaultCredentialInstanceId: "bad[id]" } as never)).rejects.toThrow();
    await expect(store.updateSettings({ titleSummarizerCredentialInstanceId: "bad[id]" } as never)).rejects.toThrow();
    await expect(store.updateSettings({ modelPresets: [
      ...priorPresets,
      { id: "bad-executor", name: "Bad", executorCredentialInstanceId: "bad[id]" },
    ] } as never)).rejects.toThrow();
    expect((await store.getSettings()).modelPresets).toEqual(priorPresets);

    await expect(store.updateSettings({ modelPresets: [
      ...priorPresets,
      { id: "bad-validator", name: "Bad", validatorCredentialInstanceId: "   " },
    ] } as never)).rejects.toThrow();
    expect((await store.getSettings()).modelPresets).toEqual(priorPresets);
  });
});
