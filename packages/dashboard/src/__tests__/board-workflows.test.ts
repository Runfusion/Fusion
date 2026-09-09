import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, getBuiltinWorkflow, type WorkflowIr } from "@fusion/core";
import { getTaskWorkflowSelectionAsyncImpl } from "../../../core/src/task-store/workflow-definitions.js";
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
describe("buildBoardWorkflowsPayload disabled built-ins", () => {
  function disabledCodingStore(taskWorkflowId?: string) {
    const quickFix = getBuiltinWorkflow("builtin:quick-fix")!;
    return {
      getSettings: vi.fn(async () => ({
        defaultWorkflowId: "builtin:coding",
        enabledBuiltinWorkflowIds: ["builtin:quick-fix"],
      })),
      getTaskWorkflowSelection: vi.fn(() => taskWorkflowId ? { workflowId: taskWorkflowId } : null),
      getWorkflowDefinition: vi.fn(async () => undefined),
      listWorkflowDefinitions: vi.fn(async () => [quickFix]),
    };
  }

  it("uses the enabled workflow as the default and omits disabled Coding with no tasks", async () => {
    const payload = await buildBoardWorkflowsPayload(disabledCodingStore() as never, []);

    expect(payload.defaultWorkflowId).toBe("builtin:quick-fix");
    expect(payload.workflows.map((workflow) => workflow.id)).toEqual(["builtin:quick-fix"]);
    expect(payload.workflows[0]?.selectable).toBe(true);
  });

  it("retains an explicitly assigned disabled Coding definition without making it selectable", async () => {
    const payload = await buildBoardWorkflowsPayload(disabledCodingStore("builtin:coding") as never, ["FN-CODING"]);

    expect(payload.taskWorkflowIds["FN-CODING"]).toBe("builtin:coding");
    expect(payload.workflows.map((workflow) => [workflow.id, workflow.selectable])).toEqual([
      ["builtin:coding", false],
      ["builtin:quick-fix", true],
    ]);
  });
});

describe("buildBoardWorkflowsPayload retired workflow succession", () => {
  it("projects legacy and successor selections into one Ideas lane", async () => {
    const persisted = new Map([
      ["FN-OLD", { workflowId: "builtin:coding-ideas", stepIds: ["plan-review"] }],
      ["FN-NEW", { workflowId: "builtin:coding-ideas-v2", stepIds: ["code-review"] }],
    ]);
    const getTaskWorkflowSelectionAsync = vi.fn(async (taskId: string) => {
      const row = persisted.get(taskId);
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => row ? [row] : [] }),
          }),
        }),
      };
      return getTaskWorkflowSelectionAsyncImpl({
        asyncLayer: { projectId: "board-successor", db },
      } as never, taskId);
    });
    const store = {
      getSettings: vi.fn(async () => ({ defaultWorkflowId: "builtin:coding" })),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync,
      getWorkflowDefinition: vi.fn(async () => undefined),
      listWorkflowDefinitions: vi.fn(async () => []),
    };

    const payload = await buildBoardWorkflowsPayload(store as never, ["FN-OLD", "FN-NEW"]);
    const ideas = payload.workflows.filter((workflow) => workflow.id === "builtin:coding-ideas-v2");

    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.name).toBe("Coding (Ideas)");
    expect(payload.workflows.filter((workflow) => workflow.name === "Coding (Ideas)")).toHaveLength(1);
    expect(payload.taskWorkflowIds).toMatchObject({
      "FN-OLD": "builtin:coding-ideas-v2",
      "FN-NEW": "builtin:coding-ideas-v2",
    });
  });
});

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
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-03-03:30 (red on main — the deleted-column class again):
    THE DEFAULT LINEAGE HAS FIVE LIFECYCLE COLUMNS, NOT SIX. #2515 merged Todo into Planning: the id `todo`
    survives carrying the label "Planning", and `triage` is gone. This expectation still asserted both a
    `triage: "Planning"` key and a `todo: "Todo"` one, so it described a board that has not shipped since that
    change.

    Same class as the 23 assertions corrected in #2758 and the two in #2720, and the same tell: the failure
    reads like a canonicalisation bug ("expected triage: Planning") when the canonicalisation is right and the
    expectation is stale.

    The invariant this case exists for is unchanged and still asserted: the built-in coding workflow'"'"'s columns
    carry their CANONICAL labels rather than raw ids — which is what the sibling case above contrasts against a
    built-in that deliberately renames one.
    */
    expect(named).toMatchObject({
      todo: "Planning",
      "in-progress": "In Progress",
      "in-review": "In Review",
      done: "Done",
    });
    // And the merged column is gone, so nothing should be canonicalising a `triage` label any more.
    expect(named).not.toHaveProperty("triage");
  });
});
