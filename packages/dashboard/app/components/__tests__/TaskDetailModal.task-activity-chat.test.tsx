import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { type ComponentProps } from "react";
import type { AgentLogEntry } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import { FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, FloatingWindow } from "../FloatingWindow";
import { useAgentLogs } from "../../hooks/useAgentLogs";

setupTaskDetailModalHooks();

const mockedUseAgentLogs = vi.mocked(useAgentLogs);

function renderModal(props: Partial<ComponentProps<typeof TaskDetailModal>> = {}) {
  return render(
    <TaskDetailModal
      task={makeTask({
        id: "FN-7315",
        column: "in-progress" as any,
        log: [
          { timestamp: "2026-06-30T20:00:00.000Z", action: "Started work", outcome: "Executor checked out" },
          { timestamp: "2026-06-30T20:01:00.000Z", action: "Posted update" },
        ],
        steeringComments: [
          { id: "steer-existing", text: "Existing steering guidance", author: "user", createdAt: "2026-06-30T20:02:00.000Z" },
        ],
      })}
      onClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
      {...props}
    />,
  );
}

function topLevelTabLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab"))
    .map((button) => button.textContent?.trim() ?? "");
}

type ActivitySegmentTestValue = "current" | "feed" | "raw-logs";

const ACTIVITY_VIEW_LABELS: Record<ActivitySegmentTestValue, string> = {
  current: "Live",
  feed: "Feed",
  "raw-logs": "Raw",
};

function openActivityViewMenu() {
  const existingMenu = screen.queryByRole("menu", { name: "Activity views" });
  if (!existingMenu) {
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  }
  return screen.getByRole("menu", { name: "Activity views" });
}

function activityViewLabels(): string[] {
  openActivityViewMenu();
  return screen.getAllByRole("menuitem").map((option) => option.textContent?.trim() ?? "");
}

function expectActivityView(value: ActivitySegmentTestValue) {
  openActivityViewMenu();
  expect(screen.getByRole("menuitem", { name: ACTIVITY_VIEW_LABELS[value] })).toHaveAttribute("aria-current", "true");
}

function selectActivityView(value: ActivitySegmentTestValue) {
  openActivityViewMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: ACTIVITY_VIEW_LABELS[value] }));
}

function mockRawLogs(entries: AgentLogEntry[]) {
  mockedUseAgentLogs.mockReturnValue({
    entries,
    loading: false,
    clear: vi.fn(),
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    total: entries.length,
    loadingMore: false,
  });
}

function createMockVisualViewport(width: number, height: number) {
  const visualViewport = new EventTarget() as EventTarget & Pick<VisualViewport, "width" | "height" | "offsetLeft" | "offsetTop" | "scale">;
  Object.defineProperties(visualViewport, {
    width: { configurable: true, value: width },
    height: { configurable: true, value: height },
    offsetLeft: { configurable: true, value: 0 },
    offsetTop: { configurable: true, value: 0 },
    scale: { configurable: true, value: 1 },
  });
  return visualViewport;
}

describe("TaskDetailModal Activity and planner Chat tab integration", () => {
  it("defaults to Activity first while selecting Live, Feed, and Raw without duplicate panels on desktop", async () => {
    const user = userEvent.setup();
    mockRawLogs([
      { timestamp: "2026-06-30T20:03:00.000Z", taskId: "FN-7315", type: "text", agent: "executor", text: "raw executor line" },
    ] as AgentLogEntry[]);

    renderModal();

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Activity", "Chat"]);
    expect(screen.getAllByRole("button", { name: "Chat" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expect(screen.queryByTestId("task-planner-chat-panel")).not.toBeInTheDocument();
    expect(activityViewLabels()).toEqual(["Live", "Feed", "Raw"]);
    expectActivityView("current");
    expect(document.querySelector(".activity-view-select")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Activity view" })).not.toBeInTheDocument();
    expect(document.querySelector(".activity-segmented-control")).toBeNull();
    expect(document.querySelector(".activity-segment")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Activity views" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("form", { name: "Task activity composer" })).toHaveLength(1);
    expect(screen.queryByText(/^Steering comment$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Send operational guidance to the active task through steering comments.")).not.toBeInTheDocument();
    expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Feed" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-viewer")).not.toBeInTheDocument();

    selectActivityView("feed");

    expectActivityView("feed");
    expect(screen.queryByRole("form", { name: "Task activity composer" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
    expect(screen.getByText("Posted update")).toBeInTheDocument();
    expect(screen.queryByText("Existing steering guidance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-viewer")).not.toBeInTheDocument();

    selectActivityView("raw-logs");

    expectActivityView("raw-logs");
    expect(screen.queryByRole("form", { name: "Task activity composer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Feed" })).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();
    expect(screen.getByText("raw executor line")).toBeInTheDocument();
  });

  it("portals the mobile Activity view menu outside the tab scroller while keeping tabs and content visible", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: 24, y: 96, top: 96, right: 116, bottom: 132, left: 24, width: 92, height: 36, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      mockRawLogs([
        { timestamp: "2026-06-30T20:03:00.000Z", taskId: "FN-7315", type: "text", agent: "executor", text: "raw executor line" },
      ] as AgentLogEntry[]);
      renderModal();

      const tabs = document.querySelector(".detail-tabs");
      expect(tabs).not.toBeNull();
      expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();

      const menu = openActivityViewMenu();
      expect(menu.parentElement).toBe(document.body);
      expect(tabs).not.toContainElement(menu);
      expect(document.querySelector(".detail-tab-dropdown")?.contains(menu)).toBe(false);
      expect(menu).toHaveStyle({ position: "fixed" });
      expect(menu.style.top).not.toBe("");
      expect(menu.style.left).not.toBe("");
      expect(activityViewLabels()).toEqual(["Live", "Feed", "Raw"]);
      expect(topLevelTabLabels()).toEqual(expect.arrayContaining(["Activity", "Chat", "Plan", "Changes", "Review"]));
      expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
      expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();

      fireEvent.keyDown(menu, { key: "Escape" });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(topLevelTabLabels()).toEqual(expect.arrayContaining(["Activity", "Chat", "Plan", "Changes", "Review"]));
      expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();

      selectActivityView("feed");
      expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
      expect(screen.getByText("Posted update")).toBeInTheDocument();
      expect(topLevelTabLabels()).toEqual(expect.arrayContaining(["Activity", "Chat", "Plan", "Changes", "Review"]));

      selectActivityView("raw-logs");
      expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();
      expect(screen.getByText("raw executor line")).toBeInTheDocument();

      selectActivityView("current");
      expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Feed" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("agent-log-viewer")).not.toBeInTheDocument();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("keeps the mobile iOS Activity menu usable through the opening visualViewport echo", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const documentElement = document.documentElement;
    const performanceNowSpy = vi.spyOn(performance, "now").mockReturnValue(100);
    const visualViewport = createMockVisualViewport(390, 720);
    const addVisualViewportListenerSpy = vi.spyOn(visualViewport, "addEventListener");
    const removeVisualViewportListenerSpy = vi.spyOn(visualViewport, "removeEventListener");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(documentElement, "clientWidth", { configurable: true, value: 390 });
    Object.defineProperty(documentElement, "clientHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: 24, y: 96, top: 96, right: 116, bottom: 132, left: 24, width: 92, height: 36, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      mockRawLogs([
        { timestamp: "2026-06-30T20:03:00.000Z", taskId: "FN-7315", type: "text", agent: "executor", text: "raw executor line" },
      ] as AgentLogEntry[]);
      const { rerender, unmount } = renderModal();
      const activityButton = screen.getByRole("button", { name: "Activity" });

      fireEvent.click(activityButton);
      let menu = screen.getByRole("menu", { name: "Activity views" });
      performanceNowSpy.mockReturnValue(120);
      act(() => {
        visualViewport.dispatchEvent(new Event("resize"));
        visualViewport.dispatchEvent(new Event("scroll"));
      });
      menu = screen.getByRole("menu", { name: "Activity views" });

      expect(menu.parentElement).toBe(document.body);
      expect(document.querySelector(".detail-tabs")).not.toContainElement(menu);
      expect(document.querySelector(".detail-tab-dropdown")?.contains(menu)).toBe(false);
      expect(menu).toHaveStyle({ position: "fixed" });
      expect(menu.style.top).not.toBe("");
      expect(menu.style.left).not.toBe("");
      expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(menu.style.left)).toBeLessThan(390);
      expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(menu.style.top)).toBeLessThan(844);
      expect(document.querySelectorAll(".activity-view-menu")).toHaveLength(1);
      expect(document.querySelectorAll(".detail-tab--activity")).toHaveLength(1);
      expect(activityButton).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("menuitem", { name: "Feed" }));
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
      expect(screen.getByText("Posted update")).toBeInTheDocument();

      selectActivityView("raw-logs");
      expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();
      expect(screen.getByText("raw executor line")).toBeInTheDocument();

      selectActivityView("current");
      expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-log-viewer")).not.toBeInTheDocument();

      fireEvent.click(activityButton);
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(activityButton);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(activityButton);
      performanceNowSpy.mockReturnValue(1000);
      act(() => {
        visualViewport.dispatchEvent(new Event("resize"));
      });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(activityButton);
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      rerender(
        <TaskDetailModal
          task={makeTask({ id: "FN-7485-NEXT", column: "in-progress" as any, log: [], steeringComments: [] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(document.querySelector(".activity-view-select")).toBeNull();
      expect(document.querySelector(".activity-segmented-control")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      unmount();
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(removeVisualViewportListenerSpy).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(removeVisualViewportListenerSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
      expect(addVisualViewportListenerSpy).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(addVisualViewportListenerSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
    } finally {
      performanceNowSpy.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
      if (originalVisualViewport) {
        Object.defineProperty(window, "visualViewport", originalVisualViewport);
      } else {
        delete (window as unknown as { visualViewport?: unknown }).visualViewport;
      }
      delete (documentElement as unknown as { clientWidth?: number }).clientWidth;
      delete (documentElement as unknown as { clientHeight?: number }).clientHeight;
    }
  });

  // FN-7536 regression: Android/mobile Chrome can fire a `window` resize/scroll as an echo of the
  // SAME tap that opens the Activity menu (URL-bar collapse, tapped-element auto-scroll-into-view),
  // distinct from the iOS visualViewport echo above. Before the fix this unguarded window listener
  // closed the menu the instant it opened; now it must be guarded the same way visualViewport is,
  // while a later, real resize/scroll still closes the menu.
  it("keeps the mobile Android Activity menu usable through the opening window resize/scroll echo", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const performanceNowSpy = vi.spyOn(performance, "now").mockReturnValue(100);
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: 24, y: 96, top: 96, right: 116, bottom: 132, left: 24, width: 92, height: 36, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      mockRawLogs([]);
      renderModal();
      const activityButton = screen.getByRole("button", { name: "Activity" });

      fireEvent.click(activityButton);
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();

      // Same-gesture echo: still inside the opening guard window, so it must reposition, not close.
      performanceNowSpy.mockReturnValue(120);
      act(() => {
        fireEvent.scroll(window);
        fireEvent(window, new Event("resize"));
      });
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "true");

      // A later, real resize (well past the opening guard window) is a true viewport change and
      // must still close the menu.
      performanceNowSpy.mockReturnValue(10_000);
      act(() => {
        fireEvent(window, new Event("resize"));
      });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "false");

      // Orientation change follows the same guarded path.
      fireEvent.click(activityButton);
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      performanceNowSpy.mockReturnValue(20_000);
      act(() => {
        fireEvent(window, new Event("orientationchange"));
      });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
    } finally {
      performanceNowSpy.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  // FN-7536 regression: `.detail-tabs` is an intentional horizontal overflow scroller. Scrolling it
  // (e.g. a mobile drag that brings the Activity tab further into view while the menu is open) must
  // reposition the menu, never close it — only a genuine page/viewport scroll outside the tab
  // scroller is a "true viewport change".
  it("repositions instead of closing the Activity menu when the .detail-tabs scroller itself scrolls", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const performanceNowSpy = vi.spyOn(performance, "now").mockReturnValue(100);
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: 24, y: 96, top: 96, right: 116, bottom: 132, left: 24, width: 92, height: 36, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      mockRawLogs([]);
      renderModal();
      const activityButton = screen.getByRole("button", { name: "Activity" });

      fireEvent.click(activityButton);
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();

      // Move well past the opening guard window so only the scroll-origin exemption is under test.
      performanceNowSpy.mockReturnValue(10_000);
      const tabsScroller = document.querySelector(".detail-tabs");
      expect(tabsScroller).not.toBeNull();
      act(() => {
        fireEvent.scroll(tabsScroller as Element);
      });
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      expect(activityButton).toHaveAttribute("aria-expanded", "true");

      // A real page scroll (not originating in the tab scroller) still closes the menu.
      act(() => {
        fireEvent.scroll(window);
      });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
    } finally {
      performanceNowSpy.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  // FN-7536 regression: the .floating-window--task-detail popup host must ALSO honor the opening
  // guard — a same-gesture window scroll/resize echo while the menu is opening inside a popup must
  // not close it, matching the fixed-modal-host behavior above.
  it("keeps the Activity menu open through an opening-tap window scroll echo inside the popup host", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const performanceNowSpy = vi.spyOn(performance, "now").mockReturnValue(100);
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: 144, y: 90, top: 90, right: 236, bottom: 126, left: 144, width: 92, height: 36, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      mockRawLogs([]);
      render(
        <FloatingWindow
          windowKey="task-detail-FN-7536"
          title="FN-7536"
          onClose={noop}
          hideHeader
          dragHandleSelector=".task-detail-content--embedded > .modal-header"
          className="floating-window--task-detail"
          layer="task-detail"
        >
          <TaskDetailContent
            task={makeTask({ id: "FN-7536", column: "in-progress" as any, log: [], steeringComments: [] })}
            embedded
            onRequestClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />
        </FloatingWindow>,
      );

      const activityButton = screen.getByRole("button", { name: "Activity" });
      fireEvent.click(activityButton);
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();
      const menu = screen.getByRole("menu", { name: "Activity views" });
      expect(menu.parentElement).toBe(document.body);

      // Same-gesture echo inside the popup host: must reposition, not close.
      performanceNowSpy.mockReturnValue(150);
      act(() => {
        fireEvent.scroll(window);
      });
      expect(screen.getByRole("menu", { name: "Activity views" })).toBeInTheDocument();

      // A later real scroll still closes it.
      performanceNowSpy.mockReturnValue(10_000);
      act(() => {
        fireEvent.scroll(window);
      });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
    } finally {
      performanceNowSpy.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  // FN-7375 regression: the position:fixed Activity menu is anchored to the layout viewport, so a
  // diverging window.visualViewport (pinch-zoom / open mobile keyboard: smaller width, nonzero
  // offsetLeft) must NOT shift the menu away from the trigger. Symptom was the popup rendering
  // detached to the far left of the modal instead of under the "Activity" tab.
  it("keeps the Activity menu above and anchored to a moving task-detail popup", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const cancelRafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    let triggerRect = { left: 144, top: 90, right: 236, bottom: 126, width: 92, height: 36 };

    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: triggerRect.left, y: triggerRect.top, ...triggerRect, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      mockRawLogs([]);
      render(
        <FloatingWindow
          windowKey="task-detail-FN-7493"
          title="FN-7493"
          onClose={noop}
          hideHeader
          dragHandleSelector=".task-detail-content--embedded > .modal-header"
          className="floating-window--task-detail"
          layer="task-detail"
        >
          <TaskDetailContent
            task={makeTask({ id: "FN-7493", column: "in-progress" as any, log: [], steeringComments: [] })}
            embedded
            onRequestClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />
        </FloatingWindow>,
      );

      const popup = screen.getByTestId("floating-window-task-detail-FN-7493");
      const menu = openActivityViewMenu();
      expect(menu.parentElement).toBe(document.body);
      expect(Number(getComputedStyle(menu).zIndex)).toBeGreaterThan(Number(popup.style.zIndex));
      expect(menu.style.left).toBe("144px");
      expect(menu.style.top).toBe("130px");

      triggerRect = { left: 260, top: 140, right: 352, bottom: 176, width: 92, height: 36 };
      act(() => {
        window.dispatchEvent(new CustomEvent(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, { detail: { windowKey: "task-detail-FN-7493", layer: "task-detail" } }));
      });

      expect(menu.style.left).toBe("260px");
      expect(menu.style.top).toBe("180px");
      expect(document.querySelectorAll(".activity-view-menu")).toHaveLength(1);
      expect(document.querySelectorAll(".detail-tab--activity")).toHaveLength(1);
      fireEvent.keyDown(menu, { key: "Escape" });
      expect(screen.queryByRole("menu", { name: "Activity views" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute("aria-expanded", "false");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });

  it("anchors the Activity menu under the trigger regardless of a diverging visual viewport", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const documentElement = document.documentElement;

    // Layout viewport is 1280x800 (wide desktop); the Activity trigger sits well inside it.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(documentElement, "clientWidth", { configurable: true, value: 1280 });
    Object.defineProperty(documentElement, "clientHeight", { configurable: true, value: 800 });
    // A pinch-zoomed visual viewport: much smaller and panned. The old code fed this into a fixed
    // element's clamp and shoved it to the left edge.
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { width: 320, height: 480, offsetLeft: 240, offsetTop: 120, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("detail-tab--activity")) {
        return { x: 700, y: 96, top: 96, right: 792, bottom: 132, left: 700, width: 92, height: 36, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      renderModal();
      const menu = openActivityViewMenu();
      // Left edge anchored under the trigger (rect.left = 700), NOT clamped to a shrunken visual
      // viewport and NOT displaced by visualViewport.offsetLeft.
      expect(menu.style.left).toBe("700px");
      // Opens below the trigger (rect.bottom = 132) + gap, unaffected by visualViewport.offsetTop.
      expect(menu.style.top).toBe("136px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
      if (originalVisualViewport) {
        Object.defineProperty(window, "visualViewport", originalVisualViewport);
      } else {
        delete (window as unknown as { visualViewport?: unknown }).visualViewport;
      }
      delete (documentElement as unknown as { clientWidth?: number }).clientWidth;
      delete (documentElement as unknown as { clientHeight?: number }).clientHeight;
    }
  });

  it("restores Chat-first ordering and omitted non-done default when the project setting is enabled", () => {
    mockRawLogs([]);

    renderModal({ taskDetailChatFirst: true });

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Chat", "Activity"]);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Activity views" })).not.toBeInTheDocument();
  });

  it("keeps explicit Activity, planner Chat, and Logs deep links stable across the ordering setting", () => {
    mockRawLogs([]);

    const { rerender } = renderModal({ initialTab: "chat", taskDetailChatFirst: true });

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Chat", "Activity"]);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expectActivityView("current");
    expect(screen.queryByTestId("task-planner-chat-panel")).not.toBeInTheDocument();

    rerender(
      <TaskDetailModal
        task={makeTask({ id: "FN-7315", column: "in-progress" as any, log: [], steeringComments: [] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        initialTab="planner-chat"
        taskDetailChatFirst={false}
      />,
    );

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Activity", "Chat"]);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();

    rerender(
      <TaskDetailModal
        task={makeTask({ id: "FN-7315", column: "in-progress" as any, log: [{ timestamp: "2026-06-30T20:01:00.000Z", action: "Posted update" }], steeringComments: [] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        initialTab="logs"
        taskDetailChatFirst={true}
      />,
    );

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Chat", "Activity"]);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expectActivityView("feed");
    expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
  });

  it("preserves Summary as the done-task mobile default while Activity and Chat remain first", async () => {
    const user = userEvent.setup();
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    try {
      mockRawLogs([]);
      render(
        <TaskDetailContent
          task={makeTask({ id: "FN-7315-DONE", column: "done" as any, log: [], steeringComments: [] })}
          embedded
          onRequestClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(topLevelTabLabels().slice(0, 3)).toEqual(["Activity", "Chat", "Summary"]);
      expect(screen.getByRole("button", { name: "Summary" })).toHaveClass("detail-tab-active");
      expect(screen.queryByRole("combobox", { name: "Activity view" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Activity" }));
      expect(activityViewLabels()).toEqual(["Live", "Feed", "Raw"]);
      expect(screen.queryByRole("tablist", { name: "Activity views" })).not.toBeInTheDocument();
      expect(screen.getByText("No agent output yet. Live messages from Planner, Executor, Reviewer, and Merger agents will appear here.")).toBeInTheDocument();
      expect(screen.getAllByRole("form", { name: "Task refinement composer" })).toHaveLength(1);
      expect(screen.queryByRole("form", { name: "Refinement request" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Chat" }));
      expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
      expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Task activity composer" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Task refinement composer" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Steering comment" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Refinement request" })).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      window.dispatchEvent(new Event("resize"));
    }
  });
});
