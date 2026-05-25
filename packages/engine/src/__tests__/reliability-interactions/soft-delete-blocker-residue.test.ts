import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SETTINGS, TaskStore, type Task } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../../scheduler.js";
import { SelfHealingManager } from "../../self-healing.js";

type Fixture = { rootDir: string; store: TaskStore; scheduler: Scheduler; selfHealing: SelfHealingManager };

async function createFixture(autoMerge = true): Promise<Fixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-fn5566-"));
  await mkdir(join(rootDir, ".fusion"), { recursive: true });
  await writeFile(join(rootDir, "README.md"), "# test\n", "utf8");
  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  await store.updateSettings({ ...DEFAULT_SETTINGS, autoMerge } as any);
  const scheduler = new Scheduler(store as any);
  const selfHealing = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
  return { rootDir, store, scheduler, selfHealing };
}

async function createTask(store: TaskStore, input: Partial<Task>): Promise<Task> {
  return store.createTask({ title: "task", description: "task", prompt: "## File Scope\n- packages/engine/src/**\n", steps: [], ...input } as any);
}

describe("reliability interactions: FN-5566 / FN-5446 soft-delete blocker residue", () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => {
    while (fixtures.length) {
      const fx = fixtures.pop()!;
      fx.scheduler.stop();
      fx.selfHealing.stop();
      fx.store.close();
      await rm(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("covers direct-delete blocker residue and blockedBy-only paths", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const blocker = await createTask(fx.store, { column: "todo" });
    const other = await createTask(fx.store, { column: "todo" });
    const depA = await createTask(fx.store, { column: "todo", status: "blocked", dependencies: [blocker.id], blockedBy: blocker.id });
    const depB = await createTask(fx.store, { column: "todo", status: "blocked", dependencies: [other.id], blockedBy: blocker.id });

    await fx.store.deleteTask(blocker.id, { removeDependencyReferences: true });

    const depAAfter = await fx.store.getTask(depA.id);
    const depBAfter = await fx.store.getTask(depB.id);
    expect(depAAfter.blockedBy ?? null).toBeNull();
    expect(depAAfter.status ?? null).toBeNull();
    expect(depAAfter.dependencies).not.toContain(blocker.id);
    expect(depBAfter.blockedBy ?? null).toBeNull();
    expect(depBAfter.status ?? null).toBeNull();
    expect(depBAfter.dependencies).toEqual([other.id]);
  });

  it("event-driven reconciliation reblocks dependents to next unresolved dependency", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const blocker = await createTask(fx.store, { column: "in-progress" });
    const other = await createTask(fx.store, { column: "todo" });
    const dep = await createTask(fx.store, { column: "todo", status: "blocked", blockedBy: blocker.id, dependencies: [other.id, blocker.id] });

    const now = new Date().toISOString();
    const db = fx.store.getDatabase();
    db.prepare("UPDATE tasks SET deletedAt = ?, \"column\" = 'archived', updatedAt = ? WHERE id = ?").run(now, now, blocker.id);
    fx.store.emit("task:deleted", await fx.store.getTask(blocker.id, { includeDeleted: true }));

    await vi.waitFor(async () => {
      const depAfter = await fx.store.getTask(dep.id);
      expect(depAfter.blockedBy).toBe(other.id);
      expect(depAfter.status).toBe("queued");
    });
  });

  it("reconciles soft-delete column drift with audit and preserves FN-5208 invariants", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const drift = await createTask(fx.store, { column: "in-review" });
    await fx.store.deleteTask(drift.id);
    const db = fx.store.getDatabase();
    db.prepare("UPDATE tasks SET \"column\" = 'in-review' WHERE id = ?").run(drift.id);

    const first = await fx.selfHealing.reconcileSoftDeletedColumnDrift();
    const second = await fx.selfHealing.reconcileSoftDeletedColumnDrift();
    const row = db.prepare("SELECT deletedAt, \"column\" as column, allowResurrection FROM tasks WHERE id = ?").get(drift.id) as any;

    expect(first.reconciled).toBe(1);
    expect(second.reconciled).toBe(0);
    expect(row.column).toBe("archived");
    expect(row.deletedAt).toBeTruthy();
    expect(row.allowResurrection).toBe(0);
    const auditEvents = (fx.store as any).getRunAuditEvents({ mutationType: "task:soft-delete-column-reconciled", limit: 10 }) as any[];
    expect(auditEvents).toHaveLength(1);
  });

  it("clearStaleBlockedBy handles missed task:deleted event with soft-deleted-blocker reason", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const blocker = await createTask(fx.store, { column: "todo" });
    const dep = await createTask(fx.store, { column: "todo", status: "blocked", blockedBy: blocker.id, dependencies: [] });

    await fx.store.deleteTask(blocker.id, { removeDependencyReferences: true });
    await fx.store.updateTask(dep.id, { blockedBy: blocker.id, status: "blocked" as any });

    await fx.selfHealing.clearStaleBlockedBy();
    const depAfter = await fx.store.getTask(dep.id);
    expect(depAfter.blockedBy ?? null).toBeNull();
    expect(depAfter.log.some((entry) => entry.action.includes("soft-deleted at"))).toBe(true);
  });

  it("FN-5147 composition: live in-review tasks remain untouched when autoMerge=false", async () => {
    const fx = await createFixture(false);
    fixtures.push(fx);
    const live = await createTask(fx.store, { column: "in-review", status: "failed" });

    const result = await fx.selfHealing.reconcileSoftDeletedColumnDrift();
    const liveAfter = await fx.store.getTask(live.id);
    expect(result.reconciled).toBe(0);
    expect(liveAfter.column).toBe("in-review");
  });
});
