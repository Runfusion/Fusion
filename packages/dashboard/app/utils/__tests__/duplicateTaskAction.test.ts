import { describe, expect, it, vi } from "vitest";
import type { BoardWorkflowsPayload } from "../../api";
import { runDuplicateTaskAction } from "../duplicateTaskAction";

const t = ((key: string, fallback: string, values?: Record<string, string>) => {
  return fallback.replace(/{{(\w+)}}/g, (_match, name: string) => values?.[name] ?? "");
}) as never;

function workflows(): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: "wf-a",
    workflows: [
      { id: "wf-a", name: "Workflow A", columns: [] },
      { id: "wf-b", name: "Workflow B", columns: [] },
    ],
    taskWorkflowIds: { "FN-001": "wf-a" },
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "FN-001",
    t,
    addToast: vi.fn(),
    confirmWithSelect: vi.fn().mockResolvedValue({ choice: "primary", checkboxValue: false, selectValue: "wf-b" }),
    confirm: vi.fn().mockResolvedValue(true),
    duplicateTask: vi.fn().mockResolvedValue({ id: "FN-002" }),
    loadBoardWorkflows: vi.fn().mockResolvedValue(workflows()),
    ...overrides,
  };
}

describe("runDuplicateTaskAction", () => {
  it("shows the picker and forwards the selected non-default workflow", async () => {
    const input = setup();
    const task = await runDuplicateTaskAction(input as never);

    expect(input.confirmWithSelect).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ defaultValue: "wf-a" }),
    }));
    expect(input.confirm).not.toHaveBeenCalled();
    expect(input.duplicateTask).toHaveBeenCalledWith("FN-001", { workflowId: "wf-b" });
    expect(task).toMatchObject({ id: "FN-002" });
    expect(input.addToast).toHaveBeenCalledWith("Duplicated FN-001 → FN-002", "success");
  });

  it("uses plain confirmation and no options when fewer than two workflows are available", async () => {
    const input = setup({
      loadBoardWorkflows: vi.fn().mockResolvedValue({
        ...workflows(),
        workflows: [{ id: "wf-a", name: "Workflow A", columns: [] }],
      }),
    });
    await runDuplicateTaskAction(input as never);
    expect(input.confirm).toHaveBeenCalled();
    expect(input.confirmWithSelect).not.toHaveBeenCalled();
    expect(input.duplicateTask).toHaveBeenCalledWith("FN-001", undefined);
  });

  it("does not duplicate after picker cancellation", async () => {
    const input = setup({
      confirmWithSelect: vi.fn().mockResolvedValue({ choice: "cancel", checkboxValue: false, selectValue: "wf-b" }),
    });
    expect(await runDuplicateTaskAction(input as never)).toBeUndefined();
    expect(input.duplicateTask).not.toHaveBeenCalled();
  });

  it("degrades a throwing or absent workflow loader to plain confirmation", async () => {
    for (const loadBoardWorkflows of [vi.fn().mockRejectedValue(new Error("offline")), undefined]) {
      const input = setup({ loadBoardWorkflows });
      await runDuplicateTaskAction(input as never);
      expect(input.confirm).toHaveBeenCalled();
      expect(input.duplicateTask).toHaveBeenCalledWith("FN-001", undefined);
    }
  });

  it("shows an error toast and returns undefined when duplication fails", async () => {
    const input = setup({ duplicateTask: vi.fn().mockRejectedValue(new Error("duplicate failed")) });
    expect(await runDuplicateTaskAction(input as never)).toBeUndefined();
    expect(input.addToast).toHaveBeenCalledWith("duplicate failed", "error");
  });
});
