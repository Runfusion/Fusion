import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskContextMenu, buildTaskActionMenuModel } from "../TaskContextMenu";

const t = ((key: string, fallback: string, vars?: Record<string, string>) => {
  if (!vars) return fallback;
  return fallback.replace(/{{(\w+)}}/g, (_, name: string) => vars[name] ?? "");
}) as any;
const columnLabel = (column: string) => column;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7255",
    title: "Context menu task",
    column: "in-progress",
    status: undefined as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

function actionIds(task: Task, overrides: Partial<Parameters<typeof buildTaskActionMenuModel>[0]> = {}): string[] {
  return buildTaskActionMenuModel({ task, t, columnLabel: columnLabel as any, ...overrides }).actions.map((action) => action.id);
}

describe("TaskContextMenu shared task action model", () => {
  it("mirrors detail Actions menu availability across lifecycle states", () => {
    expect(actionIds(makeTask({ column: "triage" }))).toEqual(["respecify", "pause", "delete"]);
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "triage" }), t, columnLabel: columnLabel as any }).shouldShowActionsMenu).toBe(false);

    expect(actionIds(makeTask({ column: "triage", status: "failed" as any }), { canRetryTask: true, hasRetryHandler: true })).toEqual(["respecify", "retry", "pause", "delete"]);
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "triage", status: "failed" as any }), t, columnLabel: columnLabel as any, canRetryTask: true, hasRetryHandler: true }).shouldShowActionsMenu).toBe(true);

    expect(actionIds(makeTask({ column: "in-review" }), { hasDuplicateHandler: true, hasResetHandler: true, onOpenRefine: vi.fn() })).toEqual([
      "duplicate",
      "refine",
      "respecify",
      "pause",
      "reset",
      "delete",
    ]);
    expect(actionIds(makeTask({ column: "done" }), { hasResetHandler: true, onOpenRefine: vi.fn() })).toEqual(["refine", "respecify", "delete"]);
    expect(actionIds(makeTask({ column: "done" }), { hasResetHandler: true })).toEqual(["respecify", "delete"]);
    expect(actionIds(makeTask({ column: "archived" }), { hasResetHandler: true })).toEqual(["delete"]);
  });

  it("exposes Plan only for pre-execution hold columns with a host callback", () => {
    const onPlan = vi.fn();
    const eligibleCases: Array<[string, Partial<Parameters<typeof buildTaskActionMenuModel>[0]>]> = [
      ["triage", {}],
      ["custom intake", { currentColumnFlags: { intake: true } }],
      ["custom hold", { currentColumnFlags: { hold: true } }],
    ];

    for (const [label, overrides] of eligibleCases) {
      const column = label === "triage" ? "triage" : label;
      const model = buildTaskActionMenuModel({
        task: makeTask({ column: column as any }),
        t,
        columnLabel: columnLabel as any,
        onPlan,
        ...overrides,
      });
      expect(model.actions.map((action) => action.id), label).toContain("plan");
      expect(model.actions.find((action) => action.id === "plan")?.label).toBe("Plan");
    }

    for (const column of ["todo", "in-progress", "in-review", "done"] as const) {
      expect(actionIds(makeTask({ column }), { onPlan })).not.toContain("plan");
    }
    expect(actionIds(makeTask({ column: "complete" as any }), { onPlan, currentColumnFlags: { hold: true, complete: true } })).not.toContain("plan");
    expect(actionIds(makeTask({ column: "cold-storage" as any }), { onPlan, currentColumnFlags: { hold: true, archived: true } })).not.toContain("plan");
    expect(actionIds(makeTask({ column: "triage" }))).not.toContain("plan");

    buildTaskActionMenuModel({ task: makeTask({ column: "triage" }), t, columnLabel: columnLabel as any, onPlan }).actions.find((action) => action.id === "plan")?.onSelect?.();
    expect(onPlan).toHaveBeenCalledTimes(1);
  });

  it("exposes GitHub tracking enablement only for untracked tasks with a host callback", () => {
    const onEnableGithubTracking = vi.fn();
    const untracked = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: undefined }),
      t,
      columnLabel: columnLabel as any,
      onEnableGithubTracking,
    });
    const disabled = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: false } as any }),
      t,
      columnLabel: columnLabel as any,
      onEnableGithubTracking,
    });
    const enabled = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: true } as any }),
      t,
      columnLabel: columnLabel as any,
      onEnableGithubTracking,
    });
    const linked = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } as any }),
      t,
      columnLabel: columnLabel as any,
      onEnableGithubTracking,
    });
    const noCallback = buildTaskActionMenuModel({ task: makeTask(), t, columnLabel: columnLabel as any });

    expect(untracked.actions.find((action) => action.id === "enable-github-tracking")?.label).toBe("Enable GitHub tracking");
    expect(untracked.actions.map((action) => action.id)).toEqual(["respecify", "enable-github-tracking", "pause", "delete"]);
    expect(disabled.actions.map((action) => action.id)).toContain("enable-github-tracking");
    expect(enabled.actions.map((action) => action.id)).not.toContain("enable-github-tracking");
    expect(linked.actions.map((action) => action.id)).not.toContain("enable-github-tracking");
    expect(noCallback.actions.map((action) => action.id)).not.toContain("enable-github-tracking");

    untracked.actions.find((action) => action.id === "enable-github-tracking")?.onSelect?.();
    expect(onEnableGithubTracking).toHaveBeenCalledTimes(1);
  });

  it("exposes pause, unpause, and paused-by-agent note with detail labels", () => {
    const active = buildTaskActionMenuModel({ task: makeTask(), t, columnLabel: columnLabel as any });
    expect(active.actions.map((action) => action.id)).toEqual(["respecify", "pause", "delete"]);
    expect(active.actions.find((action) => action.id === "pause")?.label).toBe("Pause");

    const paused = buildTaskActionMenuModel({
      task: makeTask({ paused: true, pausedByAgentId: "agent-1" } as Partial<Task>),
      t,
      columnLabel: columnLabel as any,
    });
    expect(paused.actions.map((action) => [action.id, action.label, action.tone])).toContainEqual([
      "unpause",
      "Unpause",
      undefined,
    ]);
    expect(paused.actions.map((action) => [action.id, action.label, action.tone])).toContainEqual([
      "paused-by-agent",
      "Paused by agent",
      "note",
    ]);
  });

  it("uses VALID_TRANSITIONS and in-review back-to-progress labels for move actions", () => {
    const todoMoves = buildTaskActionMenuModel({ task: makeTask({ column: "todo" }), t, columnLabel: columnLabel as any }).moveTransitions;
    expect(todoMoves.map((action) => action.column)).toEqual(["in-progress", "triage", "archived"]);
    expect(todoMoves.map((action) => action.label)).toEqual(["Move to in-progress", "Move to triage", "Move to archived"]);

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-14:10 (stale expectation from #2521):
    This expected "Back to In Progress" — a display label the PRE-#2521 code hardcoded next to the
    `in-progress` literal. #2521 correctly made the label come from the host's `columnLabel`, and
    this file's stub is `(column) => column`, so the honest output is the raw id. The old
    expectation only ever passed because the label was hardcoded, and it has been RED on main since
    #2521 landed.

    Matching the raw id would satisfy the test while proving nothing, so the label function is made
    display-like for this case instead: the assertion now fails both if the "Back to" prefix
    regresses AND if the label stops routing through `columnLabel`. Strengthened, not relaxed.
    */
    const displayLabel = ((column: string) => (column === "in-progress" ? "In Progress" : column)) as any;
    const reviewMoves = buildTaskActionMenuModel({ task: makeTask({ column: "in-review" }), t, columnLabel: displayLabel }).moveTransitions;
    expect(reviewMoves.map((action) => [action.column, action.label])).toEqual([
      ["todo", "Move to todo"],
      ["in-progress", "Back to In Progress"],
    ]);
  });

  it("derives custom workflow moves and terminal action availability from column metadata", () => {
    const workflowMoveColumns = [
      { id: "intake", label: "Intake", flags: { intake: true } },
      { id: "build", label: "Build", flags: { countsTowardWip: true } },
      { id: "qa", label: "QA", flags: { humanReview: true } },
      { id: "complete", label: "Complete", flags: { complete: true } },
      { id: "cold-storage", label: "Cold Storage", flags: { archived: true } },
    ];

    const buildModel = buildTaskActionMenuModel({
      task: makeTask({ column: "build" }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: workflowMoveColumns[1].flags,
      workflowMoveColumns,
      hasResetHandler: true,
    });
    expect(buildModel.moveTransitions.map((action) => [action.column, action.label])).toEqual([
      ["intake", "Move to Intake"],
      ["qa", "Move to QA"],
    ]);
    expect(buildModel.actions.map((action) => action.id)).toEqual(["respecify", "pause", "reset", "delete"]);
    expect(buildModel.actions.at(-2)?.id).toBe("reset");
    expect(buildModel.actions.at(-1)?.id).toBe("delete");

    const completeModel = buildTaskActionMenuModel({
      task: makeTask({ column: "complete" }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: workflowMoveColumns[3].flags,
      workflowMoveColumns,
      hasResetHandler: true,
      onOpenRefine: vi.fn(),
    });
    expect(completeModel.actions.map((action) => action.id)).toEqual(["refine", "respecify", "delete"]);
    expect(completeModel.actions.map((action) => action.id)).not.toContain("reset");
    expect(completeModel.moveTransitions.map((action) => action.column)).toEqual(["qa", "cold-storage"]);

    const archivedModel = buildTaskActionMenuModel({
      task: makeTask({ column: "cold-storage" }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: workflowMoveColumns[4].flags,
      workflowMoveColumns,
      hasResetHandler: true,
    });
    expect(archivedModel.actions.map((action) => action.id)).toEqual(["delete"]);
    expect(archivedModel.actions.map((action) => action.id)).not.toContain("reset");
  });

  it("mirrors in-review merge and manual PR status actions", () => {
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "in-review" }), t, columnLabel: columnLabel as any }).reviewAction).toMatchObject({
      id: "merge",
      label: "Merge & Close",
    });

    const onMerge = vi.fn();
    const onStartPrReview = vi.fn();
    const startPrReviewAction = buildTaskActionMenuModel({
      task: makeTask({ column: "in-review" }),
      t,
      columnLabel: columnLabel as any,
      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      onMerge,
      onStartPrReview,
    }).reviewAction;
    expect(startPrReviewAction).toMatchObject({ id: "start-pr-review", label: "Start PR Review" });
    startPrReviewAction?.onSelect?.();
    expect(onStartPrReview).toHaveBeenCalledTimes(1);
    expect(onMerge).not.toHaveBeenCalled();

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", prInfo: { status: "open" } as any }),
      t,
      columnLabel: columnLabel as any,
      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      isCheckingPrStatus: true,
    }).reviewAction).toMatchObject({ id: "check-pr-status", label: "Check PR Status", disabled: true });

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", status: "merging-pr" as any }),
      t,
      columnLabel: columnLabel as any,
      prAutomationLabel: "Merging PR…",
    }).reviewAction).toMatchObject({ id: "pr-automation", label: "Merging PR…", disabled: true });
  });

  it("keeps archived delete available without live-only destructive shells", () => {
    const onDelete = vi.fn();
    const archivedModel = buildTaskActionMenuModel({
      task: makeTask({ column: "archived" }),
      t,
      columnLabel: columnLabel as any,
      hasResetHandler: true,
      onReset: vi.fn(),
      onTogglePause: vi.fn(),
      onDelete,
    });

    expect(archivedModel.actions.map((action) => action.id)).toEqual(["delete"]);
    expect(archivedModel.actions.map((action) => action.id)).not.toContain("pause");
    expect(archivedModel.actions.map((action) => action.id)).not.toContain("reset");
    archivedModel.actions.find((action) => action.id === "delete")?.onSelect?.();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("renders descriptors and delegates selection to injected host handlers", () => {
    const onDelete = vi.fn();
    const onActionSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[{ id: "delete", label: "Delete", tone: "danger", onSelect: onDelete }]}
        onActionSelect={onActionSelect}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onActionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("selects enabled touch menu items on pointer release exactly once", () => {
    const onPause = vi.fn();
    const onActionSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[
          { id: "pause", label: "Pause", onSelect: onPause },
          { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
          { id: "note", label: "Paused by agent", tone: "note", disabled: true, onSelect: vi.fn() },
        ]}
        onActionSelect={onActionSelect}
      />,
    );

    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Pause" }), { pointerType: "touch", pointerId: 1 });

    expect(onActionSelect).toHaveBeenCalledTimes(1);
    expect(onActionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "pause" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "Disabled" })).toBeDisabled();
    expect(screen.getByText("Paused by agent")).toHaveAttribute("role", "note");
  });

  it("focuses the first enabled action and supports arrow-key roving", () => {
    render(
      <TaskContextMenu
        actions={[
          { id: "disabled", label: "Disabled", disabled: true },
          { id: "pause", label: "Pause" },
          { id: "delete", label: "Delete", tone: "danger" },
        ]}
      />,
    );

    const pause = screen.getByRole("menuitem", { name: "Pause" });
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(pause).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(del).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(pause).toHaveFocus();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-10:20 (PR #2626 review — greptile P2):
The intake-only vs intake+hold distinction, covered per workflow SHAPE rather than per column id.

`shouldShowActionsMenu` suppresses the menu only for a PURE intake lane. That distinction is the
whole point of the conversion and it was asserted only through the legacy `triage` id, which cannot
express either post-U11 shape: a merged Planning column carries both traits, and Coding (Ideas)
carries intake alone on a non-legacy id. A later predicate change could restore the unwanted Ideas
menu or hide actions on Planning cards with nothing failing.
*/
describe("shouldShowActionsMenu by workflow shape (not by column id)", () => {
  const model = (column: string, flags: Record<string, boolean>) =>
    buildTaskActionMenuModel({
      task: makeTask({ column: column as never }),
      t,
      columnLabel: columnLabel as never,
      currentColumnFlags: flags as never,
    }).shouldShowActionsMenu;

  it("SUPPRESSES the menu on a Coding (Ideas) capture — intake with no hold, non-legacy id", () => {
    // `ideas` is not the legacy intake id, so only the trait can answer. A bare captured idea has
    // no actions worth offering yet, which is the case the original guard existed for.
    expect(model("ideas", { intake: true })).toBe(false);
  });

  it("SHOWS the menu on a merged Planning column — intake AND hold", () => {
    // Post-U11 the default Planning column carries both traits. Cards rest here waiting for
    // capacity and do have real actions, so suppressing would remove affordances that existed
    // when this was the separate `todo` lane.
    expect(model("todo", { intake: true, hold: true })).toBe(true);
  });

  it("SHOWS the menu on a hold-only lane, as the pre-merge `todo` column did", () => {
    expect(model("todo", { hold: true })).toBe(true);
  });

  it("SUPPRESSES on a RENAMED pure-intake lane, proving no id is consulted", () => {
    // The assertion that fails if anyone reintroduces an id comparison: `backlog` matches no
    // legacy literal, so a correct answer here can only come from the trait.
    expect(model("backlog", { intake: true })).toBe(false);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:00 (U12 — the last `triage` column guard):
THE INVERSION. `isPreExecutionHoldColumn` ORed the legacy id with the traits unconditionally, so a
resolved column merely NAMED `triage` answered true even when its own traits said work was underway
— offering Plan, which re-plans, on a card that is already executing.

The existing cases here all pass a column with no flags or with hold/intake set, so every one of them
agrees under both the old and new form. That is why this defect survived the file's earlier
conversion: nothing exercised a resolved column whose name and traits disagree.

REVERT CHECK: restore the `column === "triage" ||` prefix and the first case fails — Plan reappears
on a mid-flight card.
*/
describe("pre-execution hold resolves traits, not the column's name", () => {
  it("does NOT treat a mid-flight column NAMED `triage` as a planning target", () => {
    const model = buildTaskActionMenuModel({
      task: makeTask({ column: "triage" }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: { intake: false, hold: false, countsTowardWip: true } as any,
      onPlan: vi.fn(),
    } as never);
    expect(model.actions.map((a: { id: string }) => a.id)).not.toContain("plan");
  });

  it("still offers Plan on a RENAMED hold column", () => {
    // The narrowing guard: traits decide, so a board that never uses the legacy name still works.
    const model = buildTaskActionMenuModel({
      task: makeTask({ column: "backlog" as never }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: { intake: true, hold: true } as any,
      onPlan: vi.fn(),
    } as never);
    expect(model.actions.map((a: { id: string }) => a.id)).toContain("plan");
  });

  it("keeps the flagless degraded answer for `triage` and withholds it for flagless `todo`", () => {
    /*
    The asymmetry the file documents: with no flags, `triage` is the only pre-execution hold. A
    flagless `todo` must NOT offer Plan, because re-planning an already-planned card is not
    recoverable by the operator.
    */
    const forColumn = (column: string) =>
      buildTaskActionMenuModel({ task: makeTask({ column: column as never }), t, columnLabel: columnLabel as any, onPlan: vi.fn() } as never)
        .actions.map((a: { id: string }) => a.id);
    expect(forColumn("triage")).toContain("plan");
    expect(forColumn("todo")).not.toContain("plan");
  });
});
