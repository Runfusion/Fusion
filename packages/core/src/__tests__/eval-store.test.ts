import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db.js";
import { EvalLifecycleError, EvalStore } from "../eval-store.js";

let db: Database;
let store: EvalStore;

beforeEach(() => {
  db = createDatabase("/tmp/fn-eval-store-test", { inMemory: true });
  db.init();
  store = new EvalStore(db);
});

describe("EvalStore", () => {
  it("creates and lists runs with deterministic ordering", () => {
    const runA = store.createRun({ projectId: "p1", scope: "completed-since-last", requestedTaskIds: ["FN-1"] });
    const runB = store.createRun({ projectId: "p1", scope: "completed-since-last", requestedTaskIds: ["FN-2"] });

    const runs = store.listRuns({ projectId: "p1" });
    const expectedOrder = [runA, runB]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((run) => run.id);
    expect(runs.map((run) => run.id)).toEqual(expectedOrder);
  });

  it("enforces active run conflict for scheduled trigger", () => {
    store.createRun({ projectId: "p1", scope: "window", trigger: "schedule" });
    expect(() => store.createRun({ projectId: "p1", scope: "window", trigger: "schedule" })).toThrow(EvalLifecycleError);
  });

  it("enforces terminal immutability", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    store.updateRun(run.id, { status: "completed" });
    expect(() => store.updateRun(run.id, { summary: "late change" })).toThrow(EvalLifecycleError);
  });

  it("creates results and preserves task snapshot after tasks row deletion", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    const result = store.createTaskResult(run.id, {
      taskId: "FN-123",
      taskSnapshot: { taskId: "FN-123", title: "Snapshot title", status: "done", summary: "task summary" },
      status: "scored",
      overallScore: 80,
      categoryScores: [{
        category: "agentPerformance",
        deterministicScore: 78,
        aiScore: 82,
        finalScore: 79,
        weight: 0.3,
        band: "strong",
        rationale: "handled execution well",
        evidence: [{ type: "task_log", ref: "log:1" }],
      }, {
        category: "taskOutcomeQuality",
        deterministicScore: 80,
        aiScore: 80,
        finalScore: 80,
        weight: 0.45,
        band: "strong",
        rationale: "good",
        evidence: [{ type: "test", ref: "test:all" }],
      }, {
        category: "processCompliance",
        deterministicScore: 72,
        aiScore: 76,
        finalScore: 73,
        weight: 0.25,
        band: "acceptable",
        rationale: "mostly compliant",
        evidence: [{ type: "other", ref: "workflow:review" }],
      }],
      evidence: [{ type: "task_log", ref: "log:1" }],
      deterministicSignals: [{ signalId: "s1", kind: "test", name: "tests-pass", passed: true }],
    });

    db.prepare("DELETE FROM tasks WHERE id = ?").run("FN-123");

    const fetched = store.getTaskResult(result.id);
    expect(fetched?.taskSnapshot.title).toBe("Snapshot title");
    expect(fetched?.taskId).toBe("FN-123");
    expect(fetched?.categoryScores).toHaveLength(3);
    expect(fetched?.categoryScores[0]?.category).toBe("agentPerformance");
    expect(fetched?.categoryScores[0]?.deterministicScore).toBe(78);
    expect(fetched?.categoryScores[1]?.weight).toBe(0.45);
    expect(fetched?.categoryScores[2]?.band).toBe("acceptable");
  });

  it("persists run window boundaries and evaluated task rollups", () => {
    const run = store.createRun({
      projectId: "p1",
      trigger: "schedule",
      scope: "completed-since-last",
      window: { since: "2026-05-01T00:00:00.000Z", until: "2026-05-02T00:00:00.000Z", baselineRunId: "ER-BASE" },
      requestedTaskIds: ["FN-1", "FN-2"],
    });

    const updated = store.updateRun(run.id, {
      status: "running",
      evaluatedTaskIds: ["FN-1", "FN-2"],
      counts: { totalTasks: 2, scoredTasks: 1, skippedTasks: 1, erroredTasks: 0 },
    });

    expect(updated?.window.since).toBe("2026-05-01T00:00:00.000Z");
    expect(updated?.evaluatedTaskIds).toEqual(["FN-1", "FN-2"]);
    expect(updated?.counts.scoredTasks).toBe(1);
  });

  it("deduplicates per runId/taskId via upsert semantics", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    const first = store.createTaskResult(run.id, {
      taskId: "FN-dup",
      taskSnapshot: { taskId: "FN-dup", title: "A" },
      status: "scored",
      overallScore: 20,
    });
    const second = store.createTaskResult(run.id, {
      taskId: "FN-dup",
      taskSnapshot: { taskId: "FN-dup", title: "B" },
      status: "scored",
      overallScore: 90,
    });

    const rows = store.listTaskResults({ runId: run.id, taskId: "FN-dup" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.overallScore).toBe(90);
    expect(rows[0]?.taskSnapshot.title).toBe("B");
    expect(second.id).toBe(first.id);
  });

  it("appends run events with sequential ordering", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    const evt1 = store.appendRunEvent(run.id, { type: "info", message: "started" });
    const evt2 = store.appendRunEvent(run.id, { type: "task_evaluated", message: "scored", taskId: "FN-1" });

    const events = store.listRunEvents(run.id);
    expect(events.map((event) => event.id)).toEqual([evt1.id, evt2.id]);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });
});
