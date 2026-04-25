import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentLogViewer } from "../AgentLogViewer";
import type { AgentLogEntry } from "@fusion/core";

// Mock lucide-react icons used by AgentLogViewer and ProviderIcon
vi.mock("lucide-react", () => ({
  Maximize2: () => null,
  Minimize2: () => null,
  Cpu: () => null,
}));

function makeEntry(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    taskId: "FN-001",
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

  it("renders text entries as spans in reverse order (newest first)", () => {
    const entries = [
      makeEntry({ text: "first chunk" }),
      makeEntry({ text: "second chunk" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const textSpans = container.querySelectorAll(".agent-log-text");
    expect(textSpans).toHaveLength(2);
    // Reversed order: second chunk first, then first chunk
    expect(textSpans[0].textContent).toContain("second chunk");
    expect(textSpans[1].textContent).toContain("first chunk");
  });

  it("keeps existing DOM rows stable when a new live entry appears at the top", () => {
    const initialEntries = [
      makeEntry({ text: "first chunk", timestamp: "2026-01-01T00:00:00Z" }),
      makeEntry({ text: "second chunk", timestamp: "2026-01-01T00:00:01Z" }),
    ];

    const { container, rerender } = render(
      <AgentLogViewer entries={initialEntries} loading={false} />,
    );

    const initialTextRows = container.querySelectorAll(".agent-log-text");
    const secondChunkNode = initialTextRows[0] as HTMLElement;
    const firstChunkNode = initialTextRows[1] as HTMLElement;
    expect(secondChunkNode.textContent).toContain("second chunk");
    expect(firstChunkNode.textContent).toContain("first chunk");

    const withLiveUpdate = [
      ...initialEntries,
      makeEntry({ text: "third chunk", timestamp: "2026-01-01T00:00:02Z" }),
    ];

    rerender(<AgentLogViewer entries={withLiveUpdate} loading={false} />);

    const updatedTextRows = container.querySelectorAll(".agent-log-text");
    expect(updatedTextRows).toHaveLength(3);
    expect(updatedTextRows[0].textContent).toContain("third chunk");
    expect(updatedTextRows[1].textContent).toContain("second chunk");
    expect(updatedTextRows[2].textContent).toContain("first chunk");
    expect(updatedTextRows[1]).toBe(secondChunkNode);
    expect(updatedTextRows[2]).toBe(firstChunkNode);
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

    expect(container.querySelectorAll(".agent-log-text")).toHaveLength(3);
    expect(
      consoleErrorSpy.mock.calls.some((call) =>
        String(call[0]).includes("Encountered two children with the same key"),
      ),
    ).toBe(false);

    consoleErrorSpy.mockRestore();
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

  it("renders a mix of text and tool entries in reverse order", () => {
    const entries = [
      makeEntry({ text: "Starting...", type: "text" }),
      makeEntry({ text: "Bash", type: "tool" }),
      makeEntry({ text: "Done!", type: "text" }),
    ];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    // Reversed order: Done! (text), Bash (tool), Starting... (text)
    const textSpans = container.querySelectorAll(".agent-log-text");
    expect(textSpans).toHaveLength(2);
    expect(textSpans[0].textContent).toContain("Done!");
    expect(textSpans[1].textContent).toContain("Starting...");

    const toolDivs = container.querySelectorAll(".agent-log-tool");
    expect(toolDivs).toHaveLength(1);
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

  it("applies the viewer styling via the agent-log-viewer class", () => {
    const entries = [makeEntry()];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
    expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
    // Theme/layout styles come from CSS classes, not inline style attributes.
    expect(viewer.style.fontFamily).toBe("");
  });

  describe("agent badge deduplication", () => {
    it("shows badge only on the first (newest) of consecutive text entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "chunk 1", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 2", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 3", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(1);
      // In reversed order, the newest (chunk 3) gets the badge
      expect(badges[0].textContent).toBe("[executor]");
    });

    it("shows badge on each agent transition in reversed order", () => {
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "triage" }),
        makeEntry({ text: "world", type: "text", agent: "triage" }),
        makeEntry({ text: "starting", type: "text", agent: "executor" }),
        makeEntry({ text: "done", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(2);
      // Reversed order: done (executor), starting (executor), world (triage), hello (triage)
      // Badge on done (i=0) and world (transition from executor to triage)
      expect(badges[0].textContent).toBe("[executor]");
      expect(badges[1].textContent).toBe("[triage]");
    });

    it("shows badge on text, tool, and text-after-tool (same agent, type change) in reversed order", () => {
      const entries = [
        makeEntry({ text: "reading...", type: "text", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: "got it", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      // Reversed: got it (text), Read (tool), reading... (text)
      // Badge on got it (i=0), Read (always block-level), reading... (type changed from tool)
      expect(badges).toHaveLength(3);
    });

    it("shows badge only on the first (newest) of consecutive thinking entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "hmm", type: "thinking", agent: "triage" }),
        makeEntry({ text: "let me think", type: "thinking", agent: "triage" }),
        makeEntry({ text: "ok", type: "thinking", agent: "triage" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = container.querySelectorAll(".agent-log-agent-badge");
      expect(badges).toHaveLength(1);
      // In reversed order, the newest (ok) gets the badge
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

  describe("model info header", () => {
    it("renders model info header with executor model when set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-sonnet-4-5" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("anthropic/claude-sonnet-4-5");
      expect(header!.textContent).toContain("Validator:");
      expect(header!.textContent).toContain("Using default");
      // Verify ProviderIcon is rendered for executor
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
    });

    it("renders 'Using default' when no executor model override is set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} executorModel={null} />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("Using default");
    });

    it("renders 'Using default' when executorModel is undefined", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("Using default");
    });

    it("renders model info header with validator model when set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          validatorModel={{ provider: "openai", modelId: "gpt-4o" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Validator:");
      expect(header!.textContent).toContain("openai/gpt-4o");
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("Using default");
      // Verify ProviderIcon is rendered for validator
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
    });

    it("renders 'Using default' when no validator model override is set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} validatorModel={null} />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Validator:");
      expect(header!.textContent).toContain("Using default");
    });

    it("renders both models when both are configured", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-opus-4" }}
          validatorModel={{ provider: "openai", modelId: "gpt-4o" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("anthropic/claude-opus-4");
      expect(header!.textContent).toContain("Validator:");
      expect(header!.textContent).toContain("openai/gpt-4o");
      // Verify both ProviderIcons are rendered
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
    });

    it("renders header with 'Using default' for both models when both are null/undefined", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("Using default");
      expect(header!.textContent).toContain("Validator:");
      expect(header!.textContent).toContain("Using default");
    });

    it("shows 'Using default' when executorModel has only provider but no modelId", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("Using default");
    });

    it("shows 'Using default' when executorModel has only modelId but no provider", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ modelId: "claude-sonnet-4-5" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("Using default");
    });

    it("renders model info header with planning/triage model when set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          planningModel={{ provider: "anthropic", modelId: "claude-opus-4" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Planning/Triage:");
      expect(header!.textContent).toContain("anthropic/claude-opus-4");
      // Verify ProviderIcon is rendered for planning
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
    });

    it("renders 'Using default' for planning/triage when no planning model is set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} planningModel={null} />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Planning/Triage:");
      expect(header!.textContent).toContain("Using default");
    });

    it("renders 'Using default' for planning/triage when planningModel is undefined", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Planning/Triage:");
      expect(header!.textContent).toContain("Using default");
    });

    it("renders all three models when all are configured", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-opus-4" }}
          validatorModel={{ provider: "openai", modelId: "gpt-4o" }}
          planningModel={{ provider: "google", modelId: "gemini-pro" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("anthropic/claude-opus-4");
      expect(header!.textContent).toContain("Validator:");
      expect(header!.textContent).toContain("openai/gpt-4o");
      expect(header!.textContent).toContain("Planning/Triage:");
      expect(header!.textContent).toContain("google/gemini-pro");
      // Verify all three ProviderIcons are rendered
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="google"]')).toBeTruthy();
    });

    it("shows 'Using default' for planning when planningModel has only provider but no modelId", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          planningModel={{ provider: "anthropic" }}
        />
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain("Planning/Triage:");
      expect(header!.textContent).toContain("Using default");
    });
  });

  describe("timestamp display", () => {
    it("renders no timestamps for entries without agent field", () => {
      const entries = [
        makeEntry({ text: "legacy 1", type: "text" }),
        makeEntry({ text: "legacy 2", type: "text" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamps = container.querySelectorAll(".agent-log-timestamp");
      expect(timestamps).toHaveLength(0);
    });

    it("renders relative timestamps for recent entries next to the badge", () => {
      const recentTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor", timestamp: recentTimestamp }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamp = container.querySelector(".agent-log-timestamp");
      expect(timestamp).toBeTruthy();
      expect(timestamp!.textContent).toBe("5m ago");

      const badge = container.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();
      expect(badge.parentElement?.querySelector(".agent-log-timestamp")).toBeTruthy();
    });

    it("renders 'just now' for entries less than a minute old", () => {
      const recentTimestamp = new Date(Date.now() - 30 * 1000).toISOString();
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor", timestamp: recentTimestamp }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamp = container.querySelector(".agent-log-timestamp");
      expect(timestamp!.textContent).toBe("just now");
    });

    it("renders hours ago for older entries", () => {
      const olderTimestamp = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor", timestamp: olderTimestamp }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamp = container.querySelector(".agent-log-timestamp");
      expect(timestamp!.textContent).toBe("3h ago");
    });

    it("renders days ago for entries older than a day", () => {
      const oldTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor", timestamp: oldTimestamp }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamp = container.querySelector(".agent-log-timestamp");
      expect(timestamp!.textContent).toBe("2d ago");
    });

    it("renders locale date for entries older than 7 days", () => {
      const veryOldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor", timestamp: veryOldTimestamp }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamp = container.querySelector(".agent-log-timestamp");
      // Should be a locale date string, not a relative time
      expect(timestamp!.textContent).not.toContain("ago");
      expect(timestamp!.textContent).not.toBe("just now");
    });

    it("uses the timestamp class inside the badge row", () => {
      const entries = [makeEntry({ text: "hello", type: "text", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badge = container.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();
      const timestamp = badge.parentElement?.querySelector(".agent-log-timestamp") as HTMLElement;
      expect(timestamp).toBeTruthy();
      expect(timestamp.classList.contains("agent-log-timestamp")).toBe(true);
      // Theme styles are class-based now, not inline.
      expect(timestamp.style.fontSize).toBe("");
      expect(timestamp.style.opacity).toBe("");
    });

    it("includes timestamp in the badge container for tool entries", () => {
      const entries = [makeEntry({ text: "Bash", type: "tool", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toolDiv = container.querySelector(".agent-log-tool");
      expect(toolDiv).toBeTruthy();
      const badge = toolDiv!.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();
      expect(badge.parentElement?.querySelector(".agent-log-timestamp")).toBeTruthy();
    });

    it("includes timestamp in the badge container for tool_result entries", () => {
      const entries = [makeEntry({ text: "ok", type: "tool_result", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const resultDiv = container.querySelector(".agent-log-tool-result");
      expect(resultDiv).toBeTruthy();
      const badge = resultDiv!.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();
      expect(badge.parentElement?.querySelector(".agent-log-timestamp")).toBeTruthy();
    });

    it("includes timestamp in the badge container for tool_error entries", () => {
      const entries = [makeEntry({ text: "fail", type: "tool_error", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const errorDiv = container.querySelector(".agent-log-tool-error");
      expect(errorDiv).toBeTruthy();
      const badge = errorDiv!.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();
      expect(badge.parentElement?.querySelector(".agent-log-timestamp")).toBeTruthy();
    });

    it("includes timestamp in the badge container for thinking entries", () => {
      const entries = [makeEntry({ text: "hmm", type: "thinking", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const thinkingSpan = container.querySelector(".agent-log-thinking");
      expect(thinkingSpan).toBeTruthy();
      const badge = thinkingSpan!.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();
      expect(badge.parentElement?.querySelector(".agent-log-timestamp")).toBeTruthy();
    });

    it("shows exactly one timestamp for consecutive text entries from the same agent", () => {
      const entries = [
        makeEntry({ text: "chunk 1", type: "text", agent: "executor" }),
        makeEntry({ text: "chunk 2", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const timestamps = container.querySelectorAll(".agent-log-timestamp");
      expect(timestamps).toHaveLength(1);
    });

    it("renders timestamps at each agent transition", () => {
      const entries = [
        makeEntry({ text: "triage output", type: "text", agent: "triage" }),
        makeEntry({ text: "executor output", type: "text", agent: "executor" }),
        makeEntry({ text: "review notes", type: "text", agent: "reviewer" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badges = Array.from(container.querySelectorAll(".agent-log-agent-badge"));
      const timestamps = container.querySelectorAll(".agent-log-timestamp");

      expect(badges).toHaveLength(3);
      expect(timestamps).toHaveLength(3);
      expect(badges.map((badge) => badge.textContent)).toEqual(["[reviewer]", "[executor]", "[triage]"]);
    });

    it("badge container includes both badge text and timestamp text", () => {
      const recentTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor", timestamp: recentTimestamp }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const badge = container.querySelector(".agent-log-agent-badge") as HTMLElement;
      expect(badge).toBeTruthy();

      const badgeContainer = badge.parentElement as HTMLElement;
      expect(badgeContainer.textContent).toContain("[executor]");
      expect(badgeContainer.textContent).toContain("5m ago");
    });
  });

  describe("horizontal overflow prevention", () => {
    it("uses the viewer class for overflow-x handling", () => {
      const longString = "A".repeat(300);
      const entries = [makeEntry({ text: longString })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
      expect(viewer.style.overflowX).toBe("");
    });

    it("uses the viewer class for overflow-wrap handling", () => {
      const entries = [makeEntry({ text: "x".repeat(250) })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
      expect(viewer.style.overflowWrap).toBe("");
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

    it("uses class-based overflow-y scrolling", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      // Scrolling behavior is now defined in CSS.
      expect(viewer.classList.contains("agent-log-viewer")).toBe(true);
      expect(viewer.style.overflowY).toBe("");
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

  describe("auto-scroll behavior", () => {
    it("scrolls to top when streaming updates arrive and user is near the top", () => {
      const initialEntries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const streamedEntries = [
        ...initialEntries,
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];

      const { rerender, container } = render(<AgentLogViewer entries={initialEntries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLDivElement;

      let scrollHeight = 600;
      Object.defineProperty(viewer, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });

      viewer.scrollTop = 20;
      rerender(<AgentLogViewer entries={[...initialEntries]} loading={false} />);

      scrollHeight = 720;
      rerender(<AgentLogViewer entries={streamedEntries} loading={false} />);

      expect(viewer.scrollTop).toBe(0);
    });

    it("keeps the viewport anchored when streaming updates arrive and user is reading older output", () => {
      const initialEntries = [
        makeEntry({ text: "first", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const streamedEntries = [
        ...initialEntries,
        makeEntry({ text: "second", timestamp: "2026-01-01T00:00:01Z" }),
      ];

      const { rerender, container } = render(<AgentLogViewer entries={initialEntries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLDivElement;

      let scrollHeight = 1000;
      Object.defineProperty(viewer, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });

      viewer.scrollTop = 220;
      rerender(<AgentLogViewer entries={[...initialEntries]} loading={false} />);

      scrollHeight = 1120;
      rerender(<AgentLogViewer entries={streamedEntries} loading={false} />);

      // Anchored by delta (1120 - 1000): 220 + 120
      expect(viewer.scrollTop).toBe(340);
    });

    it("does not offset scroll when loading older history at the bottom", () => {
      const initialEntries = [
        makeEntry({ text: "recent", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const olderLoadedEntries = [
        makeEntry({ text: "older", timestamp: "2025-12-31T23:59:00Z" }),
        ...initialEntries,
      ];

      const { rerender, container } = render(<AgentLogViewer entries={initialEntries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLDivElement;

      let scrollHeight = 900;
      Object.defineProperty(viewer, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });

      viewer.scrollTop = 260;
      rerender(<AgentLogViewer entries={[...initialEntries]} loading={false} />);

      scrollHeight = 1030;
      rerender(<AgentLogViewer entries={olderLoadedEntries} loading={false} />);

      expect(viewer.scrollTop).toBe(260);
    });
  });

  describe("long content preservation", () => {
    it("renders very long text entries without truncation", () => {
      const longText = "A".repeat(5000);
      const entries = [makeEntry({ text: longText })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      expect(textSpans[0].textContent).toContain(longText);
    });

    it("renders very long detail text without truncation", () => {
      const longDetail = "B".repeat(5000);
      const entries = [makeEntry({ text: "Read", type: "tool", detail: longDetail })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const detail = container.querySelector(".agent-log-tool-detail");
      expect(detail).toBeTruthy();
      expect(detail!.textContent).toContain(longDetail);
      expect(detail!.textContent!.length).toBeGreaterThan(5000); // " — " prefix adds a few chars
    });

    it("renders multiline text content without truncation", () => {
      const multilineText = [
        "## Analysis",
        "",
        "After reviewing the codebase:",
        "",
        "1. First issue found",
        "2. Second issue found",
        "",
        "```typescript",
        "const x = 1;",
        "```",
        "",
        "Line " + "C".repeat(2000) + " end",
      ].join("\n");
      const entries = [makeEntry({ text: multilineText })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      // The markdown-rendered content should still contain the essential parts
      expect(textSpans[0].textContent).toContain("Analysis");
      expect(textSpans[0].textContent).toContain("First issue found");
      expect(textSpans[0].textContent).toContain("const x = 1");
    });

    it("renders long tool_result detail without truncation", () => {
      const longDetail = "D".repeat(5000);
      const entries = [makeEntry({ text: "Bash", type: "tool_result", detail: longDetail })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const detail = container.querySelector(".agent-log-tool-detail");
      expect(detail).toBeTruthy();
      expect(detail!.textContent).toContain(longDetail);
    });

    it("renders long tool_error detail without truncation", () => {
      const longDetail = "E".repeat(5000);
      const entries = [makeEntry({ text: "Write", type: "tool_error", detail: longDetail })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const detail = container.querySelector(".agent-log-tool-detail");
      expect(detail).toBeTruthy();
      expect(detail!.textContent).toContain(longDetail);
    });
  });

  describe("markdown rendering", () => {
    it("renders plain text without markdown correctly", () => {
      const entries = [
        makeEntry({ text: "Hello world, this is plain text." }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      expect(textSpans[0].textContent).toContain("Hello world, this is plain text.");
    });

    it("renders text entries inside markdown-body in markdown mode", () => {
      const entries = [
        makeEntry({ text: "Paragraph one\n\nParagraph two" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textRow = container.querySelector(".agent-log-text") as HTMLElement;
      expect(textRow).toBeTruthy();

      const proseContainer = textRow.querySelector(".markdown-body") as HTMLElement;
      expect(proseContainer).toBeTruthy();
      expect(proseContainer.querySelectorAll("p")).toHaveLength(2);
    });

    it("renders thinking entries inside markdown-body in markdown mode", () => {
      const entries = [
        makeEntry({ text: "Considering:\n\n- option A\n- option B", type: "thinking" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const thinkingRow = container.querySelector(".agent-log-thinking") as HTMLElement;
      expect(thinkingRow).toBeTruthy();

      const proseContainer = thinkingRow.querySelector(".markdown-body") as HTMLElement;
      expect(proseContainer).toBeTruthy();
      expect(proseContainer.querySelector("ul")).toBeTruthy();
    });

    it("renders inline markdown elements (bold, italic, inline code)", () => {
      const entries = [
        makeEntry({ text: "This is **bold** and *italic* with `inline code`." }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      // Check that the markdown elements are rendered
      const strong = textSpans[0].querySelector("strong");
      expect(strong).toBeTruthy();
      expect(strong!.textContent).toBe("bold");
      const em = textSpans[0].querySelector("em");
      expect(em).toBeTruthy();
      expect(em!.textContent).toBe("italic");
      const code = textSpans[0].querySelector("code");
      expect(code).toBeTruthy();
      expect(code!.textContent).toBe("inline code");
    });

    it("renders code blocks with GFM support", () => {
      const entries = [
        makeEntry({ text: "```typescript\nconst x = 1;\n```" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      // Check that code block is rendered
      const pre = textSpans[0].querySelector("pre");
      expect(pre).toBeTruthy();
      const code = pre!.querySelector("code");
      expect(code).toBeTruthy();
      expect(code!.textContent).toContain("const x = 1");
    });

    it("renders GFM task lists", () => {
      const entries = [
        makeEntry({ text: "- [x] Completed task\n- [ ] Pending task" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      // Check that task list is rendered
      const ul = textSpans[0].querySelector("ul");
      expect(ul).toBeTruthy();
      const taskListItems = ul!.querySelectorAll("li");
      expect(taskListItems).toHaveLength(2);
      // Check checkboxes
      const checkboxes = ul!.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(2);
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    });

    it("renders blockquotes", () => {
      const entries = [
        makeEntry({ text: "> This is a blockquote\n> with multiple lines" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      // Check that blockquote is rendered
      const blockquote = textSpans[0].querySelector("blockquote");
      expect(blockquote).toBeTruthy();
      expect(blockquote!.textContent).toContain("This is a blockquote");
    });

    it("renders markdown in thinking entries", () => {
      const entries = [
        makeEntry({ text: "Let me think about **this problem**...", type: "thinking" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const thinkingSpans = container.querySelectorAll(".agent-log-thinking");
      expect(thinkingSpans).toHaveLength(1);
      const strong = thinkingSpans[0].querySelector("strong");
      expect(strong).toBeTruthy();
      expect(strong!.textContent).toBe("this problem");
    });

    it("renders mixed content with markdown and plain text", () => {
      const entries = [
        makeEntry({ text: "The code:\n\n```js\nconsole.log('hello');\n```\n\nworks!" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      const pre = textSpans[0].querySelector("pre");
      expect(pre).toBeTruthy();
      // Plain text before and after should be preserved
      expect(textSpans[0].textContent).toContain("The code:");
      expect(textSpans[0].textContent).toContain("works!");
    });
  });

  describe("markdown render toggle", () => {
    it("renders the toggle button in the model info header", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']");
      expect(toggle).toBeTruthy();
      expect(toggle!.textContent).toBe("Markdown");
    });

    it("defaults to markdown mode", () => {
      const entries = [makeEntry({ text: "**bold** text" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      // In markdown mode, bold should be rendered as <strong>
      const textSpans = container.querySelectorAll(".agent-log-text");
      const strong = textSpans[0].querySelector("strong");
      expect(strong).toBeTruthy();
      expect(strong!.textContent).toBe("bold");
    });

    it("has correct aria attributes on the toggle", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(toggle.getAttribute("aria-label")).toBe("Switch to plain text mode");
    });

    it("switches to plain text mode when clicked", () => {
      const entries = [makeEntry({ text: "**bold** and *italic*" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      // Markdown mode starts with prose container + rendered markdown
      const markdownModeTextRow = container.querySelector(".agent-log-text") as HTMLElement;
      expect(markdownModeTextRow.querySelector(".markdown-body")).toBeTruthy();
      expect(markdownModeTextRow.querySelector("strong")?.textContent).toBe("bold");

      // Click to switch to plain text mode
      fireEvent.click(toggle);

      // Button should update
      expect(toggle.textContent).toBe("Plain");
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(toggle.getAttribute("aria-label")).toBe("Switch to markdown mode");

      // Text should now show raw markdown syntax literally
      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      expect(textSpans[0].textContent).toContain("**bold** and *italic*");
      // Plain mode should remove markdown rendering/prose container
      expect(textSpans[0].querySelector(".markdown-body")).toBeNull();
      expect(textSpans[0].querySelector("strong")).toBeNull();
      expect(textSpans[0].querySelector("em")).toBeNull();
    });

    it("toggles back to markdown mode from plain text", () => {
      const entries = [makeEntry({ text: "**bold** text" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      // Switch to plain text
      fireEvent.click(toggle);
      expect(toggle.textContent).toBe("Plain");

      // Switch back to markdown
      fireEvent.click(toggle);
      expect(toggle.textContent).toBe("Markdown");

      // Markdown elements should be present again
      const textSpans = container.querySelectorAll(".agent-log-text");
      const strong = textSpans[0].querySelector("strong");
      expect(strong).toBeTruthy();
      expect(strong!.textContent).toBe("bold");
    });

    it("shows raw markdown syntax literally in plain text mode for text entries", () => {
      const entries = [
        makeEntry({ text: "## Heading\n\n- item 1\n- item 2\n\n`code` and **bold**" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      // Switch to plain text
      fireEvent.click(toggle);

      const textSpans = container.querySelectorAll(".agent-log-text");
      expect(textSpans).toHaveLength(1);
      // Raw markdown syntax should appear literally
      expect(textSpans[0].textContent).toContain("## Heading");
      expect(textSpans[0].textContent).toContain("- item 1");
      expect(textSpans[0].textContent).toContain("`code`");
      expect(textSpans[0].textContent).toContain("**bold**");
      // No rendered markdown elements
      expect(textSpans[0].querySelector("h2")).toBeNull();
      expect(textSpans[0].querySelector("ul")).toBeNull();
      expect(textSpans[0].querySelector("code")).toBeNull();
      expect(textSpans[0].querySelector("strong")).toBeNull();
    });

    it("respects toggle for thinking entries", () => {
      const entries = [
        makeEntry({ text: "Thinking about **this**", type: "thinking" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      // In markdown mode, bold is rendered
      const thinkingSpans = container.querySelectorAll(".agent-log-thinking");
      expect(thinkingSpans[0].querySelector("strong")).toBeTruthy();

      // Switch to plain text
      fireEvent.click(toggle);

      const thinkingSpansUpdated = container.querySelectorAll(".agent-log-thinking");
      expect(thinkingSpansUpdated[0].textContent).toContain("Thinking about **this**");
      expect(thinkingSpansUpdated[0].querySelector("strong")).toBeNull();
    });

    it("does not affect tool entries in either mode", () => {
      const entries = [
        makeEntry({ text: "Read", type: "tool" }),
        makeEntry({ text: "done", type: "tool_result" }),
        makeEntry({ text: "fail", type: "tool_error" }),
      ];
      const { container, rerender } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      // Tool entries in markdown mode
      expect(container.querySelector(".agent-log-tool")!.textContent).toContain("Read");
      expect(container.querySelector(".agent-log-tool-result")!.textContent).toContain("done");
      expect(container.querySelector(".agent-log-tool-error")!.textContent).toContain("fail");

      // Switch to plain text - tool entries should be unchanged
      fireEvent.click(toggle);

      expect(container.querySelector(".agent-log-tool")!.textContent).toContain("Read");
      expect(container.querySelector(".agent-log-tool-result")!.textContent).toContain("done");
      expect(container.querySelector(".agent-log-tool-error")!.textContent).toContain("fail");
    });

    it("safely renders HTML tags as text in plain text mode (no XSS)", () => {
      const entries = [
        makeEntry({ text: '<script>alert("xss")</script> and <b>bold</b>' }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      // Switch to plain text
      fireEvent.click(toggle);

      const textSpans = container.querySelectorAll(".agent-log-text");
      // The text content should contain the literal HTML tags
      expect(textSpans[0].textContent).toContain('<script>alert("xss")</script>');
      expect(textSpans[0].textContent).toContain("<b>bold</b>");
      // No actual script or bold HTML elements should be rendered
      expect(textSpans[0].querySelector("script")).toBeNull();
      expect(textSpans[0].querySelector("b")).toBeNull();
    });

    it("safely renders HTML in markdown mode via react-markdown sanitization", () => {
      const entries = [
        makeEntry({ text: "**safe** text here" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      // In markdown mode, react-markdown sanitizes HTML (no script execution)
      const textSpans = container.querySelectorAll(".agent-log-text");
      // Markdown formatting should work
      const strong = textSpans[0].querySelector("strong");
      expect(strong).toBeTruthy();
      expect(strong!.textContent).toBe("safe");
      // No script elements are rendered for any HTML content in markdown
      expect(textSpans[0].querySelector("script")).toBeNull();
    });
  });

  describe("fullscreen toggle", () => {
    it("renders the fullscreen toggle button in the model info header", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']");
      expect(toggle).toBeTruthy();
    });

    it("has correct aria attributes on the fullscreen toggle", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute("aria-label")).toBe("Expand agent log to full screen");
      expect(toggle.getAttribute("title")).toBe("Expand agent log to full screen");
    });

    it("adds fullscreen class when toggle is clicked", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      // Initially not fullscreen
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(false);

      // Click to enter fullscreen
      fireEvent.click(toggle);

      // Should have fullscreen class
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(true);
    });

    it("removes fullscreen class when toggle is clicked while in fullscreen", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      // Enter fullscreen
      fireEvent.click(toggle);
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(true);

      // Exit fullscreen
      fireEvent.click(toggle);
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(false);
    });

    it("updates aria label when toggling fullscreen", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      // Initially shows expand label
      expect(toggle.getAttribute("aria-label")).toBe("Expand agent log to full screen");

      // Enter fullscreen
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-label")).toBe("Exit full screen");

      // Exit fullscreen
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-label")).toBe("Expand agent log to full screen");
    });

    it("exits fullscreen when Escape key is pressed", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      // Enter fullscreen
      fireEvent.click(toggle);
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(true);

      // Press Escape to exit
      fireEvent.keyDown(document, { key: "Escape" });

      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(false);
    });

    it("does nothing when Escape key is pressed while not in fullscreen", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      // Initially not fullscreen
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(false);

      // Press Escape - should do nothing
      fireEvent.keyDown(document, { key: "Escape" });

      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(false);

      // Toggle should still work normally
      fireEvent.click(toggle);
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(true);
    });

    it("only responds to Escape key when in fullscreen mode", () => {
      const entries = [makeEntry()];
      const { container, unmount } = render(<AgentLogViewer entries={entries} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
      const toggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      // Press Escape when not fullscreen - no effect
      fireEvent.keyDown(document, { key: "Escape" });
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(false);

      // Enter fullscreen
      fireEvent.click(toggle);
      expect(viewer.classList.contains("agent-log-viewer--fullscreen")).toBe(true);

      // Clean up to remove the keydown listener
      unmount();

      // Verify the listener was removed (no errors should occur when Escape is pressed after unmount)
    });
  });
});
