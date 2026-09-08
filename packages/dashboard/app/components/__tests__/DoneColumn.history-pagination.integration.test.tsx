import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, Board } from "../Board";
import { useTasks } from "../../hooks/useTasks";
import { writeBoardWorkflowSelection } from "../../utils/boardWorkflowSelection";

const rows = Array.from({ length: 205 }, (_, index) => ({
  id: `FN-${1205 - index}`,
  title: `Done ${index}`,
  description: `Done ${index}`,
  column: "done",
  dependencies: [], steps: [], currentStep: 0, log: [],
  createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
  columnMovedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
})) as Task[];

const { fetchCompletedTasks, fetchBoardWorkflows, observers } = vi.hoisted(() => ({
  fetchCompletedTasks: vi.fn(),
  fetchBoardWorkflows: vi.fn(),
  observers: [] as Array<(entries: Array<{ isIntersecting: boolean }>) => void>,
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTaskPage: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false, nextCursor: null }),
    fetchCompletedTasks,
    fetchBoardWorkflows,
    fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  });
});
vi.mock("../../sse-bus", () => ({ subscribeSse: () => () => undefined }));
vi.mock("../TaskCard", () => ({ TaskCard: ({ task }: { task: Task }) => <article>{task.id}</article> }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ useBatchBadgeFetch: () => ({ fetchBatch: vi.fn(), isLoading: false, lastFetchTime: null, getBatchData: vi.fn() }) }));

function Harness({ projectId }: { projectId: string }) {
  const state = useTasks({ projectId, sseEnabled: false });
  return <Board tasks={state.tasks} projectId={projectId} maxConcurrent={1} maxWorktrees={1} showWorktreeGrouping={false}
    onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={vi.fn()} onNewTask={vi.fn()} autoMerge onToggleAutoMerge={vi.fn()}
    planAutoApproveEnabled onTogglePlanAutoApprove={vi.fn()} onLoadMoreCompletedTasks={state.loadMoreCompletedTasks}
    completedCounts={state.completedCounts} completedHasMore={state.completedHasMore} completedLoadingMore={state.completedLoadingMore}
    completedSortMode={state.completedSortMode} onCompletedSortModeChange={state.changeCompletedSortMode} />;
}

async function walkHistory() {
  const seen = new Set<string>();
  let maxMounted = 0;
  for (let page = 0; page < 5; page += 1) {
    await waitFor(() => expect(screen.getByLabelText("205 tasks")).toBeInTheDocument());
    const body = document.querySelector<HTMLElement>(".column[data-column='done'] .column-body")!;
    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 100_000 },
    });
    for (const position of [0, 8_000, 24_000, 48_000, 72_000]) {
      body.scrollTop = position;
      fireEvent.scroll(body);
      await act(async () => { await Promise.resolve(); });
      const mounted = [...document.querySelectorAll<HTMLElement>("[data-virtual-task-row]")];
      maxMounted = Math.max(maxMounted, mounted.length);
      mounted.forEach((node) => seen.add(node.dataset.virtualTaskRow!));
    }
    const observer = observers.at(-1);
    if (observer) {
      await act(async () => { observer([{ isIntersecting: true }]); await Promise.resolve(); });
    } else {
      body.scrollTop = body.scrollHeight - body.clientHeight;
      fireEvent.scroll(body);
      await act(async () => { await Promise.resolve(); });
    }
  }
  const body = document.querySelector<HTMLElement>(".column[data-column='done'] .column-body")!;
  for (let position = 0; position < 70_000; position += 320) {
    body.scrollTop = position;
    fireEvent.scroll(body);
    await act(async () => { await Promise.resolve(); });
    document.querySelectorAll<HTMLElement>("[data-virtual-task-row]").forEach((node) => seen.add(node.dataset.virtualTaskRow!));
  }
  expect(fetchCompletedTasks).toHaveBeenCalledTimes(5);
  expect(screen.queryByTestId("column-auto-pagination-sentinel")).toBeNull();
  expect(maxMounted).toBeLessThanOrEqual(60);
  expect(seen.size).toBe(205);
}

describe("Done column history pagination integration", () => {
  beforeEach(() => {
    localStorage.clear();
    observers.length = 0;
    class Observer {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    fetchCompletedTasks.mockReset().mockImplementation(async (_projectId: string, _limit: number, cursor?: string) => {
      const offset = cursor ? Number(cursor.split("-")[1]) : 0;
      const tasks = rows.slice(offset, offset + 50);
      const nextOffset = offset + tasks.length;
      return { tasks, total: 205, hasMore: nextOffset < 205, nextCursor: nextOffset < 205 ? `page-${nextOffset}` : null,
        counts: { byColumn: { done: 205 }, byWorkflow: { "builtin:coding": { done: 205 } } } };
    });
    fetchBoardWorkflows.mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "builtin:coding", workflows: [{ id: "builtin:coding", name: "Coding", columns: [{ id: "todo", name: "Todo", flags: { hold: true } }, { id: "done", name: "Done", flags: { complete: true } }] }], taskWorkflowIds: Object.fromEntries(rows.map((task) => [task.id, "builtin:coding"])) });
  });

  it.each([
    { width: 1200, aggregate: false, observer: true }, { width: 600, aggregate: false, observer: true },
    { width: 1200, aggregate: true, observer: true }, { width: 600, aggregate: true, observer: true },
    { width: 1200, aggregate: false, observer: false }, { width: 600, aggregate: false, observer: false },
    { width: 1200, aggregate: true, observer: false }, { width: 600, aggregate: true, observer: false },
  ])("reaches all Done rows at $width px (aggregate=$aggregate, observer=$observer)", async ({ width, aggregate, observer }) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    if (!observer) vi.stubGlobal("IntersectionObserver", undefined);
    if (aggregate) writeBoardWorkflowSelection("project-a", ALL_WORKFLOWS_BOARD_VIEW_ID);
    render(<Harness projectId="project-a" />);
    await walkHistory();
  });
});
