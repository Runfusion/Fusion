import { fireEvent, render, screen } from "@testing-library/react";
import type { Task, TaskDetail } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { DockTaskList } from "../DockTaskList";

vi.mock("../TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail, disableDrag }: { task: Task | TaskDetail; onOpenDetail: (task: Task | TaskDetail) => void; disableDrag?: boolean }) => (
    <button
      type="button"
      data-testid={`mock-task-card-${task.id}`}
      data-disable-drag={String(disableDrag)}
      onClick={() => onOpenDetail(task)}
    >
      {task.title ?? task.id}
    </button>
  ),
}));

/*
FNXC:RightDockTasks 2026-06-28-17:15:
DockTaskList must route TaskCard's own open action to the dock snapshot setter. This explicitly guards against a nested row/card handler split where the card opens the full detail modal while the wrapper also opens the dock detail.
*/
describe("DockTaskList", () => {
  it("renders populated task rows and routes TaskCard opens to onOpenTask", () => {
    const first = { id: "FN-1", title: "First task", column: "todo" } as Task;
    const second = { id: "FN-2", title: "Second task", column: "in-progress" } as Task;
    const onOpenTask = vi.fn();

    render(<DockTaskList tasks={[first, second]} onOpenTask={onOpenTask} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-1")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-2")).toBeInTheDocument();
    expect(screen.getByTestId("mock-task-card-FN-1")).toHaveAttribute("data-disable-drag", "true");

    fireEvent.click(screen.getByTestId("mock-task-card-FN-2"));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith(second);
  });

  it("renders a friendly empty message and no task rows when there are no tasks", () => {
    render(<DockTaskList tasks={[]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByTestId(/dock-task-list-row-/)).toBeNull();
  });
});
