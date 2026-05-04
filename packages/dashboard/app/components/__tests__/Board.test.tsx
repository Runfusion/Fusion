import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Board } from "../Board";
import { COLUMNS } from "@fusion/core";

import type { Task } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn().mockResolvedValue([
    { id: "WS-003", name: "Accessibility Audit", enabled: true },
  ]),
}));

const columnRenderCounts: Record<string, number> = {};

// Mock child components so we only test Board's own rendering
vi.mock("../Column", () => ({
  Column: React.memo(({ column, tasks, onToggleCollapse, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, workflowStepNameLookup }: { column: string; tasks: Task[]; onToggleCollapse?: () => void; favoriteProviders?: string[]; favoriteModels?: string[]; onToggleFavorite?: (provider: string) => void; onToggleModelFavorite?: (modelId: string) => void; isSearchActive?: boolean; workflowStepNameLookup?: ReadonlyMap<string, string> }) => {
    columnRenderCounts[column] = (columnRenderCounts[column] ?? 0) + 1;
    return (
      <div data-testid={`column-${column}`} data-tasks={JSON.stringify(tasks)} data-favorite-providers={JSON.stringify(favoriteProviders ?? [])} data-favorite-models={JSON.stringify(favoriteModels ?? [])} data-has-toggle-favorite={onToggleFavorite ? "yes" : "no"} data-has-toggle-model-favorite={onToggleModelFavorite ? "yes" : "no"} data-is-search-active={isSearchActive ? "true" : "false"} data-workflow-lookup-size={String(workflowStepNameLookup?.size ?? 0)}>
        {onToggleCollapse && <button onClick={onToggleCollapse}>toggle-{column}</button>}
      </div>
    );
  }),
}));

const noop = () => {};
const noopAsync = () => Promise.resolve({} as any);

beforeEach(() => {
  for (const key of Object.keys(columnRenderCounts)) {
    delete columnRenderCounts[key];
  }
});

function createBoardProps(overrides = {}) {
  return {
    tasks: [],
    maxConcurrent: 2,
    onMoveTask: noopAsync,
    onOpenDetail: noop,
    addToast: noop,
    onQuickCreate: noopAsync,
    onNewTask: noop,
    autoMerge: true,
    onToggleAutoMerge: noop,
    globalPaused: false,
    onUpdateTask: undefined,
    onArchiveTask: undefined,
    onUnarchiveTask: undefined,
    ...overrides,
  };
}

function renderBoard(props = {}) {
  return render(<Board {...createBoardProps(props)} />);
}

describe("Board", () => {
  it("renders a <main> element with class 'board'", () => {
    renderBoard();
    const main = screen.getByRole("main");
    expect(main).toBeDefined();
    expect(main.className).toContain("board");
  });

  it("renders with id='board' for scroll targeting", () => {
    renderBoard();
    const main = screen.getByRole("main");
    expect(main.id).toBe("board");
  });

  it("renders all 6 columns", () => {
    renderBoard();
    for (const col of COLUMNS) {
      expect(screen.getByTestId(`column-${col}`)).toBeDefined();
    }
  });

  it("forwards board-level workflow name lookup to columns", async () => {
    renderBoard();

    await waitFor(() => {
      for (const col of COLUMNS) {
        const columnEl = screen.getByTestId(`column-${col}`);
        expect(columnEl.getAttribute("data-workflow-lookup-size")).toBe("1");
      }
    });
  });

  it("renders all 6 columns as direct children of .board (CSS selector target)", () => {
    renderBoard();
    const board = screen.getByRole("main");
    // The mock Column renders <div data-testid="column-{col}" />, which are direct children
    const directChildren = Array.from(board.children);
    expect(directChildren).toHaveLength(COLUMNS.length);
    // Each direct child should be one of the column test-id elements
    for (const col of COLUMNS) {
      const colEl = screen.getByTestId(`column-${col}`);
      expect(colEl.parentElement).toBe(board);
    }
  });

  it("renders the board element as a <main> tag (semantic structure)", () => {
    renderBoard();
    const board = screen.getByRole("main");
    expect(board.tagName).toBe("MAIN");
  });

  describe("search functionality", () => {
    const createTask = (overrides: Partial<Task> & { id: string; description: string }): Task => ({
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    });

    it("renders server-filtered tasks by ID when search query is provided", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "First task", column: "todo" }),
        createTask({ id: "FN-002", description: "Second task", column: "todo" }),
        createTask({ id: "FN-003", description: "Third task", column: "in-progress" }),
      ];

      // Pre-filtered tasks - only FN-002 matches the search
      const filteredTasks = [tasks[1]];

      renderBoard({ tasks: filteredTasks, searchQuery: "FN-002" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("FN-002");

      const inProgressColumn = screen.getByTestId("column-in-progress");
      const inProgressTasks = JSON.parse(inProgressColumn.getAttribute("data-tasks") || "[]");
      expect(inProgressTasks).toHaveLength(0);
    });

    it("renders server-filtered tasks by title when search query is provided", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", title: "Fix login bug", description: "First task", column: "todo" }),
        createTask({ id: "FN-002", title: "Add dashboard feature", description: "Second task", column: "todo" }),
        createTask({ id: "FN-003", title: "Update documentation", description: "Third task", column: "todo" }),
      ];

      // Pre-filtered tasks - only dashboard matches
      const filteredTasks = [tasks[1]];

      renderBoard({ tasks: filteredTasks, searchQuery: "dashboard" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("FN-002");
    });

    it("renders server-filtered tasks by description when search query is provided", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "Implement user authentication", column: "todo" }),
        createTask({ id: "FN-002", description: "Fix database connection issue", column: "todo" }),
        createTask({ id: "FN-003", description: "Add caching layer", column: "todo" }),
      ];

      // Pre-filtered tasks - only database matches
      const filteredTasks = [tasks[1]];

      renderBoard({ tasks: filteredTasks, searchQuery: "database" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("FN-002");
    });

    it("search is case-insensitive (server handles this)", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", title: "Fix Login Bug", description: "First task", column: "todo" }),
        createTask({ id: "FN-002", title: "Add Dashboard Feature", description: "Second task", column: "todo" }),
      ];

      // Pre-filtered tasks - only FN-001 matches
      const filteredTasks = [tasks[0]];

      renderBoard({ tasks: filteredTasks, searchQuery: "login" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("FN-001");
    });

    it("search is case-insensitive for lowercase query matching uppercase content (server handles this)", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-UPPER", title: "UPPERCASE TITLE", description: "DESC", column: "todo" }),
      ];

      // Pre-filtered tasks - FN-UPPER matches
      const filteredTasks = [tasks[0]];

      renderBoard({ tasks: filteredTasks, searchQuery: "upper" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("FN-UPPER");
    });

    it("shows all tasks when search query is empty", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "First task", column: "todo" }),
        createTask({ id: "FN-002", description: "Second task", column: "todo" }),
        createTask({ id: "FN-003", description: "Third task", column: "in-progress" }),
      ];

      renderBoard({ tasks, searchQuery: "" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(2);

      const inProgressColumn = screen.getByTestId("column-in-progress");
      const inProgressTasks = JSON.parse(inProgressColumn.getAttribute("data-tasks") || "[]");
      expect(inProgressTasks).toHaveLength(1);
    });

    it("shows no tasks when search query matches nothing (server returns empty)", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "First task", column: "todo" }),
        createTask({ id: "FN-002", description: "Second task", column: "todo" }),
      ];

      // Pre-filtered tasks - empty array because server found no matches
      const filteredTasks: Task[] = [];

      renderBoard({ tasks: filteredTasks, searchQuery: "nonexistent" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(0);
    });

    it("keeps unaffected columns stable when archived collapse toggles", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "Todo task", column: "todo" }),
        createTask({ id: "FN-002", description: "Archived task", column: "archived" }),
      ];

      renderBoard({ tasks });

      const initialTodoRenders = columnRenderCounts.todo;
      const initialArchivedRenders = columnRenderCounts.archived;

      fireEvent.click(screen.getByRole("button", { name: "toggle-archived" }));

      expect(columnRenderCounts.archived).toBeGreaterThan(initialArchivedRenders);
      expect(columnRenderCounts.todo).toBe(initialTodoRenders);
    });

    it("only re-renders the affected column when a task updates", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "Todo task", column: "todo", title: "Original" }),
        createTask({ id: "FN-002", description: "Done task", column: "done", title: "Done" }),
      ];

      const { rerender } = renderBoard({ tasks });

      const initialTodoRenders = columnRenderCounts.todo;
      const initialDoneRenders = columnRenderCounts.done;

      rerender(
        <Board
          {...createBoardProps({
            tasks: [
              { ...tasks[0], title: "Updated" },
              tasks[1],
            ],
          })}
        />,
      );

      const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]");
      expect(todoTasks[0].title).toBe("Updated");
      expect(columnRenderCounts.todo).toBeGreaterThan(initialTodoRenders);
      expect(columnRenderCounts.done).toBeGreaterThanOrEqual(initialDoneRenders);
    });

    describe("sortTasksForColumn priority ordering", () => {
      it("orders done tasks by most recent completion regardless of priority", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-003",
            description: "Older urgent done task",
            column: "done",
            priority: "urgent",
            columnMovedAt: "2024-01-01T09:00:00.000Z",
          }),
          createTask({
            id: "FN-001",
            description: "Newest low-priority done task",
            column: "done",
            priority: "low",
            columnMovedAt: "2024-01-01T11:00:00.000Z",
          }),
          createTask({
            id: "FN-002",
            description: "Middle high-priority done task",
            column: "done",
            priority: "high",
            columnMovedAt: "2024-01-01T10:00:00.000Z",
          }),
        ];

        renderBoard({ tasks });

        const doneTasks = JSON.parse(screen.getByTestId("column-done").getAttribute("data-tasks") || "[]") as Task[];
        expect(doneTasks.map((t: Task) => t.id)).toEqual(["FN-001", "FN-002", "FN-003"]);
      });

      it("falls back to updatedAt and createdAt for legacy done tasks missing columnMovedAt", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-010",
            description: "Has updatedAt fallback",
            column: "done",
            updatedAt: "2024-01-01T10:30:00.000Z",
          }),
          createTask({
            id: "FN-011",
            description: "Has createdAt fallback",
            column: "done",
            createdAt: "2024-01-01T10:45:00.000Z",
          }),
          createTask({
            id: "FN-012",
            description: "Has real completion timestamp",
            column: "done",
            columnMovedAt: "2024-01-01T11:00:00.000Z",
          }),
        ];

        const taskWithCreatedAtOnly = tasks[1];
        delete taskWithCreatedAtOnly.columnMovedAt;
        delete taskWithCreatedAtOnly.updatedAt;

        renderBoard({ tasks });

        const doneTasks = JSON.parse(screen.getByTestId("column-done").getAttribute("data-tasks") || "[]") as Task[];
        expect(doneTasks.map((t: Task) => t.id)).toEqual(["FN-012", "FN-011", "FN-010"]);
      });

      it("keeps non-done columns priority-ordered even when recency differs", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-003",
            description: "Low but newest",
            column: "todo",
            priority: "low",
            columnMovedAt: "2024-01-01T12:00:00.000Z",
          }),
          createTask({
            id: "FN-001",
            description: "Urgent but older",
            column: "todo",
            priority: "urgent",
            columnMovedAt: "2024-01-01T10:00:00.000Z",
          }),
          createTask({
            id: "FN-004",
            description: "Normal",
            column: "todo",
            priority: "normal",
            columnMovedAt: "2024-01-01T11:00:00.000Z",
          }),
          createTask({
            id: "FN-002",
            description: "High",
            column: "todo",
            priority: "high",
            columnMovedAt: "2024-01-01T09:00:00.000Z",
          }),
        ];

        renderBoard({ tasks, searchQuery: "task" });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        expect(todoTasks).toHaveLength(4);
        expect(todoTasks.map((t: Task) => t.id)).toEqual(["FN-001", "FN-002", "FN-004", "FN-003"]);
      });

      it("orders same-priority tasks by numeric task ID ascending", () => {
        const tasks: Task[] = [
          createTask({ id: "FN-050", description: "Fifty", column: "in-progress", priority: "normal" }),
          createTask({ id: "FN-010", description: "Ten", column: "in-progress", priority: "normal" }),
          createTask({ id: "FN-030", description: "Thirty", column: "in-progress", priority: "normal" }),
        ];

        renderBoard({ tasks });

        const ipTasks = JSON.parse(screen.getByTestId("column-in-progress").getAttribute("data-tasks") || "[]") as Task[];
        expect(ipTasks.map((t: Task) => t.id)).toEqual(["FN-010", "FN-030", "FN-050"]);
      });

      it("normalizes missing and invalid legacy priority values to normal", () => {
        const noPriorityTask = createTask({ id: "FN-060", description: "No priority", column: "todo" });
        delete noPriorityTask.priority;

        const legacyPriorityTask = {
          ...createTask({ id: "FN-059", description: "Legacy priority", column: "todo", priority: "normal" }),
          priority: "critical" as unknown as Task["priority"],
        };

        const tasks: Task[] = [
          noPriorityTask,
          createTask({ id: "FN-061", description: "Explicit normal", column: "todo", priority: "normal" }),
          legacyPriorityTask,
          createTask({ id: "FN-062", description: "Urgent", column: "todo", priority: "urgent" }),
        ];

        renderBoard({ tasks });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        // FN-060 (missing), FN-059 (legacy invalid), and FN-061 (explicit normal) normalize to normal,
        // so they sort by numeric ID ascending after urgent tasks.
        expect(todoTasks.map((t: Task) => t.id)).toEqual(["FN-062", "FN-059", "FN-060", "FN-061"]);
      });

      it("uses localeCompare fallback for non-numeric task IDs", () => {
        const tasks: Task[] = [
          createTask({ id: "TASK-002", description: "Task two", column: "todo", priority: "normal" }),
          createTask({ id: "TASK-001", description: "Task one", column: "todo", priority: "normal" }),
        ];

        renderBoard({ tasks });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        // Both have same priority, numeric parse fails (NaN), localeCompare fallback
        expect(todoTasks.map((t: Task) => t.id)).toEqual(["TASK-001", "TASK-002"]);
      });
    });

    describe("sortTasksForColumn merging pinning", () => {
      it("pins merging tasks to top of in-review even when newer non-merging tasks exist", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-010",
            column: "in-review",
            status: "merging",
            columnMovedAt: "2024-01-01T10:00:00.000Z",
          }),
          createTask({
            id: "FN-011",
            column: "in-review",
            status: "review-ready",
            columnMovedAt: "2024-01-01T12:00:00.000Z",
          }),
        ];

        renderBoard({ tasks });

        const inReviewTasks = JSON.parse(screen.getByTestId("column-in-review").getAttribute("data-tasks") || "[]") as Task[];
        expect(inReviewTasks.map((task) => task.id)).toEqual(["FN-010", "FN-011"]);
      });

      it("pins merging-pr tasks to top of in-review even when newer non-merging tasks exist", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-020",
            column: "in-review",
            status: "merging-pr",
            columnMovedAt: "2024-01-01T10:00:00.000Z",
          }),
          createTask({
            id: "FN-021",
            column: "in-review",
            status: "review-ready",
            columnMovedAt: "2024-01-01T13:00:00.000Z",
          }),
        ];

        renderBoard({ tasks });

        const inReviewTasks = JSON.parse(screen.getByTestId("column-in-review").getAttribute("data-tasks") || "[]") as Task[];
        expect(inReviewTasks.map((task) => task.id)).toEqual(["FN-020", "FN-021"]);
      });

      it("pins merging-fix tasks to top of in-review even when newer non-merging tasks exist", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-060",
            column: "in-review",
            status: "merging-fix",
            columnMovedAt: "2024-01-01T10:00:00.000Z",
          }),
          createTask({
            id: "FN-061",
            column: "in-review",
            status: "review-ready",
            columnMovedAt: "2024-01-01T13:00:00.000Z",
          }),
        ];

        renderBoard({ tasks });

        const inReviewTasks = JSON.parse(screen.getByTestId("column-in-review").getAttribute("data-tasks") || "[]") as Task[];
        expect(inReviewTasks.map((task) => task.id)).toEqual(["FN-060", "FN-061"]);
      });

      it("sorts multiple merging tasks by priority then task ID within the pinned group", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-030",
            column: "in-review",
            status: "merging",
            priority: "high",
          }),
          createTask({
            id: "FN-031",
            column: "in-review",
            status: "merging-pr",
            priority: "urgent",
          }),
          createTask({
            id: "FN-032",
            column: "in-review",
            status: "review-ready",
            priority: "urgent",
          }),
        ];

        renderBoard({ tasks });

        const inReviewTasks = JSON.parse(screen.getByTestId("column-in-review").getAttribute("data-tasks") || "[]") as Task[];
        // Pinned group (merging): FN-031 urgent, FN-030 high — sorted by priority desc
        // Non-pinned group: FN-032 urgent
        expect(inReviewTasks.map((task) => task.id)).toEqual(["FN-031", "FN-030", "FN-032"]);
      });

      it("sorts non-in-review columns by priority then task ID regardless of status", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-040",
            column: "todo",
            status: "merging",
            priority: "high",
          }),
          createTask({
            id: "FN-041",
            column: "todo",
            status: "ready",
            priority: "urgent",
          }),
          createTask({
            id: "FN-042",
            column: "todo",
            status: "ready",
            priority: "high",
          }),
        ];

        renderBoard({ tasks });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        // No merge-pinning outside in-review, so pure priority-then-ID sort
        // FN-041 urgent, then FN-040 and FN-042 both high (sorted by ID asc)
        expect(todoTasks.map((task) => task.id)).toEqual(["FN-041", "FN-040", "FN-042"]);
      });

      it("sorts tasks without status by priority then task ID in in-review", () => {
        const statuslessTask = createTask({
          id: "FN-050",
          column: "in-review",
          priority: "normal",
        });
        delete statuslessTask.status;

        const tasks: Task[] = [
          statuslessTask,
          createTask({
            id: "FN-051",
            column: "in-review",
            status: "review-ready",
            priority: "urgent",
          }),
        ];

        renderBoard({ tasks });

        const inReviewTasks = JSON.parse(screen.getByTestId("column-in-review").getAttribute("data-tasks") || "[]") as Task[];
        // Neither is merging, so sort by priority: FN-051 urgent > FN-050 normal
        expect(inReviewTasks.map((task) => task.id)).toEqual(["FN-051", "FN-050"]);
      });
    });

    it("renders server-filtered tasks matching across multiple fields simultaneously", () => {
      const tasks: Task[] = [
        createTask({ id: "SEARCH-123", title: "Searchable title", description: "Normal description", column: "todo" }),
        createTask({ id: "FN-999", title: "Other task", description: "This has searchable content", column: "todo" }),
        createTask({ id: "FN-888", title: "Unrelated", description: "No match here", column: "todo" }),
      ];

      // Pre-filtered tasks - only the two matching tasks
      const filteredTasks = [tasks[0], tasks[1]];

      renderBoard({ tasks: filteredTasks, searchQuery: "search" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");

      // Should have both matching tasks
      expect(todoTasks).toHaveLength(2);
      expect(todoTasks.map((t: Task) => t.id).sort()).toEqual(["FN-999", "SEARCH-123"]);
    });

    it("shows all tasks for whitespace-only search query (server treats as empty)", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "First task", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "  " });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");

      // Whitespace-only query should be treated as empty, showing all tasks
      expect(todoTasks).toHaveLength(1);
    });

    it("passes isSearchActive=true to columns when search query is non-empty", () => {
      const tasks: Task[] = [
        createTask({ id: "FN-001", description: "First task", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "first" });

      for (const col of COLUMNS) {
        const columnEl = screen.getByTestId(`column-${col}`);
        expect(columnEl.getAttribute("data-is-search-active")).toBe("true");
      }
    });

    it("passes isSearchActive=false to columns when search query is empty", () => {
      renderBoard({ searchQuery: "" });

      for (const col of COLUMNS) {
        const columnEl = screen.getByTestId(`column-${col}`);
        expect(columnEl.getAttribute("data-is-search-active")).toBe("false");
      }
    });

    it("passes isSearchActive=false to columns when search query is whitespace-only", () => {
      renderBoard({ searchQuery: "   " });

      for (const col of COLUMNS) {
        const columnEl = screen.getByTestId(`column-${col}`);
        expect(columnEl.getAttribute("data-is-search-active")).toBe("false");
      }
    });
  });

  it("does not render a .board-project-context badge", () => {
    renderBoard();
    const badge = document.querySelector(".board-project-context");
    expect(badge).toBeNull();
  });

  describe("favorite model prop forwarding (FN-770)", () => {
    it("forwards favoriteProviders and favoriteModels to all columns", () => {
      const favoriteProviders = ["anthropic"];
      const favoriteModels = ["claude-sonnet-4-5"];
      const onToggleFavorite = vi.fn();
      const onToggleModelFavorite = vi.fn();

      renderBoard({
        favoriteProviders,
        favoriteModels,
        onToggleFavorite,
        onToggleModelFavorite,
      });

      // Every column should receive the favorite props
      for (const col of COLUMNS) {
        const columnEl = screen.getByTestId(`column-${col}`);
        expect(columnEl.getAttribute("data-favorite-providers")).toBe(JSON.stringify(favoriteProviders));
        expect(columnEl.getAttribute("data-favorite-models")).toBe(JSON.stringify(favoriteModels));
        expect(columnEl.getAttribute("data-has-toggle-favorite")).toBe("yes");
        expect(columnEl.getAttribute("data-has-toggle-model-favorite")).toBe("yes");
      }
    });

    it("passes empty arrays for favorites when not provided", () => {
      renderBoard();

      for (const col of COLUMNS) {
        const columnEl = screen.getByTestId(`column-${col}`);
        expect(columnEl.getAttribute("data-favorite-providers")).toBe("[]");
        expect(columnEl.getAttribute("data-favorite-models")).toBe("[]");
        expect(columnEl.getAttribute("data-has-toggle-favorite")).toBe("no");
        expect(columnEl.getAttribute("data-has-toggle-model-favorite")).toBe("no");
      }
    });
  });
});
