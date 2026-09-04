import { describe, expect, it } from "vitest";
import type { BoardWorkflowsPayload } from "../../api";
import { resolveDuplicateWorkflowChoices } from "../duplicateWorkflowChoices";

function payload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: "wf-default",
    workflows: [
      { id: "wf-z", name: "Zulu", columns: [] },
      { id: "wf-default", name: "Default", columns: [] },
      { id: "wf-a", name: "Alpha", columns: [] },
    ],
    taskWorkflowIds: { "FN-001": "wf-z" },
    ...overrides,
  };
}

describe("resolveDuplicateWorkflowChoices", () => {
  it.each([null, undefined])("returns null for a missing payload", (value) => {
    expect(resolveDuplicateWorkflowChoices(value, "FN-001")).toBeNull();
  });

  it.each([[[]], [[{ id: "wf-default", name: "Default", columns: [] }]]])(
    "returns null with fewer than two selectable workflows",
    (workflows) => {
      expect(resolveDuplicateWorkflowChoices(payload({ workflows }), "FN-001")).toBeNull();
    },
  );

  it("filters disabled workflows and sorts the default first then by name", () => {
    const result = resolveDuplicateWorkflowChoices(payload({
      workflows: [
        { id: "wf-z", name: "Zulu", columns: [] },
        { id: "wf-disabled", name: "Disabled", selectable: false, columns: [] },
        { id: "wf-default", name: "Default", columns: [] },
        { id: "wf-a", name: "Alpha", columns: [] },
      ],
    }), "FN-001");

    expect(result?.options).toEqual([
      { id: "wf-default", name: "Default" },
      { id: "wf-a", name: "Alpha" },
      { id: "wf-z", name: "Zulu" },
    ]);
    expect(result?.currentWorkflowId).toBe("wf-z");
  });

  it("falls back from a disabled current workflow to the default", () => {
    const result = resolveDuplicateWorkflowChoices(payload({
      taskWorkflowIds: { "FN-001": "wf-disabled" },
      workflows: [
        { id: "wf-disabled", name: "Disabled", selectable: false, columns: [] },
        { id: "wf-default", name: "Default", columns: [] },
        { id: "wf-a", name: "Alpha", columns: [] },
      ],
    }), "FN-001");
    expect(result?.currentWorkflowId).toBe("wf-default");
    expect(result?.options.map((option) => option.id)).not.toContain("wf-disabled");
  });

  it("uses the default when the task has no workflow mapping", () => {
    expect(resolveDuplicateWorkflowChoices(payload({ taskWorkflowIds: {} }), "FN-001")?.currentWorkflowId)
      .toBe("wf-default");
  });

  it("uses the first option when neither task nor default workflow is selectable", () => {
    const result = resolveDuplicateWorkflowChoices(payload({
      defaultWorkflowId: "wf-missing",
      taskWorkflowIds: {},
      workflows: [
        { id: "wf-b", name: "Beta", columns: [] },
        { id: "wf-a", name: "Alpha", columns: [] },
      ],
    }), "FN-001");
    expect(result).toEqual({
      options: [{ id: "wf-a", name: "Alpha" }, { id: "wf-b", name: "Beta" }],
      currentWorkflowId: "wf-a",
    });
  });

  it("keys duplicate display names by workflow id", () => {
    const result = resolveDuplicateWorkflowChoices(payload({
      workflows: [
        { id: "wf-default", name: "Same", columns: [] },
        { id: "wf-other", name: "Same", columns: [] },
      ],
      taskWorkflowIds: { "FN-001": "wf-other" },
    }), "FN-001");
    expect(result?.options).toEqual([
      { id: "wf-default", name: "Same" },
      { id: "wf-other", name: "Same" },
    ]);
    expect(result?.currentWorkflowId).toBe("wf-other");
  });
});
