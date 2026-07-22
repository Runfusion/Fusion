/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-update-step-order.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates step-order guard semantics
 * work identically against PostgreSQL backend mode.
 */
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore.updateStep step-order guard (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_step_order",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("no-ops out-of-order done updates when an earlier step is pending", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("pending");
  });

  it("does not start a later step when an earlier ordered step is still in progress", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "in-progress");
    await Promise.all([
      store.updateStep(task.id, 1, "done"),
      store.updateStep(task.id, 2, "in-progress"),
    ]);

    const updated = await store.getTask(task.id);
    expect(updated.steps.map((step) => step.status)).toEqual([
      "in-progress",
      "pending",
      "pending",
    ]);
    expect(updated.currentStep).toBe(0);
    expect(updated.log.map((entry) => entry.action)).toContainEqual(
      expect.stringContaining("Ignored out-of-order in-progress for step 2"),
    );
  });

  it("allows an explicitly independent step to finish out of index order", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [] } : step,
      ),
    });

    const active = await store.updateStep(task.id, 2, "in-progress");
    expect(active.steps[2].status).toBe("in-progress");

    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[0].status).toBe("pending");
    expect(updated.steps[1].status).toBe("pending");
    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(0);

    const remaining = await store.updateStep(task.id, 0, "done");
    expect(remaining.currentStep).toBe(1);
    const finalized = await store.updateStep(task.id, 1, "done");
    expect(finalized.steps.every((step) => step.status === "done")).toBe(true);
    expect(finalized.currentStep).toBe(3);
  });

  it("still blocks out-of-index completion when an explicit dependency is pending", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [1] } : step,
      ),
    });

    await store.updateStep(task.id, 1, "in-progress");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.at(-1)?.action).toContain("dependency step 1");
  });

  it("blocks a start when an explicit dependency is still in progress", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [1] } : step,
      ),
    });

    await store.updateStep(task.id, 1, "in-progress");
    const updated = await store.updateStep(task.id, 2, "in-progress");

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.at(-1)?.action).toContain("dependency step 1");
  });

  it("allows a satisfied explicit dependency while an unrelated earlier step is pending", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 1
          ? { ...step, dependsOn: [] }
          : index === 2
            ? { ...step, dependsOn: [1] }
            : step,
      ),
    });

    await store.updateStep(task.id, 1, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[0].status).toBe("pending");
    expect(updated.steps[1].status).toBe("done");
    expect(updated.steps[2].status).toBe("done");
  });

  it("honors an explicit empty dependency list for graph-source completion", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [] } : step,
      ),
    });

    const updated = await store.updateStep(task.id, 2, "done", { source: "graph" });

    expect(updated.steps[2].status).toBe("done");
  });

  it("blocks a graph-source start while its implicit predecessor is unfinished", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    const updated = await store.updateStep(task.id, 2, "in-progress", { source: "graph" });

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.map((entry) => entry.action)).toContainEqual(
      expect.stringContaining("Ignored dependency-order in-progress for step 2"),
    );
    expect(updated.log.map((entry) => entry.action)).toContainEqual(
      expect.stringContaining("[integrity-warning] graph-source updateStep suppressed"),
    );
  });

  it.each([{ dependsOn: [2] }, { dependsOn: [99] }, { dependsOn: [-1] }, { dependsOn: [1.5] }])(
    "falls back to strict ordering for malformed dependsOn %j",
    async ({ dependsOn }) => {
      const store = h.store();
      const task = await h.createTaskWithSteps();
      await store.updateTask(task.id, {
        steps: task.steps.map((step, index) =>
          index === 2 ? { ...step, dependsOn } : step,
        ),
      });

      const updated = await store.updateStep(task.id, 2, "done");

      expect(updated.steps[2].status).toBe("pending");
      expect(updated.log.map((entry) => entry.action)).toContainEqual(
        expect.stringContaining("[integrity-warning] invalid dependsOn"),
      );
      expect(updated.log.at(-1)?.action).toContain("earlier step 0");
    },
  );

  it("allows done when prior steps are skipped", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "skipped");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(3);
  });

  it("allows done when prior steps are done and advances currentStep", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(3);
  });

  it("keeps done→in-progress regression guard behavior", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 0, "in-progress");

    expect(updated.steps[0].status).toBe("done");
  });
});
