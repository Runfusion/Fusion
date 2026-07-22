import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Column } from "../Column";
import type { Task, Column as ColumnType } from "@fusion/core";

// Mock child components to keep tests focused on the Column badge behavior
const taskCardRenderSpy = vi.fn();

vi.mock("../TaskCard", () => ({
  TaskCard: React.memo(({ task, onPromote, isPromoting }: { task: Task; onPromote?: (taskId: string) => Promise<void>; isPromoting?: boolean }) => {
    taskCardRenderSpy(task.id);
    return (
      <div data-testid={`task-${task.id}`}>
        {onPromote && (
          <button type="button" data-testid={`card-promote-${task.id}`} disabled={isPromoting} onClick={() => void onPromote(task.id)}>
            {isPromoting ? "Promoting…" : "Promote"}
          </button>
        )}
      </div>
    );
  }),
}));
vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: ({ label, activeTasks, queuedTasks }: { label: string; activeTasks: Task[]; queuedTasks: Task[] }) => (
    <div data-testid="worktree-group" data-label={label} data-active-count={activeTasks.length} data-queued-count={queuedTasks.length}>
      <span>{label}</span>
      {activeTasks.map((task) => <div key={task.id} data-testid={`group-active-${task.id}`}>{task.id}</div>)}
      {queuedTasks.map((task) => <div key={task.id} data-testid={`group-queued-${task.id}`}>{task.id}</div>)}
    </div>
  ),
}));
vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: ({ favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, autoExpand, onCreate }: { favoriteProviders?: string[]; favoriteModels?: string[]; onToggleFavorite?: (provider: string) => void; onToggleModelFavorite?: (modelId: string) => void; autoExpand?: boolean; onCreate?: (input: { description: string }) => void }) => (
    <div
      data-testid="quick-entry-box"
      data-favorite-providers={JSON.stringify(favoriteProviders ?? [])}
      data-favorite-models={JSON.stringify(favoriteModels ?? [])}
      data-has-toggle-favorite={onToggleFavorite ? "yes" : "no"}
      data-has-toggle-model-favorite={onToggleModelFavorite ? "yes" : "no"}
      data-auto-expand={autoExpand === false ? "false" : "true"}
    >
      <button type="button" onClick={() => onCreate?.({ description: "Quick task" })}>create</button>
    </div>
  ),
}));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Archive: () => null,
  MoreVertical: () => null,
  AlertTriangle: () => null,
}));

// Mock usePluginUiSlots hook
const mockUsePluginUiSlots = vi.fn((_projectId?: string) => ({
  slots: [] as import("../../api").PluginUiSlotEntry[],
  getSlotsForId: vi.fn((_slotId: string) => [] as import("../../api").PluginUiSlotEntry[]),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (projectId?: string) => mockUsePluginUiSlots(projectId),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
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
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

const defaultProps = {
  column: "triage" as ColumnType,
  maxConcurrent: 2,
  showWorktreeGrouping: false,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

describe("Column count-flash", () => {
  it("does not apply count-flash class on initial render", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} />);

    // Badge is active/total (0/1 for triage without a live planner).
    const badge = screen.getByText("1").parentElement!;
    expect(badge.className).toContain("column-count");
    expect(badge.className).not.toContain("count-flash");
    expect(badge).toHaveTextContent("0/1");
  });

  it("applies count-flash class when task count increases", () => {
    const tasks = [makeTask("FN-001")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const moreTasks = [makeTask("FN-001"), makeTask("FN-002")];
    rerender(<Column {...defaultProps} tasks={moreTasks} />);

    const badge = screen.getByText("2").parentElement!;
    expect(badge.className).toContain("count-flash");
    expect(badge).toHaveTextContent("0/2");
  });

  it("does not apply count-flash class when task count decreases", () => {
    const tasks = [makeTask("FN-001"), makeTask("FN-002")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const fewerTasks = [makeTask("FN-001")];
    rerender(<Column {...defaultProps} tasks={fewerTasks} />);

    const badge = screen.getByText("1").parentElement!;
    expect(badge.className).not.toContain("count-flash");
  });

  it("shows accurate executing/total for WIP (unpaused active over card total)", () => {
    const tasks = [
      { ...makeTask("FN-001"), column: "in-progress" as ColumnType },
      { ...makeTask("FN-002"), column: "in-progress" as ColumnType },
      { ...makeTask("FN-003"), column: "in-progress" as ColumnType, paused: true },
      { ...makeTask("FN-004"), column: "in-progress" as ColumnType, userPaused: true },
    ];
    render(
      <Column
        {...defaultProps}
        column={"in-progress" as ColumnType}
        columnFlags={{ countsTowardWip: true }}
        tasks={tasks}
      />,
    );

    expect(screen.getByLabelText("2 executing of 4")).toHaveTextContent("2/4");
  });

  it("counts only live planners as executing in todo (queued is not executing)", () => {
    const tasks = [
      { ...makeTask("FN-001"), column: "todo" as ColumnType, status: "planning" as any },
      { ...makeTask("FN-002"), column: "todo" as ColumnType, status: "queued" as any },
      { ...makeTask("FN-003"), column: "todo" as ColumnType, status: "queued" as any },
      { ...makeTask("FN-004"), column: "todo" as ColumnType, status: "queued" as any },
    ];
    render(
      <Column
        {...defaultProps}
        column={"todo" as ColumnType}
        columnFlags={{ hold: true }}
        tasks={tasks}
      />,
    );

    expect(screen.getByLabelText("1 executing of 4")).toHaveTextContent("1/4");
  });
});

/*
FNXC:CodingIdeasWorkflow 2026-07-21-23:42:
Coding (Ideas) uses the canonical non-legacy `ideas` intake ID. Cover empty and
populated real Column markup here because Board selected/aggregate views and Lane
all compose this shared renderer; duplicate consumer tests would not add another path.
*/
describe("Column Coding (Ideas) header indicator", () => {
  it.each([
    ["empty", []],
    ["populated", [{ ...makeTask("FN-IDEA-1"), column: "ideas" as ColumnType }]],
  ])("renders one Ideas dot before the heading for a %s intake column", (_state, tasks) => {
    render(
      <Column
        {...defaultProps}
        column={"ideas" as ColumnType}
        workflowMode
        columnDisplayName="Ideas"
        columnFlags={{ intake: true }}
        tasks={tasks}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Ideas", level: 2 });
    const header = heading.closest(".column-header");
    expect(header?.querySelectorAll(".column-dot.dot-ideas")).toHaveLength(1);
    expect(heading.previousElementSibling).toHaveClass("column-dot", "dot-ideas");
  });

  it("maps the canonical Ideas dot to the shared triage token", () => {
    const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
    expect(css).toMatch(/\.dot-ideas\s*\{\s*background:\s*var\(--triage\);\s*\}/);
  });
});

/*
FNXC:BoardColumnDescriptions 2026-07-21-00:00:
Todo and In Review omit redundant readiness prose, and the shared Column renderer
must leave no empty description shell across desktop/mobile and task-data states.
*/
describe("Column legacy descriptions", () => {
  it.each([
    ["Todo", "todo" as ColumnType, "Specified and ready to start"],
    ["In Review", "in-review" as ColumnType, "Complete — ready to merge"],
  ])("omits the description shell for an empty %s column", (label, column, removedDescription) => {
    render(<Column {...defaultProps} column={column} tasks={[]} />);

    expect(screen.getByRole("heading", { name: label, level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(removedDescription)).not.toBeInTheDocument();
    expect(document.querySelector(".column-desc")).toBeNull();
  });

  it.each([
    ["Todo", "todo" as ColumnType, "Specified and ready to start"],
    ["In Review", "in-review" as ColumnType, "Complete — ready to merge"],
  ])("omits the description shell for a populated %s column", (label, column, removedDescription) => {
    render(<Column {...defaultProps} column={column} tasks={[{ ...makeTask("FN-8480"), column }]} />);

    expect(screen.getByRole("heading", { name: label, level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(removedDescription)).not.toBeInTheDocument();
    expect(document.querySelector(".column-desc")).toBeNull();
  });

  it("retains the description for Planning", () => {
    render(<Column {...defaultProps} tasks={[]} />);

    expect(screen.getByText("Raw ideas — AI will plan these")).toHaveClass("column-desc");
  });
});

describe("Column workflow mode (U9)", () => {
  it("uses the workflow column display name instead of the legacy label", () => {
    render(
      <Column
        {...defaultProps}
        column={"custom-col" as ColumnType}
        workflowMode
        columnDisplayName="Planning Hold"
        columnFlags={{ hold: true }}
        tasks={[]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Planning Hold");
  });

  it("re-keys bulk actions to trait flags (a wip column gets the processing menu)", () => {
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        onPauseTask={vi.fn()}
        tasks={[{ ...makeTask("FN-1"), column: "exec" as ColumnType }]}
      />,
    );
    // The processing-column actions button (column-menu) is present.
    expect(document.querySelector(".column-menu")).not.toBeNull();
  });

  it("surfaces a translated rejection messageKey on a failed drop (snap-back)", async () => {
    const addToast = vi.fn();
    const onMoveTask = vi.fn().mockRejectedValue({
      details: { code: "merge-blocked", messageKey: "board.rejection.mergeBlocked", retryable: false },
    });
    render(
      <Column
        {...defaultProps}
        column={"done" as ColumnType}
        workflowMode
        columnDisplayName="Done"
        columnFlags={{ complete: true }}
        addToast={addToast}
        onMoveTask={onMoveTask}
        tasks={[]}
      />,
    );
    const columnEl = document.querySelector('[data-column="done"]') as HTMLElement;
    fireEvent.drop(columnEl, { dataTransfer: { getData: () => "FN-99" } });
    await waitFor(() => expect(addToast).toHaveBeenCalled());
    // The toast surfaces the translated merge-blocked copy (not the raw key).
    expect(addToast.mock.calls[0][0]).toContain("merge step");
    expect(addToast.mock.calls[0][1]).toBe("error");
  });

  it("renders a Promote affordance on hold-column cards", () => {
    render(
      <Column
        {...defaultProps}
        column={"hold-col" as ColumnType}
        workflowMode
        columnDisplayName="Hold"
        columnFlags={{ hold: true }}
        onPromote={vi.fn().mockResolvedValue(undefined)}
        tasks={[{ ...makeTask("FN-7"), column: "hold-col" as ColumnType }]}
      />,
    );
    expect(screen.getByTestId("card-promote-FN-7")).toBeDefined();
  });

  it("#1410: clears the inline capacity banner when the task list changes via SSE", async () => {
    const onPromote = vi.fn().mockRejectedValue({
      details: { code: "capacity-exhausted", retryable: true },
    });
    const holdTask = { ...makeTask("FN-7"), column: "hold-col" as ColumnType };
    const { rerender } = render(
      <Column
        {...defaultProps}
        column={"hold-col" as ColumnType}
        workflowMode
        columnDisplayName="Hold"
        columnFlags={{ hold: true }}
        onPromote={onPromote}
        tasks={[holdTask]}
      />,
    );

    // Trigger a capacity-exhausted promote → inline banner appears.
    fireEvent.click(screen.getByTestId("card-promote-FN-7"));
    await waitFor(() => expect(screen.getByTestId("column-inline-feedback")).toBeDefined());
    expect(screen.getByTestId("column-inline-feedback").textContent).toContain("capacity");

    // An SSE-driven task list change (occupant moved out) re-renders the column
    // with a different roster → the stale banner is cleared.
    rerender(
      <Column
        {...defaultProps}
        column={"hold-col" as ColumnType}
        workflowMode
        columnDisplayName="Hold"
        columnFlags={{ hold: true }}
        onPromote={onPromote}
        tasks={[{ ...makeTask("FN-8"), column: "hold-col" as ColumnType }]}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("column-inline-feedback")).toBeNull());
  });
});

describe("Column worktree grouping setting", () => {
  it("renders legacy in-progress columns as plain cards when the setting is off", () => {
    const assigned = { ...makeTask("FN-001"), column: "in-progress" as ColumnType, worktree: "/repo/.worktrees/amber-finch" };
    render(<Column {...defaultProps} column="in-progress" tasks={[assigned]} allTasks={[assigned]} />);

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.queryByText("amber-finch")).toBeNull();
    expect(screen.getByTestId("task-FN-001")).toBeInTheDocument();
  });

  it("groups legacy in-progress tasks by worktree when the setting is on", () => {
    const assigned = { ...makeTask("FN-001A"), column: "in-progress" as ColumnType, worktree: "/repo/.worktrees/amber-finch" };
    render(<Column {...defaultProps} column="in-progress" showWorktreeGrouping tasks={[assigned]} allTasks={[assigned]} />);

    expect(screen.getByTestId("worktree-group")).toHaveAttribute("data-label", "amber-finch");
    expect(screen.getByTestId("group-active-FN-001A")).toBeInTheDocument();
    expect(screen.queryByTestId("task-FN-001A")).toBeNull();
  });

  it("renders workflow processing columns as plain cards when the setting is off", () => {
    const assigned = { ...makeTask("FN-002"), column: "exec" as ColumnType, worktree: "/repo/.worktrees/workflow-wren" };
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        tasks={[assigned]}
        allTasks={[assigned]}
      />,
    );

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.queryByText("workflow-wren")).toBeNull();
    expect(screen.getByTestId("task-FN-002")).toBeInTheDocument();
  });

  it("groups workflow processing tasks by worktree when the setting is on", () => {
    const assigned = { ...makeTask("FN-003"), column: "exec" as ColumnType, worktree: "/repo/.worktrees/workflow-hawk" };
    const unassigned = { ...makeTask("FN-004"), column: "exec" as ColumnType };
    const queued = { ...makeTask("FN-005"), column: "todo" as ColumnType };
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping
        tasks={[assigned, unassigned]}
        allTasks={[assigned, unassigned, queued]}
      />,
    );

    expect(screen.getByText("workflow-hawk")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByText("Up Next")).toBeInTheDocument();
    expect(screen.getByTestId("group-active-FN-003")).toBeInTheDocument();
    expect(screen.getByTestId("group-active-FN-004")).toBeInTheDocument();
    expect(screen.getByTestId("group-queued-FN-005")).toBeInTheDocument();
    expect(screen.queryByTestId("task-FN-003")).toBeNull();
  });

  it("does not leave worktree shells in empty processing columns", () => {
    const { rerender } = render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping
        tasks={[]}
        allTasks={[]}
      />,
    );

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.getByText("No tasks")).toBeInTheDocument();

    rerender(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping={false}
        tasks={[]}
        allTasks={[]}
      />,
    );

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.getByText("No tasks")).toBeInTheDocument();
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

    expect(onMoveTask).toHaveBeenCalledWith("KB-999", "todo", undefined);
  });

  it("does not paginate at the threshold boundary", () => {
    const tasks = Array.from({ length: 100 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(3, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} />);

    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });

  it("does not paginate grouped in-progress columns", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => ({ ...makeTask(`KB-${String(index + 1).padStart(3, "0")}`), column: "in-progress" as ColumnType }));
    render(<Column {...defaultProps} column="in-progress" showWorktreeGrouping tasks={tasks} />);

    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });

  it("does not paginate archived columns", () => {
    const tasks = Array.from({ length: 110 }, (_, index) => ({ ...makeTask(`KB-${String(index + 1).padStart(3, "0")}`), column: "archived" as ColumnType }));
    render(<Column {...defaultProps} column="archived" tasks={tasks} collapsed={false} />);

    expect(screen.queryByRole("button", { name: /Load 25 more/i })).toBeNull();
  });

  /*
  FNXC:ArchivePagination 2026-07-08-00:00:
  FN-7659 — the Archived column's server-backed "Show more" is a distinct
  affordance from the client-side Load-more button covered above: it renders
  only when `archivedHasMore` is true, is absent for an empty/under-one-page
  archive, and invokes `onLoadMoreArchived` (not the client-side visible-count
  bump) when clicked.
  */
  describe("archived pagination (FN-7659)", () => {
    const archivedTasks = Array.from({ length: 3 }, (_, index) => ({
      ...makeTask(`KB-ARCH-${index + 1}`),
      column: "archived" as ColumnType,
    }));

    it("shows the server-backed Show more button only when archivedHasMore is true", () => {
      render(<Column {...defaultProps} column="archived" tasks={archivedTasks} collapsed={false} archivedHasMore={false} />);
      expect(screen.queryByRole("button", { name: /Show more/i })).toBeNull();
    });

    it("renders no Show more button for an empty archive", () => {
      render(<Column {...defaultProps} column="archived" tasks={[]} collapsed={false} archivedHasMore={false} />);
      expect(screen.queryByRole("button", { name: /Show more/i })).toBeNull();
    });

    it("renders the Show more button when archivedHasMore is true and invokes onLoadMoreArchived on click", async () => {
      const onLoadMoreArchived = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<Column {...defaultProps} column="archived" tasks={archivedTasks} collapsed={false} archivedHasMore onLoadMoreArchived={onLoadMoreArchived} />);

      const button = screen.getByRole("button", { name: /Show more/i });
      await user.click(button);

      expect(onLoadMoreArchived).toHaveBeenCalledTimes(1);
    });

    it("does not render the Show more button when the archived column is collapsed", () => {
      render(<Column {...defaultProps} column="archived" tasks={archivedTasks} collapsed archivedHasMore onLoadMoreArchived={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /Show more/i })).toBeNull();
    });
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

  it("preserves selected built-in workflow id when quick-creating in workflow mode", async () => {
    const onQuickCreate = vi.fn().mockResolvedValue({});
    render(
      <Column
        {...defaultProps}
        column="triage"
        workflowMode
        workflowId="builtin:coding"
        tasks={[]}
        onQuickCreate={onQuickCreate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(onQuickCreate).toHaveBeenCalledWith({
      description: "Quick task",
      column: "triage",
      workflowId: "builtin:coding",
    }));
  });
});

describe("Column in-progress/in-review bulk actions", () => {
  it.each(["in-progress", "in-review"] as const)("renders Stop All and Move All to Todo actions for %s", async (column) => {
    const user = userEvent.setup();
    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[{ ...makeTask("FN-001"), column }]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    const menuButton = screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` });
    expect(menuButton).toHaveAttribute("aria-haspopup", "menu");
    expect(menuButton).toHaveAttribute("aria-expanded", "false");

    await user.click(menuButton);

    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Move All to Todo/i })).toBeTruthy();
  });

  it.each(["in-progress", "in-review"] as const)("Stop All pauses only manually-pausable tasks in %s", async (column) => {
    const user = userEvent.setup();
    const onPauseTask = vi.fn().mockResolvedValue({} as Task);

    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[
          { ...makeTask("FN-001"), column, paused: false },
          { ...makeTask("FN-002"), column, paused: true },
          { ...makeTask("FN-003"), column, paused: false, assignedAgentId: "agent-1" },
          { ...makeTask("FN-004"), column, paused: false },
        ]}
        onPauseTask={onPauseTask}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    await user.click(screen.getByRole("menuitem", { name: /Stop All/i }));

    await waitFor(() => {
      expect(onPauseTask).toHaveBeenCalledTimes(2);
    });
    expect(onPauseTask).toHaveBeenCalledWith("FN-001");
    expect(onPauseTask).toHaveBeenCalledWith("FN-004");
    expect(onPauseTask).not.toHaveBeenCalledWith("FN-003");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Stop All Tasks",
      message: `Stop all 2 ${column === "in-progress" ? "in progress" : "in review"} tasks?`,
      danger: true,
    });
  });

  it.each(["in-progress", "in-review"] as const)("disables Stop All when %s is empty", async (column) => {
    const user = userEvent.setup();

    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeDisabled();
    expect(screen.getByText("No tasks in this column")).toBeTruthy();
  });

  it.each(["in-progress", "in-review"] as const)("disables Stop All when no %s tasks are manually pausable", async (column) => {
    const user = userEvent.setup();

    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[
          { ...makeTask("FN-010"), column, paused: true },
          { ...makeTask("FN-011"), column, paused: false, assignedAgentId: "agent-1" },
        ]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeDisabled();
    expect(screen.getByText("No manually pausable tasks")).toBeTruthy();
  });

  it.each(["in-progress", "in-review"] as const)("Move All to Todo moves every task in %s", async (column) => {
    const user = userEvent.setup();
    const onMoveTask = vi.fn().mockResolvedValue({} as Task);

    render(
      <Column
        {...defaultProps}
        column={column}
        onMoveTask={onMoveTask}
        tasks={[
          { ...makeTask("FN-001"), column },
          { ...makeTask("FN-002"), column },
        ]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    await user.click(screen.getByRole("menuitem", { name: /Move All to Todo/i }));

    await waitFor(() => {
      expect(onMoveTask).toHaveBeenCalledTimes(2);
    });
    expect(onMoveTask).toHaveBeenCalledWith("FN-001", "todo", undefined);
    expect(onMoveTask).toHaveBeenCalledWith("FN-002", "todo", undefined);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Move All to Todo",
      message: `Move all 2 ${column === "in-progress" ? "in progress" : "in review"} tasks to Todo?`,
    });
  });
});

describe("Column plan auto-approval action", () => {
  it.each([
    ["workflow", false],
    ["auto-approve-all", true],
    ["require-all", false],
  ] as const)("renders the Triage switch checked only for %s mode", async (_mode, enabled) => {
    const user = userEvent.setup();
    const onTogglePlanAutoApprove = vi.fn();

    render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[]}
        planAutoApproveEnabled={enabled}
        onTogglePlanAutoApprove={onTogglePlanAutoApprove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Planning column actions" }));
    const switchItem = screen.getByRole("menuitemcheckbox", { name: /Auto-approve plan/i });
    expect(switchItem).toHaveAttribute("aria-checked", enabled ? "true" : "false");
    expect(screen.getByText(enabled ? /On bypasses manual plan approval/i : /Off uses the workflow\/default/i)).toBeInTheDocument();
  });

  it("calls the plan auto-approval toggle exactly once and closes the menu", async () => {
    const user = userEvent.setup();
    const onTogglePlanAutoApprove = vi.fn();

    render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[makeTask("FN-001")]}
        planAutoApproveEnabled={false}
        onTogglePlanAutoApprove={onTogglePlanAutoApprove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Planning column actions" }));
    await user.click(screen.getByRole("checkbox", { name: "Auto-approve plan" }));

    expect(onTogglePlanAutoApprove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("coexists with workflow intake replan actions", async () => {
    const user = userEvent.setup();
    render(
      <Column
        {...defaultProps}
        column={"intake" as ColumnType}
        workflowMode
        columnDisplayName="Intake"
        columnFlags={{ intake: true }}
        tasks={[{ ...makeTask("FN-002"), column: "intake" as ColumnType }]}
        planAutoApproveEnabled={true}
        onTogglePlanAutoApprove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Intake column actions" }));

    expect(screen.getByRole("menuitemcheckbox", { name: /Auto-approve plan/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Replan All/i })).toBeInTheDocument();
  });

  it("does not leave an actions shell on non-Triage columns without actions", () => {
    render(<Column {...defaultProps} column="done" tasks={[]} />);

    expect(screen.queryByRole("button", { name: "Done column actions" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Auto-approve plan/i })).toBeNull();
  });
});

describe("Column Done action menu", () => {
  it("renders one accessible Done actions dropdown with sort choices and archive", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Column
        {...defaultProps}
        column="done"
        tasks={[{ ...makeTask("FN-001"), column: "done" }]}
        onArchiveAllDone={vi.fn().mockResolvedValue([])}
        doneSortMode="completion-date-desc"
        onDoneSortModeChange={vi.fn()}
      />,
    );

    const header = screen.getByRole("heading", { name: "Done" }).closest(".column-header") as HTMLElement;
    const actionsButton = screen.getByRole("button", { name: "Done column actions" });
    expect(actionsButton.closest(".column-header")).toBe(header);
    expect(header.querySelectorAll(".column-menu")).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "Sort Done tasks" })).toBeNull();
    expect(container.querySelector(".done-sort-control")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive all done tasks" })).toBeNull();

    await user.click(actionsButton);

    expect(screen.getByRole("menuitemradio", { name: /Completion date \(newest first\)/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Task ID \(newest first\)/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitem", { name: /Archive all done tasks/i })).toBeEnabled();
  });

  it("renders the same Done dropdown for workflow complete columns with custom ids", async () => {
    const user = userEvent.setup();
    render(
      <Column
        {...defaultProps}
        column={"shipped" as ColumnType}
        workflowMode
        columnDisplayName="Shipped"
        columnFlags={{ complete: true }}
        tasks={[{ ...makeTask("FN-001"), column: "shipped" as ColumnType }]}
        onArchiveAllDone={vi.fn().mockResolvedValue([])}
        doneSortMode="completion-date-desc"
        onDoneSortModeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Shipped" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Shipped column actions" }));

    expect(screen.getByRole("menuitemradio", { name: /Completion date \(newest first\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Task ID \(newest first\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Archive all done tasks/i })).toBeInTheDocument();
  });

  it("selects task ID descending from the Done actions menu", async () => {
    const user = userEvent.setup();
    const onDoneSortModeChange = vi.fn();
    render(
      <Column
        {...defaultProps}
        column="done"
        tasks={[{ ...makeTask("FN-001"), column: "done" }]}
        doneSortMode="completion-date-desc"
        onDoneSortModeChange={onDoneSortModeChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Done column actions" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Task ID \(newest first\)/ }));

    expect(onDoneSortModeChange).toHaveBeenCalledWith("task-id-desc");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("selects completion-date descending from the Done actions menu", async () => {
    const user = userEvent.setup();
    const onDoneSortModeChange = vi.fn();
    render(
      <Column
        {...defaultProps}
        column="done"
        tasks={[{ ...makeTask("FN-002"), column: "done" }]}
        doneSortMode="task-id-desc"
        onDoneSortModeChange={onDoneSortModeChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Done column actions" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Completion date \(newest first\)/ }));

    expect(onDoneSortModeChange).toHaveBeenCalledWith("completion-date-desc");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("archives Done tasks from the menu only after confirmation", async () => {
    const user = userEvent.setup();
    const onArchiveAllDone = vi.fn().mockResolvedValue([{ ...makeTask("FN-001"), column: "archived" }]);
    render(
      <Column
        {...defaultProps}
        column="done"
        tasks={[{ ...makeTask("FN-001"), column: "done" }]}
        onArchiveAllDone={onArchiveAllDone}
        doneSortMode="completion-date-desc"
        onDoneSortModeChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Done column actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Archive all done tasks/i }));

    await waitFor(() => expect(onArchiveAllDone).toHaveBeenCalledTimes(1));
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Archive All Done",
      message: "Archive all 1 done tasks?",
      danger: true,
    });
  });

  it("keeps sort choices available while blocking archive for an empty Done column", async () => {
    const user = userEvent.setup();
    const onArchiveAllDone = vi.fn().mockResolvedValue([]);
    render(
      <Column
        {...defaultProps}
        column="done"
        tasks={[]}
        onArchiveAllDone={onArchiveAllDone}
        doneSortMode="completion-date-desc"
        onDoneSortModeChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Done column actions" }));

    expect(screen.getByRole("menuitemradio", { name: /Completion date \(newest first\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Task ID \(newest first\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Archive all done tasks/i })).toBeDisabled();
    expect(onArchiveAllDone).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("hides Done menu items and leaves no standalone wrappers on non-Done columns", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Column
        {...defaultProps}
        column="todo"
        tasks={[{ ...makeTask("FN-001"), column: "todo" }]}
        onArchiveAllDone={vi.fn().mockResolvedValue([])}
        doneSortMode="completion-date-desc"
        onDoneSortModeChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Sort Done tasks" })).toBeNull();
    expect(container.querySelector(".done-sort-control")).toBeNull();
    expect(container.querySelector("[aria-label='Sort Done tasks']")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Todo column actions" }));

    expect(screen.queryByRole("menuitemradio", { name: /Completion date \(newest first\)/ })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /Task ID \(newest first\)/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Archive all done tasks/i })).toBeNull();
  });

  it("does not render a Done actions menu when Done sort and archive props are absent", () => {
    const { container } = render(
      <Column
        {...defaultProps}
        column="done"
        tasks={[{ ...makeTask("FN-001"), column: "done" }]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Done column actions" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sort Done tasks" })).toBeNull();
    expect(container.querySelector(".done-sort-control")).toBeNull();
  });
});

describe("Column same-column drop", () => {
  it("does not call onMoveTask when dropping task into its current column", () => {
    const onMoveTask = vi.fn().mockResolvedValue({} as Task);
    const addToast = vi.fn();
    const tasks = [{ ...makeTask("FN-001"), column: "todo" as ColumnType }];
    
    render(<Column {...defaultProps} column="todo" tasks={tasks} onMoveTask={onMoveTask} addToast={addToast} />);

    const columnEl = screen.getByRole("heading", { name: "Todo" }).closest(".column") as HTMLElement;
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

    const columnEl = screen.getByRole("heading", { name: "Todo" }).closest(".column") as HTMLElement;
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

    const columnEl = screen.getAllByText("0")[0].closest(".column") as HTMLElement;
    const dataTransfer = {
      getData: vi.fn().mockReturnValue("FN-001"),
      dropEffect: "move",
    };

    fireEvent.drop(columnEl, { dataTransfer });

    expect(onMoveTask).toHaveBeenCalledWith("FN-001", "in-review", undefined);
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
      getSlotsForId: vi.fn((id: string) => id === "board-column-footer" ? [{ pluginId: "test-plugin", slot: { slotId: "board-column-footer", label: "Column Footer", componentPath: "./test.js" } }] : []),
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
