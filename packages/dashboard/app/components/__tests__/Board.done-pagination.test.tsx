import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Task } from "@fusion/core";
import { Board } from "../Board";

const { fetchBoardWorkflows } = vi.hoisted(() => ({
  fetchBoardWorkflows: vi.fn().mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [{
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "todo", name: "Todo", flags: { hold: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    }],
    taskWorkflowIds: { "FN-001": "builtin:coding", "FN-002": "builtin:coding" },
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
  Column: ({ column, onLoadMoreServer, serverHasMore }: {
    column: string;
    onLoadMoreServer?: () => Promise<void>;
    serverHasMore?: boolean;
  }) => (
    <section data-testid={`search-column-${column}`} data-has-more={String(Boolean(serverHasMore))}>
      <button type="button" onClick={() => void onLoadMoreServer?.()}>intersect-{column}</button>
    </section>
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
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  } as Task;
}

function props(overrides: Partial<ComponentProps<typeof Board>> = {}): ComponentProps<typeof Board> {
  return {
    tasks: [task("FN-001", "todo"), task("FN-002", "done")],
    maxConcurrent: 1,
    maxWorktrees: 1,
    showWorktreeGrouping: false,
    onMoveTask: vi.fn(),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onNewTask: vi.fn(),
    autoMerge: true,
    onToggleAutoMerge: vi.fn(),
    planAutoApproveEnabled: true,
    onTogglePlanAutoApprove: vi.fn(),
    searchQuery: "FN",
    ...overrides,
  };
}

/*
FNXC:TaskSearchPagination 2026-09-07-18:20:
Board search uses one cursor across every workflow lane. Completion lanes must request that search cursor rather than the independent completion-history page, otherwise matching tasks beyond page one are unreachable.
*/
describe("Board search pagination wiring", () => {
  it("routes searched current and completion lanes to the shared search continuation", async () => {
    const onLoadMoreCurrentTasks = vi.fn().mockResolvedValue(undefined);
    const onLoadMoreCompletedTasks = vi.fn().mockResolvedValue(undefined);
    render(<Board {...props({
      currentTasksHasMore: true,
      completedHasMore: true,
      onLoadMoreCurrentTasks,
      onLoadMoreCompletedTasks,
    })} />);

    await waitFor(() => expect(screen.getByTestId("search-column-todo")).toHaveAttribute("data-has-more", "true"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "intersect-todo" }));
      fireEvent.click(screen.getByRole("button", { name: "intersect-done" }));
      await Promise.resolve();
    });

    expect(onLoadMoreCurrentTasks).toHaveBeenCalledTimes(2);
    expect(onLoadMoreCompletedTasks).not.toHaveBeenCalled();
  });
});
