import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { isTaskPopupVisibleForView, TASK_DETAIL_FLOATING_GEOMETRY_KEY } from "../App";
import { FloatingWindow } from "../components/FloatingWindow";
import type { PoppedOutTaskEntry } from "../hooks/usePoppedOutTasks";
import type { TaskView } from "../hooks/useViewState";

function task(id: string): Task {
  return { id, title: id, status: "todo" } as Task;
}

function popupTestId(taskId: string, originTaskView?: TaskView) {
  return `floating-window-task-detail-${taskId}-${originTaskView ?? "global"}`;
}

function PopupGateHarness({ entries, taskView, taskPopupsBoardListOnly }: {
  entries: PoppedOutTaskEntry[];
  taskView: TaskView;
  taskPopupsBoardListOnly: boolean;
}) {
  return <>{entries.filter((entry) => isTaskPopupVisibleForView({ taskPopupsBoardListOnly, taskView, originTaskView: entry.originTaskView })).map(({ task: snapshot, originTaskView }) => {
    const windowKey = `task-detail-${snapshot.id}-${originTaskView ?? "global"}`;
    return <FloatingWindow key={windowKey} windowKey={windowKey} title={snapshot.id} onClose={() => {}} hideHeader dragHandleSelector=".task-detail-content--embedded > .modal-header" className="floating-window--task-detail" persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY} layer="task-detail">
      <div className="task-detail-content--embedded"><div className="modal-header">{snapshot.id}</div></div>
    </FloatingWindow>;
  })}</>;
}

function expectNoTaskPopupShell(taskId: string, originTaskView?: TaskView) {
  const id = popupTestId(taskId, originTaskView);
  expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  expect(screen.queryByTestId(id.replace("floating-window-", "floating-window-overlay-"))).not.toBeInTheDocument();
}

const origins: TaskView[] = ["board", "list", "planning", "agents", "command-center", "missions", "documents", "plugin:sample"];

describe("App task popup view gating", () => {
  it.each(origins)("renders a %s-origin popup only on its origin when scoping is enabled", (originTaskView) => {
    const entry = { task: task(`FN-8016-${originTaskView}`), originTaskView };
    const { rerender } = render(<PopupGateHarness taskView={originTaskView} taskPopupsBoardListOnly entries={[entry]} />);
    expect(screen.getByTestId(popupTestId(entry.task.id, originTaskView))).toBeInTheDocument();

    rerender(<PopupGateHarness taskView="settings" taskPopupsBoardListOnly entries={[entry]} />);
    expectNoTaskPopupShell(entry.task.id, originTaskView);
  });

  it("reproduces the planning-origin symptom and keeps another non-board/list view scoped", () => {
    expect(isTaskPopupVisibleForView({ taskPopupsBoardListOnly: true, taskView: "planning", originTaskView: "planning" })).toBe(true);
    expect(isTaskPopupVisibleForView({ taskPopupsBoardListOnly: true, taskView: "agents", originTaskView: "agents" })).toBe(true);
    expect(isTaskPopupVisibleForView({ taskPopupsBoardListOnly: true, taskView: "agents", originTaskView: "planning" })).toBe(false);
  });

  it("treats legacy undefined-origin snapshots as globally visible", () => {
    render(<PopupGateHarness taskView="planning" taskPopupsBoardListOnly entries={[{ task: task("FN-8016-legacy") }]} />);
    expect(screen.getByTestId(popupTestId("FN-8016-legacy"))).toBeInTheDocument();
  });

  it("unmounts on navigation and remounts the original scoped entry", () => {
    const entry = { task: task("FN-8016-remount"), originTaskView: "planning" as const };
    const { rerender } = render(<PopupGateHarness taskView="planning" taskPopupsBoardListOnly entries={[entry]} />);
    expect(screen.getByTestId(popupTestId(entry.task.id, entry.originTaskView))).toBeInTheDocument();
    rerender(<PopupGateHarness taskView="agents" taskPopupsBoardListOnly entries={[entry]} />);
    expectNoTaskPopupShell(entry.task.id, entry.originTaskView);
    rerender(<PopupGateHarness taskView="planning" taskPopupsBoardListOnly entries={[entry]} />);
    expect(screen.getByTestId(popupTestId(entry.task.id, entry.originTaskView))).toBeInTheDocument();
  });
});
