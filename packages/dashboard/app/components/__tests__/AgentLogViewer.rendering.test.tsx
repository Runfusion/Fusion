import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentLogViewer } from "../AgentLogViewer";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
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

  it("shows loading message when loading with no entries", () => {
    render(<AgentLogViewer entries={[]} loading={true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agent logs…");
    expect(screen.queryByText("No agent output yet.")).toBeNull();
  });

  it("shows empty message when no entries and not loading", () => {
    render(<AgentLogViewer entries={[]} loading={false} />);
    expect(screen.getByText("No agent output yet.")).toBeTruthy();
  });

  it("rerenders from empty state to populated logs without changing hook order", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = makeEntry({ text: "streamed chunk" });
    const { rerender } = render(<AgentLogViewer entries={[]} loading={false} />);

    expect(() => {
      rerender(<AgentLogViewer entries={[entry]} loading={false} />);
    }).not.toThrow();

    expect(screen.getByText("streamed chunk")).toBeTruthy();
    consoleErrorSpy.mockRestore();
  });

  it("renders grouped text entries in chronological order (oldest first)", () => {
    const entries = [
      makeEntry({ text: "first chunk", agent: "executor" }),
      makeEntry({ text: " second chunk", agent: "executor" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const textSpans = container.querySelectorAll(".agent-log-text");
    expect(textSpans).toHaveLength(1);
    expect(textSpans[0].textContent).toContain("first chunk second chunk");
  });

  it("preserves just now output for future timestamps", () => {
    const futureTimestamp = new Date(Date.now() + 30_000).toISOString();

    render(<AgentLogViewer entries={[makeEntry({ timestamp: futureTimestamp, agent: "executor" })]} loading={false} />);

    expect(screen.getByTestId("agent-log-timestamp")).toHaveTextContent("just now");
  });

  it("keeps existing DOM rows stable when a new live entry appears at the bottom", () => {
    const initialEntries = [
      makeEntry({ text: "first chunk", timestamp: "2026-01-01T00:00:00Z", agent: "triage" }),
      makeEntry({ text: "second chunk", timestamp: "2026-01-01T00:00:01Z", agent: "executor" }),
    ];

    const { container, rerender } = render(
      <AgentLogViewer entries={initialEntries} loading={false} />,
    );

    const initialTextRows = container.querySelectorAll(".agent-log-text");
    const firstChunkNode = initialTextRows[0] as HTMLElement;
    const secondChunkNode = initialTextRows[1] as HTMLElement;
    expect(firstChunkNode.textContent).toContain("first chunk");
    expect(secondChunkNode.textContent).toContain("second chunk");

    const withLiveUpdate = [
      ...initialEntries,
      makeEntry({ text: "third chunk", timestamp: "2026-01-01T00:00:02Z", agent: "reviewer" }),
    ];

    rerender(<AgentLogViewer entries={withLiveUpdate} loading={false} />);

    const updatedTextRows = container.querySelectorAll(".agent-log-text");
    expect(updatedTextRows).toHaveLength(3);
    expect(updatedTextRows[0].textContent).toContain("first chunk");
    expect(updatedTextRows[1].textContent).toContain("second chunk");
    expect(updatedTextRows[2].textContent).toContain("third chunk");
    expect(updatedTextRows[0]).toBe(firstChunkNode);
    expect(updatedTextRows[1]).toBe(secondChunkNode);
  });

  it("avoids duplicate-key collisions when entries are exact duplicates", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const duplicateEntry = makeEntry({
      timestamp: "2026-01-01T00:00:00Z",
      taskId: "FN-001",
      text: "same chunk",
      type: "text",
      agent: "executor",
      detail: "same detail",
    });

    const { container, rerender } = render(
      <AgentLogViewer entries={[duplicateEntry, { ...duplicateEntry }]} loading={false} />,
    );

    rerender(
      <AgentLogViewer
        entries={[duplicateEntry, { ...duplicateEntry }, { ...duplicateEntry }]}
        loading={false}
      />,
    );

    expect(container.querySelectorAll(".agent-log-text")).toHaveLength(1);
    expect(
      consoleErrorSpy.mock.calls.some((call) =>
        String(call[0]).includes("Encountered two children with the same key"),
      ),
    ).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("renders file paths in plain log lines as clickable file-browser links", async () => {
    const openFile = vi.fn();
    render(
      <FileBrowserProvider openFile={openFile}>
        <AgentLogViewer entries={[makeEntry({ text: "writing packages/engine/src/scheduler.ts" })]} loading={false} />
      </FileBrowserProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "packages/engine/src/scheduler.ts" }));
    expect(openFile).toHaveBeenCalledWith("packages/engine/src/scheduler.ts", { line: undefined, col: undefined });
  });

  it("renders compact timing labels and omits them for legacy entries", () => {
    const entries = [
      makeEntry({ text: "first token", type: "text", timeToFirstTokenMs: 1200, agent: "executor" }),
      makeEntry({ text: "legacy", type: "text", timestamp: "2026-01-01T00:00:01Z", agent: "reviewer" }),
      makeEntry({ text: "Bash", type: "tool_result", durationMs: 842, timestamp: "2026-01-01T00:00:02Z" }),
    ];

    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);

    expect(screen.getByText("TTFT 1.2s")).toBeInTheDocument();
    expect(screen.getByText("Duration 842ms")).toBeInTheDocument();
    expect(container.querySelectorAll(".agent-log-timing-label")).toHaveLength(2);
  });

  it("keeps timing labels stable for duplicate entries", () => {
    const duplicateEntry = makeEntry({ text: "Bash", type: "tool_result", durationMs: 25, timestamp: "2026-01-01T00:00:00Z" });
    const { container, rerender } = render(<AgentLogViewer entries={[duplicateEntry, { ...duplicateEntry }]} loading={false} />);

    rerender(<AgentLogViewer entries={[duplicateEntry, { ...duplicateEntry }, { ...duplicateEntry }]} loading={false} />);

    expect(screen.getAllByText("Duration 25ms")).toHaveLength(3);
    expect(container.querySelectorAll(".agent-log-tool-result")).toHaveLength(3);
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

  it("renders a mix of text and tool entries in chronological order", () => {
    const entries = [
      makeEntry({ text: "Starting...", type: "text" }),
      makeEntry({ text: "Bash", type: "tool" }),
      makeEntry({ text: "Done!", type: "text" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const textSpans = container.querySelectorAll(".agent-log-text");
    expect(textSpans).toHaveLength(2);
    expect(textSpans[0].textContent).toContain("Starting...");
    expect(textSpans[1].textContent).toContain("Done!");

    const toolDivs = container.querySelectorAll(".agent-log-tool");
    expect(toolDivs).toHaveLength(1);
  });

  describe("entry grouping", () => {
    it("groups consecutive text entries from the same agent into one container", () => {
      const entries = [
        makeEntry({ text: "hello", agent: "executor" }),
        makeEntry({ text: " world", agent: "executor" }),
        makeEntry({ text: "!", agent: "executor" }),
      ];

      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textRows = container.querySelectorAll(".agent-log-text");
      expect(textRows).toHaveLength(1);
      expect(textRows[0].textContent).toContain("hello world!");
    });

    it("groups consecutive thinking entries from the same agent into one container", () => {
      const entries = [
        makeEntry({ text: "think", type: "thinking", agent: "triage" }),
        makeEntry({ text: "ing", type: "thinking", agent: "triage" }),
      ];

      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const thinkingRows = container.querySelectorAll(".agent-log-thinking");
      expect(thinkingRows).toHaveLength(1);
      expect(thinkingRows[0].textContent).toContain("thinking");
    });

    it("does not group text across tool entries", () => {
      const entries = [
        makeEntry({ text: "part 1", type: "text", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: " part 2", type: "text", agent: "executor" }),
      ];

      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      expect(container.querySelectorAll(".agent-log-text")).toHaveLength(2);
      expect(container.querySelectorAll(".agent-log-tool")).toHaveLength(1);
    });

    it("does not group text entries from different agents", () => {
      const entries = [
        makeEntry({ text: "triage", agent: "triage" }),
        makeEntry({ text: "executor", agent: "executor" }),
      ];

      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      expect(container.querySelectorAll(".agent-log-text")).toHaveLength(2);
    });

    it("does not group entries across text and thinking type boundaries", () => {
      const entries = [
        makeEntry({ text: "text", type: "text", agent: "executor" }),
        makeEntry({ text: "thought", type: "thinking", agent: "executor" }),
      ];

      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      expect(container.querySelectorAll(".agent-log-text")).toHaveLength(1);
      expect(container.querySelectorAll(".agent-log-thinking")).toHaveLength(1);
    });

    it("shows badge and timestamp only once at the start of a grouped text run", () => {
      const entries = [
        makeEntry({ text: "a", type: "text", agent: "executor", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "b", type: "text", agent: "executor", timestamp: "2026-01-01T00:00:01Z" }),
      ];

      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      expect(container.querySelectorAll(".agent-log-agent-badge")).toHaveLength(1);
      expect(container.querySelectorAll(".agent-log-timestamp")).toHaveLength(1);
    });
  });

  it("renders tool entry detail toggle collapsed by default when detail is present", () => {
    const entries = [
      makeEntry({ text: "Bash", type: "tool", detail: "ls -la packages/" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} />);

    const toggle = screen.getByTestId("tool-detail-toggle");
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const content = screen.getByTestId("tool-detail-content");
    expect(content.classList.contains("agent-log-tool-detail-content--collapsed")).toBe(true);
  });

  it("does not render detail toggle when detail is absent", () => {
    const entries = [
      makeEntry({ text: "Bash", type: "tool" }),
      makeEntry({ text: "Bash", type: "tool_result" }),
      makeEntry({ text: "Bash", type: "tool_error" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} />);
    expect(screen.queryByTestId("tool-detail-toggle")).toBeNull();
  });

  it("renders long detail text without breaking layout", () => {
    const longDetail = "a/very/long/path/".repeat(10) + "file.ts";
    const entries = [
      makeEntry({ text: "Read", type: "tool", detail: longDetail }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    fireEvent.click(screen.getByTestId("tool-detail-toggle"));
    const detail = container.querySelector(".agent-log-tool-detail");
    expect(detail).toBeTruthy();
    expect(detail!.textContent).toContain(longDetail);
    // Verify the tool div still renders correctly
    const toolDiv = container.querySelector(".agent-log-tool");
    expect(toolDiv).toBeTruthy();
  });

  it("collapses tool-like detail by default across tool, tool_result, and tool_error", () => {
    const entries = [
      makeEntry({ text: "Read", type: "tool", detail: "tool output" }),
      makeEntry({ text: "Done", type: "tool_result", detail: "result output" }),
      makeEntry({ text: "Oops", type: "tool_error", detail: "error output" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} />);

    const toggles = screen.getAllByTestId("tool-detail-toggle");
    expect(toggles).toHaveLength(3);
    const contents = screen.getAllByTestId("tool-detail-content");
    expect(contents).toHaveLength(3);
    for (const content of contents) {
      expect(content.classList.contains("agent-log-tool-detail-content--collapsed")).toBe(true);
    }
  });

  it("expands and collapses tool detail on toggle click", () => {
    const entries = [
      makeEntry({ text: "Bash", type: "tool", detail: "line 1\nline 2" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} />);

    const toggle = screen.getByTestId("tool-detail-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const content = screen.getByTestId("tool-detail-content");
    expect(content.textContent).toContain("line 1");
    expect(content.classList.contains("agent-log-tool-detail-content--collapsed")).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.classList.contains("agent-log-tool-detail-content--collapsed")).toBe(true);
  });

  it("keeps identical failed-tool disclosures independent and renders error markup as inert text", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    const detail = "Error: edit failed\n<script>alert('inert')</script>\n  at edit (tools.ts:12:4)";
    const entries = [
      makeEntry({ text: "edit", type: "tool_error", detail, timestamp: "2026-01-01T00:00:00Z" }),
      makeEntry({ text: "edit", type: "tool_error", detail, timestamp: "2026-01-01T00:00:00Z" }),
      makeEntry({ text: "edit", type: "tool_error", detail, timestamp: "2026-01-01T00:00:00Z" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);

    const toggles = screen.getAllByTestId("tool-detail-toggle");
    expect(toggles).toHaveLength(3);
    expect(toggles[0]).toHaveAccessibleName("Show output (3 lines)");
    expect(toggles[0]).toBeEnabled();
    fireEvent.click(toggles[0]);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "true");
    expect(toggles[1]).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggles[1]);
    expect(toggles[1]).toHaveAttribute("aria-expanded", "true");
    expect(toggles[2]).toHaveAttribute("aria-expanded", "false");
    const expandedDetails = screen.getAllByTestId("tool-detail-content").filter(
      (content) => !content.classList.contains("agent-log-tool-detail-content--collapsed"),
    );
    expect(expandedDetails).toHaveLength(2);
    expect(expandedDetails[0]).toHaveTextContent("<script>alert('inert')</script>");
    expect(expandedDetails[1]).toHaveTextContent("<script>alert('inert')</script>");
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows complete long tool output after expanding the output disclosure", () => {
    const longDetail = `first line\n${"output ".repeat(45)}AGENT_LOG_RESULT_SUFFIX`;
    render(<AgentLogViewer entries={[makeEntry({ text: "Bash", type: "tool_result", detail: longDetail })]} loading={false} />);

    fireEvent.click(screen.getByTestId("tool-detail-toggle"));
    expect(screen.getByTestId("tool-detail-content")).toHaveTextContent("AGENT_LOG_RESULT_SUFFIX");
  });

  it("applies the viewer styling via the agent-log-viewer class", () => {
    const entries = [makeEntry()];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
    expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
    // Theme/layout styles come from CSS classes, not inline style attributes.
    expect(viewer.style.fontFamily).toBe("");
  });

  describe("agent badge deduplication", () => {
    it("shows badge only on the first (oldest) of consecutive text entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "chunk 1", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 2", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 3", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(1);
      // In chronological order, the oldest (chunk 1) gets the badge
      expect(badges[0].textContent).toBe("[executor]");
    });

    it("shows badge on each agent transition in chronological order", () => {
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "triage" }),
        makeEntry({ text: "world", type: "text", agent: "triage" }),
        makeEntry({ text: "starting", type: "text", agent: "executor" }),
        makeEntry({ text: "done", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(2);
      expect(badges[0].textContent).toBe("[Plan]");
      expect(badges[1].textContent).toBe("[executor]");
    });

    it("shows badge on text, tool, and text-after-tool (same agent, type change) in chronological order", () => {
      const entries = [
        makeEntry({ text: "reading...", type: "text", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: "got it", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      // Chronological: reading... (text), Read (tool), got it (text)
      // Badge on reading... (i=0), Read (always block-level), got it (type changed from tool)
      expect(badges).toHaveLength(3);
    });

    it("shows badge only on the first (oldest) of consecutive thinking entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "hmm", type: "thinking", agent: "triage" }),
        makeEntry({ text: "let me think", type: "thinking", agent: "triage" }),
        makeEntry({ text: "ok", type: "thinking", agent: "triage" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(1);
      // In chronological order, the oldest (hmm) gets the badge
      expect(badges[0].textContent).toBe("[Plan]");
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

});
