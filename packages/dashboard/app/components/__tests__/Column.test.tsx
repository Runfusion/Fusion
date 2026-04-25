import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Column } from "../Column";
import type { Task, Column as ColumnType } from "@fusion/core";

// Mock child components to keep tests focused on the Column badge behavior
const taskCardRenderSpy = vi.fn();

vi.mock("../TaskCard", () => ({
  TaskCard: React.memo(({ task, workflowStepNameLookup }: { task: Task; workflowStepNameLookup?: ReadonlyMap<string, string> }) => {
    taskCardRenderSpy(task.id);
    return <div data-testid={`task-${task.id}`} data-workflow-lookup-size={String(workflowStepNameLookup?.size ?? 0)} />;
  }),
}));
vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: ({ workflowStepNameLookup }: { workflowStepNameLookup?: ReadonlyMap<string, string> }) => (
    <div data-testid="worktree-group" data-workflow-lookup-size={String(workflowStepNameLookup?.size ?? 0)} />
  ),
}));
vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: ({ favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, autoExpand }: { favoriteProviders?: string[]; favoriteModels?: string[]; onToggleFavorite?: (provider: string) => void; onToggleModelFavorite?: (modelId: string) => void; autoExpand?: boolean }) => (
    <div
      data-testid="quick-entry-box"
      data-favorite-providers={JSON.stringify(favoriteProviders ?? [])}
      data-favorite-models={JSON.stringify(favoriteModels ?? [])}
      data-has-toggle-favorite={onToggleFavorite ? "yes" : "no"}
      data-has-toggle-model-favorite={onToggleModelFavorite ? "yes" : "no"}
      data-auto-expand={autoExpand === false ? "false" : "true"}
    />
  ),
}));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Archive: () => null,
  MoreVertical: () => null,
}));

// Mock usePluginUiSlots hook
const mockUsePluginUiSlots = vi.fn(() => ({
  slots: [],
  getSlotsForId: vi.fn(() => []),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (...args: unknown[]) => mockUsePluginUiSlots(...args),
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

  it("forwards workflowStepNameLookup to task cards", () => {
    render(
      <Column
        {...defaultProps}
        column="todo"
        tasks={[{ ...makeTask("FN-001"), column: "todo" as ColumnType }]}
        workflowStepNameLookup={new Map([["WS-003", "Accessibility Audit"]])}
      />,
    );

    expect(screen.getByTestId("task-FN-001").getAttribute("data-workflow-lookup-size")).toBe("1");
  });

  it("forwards workflowStepNameLookup to in-progress worktree groups", () => {
    render(
      <Column
        {...defaultProps}
        column="in-progress"
        tasks={[{ ...makeTask("FN-001"), column: "in-progress" as ColumnType, worktree: "wt-1" }]}
        workflowStepNameLookup={new Map([["WS-003", "Accessibility Audit"]])}
      />,
    );

    expect(screen.getByTestId("worktree-group").getAttribute("data-workflow-lookup-size")).toBe("1");
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

  it("disables pagination when isSearchActive is true, showing all tasks", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} isSearchActive={true} />);

    // All 110 tasks should be visible — no pagination applied during active search
    expect(screen.getAllByTestId(/task-/)).toHaveLength(110);
    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });

  it("restores pagination when isSearchActive changes back to false", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    const { rerender } = render(<Column {...defaultProps} column="todo" tasks={tasks} isSearchActive={true} />);

    // All tasks visible during search
    expect(screen.getAllByTestId(/task-/)).toHaveLength(110);

    // Search cleared — pagination resumes
    rerender(<Column {...defaultProps} column="todo" tasks={tasks} isSearchActive={false} />);

    expect(screen.getAllByTestId(/task-/)).toHaveLength(50);
    expect(screen.getByRole("button", { name: /Load 25 more/i })).toBeTruthy();
  });

  it("preserves non-search pagination behavior when isSearchActive is not provided", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    // Default (undefined isSearchActive) should still paginate
    expect(screen.getAllByTestId(/task-/)).toHaveLength(50);
    expect(screen.getByRole("button", { name: /Load 25 more/i })).toBeTruthy();
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

  it("passes autoExpand={false} to QuickEntryBox in triage column (collapsed by default)", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} onQuickCreate={vi.fn()} />);
    const quickEntry = screen.getByTestId("quick-entry-box");
    expect(quickEntry.getAttribute("data-auto-expand")).toBe("false");
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

  describe("favorite model prop forwarding (FN-770)", () => {
    it("forwards favoriteProviders, favoriteModels, and toggle callbacks to QuickEntryBox", () => {
      const onToggleFavorite = vi.fn();
      const onToggleModelFavorite = vi.fn();

      render(
        <Column
          {...defaultProps}
          column="triage"
          tasks={[]}
          onQuickCreate={vi.fn().mockResolvedValue({})}
          favoriteProviders={["anthropic"]}
          favoriteModels={["claude-sonnet-4-5"]}
          onToggleFavorite={onToggleFavorite}
          onToggleModelFavorite={onToggleModelFavorite}
        />,
      );

      const quickEntry = screen.getByTestId("quick-entry-box");
      expect(quickEntry.getAttribute("data-favorite-providers")).toBe(JSON.stringify(["anthropic"]));
      expect(quickEntry.getAttribute("data-favorite-models")).toBe(JSON.stringify(["claude-sonnet-4-5"]));
      expect(quickEntry.getAttribute("data-has-toggle-favorite")).toBe("yes");
      expect(quickEntry.getAttribute("data-has-toggle-model-favorite")).toBe("yes");
    });

    it("passes empty favorites when props not provided", () => {
      render(
        <Column
          {...defaultProps}
          column="triage"
          tasks={[]}
          onQuickCreate={vi.fn().mockResolvedValue({})}
        />,
      );

      const quickEntry = screen.getByTestId("quick-entry-box");
      expect(quickEntry.getAttribute("data-favorite-providers")).toBe("[]");
      expect(quickEntry.getAttribute("data-favorite-models")).toBe("[]");
      expect(quickEntry.getAttribute("data-has-toggle-favorite")).toBe("no");
      expect(quickEntry.getAttribute("data-has-toggle-model-favorite")).toBe("no");
    });
  });
});

describe("Column PluginSlot integration", () => {
  it("renders PluginSlot for board-column-footer", () => {
    mockUsePluginUiSlots.mockReturnValue({
      slots: [{ pluginId: "test-plugin", slot: { slotId: "board-column-footer", label: "Column Footer", componentPath: "./test.js" } }],
      getSlotsForId: (id: string) => id === "board-column-footer" ? [{ pluginId: "test-plugin", slot: { slotId: "board-column-footer", label: "Column Footer", componentPath: "./test.js" } }] : [],
      loading: false,
      error: null,
    });
    const { container } = render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[]}
      />,
    );
    // Check that column-body exists
    const columnBody = container.querySelector(".column-body");
    expect(columnBody).not.toBeNull();
    // Check for plugin slot inside column-body (always rendered, even for empty columns)
    const slot = container.querySelector('[data-slot-id="board-column-footer"]');
    expect(slot).not.toBeNull();
    expect(slot).toHaveAttribute("data-plugin-id", "test-plugin");
  });

  it("renders nothing when no plugins register for board-column-footer slot", () => {
    mockUsePluginUiSlots.mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: false,
      error: null,
    });
    const { container } = render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[]}
      />,
    );
    const slot = container.querySelector('[data-slot-id="board-column-footer"]');
    expect(slot).toBeNull();
  });
});
