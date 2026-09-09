import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Column as ColumnType, Task } from "@fusion/core";
import { Board, resetBoardColumnsOnArrival } from "../Board";
import { restoreBoardScrollSnapshot } from "../../utils/boardScrollSnapshot";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, writeBoardWorkflowSelection } from "../../utils/boardWorkflowSelection";

const workflow = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

const workflowPayload = { defaultWorkflowId: workflow.id, workflows: [workflow], taskWorkflowIds: {} };
let workflowsHydrated = true;

vi.mock("../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: workflowsHydrated ? workflowPayload : null,
    workflowMode: true,
    workflowOptions: workflowsHydrated ? [workflow] : [],
    selectedWorkflow: workflowsHydrated ? workflow : null,
    selectedWorkflowId: workflowsHydrated ? workflow.id : null,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));

vi.mock("../TaskCard", () => ({ TaskCard: ({ task }: { task: Task }) => <article data-testid={`task-${task.id}`}>{task.id}</article> }));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => null }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => null }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("../../hooks/usePluginUiSlots", () => ({ usePluginUiSlots: () => ({ slots: [], getSlotsForId: () => [], loading: false, error: null }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));

function task(id: string, column: ColumnType): Task {
  return {
    id,
    title: id,
    description: "",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

function populatedTasks(): Task[] {
  return [
    task("FN-TODO", "todo" as ColumnType),
    ...Array.from({ length: 120 }, (_, index) => task(`FN-DONE-${index}`, "done" as ColumnType)),
  ];
}

function boardProps(overrides: Partial<React.ComponentProps<typeof Board>> = {}): React.ComponentProps<typeof Board> {
  return {
    tasks: [],
    maxConcurrent: 2,
    maxWorktrees: 2,
    showWorktreeGrouping: false,
    onMoveTask: vi.fn(async () => ({} as never)),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onNewTask: vi.fn(),
    autoMerge: true,
    onToggleAutoMerge: vi.fn(),
    planAutoApproveEnabled: false,
    onTogglePlanAutoApprove: vi.fn(),
    ...overrides,
  };
}

function bodies(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#board .column-body"));
}

function setColumnGeometry(body: HTMLElement, scrollHeight = 38_400) {
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 640 },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, writable: true, value: body.scrollTop },
  });
}

async function scrollToLastVirtualRow(body: HTMLElement) {
  body.scrollTop = body.scrollHeight - body.clientHeight;
  await act(async () => {
    fireEvent.scroll(body);
    await Promise.resolve();
  });
}

describe("Board column scroll arrival", () => {
  beforeEach(() => {
    workflowsHydrated = true;
    vi.stubGlobal("ResizeObserver", undefined);
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it.each([1_200, 768, 600])("starts every selected-workflow lane at the top on a %ipx viewport", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    render(<Board {...boardProps()} />);

    await waitFor(() => expect(bodies()).toHaveLength(2));
    expect(bodies().map((body) => body.scrollTop)).toEqual([0, 0]);
  });

  it("starts aggregate workflow lanes at the top without special-casing Done", async () => {
    writeBoardWorkflowSelection(undefined, ALL_WORKFLOWS_BOARD_VIEW_ID);
    render(<Board {...boardProps()} />);

    await waitFor(() => expect(bodies()).toHaveLength(2));
    expect(bodies().map((body) => body.scrollTop)).toEqual([0, 0]);
  });

  it("resets on keep-alive reactivation but not on an active data refresh", async () => {
    const tasks: Task[] = [];
    const { rerender } = render(<Board {...boardProps({ active: true, tasks })} />);
    await waitFor(() => expect(bodies()).toHaveLength(2));

    const [todo, done] = bodies();
    todo!.scrollTop = 71;
    done!.scrollTop = 404;
    fireEvent.scroll(todo!);
    fireEvent.scroll(done!);

    rerender(<Board {...boardProps({ active: true, tasks })} />);
    expect(bodies().map((body) => body.scrollTop)).toEqual([71, 404]);

    rerender(<Board {...boardProps({ active: false, tasks })} />);
    expect(bodies().map((body) => body.scrollTop)).toEqual([71, 404]);

    rerender(<Board {...boardProps({ active: true, tasks })} />);
    await waitFor(() => expect(bodies().map((body) => body.scrollTop)).toEqual([0, 0]));
  });

  it.each([1_200, 600])("reactivates the real virtualized Done lane at its first task on a %ipx viewport", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: width <= 768 && query.includes("max-width: 768px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const tasks = populatedTasks();
    const view = render(<Board {...boardProps({ active: true, tasks })} />);

    await waitFor(() => expect(document.querySelector("[data-column='done'] [data-virtual-task-row]")).not.toBeNull());
    const doneBody = document.querySelector<HTMLElement>("[data-column='done'] .column-body")!;
    const todoBody = document.querySelector<HTMLElement>("[data-column='todo'] .column-body")!;
    setColumnGeometry(doneBody);
    setColumnGeometry(todoBody, 1_000);
    const firstDoneTaskId = document.querySelector<HTMLElement>("[data-column='done'] [data-virtual-task-row]")!.dataset.virtualTaskRow!;

    await scrollToLastVirtualRow(doneBody);
    expect(document.querySelector(`[data-column='done'] [data-virtual-task-row='${firstDoneTaskId}']`)).toBeNull();
    todoBody.scrollTop = 53;
    fireEvent.scroll(todoBody);

    view.rerender(<Board {...boardProps({ active: false, tasks })} />);
    view.rerender(<Board {...boardProps({ active: true, tasks })} />);

    await waitFor(() => {
      expect(doneBody.scrollTop).toBe(0);
      expect(todoBody.scrollTop).toBe(0);
      expect(document.querySelector(`[data-column='done'] [data-virtual-task-row='${firstDoneTaskId}']`)).not.toBeNull();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(bodies().map((body) => body.scrollTop)).toEqual([0, 0]);
  });

  it("keeps a legacy replay at zero after delayed real Board and Column hydration", async () => {
    workflowsHydrated = false;
    const tasks = populatedTasks();
    const view = render(<Board {...boardProps({ active: true, tasks })} />);
    expect(document.querySelector("#board .column-body")).toBeNull();

    workflowsHydrated = true;
    view.rerender(<Board {...boardProps({ active: true, tasks })} />);
    await waitFor(() => expect(document.querySelector("[data-column='done'] [data-virtual-task-row]")).not.toBeNull());

    for (const body of bodies()) setColumnGeometry(body);
    const board = document.querySelector<HTMLElement>("#board")!;
    const firstDoneTaskId = document.querySelector<HTMLElement>("[data-column='done'] [data-virtual-task-row]")!.dataset.virtualTaskRow!;
    expect(restoreBoardScrollSnapshot({
      boardLeft: 241,
      boardTop: 0,
      columnTops: { todo: 53, done: 38_000 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    })).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(board.scrollLeft).toBe(241);
    expect(bodies().map((body) => body.scrollTop)).toEqual([0, 0]);
    expect(document.querySelector(`[data-column='done'] [data-virtual-task-row='${firstDoneTaskId}']`)).not.toBeNull();
  });

  it("reports absent and pending boards, then synchronizes every hydrated column", () => {
    expect(resetBoardColumnsOnArrival(null)).toBe("board-absent");
    const board = document.createElement("main");
    expect(resetBoardColumnsOnArrival(board)).toBe("columns-pending");

    board.innerHTML = `<section class="column"><div class="column-body"></div></section>`;
    const body = board.querySelector<HTMLElement>(".column-body")!;
    body.scrollTop = 380;
    const onScroll = vi.fn();
    body.addEventListener("scroll", onScroll);

    expect(resetBoardColumnsOnArrival(board)).toBe("ready");
    expect(body.scrollTop).toBe(0);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });
});
