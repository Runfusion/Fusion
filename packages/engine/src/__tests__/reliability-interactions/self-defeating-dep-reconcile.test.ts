import { afterEach, describe, expect, it } from "vitest";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

/*
FNXC:DependencyIntegrity 2026-08-23-18:36:
FN-073 (be34be7430) made task CREATION a dependency writer: `insertAfterDependencyValidation` locks and
revalidates every declared prerequisite in the insert transaction and throws `Dependency task <id> not found`
for a dangling edge. These scenarios are about PRE-EXISTING rows that already carry a self-defeating edge —
exactly the rows creation can no longer mint — so the offending `dependencies` are seeded as raw columns
instead of being declared at create time. Declaring them on `createTask` again makes every case throw in the
fixture before the reconciler runs.
*/
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
      } as any,
    });
    fixtures.push(fx);

    /*
    FNXC:DependencyIntegrity 2026-08-23-18:41:
    The reconciler REWRITES `dependencies` through `store.updateTask`, which FN-073 also guards, so the
    SURVIVING edge has to point at a live task or the write throws and the reconcile is swallowed as a warn
    (recovered stays 0). FN-100 stays dangling on purpose — it is the edge under reconciliation. The store
    assigns its own sequential ids, so the survivor is referenced by the id creation actually returned
    rather than a hardcoded literal.
    */
    const survivor = await fx.store.createTask({
      title: "surviving prerequisite",
      description: "live dependency target",
      column: "todo",
      steps: [],
    } as any);

    await fx.store.listTasks({ column: "todo", slim: true });
    await fx.seedRawTaskColumns(fx.task.id, {
      title: "Finalize FN-100: close loop",
      dependencies: ["FN-100", survivor.id],
    });

    const recovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(recovered).toBe(1);

    const updated = await fx.store.getTask(fx.task.id);
    expect(updated?.dependencies).toEqual([survivor.id]);
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
      originalDependencies: ["FN-100", survivor.id],
      nextDependencies: [survivor.id],
    });
  });

  it("does not reconcile non-operational test title", async () => {
    const fx = await makeReliabilityFixture({
      taskId: "FN-4891-B",
      task: {
        column: "todo",
        title: "Test FN-100",
      } as any,
    });
    fixtures.push(fx);

    await fx.seedRawTaskColumns(fx.task.id, { dependencies: ["FN-100"] });

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
      } as any,
    });
    fixtures.push(fx);

    await fx.seedRawTaskColumns(fx.task.id, { title: "Finalize FN-100", dependencies: ["FN-100"] });

    const recovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(recovered).toBe(0);

    const updated = await fx.store.getTask(fx.task.id);
    expect(updated?.dependencies).toEqual(["FN-100"]);
  });
});
