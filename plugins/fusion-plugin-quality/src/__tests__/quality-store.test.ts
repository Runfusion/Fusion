import { describe, expect, it } from "vitest";
import { DatabaseSync } from "@fusion/core";
import { ensureQualitySchema } from "../quality-schema.js";
import { QualityStore } from "../store/quality-store.js";

describe("QualityStore", () => {
  function makeStore() {
    const db = new DatabaseSync(":memory:");
    ensureQualitySchema(db as never);
    return new QualityStore(db as never);
  }

  it("creates and lists runs scoped by project", () => {
    const store = makeStore();
    store.createRun({
      projectId: "p1",
      source: "hub",
      command: "pnpm verify:fast",
      cwd: "/repo",
      cwdKind: "project-root",
      timeoutMs: 60_000,
      triggeredBy: "test",
      presetId: "verify-fast",
    });
    store.createRun({
      projectId: "p2",
      source: "hub",
      command: "pnpm verify:fast",
      cwd: "/other",
      cwdKind: "project-root",
      timeoutMs: 60_000,
      triggeredBy: "test",
    });
    expect(store.listRuns("p1")).toHaveLength(1);
    expect(store.listRuns("p2")).toHaveLength(1);
  });

  it("getRun enforces project ownership", () => {
    const store = makeStore();
    const run = store.createRun({
      projectId: "p1",
      source: "task-tab",
      taskId: "FN-1",
      command: "pnpm test:gate",
      cwd: "/wt",
      cwdKind: "worktree",
      timeoutMs: 60_000,
      triggeredBy: "test",
    });
    expect(store.getRun("p1", run.id)?.id).toBe(run.id);
    expect(store.getRun("p2", run.id)).toBeNull();
  });

  it("prunes finished runs beyond retention", () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      const run = store.createRun({
        projectId: "p1",
        source: "hub",
        command: `echo ${i}`,
        cwd: "/repo",
        cwdKind: "project-root",
        timeoutMs: 1000,
        triggeredBy: "test",
      });
      store.updateRun("p1", run.id, {
        status: "passed",
        finishedAt: new Date().toISOString(),
        durationMs: 1,
      });
    }
    store.pruneRuns("p1", 2);
    expect(store.listRuns("p1")).toHaveLength(2);
  });

  it("saves and loads suggested cases", () => {
    const store = makeStore();
    store.saveSuggestedCases({
      projectId: "p1",
      taskId: "FN-1",
      cases: [{ id: "c1", text: "Check login", done: false, source: "heuristic" }],
      generatedAt: new Date().toISOString(),
      method: "heuristic",
    });
    const snap = store.getSuggestedCases("p1", "FN-1");
    expect(snap?.cases).toHaveLength(1);
    expect(store.getSuggestedCases("p2", "FN-1")).toBeNull();
  });
});
