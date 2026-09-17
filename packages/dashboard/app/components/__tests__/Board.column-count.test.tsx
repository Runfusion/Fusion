import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Task } from "@fusion/core";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, Board, resolveColumnBadgeTotal } from "../Board";
import { writeBoardWorkflowSelection } from "../../utils/boardWorkflowSelection";

/*
FNXC:BoardColumnCount 2026-09-16-21:24:
FN-475 regression. Every column header badge must show the task count of ITS OWN column. Before this
fix Board handed `currentTasksTotal` — the board-wide pagination total of the whole current collection —
to every non-complete lane and to every lane while searching, so Todo, In Progress, and In Review all
displayed the same number. The complete lane outside search must keep its exact per-column server total.
*/

const { fetchBoardWorkflows } = vi.hoisted(() => ({
  fetchBoardWorkflows: vi.fn().mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [{
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "ideas", name: "Ideas", flags: { intake: true } },
        { id: "todo", name: "Todo", flags: { hold: true } },
        { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
        { id: "in-review", name: "In Review", flags: { mergeBlocker: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    }],
    taskWorkflowIds: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`FN-${String(index + 1).padStart(3, "0")}`, "builtin:coding"]),
    ),
  }),
}));

vi.mock("../../api", () => ({
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflows(...args),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  useBatchBadgeFetch: () => ({
    fetchBatch: vi.fn(),
    isLoading: false,
    lastFetchTime: null,
    getBatchData: vi.fn(),
  }),
}));

vi.mock("../../sse-bus", () => ({ subscribeSse: () => () => undefined }));

vi.mock("../Column", () => ({
  Column: ({ column, tasks, totalTaskCount }: { column: string; tasks: Task[]; totalTaskCount?: number }) => (
    <section
      data-testid={`count-column-${column}`}
      data-column={column}
      data-total-task-count={String(totalTaskCount ?? "")}
      data-loaded-count={String(tasks.length)}
    />
  ),
}));

function task(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: "pending",
    paused: false,
    log: [],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  } as Task;
}

/** 3 todo + 1 in-progress + 2 done — the operator's reported board shape. */
function reproTasks(): Task[] {
  return [
    task("FN-001", "todo"),
    task("FN-002", "todo"),
    task("FN-003", "todo"),
    task("FN-004", "in-progress"),
    task("FN-005", "done"),
    task("FN-006", "done"),
  ];
}

function props(overrides: Partial<ComponentProps<typeof Board>> = {}): ComponentProps<typeof Board> {
  return {
    tasks: reproTasks(),
    maxConcurrent: 1,
    maxWorktrees: 1,
    showWorktreeGrouping: false,
    onMoveTask: vi.fn(),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onNewTask: vi.fn(),
    autoMerge: true,
    planAutoApproveEnabled: true,
    onTogglePlanAutoApprove: vi.fn(),
    searchQuery: "",
    currentTasksTotal: 99,
    ...overrides,
  };
}

async function renderedCounts(): Promise<Record<string, string>> {
  await screen.findByTestId("count-column-todo");
  const entries: Record<string, string> = {};
  for (const node of document.querySelectorAll<HTMLElement>("[data-testid^='count-column-']")) {
    entries[node.getAttribute("data-column") ?? ""] = node.getAttribute("data-total-task-count") ?? "";
  }
  return entries;
}

describe("Board column header counts", () => {
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalInnerWidth });
  });

  it("gives each selected-workflow column its own count, never the board-wide total", async () => {
    render(<Board {...props({
      projectId: "fn-475-selected",
      completedCounts: { byColumn: { done: 2 }, byWorkflow: { "builtin:coding": { done: 2 } } },
    })} />);

    await waitFor(async () => {
      expect(await renderedCounts()).toMatchObject({ ideas: "0", todo: "3", "in-progress": "1", "in-review": "0", done: "2" });
    });
    expect(Object.values(await renderedCounts())).not.toContain("99");
  });

  it("gives each aggregate-view column its own count, never the board-wide total", async () => {
    writeBoardWorkflowSelection("fn-475-aggregate", ALL_WORKFLOWS_BOARD_VIEW_ID);
    render(<Board {...props({
      projectId: "fn-475-aggregate",
      completedCounts: { byColumn: { done: 2 }, byWorkflow: { "builtin:coding": { done: 2 } } },
    })} />);

    await waitFor(async () => {
      expect(await renderedCounts()).toMatchObject({ ideas: "0", todo: "3", "in-progress": "1", "in-review": "0", done: "2" });
    });
    expect(Object.values(await renderedCounts())).not.toContain("99");
  });

  it("keeps the exact server total for a server-paginated complete lane in the selected workflow view", async () => {
    render(<Board {...props({
      projectId: "fn-475-paged-selected",
      tasks: [task("FN-001", "todo"), task("FN-005", "done")],
      completedCounts: { byColumn: { done: 8 }, byWorkflow: { "builtin:coding": { done: 8 } } },
      completedHasMore: true,
    })} />);

    await waitFor(async () => {
      const counts = await renderedCounts();
      expect(counts.done).toBe("8");
      expect(counts.todo).toBe("1");
    });
  });

  it("keeps the exact server total for a server-paginated complete lane in the aggregate view", async () => {
    writeBoardWorkflowSelection("fn-475-paged-aggregate", ALL_WORKFLOWS_BOARD_VIEW_ID);
    render(<Board {...props({
      projectId: "fn-475-paged-aggregate",
      tasks: [task("FN-001", "todo"), task("FN-005", "done")],
      completedCounts: { byColumn: { done: 8 }, byWorkflow: { "builtin:coding": { done: 8 } } },
      completedHasMore: true,
    })} />);

    await waitFor(async () => expect((await renderedCounts()).done).toBe("8"));
  });

  it("falls back to the loaded complete cards when no exact server count is known", async () => {
    render(<Board {...props({ projectId: "fn-475-no-counts" })} />);

    await waitFor(async () => {
      const counts = await renderedCounts();
      expect(counts.done).toBe("2");
      expect(counts.todo).toBe("3");
    });
  });

  it("shows every lane its own filtered card count while search is active", async () => {
    render(<Board {...props({
      projectId: "fn-475-search",
      searchQuery: "FN",
      completedCounts: { byColumn: { done: 8 }, byWorkflow: { "builtin:coding": { done: 8 } } },
    })} />);

    await waitFor(async () => {
      expect(await renderedCounts()).toMatchObject({ todo: "3", "in-progress": "1", "in-review": "0", done: "2" });
    });
    const values = Object.values(await renderedCounts());
    expect(values).not.toContain("99");
    expect(values).not.toContain("8");
  });

  it("shows zero for an empty lane instead of the board-wide total", async () => {
    render(<Board {...props({ projectId: "fn-475-empty", tasks: [task("FN-004", "in-progress")] })} />);

    await waitFor(async () => {
      expect(await renderedCounts()).toMatchObject({ ideas: "0", todo: "0", "in-review": "0", done: "0", "in-progress": "1" });
    });
  });

  it("resolves the same per-column counts at the mobile breakpoint", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 375 });
    render(<Board {...props({
      projectId: "fn-475-mobile",
      completedCounts: { byColumn: { done: 2 }, byWorkflow: { "builtin:coding": { done: 2 } } },
    })} />);

    await waitFor(async () => {
      expect(await renderedCounts()).toMatchObject({ todo: "3", "in-progress": "1", "in-review": "0", done: "2" });
    });
    expect(Object.values(await renderedCounts())).not.toContain("99");
  });
});

describe("resolveColumnBadgeTotal", () => {
  it("returns the loaded count for a non-complete lane outside search", () => {
    expect(resolveColumnBadgeTotal({ isSearchActive: false, isCompleteColumn: false, completeLaneTotal: 8, loadedCount: 3 })).toBe(3);
  });

  it("returns the exact server total for a complete lane outside search", () => {
    expect(resolveColumnBadgeTotal({ isSearchActive: false, isCompleteColumn: true, completeLaneTotal: 8, loadedCount: 1 })).toBe(8);
  });

  it("falls back to the loaded count when a complete lane has no exact server total", () => {
    expect(resolveColumnBadgeTotal({ isSearchActive: false, isCompleteColumn: true, completeLaneTotal: undefined, loadedCount: 4 })).toBe(4);
  });

  it("returns the loaded count for a non-complete lane during search", () => {
    expect(resolveColumnBadgeTotal({ isSearchActive: true, isCompleteColumn: false, completeLaneTotal: 8, loadedCount: 2 })).toBe(2);
  });

  it("returns the loaded count for a complete lane during search", () => {
    expect(resolveColumnBadgeTotal({ isSearchActive: true, isCompleteColumn: true, completeLaneTotal: 8, loadedCount: 2 })).toBe(2);
  });
});
