// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import "@fusion/core";
import {
  completeColumnsForTask,
  landedColumnsForTask,
  preWipColumnsForTask,
  wipColumnsForTask,
} from "../task-lifecycle-lanes.js";

function storeWith(ir: unknown, workflowId = "wf") {
  const selection = { workflowId, stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: workflowId, ir }),
  } as never;
}

const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

const V1_UPGRADED_IR = {
  version: "v2",
  id: "wf-v1",
  name: "legacy",
  nodes: [],
  edges: [],
  columns: ["todo", "in-progress", "in-review", "done"].map((id) => ({ id, name: id, traits: [] })),
};

function unreadableStore() {
  return {
    getTaskWorkflowSelectionAsync: async () => { throw new Error("unreadable"); },
    getTaskWorkflowSelection: () => { throw new Error("unreadable"); },
    getWorkflowDefinition: vi.fn(),
  } as never;
}

/*
FNXC:WorkflowResolvedColumns 2026-09-04-10:36:
Dashboard lifecycle helpers resolve custom workflow roles while legacy and unreadable workflows retain the built-in fallback. Completed history has one role only: complete.
*/
describe("completed lane resolution", () => {
  it("resolves custom complete columns for landed and completion-trigger callers", async () => {
    expect([...(await landedColumnsForTask(storeWith(RENAMED_IR), "FN-1"))]).toEqual(["shipped"]);
    expect([...(await completeColumnsForTask(storeWith(RENAMED_IR), "FN-1"))]).toEqual(["shipped"]);
  });

  it("falls back to Done for v1-upgraded and unreadable workflows", async () => {
    expect([...(await landedColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))]).toEqual(["done"]);
    expect([...(await completeColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))]).toEqual(["done"]);
    expect([...(await landedColumnsForTask(unreadableStore(), "FN-1"))]).toEqual(["done"]);
    expect([...(await completeColumnsForTask(unreadableStore(), "FN-1"))]).toEqual(["done"]);
  });
});

describe("active lane resolution", () => {
  it("resolves custom WIP and pre-WIP columns", async () => {
    expect([...(await wipColumnsForTask(storeWith(RENAMED_IR), "FN-1"))]).toEqual(["building"]);
    expect([...(await preWipColumnsForTask(storeWith(RENAMED_IR), "FN-1"))]).toEqual(["backlog"]);
  });

  it("uses built-in fallbacks for v1-upgraded and unreadable workflows", async () => {
    expect([...(await wipColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))]).toEqual(["in-progress"]);
    expect([...(await preWipColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))]).toEqual(["todo"]);
    expect([...(await wipColumnsForTask(unreadableStore(), "FN-1"))]).toEqual(["in-progress"]);
    expect([...(await preWipColumnsForTask(unreadableStore(), "FN-1"))]).toEqual(["todo"]);
  });

  it("does not assign fallback roles when a v2 workflow expresses another lifecycle trait", async () => {
    const noActiveRoles = {
      version: "v2",
      id: "wf-traited",
      name: "traited",
      nodes: [],
      edges: [],
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "in-progress", name: "In Progress", traits: [] },
        { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
      ],
    };
    expect([...(await wipColumnsForTask(storeWith(noActiveRoles), "FN-1"))]).toEqual([]);
    expect([...(await preWipColumnsForTask(storeWith(noActiveRoles), "FN-1"))]).toEqual([]);
  });
});
