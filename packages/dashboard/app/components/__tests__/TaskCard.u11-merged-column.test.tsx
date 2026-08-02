/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
TaskCard's planning affordances under the U11 COLUMN SHAPE, where the merged
pre-implementation column keeps the id `todo` and `triage` no longer exists.

This is the shape that made the drift urgent. Every affordance here used to be gated on
`task.column === "triage"`. Land U11's IR on top of that and each comparison silently
becomes false: the delete button, the awaiting-approval controls, the planner badge and
the step list all disappear from planning cards — a green merge and a broken board.

The cards below therefore declare NO legacy id anywhere. They sit in `todo`, carrying the
merged column's traits (intake + hold), which is exactly what a post-U11 board hands the
component.

REVERT CHECK: restore any `task.column === "triage"` comparison and the matching case
fails, because these cards are not in `triage` and never will be again.
*/
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

/** The U11 merged pre-implementation column: id `todo`, intake AND hold. */
const MERGED_PLANNING_FLAGS = { intake: true, hold: true } as const;

function planningTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-U11",
    title: "Planning card",
    // The merged column keeps `todo`; `triage` is gone.
    column: "todo",
    status: undefined,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

describe("TaskCard on the U11 merged planning column", () => {
  it("still offers Delete on a planning card", () => {
    render(
      <TaskCard
        task={planningTask()}
        taskColumnFlags={MERGED_PLANNING_FLAGS}
        onOpenDetail={() => {}}
        onDeleteTask={vi.fn()}
        addToast={() => {}}
      />,
    );
    // Gated on the intake ROLE. Under the old `column === "triage"` form this button
    // vanishes the moment the merged IR lands.
    expect(document.querySelector(".card-delete-btn")).not.toBeNull();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (PR #2566 review — greptile):
  REPLACED by the agent-active case below, which asserts the pulsing badge element.
  The original matched `/planning/i` as TEXT and was not discriminating: before the
  `columnFlags` threading the badge did not render at all, yet the case passed because
  other "Planning" text is present on the card. Same mistake I made in the ListView DOM
  test — matching a word that also appears in chrome.
  */

  it("reads as agent-active from a live planning status on the merged column", () => {
    /*
    FNXC:TaskActivity 2026-08-01-17:53:
    Activity chrome now follows the shared live-agent predicate: a `planning` status card
    glows on the merged lane, while fresh planner logs alone no longer do (a log line is
    not a concurrency slot, and lane counts must never exceed the live-agent population).
    */
    const { container } = render(
      <TaskCard
        task={planningTask({ status: "planning" } as Partial<Task>)}
        taskColumnFlags={MERGED_PLANNING_FLAGS}
        onOpenDetail={() => {}}
        addToast={() => {}}
      />,
    );
    expect(container.querySelector(".pulsing")).not.toBeNull();
  });

  it("does NOT read as agent-active from fresh planner logs alone", () => {
    const { container } = render(
      <TaskCard
        task={planningTask({ recentAgentActivityAt: new Date().toISOString() } as Partial<Task>)}
        taskColumnFlags={MERGED_PLANNING_FLAGS}
        onOpenDetail={() => {}}
        addToast={() => {}}
      />,
    );
    expect(container.querySelector(".pulsing")).toBeNull();
  });

  it("does NOT offer Start on the merged column, which auto-triages", () => {
    /*
    The inversion that made this more than a rename. `showStartAction` was
    `intake && column !== "triage"`; with `triage` deleted that conjunct is vacuously
    true, so a Start button would appear on EVERY planning card. It is now gated on
    `manualIntake`, which the merged column does not carry.
    */
    render(
      <TaskCard
        task={planningTask()}
        taskColumnFlags={MERGED_PLANNING_FLAGS}
        onOpenDetail={() => {}}
        onMoveTask={vi.fn()}
        addToast={() => {}}
      />,
    );
    expect(screen.queryByTestId("card-start-FN-U11")).toBeNull();
  });

  it("DOES offer Start on a manual intake lane", () => {
    // Coding (Ideas)'s "Ideas": intake with autoTriage off, and no hold.
    render(
      <TaskCard
        task={planningTask({ id: "FN-IDEAS", column: "ideas" as Task["column"] })}
        taskColumnFlags={{ intake: true, manualIntake: true }}
        onOpenDetail={() => {}}
        onMoveTask={vi.fn()}
        addToast={() => {}}
      />,
    );
    expect(screen.getByTestId("card-start-FN-IDEAS")).toBeTruthy();
  });
});
