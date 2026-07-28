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
/*
FNXC:WorkflowReplan 2026-07-26-06:10:
Regression surfaces for the sticky-execution-timestamp strand (FN-8594). A card that executed
once and was rebounded to a planner lane by Plan Review keeps `firstExecutionAt` forever, so
execution timestamps must never outrank the planner-lane checks — otherwise triage discovery
drops the card and it sits "stuck in planning". Enumerated surfaces: the "triage" column under
every parked-for-planning status AND no status, the plan-in-place "todo" lane, both timestamp
fields independently, and the queued-todo cards where a timestamp must still read as advanced.
*/
type PlanningGuardCase = {
  label: string;
  task: Pick<Task, "column" | "worktree" | "steps" | "status">
    & Partial<Pick<Task, "firstExecutionAt" | "executionStartedAt">>;
  stillPlanning: boolean;
};

const planStep = (name: string): TaskStep => ({ name, status: "pending" });

const planningGuardCases: PlanningGuardCase[] = [
  { label: "empty triage task", task: { column: "triage", steps: [] }, stillPlanning: true },
  { label: "unplanned todo seed", task: { column: "todo", steps: [] }, stillPlanning: true },
  /*
  FNXC:NodeWorktreeIsolation 2026-07-26-20:50:
  Planning acquires the task worktree up front, so worktree alone is NOT advancement.
  Only execution timestamps / execution columns prove the card left planning.
  */
  { label: "todo task with a worktree", task: { column: "todo", worktree: "/tmp/FN-1", steps: [] }, stillPlanning: true },
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

  // Worktree under a planning status is still planning; execution timestamps are the durable signal.
  {
    label: "triage card that already has a planning worktree",
    task: { column: "triage", worktree: "/tmp/FN-1", steps: [planStep("step-1")], status: "needs-replan" },
    stillPlanning: true,
  },
  {
    label: "card that reached execution while a planning recovery was in flight",
    task: { column: "in-progress", steps: [planStep("step-1")], status: "needs-replan" },
    stillPlanning: false,
  },

  // Sticky execution timestamps must not survive a legitimate rebound into a planner lane.
  {
    label: "triage replan card that already executed once (firstExecutionAt)",
    task: {
      column: "triage",
      steps: [planStep("step-1")],
      status: "needs-replan",
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
    },
    stillPlanning: true,
  },
  {
    label: "triage replan card whose last execution start is still stamped",
    task: {
      column: "triage",
      steps: [planStep("step-1")],
      status: "needs-replan",
      executionStartedAt: "2026-07-26T04:35:29.068Z",
    },
    stillPlanning: true,
  },
  // A triage card with a timestamp but NO planning status is the stranded-advanced class that
  // self-healing's advanced recovery owns (PR #2360) — planning must keep excluding it.
  {
    label: "stranded-advanced triage card with execution timestamps and no planning status",
    task: {
      column: "triage",
      steps: [planStep("step-1")],
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
      executionStartedAt: "2026-07-26T04:35:29.068Z",
    },
    stillPlanning: false,
  },
  /*
  FNXC:WorkflowReplan 2026-07-26-07:40:
  `planning` is the TRANSIENT planner claim, not a durable park: when a stamp lands on a
  `planning` row, execution won the FN-8361 race and recovery must not clear the status out from
  under it. Only the durable park statuses outrank the stamps.
  */
  {
    label: "planning row claimed by execution mid-race (FN-8361)",
    task: {
      column: "triage",
      steps: [],
      status: "planning",
      worktree: "/tmp/claimed",
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
    },
    stillPlanning: false,
  },
  /*
  FNXC:WorkflowReplan 2026-07-26-18:40 (FN-8596 strand):
  The stale-stamp case, and the exact shape that stranded a card in production. Triage CLAIMED a
  rebounded replan card, overwriting `needs-replan` with the transient `planning`, so the durable-
  park escape no longer applied and the card fell through to the execution stamps — which were set
  on its FIRST pass and are never cleared. It read as advanced, every guarded planner write silently
  no-opped, and the finalize never handed the card off.
  The discriminator is arrival order: the stamp PREDATES `columnMovedAt`, so it belongs to the
  previous pass. Contrast with the FN-8361 case above, where the stamp lands after arrival (there,
  no `columnMovedAt` at all) and execution genuinely won the race.
  */
  {
    label: "triage replan card claimed by triage, stamps left over from its previous pass",
    task: {
      column: "triage",
      steps: [planStep("step-1")],
      status: "planning",
      worktree: "/tmp/brave-otter",
      executionStartedAt: "2026-07-26T13:50:57.686Z",
      firstExecutionAt: "2026-07-26T13:50:57.686Z",
      columnMovedAt: "2026-07-26T13:51:33.266Z",
    },
    stillPlanning: true,
  },
  {
    label: "triage planning card whose execution stamp lands AFTER arrival (live claim, FN-8361)",
    task: {
      column: "triage",
      steps: [],
      status: "planning",
      columnMovedAt: "2026-07-26T13:51:33.266Z",
      executionStartedAt: "2026-07-26T13:52:10.000Z",
    },
    stillPlanning: false,
  },
  /*
  FNXC:WorkflowReplan 2026-07-26-20:30 (FN-8596, second strand):
  A stale stamp with NO status is STILL plannable — this deliberately differs from the
  no-`columnMovedAt` PR #2360 case above, and production forced the distinction. After the stale-
  status sweep cleared `planning` to null, this exact shape was owned by NOBODY: planning excluded
  it (stamps read as advanced) and `recoverAdvancedTriageTasks` also excluded it, because it bails
  on `workflowIrPinColumnId === "triage"` — it cannot resume a card into the column it already
  occupies. The card sat indefinitely. Arrival order is the honest signal regardless of status.
  */
  {
    label: "triage card with stale stamps and NO status is still plannable (nobody else owns it)",
    task: {
      column: "triage",
      steps: [planStep("step-1")],
      executionStartedAt: "2026-07-26T13:50:57.686Z",
      columnMovedAt: "2026-07-26T14:17:59.396Z",
    },
    stillPlanning: true,
  },
  {
    label: "triage card parked by a reviewer outage after an execution attempt",
    task: {
      column: "triage",
      steps: [planStep("step-1")],
      status: "plan-review-unavailable",
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
    },
    stillPlanning: true,
  },
  {
    label: "plan-in-place todo replan card that already executed once",
    task: {
      column: "todo",
      steps: [planStep("step-1")],
      status: "needs-replan",
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
    },
    stillPlanning: true,
  },
  // A queued todo card with an execution timestamp and no planning status HAS advanced:
  // this is the FN-7977 race where the stamp lands just before the move to in-progress.
  {
    label: "queued todo card stamped with firstExecutionAt just before the dispatch move",
    task: { column: "todo", steps: [], firstExecutionAt: "2026-07-26T04:35:29.068Z" },
    stillPlanning: false,
  },
  {
    label: "queued todo card stamped with executionStartedAt just before the dispatch move",
    task: { column: "todo", steps: [], executionStartedAt: "2026-07-26T04:35:29.068Z" },
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveWorktree: true });
  });

  it("skips the move when the card is already in the replan column (plan-in-place)", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    const target = await moveTaskToReplanColumn(store, { id: "FN-1", column: "todo" });
    expect(target).toBe("todo");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkflowReplan 2026-07-26-11:05:
Symptom (FN-8603): two Plan Review REVISE bounces each logged "Removed conflicting worktree /
Deleted branch / Cleaned up conflicting worktree, retrying" and rebuilt the checkout from scratch
(~10s init each). `moveTask`'s reopen block clears `worktree` but keeps `branch`, so the replan
row lost its checkout while still owning `fusion/<id>` — the next planning acquisition could not
resume, re-created the same branch, and collided with the worktree it had just orphaned.

Surface enumeration — every replan-bounce mover routes through `moveTaskToReplanColumn`, so the
invariant is asserted at that seam for ALL of them, not just the Plan Review repro:
 - Plan Review REVISE -> automatic replan (executor.ts, the reported case)
 - required-workflow-artifact planning recovery (executor.ts)
 - spec-staleness rebound inside execute() (executor.ts)
 - scheduler filesystem-validation and spec-staleness rebounds, legacy loop + workflow sweep
Both replan-column shapes are covered (default Coding "triage" and plan-in-place Coding (Ideas)
"todo"), as is every reopen origin column that `moveTask` treats as a reopen (in-progress,
in-review, done). The already-in-column no-op case cannot strand a worktree because it never
moves.
*/
describe("replan bounces preserve the task worktree (FN-8603)", () => {
  const REPLAN_BOUNCE_ORIGINS = ["in-progress", "in-review", "done"] as const;
  const REPLAN_COLUMN_SHAPES = [
    { workflowId: undefined, expected: "triage", label: "default Coding (triage replan column)" },
    { workflowId: "builtin:coding-ideas", expected: "todo", label: "Coding (Ideas) (plan-in-place todo)" },
  ] as const;

  for (const shape of REPLAN_COLUMN_SHAPES) {
    for (const from of REPLAN_BOUNCE_ORIGINS) {
      it(`preserves the worktree bouncing ${from} -> ${shape.expected} — ${shape.label}`, async () => {
        const store = storeWithSelection(shape.workflowId);
        const target = await moveTaskToReplanColumn(store, { id: "FN-8603", column: from });
        expect(target).toBe(shape.expected);
        expect(store.moveTask).toHaveBeenCalledWith(
          "FN-8603",
          shape.expected,
          expect.objectContaining({ preserveWorktree: true }),
        );
      });
    }
  }

  it("preserves the worktree when the caller pre-resolved the replan column", async () => {
    // The Plan Review REVISE handler resolves the column first so it can log it, then passes
    // it in — that overload must carry the same option as the self-resolving one.
    const store = storeWithSelection(undefined);
    const target = await moveTaskToReplanColumn(store, { id: "FN-8603", column: "in-progress" }, "triage");
    expect(target).toBe("triage");
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-8603",
      "triage",
      expect.objectContaining({ preserveWorktree: true }),
    );
  });
});
