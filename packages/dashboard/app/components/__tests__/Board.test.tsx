import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board } from "../Board";
import { COLUMNS } from "@kb/core";

import type { Task } from "@kb/core";

// Mock child components so we only test Board's own rendering
vi.mock("../Column", () => ({
  Column: ({ column, tasks }: { column: string; tasks: Task[] }) => (
    <div data-testid={`column-${column}`} data-tasks={JSON.stringify(tasks)} />
  ),
}));

const noop = () => {};
const noopAsync = () => Promise.resolve({} as any);

function renderBoard(props = {}) {
  return render(
    <Board
      tasks={[]}
      maxConcurrent={2}
      onMoveTask={noopAsync}
      onOpenDetail={noop}
      addToast={noop}
      onQuickCreate={noopAsync}
      onNewTask={noop}
      autoMerge={true}
      onToggleAutoMerge={noop}
      globalPaused={false}
      {...props}
    />,
  );
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
      id: overrides.id,
      title: overrides.title,
      description: overrides.description,
      column: overrides.column ?? "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    });

    it("filters tasks by ID when search query is provided", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", description: "First task", column: "todo" }),
        createTask({ id: "KB-002", description: "Second task", column: "todo" }),
        createTask({ id: "KB-003", description: "Third task", column: "in-progress" }),
      ];

      renderBoard({ tasks, searchQuery: "KB-002" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("KB-002");

      const inProgressColumn = screen.getByTestId("column-in-progress");
      const inProgressTasks = JSON.parse(inProgressColumn.getAttribute("data-tasks") || "[]");
      expect(inProgressTasks).toHaveLength(0);
    });

    it("filters tasks by title when search query is provided", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", title: "Fix login bug", description: "First task", column: "todo" }),
        createTask({ id: "KB-002", title: "Add dashboard feature", description: "Second task", column: "todo" }),
        createTask({ id: "KB-003", title: "Update documentation", description: "Third task", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "dashboard" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("KB-002");
    });

    it("filters tasks by description when search query is provided", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", description: "Implement user authentication", column: "todo" }),
        createTask({ id: "KB-002", description: "Fix database connection issue", column: "todo" }),
        createTask({ id: "KB-003", description: "Add caching layer", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "database" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("KB-002");
    });

    it("search is case-insensitive", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", title: "Fix Login Bug", description: "First task", column: "todo" }),
        createTask({ id: "KB-002", title: "Add Dashboard Feature", description: "Second task", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "login" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("KB-001");
    });

    it("search is case-insensitive for lowercase query matching uppercase content", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-UPPER", title: "UPPERCASE TITLE", description: "DESC", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "upper" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(1);
      expect(todoTasks[0].id).toBe("KB-UPPER");
    });

    it("shows all tasks when search query is empty", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", description: "First task", column: "todo" }),
        createTask({ id: "KB-002", description: "Second task", column: "todo" }),
        createTask({ id: "KB-003", description: "Third task", column: "in-progress" }),
      ];

      renderBoard({ tasks, searchQuery: "" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(2);

      const inProgressColumn = screen.getByTestId("column-in-progress");
      const inProgressTasks = JSON.parse(inProgressColumn.getAttribute("data-tasks") || "[]");
      expect(inProgressTasks).toHaveLength(1);
    });

    it("shows no tasks when search query matches nothing", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", description: "First task", column: "todo" }),
        createTask({ id: "KB-002", description: "Second task", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "nonexistent" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");
      expect(todoTasks).toHaveLength(0);
    });

    it("filtered tasks are sorted correctly (columnMovedAt, createdAt)", () => {
      const tasks: Task[] = [
        createTask({
          id: "KB-001",
          description: "Old task with move time",
          column: "todo",
          columnMovedAt: "2024-01-01T10:00:00.000Z",
          createdAt: "2024-01-01T08:00:00.000Z",
        }),
        createTask({
          id: "KB-002",
          description: "Newer task with move time",
          column: "todo",
          columnMovedAt: "2024-01-01T12:00:00.000Z",
          createdAt: "2024-01-01T08:00:00.000Z",
        }),
        createTask({
          id: "KB-003",
          description: "Legacy task no move time",
          column: "todo",
          createdAt: "2024-01-01T09:00:00.000Z",
        }),
      ];

      renderBoard({ tasks, searchQuery: "task" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]") as Task[];

      // Should have all 3 tasks
      expect(todoTasks).toHaveLength(3);

      // Tasks with columnMovedAt should come first, sorted by columnMovedAt descending (newest first)
      // So KB-002 (12:00) should be first, KB-001 (10:00) second
      // Legacy tasks (no columnMovedAt) come last, sorted by createdAt ascending
      expect(todoTasks[0].id).toBe("KB-002");
      expect(todoTasks[1].id).toBe("KB-001");
      expect(todoTasks[2].id).toBe("KB-003");
    });

    it("matches tasks across multiple fields simultaneously", () => {
      const tasks: Task[] = [
        createTask({ id: "SEARCH-123", title: "Searchable title", description: "Normal description", column: "todo" }),
        createTask({ id: "KB-999", title: "Other task", description: "This has searchable content", column: "todo" }),
        createTask({ id: "KB-888", title: "Unrelated", description: "No match here", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "search" });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");

      // Should match both tasks with "search" in ID, title, or description
      expect(todoTasks).toHaveLength(2);
      expect(todoTasks.map((t: Task) => t.id).sort()).toEqual(["KB-999", "SEARCH-123"]);
    });

    it("trims whitespace from search query", () => {
      const tasks: Task[] = [
        createTask({ id: "KB-001", description: "First task", column: "todo" }),
      ];

      renderBoard({ tasks, searchQuery: "  " });

      const todoColumn = screen.getByTestId("column-todo");
      const todoTasks = JSON.parse(todoColumn.getAttribute("data-tasks") || "[]");

      // Whitespace-only query should be treated as empty, showing all tasks
      expect(todoTasks).toHaveLength(1);
    });
  });
});
