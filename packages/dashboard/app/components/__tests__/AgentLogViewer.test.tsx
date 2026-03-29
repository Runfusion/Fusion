import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentLogViewer } from "../AgentLogViewer";
import type { AgentLogEntry } from "@kb/core";

function makeEntry(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    taskId: "KB-001",
    text: "Hello world",
    type: "text",
    ...overrides,
  };
}

describe("AgentLogViewer", () => {
  it("shows loading message when loading with no entries", () => {
    render(<AgentLogViewer entries={[]} loading={true} />);
    expect(screen.getByText("Loading agent logs…")).toBeTruthy();
  });

  it("shows empty message when no entries and not loading", () => {
    render(<AgentLogViewer entries={[]} loading={false} />);
    expect(screen.getByText("No agent output yet.")).toBeTruthy();
  });

  it("renders text entries as spans", () => {
    const entries = [
      makeEntry({ text: "first chunk" }),
      makeEntry({ text: "second chunk" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const textSpans = container.querySelectorAll(".agent-log-text");
    expect(textSpans).toHaveLength(2);
    expect(textSpans[0].textContent).toBe("first chunk");
    expect(textSpans[1].textContent).toBe("second chunk");
  });

  it("renders tool entries with distinct styling", () => {
    const entries = [
      makeEntry({ text: "Read", type: "tool" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const toolDiv = container.querySelector(".agent-log-tool");
    expect(toolDiv).toBeTruthy();
    expect(toolDiv!.textContent).toContain("Read");
  });

  it("renders a mix of text and tool entries", () => {
    const entries = [
      makeEntry({ text: "Starting...", type: "text" }),
      makeEntry({ text: "Bash", type: "tool" }),
      makeEntry({ text: "Done!", type: "text" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    expect(container.querySelectorAll(".agent-log-text")).toHaveLength(2);
    expect(container.querySelectorAll(".agent-log-tool")).toHaveLength(1);
  });

  it("renders tool entry detail when present", () => {
    const entries = [
      makeEntry({ text: "Bash", type: "tool", detail: "ls -la packages/" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const detail = container.querySelector(".agent-log-tool-detail");
    expect(detail).toBeTruthy();
    expect(detail!.textContent).toContain("ls -la packages/");
  });

  it("does not render detail span when detail is absent", () => {
    const entries = [
      makeEntry({ text: "Bash", type: "tool" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const detail = container.querySelector(".agent-log-tool-detail");
    expect(detail).toBeNull();
  });

  it("renders long detail text without breaking layout", () => {
    const longDetail = "a/very/long/path/".repeat(10) + "file.ts";
    const entries = [
      makeEntry({ text: "Read", type: "tool", detail: longDetail }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const detail = container.querySelector(".agent-log-tool-detail");
    expect(detail).toBeTruthy();
    expect(detail!.textContent).toContain(longDetail);
    // Verify the tool div still renders correctly
    const toolDiv = container.querySelector(".agent-log-tool");
    expect(toolDiv).toBeTruthy();
  });

  it("has a monospace font family", () => {
    const entries = [makeEntry()];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
    expect(viewer.style.fontFamily).toBe("monospace");
  });

  it("auto-scrolls to the bottom by default when entries are present", () => {
    const entries = [makeEntry({ text: "line 1" }), makeEntry({ text: "line 2" })];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
    // After render with autoScroll=true, scrollTop should be set to scrollHeight
    expect(viewer.scrollTop).toBe(viewer.scrollHeight);
  });

  it("disables auto-scroll when user scrolls away from bottom", () => {
    const entries = [makeEntry({ text: "line 1" })];
    const { container, rerender } = render(
      <AgentLogViewer entries={entries} loading={false} />,
    );
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;

    // Simulate a container with content taller than viewport
    Object.defineProperty(viewer, "scrollHeight", { value: 1000, writable: true, configurable: true });
    Object.defineProperty(viewer, "clientHeight", { value: 500, writable: true, configurable: true });
    // User is scrolled far from bottom
    Object.defineProperty(viewer, "scrollTop", { value: 100, writable: true, configurable: true });
    fireEvent.scroll(viewer);

    // Re-render with new entries — auto-scroll should be disabled, so scrollTop stays
    const newEntries = [...entries, makeEntry({ text: "line 2" })];
    rerender(<AgentLogViewer entries={newEntries} loading={false} />);

    // scrollTop should remain at 100, not jump to scrollHeight
    expect(viewer.scrollTop).toBe(100);
  });

  it("re-enables auto-scroll when user scrolls to near the bottom", () => {
    const entries = [makeEntry({ text: "line 1" })];
    const { container, rerender } = render(
      <AgentLogViewer entries={entries} loading={false} />,
    );
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;

    // First scroll away from bottom to disable auto-scroll
    Object.defineProperty(viewer, "scrollHeight", { value: 1000, writable: true, configurable: true });
    Object.defineProperty(viewer, "clientHeight", { value: 500, writable: true, configurable: true });
    Object.defineProperty(viewer, "scrollTop", { value: 100, writable: true, configurable: true });
    fireEvent.scroll(viewer);

    // Now scroll to near the bottom (within threshold of 40px)
    Object.defineProperty(viewer, "scrollTop", { value: 480, writable: true, configurable: true });
    fireEvent.scroll(viewer);

    // Re-render with new entries — auto-scroll should be re-enabled
    const newEntries = [...entries, makeEntry({ text: "line 2" })];
    rerender(<AgentLogViewer entries={newEntries} loading={false} />);

    // scrollTop should jump to scrollHeight since auto-scroll is re-enabled
    expect(viewer.scrollTop).toBe(viewer.scrollHeight);
  });

  it("does NOT re-enable auto-scroll when user scrolls down but not near bottom", () => {
    const entries = [makeEntry({ text: "line 1" })];
    const { container, rerender } = render(
      <AgentLogViewer entries={entries} loading={false} />,
    );
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;

    // Container with scrollable content
    Object.defineProperty(viewer, "scrollHeight", { value: 1000, writable: true, configurable: true });
    Object.defineProperty(viewer, "clientHeight", { value: 500, writable: true, configurable: true });

    // User scrolls partway down — not near bottom
    Object.defineProperty(viewer, "scrollTop", { value: 200, writable: true, configurable: true });
    fireEvent.scroll(viewer);

    // Re-render with new entries — auto-scroll should stay disabled
    const newEntries = [...entries, makeEntry({ text: "line 2" })];
    rerender(<AgentLogViewer entries={newEntries} loading={false} />);

    // scrollTop should remain where user left it
    expect(viewer.scrollTop).toBe(200);
  });

  describe("agent badge deduplication", () => {
    it("shows badge only on the first of consecutive text entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "chunk 1", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 2", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 3", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(1);
      expect(badges[0].textContent).toBe("[executor]");
    });

    it("shows badge on each agent transition for consecutive text entries", () => {
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "triage" }),
        makeEntry({ text: "world", type: "text", agent: "triage" }),
        makeEntry({ text: "starting", type: "text", agent: "executor" }),
        makeEntry({ text: "done", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(2);
      expect(badges[0].textContent).toBe("[triage]");
      expect(badges[1].textContent).toBe("[executor]");
    });

    it("shows badge on text, tool, and text-after-tool (same agent, type change)", () => {
      const entries = [
        makeEntry({ text: "reading...", type: "text", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: "got it", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      // Badge on first text, on the tool (always), and on the text after tool (type changed)
      expect(badges).toHaveLength(3);
    });

    it("shows badge only on the first of consecutive thinking entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "hmm", type: "thinking", agent: "triage" }),
        makeEntry({ text: "let me think", type: "thinking", agent: "triage" }),
        makeEntry({ text: "ok", type: "thinking", agent: "triage" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(1);
      expect(badges[0].textContent).toBe("[triage]");
    });

    it("always shows badge on tool entries regardless of surrounding entries", () => {
      const entries = [
        makeEntry({ text: "Bash", type: "tool", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: "Write", type: "tool", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(3);
    });

    it("always shows badge on tool_result and tool_error entries", () => {
      const entries = [
        makeEntry({ text: "Bash", type: "tool", agent: "executor" }),
        makeEntry({ text: "ok", type: "tool_result", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: "not found", type: "tool_error", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(4);
    });

    it("produces no badges when entries have no agent field", () => {
      const entries = [
        makeEntry({ text: "legacy chunk 1", type: "text" }),
        makeEntry({ text: "legacy chunk 2", type: "text" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(0);
    });
  });

  it("enables auto-scroll when user is exactly at the bottom", () => {
    const entries = [makeEntry({ text: "line 1" })];
    const { container, rerender } = render(
      <AgentLogViewer entries={entries} loading={false} />,
    );
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;

    // Container at exact bottom: scrollTop + clientHeight === scrollHeight
    Object.defineProperty(viewer, "scrollHeight", { value: 1000, writable: true, configurable: true });
    Object.defineProperty(viewer, "clientHeight", { value: 500, writable: true, configurable: true });
    Object.defineProperty(viewer, "scrollTop", { value: 500, writable: true, configurable: true });
    fireEvent.scroll(viewer);

    // Re-render with new entries — auto-scroll should be enabled
    const newEntries = [...entries, makeEntry({ text: "line 2" })];
    rerender(<AgentLogViewer entries={newEntries} loading={false} />);

    // scrollTop should jump to scrollHeight
    expect(viewer.scrollTop).toBe(viewer.scrollHeight);
  });
});
