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

function PopupGateHarness({
  entries,
  taskView,
  taskPopupsBoardListOnly,
}: {
  entries: PoppedOutTaskEntry[];
  taskView: TaskView;
  taskPopupsBoardListOnly: boolean;
}) {
  return (
    <>
      {entries
        .filter((entry) => isTaskPopupVisibleForView({ taskPopupsBoardListOnly, taskView, originTaskView: entry.originTaskView }))
        .map(({ task: snapshot }) => (
          <FloatingWindow
            key={snapshot.id}
            windowKey={`task-detail-${snapshot.id}`}
            title={snapshot.id}
            onClose={() => {}}
            hideHeader
            dragHandleSelector=".task-detail-content--embedded > .modal-header"
            className="floating-window--task-detail"
            persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY}
            layer="task-detail"
          >
            <div className="task-detail-content--embedded">
              <div className="modal-header">{snapshot.id}</div>
              <div>{snapshot.title}</div>
            </div>
          </FloatingWindow>
        ))}
    </>
  );
}

function expectNoTaskPopupShell(taskId: string) {
  expect(screen.queryByTestId(`floating-window-task-detail-${taskId}`)).not.toBeInTheDocument();
  expect(screen.queryByTestId(`floating-window-overlay-task-detail-${taskId}`)).not.toBeInTheDocument();
}

describe("App task popup view gating", () => {
  it("keeps default/off popups visible regardless of the active view", () => {
    render(
      <PopupGateHarness
        taskView="command-center"
        taskPopupsBoardListOnly={false}
        entries={[{ task: task("FN-7944-A"), originTaskView: "board" }]}
      />,
    );

    expect(screen.getByTestId("floating-window-task-detail-FN-7944-A")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-overlay-task-detail-FN-7944-A")).toBeInTheDocument();
  });

  it("attaches enabled popups to the Board/List view where they were opened", () => {
    const entries: PoppedOutTaskEntry[] = [
      { task: task("FN-7944-board"), originTaskView: "board" },
      { task: task("FN-7944-list"), originTaskView: "list" },
    ];

    const { rerender } = render(<PopupGateHarness taskView="board" taskPopupsBoardListOnly entries={entries} />);

    expect(screen.getByTestId("floating-window-task-detail-FN-7944-board")).toBeInTheDocument();
    expectNoTaskPopupShell("FN-7944-list");

    rerender(<PopupGateHarness taskView="list" taskPopupsBoardListOnly entries={entries} />);

    expectNoTaskPopupShell("FN-7944-board");
    expect(screen.getByTestId("floating-window-task-detail-FN-7944-list")).toBeInTheDocument();
  });

  it("hides all attached popups on non-task views without leaving shells or overlays, then re-shows the same entry", () => {
    const entries: PoppedOutTaskEntry[] = [
      { task: task("FN-7944-board"), originTaskView: "board" },
      { task: task("FN-7944-list"), originTaskView: "list" },
    ];

    const { rerender } = render(<PopupGateHarness taskView="board" taskPopupsBoardListOnly entries={entries} />);
    expect(screen.getByTestId("floating-window-task-detail-FN-7944-board")).toBeInTheDocument();

    rerender(<PopupGateHarness taskView="agents" taskPopupsBoardListOnly entries={entries} />);
    expectNoTaskPopupShell("FN-7944-board");
    expectNoTaskPopupShell("FN-7944-list");

    rerender(<PopupGateHarness taskView="board" taskPopupsBoardListOnly entries={entries} />);
    expect(screen.getByTestId("floating-window-task-detail-FN-7944-board")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-body-task-detail-FN-7944-board")).toHaveTextContent("FN-7944-board");
  });

  it("does not render popups opened away from Board/List when attachment is enabled", () => {
    render(
      <PopupGateHarness
        taskView="command-center"
        taskPopupsBoardListOnly
        entries={[{ task: task("FN-7944-command"), originTaskView: "command-center" }]}
      />,
    );

    expectNoTaskPopupShell("FN-7944-command");
  });
});
