/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-self-defeating-dep.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. The pure-logic detection tests are
 * omitted (they don't touch the DB); only the create-time guard tests are
 * migrated to validate the backend-mode createTask path enforces the same
 * SelfDefeatingDependencyError.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore create-time self-defeating dep guard (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_self_defeating",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("rejects createTask with SelfDefeatingDependencyError and persists nothing", async () => {
    const store = h.store();
    await expect(
      store.createTask({
        title: "Finalize FN-4847: mark steps done",
        description: "manual closeout",
        dependencies: ["FN-4847"],
      }),
    ).rejects.toMatchObject({
      name: "SelfDefeatingDependencyError",
      code: "SELF_DEFEATING_DEPENDENCY",
    });

    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(0);
  });

  /*
  FNXC:SelfDefeatingDependency 2026-08-23-16:28:
  FN-073 made creation validate that every declared dependency target exists, so the "allowed" half of
  this guard can no longer point at a fabricated id — it would fail on the dependency check before the
  title guard ever spoke. Depend on a REAL sibling and name it in the title: that still proves a
  non-operational title ("Test <id>") is admitted where the operational one above is rejected.
  */
  it("allows non-operational sibling title", async () => {
    const store = h.store();
    const dependency = await store.createTask({
      title: "Sibling under test",
      description: "dependency target",
    });
    const created = await store.createTask({
      title: `Test ${dependency.id}`,
      description: "verification task",
      dependencies: [dependency.id],
    });
    expect(created.id).toMatch(/^(FN|KB)-/);
    expect(created.dependencies).toEqual([dependency.id]);
  });
});
