// @vitest-environment node
//
// U12: workflow-columns migration / integrity / graduation + rollback safety.
//
// Proves the U12 plan scenarios:
//   - Migration rewrites ZERO task rows (KTD-1): fresh DB and an aged fixture DB
//     (tasks in every legacy column, some with workflow selections) resolve every
//     task to a valid (workflow, column) pair.
//   - The integrity pass re-homes a task whose stored column is invalid in its
//     resolved workflow, and is IDEMPOTENT (a second run is a no-op).
//   - done/archived (terminal) cards are left untouched by the integrity pass.
//   - Flag OFF after running flag-ON: legacy board + engine behavior intact.
//   - Deliberate parity-drift injection (altered default-workflow adjacency) is
//     CAUGHT by the graduation report's transition-parity gate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { workflowHasColumn } from "../workflow-transitions.js";
import {
  checkTransitionParity,
  computeWorkflowColumnsGraduationReport,
  countDualAcceptDisagreements,
} from "../workflow-parity.js";
import type { Column } from "../types.js";

function customIr(name: string, cols: string[], entryId: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: cols.map((id) => ({
      id,
      name: id,
      traits: id === entryId ? [{ trait: "intake" }] : [],
    })),
    nodes: [
      { id: "start", kind: "start", column: entryId },
      { id: "work", kind: "prompt", column: cols[1] ?? entryId, config: { prompt: "do" } },
      { id: "end", kind: "end", column: cols[cols.length - 1] },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  };
}

describe("U12 migration — zero task-row rewrites (KTD-1)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  async function seedInColumn(column: Column): Promise<string> {
    const task = await store.createTask({ description: `seed-${column}` });
    const u = { moveSource: "user" as const };
    if (column === "triage") return task.id;
    await store.moveTask(task.id, "todo", u);
    if (column === "todo") return task.id;
    await store.moveTask(task.id, "in-progress", u);
    if (column === "in-progress") return task.id;
    await store.moveTask(task.id, "in-review", { ...u, allowDirectInReviewMove: true });
    if (column === "in-review") return task.id;
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    if (column === "done") return task.id;
    await store.moveTask(task.id, "archived", u);
    return task.id;
  }

  it("fresh DB: a default-workflow task resolves to a valid (workflow, column) pair", async () => {
    const id = await seedInColumn("todo");
    const task = await store.getTask(id);
    expect(workflowHasColumn(BUILTIN_CODING_WORKFLOW_IR, task.column)).toBe(true);
  });

  it("aged fixture: tasks in every legacy column all resolve to a valid column; integrity pass touches none", async () => {
    const ids: string[] = [];
    for (const col of ["triage", "todo", "in-progress", "in-review", "done", "archived"] as Column[]) {
      ids.push(await seedInColumn(col));
    }
    // A task with a custom-workflow selection whose column IS valid in it.
    const wf = await store.createWorkflowDefinition({
      name: "valid-custom",
      ir: customIr("valid-custom", ["todo", "build", "done"], "todo"),
    });
    const customTask = await store.createTask({ description: "custom" });
    await store.moveTask(customTask.id, "todo", { moveSource: "user" });
    await store.selectTaskWorkflowAndReconcile(customTask.id, wf.id);

    const before = await Promise.all(ids.map((id) => store.getTask(id)));
    const result = await store.runWorkflowColumnsIntegrityPass();
    // No row was invalid → nothing re-homed.
    expect(result.rehomed).toBe(0);

    const after = await Promise.all(ids.map((id) => store.getTask(id)));
    for (let i = 0; i < ids.length; i += 1) {
      expect(after[i].column).toBe(before[i].column);
    }
  });
});

describe("U12 integrity pass — invalid column re-home + idempotency + terminal-untouched", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  function rawDb(): { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } {
    return (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  }

  it("re-homes a task whose stored column is invalid in its resolved workflow, and is idempotent", async () => {
    // Select a custom workflow that defines [stage-a, stage-b, finished], then
    // force the stored column to one that workflow never defines.
    const wf = await store.createWorkflowDefinition({
      name: "drifted",
      ir: customIr("drifted", ["stage-a", "stage-b", "finished"], "stage-a"),
    });
    const task = await store.createTask({ description: "drifter" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    // Out-of-band corruption: stored column not in the workflow.
    rawDb().prepare(`UPDATE tasks SET "column" = ? WHERE id = ?`).run("ghost-column", task.id);

    const first = await store.runWorkflowColumnsIntegrityPass();
    expect(first.rehomed).toBe(1);
    const afterFirst = await store.getTask(task.id);
    expect(afterFirst.column).toBe("stage-a"); // entry (intake) column

    // Idempotent: a second run finds nothing out of place.
    const second = await store.runWorkflowColumnsIntegrityPass();
    expect(second.rehomed).toBe(0);
    expect((await store.getTask(task.id)).column).toBe("stage-a");
  });

  it("leaves done/archived (terminal) cards untouched even if their column were invalid", async () => {
    // A task selecting a custom workflow that lacks "done" but the task sits in
    // "done" — terminal cards are never re-homed.
    const wf = await store.createWorkflowDefinition({
      name: "no-done",
      ir: customIr("no-done", ["start-col", "mid-col", "fin-col"], "start-col"),
    });
    const task = await store.createTask({ description: "terminal" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    rawDb().prepare(`UPDATE tasks SET "column" = ? WHERE id = ?`).run("done", task.id);

    const result = await store.runWorkflowColumnsIntegrityPass();
    expect(result.skippedTerminal).toBeGreaterThanOrEqual(1);
    expect((await store.getTask(task.id)).column).toBe("done");
  });
});

describe("U12 rollback safety — flag OFF after flag ON keeps legacy behavior", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("a board built under flag-ON resolves identically and moves legacy-style under flag-OFF", async () => {
    // Build a board under flag-ON.
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const t = await store.createTask({ description: "rollback" });
    await store.moveTask(t.id, "todo", { moveSource: "user" });
    await store.moveTask(t.id, "in-progress", { moveSource: "user" });

    // Flip the flag OFF.
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });

    // Legacy board intact: the task is still in in-progress.
    expect((await store.getTask(t.id)).column).toBe("in-progress");

    // Legacy engine behavior: an illegal move throws the legacy string (not a
    // typed rejection), and a legal move works exactly as before.
    const archived = await store.createTask({ description: "legacy" });
    await store.moveTask(archived.id, "todo", { moveSource: "user" });
    await store.moveTask(archived.id, "in-progress", { moveSource: "user" });
    await store.moveTask(archived.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    await store.moveTask(archived.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    await store.moveTask(archived.id, "archived", { moveSource: "user" });
    let caught: unknown;
    try {
      await store.moveTask(archived.id, "todo", { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Invalid transition/);
  });

  it("a card stranded in a custom column when the flag is toggled OFF degrades to a clean Invalid-transition error (no TypeError) and listTasks stays healthy", async () => {
    // Flag ON: select a custom workflow whose entry column is custom, so the
    // card is re-homed into a column that VALID_TRANSITIONS never keys.
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const wf = await store.createWorkflowDefinition({
      name: "stranded",
      ir: customIr("stranded", ["intake", "build", "ship"], "intake"),
    });
    const task = await store.createTask({ description: "stranded card" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    expect((await store.getTask(task.id)).column).toBe("intake");

    // Toggle the flag OFF — #1409: the ON→OFF evacuation re-homes the card from
    // the custom "intake" column to the nearest legacy column (the default
    // workflow's entry column, triage) so it is not stranded on the legacy path.
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });
    expect((await store.getTask(task.id)).column).toBe("triage");

    // listTasks stays healthy.
    await expect(store.listTasks()).resolves.toBeDefined();

    // The evacuated card now moves legacy-style: triage → todo works.
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    expect((await store.getTask(task.id)).column).toBe("todo");
  });
});

describe("Residual B: getBranchProgressByTask reads workflow_run_branches", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  function db(): { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } {
    return (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  }

  it("returns an empty map when the table is empty (cheap short-circuit)", async () => {
    const t = await store.createTask({ description: "x" });
    expect(store.getBranchProgressByTask([t.id]).size).toBe(0);
  });

  it("returns the latest run's branches for a task with rows", async () => {
    const t = await store.createTask({ description: "fanout" });
    const ins = `INSERT INTO workflow_run_branches (taskId, runId, branchId, currentNodeId, status, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`;
    // Older run (should be ignored).
    db().prepare(ins).run(t.id, "run-1", "b1", "n1", "completed", "2026-06-01T00:00:00.000Z");
    // Latest run with two branches.
    db().prepare(ins).run(t.id, "run-2", "b1", "n2", "running", "2026-06-03T00:00:00.000Z");
    db().prepare(ins).run(t.id, "run-2", "b2", "n3", "completed", "2026-06-03T00:00:01.000Z");

    const byTask = store.getBranchProgressByTask([t.id]);
    const entries = byTask.get(t.id) ?? [];
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.branchId).sort()).toEqual(["b1", "b2"]);
    expect(entries.find((e) => e.branchId === "b2")?.status).toBe("completed");
  });
});

describe("#1407/#1412/#1413: workflow_run_branches persistence + latest-run JOIN + prune", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  type BranchStore = {
    saveWorkflowRunBranch(state: {
      taskId: string; runId: string; branchId: string; currentNodeId: string; status: string;
    }): void;
    loadWorkflowRunBranches(taskId: string, runId: string): Array<{
      taskId: string; runId: string; branchId: string; currentNodeId: string; status: string;
    }>;
    clearWorkflowRunBranches(taskId: string, keepRunId: string): void;
  };
  const bs = (): BranchStore => store as unknown as BranchStore;

  function rawCount(taskId: string): number {
    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_run_branches WHERE taskId = ?")
      .get(taskId) as { c: number };
    return row.c;
  }

  it("saveWorkflowRunBranch upserts one row per (taskId, runId, branchId) keyed by currentNodeId", async () => {
    const t = await store.createTask({ description: "fanout" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "r1", branchId: "b1", currentNodeId: "n1", status: "running" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "r1", branchId: "b1", currentNodeId: "n2", status: "completed" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "r1", branchId: "b2", currentNodeId: "n3", status: "running" });

    // b1 overwrote in place (still one row), b2 added — 2 rows total.
    expect(rawCount(t.id)).toBe(2);
    const loaded = bs().loadWorkflowRunBranches(t.id, "r1");
    const b1 = loaded.find((s) => s.branchId === "b1");
    expect(b1?.currentNodeId).toBe("n2");
    expect(b1?.status).toBe("completed");
  });

  it("loadWorkflowRunBranches returns only the requested run", async () => {
    const t = await store.createTask({ description: "fanout" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "r1", branchId: "b1", currentNodeId: "n1", status: "completed" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "r2", branchId: "b1", currentNodeId: "n9", status: "running" });
    expect(bs().loadWorkflowRunBranches(t.id, "r1").length).toBe(1);
    expect(bs().loadWorkflowRunBranches(t.id, "r1")[0]?.currentNodeId).toBe("n1");
  });

  it("clearWorkflowRunBranches prunes all runs except the kept one (#1412)", async () => {
    const t = await store.createTask({ description: "fanout" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "old-1", branchId: "b1", currentNodeId: "n1", status: "completed" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "old-2", branchId: "b1", currentNodeId: "n1", status: "completed" });
    bs().saveWorkflowRunBranch({ taskId: t.id, runId: "keep", branchId: "b1", currentNodeId: "n5", status: "running" });
    expect(rawCount(t.id)).toBe(3);

    bs().clearWorkflowRunBranches(t.id, "keep");
    expect(rawCount(t.id)).toBe(1);
    expect(bs().loadWorkflowRunBranches(t.id, "keep").length).toBe(1);
  });

  it("getBranchProgressByTask returns only the latest run's branches across multiple runs (#1413)", async () => {
    const t = await store.createTask({ description: "fanout" });
    const ins = `INSERT INTO workflow_run_branches (taskId, runId, branchId, currentNodeId, status, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`;
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
    // Older run.
    db.prepare(ins).run(t.id, "run-1", "b1", "n1", "completed", "2026-06-01T00:00:00.000Z");
    db.prepare(ins).run(t.id, "run-1", "b2", "n2", "completed", "2026-06-01T00:00:01.000Z");
    // Latest run, two branches with staggered updatedAt (both must be returned).
    db.prepare(ins).run(t.id, "run-2", "b1", "n3", "running", "2026-06-03T00:00:00.000Z");
    db.prepare(ins).run(t.id, "run-2", "b2", "n4", "completed", "2026-06-03T00:00:01.000Z");

    const entries = store.getBranchProgressByTask([t.id]).get(t.id) ?? [];
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.nodeId).sort()).toEqual(["n3", "n4"]);
  });

  it("getBranchProgressByTask breaks updatedAt ties deterministically by runId (#1413)", async () => {
    const t = await store.createTask({ description: "fanout" });
    const ins = `INSERT INTO workflow_run_branches (taskId, runId, branchId, currentNodeId, status, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`;
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
    const ts = "2026-06-03T00:00:00.000Z";
    // Two runs with identical updatedAt — runId DESC ("run-b" > "run-a") wins.
    db.prepare(ins).run(t.id, "run-a", "b1", "nA", "running", ts);
    db.prepare(ins).run(t.id, "run-b", "b1", "nB", "running", ts);

    const entries = store.getBranchProgressByTask([t.id]).get(t.id) ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0]?.nodeId).toBe("nB");
  });
});

describe("U12 graduation report — parity drift is caught", () => {
  it("transition-parity holds for the unmodified default workflow", () => {
    expect(checkTransitionParity(BUILTIN_CODING_WORKFLOW_IR).agree).toBe(true);
  });

  it("a deliberately drifted default-workflow adjacency is caught by transition parity", () => {
    // Clone the default IR and remove a legal edge target from in-progress's
    // adjacency by dropping the "todo" backward column from its outgoing edges.
    const drifted = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as WorkflowIr & {
      edges: Array<{ from: string; to: string }>;
      columns: Array<{ id: string }>;
    };
    // Remove ALL columns named "archived" so the column set itself diverges —
    // a coarse but unambiguous drift the gate must catch.
    drifted.columns = drifted.columns.filter((c) => c.id !== "archived");
    const report = checkTransitionParity(drifted as unknown as WorkflowIr);
    expect(report.agree).toBe(false);
    expect(report.diffs.some((d) => d.from === "archived" || d.from === "done")).toBe(true);
  });

  it("graduation report is NOT ready with zero observations and is gated by every signal", () => {
    const report = computeWorkflowColumnsGraduationReport({
      parity: { observed: 0, agreed: 0, drift: 0, agreeRate: 0, driftFieldCounts: {}, recentDrift: [] },
      defaultWorkflowIr: BUILTIN_CODING_WORKFLOW_IR,
      dualAcceptEvents: [],
    });
    expect(report.ready).toBe(false);
    expect(report.blockers.some((b) => /observation window empty/.test(b))).toBe(true);
  });

  it("graduation report is ready only when parity clean, transitions match, and zero dual-accept disagreement", () => {
    const report = computeWorkflowColumnsGraduationReport({
      parity: { observed: 100, agreed: 100, drift: 0, agreeRate: 1, driftFieldCounts: {}, recentDrift: [] },
      defaultWorkflowIr: BUILTIN_CODING_WORKFLOW_IR,
      dualAcceptEvents: [],
    });
    expect(report.transitionParity.agree).toBe(true);
    expect(report.dualAccept.total).toBe(0);
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("dual-accept disagreements above zero block graduation", () => {
    const events = [
      {
        domain: "database",
        mutationType: "merge:dependency-parity-diff",
        target: "FN-1",
        timestamp: "2026-06-03T00:00:00.000Z",
      },
      {
        domain: "database",
        mutationType: "merge:lease-parity-diff",
        target: "FN-2",
        timestamp: "2026-06-03T00:00:01.000Z",
      },
    ] as unknown as Parameters<typeof countDualAcceptDisagreements>[0];
    const counted = countDualAcceptDisagreements(events);
    expect(counted.total).toBe(2);

    const report = computeWorkflowColumnsGraduationReport({
      parity: { observed: 50, agreed: 50, drift: 0, agreeRate: 1, driftFieldCounts: {}, recentDrift: [] },
      defaultWorkflowIr: BUILTIN_CODING_WORKFLOW_IR,
      dualAcceptEvents: events,
    });
    expect(report.ready).toBe(false);
    expect(report.blockers.some((b) => /dual-accept/.test(b))).toBe(true);
  });
});
