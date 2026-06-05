import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Board } from "../Board";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useBlockerFanout", () => ({
  useBlockerFanout: () => new Map(),
}));

vi.mock("../Column", () => ({
  Column: React.memo(({ column, tasks }: { column: string; tasks?: unknown[] }) => (
    <div data-task-count={tasks?.length ?? 0} data-testid={`column-${column}`} />
  )),
}));

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

function mockViewport(width: number) {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)" ? width <= 768 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function extractMediaBlocks(content: string, queryPattern: RegExp): string {
  const blocks: string[] = [];
  const regex = new RegExp(`@media[^{}]*${queryPattern.source}[^{}]*\\{`, "g");
  let match;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount++;
      if (content[endIdx] === "}") braceCount--;
      endIdx++;
    }
    if (braceCount === 0) blocks.push(content.slice(startIdx, endIdx - 1));
  }

  return blocks.join("\n");
}

function extractRule(content: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

const boardProps = {
  tasks: [],
  maxConcurrent: 2,
  onMoveTask: vi.fn(async () => ({} as any)),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
  onQuickCreate: vi.fn(async () => ({} as any)),
  onNewTask: vi.fn(),
  autoMerge: true,
  onToggleAutoMerge: vi.fn(),
  globalPaused: false,
};

describe("Board mobile initial render stabilization (FN-4574)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("normalizes scrollLeft to 0 on initial mobile render and keeps snap style in CSS, not inline", () => {
    const viewportSpy = mockViewport(375);
    const raf = vi.fn<(cb: FrameRequestCallback) => number>((cb) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(<Board {...boardProps} />);

    const board = document.querySelector("main.board") as HTMLElement;
    expect(board).not.toBeNull();
    board.scrollLeft = 500;

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(board.scrollLeft).toBe(0);
    expect(raf).toHaveBeenCalled();
    expect(board.style.scrollSnapType).toBe("");

    viewportSpy.mockRestore();
  });

  it("re-anchors on pageshow persisted restore for mobile", () => {
    const viewportSpy = mockViewport(375);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(<Board {...boardProps} />);

    const board = document.querySelector("main.board") as HTMLElement;
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(board.scrollLeft).toBe(0);

    board.scrollLeft = 500;
    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { configurable: true, value: true });
    window.dispatchEvent(pageShow);

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(board.scrollLeft).toBe(0);

    viewportSpy.mockRestore();
  });

  it("does not throw when visualViewport resize listener lacks removeEventListener (Android seam)", () => {
    const viewportSpy = mockViewport(375);
    const visualViewportResizeListeners: Array<() => void> = [];

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        scale: 1,
        addEventListener: (_event: string, listener: () => void) => {
          visualViewportResizeListeners.push(listener);
        },
      },
    });

    render(<Board {...boardProps} />);

    expect(visualViewportResizeListeners).toHaveLength(1);

    expect(() => {
      visualViewportResizeListeners[0]();
    }).not.toThrow();

    viewportSpy.mockRestore();
  });

  it("is a desktop no-op and does not force pageshow re-anchor", () => {
    const viewportSpy = mockViewport(1280);
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    render(<Board {...boardProps} />);
    const board = document.querySelector("main.board") as HTMLElement;
    board.scrollLeft = 500;

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { configurable: true, value: true });
    window.dispatchEvent(pageShow);

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(board.scrollLeft).toBe(500);
    expect(addEventListenerSpy).not.toHaveBeenCalledWith("pageshow", expect.any(Function));

    viewportSpy.mockRestore();
  });

  it("preserves FN-001 mobile board invariants and avoids button-rule mutations in .board mobile block", () => {
    const cssContent = loadAllAppCss();
    const mobileCss = extractMediaBlocks(cssContent, /\(max-width: 768px\)/);
    const boardBlock = extractRule(mobileCss, ".board");

    expect(boardBlock).toContain("scroll-snap-type: x proximity");
    expect(boardBlock).toContain("overflow-anchor: none");
    expect(boardBlock).not.toContain("scroll-snap-type: x mandatory");

    const forbiddenBoardSelectors = [
      /\.board[^\{]*\.btn\s*\{/,
      /\.board[^\{]*\.btn-icon\s*\{/,
      /\.board[^\{]*\.modal-close\s*\{/,
      /\.board[^\{]*\.card-[^\s\{]*\s*\{/,
      /\.board[^\{]*\.btn[^\{]*min-height\s*:/,
      /\.board[^\{]*\.btn-icon[^\{]*min-height\s*:/,
      /\.board[^\{]*\.modal-close[^\{]*min-height\s*:/,
      /\.board[^\{]*\.card-[^\{]*min-height\s*:/,
    ];

    for (const forbiddenSelector of forbiddenBoardSelectors) {
      expect(mobileCss).not.toMatch(forbiddenSelector);
    }
  });

  it("keeps the board fill-height invariant across base, tablet, and mobile CSS tiers", () => {
    const cssContent = loadAllAppCss();
    const baseBoardRule = extractRule(cssContent, ".board");
    const tabletCss = extractMediaBlocks(cssContent, /\(min-width: 769px\) and \(max-width: 1024px\)/);
    const mobileCss = extractMediaBlocks(cssContent, /\(max-width: 768px\)/);
    const tabletBoardRule = extractRule(tabletCss, ".board");
    const mobileBoardRule = extractRule(mobileCss, ".board");
    const mobileColumnRule = extractRule(mobileCss, ".board > .column");
    const projectContentRule = extractRule(cssContent, ".project-content");

    expect(projectContentRule).toContain("display: flex");
    expect(projectContentRule).toContain("min-height: 0");
    expect(projectContentRule).toContain("min-width: 0");

    expect(baseBoardRule).toContain("box-sizing: border-box");
    expect(baseBoardRule).toContain("flex: 1 1 auto");
    expect(baseBoardRule).toContain("min-height: 0");
    expect(baseBoardRule).toContain("min-width: 0");

    expect(tabletBoardRule).toContain("grid-template-columns: repeat(6, minmax(260px, 1fr))");
    expect(tabletBoardRule).toContain("overflow-x: auto");

    expect(mobileBoardRule).toContain("display: flex");
    expect(mobileBoardRule).toContain("scroll-snap-type: x proximity");
    expect(mobileBoardRule).toContain("width: 100%");
    expect(mobileColumnRule).toContain("width: 300px");
    expect(mobileColumnRule).toContain("min-width: 300px");
    expect(mobileColumnRule).toContain("flex-shrink: 0");
  });

  it("renders the board main element and all column children for empty and populated states", () => {
    const viewportSpy = mockViewport(1280);
    const { rerender } = render(<Board {...boardProps} />);

    let board = document.querySelector("main.board");
    expect(board).not.toBeNull();

    let columns = document.querySelectorAll("[data-testid^='column-']");
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      expect(column).toHaveAttribute("data-task-count", "0");
    }

    rerender(
      <Board
        {...boardProps}
        tasks={[
          { id: "FN-1", title: "Planning task", column: "triage" },
          { id: "FN-2", title: "Todo task", column: "todo" },
        ] as any}
      />,
    );

    board = document.querySelector("main.board");
    expect(board).not.toBeNull();

    columns = document.querySelectorAll("[data-testid^='column-']");
    expect(columns).toHaveLength(6);
    expect(document.querySelector("[data-testid='column-triage']")).toHaveAttribute("data-task-count", "1");
    expect(document.querySelector("[data-testid='column-todo']")).toHaveAttribute("data-task-count", "1");

    viewportSpy.mockRestore();
  });
});
