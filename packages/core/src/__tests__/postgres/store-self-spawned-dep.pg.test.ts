import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore self-spawned dependency guard (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_self_spawned_dependency",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("rejects both dependency write seams without changing the persisted parent", async () => {
    const store = h.store();
    const parent = await store.createTask({ description: "parent" });
    const child = await store.createTask({
      description: "child",
      source: { sourceType: "api", sourceParentTaskId: parent.id },
    });

    await expect(store.updateTask(parent.id, { dependencies: [child.id] })).rejects.toMatchObject({
      name: "SelfSpawnedDependencyError",
      code: "SELF_SPAWNED_DEPENDENCY",
    });
    expect((await store.getTask(parent.id)).dependencies).toEqual([]);

    await expect(store.updateTaskDependencies(parent.id, {
      operation: "add",
      dependency: child.id,
    })).rejects.toMatchObject({
      name: "SelfSpawnedDependencyError",
      code: "SELF_SPAWNED_DEPENDENCY",
    });
    expect((await store.getTask(parent.id)).dependencies).toEqual([]);
  });

  it("continues to allow independently planned dependencies", async () => {
    const store = h.store();
    const parent = await store.createTask({ description: "parent" });
    const independent = await store.createTask({ description: "independent" });

    const updated = await store.updateTaskDependencies(parent.id, {
      operation: "add",
      dependency: independent.id,
    });

    expect(updated.dependencies).toEqual([independent.id]);
  });
});
