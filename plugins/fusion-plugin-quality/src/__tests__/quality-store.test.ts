import { describe, expect, it } from "vitest";
import { DatabaseSync } from "@fusion/core";
import { ensureQualitySchema } from "../quality-schema.js";
import { QualityStore } from "../store/quality-store.js";

/*
FNXC:QualityPostgres 2026-07-16-09:03:
SQLite QualityStore tests remain for pure domain logic only. Runtime QA never
uses this path — routes bind AsyncQualityStore via getAsyncLayer.
*/

describe("QualityStore (unit / SQLite test harness only)", () => {
  function makeStore() {
    const db = new DatabaseSync(":memory:");
    ensureQualitySchema(db as never);
    return new QualityStore(db as never);
  }

  it("creates and lists runs scoped by project", async () => {
    const store = makeStore();
    await store.createRun({
      projectId: "p1",
      source: "hub",
      command: "pnpm verify:fast",
      cwd: "/repo",
      cwdKind: "project-root",
      timeoutMs: 60_000,
      triggeredBy: "test",
      presetId: "verify-fast",
    });
    await store.createRun({
      projectId: "p2",
      source: "hub",
      command: "pnpm verify:fast",
      cwd: "/other",
      cwdKind: "project-root",
      timeoutMs: 60_000,
      triggeredBy: "test",
    });
    expect(await store.listRuns("p1")).toHaveLength(1);
    expect(await store.listRuns("p2")).toHaveLength(1);
  });

  it("getRun enforces project ownership", async () => {
    const store = makeStore();
    const run = await store.createRun({
      projectId: "p1",
      source: "task-tab",
      taskId: "FN-1",
      command: "pnpm test:gate",
      cwd: "/wt",
      cwdKind: "worktree",
      timeoutMs: 60_000,
      triggeredBy: "test",
    });
    expect((await store.getRun("p1", run.id))?.id).toBe(run.id);
    expect(await store.getRun("p2", run.id)).toBeNull();
  });

  it("prunes finished runs beyond retention", async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      const run = await store.createRun({
        projectId: "p1",
        source: "hub",
        command: `echo ${i}`,
        cwd: "/repo",
        cwdKind: "project-root",
        timeoutMs: 1000,
        triggeredBy: "test",
      });
      await store.updateRun("p1", run.id, {
        status: "passed",
        finishedAt: new Date().toISOString(),
        durationMs: 1,
      });
    }
    await store.pruneRuns("p1", 2);
    expect(await store.listRuns("p1")).toHaveLength(2);
  });

  it("saves and loads suggested cases", async () => {
    const store = makeStore();
    await store.saveSuggestedCases({
      projectId: "p1",
      taskId: "FN-1",
      cases: [{ id: "c1", text: "Check login", done: false, source: "heuristic" }],
      generatedAt: new Date().toISOString(),
      method: "heuristic",
    });
    const snap = await store.getSuggestedCases("p1", "FN-1");
    expect(snap?.cases).toHaveLength(1);
    expect(await store.getSuggestedCases("p2", "FN-1")).toBeNull();
  });
});
