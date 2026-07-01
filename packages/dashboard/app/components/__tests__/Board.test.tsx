import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { Board } from "../Board";
import { COLUMNS } from "@fusion/core";
import { BOARD_WORKFLOW_SELECTION_STORAGE_KEY } from "../../utils/boardWorkflowSelection";
import { scopedKey } from "../../utils/projectStorage";

import type { Task } from "@fusion/core";

const fetchBatchMock = vi.fn();
const pendingWorkflowSteps = () => new Promise<never>(() => {});
const fetchWorkflowStepsMock = vi.fn().mockImplementation(pendingWorkflowSteps);

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  useBatchBadgeFetch: vi.fn(() => ({
    fetchBatch: fetchBatchMock,
    isLoading: false,
    lastFetchTime: null,
    getBatchData: vi.fn(),
  })),
}));

const pendingBoardWorkflows = () => new Promise<never>(() => {});
const fetchBoardWorkflowsMock = vi.fn().mockImplementation(pendingBoardWorkflows);
const promoteTaskMock = vi.fn().mockResolvedValue({});

vi.mock("../../api", () => ({
  fetchWorkflowSteps: (...args: unknown[]) => fetchWorkflowStepsMock(...args),
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
  promoteTask: (...args: unknown[]) => promoteTaskMock(...args),
}));

// Capture SSE event handlers registered via subscribeSse so tests can simulate
// server-pushed `workflow:*` events without a real EventSource.
const sseHandlers: Record<string, (event?: unknown) => void> = {};
const subscribeSseMock = vi.fn(
  (_url: string, opts: { events?: Record<string, (event?: unknown) => void> }) => {
    for (const [name, handler] of Object.entries(opts.events ?? {})) {
      sseHandlers[name] = handler;
    }
    return () => {};
  },
);
vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => (subscribeSseMock as (...a: unknown[]) => () => void)(...args),
}));

const columnRenderCounts: Record<string, number> = {};

// Mock child components so we only test Board's own rendering
vi.mock("../Column", () => ({
  Column: React.memo(({
    column,
    tasks,
    columnDisplayName,
    collapsed,
    onToggleCollapse,
    onQuickCreate,
    onNewTask,
    onToggleAutoMerge,
    onArchiveAllDone,
    favoriteProviders,
    favoriteModels,
    onToggleFavorite,
    onToggleModelFavorite,
    isSearchActive,
    doneSortMode,
    onDoneSortModeChange,
    workflowId,
    canDropTask,
    onPlanningMode,
    onSubtaskBreakdown,
    taskWorkflowBadges,
  }: {
    column: string;
    tasks: Task[];
    columnDisplayName?: string;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
    onQuickCreate?: unknown;
    onNewTask?: unknown;
    onToggleAutoMerge?: () => void;
    onArchiveAllDone?: unknown;
    favoriteProviders?: string[];
    favoriteModels?: string[];
    onToggleFavorite?: (provider: string) => void;
    onToggleModelFavorite?: (modelId: string) => void;
    isSearchActive?: boolean;
    doneSortMode?: string;
    onDoneSortModeChange?: (mode: "completion-date-desc" | "task-id-desc") => void;
    workflowId?: string;
    canDropTask?: unknown;
    onPlanningMode?: unknown;
    onSubtaskBreakdown?: unknown;
    taskWorkflowBadges?: ReadonlyMap<string, { workflowId: string; workflowName: string }>;
  }) => {
    columnRenderCounts[column] = (columnRenderCounts[column] ?? 0) + 1;
    return (
      <div data-testid={`column-${column}`} data-tasks={JSON.stringify(tasks)} data-workflow-badges={JSON.stringify(Object.fromEntries(taskWorkflowBadges ?? new Map()))} data-collapsed={collapsed ? "true" : "false"} data-has-quick-create={onQuickCreate ? "yes" : "no"} data-has-new-task={onNewTask ? "yes" : "no"} data-has-auto-merge-toggle={onToggleAutoMerge ? "yes" : "no"} data-has-archive-all={onArchiveAllDone ? "yes" : "no"} data-favorite-providers={JSON.stringify(favoriteProviders ?? [])} data-favorite-models={JSON.stringify(favoriteModels ?? [])} data-has-toggle-favorite={onToggleFavorite ? "yes" : "no"} data-has-toggle-model-favorite={onToggleModelFavorite ? "yes" : "no"} data-is-search-active={isSearchActive ? "true" : "false"} data-done-sort-mode={doneSortMode ?? ""} data-has-done-sort-handler={onDoneSortModeChange ? "yes" : "no"} data-workflow-id={workflowId ?? ""} data-column-display-name={columnDisplayName ?? ""} data-has-can-drop={canDropTask ? "yes" : "no"} data-has-planning={onPlanningMode ? "yes" : "no"} data-has-subtask={onSubtaskBreakdown ? "yes" : "no"}>
        {tasks.map((task) => (
          <article key={task.id} data-testid={`board-task-card-${task.id}`}>
            {task.title ?? task.description ?? task.id}
          </article>
        ))}
        {onToggleCollapse && <button onClick={onToggleCollapse}>toggle-{column}</button>}
        {onDoneSortModeChange && <button type="button" onClick={() => onDoneSortModeChange("task-id-desc")}>sort-{column}-by-id</button>}
      </div>
    );
  }),
}));

// Mock Lane so the multi-lane Board tests assert grouping/ordering without
// pulling in the full Column tree.
vi.mock("../Lane", () => ({
  Lane: ({ workflow, tasks, collapsed }: { workflow: { id: string; name: string }; tasks: Task[]; collapsed: boolean }) => (
    <section
      data-testid={`lane-${workflow.id}`}
      data-lane-name={workflow.name}
      data-lane-count={String(tasks.length)}
      data-lane-collapsed={collapsed ? "true" : "false"}
      data-lane-task-ids={JSON.stringify(tasks.map((t) => t.id))}
    />
  ),
}));

const DEFAULT_WORKFLOW = {
  id: "builtin:coding",
  name: "Coding (built-in)",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
    { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
    { id: "done", name: "Done", flags: { complete: true } },
    { id: "archived", name: "Archived", flags: { archived: true } },
  ],
};

const noop = () => {};
const noopAsync = () => Promise.resolve({} as any);

function clearBoardTestStorage() {
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom localStorage */
  }
}

beforeEach(() => {
  fetchBatchMock.mockReset();
  fetchWorkflowStepsMock.mockReset();
  fetchWorkflowStepsMock.mockImplementation(pendingWorkflowSteps);
  promoteTaskMock.mockClear();
  subscribeSseMock.mockClear();
  for (const key of Object.keys(sseHandlers)) delete sseHandlers[key];
  fetchBoardWorkflowsMock.mockReset();
  fetchBoardWorkflowsMock.mockImplementation(pendingBoardWorkflows);
  clearBoardTestStorage();
  for (const key of Object.keys(columnRenderCounts)) {
    delete columnRenderCounts[key];
  }
});

afterEach(() => {
  clearBoardTestStorage();
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

async function openWorkflowSwitcher() {
  const trigger = await screen.findByTestId("workflow-switcher");
  fireEvent.click(trigger);
  return trigger;
}

async function selectWorkflow(workflowId: string) {
  await openWorkflowSwitcher();
  fireEvent.click(screen.getByTestId(`workflow-switcher-option-${workflowId}`));
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

  it("FN-4380: does not eagerly fetch GitHub badge status on board mount", () => {
    vi.useFakeTimers();
    try {
      const tasksWithBadges: Task[] = [
        {
          id: "FN-PR-1",
          title: "Task with PR badge",
          description: "Has prInfo",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          prInfo: { number: 123, owner: "runfusion", repo: "fusion" } as Task["prInfo"],
        },
        {
          id: "FN-ISSUE-1",
          title: "Task with issue badge",
          description: "Has issueInfo",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          issueInfo: { number: 456, owner: "runfusion", repo: "fusion" } as Task["issueInfo"],
        },
      ];

      renderBoard({ tasks: tasksWithBadges });
      vi.runAllTimers();
      expect(fetchBatchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders all 6 columns", () => {
    renderBoard();
    for (const col of COLUMNS) {
      expect(screen.getByTestId(`column-${col}`)).toBeDefined();
    }
  });

  it("FN-7250 removes cards from columns when the shared task array drops a deleted id", () => {
    const deletedTask = {
      id: "FN-DELETE",
      description: "Deleted",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    } as Task;
    const keptTask = { ...deletedTask, id: "FN-KEEP", description: "Kept", column: "in-progress" } as Task;
    const readIds = (column: string) => (JSON.parse(screen.getByTestId(`column-${column}`).getAttribute("data-tasks") || "[]") as Task[]).map((task) => task.id);

    const { rerender } = renderBoard({ tasks: [deletedTask, keptTask] });

    expect(readIds("todo")).toEqual(["FN-DELETE"]);
    expect(readIds("in-progress")).toEqual(["FN-KEEP"]);
    expect(screen.getByTestId("board-task-card-FN-DELETE")).toBeInTheDocument();
    expect(screen.getByTestId("board-task-card-FN-KEEP")).toBeInTheDocument();

    rerender(<Board {...createBoardProps({ tasks: [keptTask] })} />);

    expect(readIds("todo")).toEqual([]);
    expect(readIds("in-progress")).toEqual(["FN-KEEP"]);
    expect(screen.queryByTestId("board-task-card-FN-DELETE")).toBeNull();
    expect(screen.getByTestId("board-task-card-FN-KEEP")).toBeInTheDocument();
  });

  it("falls back malformed task columns to triage instead of crashing", () => {
    const malformedTask = {
      id: "FN-404",
      description: "Malformed",
      column: "impossible-column",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    } as unknown as Task;

    expect(() => renderBoard({ tasks: [malformedTask] })).not.toThrow();

    const triageTasks = JSON.parse(screen.getByTestId("column-triage").getAttribute("data-tasks") || "[]") as Task[];
    expect(triageTasks).toHaveLength(1);
    expect(triageTasks[0]?.id).toBe("FN-404");
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

    describe("column default ordering priority semantics", () => {
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

      it("threads Done sort state through the legacy board without altering other columns", () => {
        const tasks: Task[] = [
          createTask({ id: "FN-003", description: "Old done", column: "done", columnMovedAt: "2024-01-01T09:00:00.000Z" }),
          createTask({ id: "FN-001", description: "New done", column: "done", columnMovedAt: "2024-01-01T11:00:00.000Z" }),
          createTask({ id: "FN-002", description: "Tie low id", column: "done", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
          createTask({ id: "FN-004", description: "Tie high id", column: "done", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
          createTask({ id: "FN-050", description: "Todo fifty", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
          createTask({ id: "FN-010", description: "Todo ten", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
        ];

        renderBoard({ tasks });

        const readIds = (column: string) => (JSON.parse(screen.getByTestId(`column-${column}`).getAttribute("data-tasks") || "[]") as Task[]).map((task) => task.id);
        expect(screen.getByTestId("column-done")).toHaveAttribute("data-done-sort-mode", "completion-date-desc");
        expect(screen.getByTestId("column-done")).toHaveAttribute("data-has-done-sort-handler", "yes");
        expect(readIds("done")).toEqual(["FN-001", "FN-002", "FN-004", "FN-003"]);
        expect(readIds("todo")).toEqual(["FN-010", "FN-050"]);
        expect(screen.getByTestId("column-todo")).toHaveAttribute("data-has-done-sort-handler", "no");

        fireEvent.click(screen.getByRole("button", { name: "sort-done-by-id" }));

        expect(screen.getByTestId("column-done")).toHaveAttribute("data-done-sort-mode", "task-id-desc");
        expect(readIds("done")).toEqual(["FN-004", "FN-003", "FN-002", "FN-001"]);
        expect(readIds("todo")).toEqual(["FN-010", "FN-050"]);
      });

      it("passes Done sort state to an empty legacy Done column", () => {
        renderBoard({ tasks: [] });

        expect(screen.getByTestId("column-done")).toHaveAttribute("data-tasks", "[]");
        expect(screen.getByTestId("column-done")).toHaveAttribute("data-done-sort-mode", "completion-date-desc");
        expect(screen.getByTestId("column-done")).toHaveAttribute("data-has-done-sort-handler", "yes");
      });

      it("orders todo by priority before age", () => {
        const tasks: Task[] = [
          createTask({
            id: "FN-003",
            description: "Low but oldest",
            column: "todo",
            priority: "low",
            createdAt: "2024-01-01T08:00:00.000Z",
          }),
          createTask({
            id: "FN-001",
            description: "Urgent but newer",
            column: "todo",
            priority: "urgent",
            createdAt: "2024-01-01T10:00:00.000Z",
          }),
          createTask({
            id: "FN-004",
            description: "Normal",
            column: "todo",
            priority: "normal",
            createdAt: "2024-01-01T09:00:00.000Z",
          }),
          createTask({
            id: "FN-002",
            description: "High",
            column: "todo",
            priority: "high",
            createdAt: "2024-01-01T07:00:00.000Z",
          }),
        ];

        renderBoard({ tasks, searchQuery: "task" });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        expect(todoTasks).toHaveLength(4);
        expect(todoTasks.map((t: Task) => t.id)).toEqual(["FN-001", "FN-002", "FN-004", "FN-003"]);
      });

      it("orders same-priority todo tasks by oldest createdAt first", () => {
        const tasks: Task[] = [
          createTask({ id: "FN-020", description: "Newest", column: "todo", priority: "high", createdAt: "2024-01-01T12:00:00.000Z" }),
          createTask({ id: "FN-021", description: "Oldest", column: "todo", priority: "high", createdAt: "2024-01-01T09:00:00.000Z" }),
          createTask({ id: "FN-022", description: "Middle", column: "todo", priority: "high", createdAt: "2024-01-01T10:00:00.000Z" }),
        ];

        renderBoard({ tasks });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        expect(todoTasks.map((t: Task) => t.id)).toEqual(["FN-021", "FN-022", "FN-020"]);
      });

      it("uses task ID as deterministic tie-breaker when todo createdAt matches", () => {
        const tasks: Task[] = [
          createTask({ id: "FN-050", description: "Fifty", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
          createTask({ id: "FN-010", description: "Ten", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
          createTask({ id: "FN-030", description: "Thirty", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
        ];

        renderBoard({ tasks });

        const todoTasks = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]") as Task[];
        expect(todoTasks.map((t: Task) => t.id)).toEqual(["FN-010", "FN-030", "FN-050"]);
      });

      it("keeps non-todo columns on priority then task ID ordering", () => {
        const tasks: Task[] = [
          createTask({ id: "FN-050", description: "Fifty", column: "in-progress", priority: "normal", createdAt: "2024-01-01T12:00:00.000Z" }),
          createTask({ id: "FN-010", description: "Ten", column: "in-progress", priority: "normal", createdAt: "2024-01-01T09:00:00.000Z" }),
          createTask({ id: "FN-030", description: "Thirty", column: "in-progress", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
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

    describe("column default ordering merging pinning", () => {
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

    it("renders server-filtered branch-target results without additional client filtering", () => {
      const branchFilteredTasks: Task[] = [
        createTask({
          id: "FN-3428",
          description: "Task targeting release branch",
          column: "todo",
          branch: "feature/fn-3428",
          baseBranch: "release/2026-05",
        }),
      ];

      renderBoard({ tasks: branchFilteredTasks, searchQuery: "release/2026-05" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]") as Task[];
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0]?.id).toBe("FN-3428");
      expect(todoTasks[0]?.branch).toBe("feature/fn-3428");
      expect(todoTasks[0]?.baseBranch).toBe("release/2026-05");
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

  describe("multi-lane board (U9, flag ON)", () => {
    const mkTask = (overrides: Partial<Task> & { id: string }): Task => ({
      title: overrides.id,
      description: "d",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    });

    const CUSTOM_WORKFLOW = {
      id: "wf-custom",
      name: "Custom Flow",
      columns: [
        { id: "intake", name: "Intake", flags: { intake: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    };

    function enableFlag(taskWorkflowIds: Record<string, string>, workflows = [DEFAULT_WORKFLOW]) {
      fetchBoardWorkflowsMock.mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows,
        taskWorkflowIds,
      });
    }


    async function openWorkflowSwitcher() {
      const trigger = await screen.findByTestId("workflow-switcher");
      fireEvent.click(trigger);
      return trigger;
    }

    function workflowSwitcherOptionIds() {
      return screen.getAllByRole("option").map((option) => option.getAttribute("data-testid")?.replace("workflow-switcher-option-", ""));
    }

    async function selectWorkflow(workflowId: string) {
      await openWorkflowSwitcher();
      fireEvent.click(screen.getByTestId(`workflow-switcher-option-${workflowId}`));
    }

    it("flag OFF renders the legacy single-lane board byte-identically", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue({
        flagEnabled: false,
        defaultWorkflowId: "builtin:coding",
        workflows: [],
        taskWorkflowIds: {},
      });
      renderBoard({ tasks: [mkTask({ id: "FN-1" })] });
      // Let the board-workflows fetch resolve (flagEnabled:false) so the async
      // state settle is wrapped and the legacy board stays the rendered output.
      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalled());
      const board = screen.getByRole("main");
      expect(board.className).toBe("board");
      // All 6 legacy columns present; no lanes.
      for (const col of COLUMNS) {
        expect(screen.getByTestId(`column-${col}`)).toBeDefined();
      }
      expect(screen.queryByTestId(/^lane-/)).toBeNull();
    });

    it("hydrates remounted board workflow selection from durable project storage", async () => {
      const projectId = "project-board-persist";
      enableFlag({}, [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW]);
      const { unmount } = renderBoard({ projectId });

      await selectWorkflow(CUSTOM_WORKFLOW.id);
      await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent(CUSTOM_WORKFLOW.name));
      expect(window.localStorage.getItem(scopedKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId))).toBe(CUSTOM_WORKFLOW.id);

      unmount();
      enableFlag({}, [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW]);
      renderBoard({ projectId });

      await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent(CUSTOM_WORKFLOW.name));
    });

    it("keeps a custom board workflow selected after task refresh and workflow payload revalidation", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
        taskWorkflowIds: { "FN-1": "wf-custom" },
      });
      const { rerender } = renderBoard({
        projectId: "project-board-refresh",
        tasks: [mkTask({ id: "FN-1", column: "intake", title: "Custom task" })],
      });

      await selectWorkflow(CUSTOM_WORKFLOW.id);
      await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent(CUSTOM_WORKFLOW.name));

      rerender(<Board {...createBoardProps({
        projectId: "project-board-refresh",
        tasks: [mkTask({ id: "FN-1", column: "done", title: "Custom task after respec" })],
      })} />);
      await act(async () => {
        sseHandlers["workflow:updated"]?.();
      });

      await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent(CUSTOM_WORKFLOW.name));
      expect(screen.getByTestId("column-done")).toHaveAttribute("data-tasks", expect.stringContaining("FN-1"));
    });

    it("tasks with no selection render in the default selected workflow", async () => {
      enableFlag({ "FN-1": "builtin:coding", "FN-2": "builtin:coding" });
      renderBoard({ tasks: [mkTask({ id: "FN-1" }), mkTask({ id: "FN-2", column: "in-progress" })] });
      await waitFor(() => expect(screen.getByTestId("column-todo")).toBeDefined());
      expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id)).toEqual(["FN-1"]);
      expect(JSON.parse(screen.getByTestId("column-in-progress").getAttribute("data-tasks") || "[]").map((task: Task) => task.id)).toEqual(["FN-2"]);
      expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("Coding");
    });

    it("puts create controls on the workflow intake column instead of the first visible column", async () => {
      const workflow = {
        id: "wf-intake-second",
        name: "Intake second",
        columns: [
          { id: "queue", name: "Queue", flags: { hold: true } },
          { id: "idea", name: "Idea", flags: { intake: true } },
          { id: "shipped", name: "Shipped", flags: { complete: true } },
        ],
      };
      enableFlag({ "FN-1": workflow.id }, [workflow]);
      renderBoard({ tasks: [mkTask({ id: "FN-1", column: "queue" })] });

      await waitFor(() => expect(screen.getByTestId("column-queue")).toBeDefined());

      expect(screen.getByTestId("column-queue").getAttribute("data-has-new-task")).toBe("no");
      expect(screen.getByTestId("column-queue").getAttribute("data-has-quick-create")).toBe("no");
      expect(screen.getByTestId("column-idea").getAttribute("data-has-new-task")).toBe("yes");
      expect(screen.getByTestId("column-idea").getAttribute("data-has-quick-create")).toBe("yes");
    });

    it("passes auto-merge toggle to selected workflow human-review columns", async () => {
      const workflow = {
        ...DEFAULT_WORKFLOW,
        columns: [
          { id: "triage", name: "Triage", flags: { intake: true } },
          { id: "review", name: "Review", flags: { humanReview: true } },
          { id: "done", name: "Done", flags: { complete: true } },
        ],
      };
      enableFlag({ "FN-1": workflow.id }, [workflow]);
      renderBoard({ tasks: [mkTask({ id: "FN-1", column: "review" })] });

      await waitFor(() => expect(screen.getByTestId("column-review")).toBeDefined());
      expect(screen.getByTestId("column-review").getAttribute("data-has-auto-merge-toggle")).toBe("yes");
    });

    it("keeps workflow create and edit actions visible when only one workflow exists", async () => {
      const onCreateWorkflow = vi.fn();
      const onOpenWorkflowEditor = vi.fn();
      enableFlag({ "FN-1": "builtin:coding" }, [DEFAULT_WORKFLOW]);

      renderBoard({
        tasks: [mkTask({ id: "FN-1", column: "triage" })],
        onCreateWorkflow,
        onOpenWorkflowEditor,
      });

      await waitFor(() => expect(screen.getByTestId("column-triage")).toBeDefined());
      const selector = screen.getByTestId("workflow-switcher");
      expect(document.querySelector(".board-workflow-edit-btn")).toBeNull();
      expect(document.querySelector(".board-workflow-create-btn")).toBeNull();

      fireEvent.click(selector);
      fireEvent.click(screen.getByTestId("workflow-switcher-create"));
      fireEvent.click(selector);
      fireEvent.click(screen.getByTestId("workflow-switcher-edit-builtin:coding"));
      expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
      expect(onOpenWorkflowEditor).toHaveBeenCalledWith("builtin:coding");
    });

    it("preserves workflow toolbar partial action visibility", async () => {
      const onCreateWorkflow = vi.fn();
      enableFlag({}, [DEFAULT_WORKFLOW]);
      const { unmount } = renderBoard({ onCreateWorkflow });

      await waitFor(() => expect(document.querySelector(".board-workflow-toolbar")).not.toBeNull());
      expect(document.querySelector(".board-workflow-create-btn")).toBeNull();
      fireEvent.click(screen.getByTestId("workflow-switcher"));
      fireEvent.click(screen.getByTestId("workflow-switcher-create"));
      expect(screen.queryByTestId("workflow-switcher-edit-builtin:coding")).toBeNull();
      expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
      unmount();

      const onOpenWorkflowEditor = vi.fn();
      enableFlag({}, [DEFAULT_WORKFLOW]);
      renderBoard({ onOpenWorkflowEditor });

      await waitFor(() => expect(document.querySelector(".board-workflow-toolbar")).not.toBeNull());
      expect(document.querySelector(".board-workflow-edit-btn")).toBeNull();
      fireEvent.click(screen.getByTestId("workflow-switcher"));
      expect(screen.queryByTestId("workflow-switcher-create")).toBeNull();
      fireEvent.click(screen.getByTestId("workflow-switcher-edit-builtin:coding"));
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
    });

    it("renders workflow toolbar actions without a collapse affordance", async () => {
      const onCreateWorkflow = vi.fn();
      const onOpenWorkflowEditor = vi.fn();
      enableFlag(
        { "FN-1": "builtin:coding", "FN-2": "wf-custom" },
        [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
      );
      renderBoard({
        tasks: [mkTask({ id: "FN-1" }), mkTask({ id: "FN-2", column: "intake" })],
        onCreateWorkflow,
        onOpenWorkflowEditor,
      });

      const selector = await screen.findByTestId("workflow-switcher");
      expect(document.querySelector(".board-workflow-edit-btn")).toBeNull();
      expect(document.querySelector(".board-workflow-create-btn")).toBeNull();
      fireEvent.click(selector);
      expect(screen.getByTestId("workflow-switcher-create")).toBeDefined();
      expect(screen.getByTestId("workflow-switcher-edit-builtin:coding")).toBeDefined();
      expect(screen.getByTestId("workflow-switcher-edit-wf-custom")).toBeDefined();
      const toolbar = document.querySelector(".board-workflow-toolbar");
      expect(toolbar).not.toBeNull();
      expect(toolbar?.hasAttribute("data-collapsed")).toBe(false);
      expect(toolbar?.querySelector(".board-workflow-collapse-toggle")).toBeNull();
      expect(toolbar?.querySelector(".board-workflow-collapsed-label")).toBeNull();
      expect(screen.queryByTestId("board-workflow-collapse-toggle")).toBeNull();
    });

    it("relocates workflow selector, edit, and create controls into the header slot", async () => {
      const onCreateWorkflow = vi.fn();
      const onOpenWorkflowEditor = vi.fn();
      const headerSlot = document.createElement("div");
      headerSlot.id = "header-workflow-slot";
      headerSlot.className = "header-workflow-slot";
      document.body.appendChild(headerSlot);
      enableFlag(
        { "FN-1": "builtin:coding", "FN-2": "wf-custom" },
        [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
      );
      try {
        renderBoard({
          tasks: [mkTask({ id: "FN-1" }), mkTask({ id: "FN-2", column: "intake" })],
          onCreateWorkflow,
          onOpenWorkflowEditor,
          workflowControlsInHeader: true,
        });

        const selector = await screen.findByTestId("workflow-switcher");
        await waitFor(() => expect(headerSlot.querySelector(".board-workflow-toolbar")).not.toBeNull());
        expect(headerSlot.contains(selector)).toBe(true);
        expect(headerSlot.querySelector(".board-workflow-edit-btn")).toBeNull();
        expect(headerSlot.querySelector(".board-workflow-create-btn")).toBeNull();
        expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();

        fireEvent.click(selector);
        expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-custom"));
        await waitFor(() => expect(screen.getByTestId("column-intake")).toBeDefined());
        expect(screen.queryByTestId("column-todo")).toBeNull();
        fireEvent.click(selector);
        fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-custom"));
        expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-custom");
      } finally {
        headerSlot.remove();
      }
    });

    it("keeps the board workflow toolbar inline when header relocation is inactive", async () => {
      const headerSlot = document.createElement("div");
      headerSlot.id = "header-workflow-slot";
      document.body.appendChild(headerSlot);
      enableFlag({ "FN-1": "builtin:coding", "FN-2": "wf-custom" }, [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW]);
      try {
        renderBoard({
          tasks: [mkTask({ id: "FN-1" }), mkTask({ id: "FN-2", column: "intake" })],
          onCreateWorkflow: vi.fn(),
          onOpenWorkflowEditor: vi.fn(),
        });

        await screen.findByTestId("workflow-switcher");
        await waitFor(() => expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).not.toBeNull());
        expect(headerSlot.querySelector(".board-workflow-toolbar")).toBeNull();
      } finally {
        headerSlot.remove();
      }
    });

    it("relocates the aggregate selector without empty action shells", async () => {
      const headerSlot = document.createElement("div");
      headerSlot.id = "header-workflow-slot";
      document.body.appendChild(headerSlot);
      enableFlag({ "FN-1": "builtin:coding" }, [DEFAULT_WORKFLOW]);
      try {
        renderBoard({
          tasks: [mkTask({ id: "FN-1" })],
          workflowControlsInHeader: true,
        });

        await waitFor(() => expect(screen.getByTestId("column-todo")).toBeDefined());
        await waitFor(() => expect(headerSlot.querySelector(".board-workflow-toolbar")).not.toBeNull());
        expect(headerSlot.querySelector(".board-workflow-edit-btn")).toBeNull();
        expect(headerSlot.querySelector(".board-workflow-create-btn")).toBeNull();
        fireEvent.click(screen.getByTestId("workflow-switcher"));
        expect(screen.getByTestId("workflow-switcher-option-__all_workflows__")).toBeInTheDocument();
        expect(screen.queryByTestId("workflow-switcher-edit-__all_workflows__")).toBeNull();
      } finally {
        headerSlot.remove();
      }
    });

    it("renders one selected workflow at a time and switches workflows from the dropdown", async () => {
      const onCreateWorkflow = vi.fn();
      const onOpenWorkflowEditor = vi.fn();
      enableFlag(
        { "FN-1": "builtin:coding", "FN-2": "wf-custom", "FN-3": "wf-custom" },
        [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
      );
      renderBoard({
        tasks: [
          mkTask({ id: "FN-1" }),
          mkTask({ id: "FN-2", column: "intake" }),
          mkTask({ id: "FN-3", column: "intake" }),
        ],
        onCreateWorkflow,
        onOpenWorkflowEditor,
      });
      const selector = await screen.findByTestId("workflow-switcher");
      expect(selector).toHaveTextContent("Coding");
      expect(selector.querySelector(".workflow-switcher-counts")).toBeNull();
      await openWorkflowSwitcher();
      expect(selector).toHaveTextContent("1");
      expect(screen.getByTestId("workflow-switcher-option-wf-custom")).toHaveTextContent("2");
      fireEvent.keyDown(selector, { key: "Escape" });
      expect(document.querySelector(".board-workflow-edit-btn")).toBeNull();
      expect(document.querySelector(".board-workflow-create-btn")).toBeNull();
      fireEvent.click(selector);
      fireEvent.click(screen.getByTestId("workflow-switcher-create"));
      fireEvent.click(selector);
      fireEvent.click(screen.getByTestId("workflow-switcher-edit-builtin:coding"));
      expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
      expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id)).toEqual(["FN-1"]);
      expect(screen.getByTestId("column-todo")).toHaveAttribute("data-workflow-badges", "{}");
      expect(screen.queryByTestId("column-intake")).toBeNull();

      await selectWorkflow("wf-custom");
      await waitFor(() => expect(screen.getByTestId("column-intake")).toBeDefined());
      expect(JSON.parse(screen.getByTestId("column-intake").getAttribute("data-tasks") || "[]").map((task: Task) => task.id).sort()).toEqual(["FN-2", "FN-3"]);
      expect(screen.queryByTestId("column-todo")).toBeNull();

      fireEvent.click(screen.getByTestId("workflow-switcher"));
      fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-custom"));
      expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-custom");
    });

    it("selects the all-workflows aggregate view without persisting the sentinel", async () => {
      const projectId = "project-board-all-workflows";
      enableFlag(
        { "FN-1": "builtin:coding", "FN-2": "wf-custom" },
        [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
      );
      renderBoard({
        projectId,
        tasks: [mkTask({ id: "FN-1", column: "todo" }), mkTask({ id: "FN-2", column: "intake" })],
        onPlanningMode: vi.fn(),
        onSubtaskBreakdown: vi.fn(),
      });

      await selectWorkflow("__all_workflows__");

      expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("All workflows");
      expect(screen.getByTestId("column-todo")).toHaveAttribute("data-tasks", expect.stringContaining("FN-1"));
      expect(screen.getByTestId("column-intake")).toHaveAttribute("data-tasks", expect.stringContaining("FN-2"));
      expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-workflow-badges") || "{}")).toMatchObject({
        "FN-1": { workflowId: "builtin:coding", workflowName: "Coding (built-in)" },
      });
      expect(JSON.parse(screen.getByTestId("column-intake").getAttribute("data-workflow-badges") || "{}")).toMatchObject({
        "FN-2": { workflowId: "wf-custom", workflowName: "Custom Flow" },
      });
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-workflow-id", "builtin:coding");
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-has-can-drop", "no");
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-has-planning", "yes");
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-has-subtask", "yes");
      expect(window.localStorage.getItem(scopedKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId))).toBeNull();

      fireEvent.click(screen.getByTestId("workflow-switcher"));
      expect(screen.queryByTestId("workflow-switcher-edit-__all_workflows__")).toBeNull();
    });

    it("falls stale and missing task workflow ids back to the default workflow", async () => {
      enableFlag(
        { "FN-default": "builtin:coding", "FN-stale": "wf-deleted", "FN-custom": "wf-custom" },
        [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
      );
      renderBoard({
        tasks: [
          mkTask({ id: "FN-default", column: "todo" }),
          mkTask({ id: "FN-stale", column: "todo" }),
          mkTask({ id: "FN-missing", column: "todo" }),
          mkTask({ id: "FN-custom", column: "intake" }),
        ],
      });

      await waitFor(() => expect(screen.getByTestId("column-todo")).toBeDefined());
      const defaultWorkflowIds = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id).sort();
      expect(defaultWorkflowIds).toEqual(["FN-default", "FN-missing", "FN-stale"]);

      await openWorkflowSwitcher();
      expect(screen.getByTestId("workflow-switcher-option-builtin:coding")).toHaveTextContent("3");
      fireEvent.click(screen.getByTestId("workflow-switcher-option-__all_workflows__"));
      const aggregateTodoIds = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id).sort();
      expect(aggregateTodoIds).toEqual(["FN-default", "FN-missing", "FN-stale"]);
      expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-workflow-badges") || "{}")).toMatchObject({
        "FN-default": { workflowId: "builtin:coding", workflowName: "Coding (built-in)" },
        "FN-missing": { workflowId: "builtin:coding", workflowName: "Coding (built-in)" },
        "FN-stale": { workflowId: "builtin:coding", workflowName: "Coding (built-in)" },
      });
      expect(screen.getByTestId("column-intake")).toHaveAttribute("data-tasks", expect.stringContaining("FN-custom"));
    });

    it("keeps hidden workflow tasks out of shared aggregate columns and archived columns collapsed", async () => {
      const customWorkflow = {
        id: "wf-archive-hidden",
        name: "Archive + Hidden Flow",
        columns: [
          { id: "ready", name: "Ready", flags: { intake: true } },
          { id: "quiet", name: "Quiet", flags: { hiddenFromBoard: true } },
          { id: "cold-storage", name: "Cold storage", flags: { archived: true } },
        ],
      };
      const visibleQuietWorkflow = {
        id: "wf-visible-quiet",
        name: "Visible Quiet Flow",
        columns: [
          { id: "quiet", name: "Visible quiet", flags: { intake: true } },
        ],
      };
      enableFlag(
        { "FN-ready": "wf-archive-hidden", "FN-quiet-hidden": "wf-archive-hidden", "FN-quiet-visible": "wf-visible-quiet", "FN-cold": "wf-archive-hidden" },
        [DEFAULT_WORKFLOW, customWorkflow, visibleQuietWorkflow],
      );
      renderBoard({
        tasks: [
          mkTask({ id: "FN-ready", column: "ready" }),
          mkTask({ id: "FN-quiet-hidden", column: "quiet" }),
          mkTask({ id: "FN-quiet-visible", column: "quiet" }),
          mkTask({ id: "FN-cold", column: "cold-storage" }),
        ],
      });

      await selectWorkflow("__all_workflows__");

      expect(screen.getByTestId("column-ready")).toHaveAttribute("data-tasks", expect.stringContaining("FN-ready"));
      expect(screen.getByTestId("column-quiet")).toHaveAttribute("data-tasks", expect.stringContaining("FN-quiet-visible"));
      expect(screen.getByTestId("column-quiet")).not.toHaveAttribute("data-tasks", expect.stringContaining("FN-quiet-hidden"));
      expect(screen.getByTestId("column-cold-storage")).toHaveAttribute("data-tasks", expect.stringContaining("FN-cold"));
      expect(screen.getByTestId("column-cold-storage")).toHaveAttribute("data-collapsed", "true");
      expect(screen.getByRole("main").lastElementChild).toBe(screen.getByTestId("column-cold-storage"));
    });

    it("creates aggregate tasks only from a real workflow intake column", async () => {
      const customDefaultWorkflow = {
        id: "wf-custom-default",
        name: "Custom Default",
        columns: [
          { id: "inbox", name: "Inbox", flags: { intake: true } },
          { id: "active", name: "Active", flags: { countsTowardWip: true } },
          { id: "finished", name: "Finished", flags: { complete: true } },
        ],
      };
      fetchBoardWorkflowsMock.mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom-default",
        workflows: [customDefaultWorkflow, DEFAULT_WORKFLOW],
        taskWorkflowIds: { "FN-custom-default": "wf-custom-default" },
      });
      renderBoard({
        tasks: [mkTask({ id: "FN-custom-default", column: "inbox" })],
        onPlanningMode: vi.fn(),
        onSubtaskBreakdown: vi.fn(),
      });

      await selectWorkflow("__all_workflows__");

      expect(screen.getByTestId("column-inbox")).toHaveAttribute("data-has-quick-create", "yes");
      expect(screen.getByTestId("column-inbox")).toHaveAttribute("data-workflow-id", "wf-custom-default");
      expect(screen.getByTestId("column-inbox")).toHaveAttribute("data-has-planning", "yes");
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-has-quick-create", "no");
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-workflow-id", "");
    });

    it("uses default workflow column labels and flags for duplicate aggregate column ids", async () => {
      const duplicateNameWorkflow = {
        id: "wf-duplicate",
        name: "Coding (built-in)",
        columns: [
          { id: "todo", name: "Queue from duplicate", flags: { intake: true } },
          { id: "done", name: "Complete from duplicate", flags: { complete: true } },
        ],
      };
      enableFlag(
        { "FN-1": "builtin:coding", "FN-2": "wf-duplicate" },
        [duplicateNameWorkflow, DEFAULT_WORKFLOW],
      );
      renderBoard({ tasks: [mkTask({ id: "FN-1", column: "todo" }), mkTask({ id: "FN-2", column: "todo" })] });

      await selectWorkflow("__all_workflows__");

      expect(screen.getByTestId("column-todo")).toHaveAttribute("data-column-display-name", "Todo");
      expect(screen.getByTestId("column-todo")).toHaveAttribute("data-has-quick-create", "no");
      expect(screen.getByTestId("column-triage")).toHaveAttribute("data-has-quick-create", "yes");
      await openWorkflowSwitcher();
      expect(workflowSwitcherOptionIds()).toEqual(["__all_workflows__", "builtin:coding", "wf-duplicate"]);
    });

    it("keeps the default workflow first in the dropdown even when another workflow has cards", async () => {
      enableFlag(
        { "FN-2": "wf-custom" },
        [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
      );
      renderBoard({ tasks: [mkTask({ id: "FN-2", column: "intake" })] });
      const selector = await openWorkflowSwitcher();
      expect(workflowSwitcherOptionIds()).toEqual(["__all_workflows__", "builtin:coding", "wf-custom"]);
      expect(selector).toHaveTextContent("Coding");
      expect(screen.queryByTestId("column-intake")).toBeNull();
    });

    it("orders the default workflow first when workflow payload order differs", async () => {
      enableFlag(
        { "FN-1": "builtin:coding", "FN-2": "wf-custom" },
        [CUSTOM_WORKFLOW, DEFAULT_WORKFLOW],
      );
      renderBoard({ tasks: [mkTask({ id: "FN-1" }), mkTask({ id: "FN-2", column: "intake" })] });
      await openWorkflowSwitcher();
      expect(workflowSwitcherOptionIds()).toEqual(["__all_workflows__", "builtin:coding", "wf-custom"]);
    });

    it("renders archived cards in the selected workflow archived column", async () => {
      enableFlag({ "FN-1": "builtin:coding", "FN-9": "builtin:coding" });
      renderBoard({ tasks: [mkTask({ id: "FN-1" }), mkTask({ id: "FN-9", column: "archived" })] });
      await waitFor(() => expect(screen.getByTestId("column-archived")).toBeDefined());
      const todoIds = JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id);
      expect(todoIds).toEqual(["FN-1"]);
      const archivedIds = JSON.parse(screen.getByTestId("column-archived").getAttribute("data-tasks") || "[]").map((task: Task) => task.id);
      expect(archivedIds).toEqual(["FN-9"]);
    });

    it("renders selected workflow columns as direct children of the horizontal board", async () => {
      enableFlag({ "FN-1": "builtin:coding" }, [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW]);
      renderBoard({ tasks: [mkTask({ id: "FN-1" })] });
      await waitFor(() => expect(screen.getByRole("main").className).toContain("board-workflow-columns"));
      expect([...screen.getByRole("main").children].map((child) => child.getAttribute("data-testid"))).toEqual([
        "column-triage",
        "column-todo",
        "column-in-progress",
        "column-in-review",
        "column-done",
        "column-archived",
      ]);
    });

    it("archived column is collapsible in workflow mode", async () => {
      enableFlag({ "FN-9": "builtin:coding" });
      renderBoard({ tasks: [mkTask({ id: "FN-9", column: "archived" })] });

      const archivedColumn = await screen.findByTestId("column-archived");
      expect(archivedColumn.getAttribute("data-collapsed")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "toggle-archived" }));
      expect(screen.getByTestId("column-archived").getAttribute("data-collapsed")).toBe("false");

      fireEvent.click(screen.getByRole("button", { name: "toggle-archived" }));
      expect(screen.getByTestId("column-archived").getAttribute("data-collapsed")).toBe("true");
    });

    it("workflow without archived column does not render one", async () => {
      enableFlag({ "FN-1": CUSTOM_WORKFLOW.id }, [CUSTOM_WORKFLOW]);
      renderBoard({ tasks: [mkTask({ id: "FN-1", column: "intake" })] });

      await waitFor(() => expect(screen.getByTestId("column-intake")).toBeDefined());
      expect(screen.queryByTestId("column-archived")).toBeNull();
    });

    it("built-in workflow Done uses the selected Done sort mode", async () => {
      const tasks = [
        mkTask({ id: "FN-003", column: "done", columnMovedAt: "2024-01-01T09:00:00.000Z" }),
        mkTask({ id: "FN-001", column: "done", columnMovedAt: "2024-01-01T11:00:00.000Z" }),
        mkTask({ id: "FN-002", column: "done", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
        mkTask({ id: "FN-004", column: "done", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
        mkTask({ id: "FN-050", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
        mkTask({ id: "FN-010", column: "todo", priority: "normal", createdAt: "2024-01-01T10:00:00.000Z" }),
      ];
      enableFlag(Object.fromEntries(tasks.map((task) => [task.id, "builtin:coding"])));
      renderBoard({ tasks });

      const readIds = (column: string) => (JSON.parse(screen.getByTestId(`column-${column}`).getAttribute("data-tasks") || "[]") as Task[]).map((task) => task.id);
      await waitFor(() => expect(screen.getByTestId("column-done")).toHaveAttribute("data-done-sort-mode", "completion-date-desc"));
      expect(readIds("done")).toEqual(["FN-001", "FN-002", "FN-004", "FN-003"]);
      expect(readIds("todo")).toEqual(["FN-010", "FN-050"]);
      expect(screen.getByTestId("column-todo")).toHaveAttribute("data-has-done-sort-handler", "no");

      fireEvent.click(screen.getByRole("button", { name: "sort-done-by-id" }));

      expect(screen.getByTestId("column-done")).toHaveAttribute("data-done-sort-mode", "task-id-desc");
      expect(readIds("done")).toEqual(["FN-004", "FN-003", "FN-002", "FN-001"]);
      expect(readIds("todo")).toEqual(["FN-010", "FN-050"]);
    });

    it("passes Done sort state to an empty built-in workflow Done column", async () => {
      enableFlag({});
      renderBoard({ tasks: [] });

      await waitFor(() => expect(screen.getByTestId("column-done")).toHaveAttribute("data-tasks", "[]"));
      expect(screen.getByTestId("column-done")).toHaveAttribute("data-done-sort-mode", "completion-date-desc");
      expect(screen.getByTestId("column-done")).toHaveAttribute("data-has-done-sort-handler", "yes");
    });

    it("uses the selected Done sort mode for custom complete workflow columns", async () => {
      const workflow = {
        id: "wf-shipped",
        name: "Custom shipped",
        columns: [
          { id: "todo", name: "Todo", flags: { intake: true } },
          { id: "shipped", name: "Shipped", flags: { complete: true } },
        ],
      };
      const tasks = [
        mkTask({ id: "FN-003", column: "shipped", priority: "normal", columnMovedAt: "2024-01-01T09:00:00.000Z" }),
        mkTask({ id: "FN-001", column: "shipped", priority: "normal", columnMovedAt: "2024-01-01T11:00:00.000Z" }),
        mkTask({ id: "FN-002", column: "shipped", priority: "normal", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
      ];
      enableFlag({ "FN-003": workflow.id, "FN-001": workflow.id, "FN-002": workflow.id }, [workflow]);
      renderBoard({ tasks });

      const readIds = () => (JSON.parse(screen.getByTestId("column-shipped").getAttribute("data-tasks") || "[]") as Task[]).map((task) => task.id);
      await waitFor(() => expect(screen.getByTestId("column-shipped")).toHaveAttribute("data-done-sort-mode", "completion-date-desc"));
      expect(screen.getByTestId("column-shipped")).toHaveAttribute("data-has-done-sort-handler", "yes");
      expect(readIds()).toEqual(["FN-001", "FN-002", "FN-003"]);

      fireEvent.click(screen.getByRole("button", { name: "sort-shipped-by-id" }));

      expect(screen.getByTestId("column-shipped")).toHaveAttribute("data-done-sort-mode", "task-id-desc");
      expect(readIds()).toEqual(["FN-003", "FN-002", "FN-001"]);
    });

    it("done column in workflow mode receives onArchiveAllDone prop", async () => {
      const onArchiveAllDone = vi.fn();
      enableFlag({ "FN-1": "builtin:coding" });
      renderBoard({ tasks: [mkTask({ id: "FN-1", column: "done" })], onArchiveAllDone });

      await waitFor(() => expect(screen.getByTestId("column-done")).toBeDefined());
      expect(screen.getByTestId("column-done").getAttribute("data-has-archive-all")).toBe("yes");
      expect(screen.getByTestId("column-todo").getAttribute("data-has-archive-all")).toBe("no");
    });

    it("re-fetches board-workflows when the workflow switcher opens", async () => {
      enableFlag({ "FN-1": "builtin:coding" }, [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW]);
      renderBoard({ projectId: "proj-1", tasks: [mkTask({ id: "FN-1", column: "todo" })] });

      const trigger = await screen.findByTestId("workflow-switcher");
      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(1));
      fetchBoardWorkflowsMock.mockClear();

      fireEvent.click(trigger);

      expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
    });
  });

  describe("workflow:updated SSE invalidation (#1406)", () => {
    it("re-fetches board-workflows when a workflow:updated SSE event arrives", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue({
        flagEnabled: false,
        defaultWorkflowId: "builtin:coding",
        workflows: [],
        taskWorkflowIds: {},
      });
      renderBoard({ projectId: "proj-1" });
      // Initial mount fetch.
      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(1));
      // Board subscribed for workflow lifecycle events.
      expect(subscribeSseMock).toHaveBeenCalled();
      expect(typeof sseHandlers["workflow:updated"]).toBe("function");

      // Simulate a server-pushed workflow:updated event → invalidate + re-fetch.
      await act(async () => {
        sseHandlers["workflow:updated"]?.();
      });
      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(2));
    });

    it("re-homes a preserved-column task to the new workflow after workflow invalidation", async () => {
      const preservedWorkflow = {
        id: "wf-preserved",
        name: "Preserved Flow",
        columns: [
          { id: "todo", name: "Todo", flags: { intake: true } },
          { id: "done", name: "Done", flags: { complete: true } },
        ],
      };
      fetchBoardWorkflowsMock
        .mockResolvedValueOnce({
          flagEnabled: true,
          defaultWorkflowId: "builtin:coding",
          workflows: [DEFAULT_WORKFLOW, preservedWorkflow],
          taskWorkflowIds: { "FN-1": "builtin:coding" },
        })
        .mockResolvedValueOnce({
          flagEnabled: true,
          defaultWorkflowId: "builtin:coding",
          workflows: [DEFAULT_WORKFLOW, preservedWorkflow],
          taskWorkflowIds: { "FN-1": "wf-preserved" },
        });
      renderBoard({ projectId: "proj-1", tasks: [{
        id: "FN-1",
        title: "Preserved switcher",
        description: "d",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      } as Task] });

      const selector = await screen.findByTestId("workflow-switcher");
      await waitFor(() => expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id)).toEqual(["FN-1"]));
      expect(selector).toHaveTextContent("Coding");

      await act(async () => {
        sseHandlers["workflow:updated"]?.();
      });

      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id)).toEqual([]));

      await selectWorkflow("wf-preserved");
      await waitFor(() => expect(JSON.parse(screen.getByTestId("column-todo").getAttribute("data-tasks") || "[]").map((task: Task) => task.id)).toEqual(["FN-1"]));
    });
  });
});
