import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, type WorkflowIr } from "@fusion/core";
import { buildBoardWorkflowsPayload } from "../routes/board-workflows.js";

const CUSTOM_WORKFLOW_ID = "WF-DESCRIPTIONS";

function customWorkflowIr(columns: WorkflowIr["columns"]): WorkflowIr {
  return {
    ...BUILTIN_CODING_WORKFLOW_IR,
    name: "Description workflow",
    columns,
  };
}

function makeStore(ir: WorkflowIr) {
  return {
    getSettings: vi.fn(),
    getTaskWorkflowSelection: vi.fn((taskId: string) => taskId === "FN-CUSTOM" ? { workflowId: CUSTOM_WORKFLOW_ID } : null),
    getWorkflowDefinition: vi.fn(async (id: string) => id === CUSTOM_WORKFLOW_ID ? {
      id: CUSTOM_WORKFLOW_ID,
      name: "Description workflow",
      description: "",
      kind: "workflow",
      ir,
      layout: {},
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    } : undefined),
    listWorkflowDefinitions: vi.fn(async () => []),
  };
}

/*
FNXC:WorkflowColumnDescriptions 2026-07-22-12:35:
The board-workflows bridge must preserve author-defined column copy without
inventing empty values; Column applies the lifecycle fallback only after this
projection keeps an omitted description absent.
*/
describe("buildBoardWorkflowsPayload column descriptions", () => {
  it("projects populated descriptions and omits legacy columns without custom copy", async () => {
    const columns = BUILTIN_CODING_WORKFLOW_IR.columns.map((column, index) => (
      index === 0
        ? { ...column, description: "Plan work\nwith the team" }
        : { ...column }
    ));
    const payload = await buildBoardWorkflowsPayload(
      makeStore(customWorkflowIr(columns)) as never,
      ["FN-CUSTOM"],
      { experimentalFeatures: { workflowColumns: true } },
    );

    const workflow = payload.workflows.find(({ id }) => id === CUSTOM_WORKFLOW_ID);
    expect(workflow?.columns[0]).toMatchObject({
      id: BUILTIN_CODING_WORKFLOW_IR.columns[0].id,
      description: "Plan work\nwith the team",
    });
    expect(workflow?.columns[1]).not.toHaveProperty("description");
  });
});
