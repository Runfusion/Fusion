import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { TaskStore } from "../store.js";
import { extractSymbolLockIdentity, normalizeSymbolLockKey, symbolLocksConflict } from "../task-store/symbol-locks.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../__test-utils__/pg-test-harness.js";

function storeForProject(harness: SharedPgTaskStoreHarness, projectId: string): TaskStore {
  return new TaskStore(harness.rootDir(), undefined, {
    asyncLayer: { ...harness.layer(), projectId },
  });
}

describe("symbol lock normalization", () => {
  it("normalizes equivalent symbol references deterministically", () => {
    expect(normalizeSymbolLockKey(" Pkg\\File.ts # Exported.member ")).toBe("pkg/file.ts#exported.member");
    expect(extractSymbolLockIdentity("project-a", "pkg/file.ts#Exported.member")).toEqual({ projectId: "project-a", normalizedSymbol: "pkg/file.ts#exported.member", symbolKey: "pkg/file.ts#exported.member" });
    expect(symbolLocksConflict("pkg\\file.ts#Thing", " pkg/file.ts # thing ")).toBe(true);
  });
});

pgDescribe("TaskStore durable symbol locks", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_symbol_lock" });
  beforeAll(h.beforeAll); afterAll(h.afterAll); beforeEach(h.beforeEach); afterEach(h.afterEach);

  it("acquires all symbols atomically and returns the contending owner without partial acquisition", async () => {
    const store = h.store();
    const first = await store.acquireSymbolLocks(["pkg/a.ts#A"], { ownerTaskId: "FN-owner", agentId: "agent-a" }, 60_000);
    expect(first.acquired).toBe(true);
    const second = await store.acquireSymbolLocks(["pkg/a.ts#A", "pkg/b.ts#B"], { ownerTaskId: "FN-other" }, 60_000);
    expect(second).toMatchObject({ acquired: false, locks: [], conflicts: [{ ownerTaskId: "FN-owner", symbolKey: "pkg/a.ts#a" }] });
    expect(await store.inspectSymbolLockConflicts(["pkg/b.ts#B"])).toEqual([]);
  });

  /*
  FNXC:SymbolLock 2026-07-30-15:10:
  Scheduler admission must partition every symbol-lock operation by project.
  Two projects may hold the same canonical key, while inspect, reconciliation,
  and their structured audit records must never make either project contend with
  or expose the other's lock.
  */
  it("isolates acquire, inspect, reconciliation, and audit metadata by project", async () => {
    const projectA = storeForProject(h, "project-a");
    const projectB = storeForProject(h, "project-b");

    expect((await projectA.acquireSymbolLocks(["pkg/shared.ts#Export"], { ownerTaskId: "FN-project-a" }, 60_000)).acquired).toBe(true);
    expect((await projectB.acquireSymbolLocks(["pkg/shared.ts#Export"], { ownerTaskId: "FN-project-b" }, 60_000)).acquired).toBe(true);
    expect(await projectA.inspectSymbolLockConflicts(["pkg/shared.ts#Export"])).toMatchObject([
      { ownerTaskId: "FN-project-a", symbolKey: "pkg/shared.ts#export" },
    ]);
    expect(await projectB.inspectSymbolLockConflicts(["pkg/shared.ts#Export"])).toMatchObject([
      { ownerTaskId: "FN-project-b", symbolKey: "pkg/shared.ts#export" },
    ]);

    // The missing B task makes only B's lock stale; A remains invisible to B's sweep.
    expect((await projectB.reconcileStaleSymbolLocks()).reconciled).toEqual(["pkg/shared.ts#export"]);
    expect(await projectA.inspectSymbolLockConflicts(["pkg/shared.ts#Export"])).toMatchObject([
      { ownerTaskId: "FN-project-a", symbolKey: "pkg/shared.ts#export" },
    ]);

    const audits = await h.adminDb().select({ taskId: schema.project.runAuditEvents.taskId, metadata: schema.project.runAuditEvents.metadata })
      .from(schema.project.runAuditEvents)
      .where(eq(schema.project.runAuditEvents.mutationType, "symbol-lock:acquired"));
    expect(audits).toEqual(expect.arrayContaining([
      { taskId: "FN-project-a", metadata: { count: 1, symbolKeys: ["pkg/shared.ts#export"], outcome: "acquired" } },
      { taskId: "FN-project-b", metadata: { count: 1, symbolKeys: ["pkg/shared.ts#export"], outcome: "acquired" } },
    ]));
  });

  it("renews and releases only the caller's unexpired locks", async () => {
    const store = h.store();
    await store.acquireSymbolLocks(["pkg/a.ts#A"], { ownerTaskId: "FN-owner" }, 60_000);
    expect(await store.renewSymbolLocks(["pkg/a.ts#A"], "FN-other", 60_000)).toEqual({ renewed: [], lost: ["pkg/a.ts#a"] });
    expect((await store.releaseSymbolLocks(["pkg/a.ts#A"], "FN-other")).released).toEqual([]);
    expect((await store.releaseSymbolLocks(["pkg/a.ts#A"], "FN-owner")).released).toEqual(["pkg/a.ts#a"]);
    expect((await store.releaseSymbolLocks(["pkg/a.ts#A"], "FN-owner")).released).toEqual([]);
  });

  it("releases an active task's symbols when it is failed in place", async () => {
    const store = h.store();
    const owner = await store.createTask({ description: "failed symbol lock owner", declaredSymbols: ["pkg/failed.ts#A"] });
    await store.moveTask(owner.id, "todo");
    await store.moveTask(owner.id, "in-progress");
    await store.acquireSymbolLocks(["pkg/failed.ts#A"], { ownerTaskId: owner.id }, 60_000);

    await store.updateTask(owner.id, { status: "failed", error: "terminal execution failure" });

    expect(await store.inspectSymbolLockConflicts(["pkg/failed.ts#A"])).toEqual([]);
  });

  it("allows expired locks to be acquired and reconciles terminal owners", async () => {
    const store = h.store(); const layer = h.layer(); const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    await store.acquireSymbolLocks(["pkg/expired.ts#A"], { ownerTaskId: "FN-dead" }, 60_000);
    await layer.db.update(schema.project.symbolLocks).set({ expiresAt: new Date(Date.now() - 1_000).toISOString() }).where(and(eq(schema.project.symbolLocks.projectId, projectId), eq(schema.project.symbolLocks.symbolKey, "pkg/expired.ts#a")));
    expect((await store.acquireSymbolLocks(["pkg/expired.ts#A"], { ownerTaskId: "FN-new" }, 60_000)).acquired).toBe(true);
    const owner = await store.createTask({ description: "terminal symbol lock owner" });
    await store.acquireSymbolLocks(["pkg/terminal.ts#A"], { ownerTaskId: owner.id }, 60_000);
    await layer.db.update(schema.project.tasks).set({ column: "done" }).where(and(
      eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, owner.id),
    ));
    expect((await store.reconcileStaleSymbolLocks()).reconciled).toContain("pkg/terminal.ts#a");
  });
});
