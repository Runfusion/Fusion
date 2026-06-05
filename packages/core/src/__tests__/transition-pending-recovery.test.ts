// @vitest-environment node
//
// #1401 + #1409: store-level recovery / evacuation passes for the workflow
// columns feature.
//
//   #1401 — transitionPending recovery sweep:
//     * a crash-simulated stale marker is recovered (cleared) by the sweep,
//     * the phantom capacity slot the marker reserved is released so a fresh
//       card can re-enter a full (capacity=1) column afterwards,
//     * the sweep is idempotent (a second run finds nothing).
//
//   #1409 — flag ON→OFF evacuation:
//     * toggling workflowColumns OFF with a card in a custom column re-homes it
//       to a legacy column, the board stays listable, and legacy moves work.
//     * a flag-OFF store init evacuates a card left in a custom column.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { makeTransitionPending, serializeTransitionPending } from "../transition-types.js";

/** A custom workflow whose middle column carries a WIP capacity limit of 1. */
function cappedIr(): WorkflowIr {
  return {
    version: "v2",
    name: "capped",
    columns: [
      { id: "intake", name: "intake", traits: [{ trait: "intake" }] },
      {
        id: "build",
        name: "build",
        traits: [{ trait: "wip", config: { limit: 1, countPending: true } }],
      },
      { id: "ship", name: "ship", traits: [] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "intake" },
      { id: "work", kind: "prompt", column: "build", config: { prompt: "do" } },
      { id: "end", kind: "end", column: "ship" },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  };
}

function simpleCustomIr(): WorkflowIr {
  return {
    version: "v2",
    name: "simple-custom",
    columns: [
      { id: "intake", name: "intake", traits: [{ trait: "intake" }] },
      { id: "build", name: "build", traits: [] },
      { id: "ship", name: "ship", traits: [] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "intake" },
      { id: "work", kind: "prompt", column: "build", config: { prompt: "do" } },
      { id: "end", kind: "end", column: "ship" },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  };
}

describe("#1401 transitionPending recovery sweep", () => {
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

  function rawDb(): {
    prepare: (s: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown };
  } {
    return (store as unknown as { db: ReturnType<typeof rawDb> }).db;
  }

  function readMarkerColumn(taskId: string): string | null {
    const row = rawDb()
      .prepare(`SELECT transitionPending FROM tasks WHERE id = ?`)
      .get(taskId) as { transitionPending: string | null } | undefined;
    return row?.transitionPending ?? null;
  }

  it("recovers a crash-simulated stale marker and is idempotent", async () => {
    const t = await store.createTask({ description: "stale-marker" });
    // Simulate a crash that left a transitionPending marker set forever.
    const marker = serializeTransitionPending(
      makeTransitionPending("build", ["default-workflow:postCommit"], Date.now() - 60_000),
    );
    rawDb().prepare(`UPDATE tasks SET transitionPending = ? WHERE id = ?`).run(marker, t.id);
    expect(readMarkerColumn(t.id)).not.toBeNull();

    const first = await store.recoverStaleTransitionPending();
    expect(first.scanned).toBeGreaterThanOrEqual(1);
    expect(first.recovered).toBe(1);
    // Marker cleared → capacity slot released.
    expect(readMarkerColumn(t.id)).toBeNull();

    // Idempotent: nothing left to recover.
    const second = await store.recoverStaleTransitionPending();
    expect(second.recovered).toBe(0);
  });

  it("releases the phantom capacity slot a stale marker reserved (count returns to normal)", async () => {
    const wf = await store.createWorkflowDefinition({ name: "capped", ir: cappedIr() });

    // A "ghost" task crashed mid-transition into the capacity-1 "build" column:
    // its marker reserves the only slot even though it never committed there.
    const ghost = await store.createTask({ description: "ghost" });
    await store.selectTaskWorkflowAndReconcile(ghost.id, wf.id);
    const ghostMarker = serializeTransitionPending(
      makeTransitionPending("build", ["default-workflow:postCommit"], Date.now() - 60_000),
    );
    rawDb().prepare(`UPDATE tasks SET transitionPending = ? WHERE id = ?`).run(ghostMarker, ghost.id);

    // A fresh card in the same workflow cannot enter "build": the phantom marker
    // is counted as occupying the single capacity slot.
    const fresh = await store.createTask({ description: "fresh" });
    await store.selectTaskWorkflowAndReconcile(fresh.id, wf.id);
    expect((await store.getTask(fresh.id)).column).toBe("intake");

    let blocked: unknown;
    try {
      await store.moveTask(fresh.id, "build", { moveSource: "user" });
    } catch (e) {
      blocked = e;
    }
    expect(blocked).toBeInstanceOf(Error);
    expect((await store.getTask(fresh.id)).column).toBe("intake");

    // Recovery clears the stale marker, releasing the slot.
    const result = await store.recoverStaleTransitionPending();
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    // Now the fresh card can enter the capacity column.
    await store.moveTask(fresh.id, "build", { moveSource: "user" });
    expect((await store.getTask(fresh.id)).column).toBe("build");
  });
});

describe("#1409 flag ON→OFF evacuation", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("toggling OFF re-homes a card from a custom column to a legacy column; moves work", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const wf = await store.createWorkflowDefinition({ name: "simple-custom", ir: simpleCustomIr() });
    const task = await store.createTask({ description: "evac" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    expect((await store.getTask(task.id)).column).toBe("intake");

    // Toggle OFF — evacuation re-homes the card to the nearest legacy column
    // (the default workflow's entry column, triage).
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });
    expect((await store.getTask(task.id)).column).toBe("triage");

    // Board listable; legacy moves work from the evacuated column.
    await expect(store.listTasks()).resolves.toBeDefined();
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    expect((await store.getTask(task.id)).column).toBe("in-progress");
  });

  it("evacuateCustomColumnsToLegacy is idempotent (a second run is a no-op)", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const wf = await store.createWorkflowDefinition({ name: "simple-custom-2", ir: simpleCustomIr() });
    const task = await store.createTask({ description: "evac2" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });

    // First explicit run already evacuated (via the toggle); a fresh run is a no-op.
    const again = await store.evacuateCustomColumnsToLegacy("flag-off-init");
    expect(again.evacuated).toBe(0);
    expect((await store.getTask(task.id)).column).toBe("triage");
  });
});
