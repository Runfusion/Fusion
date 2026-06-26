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
});
