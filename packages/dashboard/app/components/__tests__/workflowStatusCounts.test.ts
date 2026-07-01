import { describe, expect, it } from "vitest";
import {
  getBuiltinWorkflow,
  resolveColumnFlags,
  type Task,
} from "@fusion/core";
import type { BoardWorkflowColumn, BoardWorkflowsPayload } from "../../api";
import { computeWorkflowStatusCounts } from "../workflowStatusCounts";

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
        { id: "archived", name: "Archived", flags: { archived: true } },
      ],
    },
    {
      id: "design",
      name: "Design",
      columns: [
        { id: "design-todo", name: "Todo", flags: { intake: true } },
        {
          id: "design-active",
          name: "Active",
          flags: { countsTowardWip: true },
        },
        { id: "design-done", name: "Done", flags: { complete: true } },
        { id: "design-archived", name: "Archived", flags: { archived: true } },
      ],
    },
    {
      id: "empty",
      name: "Empty",
      columns: [
        { id: "empty-todo", name: "Todo", flags: { intake: true } },
        {
          id: "empty-active",
          name: "Active",
          flags: { countsTowardWip: true },
        },
        { id: "empty-done", name: "Done", flags: { complete: true } },
      ],
    },
  ],
};

function task(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
  } as Task;
}

function taskWithStatus(id: string, column: string, status: string): Task {
  return {
    ...task(id, column),
    status,
  } as Task;
}

function builtinWorkflowColumns(id: string): BoardWorkflowColumn[] {
  const workflow = getBuiltinWorkflow(id);
  if (!workflow) throw new Error(`Missing built-in workflow fixture: ${id}`);
  if (workflow.ir.version !== "v2")
    throw new Error(`Built-in workflow fixture is not v2: ${id}`);

  return workflow.ir.columns.map((column) => ({
    id: column.id,
    name: column.name,
    flags: resolveColumnFlags(column),
  }));
}

function singleWorkflowPayload(
  id: string,
  columns: BoardWorkflowColumn[]
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
    expect(computeWorkflowStatusCounts([task("FN-1", "todo")], null).size).toBe(
      0
    );
    expect(computeWorkflowStatusCounts(undefined, undefined).size).toBe(0);
  });

  it("initializes every workflow with zero counts for empty and duplicate/populated states", () => {
    const counts = computeWorkflowStatusCounts([], boardWorkflows);

    expect(counts.get("default")).toEqual({ todo: 0, inProgress: 0, done: 0, merging: 0 });
    expect(counts.get("design")).toEqual({ todo: 0, inProgress: 0, done: 0, merging: 0 });
    expect(counts.get("empty")).toEqual({ todo: 0, inProgress: 0, done: 0, merging: 0 });
  });

  it("classifies todo, in-progress, and done buckets from workflow column flags", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-todo", "todo"),
        task("FN-ready", "ready"),
        task("FN-active", "active"),
        task("FN-review", "review"),
        task("FN-done", "done"),
      ],
      boardWorkflows
    );

    expect(counts.get("default")).toEqual({ todo: 2, inProgress: 2, done: 1, merging: 0 });
  });

  it("keeps flag-based classification authoritative over canonical lifecycle ids", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-complete-in-progress", "in-progress"),
        task("FN-wip-done", "done"),
        task("FN-archived-active", "active"),
      ],
      singleWorkflowPayload("flags-win", [
        {
          id: "in-progress",
          name: "Complete despite id",
          flags: { complete: true },
        },
        {
          id: "done",
          name: "WIP despite id",
          flags: { countsTowardWip: true },
        },
        {
          id: "active",
          name: "Archived despite id",
          flags: { archived: true },
        },
      ])
    );

    expect(counts.get("flags-win")).toEqual({
      todo: 0,
      inProgress: 1,
      done: 1,
      merging: 0,
    });
  });

  it("falls back to the default workflow when a task has no workflow assignment", () => {
    const counts = computeWorkflowStatusCounts(
      [task("FN-unassigned", "done")],
      boardWorkflows
    );

    expect(counts.get("default")).toEqual({ todo: 0, inProgress: 0, done: 1, merging: 0 });
  });

  it("counts tasks independently for their assigned workflow", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-design-todo", "design-todo"),
        task("FN-design-active", "design-active"),
        task("FN-design-done", "design-done"),
      ],
      {
        ...boardWorkflows,
        taskWorkflowIds: {
          "FN-design-todo": "design",
          "FN-design-active": "design",
          "FN-design-done": "design",
        },
      }
    );

    expect(counts.get("design")).toEqual({ todo: 1, inProgress: 1, done: 1, merging: 0 });
    expect(counts.get("default")).toEqual({ todo: 0, inProgress: 0, done: 0, merging: 0 });
  });

  it("tracks actively merging tasks per workflow separately from bucket counts", () => {
    const counts = computeWorkflowStatusCounts(
      [
        taskWithStatus("FN-default-merging", "review", "merging"),
        taskWithStatus("FN-design-merging-fix", "design-active", "merging-fix"),
        taskWithStatus("FN-design-normal", "design-active", "executing"),
      ],
      {
        ...boardWorkflows,
        taskWorkflowIds: {
          "FN-design-merging-fix": "design",
          "FN-design-normal": "design",
        },
      }
    );

    expect(counts.get("default")).toEqual({ todo: 0, inProgress: 1, done: 0, merging: 1 });
    expect(counts.get("design")).toEqual({ todo: 0, inProgress: 2, done: 0, merging: 1 });
  });

  it("excludes archived and board-hidden column tasks while stale workflows fall back to default", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-archived", "archived"),
        task("FN-hidden", "quiet"),
        task("FN-unknown-column", "missing"),
        task("FN-unknown-workflow", "todo"),
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
          boardWorkflows.workflows[1],
          boardWorkflows.workflows[2],
        ],
        taskWorkflowIds: {
          "FN-unknown-workflow": "missing-workflow",
        },
      }
    );

    expect(counts.get("default")).toEqual({ todo: 1, inProgress: 0, done: 0, merging: 0 });
  });

  it("uses real quick-fix columns to count the reported two done and zero in-progress state", () => {
    const columns = builtinWorkflowColumns("builtin:quick-fix");

    const counts = computeWorkflowStatusCounts(
      [task("FN-done-1", "done"), task("FN-done-2", "done")],
      singleWorkflowPayload("builtin:quick-fix", columns)
    );

    expect(counts.get("builtin:quick-fix")).toEqual({
      todo: 0,
      inProgress: 0,
      done: 2,
      merging: 0,
    });
  });

  it("classifies every linear built-in's canonical lifecycle columns", () => {
    for (const workflowId of [
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:compound-engineering",
    ]) {
      const columns = builtinWorkflowColumns(workflowId);

      const counts = computeWorkflowStatusCounts(
        [
          task(`${workflowId}-triage`, "triage"),
          task(`${workflowId}-todo`, "todo"),
          task(`${workflowId}-in-progress`, "in-progress"),
          task(`${workflowId}-in-review`, "in-review"),
          task(`${workflowId}-done`, "done"),
          task(`${workflowId}-archived`, "archived"),
        ],
        singleWorkflowPayload(workflowId, columns)
      );

      expect(counts.get(workflowId)).toEqual({
        todo: 3,
        inProgress: 1,
        done: 1,
        merging: 0,
      });
    }
  });

  it("initializes and populates flag-less workflow states including multiple done tasks", () => {
    const columns = builtinWorkflowColumns("builtin:quick-fix");
    const payload = singleWorkflowPayload("builtin:quick-fix", columns);

    expect(
      computeWorkflowStatusCounts([], payload).get("builtin:quick-fix")
    ).toEqual({ todo: 0, inProgress: 0, done: 0, merging: 0 });

    const counts = computeWorkflowStatusCounts(
      [
        task("FN-todo", "todo"),
        task("FN-review", "in-review"),
        task("FN-active", "in-progress"),
        task("FN-done-1", "done"),
        task("FN-done-2", "done"),
      ],
      payload
    );

    expect(counts.get("builtin:quick-fix")).toEqual({
      todo: 2,
      inProgress: 1,
      done: 2,
      merging: 0,
    });
  });

  it("keeps the trait-bearing built-in coding workflow bucketing unchanged", () => {
    const counts = computeWorkflowStatusCounts(
      [
        task("FN-active", "in-progress"),
        task("FN-review", "in-review"),
        task("FN-done", "done"),
        task("FN-archived", "archived"),
      ],
      singleWorkflowPayload(
        "builtin:coding",
        builtinWorkflowColumns("builtin:coding")
      )
    );

    expect(counts.get("builtin:coding")).toEqual({
      todo: 1,
      inProgress: 1,
      done: 1,
      merging: 0,
    });
  });
});
