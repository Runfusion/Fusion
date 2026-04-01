import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentLogViewer } from "../AgentLogViewer";
import type { AgentLogEntry } from "@fusion/core";

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
    expect(textSpans[0].textContent).toBe("second chunk");
    expect(textSpans[1].textContent).toBe("first chunk");
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
    expect(textSpans[0].textContent).toBe("Done!");
    expect(textSpans[1].textContent).toBe("Starting...");

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

  it("has a monospace font family", () => {
    const entries = [makeEntry()];
    const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
    const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLElement;
    expect(viewer.style.fontFamily).toBe("monospace");
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
  });

  describe("auto-scroll behavior", () => {
    it("scrolls to top when new entries arrive and user is near the top", () => {
      const { rerender, container } = render(<AgentLogViewer entries={[makeEntry({ text: "first" })]} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLDivElement;
      
      // Simulate user being at the top
      viewer.scrollTop = 0;
      
      // Add a new entry
      rerender(<AgentLogViewer entries={[makeEntry({ text: "second" }), makeEntry({ text: "first" })]} loading={false} />);
      
      // Should have scrolled to top (newest first)
      expect(viewer.scrollTop).toBe(0);
    });

    it("does not auto-scroll when user has scrolled down", () => {
      const { rerender, container } = render(<AgentLogViewer entries={[makeEntry({ text: "first" })]} loading={false} />);
      const viewer = container.querySelector("[data-testid='agent-log-viewer']") as HTMLDivElement;
      
      // Simulate user scrolling down past the threshold
      Object.defineProperty(viewer, 'scrollTop', { value: 100, writable: true });
      
      // Add a new entry
      rerender(<AgentLogViewer entries={[makeEntry({ text: "second" }), makeEntry({ text: "first" })]} loading={false} />);
      
      // Should not have scrolled (scrollTop should remain 100)
      expect(viewer.scrollTop).toBe(100);
    });
  });
});
