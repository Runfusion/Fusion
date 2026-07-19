import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStep, TaskStore } from "@fusion/core";
import { hasAdvancedPastPlanning, isTaskStillInPlanningStage, moveTaskToReplanColumn, resolveReplanTargetColumn } from "../replan-target.js";

/*
FNXC:WorkflowReplan 2026-07-12-23:55:
Engine replan rebounds must target a column the task's OWN workflow declares. The default
Coding workflow replans in "triage"; Coding (Ideas) has no "triage" column and replans in
place in its merged "todo" planner column. The old hardcoded moveTask(id, "triage") orphaned
Coding (Ideas) cards in an undeclared column (rendered back in the "Ideas" intake lane).
*/

function storeWithSelection(workflowId: string | undefined): TaskStore {
  return {
    getTaskWorkflowSelection: vi.fn().mockReturnValue(workflowId ? { workflowId, stepIds: [] } : undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

/*
FNXC:WorkflowReplan 2026-07-16-05:35:
Regression surfaces for the steps>0 planner wedge. A replan card retains the steps its
previous planning pass materialized, so steps must never imply "advanced" while the card is
parked in a planner lane. Enumerated surfaces: the "triage" column (with and without an
explicit needs-replan status), the plan-in-place "todo" planner lane used by Coding (Ideas),
every parked-for-planning status, and the advancement signals that must still fire
(worktree, execution/terminal columns, planned-and-queued todo cards).
*/
type PlanningGuardCase = {
  label: string;
  task: Pick<Task, "column" | "worktree" | "steps" | "status">;
  stillPlanning: boolean;
};

const planStep = (name: string): TaskStep => ({ name, status: "pending" });

const planningGuardCases: PlanningGuardCase[] = [
  { label: "empty triage task", task: { column: "triage", steps: [] }, stillPlanning: true },
  { label: "unplanned todo seed", task: { column: "todo", steps: [] }, stillPlanning: true },
  { label: "todo task with a worktree", task: { column: "todo", worktree: "/tmp/FN-1", steps: [] }, stillPlanning: false },
  {
    label: "planned-and-queued todo task with materialized steps",
    task: { column: "todo", steps: [planStep("step-1")] },
    stillPlanning: false,
  },
  { label: "in-progress task", task: { column: "in-progress", steps: [] }, stillPlanning: false },
  { label: "in-review task", task: { column: "in-review", steps: [] }, stillPlanning: false },
  { label: "completed task", task: { column: "done", steps: [] }, stillPlanning: false },
  { label: "archived task", task: { column: "archived", steps: [] }, stillPlanning: false },

  // A triage card sits in the planner column by definition — nothing executes out of triage,
  // so steps materialized by its previous planning pass must never read as advancement.
  {
    label: "triage replan card carrying steps from its previous planning pass",
    task: { column: "triage", steps: [planStep("step-1")], status: "needs-replan" },
    stillPlanning: true,
  },
  {
    label: "triage card carrying steps with no explicit status",
    task: { column: "triage", steps: [planStep("step-1"), planStep("step-2")] },
    stillPlanning: true,
  },
  {
    label: "triage card parked by a reviewer outage",
    task: { column: "triage", steps: [planStep("step-1")], status: "plan-review-unavailable" },
    stillPlanning: true,
  },

  // Plan-in-place workflows (Coding (Ideas)) park replans in the merged "todo" planner lane,
  // carrying a real spec — the planning status is what separates them from queued work.
  {
    label: "plan-in-place todo replan card carrying steps",
    task: { column: "todo", steps: [planStep("step-1")], status: "needs-replan" },
    stillPlanning: true,
  },
  {
    label: "plan-in-place todo card parked by a reviewer outage",
    task: { column: "todo", steps: [planStep("step-1")], status: "plan-review-unavailable" },
    stillPlanning: true,
  },

  // FN-7977's protections must survive: real advancement still outranks a planning status.
  {
    label: "triage card an executor already claimed a worktree for",
    task: { column: "triage", worktree: "/tmp/FN-1", steps: [planStep("step-1")], status: "needs-replan" },
    stillPlanning: false,
  },
  {
    label: "card that reached execution while a planning recovery was in flight",
    task: { column: "in-progress", steps: [planStep("step-1")], status: "needs-replan" },
    stillPlanning: false,
  },
];

describe("planning-stage guard", () => {
  it.each(planningGuardCases)("recognizes $label", ({ task, stillPlanning }) => {
    expect(isTaskStillInPlanningStage(task)).toBe(stillPlanning);
    expect(hasAdvancedPastPlanning(task)).toBe(!stillPlanning);
  });
});

describe("resolveReplanTargetColumn", () => {
  it("targets triage for the default Coding workflow", async () => {
    const store = storeWithSelection("builtin:coding");
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });

  it("targets triage when the task has no workflow selection", async () => {
    const store = storeWithSelection(undefined);
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });

  it("targets todo for Coding (Ideas), which declares no triage column", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("todo");
  });

  it("falls back to triage for workflows declaring neither triage nor todo (never a custom column)", async () => {
    // builtin:marketing declares ideation/backlog/drafting/... — no triage, no todo.
    // A custom entry column would strand the needs-replan card (triage only scans
    // "triage" and "todo") and the legacy move path throws on custom targets.
    const store = storeWithSelection("builtin:marketing");
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });

  it("falls back to triage when workflow resolution throws", async () => {
    const store = {
      getTaskWorkflowSelection: vi.fn(() => {
        throw new Error("boom");
      }),
      getWorkflowDefinition: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as TaskStore;
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });
});

describe("moveTaskToReplanColumn", () => {
  it("moves a Coding (Ideas) card to todo, not triage", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    const target = await moveTaskToReplanColumn(store, { id: "FN-1", column: "in-progress" });
    expect(target).toBe("todo");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo");
  });

  it("skips the move when the card is already in the replan column (plan-in-place)", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    const target = await moveTaskToReplanColumn(store, { id: "FN-1", column: "todo" });
    expect(target).toBe("todo");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
