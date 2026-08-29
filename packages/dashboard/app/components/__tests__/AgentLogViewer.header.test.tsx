import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  describe("model info header", () => {
    it("renders model info header with executor model when set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-sonnet-4-5" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(header!.textContent).not.toContain("Executor:");

      fireEvent.click(screen.getByTestId("agent-log-model-expand"));
      expect(header!.textContent).toContain("Executor:");
      expect(header!.textContent).toContain("anthropic/claude-sonnet-4-5");
    });

    it("renders 'Using default' when no executor model override is set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} executorModel={null} />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("renders 'Using default' when executorModel is undefined", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("renders model info header with validator model when set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          validatorModel={{ provider: "openai", modelId: "gpt-4o" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
      expect(header!.textContent).not.toContain("Reviewer:");

      fireEvent.click(screen.getByTestId("agent-log-model-expand"));
      expect(header!.textContent).toContain("Reviewer:");
      expect(header!.textContent).toContain("openai/gpt-4o");
    });

    it("renders 'Using default' when no validator model override is set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} validatorModel={null} />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("renders both models when both are configured", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-opus-4" }}
          validatorModel={{ provider: "openai", modelId: "gpt-4o" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
      expect(header!.textContent).not.toContain("anthropic/claude-opus-4");
      expect(header!.textContent).not.toContain("openai/gpt-4o");

      fireEvent.click(screen.getByTestId("agent-log-model-expand"));
      expect(header!.textContent).toContain("anthropic/claude-opus-4");
      expect(header!.textContent).toContain("openai/gpt-4o");
    });

    it("renders header with 'Using default' for both models when both are null/undefined", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("shows 'Using default' when executorModel has only provider but no modelId", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("shows 'Using default' when executorModel has only modelId but no provider", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ modelId: "claude-sonnet-4-5" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("renders model info header with planning model when set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          planningModel={{ provider: "anthropic", modelId: "claude-opus-4" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(header!.textContent).not.toContain("Planning:");

      fireEvent.click(screen.getByTestId("agent-log-model-expand"));
      expect(header!.textContent).toContain("Planning:");
      expect(header!.textContent).toContain("anthropic/claude-opus-4");
    });

    it("renders 'Using default' for planning when no planning model is set", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} planningModel={null} />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });

    it("renders 'Using default' for planning when planningModel is undefined", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
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
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="google"]')).toBeTruthy();
      expect(header!.textContent).not.toContain("anthropic/claude-opus-4");
      expect(header!.textContent).not.toContain("openai/gpt-4o");
      expect(header!.textContent).not.toContain("google/gemini-pro");

      fireEvent.click(screen.getByTestId("agent-log-model-expand"));
      expect(header!.textContent).toContain("anthropic/claude-opus-4");
      expect(header!.textContent).toContain("openai/gpt-4o");
      expect(header!.textContent).toContain("google/gemini-pro");
    });

    it("shows 'Using default' for planning when planningModel has only provider but no modelId", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          planningModel={{ provider: "anthropic" }}
        />,
      );
      const header = container.querySelector("[data-testid='agent-log-model-header']");
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("Using default");
    });
  });

  describe("model header expand/collapse", () => {
    it("shows only provider icons in collapsed state, hides model text", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-sonnet-4-5" }}
        />,
      );

      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(screen.getByTestId("agent-log-model-expand")).toBeTruthy();
      expect(container.textContent).not.toContain("Executor:");
      expect(container.textContent).not.toContain("claude-sonnet-4-5");
    });

    it("shows model details when expand button is clicked", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-sonnet-4-5" }}
        />,
      );

      fireEvent.click(screen.getByTestId("agent-log-model-expand"));
      expect(container.textContent).toContain("Executor:");
      expect(container.textContent).toContain("anthropic/claude-sonnet-4-5");
    });

    it("collapses model details when expand button is clicked again", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-sonnet-4-5" }}
        />,
      );

      const button = screen.getByTestId("agent-log-model-expand");
      fireEvent.click(button);
      expect(container.textContent).toContain("Executor:");
      fireEvent.click(button);
      expect(container.textContent).not.toContain("Executor:");
    });

    it("shows no provider icons when no model overrides are set", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);

      expect(container.querySelector("[data-provider]")).toBeNull();
    });

    it("has aria-expanded=false when collapsed and aria-expanded=true when expanded", () => {
      const entries = [makeEntry()];
      render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-sonnet-4-5" }}
        />,
      );

      const button = screen.getByTestId("agent-log-model-expand");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
    });

    it("renders multiple provider icons for multiple overrides", () => {
      const entries = [makeEntry()];
      const { container } = render(
        <AgentLogViewer
          entries={entries}
          loading={false}
          executorModel={{ provider: "anthropic", modelId: "claude-opus-4" }}
          validatorModel={{ provider: "openai", modelId: "gpt-4o" }}
          planningModel={{ provider: "google", modelId: "gemini-pro" }}
        />,
      );

      expect(container.querySelector('[data-provider="anthropic"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="openai"]')).toBeTruthy();
      expect(container.querySelector('[data-provider="google"]')).toBeTruthy();
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

    it("renders the agent badge as a sticky overlay on a full-width text block", () => {
      const entries = [makeEntry({ text: "long executor output", type: "text", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const block = container.querySelector(".agent-log-text") as HTMLElement;
      const badgeRow = container.querySelector(".agent-log-badge-row") as HTMLElement;

      expect(block).toBeTruthy();
      expect(badgeRow).toBeTruthy();
      expect(getComputedStyle(block).width).toBe("100%");
      expect(getComputedStyle(badgeRow).position).toBe("sticky");
      expect(getComputedStyle(badgeRow).left).not.toBe("");
      expect(getComputedStyle(badgeRow).pointerEvents).toBe("none");
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
      expect(badges.map((badge) => badge.textContent)).toEqual(["[Plan]", "[executor]", "[reviewer]"]);
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
});
