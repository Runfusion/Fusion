/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * Validation tests for createSharedPgTaskStoreTestHarness() — the PostgreSQL
 * counterpart to the SQLite createSharedTaskStoreTestHarness. Proves the
 * shared harness:
 *   - boots one PG database reused across tests in a describe block,
 *   - resets all application data in beforeEach (TRUNCATE + config reseed),
 *   - keeps the store usable across multiple tests with no cross-test leakage.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("createSharedPgTaskStoreTestHarness", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_shared_harness_val",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("constructs a backend-mode store", () => {
    expect(h.store().isBackendMode()).toBe(true);
    expect(h.store().getAsyncLayer()).not.toBeNull();
  });

  it("creates a task and reads it back", async () => {
    const created = await h.store().createTask({ description: "shared harness task" });
    expect(created.id).toBeTruthy();
    const fetched = await h.store().getTask(created.id);
    expect(fetched.description).toBe("shared harness task");
  });

  it("does NOT see tasks created by the previous test (reset works)", async () => {
    // The previous test created one task; beforeEach TRUNCATE must have cleared it.
    const tasks = await h.store().listTasks();
    expect(tasks.length).toBe(0);
  });

  it("creates a task, then verifies the reset cleared it for the next assertion", async () => {
    await h.store().createTask({ description: "task A" });
    await h.store().createTask({ description: "task B" });
    let tasks = await h.store().listTasks();
    expect(tasks.length).toBe(2);
    // Manually trigger the reset to prove it clears within the same DB.
    await h.beforeEach();
    tasks = await h.store().listTasks();
    expect(tasks.length).toBe(0);
  });

  it("preserves default project settings after reset", async () => {
    const settings = await h.store().getSettings();
    // DEFAULT_PROJECT_SETTINGS has autoMerge defined; the reset reseeds it.
    expect(settings).toBeDefined();
    expect(typeof settings).toBe("object");
  });

  it("updateSettings then reset restores defaults", async () => {
    await h.store().updateSettings({ taskPrefix: "SHARED" });
    let settings = await h.store().getSettings();
    expect(settings.taskPrefix).toBe("SHARED");
    await h.beforeEach();
    settings = await h.store().getSettings();
    // After reset the config row is reseeded with DEFAULT_PROJECT_SETTINGS,
    // so the custom prefix is gone.
    expect(settings.taskPrefix).not.toBe("SHARED");
  });
});
