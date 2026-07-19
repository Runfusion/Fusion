import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentLogViewer } from "../AgentLogViewer";
import { makeEntry, getScrollContainer } from "./AgentLogViewer.test-helpers";
import "../../styles.css";
import "../TaskDetailModal.css";

// Mock lucide-react icons used by AgentLogViewer and ProviderIcon
vi.mock("lucide-react", () => ({
  Maximize2: () => null,
  Minimize2: () => null,
  Loader2: () => null,
  Cpu: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));

describe("AgentLogViewer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("horizontal overflow prevention", () => {
    it("uses the scroll container class for overflow-x handling", () => {
      const longString = "A".repeat(300);
      const entries = [makeEntry({ text: longString })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const scrollContainer = getScrollContainer(container);
      expect(scrollContainer.classList.contains("agent-log-viewer-scroll")).toBe(true);
      expect(scrollContainer.style.overflowX).toBe("");
    });

    it("uses the scroll container class for overflow-wrap handling", () => {
      const entries = [makeEntry({ text: "x".repeat(250) })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const scrollContainer = getScrollContainer(container);
      expect(scrollContainer.classList.contains("agent-log-viewer-scroll")).toBe(true);
      expect(scrollContainer.style.overflowWrap).toBe("");
    });

    it("renders pre elements with overflow-x auto for internal scrolling", () => {
      const longLine = "const x = " + "'a'.repeat(500)";
      const entries = [makeEntry({ text: "```\n" + longLine + "\n```" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const pre = container.querySelector("pre") as HTMLElement;
      expect(pre).toBeTruthy();
      expect(pre.style.overflowX).toBe("auto");
      expect(pre.style.maxWidth).toBe("100%");
    });

    it("applies model-header wrapping via class", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const header = container.querySelector("[data-testid='agent-log-model-header']") as HTMLElement;
      expect(header.classList.contains("agent-log-model-header")).toBe(true);
      expect(header.style.flexWrap).toBe("");
    });
  });

  describe("full-height layout", () => {
    it("does not have a fixed maxHeight constraint", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      // The viewer should NOT have a maxHeight of 500px (the old fixed constraint)
      expect(viewer.style.maxHeight).not.toBe("500px");
      // maxHeight should be empty (unset) so the viewer can grow to fill available space
      expect(viewer.style.maxHeight).toBe("");
    });

    it("uses class-based overflow-y scrolling on the entries container", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const scrollContainer = getScrollContainer(container);
      // Scrolling behavior is now defined in CSS.
      expect(scrollContainer.classList.contains("agent-log-viewer-scroll")).toBe(true);
      expect(scrollContainer.style.overflowY).toBe("");
    });

    it("uses agent-log-viewer--streaming class when entries are present", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
      expect(viewer.classList.contains("agent-log-viewer--streaming")).toBe(true);
    });

    it("does not use streaming class on loading state", () => {
      const { container } = render(<AgentLogViewer entries={[]} loading={true} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
      expect(viewer.classList.contains("agent-log-viewer--streaming")).toBe(false);
    });
  });

  describe("sticky header layout", () => {
    it("renders the model header as a sibling of the scroll container", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      const header = screen.getByTestId("agent-log-model-header");
      const scrollContainer = getScrollContainer(container);

      expect(header.parentElement).toBe(viewer);
      expect(scrollContainer.parentElement).toBe(viewer);
      expect(scrollContainer.contains(header)).toBe(false);
    });

    it("renders log entry rows inside the scroll container", () => {
      const entries = [
        makeEntry({ type: "text", text: "hello" }),
        makeEntry({ type: "tool", text: "Bash" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const scrollContainer = getScrollContainer(container);

      expect(scrollContainer.querySelector(".agent-log-text")).toBeTruthy();
      expect(scrollContainer.querySelector(".agent-log-tool")).toBeTruthy();
    });

    it("renders pagination summary and load-more controls inside the scroll container", () => {
      const entries = [makeEntry({ text: "hello" })];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          totalCount={42}
          hasMore={true}
          onLoadMore={() => {}}
        />,
      );
      const scrollContainer = getScrollContainer(container);

      expect(scrollContainer.querySelector("[data-testid='agent-log-summary']")).toBeTruthy();
      expect(scrollContainer.querySelector("[data-testid='agent-log-load-more']")).toBeTruthy();
    });

    it("renders the return-to-live button inside the scroll container", () => {
      const entries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const scrollContainer = getScrollContainer(container);

      Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 200 });

      scrollContainer.scrollTop = 300;
      fireEvent.scroll(scrollContainer);

      const returnToLive = screen.getByTestId("agent-log-return-to-live");
      expect(returnToLive.parentElement).toBe(scrollContainer);
    });
  });

  describe("auto-scroll behavior", () => {
    it("scrolls to bottom when streaming updates arrive and user is near the bottom", () => {
      const initialEntries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const streamedEntries = [
        ...initialEntries,
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];

      const { rerender, container } = render(<AgentLogViewer entries={initialEntries} loading={false} />);
      const viewer = getScrollContainer(container);

      let scrollHeight = 600;
      Object.defineProperty(viewer, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });

      viewer.scrollTop = 560;
      rerender(<AgentLogViewer entries={[...initialEntries]} loading={false} />);

      scrollHeight = 720;
      rerender(<AgentLogViewer entries={streamedEntries} loading={false} />);

      expect(viewer.scrollTop).toBe(720);
    });

    it("does not auto-scroll when streaming updates arrive and user is reading older output", () => {
      const initialEntries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const streamedEntries = [
        ...initialEntries,
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];

      const { rerender, container } = render(<AgentLogViewer entries={initialEntries} loading={false} />);
      const viewer = getScrollContainer(container);

      let scrollHeight = 1000;
      Object.defineProperty(viewer, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });

      viewer.scrollTop = 220;
      fireEvent.scroll(viewer);
      rerender(<AgentLogViewer entries={[...initialEntries]} loading={false} />);

      scrollHeight = 1120;
      rerender(<AgentLogViewer entries={streamedEntries} loading={false} />);

      expect(viewer.scrollTop).toBe(220);
    });

    it("keeps viewport anchored when older history is prepended", () => {
      const initialEntries = [
        makeEntry({ text: "recent", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const olderLoadedEntries = [
        makeEntry({ text: "older", timestamp: "2025-12-31T23:59:00Z" }),
        ...initialEntries,
      ];

      const { rerender, container } = render(<AgentLogViewer entries={initialEntries} loading={false} />);
      const viewer = getScrollContainer(container);

      let scrollHeight = 900;
      Object.defineProperty(viewer, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });

      viewer.scrollTop = 260;
      rerender(<AgentLogViewer entries={[...initialEntries]} loading={false} />);

      scrollHeight = 1030;
      rerender(<AgentLogViewer entries={olderLoadedEntries} loading={false} />);

      // Anchored by delta (1030 - 900): 260 + 130
      expect(viewer.scrollTop).toBe(390);
    });

    it("shows return-to-live button when user scrolls away from bottom", () => {
      const entries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = getScrollContainer(container);

      Object.defineProperty(viewer, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 200 });

      viewer.scrollTop = 300;
      fireEvent.scroll(viewer);

      expect(screen.getByTestId("agent-log-return-to-live")).toBeTruthy();
    });

    it("hides return-to-live button when user is following live output", () => {
      const entries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = getScrollContainer(container);

      Object.defineProperty(viewer, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 200 });

      viewer.scrollTop = 760;
      fireEvent.scroll(viewer);

      expect(screen.queryByTestId("agent-log-return-to-live")).toBeNull();
    });

    it("returns to bottom and resumes following when return-to-live is clicked", () => {
      const entries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = getScrollContainer(container);

      Object.defineProperty(viewer, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 200 });

      viewer.scrollTop = 280;
      fireEvent.scroll(viewer);

      const returnButton = screen.getByTestId("agent-log-return-to-live");
      fireEvent.click(returnButton);

      expect(viewer.scrollTop).toBe(1000);
      expect(screen.queryByTestId("agent-log-return-to-live")).toBeNull();
    });

    it("FN-8339: does not let observers override a user who scrolls up during streamed growth", async () => {
      const resizeCallbacks: Array<() => void> = [];
      const originalResizeObserver = globalThis.ResizeObserver;

      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver));
        }

        observe() {}
        unobserve() {}
        disconnect() {}
      }

      Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
      try {
        const streamingEntry = makeEntry({ text: "streaming output" });
        const { container, rerender } = render(<AgentLogViewer entries={[streamingEntry]} loading={false} />);
        const viewer = getScrollContainer(container);
        let scrollHeight = 1000;
        Object.defineProperty(viewer, "scrollHeight", { configurable: true, get: () => scrollHeight });
        Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 200 });

        viewer.scrollTop = 300;
        fireEvent.scroll(viewer);
        scrollHeight = 1400;
        resizeCallbacks.forEach((callback) => callback());
        rerender(<AgentLogViewer entries={[{ ...streamingEntry, text: "streaming output grows in place" }]} loading={false} />);

        await waitFor(() => expect(viewer.scrollTop).toBe(300));
      } finally {
        if (originalResizeObserver) {
          Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
        } else {
          delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
        }
      }
    });

    it("FN-8339: follows in-place streamed growth while pinned", async () => {
      const streamingEntry = makeEntry({ text: "streaming output" });
      const { container, rerender } = render(<AgentLogViewer entries={[streamingEntry]} loading={false} />);
      const viewer = getScrollContainer(container);
      let scrollHeight = 1000;
      Object.defineProperty(viewer, "scrollHeight", { configurable: true, get: () => scrollHeight });
      Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 200 });

      viewer.scrollTop = 800;
      fireEvent.scroll(viewer);
      scrollHeight = 1400;
      rerender(<AgentLogViewer entries={[{ ...streamingEntry, text: "streaming output grows in place" }]} loading={false} />);

      await waitFor(() => expect(viewer.scrollTop).toBe(1400));
    });

    it("re-pins to bottom on resize while following", () => {
      const resizeCallbacks: Array<() => void> = [];
      const originalResizeObserver = globalThis.ResizeObserver;

      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver));
        }

        observe() {}
        unobserve() {}
        disconnect() {}
      }

      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: ResizeObserverMock,
      });

      try {
        const entries = [
          makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
          makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
        ];
        const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
        const viewer = getScrollContainer(container);

        Object.defineProperty(viewer, "scrollHeight", { configurable: true, value: 1200 });
        Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 200 });
        viewer.scrollTop = 980;
        fireEvent.scroll(viewer);

        viewer.scrollTop = 640;
        resizeCallbacks.forEach((callback) => callback());

        expect(viewer.scrollTop).toBe(1200);
      } finally {
        if (originalResizeObserver) {
          Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            value: originalResizeObserver,
          });
        } else {
          delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
        }
      }
    });
  });

  describe("pagination placement", () => {
    it("renders the load-more control above the first log entry", () => {
      const entries = [
        makeEntry({ text: "oldest", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "newest", timestamp: "2026-01-01T00:00:01Z" }),
      ];

      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          hasMore={true}
          onLoadMore={() => {}}
        />,
      );

      const loadMore = screen.getByTestId("agent-log-load-more");
      const firstRow = container.querySelector(".agent-log-text") as HTMLElement;
      expect(firstRow).toBeTruthy();

      expect(loadMore.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
