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

const { fetchCompletedTasks, fetchBoardWorkflows, pauseTask, observers } = vi.hoisted(() => ({
  fetchCompletedTasks: vi.fn(),
  fetchBoardWorkflows: vi.fn(),
  pauseTask: vi.fn(),
  observers: [] as Array<(entries: Array<{ isIntersecting: boolean }>) => void>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

type CompletedPage = {
  tasks: Task[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  counts: { byColumn: Record<string, number>; byWorkflow: Record<string, Record<string, number>> };
};

let staleContinuation: ReturnType<typeof deferred<CompletedPage>>;

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTaskPage: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false, nextCursor: null }),
    fetchCompletedTasks,
    fetchBoardWorkflows,
    pauseTask,
    fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  });
});
vi.mock("../../sse-bus", () => ({ subscribeSse: () => () => undefined }));
vi.mock("../TaskCard", () => ({ TaskCard: ({ task }: { task: Task }) => <article>{task.id}</article> }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ useBatchBadgeFetch: () => ({ fetchBatch: vi.fn(), isLoading: false, lastFetchTime: null, getBatchData: vi.fn() }) }));

function Harness({ projectId }: { projectId: string }) {
  const state = useTasks({ projectId, sseEnabled: false });
  return <>
    <button type="button" onClick={() => void state.pauseTask("FN-CURRENT")}>invalidate pagination</button>
    <button type="button" onClick={() => void state.loadMoreCompletedTasks()}>resume pagination</button>
    <Board tasks={state.tasks} projectId={projectId} maxConcurrent={1} maxWorktrees={1} showWorktreeGrouping={false}
      onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={vi.fn()} onNewTask={vi.fn()} autoMerge onToggleAutoMerge={vi.fn()}
      planAutoApproveEnabled onTogglePlanAutoApprove={vi.fn()} onLoadMoreCompletedTasks={state.loadMoreCompletedTasks}
      completedCounts={state.completedCounts} completedHasMore={state.completedHasMore} completedLoadingMore={state.completedLoadingMore}
      completedPaginationError={state.completedPaginationError} completedProgressKey={state.completedProgressKey}
      onRetryCompletedTasks={state.retryCompletedTasksPagination}
      completedSortMode={state.completedSortMode} onCompletedSortModeChange={state.changeCompletedSortMode} />
  </>;
}

function installMeasuredScrollGeometry(body: HTMLElement) {
  const viewportHeight = 640;
  let scrollPosition = 0;
  let pinnedToEnd = false;
  const physicalHeight = () => {
    const spacers = [...body.querySelectorAll<HTMLElement>(".column-virtual-spacer")]
      .reduce((sum, spacer) => sum + (Number.parseFloat(spacer.style.height) || 0), 0);
    const rowsHeight = [...body.querySelectorAll<HTMLElement>("[data-virtual-task-row]")]
      .reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    return Math.max(viewportHeight, spacers + rowsHeight);
  };
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: viewportHeight },
    scrollHeight: { configurable: true, get: physicalHeight },
    scrollTop: {
      configurable: true,
      get: () => pinnedToEnd ? Math.max(0, physicalHeight() - viewportHeight) : scrollPosition,
      set: (value: number) => {
        scrollPosition = Math.max(0, value);
        pinnedToEnd = value >= physicalHeight() - viewportHeight - 1;
      },
    },
  });
  return {
    pinToEnd() { body.scrollTop = body.scrollHeight - body.clientHeight; },
    setPosition(position: number) { pinnedToEnd = false; scrollPosition = position; },
  };
}

async function walkHistory() {
  const seen = new Set<string>();
  let maxMounted = 0;
  await waitFor(() => expect(screen.getByLabelText("205 tasks")).toBeInTheDocument());
  const body = document.querySelector<HTMLElement>(".column[data-column='done'] .column-body")!;
  const geometry = installMeasuredScrollGeometry(body);
  geometry.pinToEnd();
  if (observers.at(-1)) {
    await act(async () => { observers.at(-1)?.([{ isIntersecting: true }]); await Promise.resolve(); });
  } else {
    fireEvent.scroll(body);
  }

  await waitFor(() => expect(fetchCompletedTasks).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("column-auto-pagination-sentinel")).toHaveTextContent("Loading");
  fireEvent.click(screen.getByRole("button", { name: "invalidate pagination" }));
  await waitFor(() => expect(screen.getByTestId("column-auto-pagination-sentinel")).not.toHaveTextContent("Loading"));
  staleContinuation.resolve({
    tasks: [{ ...rows[50]!, id: "FN-STALE" }], total: 205, hasMore: false, nextCursor: null,
    counts: { byColumn: { done: 205 }, byWorkflow: { "builtin:coding": { done: 205 } } },
  });
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByText("FN-STALE")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "resume pagination" }));
  await waitFor(() => expect(fetchCompletedTasks).toHaveBeenCalledTimes(7));
  expect(screen.queryByTestId("column-auto-pagination-sentinel")).toBeNull();

  const collectMounted = () => {
    const mounted = [...document.querySelectorAll<HTMLElement>("[data-virtual-task-row]")];
    maxMounted = Math.max(maxMounted, mounted.length);
    mounted.forEach((node) => seen.add(node.dataset.virtualTaskRow!));
  };
  const finalScrollHeight = body.scrollHeight;
  for (let position = 0; position <= finalScrollHeight; position += 240) {
    geometry.setPosition(Math.min(position, Math.max(0, body.scrollHeight - body.clientHeight)));
    fireEvent.scroll(body);
    await act(async () => { await Promise.resolve(); });
    collectMounted();
  }
  geometry.pinToEnd();
  fireEvent.scroll(body);
  await act(async () => { await Promise.resolve(); });
  collectMounted();

  expect(fetchCompletedTasks).toHaveBeenCalledTimes(7);
  expect(maxMounted).toBeLessThanOrEqual(40);
  expect(seen.size).toBe(205);
  expect(seen.has("FN-1001")).toBe(true);
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
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measuredRect() {
      const rowId = this.dataset.virtualTaskRow;
      const numericId = rowId ? Number.parseInt(rowId.replace("FN-", ""), 10) : 0;
      const height = rowId ? 88 + (numericId % 5) * 12 : 0;
      return { x: 0, y: 0, width: 320, height, top: 0, right: 320, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
    });
    class MeasuredResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, contentRect: target.getBoundingClientRect(), borderBoxSize: [] }] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MeasuredResizeObserver);
    staleContinuation = deferred<CompletedPage>();
    pauseTask.mockReset().mockResolvedValue({ ...rows[0]!, id: "FN-CURRENT", column: "todo", paused: true });
    let cursor50Requests = 0;
    fetchCompletedTasks.mockReset().mockImplementation(async (_projectId: string, _limit: number, cursor?: string) => {
      const counts = { byColumn: { done: 205 }, byWorkflow: { "builtin:coding": { done: 205 } } };
      if (!cursor) return { tasks: rows.slice(0, 50), total: 205, hasMore: true, nextCursor: "page-50", counts };
      if (cursor === "page-50" && cursor50Requests++ === 0) return staleContinuation.promise;
      if (cursor === "page-50") return { tasks: rows.slice(50, 100), total: 205, hasMore: true, nextCursor: "page-100", counts };
      if (cursor === "page-100") return { tasks: [rows[99]!], total: 205, hasMore: true, nextCursor: "page-after-duplicate", counts };
      if (cursor === "page-after-duplicate") return { tasks: rows.slice(100, 150), total: 205, hasMore: true, nextCursor: "page-150", counts };
      if (cursor === "page-150") return { tasks: rows.slice(150, 200), total: 205, hasMore: true, nextCursor: "page-200", counts };
      return { tasks: rows.slice(200), total: 205, hasMore: false, nextCursor: null, counts };
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
