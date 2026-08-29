/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-effective-node-fields.test.ts.
 *
 * Migrated from `new TaskStore(rootDir, { inMemoryDb: true })` (SQLite) to the
 * shared PG test harness so the effective-node-routing fields persistence path
 * is exercised against PostgreSQL. This is part of the SQLite removal test
 * migration: every pure-TaskStore-API test that exercises backend-mode methods
 * (createTask/updateTask/getTask/updateSettings/getSettings) gets a PG twin
 * gated by pgDescribe (auto-skipped in CI without PG).
 *
 * The original SQLite test file remains until SQLite is fully removed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("effective node routing fields persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_eff_node_fields",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists effective node fields through create/update/read and clear cycle", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "task for effective node fields" });

    await store.updateTask(created.id, {
      effectiveNodeId: "node-abc",
      effectiveNodeSource: "project-default",
    });

    const withRouting = await store.getTask(created.id);
    expect(withRouting.effectiveNodeId).toBe("node-abc");
    expect(withRouting.effectiveNodeSource).toBe("project-default");

    await store.updateTask(created.id, {
      effectiveNodeId: null,
      effectiveNodeSource: null,
    });

    const cleared = await store.getTask(created.id);
    expect(cleared.effectiveNodeId).toBeUndefined();
    expect(cleared.effectiveNodeSource).toBeUndefined();
  });

  it("persists defaultNodeId in project settings through save/load", async () => {
    const store = h.store();
    await store.updateSettings({ defaultNodeId: "node-default-1" });
    const settings = await store.getSettings();
    expect(settings.defaultNodeId).toBe("node-default-1");
  });

  it("defaults defaultNodeId to undefined in fresh project settings", async () => {
    const store = h.store();
    const settings = await store.getSettings();
    expect(settings.defaultNodeId).toBeUndefined();
  });
});
