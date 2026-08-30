import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const productSources = {
  TaskCard: readAppFile("components/TaskCard.tsx"),
  ListView: readAppFile("components/ListView.tsx"),
  TaskForm: readAppFile("components/TaskForm.tsx"),
  QuickEntryBox: readAppFile("components/QuickEntryBox.tsx"),
  NewTaskModal: readAppFile("components/NewTaskModal.tsx"),
};

describe("retired plan approval UI census", () => {
  it("has zero badge, toggle, task-field, or shield sites in every product component", () => {
    for (const [name, source] of Object.entries(productSources)) {
      for (const retiredTerm of [
        "card-plan-approval-badge",
        "list-plan-approval-badge",
        "plan-approval-badge-",
        "plan-approval-toggle",
        "requirePlanApproval",
        "ShieldCheck",
      ]) {
        expect(source, `${name} still contains ${retiredTerm}`).not.toContain(retiredTerm);
      }
    }
  });

  it("retains the neighboring fast-mode badges and create toggles", () => {
    expect(productSources.TaskCard).toContain("card-execution-mode-badge");
    expect(productSources.ListView).toContain("list-execution-mode-badge");
    expect(productSources.TaskForm).toContain("task-form-inline-fast");
    expect(productSources.QuickEntryBox).toContain("quick-entry-fast-toggle");
    expect(productSources.NewTaskModal).toContain("executionMode={executionMode}");
  });
});
