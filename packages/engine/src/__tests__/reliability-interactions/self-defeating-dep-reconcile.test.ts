import { afterEach, describe, expect, it } from "vitest";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

describeIfGit("reliability interactions: self-defeating dep reconciliation", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];

  afterEach(async () => {
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("reconciles pre-existing offender in todo and records audit + task log", async () => {
    const fx = await makeReliabilityFixture({
      taskId: "FN-4891-A",
      task: {
        column: "todo",
        title: "safe title",
        dependencies: ["FN-100", "FN-200"],
      } as any,
    });
    fixtures.push(fx);

    await fx.store.listTasks({ column: "todo", slim: true });
    await fx.seedRawTaskColumns(fx.task.id, { title: "Finalize FN-100: close loop" });

    const recovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(recovered).toBe(1);

    const updated = await fx.store.getTask(fx.task.id);
    expect(updated?.dependencies).toEqual(["FN-200"]);
    expect(
      updated?.log.some((entry) => JSON.stringify(entry).includes("Auto-reconciled self-defeating dependency")),
    ).toBe(true);

    const events = await fx.store.getRunAuditEventsAsync({
      taskId: fx.task.id,
      domain: "database",
      mutationType: "task:auto-reconciled-self-defeating-dep",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(fx.task.id);
    expect(events[0]?.metadata).toMatchObject({
      matchedVerb: "finalize",
      operandTaskId: "FN-100",
      originalDependencies: ["FN-100", "FN-200"],
      nextDependencies: ["FN-200"],
    });
  });

  it("does not reconcile non-operational test title", async () => {
    const fx = await makeReliabilityFixture({
      taskId: "FN-4891-B",
      task: {
        column: "todo",
        title: "Test FN-100",
        dependencies: ["FN-100"],
      } as any,
    });
    fixtures.push(fx);

    const recovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(recovered).toBe(0);

    const updated = await fx.store.getTask(fx.task.id);
    expect(updated?.dependencies).toEqual(["FN-100"]);
  });

  it("does not touch in-progress offenders", async () => {
    const fx = await makeReliabilityFixture({
      taskId: "FN-4891-C",
      task: {
        column: "in-progress",
        title: "safe title",
        dependencies: ["FN-100"],
      } as any,
    });
    fixtures.push(fx);

    await fx.seedRawTaskColumns(fx.task.id, { title: "Finalize FN-100" });

    const recovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(recovered).toBe(0);

    const updated = await fx.store.getTask(fx.task.id);
    expect(updated?.dependencies).toEqual(["FN-100"]);
  });
});
