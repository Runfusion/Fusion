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

    const reviewMoves = buildTaskActionMenuModel({ task: makeTask({ column: "in-review" }), t, columnLabel: columnLabel as any }).moveTransitions;
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
