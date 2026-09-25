import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  Sparkles: () => null,
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

  it("renders one attributed disclosure for a grouped executor response with a runtime marker", () => {
    const entries = [
      makeEntry({ type: "status", text: "Executor using model: anthropic/claude-opus-4-1", agent: "executor" }),
      makeEntry({ text: "first chunk", agent: "executor" }),
      makeEntry({ text: " second chunk", agent: "executor" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} executorModel={{ provider: "openai", modelId: "gpt-4o" }} />);

    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveAttribute("data-ai-provider", "anthropic");
    expect(notes[0]).toHaveAttribute("data-ai-model", "claude-opus-4-1");
  });

  it("stays provider-agnostic when historic log provenance is missing even if the current executor model is set", () => {
    const entries = [
      makeEntry({ text: "first chunk", agent: "executor" }),
      makeEntry({ text: " second chunk", agent: "executor" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} executorModel={{ provider: "anthropic", modelId: "claude-opus-4-1" }} />);

    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveAttribute("data-ai-attribution", "provider-agnostic");
    expect(notes[0]).not.toHaveAttribute("data-ai-provider");
  });

  it("splits grouped historic output at a model-A-to-model-B runtime marker change", () => {
    const entries = [
      makeEntry({ type: "status", text: "Executor using model: anthropic/claude-opus-4-1", agent: "executor", timestamp: "2026-01-01T00:00:00Z" }),
      makeEntry({ text: "output from A", agent: "executor", timestamp: "2026-01-01T00:00:01Z" }),
      makeEntry({ type: "status", text: "Executor using model: openai/gpt-4o", agent: "executor", timestamp: "2026-01-01T00:00:02Z" }),
      makeEntry({ text: "output from B", agent: "executor", timestamp: "2026-01-01T00:00:03Z" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} executorModel={{ provider: "google", modelId: "gemini-pro" }} />);

    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveAttribute("data-ai-provider", "anthropic");
    expect(notes[0]).toHaveAttribute("data-ai-model", "claude-opus-4-1");
    expect(notes[1]).toHaveAttribute("data-ai-provider", "openai");
    expect(notes[1]).toHaveAttribute("data-ai-model", "gpt-4o");
    expect(screen.getByText("output from A")).toBeTruthy();
    expect(screen.getByText("output from B")).toBeTruthy();
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

  it("renders tool payloads visibly without interaction across tool, result, and error rows", () => {
    const entries = [
      makeEntry({ text: "fn_run_verification", type: "tool", detail: "command=pnpm lint, allowFullSuite=false" }),
      makeEntry({ text: "fn_run_verification", type: "tool_result", detail: "ok" }),
      makeEntry({ text: "fn_run_verification", type: "tool_error", detail: "permission denied" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} />);

    const contents = screen.getAllByTestId("tool-detail-content");
    expect(contents).toHaveLength(3);
    expect(contents[0]).toHaveTextContent("command=pnpm lint, allowFullSuite=false");
    expect(contents[1]).toHaveTextContent("ok");
    expect(contents[2]).toHaveTextContent("permission denied");
    for (const content of contents) {
      expect(content).toBeVisible();
      expect(content).not.toHaveClass("agent-log-tool-detail-content--preview");
    }
    expect(screen.queryByTestId("tool-detail-toggle")).toBeNull();
  });

  it("does not render detail shells or reveal controls when detail is absent", () => {
    const entries = [
      makeEntry({ text: "Bash", type: "tool" }),
      makeEntry({ text: "Bash", type: "tool_result" }),
      makeEntry({ text: "Bash", type: "tool_error" }),
    ];
    render(<AgentLogViewer entries={entries} loading={false} />);
    expect(screen.queryByTestId("tool-detail-toggle")).toBeNull();
    expect(screen.queryByTestId("tool-detail-content")).toBeNull();
  });

  it("previews overflowing detail visibly and expands the same content node", () => {
    const longDetail = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n");
    render(<AgentLogViewer entries={[makeEntry({ text: "Read", type: "tool", detail: longDetail })]} loading={false} />);

    const toggle = screen.getByTestId("tool-detail-toggle");
    const content = screen.getByTestId("tool-detail-content");
    expect(content).toBeVisible();
    expect(content).toHaveClass("agent-log-tool-detail-content--preview");
    expect(toggle).toHaveAccessibleName("Show more Arguments (7 lines)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(screen.getByTestId("tool-detail-content")).toBe(content);
    expect(content).toBeVisible();
    expect(content).not.toHaveClass("agent-log-tool-detail-content--preview");
    expect(toggle).toHaveAccessibleName("Show less Arguments");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("uses type-aware reveal labels for arguments, output, and errors", () => {
    const detail = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n");
    render(<AgentLogViewer entries={[
      makeEntry({ text: "Read", type: "tool", detail }),
      makeEntry({ text: "Read", type: "tool_result", detail }),
      makeEntry({ text: "Read", type: "tool_error", detail }),
    ]} loading={false} />);

    const toggles = screen.getAllByTestId("tool-detail-toggle");
    expect(toggles[0]).toHaveAccessibleName("Show more Arguments (7 lines)");
    expect(toggles[1]).toHaveAccessibleName("Show more Output (7 lines)");
    expect(toggles[2]).toHaveAccessibleName("Show more Error (7 lines)");
  });

  it("keeps identical failed-tool disclosures independent and renders error markup as inert text", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    const detail = [
      "Error: edit failed",
      "<script>alert('inert')</script>",
      "  at edit (tools.ts:12:4)",
      "line four",
      "line five",
      "line six",
      "line seven",
    ].join("\n");
    const entries = [
      makeEntry({ text: "edit", type: "tool_error", detail, timestamp: "2026-01-01T00:00:00Z" }),
      makeEntry({ text: "edit", type: "tool_error", detail, timestamp: "2026-01-01T00:00:00Z" }),
      makeEntry({ text: "edit", type: "tool_error", detail, timestamp: "2026-01-01T00:00:00Z" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);

    const toggles = screen.getAllByTestId("tool-detail-toggle");
    expect(toggles).toHaveLength(3);
    expect(toggles[0]).toHaveAccessibleName("Show more Error (7 lines)");
    fireEvent.click(toggles[0]);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "true");
    expect(toggles[1]).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggles[1]);
    expect(toggles[1]).toHaveAttribute("aria-expanded", "true");
    expect(toggles[2]).toHaveAttribute("aria-expanded", "false");
    const expandedDetails = screen.getAllByTestId("tool-detail-content").filter(
      (content) => !content.classList.contains("agent-log-tool-detail-content--preview"),
    );
    expect(expandedDetails).toHaveLength(2);
    expect(expandedDetails[0]).toHaveTextContent("<script>alert('inert')</script>");
    expect(expandedDetails[1]).toHaveTextContent("<script>alert('inert')</script>");
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows one host-opted missing-detail hint without claiming the current setting state", () => {
    const entries = [
      makeEntry({ text: "Read", type: "tool" }),
      makeEntry({ text: "Read", type: "tool_result" }),
      makeEntry({ text: "Read", type: "tool_error" }),
    ];
    const { rerender } = render(<AgentLogViewer entries={entries} loading={false} />);
    expect(screen.queryByTestId("agent-log-missing-detail-hint")).toBeNull();

    rerender(<AgentLogViewer entries={entries} loading={false} showMissingDetailHint />);
    expect(screen.getByTestId("agent-log-missing-detail-hint")).toHaveTextContent("may have been recorded while detail saving was disabled");

    rerender(<AgentLogViewer entries={entries.map((entry) => ({ ...entry, detail: "saved" }))} loading={false} showMissingDetailHint />);
    expect(screen.queryByTestId("agent-log-missing-detail-hint")).toBeNull();

    rerender(<AgentLogViewer entries={[makeEntry({ text: "Read", type: "tool_error" })]} loading={false} showMissingDetailHint />);
    expect(screen.queryByTestId("agent-log-missing-detail-hint")).toBeNull();
  });

  it("uses a tokenized visible preview clamp on desktop and mobile", () => {
    const css = readFileSync(resolve(__dirname, "../AgentLogViewer.css"), "utf8");
    const previewStart = css.indexOf(".agent-log-tool-detail-content--preview {");
    const previewRule = css.slice(previewStart, css.indexOf("}", previewStart) + 1);
    const mobileCss = css.slice(css.indexOf("@media (max-width: 768px)"));

    expect(previewRule).toContain("max-block-size");
    expect(previewRule).toContain("overflow: hidden");
    expect(previewRule).not.toContain("display: none");
    expect(css).not.toContain("agent-log-tool-detail-content--collapsed");
    expect(mobileCss).toContain(".agent-log-tool-detail-content--preview");
    expect(mobileCss).toContain("max-block-size");
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
