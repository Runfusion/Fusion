/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-dependency-cycle.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates dependency cycle detection
 * guard works identically against PostgreSQL backend mode.
 *
 * KNOWN GAP: updateTask with dependency changes hits raw SQLite paths in
 * backend mode ("TaskStore.db: SQLite Database is not available"). The
 * dependency mutation write paths need async delegation. Tests exercising
 * those paths are skipped until wired.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { DependencyCycleError } from "../../store.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore dependency cycle guard (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dep_cycle",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);

  beforeEach(async () => {
    await h.beforeEach();
  });

  afterEach(async () => {
    await h.afterEach();
  });

  it("rejects cycle-forming update and preserves persisted dependencies", async () => {
    const store = h.store();
    const a = await store.createTask({ title: "A", description: "A" });
    const b = await store.createTask({ title: "B", description: "B", dependencies: [a.id] });

    await expect(store.updateTask(a.id, { dependencies: [b.id] })).rejects.toBeInstanceOf(DependencyCycleError);

    const refreshedA = await store.getTask(a.id);
    expect(refreshedA.dependencies).toEqual([]);
  });

  it("accepts umbrella parent depending on children with no back-edge", async () => {
    const store = h.store();
    const childA = await store.createTask({ title: "child-a", description: "a" });
    const childB = await store.createTask({ title: "child-b", description: "b" });

    const parent = await store.createTask({
      title: "umbrella",
      description: "parent",
      dependencies: [childA.id, childB.id],
    });

    expect(parent.dependencies).toEqual([childA.id, childB.id]);
  });

  it("rejects FN-5240/FN-5241/FN-5242 write-time cycle signature", async () => {
    const store = h.store();
    const a = await store.createTask({ title: "FN-5240", description: "A" });
    const b = await store.createTask({ title: "FN-5241", description: "B" });
    const c = await store.createTask({ title: "FN-5242", description: "C" });

    await store.updateTask(b.id, { dependencies: [c.id] });
    await store.updateTask(c.id, { dependencies: [a.id] });

    await expect(store.updateTask(a.id, { dependencies: [b.id] })).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("rejects self-loop introduced via update", async () => {
    const store = h.store();
    const a = await store.createTask({ title: "A", description: "A" });
    await expect(store.updateTask(a.id, { dependencies: [a.id] })).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("DependencyCycleError includes IDs and arrow-rendered path", () => {
    const error = new DependencyCycleError("FN-A", ["FN-A", "FN-B", "FN-A"]);
    expect(error.name).toBe("DependencyCycleError");
    expect(error.cyclePath).toEqual(["FN-A", "FN-B", "FN-A"]);
    expect(error.message).toContain("FN-A → FN-B → FN-A");
  });

  it("accepts non-cyclic updates", async () => {
    const store = h.store();
    const a = await store.createTask({ title: "A", description: "A" });
    const b = await store.createTask({ title: "B", description: "B" });
    const updated = await store.updateTask(b.id, { dependencies: [a.id] });
    expect(updated.dependencies).toEqual([a.id]);
  });
});
