import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Column as ColumnType, Task } from "@fusion/core";
import { Board } from "../Board";
import { restoreBoardScrollSnapshot } from "../../utils/boardScrollSnapshot";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, writeBoardWorkflowSelection } from "../../utils/boardWorkflowSelection";

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 — l'invariant est rejou\u00e9 \u00e0 travers le VRAI `Board`, ses vraies `Column` et le vrai hook. Seules
les donn\u00e9es et les descendants co\u00fbteux sans rapport sont mock\u00e9s.

jsdom marque tout \u00e9v\u00e9nement dispatch\u00e9 `isTrusted: false`, ce que la production refuse \u00e0 juste titre. On
injecte donc UNIQUEMENT le pr\u00e9dicat `isUserInteraction` stable du harnais autour de l'impl\u00e9mentation
r\u00e9elle : la logique de magn\u00e9tisme test\u00e9e reste celle de production.
*/
vi.mock("../../hooks/useColumnScrollSnap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useColumnScrollSnap")>();
  return {
    ...actual,
    useColumnScrollSnap: (
      scroller: HTMLElement | null,
      options: Parameters<typeof actual.useColumnScrollSnap>[1] = {},
    ) => actual.useColumnScrollSnap(scroller, { ...options, isUserInteraction: () => true }),
  };
});

const workflow = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In Progress", flags: {} },
    { id: "in-review", name: "In Review", flags: { review: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

const workflowPayload = { defaultWorkflowId: workflow.id, workflows: [workflow], taskWorkflowIds: {} };
let aggregateSelected = false;

vi.mock("../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: workflowPayload,
    workflowMode: true,
    workflowOptions: [workflow],
    selectedWorkflow: workflow,
    selectedWorkflowId: aggregateSelected ? ALL_WORKFLOWS_BOARD_VIEW_ID : workflow.id,
    isAllWorkflowsSelected: aggregateSelected,
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
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirmWithCheckbox: vi.fn(), confirm: vi.fn() }) }));

const VIEWPORT = 390;
const COLUMN = 300;
const GAP = 16;
const PADDING = 16;

function anchorFor(index: number, columnCount: number): number {
  const contentWidth = PADDING * 2 + columnCount * COLUMN + Math.max(0, columnCount - 1) * GAP;
  const ideal = Math.round(PADDING + index * (COLUMN + GAP) + COLUMN / 2 - VIEWPORT / 2);
  return Math.min(Math.max(ideal, 0), Math.max(0, contentWidth - VIEWPORT));
}

interface ScreenProfile {
  innerWidth: number;
  innerHeight: number;
  screen: { width: number; height: number };
  maxTouchPoints: number;
  fine: boolean;
}

const PHONE_PORTRAIT: ScreenProfile = { innerWidth: 390, innerHeight: 844, screen: { width: 390, height: 844 }, maxTouchPoints: 5, fine: false };
const PHONE_LANDSCAPE: ScreenProfile = { innerWidth: 844, innerHeight: 390, screen: { width: 390, height: 844 }, maxTouchPoints: 5, fine: false };
const TABLET_PORTRAIT: ScreenProfile = { innerWidth: 768, innerHeight: 1024, screen: { width: 768, height: 1024 }, maxTouchPoints: 5, fine: false };
const TABLET_LANDSCAPE: ScreenProfile = { innerWidth: 1024, innerHeight: 768, screen: { width: 768, height: 1024 }, maxTouchPoints: 5, fine: false };
const DESKTOP: ScreenProfile = { innerWidth: 1280, innerHeight: 900, screen: { width: 1920, height: 1080 }, maxTouchPoints: 0, fine: true };
const NARROW_DESKTOP: ScreenProfile = { innerWidth: 600, innerHeight: 800, screen: { width: 1920, height: 1080 }, maxTouchPoints: 0, fine: true };

function applyProfile(profile: ScreenProfile): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: profile.innerWidth });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: profile.innerHeight });
  Object.defineProperty(window, "screen", { configurable: true, value: profile.screen });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: profile.maxTouchPoints });
  vi.stubGlobal("visualViewport", {
    width: profile.innerWidth,
    height: profile.innerHeight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches:
      (query.includes("max-width: 768px") && profile.innerWidth <= 768)
      || (query.includes("max-width: 600px") && profile.innerWidth <= 600)
      || (query.includes("max-width: 767.98px") && profile.innerWidth < 768)
      || (query.includes("max-height: 480px") && profile.innerHeight <= 480)
      || (query.includes("hover: hover") && profile.fine),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as MediaQueryList);
}

function task(id: string, column: ColumnType): Task {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: id,
    description: "",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    columnMovedAt: timestamp,
  } as Task;
}

function boardProps(overrides: Partial<React.ComponentProps<typeof Board>> = {}): React.ComponentProps<typeof Board> {
  return {
    tasks: [task("FN-1", "todo" as ColumnType), task("FN-2", "in-progress" as ColumnType)],
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

/** Give the rendered board real phone geometry: it has none in jsdom. */
function installBoardGeometry(initialScrollLeft = 0): HTMLElement {
  const board = document.getElementById("board") as HTMLElement;
  const columns = Array.from(board.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("column"),
  );
  const contentWidth = PADDING * 2 + columns.length * COLUMN + Math.max(0, columns.length - 1) * GAP;
  const maxScrollLeft = Math.max(0, contentWidth - VIEWPORT);
  let scrollLeft = initialScrollLeft;
  Object.defineProperty(board, "clientWidth", { configurable: true, value: VIEWPORT });
  Object.defineProperty(board, "scrollWidth", { configurable: true, value: contentWidth });
  Object.defineProperty(board, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = Math.min(Math.max(value, 0), maxScrollLeft);
    },
  });
  board.getBoundingClientRect = () => new DOMRect(0, 0, VIEWPORT, 700);
  board.setPointerCapture = vi.fn();
  board.releasePointerCapture = vi.fn();
  board.hasPointerCapture = vi.fn(() => false);
  columns.forEach((column, index) => {
    const left = PADDING + index * (COLUMN + GAP);
    column.getBoundingClientRect = () => new DOMRect(left - board.scrollLeft, 0, COLUMN, 700);
  });
  return board;
}

function pointer(board: HTMLElement, type: string, clientX: number, clientY = 400): void {
  board.dispatchEvent(new PointerEvent(type, {
    clientX,
    clientY,
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
  }));
}

/** One finger swipe with native pan ticks, then the owned transition run to completion. */
function swipe(board: HTMLElement, options: { travel: number; stepMs?: number; settle?: boolean }): void {
  const { travel, stepMs = 50, settle = true } = options;
  act(() => {
    board.dispatchEvent(new Event("touchstart"));
    pointer(board, "pointerdown", 330);
    vi.advanceTimersByTime(stepMs);
    pointer(board, "pointermove", 330 - travel);
    board.scrollLeft = board.scrollLeft + travel;
    board.dispatchEvent(new Event("scroll"));
    pointer(board, "pointerup", 330 - travel);
  });
  if (settle) {
    act(() => {
      vi.advanceTimersByTime(600);
    });
  }
}

/*
 * Fake timers are already installed (the owned transition is timer/rAF driven), so flush React's
 * effects explicitly instead of `waitFor`, which would wait on real time and never resolve.
 */
async function renderBoard(props: Partial<React.ComponentProps<typeof Board>> = {}) {
  const result = render(<Board {...boardProps(props)} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.getElementById("board")).toBeTruthy();
  return result;
}

describe("Board mobile column snapping (real Board, real hook)", () => {
  beforeEach(() => {
    aggregateSelected = false;
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", undefined);
    window.localStorage.clear();
    window.sessionStorage.clear();
    applyProfile(PHONE_PORTRAIT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.body.innerHTML = "";
  });

  it.each([
    { label: "selected workflow view", aggregate: false },
    { label: "aggregate workflow view", aggregate: true },
  ])("pages one column per swipe in the $label", async ({ aggregate }) => {
    aggregateSelected = aggregate;
    if (aggregate) writeBoardWorkflowSelection(undefined, ALL_WORKFLOWS_BOARD_VIEW_ID);
    await renderBoard();
    const board = installBoardGeometry(0);
    const columnCount = board.querySelectorAll(":scope > .column").length;
    expect(columnCount).toBeGreaterThanOrEqual(2);

    swipe(board, { travel: 40 });
    expect(board.scrollLeft).toBe(anchorFor(1, columnCount));

    swipe(board, { travel: 40 });
    expect(board.scrollLeft).toBe(anchorFor(2, columnCount));
  });

  it("does not page further for a fast flick than for a slow swipe", async () => {
    await renderBoard();
    const board = installBoardGeometry(0);
    const columnCount = board.querySelectorAll(":scope > .column").length;

    swipe(board, { travel: 260, stepMs: 8 });
    expect(board.scrollLeft).toBe(anchorFor(1, columnCount));
  });

  it("pages backwards one column and stops at the first column", async () => {
    await renderBoard();
    const board = installBoardGeometry(anchorFor(1, 4));
    const columnCount = board.querySelectorAll(":scope > .column").length;

    swipe(board, { travel: -40 });
    expect(board.scrollLeft).toBe(anchorFor(0, columnCount));

    swipe(board, { travel: -40 });
    expect(board.scrollLeft).toBe(anchorFor(0, columnCount));
  });

  it("keeps a vertical lane scroll from paging the board", async () => {
    await renderBoard();
    const board = installBoardGeometry(anchorFor(1, 4));
    const body = board.querySelector(".column-body") as HTMLElement;
    const before = board.scrollLeft;

    act(() => {
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
      body.dispatchEvent(new Event("scrollend", { bubbles: true }));
      vi.advanceTimersByTime(600);
    });

    expect(board.scrollLeft).toBe(before);
  });

  it("lets a real snapshot restore win over a pending correction", async () => {
    await renderBoard();
    const board = installBoardGeometry(0);

    swipe(board, { travel: 40, settle: false });
    act(() => {
      vi.advanceTimersByTime(96);
    });
    expect(board.scrollLeft).toBeGreaterThan(40);

    act(() => {
      restoreBoardScrollSnapshot({
        boardLeft: 512,
        boardTop: 0,
        columnTops: { todo: 0 },
        projectContentLeft: 0,
        projectContentTop: 0,
        documentLeft: 0,
        documentTop: 0,
      });
      vi.advanceTimersByTime(900);
    });

    expect(board.scrollLeft).toBe(512);
    expect(board.style.overflowX).toBe("");
  });

  it("does not snap while the view is kept alive but inactive, and resumes when active", async () => {
    const { rerender } = await renderBoard({ active: false });
    let board = installBoardGeometry(0);

    swipe(board, { travel: 40 });
    expect(board.scrollLeft).toBe(40);

    await act(async () => {
      rerender(<Board {...boardProps({ active: true })} />);
    });
    board = installBoardGeometry(0);
    swipe(board, { travel: 40 });
    const columnCount = board.querySelectorAll(":scope > .column").length;
    expect(board.scrollLeft).toBe(anchorFor(1, columnCount));
  });

  it("does not snap on mount, refresh, or a resting layout change", async () => {
    const { rerender } = await renderBoard();
    const board = installBoardGeometry(120);

    await act(async () => {
      rerender(<Board {...boardProps({ tasks: [task("FN-9", "done" as ColumnType)] })} />);
      vi.advanceTimersByTime(900);
    });

    expect(board.scrollLeft).toBe(120);
  });
});

describe("Board horizontal scrolling stays free off phone viewports", () => {
  beforeEach(() => {
    aggregateSelected = false;
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", undefined);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.body.innerHTML = "";
  });

  it.each([
    { label: "desktop", profile: DESKTOP },
    { label: "portrait tablet", profile: TABLET_PORTRAIT },
    { label: "landscape tablet", profile: TABLET_LANDSCAPE },
  ])("leaves an intermediate position untouched on $label", async ({ profile }) => {
    applyProfile(profile);
    await renderBoard();
    const board = installBoardGeometry(0);

    swipe(board, { travel: 40 });

    // No magnetism: the operator keeps exactly the position they scrolled to.
    expect(board.scrollLeft).toBe(40);
  });

  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  Un navigateur de bureau SANS tactile à <=768 px reste classifié mobile par `isMobileViewport`, donc le
  propriétaire est attaché — mais il ignore délibérément la souris (FN-9219/FN-115) : ni capture, ni
  suspension du snap, ni correction. Une largeur seule ne prouve pas la capacité d'entrée.
  */
  it("never snaps or captures mouse input on a narrow non-touch desktop", async () => {
    applyProfile(NARROW_DESKTOP);
    await renderBoard();
    const board = installBoardGeometry(0);

    act(() => {
      board.dispatchEvent(new PointerEvent("pointerdown", { clientX: 330, clientY: 400, pointerType: "mouse", pointerId: 3, isPrimary: true, bubbles: true }));
      board.dispatchEvent(new PointerEvent("pointermove", { clientX: 290, clientY: 400, pointerType: "mouse", pointerId: 3, isPrimary: true, bubbles: true }));
      board.scrollLeft = 40;
      board.dispatchEvent(new Event("scroll"));
      board.dispatchEvent(new PointerEvent("pointerup", { clientX: 290, clientY: 400, pointerType: "mouse", pointerId: 3, isPrimary: true, bubbles: true }));
      vi.advanceTimersByTime(900);
    });

    // The position the mouse pan produced is kept as-is: no magnetic correction, no snap suspension.
    // (Pointer capture here belongs to the separate mouse-pan owner, which is unchanged by FN-500.)
    expect(board.scrollLeft).toBe(40);
    expect(board.style.scrollSnapType).toBe("");
    expect(board.style.overflowX).toBe("");
  });

  it("still pages a short landscape phone", async () => {
    applyProfile(PHONE_LANDSCAPE);
    await renderBoard();
    const board = installBoardGeometry(0);
    const columnCount = board.querySelectorAll(":scope > .column").length;

    swipe(board, { travel: 40 });

    expect(board.scrollLeft).toBe(anchorFor(1, columnCount));
  });
});
