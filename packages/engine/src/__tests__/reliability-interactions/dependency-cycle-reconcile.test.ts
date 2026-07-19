import { afterEach, describe, expect, it } from "vitest";
import { DependencyCycleError, detectSelfDefeatingDependency } from "@fusion/core";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

describeIfGit("reliability interactions: dependency-cycle reconciliation", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];

  afterEach(async () => {
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("auto-repairs umbrella back-edge cycles and records audit/log evidence", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5256-U" });
    fixtures.push(fx);

    const umbrella = await fx.store.createTask({
      id: "FN-5256-P",
      title: "Umbrella: track FN-5256",
      description: "parent",
    } as any);
    const child = await fx.store.createTask({ id: "FN-5256-C", title: "Foundation child", description: "child" } as any);

    await fx.store.listTasks({ slim: true });
    await fx.seedRawTaskColumns(umbrella.id, { dependencies: [child.id] });
    await fx.seedRawTaskColumns(child.id, { dependencies: [umbrella.id] });

    const recovered = await fx.manager.reconcileDependencyCycles();
    expect(recovered).toBe(1);

    const updatedChild = await fx.store.getTask(child.id);
    const updatedUmbrella = await fx.store.getTask(umbrella.id);
    expect(updatedChild?.dependencies).toEqual([]);
    expect(updatedUmbrella?.dependencies).toEqual([child.id]);
    expect(updatedChild?.log.some((entry) => JSON.stringify(entry).includes("Auto-cleared umbrella back-edge"))).toBe(true);

    const repairedAudit = await fx.store.getRunAuditEventsAsync({
      taskId: child.id,
      domain: "database",
      mutationType: "task:auto-reconciled-dependency-cycle",
    });
    expect(repairedAudit).toHaveLength(1);
    expect(repairedAudit[0]?.metadata).toMatchObject({
      removedDependency: umbrella.id,
      reason: "umbrella-back-edge",
    });
  });

  it("detects ambiguous FN-5240/FN-5241/FN-5242 persisted cycle once and leaves it unchanged", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5256-A" });
    fixtures.push(fx);

    const a = await fx.store.createTask({ id: "FN-5240", title: "Task A", description: "A" } as any);
    const b = await fx.store.createTask({ id: "FN-5241", title: "Task B", description: "B" } as any);
    const c = await fx.store.createTask({ id: "FN-5242", title: "Task C", description: "C" } as any);

    await fx.store.listTasks({ slim: true });
    await fx.seedRawTaskColumns(a.id, { dependencies: [b.id] });
    await fx.seedRawTaskColumns(b.id, { dependencies: [c.id] });
    await fx.seedRawTaskColumns(c.id, { dependencies: [a.id] });

    const recovered = await fx.manager.reconcileDependencyCycles();
    expect(recovered).toBe(0);

    expect((await fx.store.getTask(a.id))?.dependencies).toEqual([b.id]);
    expect((await fx.store.getTask(b.id))?.dependencies).toEqual([c.id]);
    expect((await fx.store.getTask(c.id))?.dependencies).toEqual([a.id]);

    const detected = await fx.store.getRunAuditEventsAsync({
      taskId: a.id,
      domain: "database",
      mutationType: "task:dependency-cycle-detected",
    });
    const unrepaired = await fx.store.getRunAuditEventsAsync({
      taskId: a.id,
      domain: "database",
      mutationType: "task:dependency-cycle-unrepaired",
    });
    expect(detected).toHaveLength(1);
    expect(unrepaired).toHaveLength(1);
  });

  it("composes self-defeating cleanup before dependency-cycle cleanup and keeps write-time guard active", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5256-COMP" });
    fixtures.push(fx);

    const child = await fx.store.createTask({ id: "FN-5256-CHILD", title: "child", description: "child" } as any);
    const umbrella = await fx.store.createTask({
      id: "FN-5256-UMB",
      title: "Umbrella coordination",
      description: "umbrella",
      dependencies: [child.id],
    } as any);

    await fx.store.listTasks({ column: "todo", slim: true });
    await fx.seedRawTaskColumns(child.id, { title: "Finalize FN-100: close loop", dependencies: ["FN-100"], column: "todo" });
    expect(await fx.store.getTask(child.id)).toMatchObject({
      title: "Finalize FN-100: close loop", dependencies: ["FN-100"], column: "todo",
    });
    const seededChild = (await fx.store.listTasks({ column: "todo", slim: true })).find((task) => task.id === child.id)!;
    expect(seededChild).toMatchObject({ title: "Finalize FN-100: close loop", dependencies: ["FN-100"], column: "todo" });
    expect(detectSelfDefeatingDependency(seededChild.title, seededChild.dependencies)).toEqual({ matchedVerb: "finalize", operandTaskId: "FN-100" });

    const selfDefRecovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(selfDefRecovered).toBe(1);
    expect((await fx.store.getTask(child.id))?.dependencies).toEqual([]);

    await fx.seedRawTaskColumns(child.id, { dependencies: [umbrella.id] });

    const cycleRecovered = await fx.manager.reconcileDependencyCycles();
    expect(cycleRecovered).toBe(1);

    const updatedChild = await fx.store.getTask(child.id);
    expect(updatedChild?.dependencies).toEqual([]);

    const selfDefAudit = await fx.store.getRunAuditEventsAsync({
      taskId: child.id,
      domain: "database",
      mutationType: "task:auto-reconciled-self-defeating-dep",
    });
    const cycleAudit = await fx.store.getRunAuditEventsAsync({
      taskId: child.id,
      domain: "database",
      mutationType: "task:auto-reconciled-dependency-cycle",
    });
    expect(selfDefAudit).toHaveLength(1);
    expect(cycleAudit).toHaveLength(1);

    await expect(fx.store.updateTask(child.id, { dependencies: [umbrella.id] })).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("leaves ambiguous long cycles unchanged and emits one unrepaired event with closed cyclePath", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5432-LONG" });
    fixtures.push(fx);

    const a = await fx.store.createTask({ id: "FN-5432-A", title: "Task A", description: "A" } as any);
    const b = await fx.store.createTask({ id: "FN-5432-B", title: "Task B", description: "B" } as any);
    const c = await fx.store.createTask({ id: "FN-5432-C", title: "Task C", description: "C" } as any);
    const d = await fx.store.createTask({ id: "FN-5432-D", title: "Task D", description: "D" } as any);

    await fx.store.listTasks({ slim: true });
    await fx.seedRawTaskColumns(a.id, { dependencies: [b.id] });
    await fx.seedRawTaskColumns(b.id, { dependencies: [c.id] });
    await fx.seedRawTaskColumns(c.id, { dependencies: [d.id] });
    await fx.seedRawTaskColumns(d.id, { dependencies: [a.id] });

    const recovered = await fx.manager.reconcileDependencyCycles();
    expect(recovered).toBe(0);

    expect((await fx.store.getTask(a.id))?.dependencies).toEqual([b.id]);
    expect((await fx.store.getTask(b.id))?.dependencies).toEqual([c.id]);
    expect((await fx.store.getTask(c.id))?.dependencies).toEqual([d.id]);
    expect((await fx.store.getTask(d.id))?.dependencies).toEqual([a.id]);

    const repaired = await fx.store.getRunAuditEventsAsync({ domain: "database", mutationType: "task:auto-reconciled-dependency-cycle" });
    expect(repaired).toHaveLength(0);

    const unrepaired = await fx.store.getRunAuditEventsAsync({ domain: "database", mutationType: "task:dependency-cycle-unrepaired" });
    expect(unrepaired).toHaveLength(1);
    const cyclePath = unrepaired[0]?.metadata?.cyclePath as string[];
    expect(Array.isArray(cyclePath)).toBe(true);
    expect(cyclePath.length).toBe(5);
    expect(cyclePath[0]).toBe(cyclePath[cyclePath.length - 1]);
    expect(new Set(cyclePath)).toEqual(new Set([a.id, b.id, c.id, d.id]));
  });

  it("keeps write-time cycle guard correct during ambiguous cycle sweep", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5432-RACE" });
    fixtures.push(fx);

    const a = await fx.store.createTask({ id: "FN-5432-RA", title: "Task A", description: "A" } as any);
    const b = await fx.store.createTask({ id: "FN-5432-RB", title: "Task B", description: "B" } as any);
    const c = await fx.store.createTask({ id: "FN-5432-RC", title: "Task C", description: "C" } as any);
    const d = await fx.store.createTask({ id: "FN-5432-RD", title: "Task D", description: "D" } as any);

    await fx.store.listTasks({ slim: true });
    await fx.seedRawTaskColumns(a.id, { dependencies: [b.id] });
    await fx.seedRawTaskColumns(b.id, { dependencies: [c.id] });
    await fx.seedRawTaskColumns(c.id, { dependencies: [d.id] });
    await fx.seedRawTaskColumns(d.id, { dependencies: [a.id] });

    const sweepPromise = fx.manager.reconcileDependencyCycles();
    const x = await fx.store.createTask({ id: "FN-5432-RX", title: "Task X", description: "X", dependencies: [a.id] } as any);
    const recovered = await sweepPromise;

    expect(recovered).toBe(0);
    await expect(fx.store.updateTask(x.id, { dependencies: [b.id, a.id] })).resolves.toBeTruthy();
    await expect(fx.store.updateTask(a.id, { dependencies: [x.id] })).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("reconciles self-defeating edges before cycle handling without contradictory audit outcomes", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5432-COMP2" });
    fixtures.push(fx);

    const p = await fx.store.createTask({ title: "Task P", description: "P" } as any);
    const q = await fx.store.createTask({ title: "Task Q", description: "Q", dependencies: [p.id] } as any);

    await fx.store.listTasks({ column: "todo", slim: true });
    await fx.seedRawTaskColumns(p.id, { title: "Finalize FN-101: now", dependencies: ["FN-101"], column: "todo" });
    expect(await fx.store.getTask(p.id)).toMatchObject({
      title: "Finalize FN-101: now", dependencies: ["FN-101"], column: "todo",
    });
    const seededP = (await fx.store.listTasks({ column: "todo", slim: true })).find((task) => task.id === p.id)!;
    expect(seededP).toMatchObject({ title: "Finalize FN-101: now", dependencies: ["FN-101"], column: "todo" });
    expect(detectSelfDefeatingDependency(seededP.title, seededP.dependencies)).toEqual({ matchedVerb: "finalize", operandTaskId: "FN-101" });

    const selfDefRecovered = await fx.manager.reconcileSelfDefeatingDependencies();
    expect(selfDefRecovered).toBe(1);
    expect((await fx.store.getTask(p.id))?.dependencies).toEqual([]);

    await fx.seedRawTaskColumns(p.id, { dependencies: [q.id] });
    const cycleRecovered = await fx.manager.reconcileDependencyCycles();
    expect(cycleRecovered).toBe(0);

    const selfDefAudit = await fx.store.getRunAuditEventsAsync({ taskId: p.id, domain: "database", mutationType: "task:auto-reconciled-self-defeating-dep" });
    const unrepairedP = await fx.store.getRunAuditEventsAsync({ taskId: p.id, domain: "database", mutationType: "task:dependency-cycle-unrepaired" });
    expect(selfDefAudit).toHaveLength(1);
    expect(unrepairedP).toHaveLength(1);
    const unrepairedPath = unrepairedP[0]?.metadata?.cyclePath as string[];
    expect(unrepairedPath).toEqual([p.id, q.id, p.id]);

    const cycleDetected = await fx.store.getRunAuditEventsAsync({ taskId: p.id, domain: "database", mutationType: "task:dependency-cycle-detected" });
    expect(cycleDetected).toHaveLength(1);
  });

  it("emits closed and task-anchored cyclePath metadata for unrepaired cycle events", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5432-SHAPE" });
    fixtures.push(fx);

    const a = await fx.store.createTask({ id: "FN-5432-SA", title: "Task A", description: "A" } as any);
    const b = await fx.store.createTask({ id: "FN-5432-SB", title: "Task B", description: "B" } as any);
    const c = await fx.store.createTask({ id: "FN-5432-SC", title: "Task C", description: "C" } as any);
    const d = await fx.store.createTask({ id: "FN-5432-SD", title: "Task D", description: "D" } as any);

    await fx.store.listTasks({ slim: true });
    await fx.seedRawTaskColumns(a.id, { dependencies: [b.id] });
    await fx.seedRawTaskColumns(b.id, { dependencies: [c.id] });
    await fx.seedRawTaskColumns(c.id, { dependencies: [d.id] });
    await fx.seedRawTaskColumns(d.id, { dependencies: [a.id] });

    await fx.manager.reconcileDependencyCycles();

    const unrepaired = await fx.store.getRunAuditEventsAsync({ domain: "database", mutationType: "task:dependency-cycle-unrepaired" });
    expect(unrepaired.length).toBeGreaterThan(0);

    for (const event of unrepaired) {
      const cyclePath = event.metadata?.cyclePath as string[];
      expect(Array.isArray(cyclePath)).toBe(true);
      expect(cyclePath.length).toBeGreaterThan(0);
      expect(cyclePath[0]).toBe(cyclePath[cyclePath.length - 1]);
      expect(cyclePath).toContain(event.taskId);
    }
  });
});
