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

/*
FNXC:WorkflowResolvedColumns 2026-07-27-16:40 (U10 / R8):
`BUILTIN_WORKFLOW_COLUMN_LABELS` canonicalises lifecycle column labels for BUILT-IN workflows.
It was applied unconditionally, so it also overwrote a built-in that DELIBERATELY renames a
lifecycle column — `builtin:lead-generation` names `triage` "Lead intake" and the board rendered
it as "Planning". Measured against the built-in IRs in tree: 4 column names were being replaced,
3 by case-only variants ("In progress" -> "In Progress") and 1 by a genuine semantic rename.

The canonical map must therefore be a FALLBACK for a column whose IR name adds nothing (blank,
the raw id, or the same words in different case) — never an override of a name the IR chose.
This is also the mechanism that would clobber U11's Todo->Planning rename.
*/
describe("buildBoardWorkflowsPayload built-in column labels", () => {
  function builtinStore(workflowId: string) {
    return {
      getSettings: vi.fn(),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId })),
      getWorkflowDefinition: vi.fn(async () => undefined),
      listWorkflowDefinitions: vi.fn(async () => []),
    };
  }

  it("keeps a built-in's deliberately renamed lifecycle column name", async () => {
    const payload = await buildBoardWorkflowsPayload(
      builtinStore("builtin:lead-generation") as never,
      ["FN-LEAD"],
    );
    const workflow = payload.workflows.find(({ id }) => id === "builtin:lead-generation");
    expect(workflow?.columns.find((column) => column.id === "triage")?.name).toBe("Lead intake");
  });

  it("still canonicalises the default coding workflow's lifecycle labels", async () => {
    const payload = await buildBoardWorkflowsPayload(
      builtinStore("builtin:coding") as never,
      ["FN-CODE"],
    );
    const workflow = payload.workflows.find(({ id }) => id === "builtin:coding");
    const named = Object.fromEntries((workflow?.columns ?? []).map((column) => [column.id, column.name]));
    expect(named).toMatchObject({
      triage: "Planning",
      todo: "Todo",
      "in-progress": "In Progress",
      "in-review": "In Review",
      done: "Done",
      archived: "Archived",
    });
  });
});
