import { describe, expect, it } from "vitest";
import {
  getBuiltinWorkflow,
  resolveColumnFlags,
  type Task,
} from "@fusion/core";
import type { BoardWorkflowColumn, BoardWorkflowsPayload } from "../../api";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../../utils/boardWorkflowSelection";
import { computeWorkflowStatusCounts } from "../workflowStatusCounts";

const ZERO_COUNTS = { plan: 0, progress: 0, review: 0, merging: 0 };

const boardWorkflows: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "default",
  taskWorkflowIds: {},
  workflows: [
    {
      id: "default",
      name: "Default",
      columns: [
        { id: "todo", name: "Todo", flags: { intake: true } },
        { id: "ready", name: "Ready", flags: {} },
        { id: "active", name: "Active", flags: { countsTowardWip: true } },
        {
          id: "review",
          name: "Review",
          flags: { countsTowardWip: true, mergeBlocker: true },
        },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
    {
      id: "design",
      name: "Design",
      columns: [
        { id: "design-plan", name: "Plan", flags: { intake: true } },
        { id: "design-progress", name: "Progress", flags: { countsTowardWip: true } },
        { id: "design-review", name: "Review", flags: { humanReview: true } },
        { id: "design-done", name: "Done", flags: { complete: true } },
      ],
    },
    {
      id: "empty",
      name: "Empty",
      columns: [{ id: "empty-plan", name: "Plan", flags: { intake: true } }],
    },
  ],
};

function task(id: string, column: string, status?: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...(status ? { status } : {}),
  } as unknown as Task;
}

function builtinWorkflowColumns(id: string): BoardWorkflowColumn[] {
  const workflow = getBuiltinWorkflow(id);
  if (!workflow || workflow.ir.version !== "v2") {
    throw new Error(`Missing v2 built-in workflow fixture: ${id}`);
  }
  return workflow.ir.columns.map((column) => ({
    id: column.id,
    name: column.name,
    flags: resolveColumnFlags(column) as unknown as BoardWorkflowColumn["flags"],
  }));
}

function singleWorkflowPayload(
  id: string,
  columns: BoardWorkflowColumn[],
): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: id,
    taskWorkflowIds: {},
    workflows: [{ id, name: id, columns }],
  };
}

describe("computeWorkflowStatusCounts", () => {
  it("returns an empty map when workflow metadata is unavailable", () => {
    expect(computeWorkflowStatusCounts([task("FN-1", "todo")], null).size).toBe(0);
    expect(computeWorkflowStatusCounts(undefined, undefined).size).toBe(0);
  });

  it("initializes every workflow and the aggregate sentinel with zero counts", () => {
    const counts = computeWorkflowStatusCounts([], boardWorkflows);

    expect(counts.get("default")).toEqual(ZERO_COUNTS);
    expect(counts.get("design")).toEqual(ZERO_COUNTS);
    expect(counts.get("empty")).toEqual(ZERO_COUNTS);
    expect(counts.get(ALL_WORKFLOWS_BOARD_VIEW_ID)).toEqual(ZERO_COUNTS);
  });

  it("classifies Plan, Progress, and Review while excluding complete work", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-plan", "todo"),
        task("FN-ready", "ready"),
        task("FN-progress", "active"),
        task("FN-review", "review"),
        task("FN-done", "done"),
      ],
      boardWorkflows,
    );

    expect(counts.get("default")).toEqual({ plan: 2, progress: 1, review: 1, merging: 0 });
  });

  it.each([
    ["mergeOrchestration", { mergeOrchestration: true }],
    ["mergeBlocker", { mergeBlocker: true }],
    ["humanReview", { humanReview: true }],
  ] as const)("classifies a %s-only custom column as Review", (_name, reviewFlag) => {
    const counts = computeWorkflowStatusCounts(
      [task("FN-review", "custom-review")],
      singleWorkflowPayload("custom", [
        { id: "custom-review", name: "Custom review", flags: reviewFlag },
      ]),
    );

    expect(counts.get("custom")).toEqual({ plan: 0, progress: 0, review: 1, merging: 0 });
  });

  it("gives Review priority over WIP and complete priority over every active role", () => {
    const counts = computeWorkflowStatusCounts(
      [task("FN-review-wip", "review-wip"), task("FN-complete-review", "complete-review")],
      singleWorkflowPayload("flags-win", [
        {
          id: "review-wip",
          name: "Review and WIP",
          flags: { countsTowardWip: true, humanReview: true },
        },
        {
          id: "complete-review",
          name: "Complete and review",
          flags: { complete: true, mergeOrchestration: true },
        },
      ]),
    );

    expect(counts.get("flags-win")).toEqual({ plan: 0, progress: 0, review: 1, merging: 0 });
  });

  it("falls back to canonical columns for trait-less linear workflows", () => {
    const payload = singleWorkflowPayload("legacy", [
      { id: "triage", name: "Triage", flags: {} },
      { id: "todo", name: "Todo", flags: {} },
      { id: "in-progress", name: "In progress", flags: {} },
      { id: "in-review", name: "In review", flags: {} },
      { id: "done", name: "Done", flags: {} },
    ]);

    const counts = computeWorkflowStatusCounts(
      [
        task("FN-triage", "triage"),
        task("FN-todo", "todo"),
        task("FN-progress", "in-progress"),
        task("FN-review", "in-review"),
        task("FN-done", "done"),
      ],
      payload,
    );

    expect(counts.get("legacy")).toEqual({ plan: 2, progress: 1, review: 1, merging: 0 });
  });

  it("keeps resolved flags authoritative when a modern workflow reuses canonical ids", () => {
    const payload = singleWorkflowPayload("modern", [
      { id: "in-progress", name: "Planning", flags: { intake: true } },
      { id: "in-review", name: "Implementation", flags: { countsTowardWip: true } },
      { id: "done", name: "Approval", flags: { humanReview: true } },
    ]);

    const counts = computeWorkflowStatusCounts(
      [
        task("FN-plan", "in-progress"),
        task("FN-progress", "in-review"),
        task("FN-review", "done"),
      ],
      payload,
    );

    expect(counts.get("modern")).toEqual({ plan: 1, progress: 1, review: 1, merging: 0 });
  });

  it("classifies every linear built-in and excludes its complete column", () => {
    for (const workflowId of [
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:compound-engineering",
    ]) {
      const counts = computeWorkflowStatusCounts(
        [
          task(`${workflowId}-triage`, "triage"),
          task(`${workflowId}-todo`, "todo"),
          task(`${workflowId}-progress`, "in-progress"),
          task(`${workflowId}-review`, "in-review"),
          task(`${workflowId}-done`, "done"),
        ],
        singleWorkflowPayload(workflowId, builtinWorkflowColumns(workflowId)),
      );

      expect(counts.get(workflowId)).toEqual({ plan: 2, progress: 1, review: 1, merging: 0 });
    }
  });

  it("uses the default workflow for absent or stale assignments and ignores unknown or hidden columns", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-unassigned", "todo"),
        task("FN-stale", "ready"),
        task("FN-hidden", "quiet"),
        task("FN-unknown", "missing"),
      ],
      {
        ...boardWorkflows,
        workflows: [
          {
            ...boardWorkflows.workflows[0],
            columns: [
              ...boardWorkflows.workflows[0].columns,
              { id: "quiet", name: "Quiet", flags: { hiddenFromBoard: true } },
            ],
          },
          ...boardWorkflows.workflows.slice(1),
        ],
        taskWorkflowIds: {
          "FN-stale": "removed-workflow",
          "FN-hidden": "default",
          "FN-unknown": "design",
        },
      },
    );

    expect(counts.get("default")).toEqual({ plan: 2, progress: 0, review: 0, merging: 0 });
  });

  it("counts each real row once in its workflow and once in the aggregate", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-default-plan", "todo"),
        task("FN-default-review", "review"),
        task("FN-default-done", "done"),
        task("FN-design-progress", "design-progress"),
        task("FN-design-review", "design-review"),
        task("FN-design-done", "design-done"),
      ],
      {
        ...boardWorkflows,
        taskWorkflowIds: {
          "FN-design-progress": "design",
          "FN-design-review": "design",
          "FN-design-done": "design",
        },
      },
    );

    expect(counts.get("default")).toEqual({ plan: 1, progress: 0, review: 1, merging: 0 });
    expect(counts.get("design")).toEqual({ plan: 0, progress: 1, review: 1, merging: 0 });
    expect(counts.get(ALL_WORKFLOWS_BOARD_VIEW_ID)).toEqual({ plan: 1, progress: 1, review: 2, merging: 0 });
  });

  it("counts an active merge once in Review while retaining the merging indicator", () => {
    const counts = computeWorkflowStatusCounts(
      [task("FN-reviewing", "review", "reviewing"), task("FN-landing", "review", "landing")],
      boardWorkflows,
    );

    expect(counts.get("default")).toEqual({ plan: 0, progress: 0, review: 2, merging: 2 });
    expect(counts.get(ALL_WORKFLOWS_BOARD_VIEW_ID)).toEqual({ plan: 0, progress: 0, review: 2, merging: 2 });
  });

  /*
  FNXC:ColumnCapacity 2026-10-10-20:08 (RUFU-362):
  Production shape that froze project saneca: a WIP lane whose every row had died with a failure badge.
  The switcher reported it as fully loaded work in progress while live occupancy was zero, so the board
  looked busy to an operator while the engine re-suspended ready cards on `capacity-exhausted`. The
  bucket rule now matches the lane's real admission answer, and the live card beside each park is what
  keeps these assertions non-vacuous — a counter that simply never incremented would also read 0.
  */
  it("reports a WIP lane full of failed parks as zero work in progress", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("SANE-435", "active", "failed"),
        task("SANE-515", "active", "failed"),
        task("SANE-453", "active", "failed"),
      ],
      boardWorkflows,
    );

    expect(counts.get("default")).toEqual(ZERO_COUNTS);
    expect(counts.get(ALL_WORKFLOWS_BOARD_VIEW_ID)).toEqual(ZERO_COUNTS);
  });

  it.each([
    ["progress", "active"],
    ["review", "review"],
  ])("drops a failed park from %s occupancy while a live card in the same lane still counts", (_phase, column) => {
    const counts = computeWorkflowStatusCounts(
      [task("FN-dead", column, "failed"), task("FN-live", column)],
      boardWorkflows,
    );

    const expected = { plan: 0, progress: 0, review: 0, merging: 0 };
    expected[_phase as "progress" | "review"] = 1;
    expect(counts.get("default")).toEqual(expected);
    expect(counts.get(ALL_WORKFLOWS_BOARD_VIEW_ID)).toEqual(expected);
  });

  it("keeps a failed park in the Plan bucket, which reports queue depth rather than occupancy", () => {
    const counts = computeWorkflowStatusCounts(
      [task("FN-dead-todo", "todo", "failed"), task("FN-dead-ready", "ready", "failed")],
      boardWorkflows,
    );

    expect(counts.get("default")).toEqual({ plan: 2, progress: 0, review: 0, merging: 0 });
  });

  it("applies the exclusion on the canonical-column fallback path too, not only resolved traits", () => {
    const legacy = singleWorkflowPayload("legacy", [
      { id: "todo", name: "Todo", flags: {} },
      { id: "in-progress", name: "In progress", flags: {} },
      { id: "in-review", name: "In review", flags: {} },
      { id: "done", name: "Done", flags: {} },
    ]);

    const counts = computeWorkflowStatusCounts(
      [
        task("FN-legacy-dead", "in-progress", "failed"),
        task("FN-legacy-live", "in-review"),
      ],
      legacy,
    );

    expect(counts.get("legacy")).toEqual({ plan: 0, progress: 0, review: 1, merging: 0 });
  });
});
