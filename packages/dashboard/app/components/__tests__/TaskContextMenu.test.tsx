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
    expect(actionIds(makeTask({ column: "triage" }))).toEqual(["delete", "respecify", "pause"]);
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "triage" }), t, columnLabel: columnLabel as any }).shouldShowActionsMenu).toBe(false);

    expect(actionIds(makeTask({ column: "triage", status: "failed" as any }), { canRetryTask: true, hasRetryHandler: true })).toContain("retry");
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "triage", status: "failed" as any }), t, columnLabel: columnLabel as any, canRetryTask: true, hasRetryHandler: true }).shouldShowActionsMenu).toBe(true);

    expect(actionIds(makeTask({ column: "in-review" }), { hasDuplicateHandler: true, hasResetHandler: true, onOpenRefine: vi.fn() })).toEqual([
      "delete",
      "duplicate",
      "refine",
      "respecify",
      "reset",
      "pause",
    ]);
    expect(actionIds(makeTask({ column: "done" }), { hasResetHandler: true, onOpenRefine: vi.fn() })).toEqual(["delete", "refine", "respecify"]);
    expect(actionIds(makeTask({ column: "done" }), { hasResetHandler: true })).toEqual(["delete", "respecify"]);
    expect(actionIds(makeTask({ column: "archived" }), { hasResetHandler: true })).toEqual(["delete", "respecify"]);
  });

  it("exposes pause, unpause, and paused-by-agent note with detail labels", () => {
    const active = buildTaskActionMenuModel({ task: makeTask(), t, columnLabel: columnLabel as any });
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
    expect(buildModel.actions.map((action) => action.id)).toContain("reset");
    expect(buildModel.actions.map((action) => action.id)).toContain("pause");

    const completeModel = buildTaskActionMenuModel({
      task: makeTask({ column: "complete" }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: workflowMoveColumns[3].flags,
      workflowMoveColumns,
      hasResetHandler: true,
      onOpenRefine: vi.fn(),
    });
    expect(completeModel.actions.map((action) => action.id)).toEqual(["delete", "refine", "respecify"]);
    expect(completeModel.moveTransitions.map((action) => action.column)).toEqual(["qa", "cold-storage"]);

    const archivedModel = buildTaskActionMenuModel({
      task: makeTask({ column: "cold-storage" }),
      t,
      columnLabel: columnLabel as any,
      currentColumnFlags: workflowMoveColumns[4].flags,
      workflowMoveColumns,
      hasResetHandler: true,
    });
    expect(archivedModel.actions.map((action) => action.id)).toEqual(["delete", "respecify"]);
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
