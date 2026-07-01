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
const makeTask = (id: string, title: string, column: string) => ({ id, title, column }) as Task;

describe("DockTaskList", () => {
  it("renders populated active task rows and routes TaskCard opens to onOpenTask", () => {
    const first = makeTask("FN-1", "First task", "todo");
    const second = makeTask("FN-2", "Second task", "in-progress");
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

  it("FN-7250 removes rows when the shared task array drops a deleted id", () => {
    const deleted = makeTask("FN-DELETE", "Deleted task", "todo");
    const kept = makeTask("FN-KEEP", "Kept task", "in-progress");

    const { rerender } = render(<DockTaskList tasks={[deleted, kept]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list-row-FN-DELETE")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-KEEP")).toBeInTheDocument();

    rerender(<DockTaskList tasks={[kept]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.queryByTestId("dock-task-list-row-FN-DELETE")).toBeNull();
    expect(screen.getByTestId("dock-task-list-row-FN-KEEP")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-empty")).toBeNull();
  });

  it("FN-7250 renders the empty state when the only task is deleted", () => {
    const deleted = makeTask("FN-DELETE", "Deleted task", "todo");

    const { rerender } = render(<DockTaskList tasks={[deleted]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list-row-FN-DELETE")).toBeInTheDocument();

    rerender(<DockTaskList tasks={[]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.queryByTestId("dock-task-list-row-FN-DELETE")).toBeNull();
    expect(screen.getByTestId("dock-task-list-empty")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });

  /*
  FNXC:RightDockTasks 2026-06-28-18:38:
  The right-dock Tasks list is active-by-default: done tasks are opt-in via Show Done, archived tasks never appear, and the incoming active/done order is preserved when completed work is shown.
  */
  it("hides done and archived tasks by default, then toggles done tasks without showing archived rows", () => {
    const active = makeTask("FN-ACTIVE", "Active task", "todo");
    const done = makeTask("FN-DONE", "Done task", "done");
    const laterActive = makeTask("FN-LATER", "Later active task", "in-progress");
    const archived = makeTask("FN-ARCHIVED", "Archived task", "archived");
    const onOpenTask = vi.fn();

    render(<DockTaskList tasks={[active, done, laterActive, archived]} onOpenTask={onOpenTask} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list-row-FN-ACTIVE")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-LATER")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();
    expect(screen.queryByTestId("dock-task-list-row-FN-ARCHIVED")).toBeNull();

    const showDone = screen.getByRole("button", { name: "Show Done" });
    expect(showDone).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(showDone);

    expect(screen.getByRole("button", { name: "Hide Done" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("dock-task-list-row-FN-ARCHIVED")).toBeNull();
    expect(screen.getAllByTestId(/dock-task-list-row-/).map((row) => row.getAttribute("data-testid"))).toEqual([
      "dock-task-list-row-FN-ACTIVE",
      "dock-task-list-row-FN-DONE",
      "dock-task-list-row-FN-LATER",
    ]);

    fireEvent.click(screen.getByTestId("mock-task-card-FN-DONE"));
    expect(onOpenTask).toHaveBeenCalledWith(done);

    fireEvent.click(screen.getByRole("button", { name: "Hide Done" }));
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();
    expect(screen.queryByTestId("dock-task-list-row-FN-ARCHIVED")).toBeNull();
  });

  /*
  FNXC:RightDockTasks 2026-06-28-18:42:
  Empty right-dock task states must distinguish a truly empty list from a list whose only rows are completed or archived, so the compact panel never renders blank and the Show Done affordance remains reachable when completed rows exist.
  */
  it("renders distinct empty states for no tasks, only done tasks, and only archived tasks", () => {
    const { rerender } = render(<DockTaskList tasks={[]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-empty")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done/i })).toBeNull();
    expect(screen.queryByTestId(/dock-task-list-row-/)).toBeNull();

    rerender(<DockTaskList tasks={[makeTask("FN-DONE", "Done only", "done")]} onOpenTask={vi.fn()} addToast={vi.fn()} />);
    expect(screen.getByText("No active tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Done" })).toBeInTheDocument();
    expect(screen.getByText(/Archived tasks stay out/i)).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();

    rerender(<DockTaskList tasks={[makeTask("FN-ARCHIVED", "Archived only", "archived")]} onOpenTask={vi.fn()} addToast={vi.fn()} />);
    expect(screen.getByText("No active tasks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done/i })).toBeNull();
    expect(screen.getByText(/Archived tasks stay out/i)).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-ARCHIVED")).toBeNull();
  });

  it("renders duplicate task ids as distinct rows without duplicate React key warnings", () => {
    const duplicateFirst = makeTask("FN-DUP", "Duplicate first", "todo");
    const duplicateSecond = makeTask("FN-DUP", "Duplicate second", "in-progress");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onOpenTask = vi.fn();

    try {
      render(<DockTaskList tasks={[duplicateFirst, duplicateSecond]} onOpenTask={onOpenTask} addToast={vi.fn()} />);

      expect(screen.getAllByTestId("dock-task-list-row-FN-DUP")).toHaveLength(2);
      expect(screen.getByText("Duplicate first")).toBeInTheDocument();
      expect(screen.getByText("Duplicate second")).toBeInTheDocument();
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("Encountered two children with the same key"))).toBe(false);

      fireEvent.click(screen.getByText("Duplicate second"));
      expect(onOpenTask).toHaveBeenCalledWith(duplicateSecond);
    } finally {
      consoleError.mockRestore();
    }
  });
});
