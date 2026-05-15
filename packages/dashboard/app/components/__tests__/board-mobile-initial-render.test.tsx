import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { Board } from "../Board";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useBlockerFanout", () => ({
  useBlockerFanout: () => new Map(),
}));

vi.mock("../Column", () => ({
  Column: React.memo(({ column }: { column: string }) => (
    <div data-testid={`column-${column}`} />
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
    matches: query === "(max-width: 768px)" ? width <= 768 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
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

  it("normalizes scrollLeft to 0 on initial mobile render and keeps snap style in CSS, not inline", async () => {
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

    vi.advanceTimersByTime(1);
    await waitFor(() => {
      expect(board.scrollLeft).toBe(0);
    });
    expect(raf).toHaveBeenCalled();
    expect(board.style.scrollSnapType).toBe("");

    viewportSpy.mockRestore();
  });

  it("re-anchors on pageshow persisted restore for mobile", async () => {
    const viewportSpy = mockViewport(375);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(<Board {...boardProps} />);

    const board = document.querySelector("main.board") as HTMLElement;
    vi.advanceTimersByTime(1);
    await waitFor(() => expect(board.scrollLeft).toBe(0));

    board.scrollLeft = 500;
    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { configurable: true, value: true });
    window.dispatchEvent(pageShow);

    vi.advanceTimersByTime(1);
    await waitFor(() => expect(board.scrollLeft).toBe(0));

    viewportSpy.mockRestore();
  });

  it("is a desktop no-op and does not force pageshow re-anchor", async () => {
    const viewportSpy = mockViewport(1280);
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    render(<Board {...boardProps} />);
    const board = document.querySelector("main.board") as HTMLElement;
    board.scrollLeft = 500;

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { configurable: true, value: true });
    window.dispatchEvent(pageShow);

    vi.advanceTimersByTime(1);
    await waitFor(() => expect(board.scrollLeft).toBe(500));
    expect(addEventListenerSpy).not.toHaveBeenCalledWith("pageshow", expect.any(Function));

    viewportSpy.mockRestore();
  });

  it("preserves FN-001 mobile board invariants and avoids button-rule mutations in .board mobile block", () => {
    const cssContent = loadAllAppCss();
    const mobileCss = extractMobileMediaBlocks(cssContent);
    const boardBlock = mobileCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";

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
});
