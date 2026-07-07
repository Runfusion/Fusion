import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { Board } from "../Board";
import { loadAllAppCss } from "../../test/cssFixture";

const apiMocks = vi.hoisted(() => ({
  fetchBoardWorkflows: vi.fn(),
  fetchWorkflowSteps: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchBoardWorkflows: apiMocks.fetchBoardWorkflows,
  fetchWorkflowSteps: apiMocks.fetchWorkflowSteps,
  promoteTask: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../hooks/useBlockerFanout", () => ({
  useBlockerFanout: () => new Map(),
}));

vi.mock("../Column", () => ({
  Column: React.memo(({ column, tasks }: { column: string; tasks?: unknown[] }) => (
    <div className="column" data-task-count={tasks?.length ?? 0} data-testid={`column-${column}`} />
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

function expectLogicalOrPhysicalMinSize(rule: string, axis: "block" | "inline"): void {
  const logicalProp = axis === "block" ? "min-block-size" : "min-inline-size";
  const physicalProp = axis === "block" ? "min-height" : "min-width";
  expect(rule).toSatisfy((value: string) => value.includes(`${logicalProp}: 0`) || value.includes(`${physicalProp}: 0`));
}

const workflowPayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "triage", name: "Triage", flags: { intake: true } },
        { id: "todo", name: "Todo", flags: {} },
        { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
        { id: "in-review", name: "In Review", flags: { humanReview: true } },
        { id: "done", name: "Done", flags: { complete: true } },
        { id: "archived", name: "Archived", flags: { archived: true } },
      ],
    },
  ],
  taskWorkflowIds: {},
};

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
    apiMocks.fetchBoardWorkflows.mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    apiMocks.fetchWorkflowSteps.mockResolvedValue([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves board column scroll during initial mobile stabilization while keeping snap style in CSS, not inline", () => {
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
    /*
    FNXC:BoardMobile 2026-07-07-08:30:
    FN-7342 (preserve board scroll during refresh stabilization) removed the `boardEl.scrollLeft = 0` reset from mobile stabilization — #board is the user's horizontal scroller, so stabilization now only normalizes document-level horizontal drift and must not force the board back to triage. The board's column scroll position is therefore preserved (500) instead of reset to 0; rAF scheduling and the CSS-not-inline snap invariant still hold.
    */
    expect(board.scrollLeft).toBe(500);
    expect(raf).toHaveBeenCalled();
    expect(board.style.scrollSnapType).toBe("");

    viewportSpy.mockRestore();
  });

  it("preserves board column scroll on pageshow persisted restore for mobile", () => {
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
    /*
    FNXC:BoardMobile 2026-07-07-08:32:
    FN-7342 keeps pageshow/bfcache stabilization scoped to document-level drift, so the board column scroll set before the restore (500) is preserved rather than re-anchored to 0.
    */
    expect(board.scrollLeft).toBe(500);

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

    const { unmount } = render(<Board {...boardProps} />);

    /*
     * FNXC:MobileBoard 2026-06-25-11:24:
     * Board owns more than one legitimate visualViewport resize subscriber (responsive mode plus mobile re-anchor). The Android seam is the missing `removeEventListener`, so assert every registered listener is safe instead of pinning an incidental listener count.
     */
    expect(visualViewportResizeListeners.length).toBeGreaterThan(0);

    expect(() => {
      act(() => {
        for (const listener of visualViewportResizeListeners) {
          listener();
        }
      });
    }).not.toThrow();

    // Exercises the Android seam: cleanup must not throw without removeEventListener.
    expect(() => unmount()).not.toThrow();

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
    expect(addEventListenerSpy).toHaveBeenCalledWith("pageshow", expect.any(Function));

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

  it("keeps the board fill-height invariant across workflow, base, tablet, and mobile CSS tiers", () => {
    const cssContent = loadAllAppCss();
    const baseBoardRule = extractRule(cssContent, ".board");
    const workflowViewRule = extractRule(cssContent, ".board-workflow-view");
    const workflowColumnsRule = extractRule(cssContent, ".board.board-workflow-columns");
    const workflowColumnRule = extractRule(cssContent, ".board.board-workflow-columns > .column");
    const sharedColumnRule = extractRule(cssContent, ".column");
    const workflowTabletCss = extractMediaBlocks(cssContent, /\(max-width: 1024px\)/);
    const workflowTabletColumnsRule = extractRule(workflowTabletCss, ".board.board-workflow-columns");
    const tabletCss = extractMediaBlocks(cssContent, /\(min-width: 769px\) and \(max-width: 1024px\)/);
    const mobileCss = extractMediaBlocks(cssContent, /\(max-width: 768px\)/);
    const tabletBoardRule = extractRule(tabletCss, ".board");
    const mobileBoardRule = extractRule(mobileCss, ".board");
    const mobileColumnRule = extractRule(mobileCss, ".board > .column");
    const mobileProjectContentRule = extractRule(mobileCss, ".project-content");
    const mobileWorkflowViewRule = extractRule(mobileCss, ".board-workflow-view");
    const mobileWorkflowColumnsRule = extractRule(mobileCss, ".board.board-workflow-columns");
    const mobileWorkflowColumnRule = extractRule(mobileCss, ".board.board-workflow-columns > .column");
    const projectContentRule = extractRule(cssContent, ".project-content");

    expect(projectContentRule).toContain("display: flex");
    /*
     * FNXC:BoardMobileCss 2026-06-19-03:16:
     * The fill-height invariant accepts logical min-size properties because styles.css canonicalizes .project-content to writing-mode-safe min-block-size/min-inline-size declarations.
     */
    expectLogicalOrPhysicalMinSize(projectContentRule, "block");
    expectLogicalOrPhysicalMinSize(projectContentRule, "inline");

    expect(baseBoardRule).toContain("box-sizing: border-box");
    expect(baseBoardRule).toContain("flex: 1 1 auto");
    expect(baseBoardRule).toContain("height: 100%");
    expect(baseBoardRule).toContain("min-height: 0");
    expect(baseBoardRule).toContain("min-width: 0");

    expect(workflowViewRule).toContain("display: flex");
    expect(workflowViewRule).toContain("flex-direction: column");
    expect(workflowViewRule).toContain("flex: 1 1 auto");
    expect(workflowViewRule).toContain("height: 100%");
    expect(workflowViewRule).toContain("max-height: 100%");
    expect(workflowViewRule).toContain("min-height: 0");

    expect(workflowColumnsRule).toContain("flex: 1 1 auto");
    expect(workflowColumnsRule).toContain("display: flex");
    expect(workflowColumnsRule).toContain("align-items: stretch");
    expect(workflowColumnsRule).toContain("height: 100%");
    expect(workflowColumnsRule).toContain("max-height: 100%");
    expect(workflowColumnsRule).toContain("min-height: 0");
    expect(workflowColumnsRule).toContain("scroll-snap-type: x proximity");
    expect(workflowColumnsRule).not.toContain("scroll-snap-type: x mandatory");

    expect(workflowTabletColumnsRule).toContain("flex: 1 1 auto");
    expect(workflowTabletColumnsRule).toContain("align-items: stretch");
    expect(workflowTabletColumnsRule).toContain("height: 100%");
    expect(workflowTabletColumnsRule).toContain("max-height: 100%");
    expect(workflowTabletColumnsRule).toContain("min-height: 0");
    expect(workflowTabletColumnsRule).toContain("scroll-snap-type: x proximity");
    expect(workflowTabletColumnsRule).not.toContain("scroll-snap-type: x mandatory");

    expect(workflowColumnRule).toContain("flex: 1 0 300px");
    expect(workflowColumnRule).toContain("min-width: 300px");
    expect(workflowColumnRule).toContain("height: 100%");
    expect(workflowColumnRule).toContain("min-height: 0");
    expect(sharedColumnRule).toContain("min-height: 0");

    expect(tabletBoardRule).toContain("grid-template-columns: repeat(6, minmax(260px, 1fr))");
    expect(tabletBoardRule).toContain("overflow-x: auto");

    expect(mobileBoardRule).toContain("display: flex");
    expect(mobileBoardRule).toContain("scroll-snap-type: x proximity");
    expect(mobileBoardRule).toContain("width: 100%");
    expect(mobileColumnRule).toContain("width: 300px");
    expect(mobileColumnRule).toContain("min-width: 300px");
    expect(mobileColumnRule).toContain("flex-shrink: 0");

    expect(mobileProjectContentRule).toContain("display: flex");
    expect(mobileProjectContentRule).toContain("align-items: stretch");
    expect(mobileProjectContentRule).toContain("width: 100%");
    expectLogicalOrPhysicalMinSize(mobileProjectContentRule, "block");
    expect(mobileProjectContentRule).toContain("overflow: hidden");

    expect(mobileWorkflowViewRule).toContain("display: flex");
    expect(mobileWorkflowViewRule).toContain("flex-direction: column");
    expect(mobileWorkflowViewRule).toContain("flex: 1 1 auto");
    expect(mobileWorkflowViewRule).toContain("width: 100%");
    expect(mobileWorkflowViewRule).toContain("height: 100%");
    expect(mobileWorkflowViewRule).toContain("min-height: 0");
    expect(mobileWorkflowViewRule).toContain("overflow: hidden");

    expect(mobileWorkflowColumnsRule).toContain("display: flex");
    expect(mobileWorkflowColumnsRule).toContain("flex: 1 1 auto");
    expect(mobileWorkflowColumnsRule).toContain("align-items: stretch");
    expect(mobileWorkflowColumnsRule).toContain("width: 100%");
    expect(mobileWorkflowColumnsRule).toContain("height: 100%");
    expect(mobileWorkflowColumnsRule).toContain("min-height: 0");
    expect(mobileWorkflowColumnsRule).toContain("overflow-x: auto");
    expect(mobileWorkflowColumnsRule).toContain("overscroll-behavior-x: contain");
    expect(mobileWorkflowColumnsRule).toContain("touch-action: pan-x pan-y");
    expect(mobileWorkflowColumnsRule).toContain("scroll-snap-type: x proximity");
    expect(mobileWorkflowColumnsRule).not.toContain("scroll-snap-type: x mandatory");

    expect(mobileWorkflowColumnRule).toContain("flex: 1 0 300px");
    expect(mobileWorkflowColumnRule).toContain("min-width: 300px");
    expect(mobileWorkflowColumnRule).toContain("height: 100%");
    expect(mobileWorkflowColumnRule).toContain("min-height: 0");
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

  it("renders workflow-mode columns for empty and populated states at mobile width with and without the toolbar", async () => {
    vi.useRealTimers();
    const viewportSpy = mockViewport(390);
    apiMocks.fetchBoardWorkflows.mockResolvedValue(workflowPayload);

    const { rerender } = render(
      <Board
        {...boardProps}
        onCreateWorkflow={vi.fn()}
        onOpenWorkflowEditor={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".board-workflow-view")).not.toBeNull();
    });

    expect(document.querySelector(".board-workflow-toolbar")).not.toBeNull();
    let board = document.querySelector("main.board.board-workflow-columns");
    expect(board).not.toBeNull();

    let columns = document.querySelectorAll(".board-workflow-columns [data-testid^='column-']");
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      expect(column).toHaveClass("column");
      expect(column).toHaveAttribute("data-task-count", "0");
    }

    rerender(
      <Board
        {...boardProps}
        onCreateWorkflow={vi.fn()}
        onOpenWorkflowEditor={vi.fn()}
        tasks={[
          { id: "FN-1", title: "Workflow planning task", column: "triage" },
          { id: "FN-2", title: "Workflow todo task", column: "todo" },
        ] as any}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector("main.board.board-workflow-columns")).not.toBeNull();
    });

    board = document.querySelector("main.board.board-workflow-columns");
    expect(board).not.toBeNull();

    columns = document.querySelectorAll(".board-workflow-columns [data-testid^='column-']");
    expect(columns).toHaveLength(6);
    expect(document.querySelector(".board-workflow-columns [data-testid='column-triage']")).toHaveAttribute("data-task-count", "1");
    expect(document.querySelector(".board-workflow-columns [data-testid='column-todo']")).toHaveAttribute("data-task-count", "1");

    cleanup();

    render(<Board {...boardProps} />);

    await waitFor(() => {
      expect(document.querySelector("main.board.board-workflow-columns")).not.toBeNull();
    });

    /*
    FNXC:BoardMobile 2026-07-07-08:35:
    FN-6825 (combine workflow actions in switcher) moved edit/create into the WorkflowSwitcher, so shouldRenderWorkflowControls is now `workflowOptions.length > 0` rather than gated on onCreateWorkflow/onOpenWorkflowEditor. A Board rendered without those callbacks still shows the switcher toolbar whenever workflow options exist, so the no-callbacks toolbar shell no longer disappears.
    */
    expect(document.querySelector(".board-workflow-toolbar")).not.toBeNull();
    expect(document.querySelectorAll(".board-workflow-columns [data-testid^='column-']")).toHaveLength(6);

    viewportSpy.mockRestore();
  });

  it("renders workflow-mode columns for empty and populated states at tablet width", async () => {
    vi.useRealTimers();
    const viewportSpy = mockViewport(900);
    apiMocks.fetchBoardWorkflows.mockResolvedValue(workflowPayload);

    const { rerender } = render(<Board {...boardProps} />);

    await waitFor(() => {
      expect(document.querySelector(".board-workflow-view")).not.toBeNull();
    });

    let board = document.querySelector("main.board.board-workflow-columns");
    expect(board).not.toBeNull();

    let columns = document.querySelectorAll(".board-workflow-columns [data-testid^='column-']");
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      expect(column).toHaveClass("column");
      expect(column).toHaveAttribute("data-task-count", "0");
    }

    rerender(
      <Board
        {...boardProps}
        tasks={[
          { id: "FN-1", title: "Workflow planning task", column: "triage" },
          { id: "FN-2", title: "Workflow todo task", column: "todo" },
        ] as any}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector("main.board.board-workflow-columns")).not.toBeNull();
    });

    board = document.querySelector("main.board.board-workflow-columns");
    expect(board).not.toBeNull();

    columns = document.querySelectorAll(".board-workflow-columns [data-testid^='column-']");
    expect(columns).toHaveLength(6);
    expect(document.querySelector(".board-workflow-columns [data-testid='column-triage']")).toHaveAttribute("data-task-count", "1");
    expect(document.querySelector(".board-workflow-columns [data-testid='column-todo']")).toHaveAttribute("data-task-count", "1");

    viewportSpy.mockRestore();
  });
});
