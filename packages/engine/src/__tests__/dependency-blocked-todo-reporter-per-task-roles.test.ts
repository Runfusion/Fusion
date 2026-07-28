/*
FNXC:WorkflowLifecycleColumns 2026-07-28-17:40 (PR #2479 review, P1):

BOARD-WIDE ROLE UNIONS MISCLASSIFY TASKS.

The previous fix resolved lifecycle roles across every workflow on the board and
UNIONED them into one `holdColumns` / `terminalColumns` pair. That is wrong the
moment two workflows reuse a column ID for DIFFERENT roles — and it is wrong for
the reason this whole program exists: **a column id only means something relative
to its own workflow.** A board-wide union quietly re-assumes ids are globally
meaningful, which is the precise assumption being removed.

The concrete break, and the fixture below: workflow A calls its HOLD column
`done`; workflow B calls its TERMINAL column `done`. Under a union,
`holdColumns` and `terminalColumns` BOTH contain `done`, so every card in a
column named `done` is simultaneously "held" and "terminal" regardless of which
workflow it belongs to. Dependents get counted as blocked while the blocker
sitting beside them is discarded as finished — from one ambiguous id.

The fix is per-task classification: each task is classified against ITS OWN
workflow, which makes the misclassification impossible by construction rather
than detected after the fact. It also removes the repeated workflow-definition
reads (the sibling P2), because one shared IR cache serves the whole pass.

These tests were written FIRST and observed FAILING against the union.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { DependencyBlockedTodoReporter } from "../dependency-blocked-todo-reporter.js";

const NOW = Date.parse("2026-05-18T12:00:00.000Z");
/** Old enough to bucket "stale", so significance gating never masks a miss. */
const MOVED_AT = new Date(NOW - 5 * 60 * 60_000).toISOString();

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "test",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    blockedBy: "",
    overlapBlockedBy: "",
    log: [],
    createdAt: MOVED_AT,
    updatedAt: MOVED_AT,
    columnMovedAt: MOVED_AT,
    ...over,
  } as Task;
}

/**
 * `done` is the HOLD column here — a workflow that finished naming its columns
 * differently. Nothing about this is exotic; ids are workflow-local by design.
 */
function holdIsDoneIr(): WorkflowIr {
  return {
    version: "v2",
    id: "wf-hold-done",
    nodes: [],
    edges: [],
    columns: [
      { id: "done", name: "done", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** The builtin shape, where `done` is TERMINAL. */
function doneIsTerminalIr(): WorkflowIr {
  return {
    version: "v2",
    id: "wf-done-terminal",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(
  tasks: Task[],
  workflowByTask: Record<string, string>,
  irByWorkflow: Record<string, WorkflowIr>,
) {
  const upsertInsight = vi.fn().mockResolvedValue(undefined);
  const getWorkflowDefinition = vi.fn(async (id: string) =>
    irByWorkflow[id] ? { ir: irByWorkflow[id] } : null,
  );
  const store = {
    getSettings: vi.fn().mockResolvedValue({ maxAutoMergeRetries: 3 }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getInsightStore: vi.fn(() => ({ upsertInsight, listInsights: vi.fn().mockResolvedValue([]) })),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({ workflowId: workflowByTask[id], stepIds: [] })),
    getTaskWorkflowSelection: vi.fn((id: string) => ({ workflowId: workflowByTask[id], stepIds: [] })),
    getWorkflowDefinition,
  } as unknown as TaskStore;
  return { store, upsertInsight, getWorkflowDefinition };
}

function reporter(store: TaskStore) {
  return new DependencyBlockedTodoReporter({
    store,
    projectId: "p1",
    logger: { warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
  });
}

describe("dependency-blocked report classifies each task by ITS OWN workflow", () => {
  it("does not treat a blocker as finished because ANOTHER workflow calls that column terminal", async () => {
    /*
    The P1, minimally. Every card belongs to `wf-hold-done`, where `done` is the
    HOLD column. A second workflow on the board calls `done` terminal.

    Under the union, `terminalColumns` contains `done`, so the blocker resting in
    `done` is discarded as finished and the report goes silent — even though for
    ITS workflow that column means "waiting for capacity".
    */
    const tasks = [
      task({ id: "BLOCKER", column: "done" }),
      task({ id: "DEP-1", column: "done", dependencies: ["BLOCKER"] }),
      task({ id: "DEP-2", column: "done", dependencies: ["BLOCKER"] }),
      task({ id: "DEP-3", column: "done", dependencies: ["BLOCKER"] }),
      // A card from the OTHER workflow, whose `done` genuinely is terminal.
      task({ id: "OTHER", column: "done" }),
    ];
    const byTask: Record<string, string> = {
      BLOCKER: "wf-hold-done",
      "DEP-1": "wf-hold-done",
      "DEP-2": "wf-hold-done",
      "DEP-3": "wf-hold-done",
      OTHER: "wf-done-terminal",
    };
    const { store, upsertInsight } = createStore(tasks, byTask, {
      "wf-hold-done": holdIsDoneIr(),
      "wf-done-terminal": doneIsTerminalIr(),
    });

    const result = await reporter(store).report();

    expect(result.alerted).toBe(true);
    const payload = JSON.parse(upsertInsight.mock.calls[0][1].content);
    expect(payload.groups.map((g: { blockerId: string }) => g.blockerId)).toEqual(["BLOCKER"]);
    expect(payload.groups[0].blockedTodoIds).toEqual(["DEP-1", "DEP-2", "DEP-3"]);
  });

  it("does not treat a finished card as held because ANOTHER workflow calls that column hold", async () => {
    /*
    The mirror image, and the half a one-directional fix would miss. Every card
    belongs to `wf-done-terminal`, where `done` is TERMINAL. Under the union
    `holdColumns` contains `done`, so finished cards are counted as blocked
    todos and the report invents blockage that does not exist.
    */
    const tasks = [
      task({ id: "BLOCKER", column: "in-progress" }),
      task({ id: "DEP-1", column: "done", dependencies: ["BLOCKER"] }),
      task({ id: "DEP-2", column: "done", dependencies: ["BLOCKER"] }),
      task({ id: "DEP-3", column: "done", dependencies: ["BLOCKER"] }),
      task({ id: "OTHER", column: "done" }),
    ];
    const byTask: Record<string, string> = {
      BLOCKER: "wf-done-terminal",
      "DEP-1": "wf-done-terminal",
      "DEP-2": "wf-done-terminal",
      "DEP-3": "wf-done-terminal",
      OTHER: "wf-hold-done",
    };
    const { store } = createStore(tasks, byTask, {
      "wf-hold-done": holdIsDoneIr(),
      "wf-done-terminal": doneIsTerminalIr(),
    });

    const result = await reporter(store).report();

    // Those dependents are DONE in their own workflow — nothing is blocked.
    expect(result.alerted).toBe(false);
    expect(result.reason).toBe("no-blocked-groups");
  });

  it("reads one workflow definition per WORKFLOW, not per task (P2)", async () => {
    /*
    The sibling P2, which the per-task fix resolves as a side effect: a shared IR
    cache across the pass means workflow-definition reads scale with the number of
    WORKFLOWS, not the number of cards.
    */
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ id: `FN-${i}`, column: i === 0 ? "in-progress" : "todo", dependencies: i === 0 ? [] : ["FN-0"] }),
    );
    const byTask = Object.fromEntries(tasks.map((t) => [t.id, "wf-done-terminal"]));
    const { store, getWorkflowDefinition } = createStore(tasks, byTask, {
      "wf-done-terminal": doneIsTerminalIr(),
    });

    await reporter(store).report();

    expect(getWorkflowDefinition.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("still degrades to legacy behavior when no workflow resolves", async () => {
    const tasks = [
      task({ id: "BLOCKER", column: "in-progress" }),
      task({ id: "DEP-1", column: "todo", dependencies: ["BLOCKER"] }),
      task({ id: "DEP-2", column: "todo", dependencies: ["BLOCKER"] }),
      task({ id: "DEP-3", column: "todo", dependencies: ["BLOCKER"] }),
    ];
    const { store } = createStore(tasks, {}, {});

    const result = await reporter(store).report();

    expect(result.alerted).toBe(true);
    expect(result.groupCount).toBe(1);
  });
});
