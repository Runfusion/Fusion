import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task, TaskDetail } from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockTaskList } from "../DockTaskList";

/*
FNXC:RightDockTasks 2026-07-22-12:05:
The mock records each TaskCard mount so tests can assert row identity stability: reorders, filter toggles, and status changes must not remount surviving cards (the old `${id}-${index}` key did).
*/
const { taskCardMountLog } = vi.hoisted(() => ({ taskCardMountLog: [] as string[] }));

vi.mock("../TaskCard", () => ({
  TaskCard: ({ task, taskColumnFlags, onOpenDetail, onDeleteTask, onReviseTask }: { task: Task | TaskDetail; taskColumnFlags?: { complete?: boolean }; onOpenDetail: (task: Task | TaskDetail) => void; onDeleteTask?: (id: string) => Promise<Task>; onReviseTask?: (task: Task) => void }) => {
    useEffect(() => {
      taskCardMountLog.push(task.id);
    }, []);
    return (
      <button
        type="button"
        data-testid={`mock-task-card-${task.id}`}
        data-has-delete={String(Boolean(onDeleteTask))}
        data-complete={String(taskColumnFlags?.complete === true)}
        onClick={() => onOpenDetail(task)}
      >
        {task.title ?? task.id}
        {onReviseTask ? <span data-testid={`mock-task-card-revise-${task.id}`} onClick={(event) => { event.stopPropagation(); onReviseTask(task as Task); }}>Revise</span> : null}
      </button>
    );
  },
}));

/*
FNXC:RightDockTasks 2026-06-28-17:15:
DockTaskList must route TaskCard's own open action to the dock snapshot setter. This explicitly guards against a nested row/card handler split where the card opens the full detail modal while the wrapper also opens the dock detail.
*/
const makeTask = (id: string, title: string, column: string) => ({ id, title, column }) as Task;

describe("DockTaskList", () => {
  beforeEach(() => {
    taskCardMountLog.length = 0;
  });

  /*
  FNXC:RightDockTasks 2026-07-22-12:05:
  Regression coverage for the `${id}-${index}` volatile-key bug: any reorder, membership change, or status change remounted every surviving card.
  */
  it("keeps TaskCard identity across list reorders and status changes", () => {
    const first = makeTask("FN-1", "First task", "todo");
    const second = makeTask("FN-2", "Second task", "in-progress");

    const { rerender } = render(<DockTaskList tasks={[first, second]} onOpenTask={vi.fn()} addToast={vi.fn()} />);
    expect(taskCardMountLog).toEqual(["FN-1", "FN-2"]);

    rerender(<DockTaskList tasks={[makeTask("FN-2", "Second task", "in-review"), first]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.getAllByTestId(/dock-task-list-row-/).map((row) => row.getAttribute("data-testid"))).toEqual([
      "dock-task-list-row-FN-2",
      "dock-task-list-row-FN-1",
    ]);
    expect(taskCardMountLog).toEqual(["FN-1", "FN-2"]);
  });

  it("keeps surviving TaskCard identity when membership changes via the Show Done toggle", () => {
    const active = makeTask("FN-ACTIVE", "Active task", "todo");
    const done = makeTask("FN-DONE", "Done task", "done");

    render(<DockTaskList tasks={[active, done]} onOpenTask={vi.fn()} addToast={vi.fn()} />);
    expect(taskCardMountLog).toEqual(["FN-ACTIVE"]);

    fireEvent.click(screen.getByRole("button", { name: "Show Done" }));
    expect(taskCardMountLog).toEqual(["FN-ACTIVE", "FN-DONE"]);

    fireEvent.click(screen.getByRole("button", { name: "Hide Done" }));
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();
    expect(taskCardMountLog).toEqual(["FN-ACTIVE", "FN-DONE"]);
  });

  /*
  FNXC:TaskDeletion 2026-07-12-00:00:
  The reported inert delete localized to the right-dock Tasks list host: it rendered TaskCard without onDeleteTask, so that surface could not enter the shared confirm→delete flow while board/list/detail hosts were wired.
  */
  it("threads delete into right-dock TaskCards so the delete affordance can enter the shared flow", () => {
    const task = makeTask("FN-DELETE", "Delete from right dock", "triage");
    const onDeleteTask = vi.fn(async () => task);

    render(<DockTaskList tasks={[task]} onOpenTask={vi.fn()} onDeleteTask={onDeleteTask} addToast={vi.fn()} />);

    expect(screen.getByTestId("mock-task-card-FN-DELETE")).toHaveAttribute("data-has-delete", "true");
  });

  it("renders populated active task rows and routes TaskCard opens to onOpenTask", () => {
    const first = makeTask("FN-1", "First task", "todo");
    const second = makeTask("FN-2", "Second task", "in-progress");
    const onOpenTask = vi.fn();

    render(<DockTaskList tasks={[first, second]} onOpenTask={onOpenTask} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-1")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-2")).toBeInTheDocument();
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
  The right-dock Tasks list is active-by-default: completed tasks are opt-in via Show Done, and the incoming active/done order is preserved when completed work is shown.
  */
  it("hides completed tasks by default, then toggles them without changing row order", () => {
    const active = makeTask("FN-ACTIVE", "Active task", "todo");
    const done = makeTask("FN-DONE", "Done task", "done");
    const laterActive = makeTask("FN-LATER", "Later active task", "in-progress");
    const onOpenTask = vi.fn();

    render(<DockTaskList tasks={[active, done, laterActive]} onOpenTask={onOpenTask} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list-row-FN-ACTIVE")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-LATER")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();

    const showDone = screen.getByRole("button", { name: "Show Done" });
    expect(showDone).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(showDone);

    expect(screen.getByRole("button", { name: "Hide Done" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId(/dock-task-list-row-/).map((row) => row.getAttribute("data-testid"))).toEqual([
      "dock-task-list-row-FN-ACTIVE",
      "dock-task-list-row-FN-DONE",
      "dock-task-list-row-FN-LATER",
    ]);

    fireEvent.click(screen.getByTestId("mock-task-card-FN-DONE"));
    expect(onOpenTask).toHaveBeenCalledWith(done);

    fireEvent.click(screen.getByRole("button", { name: "Hide Done" }));
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();
  });

  /*
  FNXC:RightDockTasks 2026-06-28-18:42:
  Empty right-dock task states must distinguish a truly empty list from a list whose only rows are completed, so the compact panel never renders blank and the Show Done affordance remains reachable when completed rows exist.
  */
  it("renders reverted complete work as an ordinary dock row with revise", () => {
    const reverted = {
      ...makeTask("FN-REVERTED", "Cancelled task", "shipped"),
      description: "first line\nsecond line",
      sourceMetadata: { revertedAt: "2026-08-01T00:00:00.000Z" },
    } as Task;
    const onReviseTask = vi.fn();

    render(
      <DockTaskList
        tasks={[reverted, reverted]}
        columnFlagsByTaskId={new Map([[reverted.id, { complete: true }]])}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onReviseTask={onReviseTask}
        addToast={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("dock-reverted-tasks")).toBeNull();
    expect(screen.queryByTestId("dock-task-list-row-FN-REVERTED")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Done" }));
    expect(screen.getAllByTestId("dock-task-list-row-FN-REVERTED")).toHaveLength(1);
    expect(screen.getByTestId("mock-task-card-FN-REVERTED")).toHaveAttribute("data-complete", "true");
    fireEvent.click(screen.getByTestId("mock-task-card-revise-FN-REVERTED"));
    expect(onReviseTask).toHaveBeenCalledWith(reverted);
  });

  it("renders distinct empty states for no tasks and only completed tasks", () => {
    const { rerender } = render(<DockTaskList tasks={[]} onOpenTask={vi.fn()} addToast={vi.fn()} />);

    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-empty")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done/i })).toBeNull();
    expect(screen.queryByTestId(/dock-task-list-row-/)).toBeNull();

    rerender(<DockTaskList tasks={[makeTask("FN-DONE", "Done only", "done")]} onOpenTask={vi.fn()} addToast={vi.fn()} />);
    expect(screen.getByText("No active tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Done" })).toBeInTheDocument();
    expect(screen.getByText("Completed tasks are hidden until you choose Show Done.")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();
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
