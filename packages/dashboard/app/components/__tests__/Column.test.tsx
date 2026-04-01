import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Column } from "../Column";
import type { Task, Column as ColumnType } from "@fusion/core";

// Mock child components to keep tests focused on the Column badge behavior
const taskCardRenderSpy = vi.fn();

vi.mock("../TaskCard", () => ({
  TaskCard: React.memo(({ task }: { task: Task }) => {
    taskCardRenderSpy(task.id);
    return <div data-testid={`task-${task.id}`} />;
  }),
}));
vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: () => <div />,
}));
vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: () => <div data-testid="quick-entry-box" />,
}));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
}));

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    column: "triage" as ColumnType,
    status: undefined as any,
    steps: [],
    currentStep: 0,
    dependencies: [],
    description: "",
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  taskCardRenderSpy.mockClear();
});

const defaultProps = {
  column: "triage" as ColumnType,
  maxConcurrent: 2,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

describe("Column count-flash", () => {
  it("does not apply count-flash class on initial render", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} />);

    const badge = screen.getByText("1");
    expect(badge.className).toContain("column-count");
    expect(badge.className).not.toContain("count-flash");
  });

  it("applies count-flash class when task count increases", () => {
    const tasks = [makeTask("FN-001")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const moreTasks = [makeTask("FN-001"), makeTask("FN-002")];
    rerender(<Column {...defaultProps} tasks={moreTasks} />);

    const badge = screen.getByText("2");
    expect(badge.className).toContain("count-flash");
  });

  it("does not apply count-flash class when task count decreases", () => {
    const tasks = [makeTask("FN-001"), makeTask("FN-002")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const fewerTasks = [makeTask("FN-001")];
    rerender(<Column {...defaultProps} tasks={fewerTasks} />);

    const badge = screen.getByText("1");
    expect(badge.className).not.toContain("count-flash");
  });
});

describe("Column memoization", () => {
  it("does not re-render task cards when rerendered with the same task references", () => {
    const tasks = [makeTask("FN-001")];
    const props = { ...defaultProps, tasks };

    const { rerender } = render(<Column {...props} />);
    expect(taskCardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<Column {...props} />);

    expect(taskCardRenderSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Column pagination", () => {
  it("shows only the initial page for large non-in-progress columns", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    expect(screen.getAllByTestId(/task-/)).toHaveLength(50);
    expect(screen.getByRole("button", { name: /Load 25 more/i })).toBeTruthy();
  });

  it("loads more tasks on demand", async () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    await userEvent.click(screen.getByRole("button", { name: /Load 25 more/i }));

    expect(screen.getAllByTestId(/task-/)).toHaveLength(75);
  });

  it("preserves pagination across task array updates", async () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    const { rerender } = render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    await userEvent.click(screen.getByRole("button", { name: /Load 25 more/i }));
    expect(screen.getAllByTestId(/task-/)).toHaveLength(75);

    rerender(<Column {...defaultProps} column="todo" tasks={[...tasks]} />);

    expect(screen.getAllByTestId(/task-/)).toHaveLength(75);
  });

  it("clamps visible tasks when a paginated list shrinks", async () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    const { rerender } = render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    await userEvent.click(screen.getByRole("button", { name: /Load 25 more/i }));
    expect(screen.getAllByTestId(/task-/)).toHaveLength(75);

    rerender(<Column {...defaultProps} column="todo" tasks={tasks.slice(0, 60)} />);

    expect(screen.getAllByTestId(/task-/)).toHaveLength(60);
  });

  it("still handles drops when pagination is enabled", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    const onMoveTask = vi.fn().mockResolvedValue({} as Task);
    render(<Column {...defaultProps} column="todo" tasks={tasks} onMoveTask={onMoveTask} />);

    const column = screen.getByText("110").closest(".column") as HTMLElement;
    const dataTransfer = {
      getData: vi.fn().mockReturnValue("KB-999"),
      dropEffect: "move",
    };

    fireEvent.drop(column, { dataTransfer });

    expect(onMoveTask).toHaveBeenCalledWith("KB-999", "todo");
  });

  it("does not paginate at the threshold boundary", () => {
    const tasks = Array.from({ length: 100 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });

  it("does not paginate in-progress columns", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => ({ ...makeTask(`KB-${String(index + 1).padStart(3, "0")}`), column: "in-progress" as ColumnType }));
    render(<Column {...defaultProps} column="in-progress" tasks={tasks} />);

    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });

  it("does not paginate archived columns", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => ({ ...makeTask(`KB-${String(index + 1).padStart(3, "0")}`), column: "archived" as ColumnType }));
    render(<Column {...defaultProps} column="archived" tasks={tasks} collapsed={false} />);

    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });
});

describe("Column QuickEntryBox", () => {
  it("renders QuickEntryBox in triage column when onQuickCreate is provided", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} onQuickCreate={vi.fn()} />);
    expect(screen.getByTestId("quick-entry-box")).toBeTruthy();
  });

  it("does not render QuickEntryBox in triage column when onQuickCreate is not provided", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} />);
    expect(screen.queryByTestId("quick-entry-box")).toBeNull();
  });

  it("does not render QuickEntryBox in non-triage columns", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} column="todo" onQuickCreate={vi.fn()} />);
    expect(screen.queryByTestId("quick-entry-box")).toBeNull();
  });
});

describe("Column same-column drop", () => {
  it("does not call onMoveTask when dropping task into its current column", () => {
    const onMoveTask = vi.fn().mockResolvedValue({} as Task);
    const addToast = vi.fn();
    const tasks = [{ ...makeTask("FN-001"), column: "todo" as ColumnType }];
    
    render(<Column {...defaultProps} column="todo" tasks={tasks} onMoveTask={onMoveTask} addToast={addToast} />);

    const columnEl = screen.getByText("1").closest(".column") as HTMLElement;
    const dataTransfer = {
      getData: vi.fn().mockReturnValue("FN-001"),
      dropEffect: "move",
    };

    fireEvent.drop(columnEl, { dataTransfer });

    expect(onMoveTask).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("removes drag-over styling after drop even on same column", () => {
    const onMoveTask = vi.fn().mockResolvedValue({} as Task);
    const tasks = [{ ...makeTask("FN-001"), column: "todo" as ColumnType }];
    
    render(<Column {...defaultProps} column="todo" tasks={tasks} onMoveTask={onMoveTask} />);

    const columnEl = screen.getByText("1").closest(".column") as HTMLElement;
    const dataTransfer = {
      getData: vi.fn().mockReturnValue("FN-001"),
      dropEffect: "move",
    };

    // First trigger dragOver to set drag-over state
    fireEvent.dragOver(columnEl, { dataTransfer });
    expect(columnEl.className).toContain("drag-over");

    // Then drop - should remove drag-over class even for same-column drop
    fireEvent.drop(columnEl, { dataTransfer });
    expect(columnEl.className).not.toContain("drag-over");
  });

  it("calls onMoveTask when dropping task into a different column", () => {
    const onMoveTask = vi.fn().mockResolvedValue({} as Task);
    const addToast = vi.fn();
    // Task is in "todo" column - but we're dropping it onto "in-review" column
    // The "in-review" column should have 0 tasks initially
    const tasksInTargetColumn: Task[] = [];
    
    // Dropping into "in-review" column (which has 0 tasks)
    render(<Column {...defaultProps} column="in-review" tasks={tasksInTargetColumn} onMoveTask={onMoveTask} addToast={addToast} />);

    const columnEl = screen.getByText("0").closest(".column") as HTMLElement;
    const dataTransfer = {
      getData: vi.fn().mockReturnValue("FN-001"),
      dropEffect: "move",
    };

    fireEvent.drop(columnEl, { dataTransfer });

    expect(onMoveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });
});
