import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { isTaskPopupVisibleForView, TASK_DETAIL_FLOATING_GEOMETRY_KEY } from "../App";
import { FloatingWindow } from "../components/FloatingWindow";
import { usePoppedOutTasks, type PoppedOutTaskEntry } from "../hooks/usePoppedOutTasks";
import type { TaskView } from "../hooks/useViewState";

function task(id: string): Task {
  return { id, title: id, status: "todo" } as Task;
}

function popupTestId(taskId: string, originTaskView?: TaskView) {
  return `floating-window-task-detail-${taskId}-${originTaskView ?? "global"}`;
}

/*
FNXC:TaskPopupViewGating 2026-07-22-13:20:
FN remount-churn fix R7 changed the render contract this harness mirrors: App renders ALL popped-out entries and hides off-origin-view windows via FloatingWindow `hidden` (visibility-based, aria-hidden) instead of filtering the render array. The `isTaskPopupVisibleForView` predicate is unchanged; the assertion for an off-view popup moved from "not in DOM" to "hidden and inert" so the setting's intent (popups do not clutter other views) still holds while the embedded task detail stays mounted.
*/
function PopupGateHarness({ entries, taskView, taskPopupsBoardListOnly }: {
  entries: PoppedOutTaskEntry[];
  taskView: TaskView;
  taskPopupsBoardListOnly: boolean;
}) {
  return <>{entries.map(({ task: snapshot, originTaskView }) => {
    const windowKey = `task-detail-${snapshot.id}-${originTaskView ?? "global"}`;
    const hidden = !isTaskPopupVisibleForView({ taskPopupsBoardListOnly, taskView, originTaskView });
    return <FloatingWindow key={windowKey} windowKey={windowKey} title={snapshot.id} hidden={hidden} onClose={() => {}} hideHeader dragHandleSelector=".task-detail-content--embedded > .modal-header" className="floating-window--task-detail" persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY} layer="task-detail">
      <div className="task-detail-content--embedded"><div className="modal-header">{snapshot.id}</div></div>
    </FloatingWindow>;
  })}</>;
}

function expectHiddenTaskPopupShell(taskId: string, originTaskView?: TaskView) {
  const id = popupTestId(taskId, originTaskView);
  // Hidden, not absent: the window stays mounted (terminal/detail state survives) but is invisible and inert.
  const window = screen.getByTestId(id);
  expect(window).toBeInTheDocument();
  const overlay = screen.getByTestId(id.replace("floating-window-", "floating-window-overlay-"));
  expect(overlay).toHaveAttribute("aria-hidden", "true");
  expect(overlay.className).toContain("floating-window-overlay--hidden");
}

function expectVisibleTaskPopupShell(taskId: string, originTaskView?: TaskView) {
  const id = popupTestId(taskId, originTaskView);
  expect(screen.getByTestId(id)).toBeInTheDocument();
  const overlay = screen.getByTestId(id.replace("floating-window-", "floating-window-overlay-"));
  expect(overlay).not.toHaveAttribute("aria-hidden");
  expect(overlay.className).not.toContain("floating-window-overlay--hidden");
}

/*
FNXC:TaskPopupViewGating 2026-08-01-16:04:
FN-8698 requires Board and List clicks for the same task to address distinct retained popups.
This interaction harness mirrors App's current-view popup callback so it catches any task-ID-only
open or refresh regression while exercising the real FloatingWindow hidden/inert contract.
*/
function BoardListPopupInteractionHarness({ initialTaskView }: { initialTaskView: "board" | "list" }) {
  const [taskView, setTaskView] = useState<TaskView>(initialTaskView);
  const { entries, popOut, close } = usePoppedOutTasks();
  const sharedTask = task("FN-8698");

  return <>
    <button onClick={() => setTaskView("board")}>Show Board</button>
    <button onClick={() => setTaskView("list")}>Show List</button>
    <button onClick={() => popOut(sharedTask, taskView)}>Open current task</button>
    <button onClick={() => close(sharedTask.id, "board")}>Close Board task</button>
    <button onClick={() => close(sharedTask.id, "list")}>Close List task</button>
    <PopupGateHarness entries={entries} taskView={taskView} taskPopupsBoardListOnly />
  </>;
}

const origins: TaskView[] = ["board", "list", "planning", "agents", "command-center", "missions", "documents", "plugin:sample"];

describe("App task popup view gating", () => {
  it.each(origins)("shows a %s-origin popup only on its origin when scoping is enabled, hiding it elsewhere", (originTaskView) => {
    const entry = { task: task(`FN-8016-${originTaskView}`), originTaskView };
    const { rerender } = render(<PopupGateHarness taskView={originTaskView} taskPopupsBoardListOnly entries={[entry]} />);
    expectVisibleTaskPopupShell(entry.task.id, originTaskView);

    rerender(<PopupGateHarness taskView="settings" taskPopupsBoardListOnly entries={[entry]} />);
    expectHiddenTaskPopupShell(entry.task.id, originTaskView);
  });

  it.each([["board", "list"], ["list", "board"]] as const)("opens %s then %s popups independently for the same task and closes each without affecting the other", (firstView, secondView) => {
    render(<BoardListPopupInteractionHarness initialTaskView={firstView} />);

    fireEvent.click(screen.getByRole("button", { name: "Open current task" }));
    expectVisibleTaskPopupShell("FN-8698", firstView);

    fireEvent.click(screen.getByRole("button", { name: secondView === "board" ? "Show Board" : "Show List" }));
    expectHiddenTaskPopupShell("FN-8698", firstView);
    fireEvent.click(screen.getByRole("button", { name: "Open current task" }));
    expectVisibleTaskPopupShell("FN-8698", secondView);
    expectHiddenTaskPopupShell("FN-8698", firstView);

    // Reopening on the current view refreshes its own instance rather than adding a duplicate.
    fireEvent.click(screen.getByRole("button", { name: "Open current task" }));
    expect(screen.getAllByTestId(/floating-window-task-detail-FN-8698-(board|list)$/)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: secondView === "board" ? "Close Board task" : "Close List task" }));
    expect(screen.queryByTestId(popupTestId("FN-8698", secondView))).not.toBeInTheDocument();
    expectHiddenTaskPopupShell("FN-8698", firstView);

    fireEvent.click(screen.getByRole("button", { name: firstView === "board" ? "Show Board" : "Show List" }));
    expectVisibleTaskPopupShell("FN-8698", firstView);
    fireEvent.click(screen.getByRole("button", { name: firstView === "board" ? "Close Board task" : "Close List task" }));
    expect(screen.queryByTestId(popupTestId("FN-8698", firstView))).not.toBeInTheDocument();
  });

  it("keeps independently addressed Board and List popups visible together when view gating is disabled", () => {
    render(<PopupGateHarness
      entries={[
        { task: task("FN-8698"), originTaskView: "board" },
        { task: task("FN-8698"), originTaskView: "list" },
      ]}
      taskView="planning"
      taskPopupsBoardListOnly={false}
    />);

    expectVisibleTaskPopupShell("FN-8698", "board");
    expectVisibleTaskPopupShell("FN-8698", "list");
  });

  it("keeps another non-board/list view scoped", () => {
    expect(isTaskPopupVisibleForView({ taskPopupsBoardListOnly: true, taskView: "planning", originTaskView: "planning" })).toBe(true);
    expect(isTaskPopupVisibleForView({ taskPopupsBoardListOnly: true, taskView: "agents", originTaskView: "planning" })).toBe(false);
  });

  it("treats legacy undefined-origin snapshots as globally visible", () => {
    render(<PopupGateHarness taskView="planning" taskPopupsBoardListOnly entries={[{ task: task("FN-8016-legacy") }]} />);
    expectVisibleTaskPopupShell("FN-8016-legacy");
  });

  it("keeps the same window instance mounted across navigation away and back", () => {
    const entry = { task: task("FN-8016-keepalive"), originTaskView: "planning" as const };
    const { rerender } = render(<PopupGateHarness taskView="planning" taskPopupsBoardListOnly entries={[entry]} />);
    expectVisibleTaskPopupShell(entry.task.id, entry.originTaskView);
    const windowNode = screen.getByTestId(popupTestId(entry.task.id, entry.originTaskView));

    rerender(<PopupGateHarness taskView="agents" taskPopupsBoardListOnly entries={[entry]} />);
    expectHiddenTaskPopupShell(entry.task.id, entry.originTaskView);
    // Same DOM node — the window was hidden, never unmounted.
    expect(screen.getByTestId(popupTestId(entry.task.id, entry.originTaskView))).toBe(windowNode);

    rerender(<PopupGateHarness taskView="planning" taskPopupsBoardListOnly entries={[entry]} />);
    expectVisibleTaskPopupShell(entry.task.id, entry.originTaskView);
    expect(screen.getByTestId(popupTestId(entry.task.id, entry.originTaskView))).toBe(windowNode);
  });
});
