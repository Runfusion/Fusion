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
      /*
      FNXC:HumanPlanApproval 2026-09-15-06:24:
      FN-408 adds a DIFFERENT per-card control (`*-human-plan-approval-*`). The retired FN-234 terms
      are therefore pinned to their exact former ids rather than the loose `plan-approval-toggle`
      substring, which would have matched the new control and turned this census into a false
      positive. Everything FN-234 removed — including the `requirePlanApproval` task field and its
      shield iconography — is still asserted absent.
      */
      for (const retiredTerm of [
        "card-plan-approval-badge",
        "list-plan-approval-badge",
        "plan-approval-badge-",
        "quick-entry-plan-approval-toggle",
        "task-form-plan-approval-toggle",
        "task-form-inline-plan-approval",
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

  /*
  FNXC:HumanPlanApproval 2026-09-15-06:24:
  FN-408 — the per-card human decision affordance must exist on every surface the operator uses:
  both creation hosts and all three board renders. A census that only proves the FN-234 controls are
  gone would happily pass with the new ones missing too.
  */
  it("renders the FN-408 per-card human plan approval affordances on every surface", () => {
    expect(productSources.QuickEntryBox).toContain("quick-entry-human-plan-approval-toggle");
    expect(productSources.TaskForm).toContain("task-form-inline-human-plan-approval");
    expect(productSources.NewTaskModal).toContain("onHumanPlanApprovalChange={setRequiresHumanPlanApproval}");
    expect(productSources.TaskCard).toContain("HumanPlanApprovalBadge");
    // Both ListView renders (mobile cards and the desktop table) must carry the badge.
    expect(productSources.ListView.match(/<HumanPlanApprovalBadge/g) ?? []).toHaveLength(2);
  });
});
