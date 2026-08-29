import {describe, expect, it} from "vitest";
import {decideArchiveLiveness, resolveArchiveLivenessWipLanes} from "../tasks/task-archive-liveness.js";

describe("task archive liveness", () => {
  it("protects default and renamed WIP lanes, active merges, and paused work", async () => {
    expect(decideArchiveLiveness({column: "in-progress", wipLanes: new Set(["in-progress"])})).toMatchObject({live: true, reasons: ["wip-lane"]});
    const ir = {version: "v2", id: "renamed", name: "renamed", nodes: [], edges: [], columns: [{id: "todo", name: "Todo", traits: [{trait: "intake"}]}, {id: "building", name: "Building", traits: [{trait: "wip"}]}]};
    const store = {getTaskWorkflowSelection: () => ({workflowId: "renamed", stepIds: []}), getTaskWorkflowSelectionAsync: async () => ({workflowId: "renamed", stepIds: []}), getWorkflowDefinition: async () => ({id: "renamed", ir})} as never;
    const lanes = await resolveArchiveLivenessWipLanes(store, "FN-1");
    expect(decideArchiveLiveness({column: "building", wipLanes: lanes})).toMatchObject({live: true});
    expect(decideArchiveLiveness({column: "todo", wipLanes: lanes})).toMatchObject({live: false});
    expect(decideArchiveLiveness({column: "in-review", status: "merging", wipLanes: lanes})).toMatchObject({live: true, reasons: ["active-merge-status"]});
  });

  it("falls back to legacy WIP when workflow resolution fails", async () => {
    const lanes = await resolveArchiveLivenessWipLanes({getTaskWorkflowSelectionAsync: async () => { throw new Error("unavailable"); }} as never, "FN-1");
    expect(decideArchiveLiveness({column: "in-progress", wipLanes: lanes})).toMatchObject({live: true});
  });
});
