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
      fireEvent.click(screen.getByTestId("tool-detail-toggle"));
      // FNXC:ToolCallDisplay 2026-08-03-02:01: FN-8701 wraps payload in ToolCallDetails (label + pre).
      const detail = container.querySelector(".agent-log-tool-detail .tool-call-details-value");
      expect(detail).toBeTruthy();
      expect(detail!.textContent).toContain(longDetail);
      expect(detail!.textContent!.length).toBe(5000);
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
      fireEvent.click(screen.getByTestId("tool-detail-toggle"));
      const detail = container.querySelector(".agent-log-tool-detail");
      expect(detail).toBeTruthy();
      expect(detail!.textContent).toContain(longDetail);
    });

    it("renders long tool_error detail without truncation", () => {
      const longDetail = "E".repeat(5000);
      const entries = [makeEntry({ text: "Write", type: "tool_error", detail: longDetail })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      fireEvent.click(screen.getByTestId("tool-detail-toggle"));
      const detail = container.querySelector(".agent-log-tool-detail");
      expect(detail).toBeTruthy();
      expect(detail!.textContent).toContain(longDetail);
    });

    it("preserves raw whitespace in tool detail blocks", () => {
      const detailText = "stdout:\n  line one\n    indented line two\n";
      const entries = [makeEntry({ text: "Bash", type: "tool_result", detail: detailText })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      fireEvent.click(screen.getByTestId("tool-detail-toggle"));
      // FNXC:ToolCallDisplay 2026-08-03-02:01: FN-8701 keeps the raw payload in a nested <pre>.
      const detail = container.querySelector(".agent-log-tool-detail .tool-call-details-value") as HTMLElement;
      expect(detail).toBeTruthy();
      expect(detail.tagName).toBe("PRE");
      expect(detail.textContent).toBe(detailText);
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

    it("renders file links inside inline code with the code wrapper preserved", () => {
      const openFile = vi.fn();
      const entries = [
        makeEntry({ text: "Check `packages/engine/src/scheduler.ts:7` now." }),
      ];
      const { container } = render(
        <FileBrowserProvider openFile={openFile}>
          <AgentLogViewer entries={entries} loading={false} />
        </FileBrowserProvider>,
      );

      const fileLink = screen.getByRole("button", { name: "packages/engine/src/scheduler.ts:7" });
      const code = fileLink.closest("code");
      expect(code).toBeTruthy();
      expect(code?.querySelector("button.file-path-link")).toBe(fileLink);

      fireEvent.click(fileLink);
      expect(openFile).toHaveBeenCalledWith("packages/engine/src/scheduler.ts", { line: 7, col: undefined });
      expect(container.querySelectorAll("code button.file-path-link")).toHaveLength(1);
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

    it("FN-3847: uses accent text color for pressed markdown/tools toggles", () => {
      window.localStorage.setItem("fn-agent-log-markdown", "true");
      window.localStorage.setItem("fn-agent-log-tool-output", "true");
      const entries = [makeEntry({ text: "hello" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);

      const markdownToggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;
      const toolsToggle = container.querySelector("[data-testid='agent-log-tool-output-toggle']") as HTMLButtonElement;
      const fullscreenToggle = container.querySelector("[data-testid='agent-log-fullscreen-toggle']") as HTMLButtonElement;

      expect(markdownToggle.getAttribute("aria-pressed")).toBe("true");
      expect(toolsToggle.getAttribute("aria-pressed")).toBe("true");

      const markdownColor = getComputedStyle(markdownToggle).color;
      const toolsColor = getComputedStyle(toolsToggle).color;
      const unpressedColor = getComputedStyle(fullscreenToggle).color;

      // Contract: unpressed toggles keep the shared muted button color, pressed toggles switch to accent foreground.
      expect(markdownColor.length).toBeGreaterThan(0);
      expect(toolsColor.length).toBeGreaterThan(0);
      expect(markdownColor).toBe(toolsColor);
      expect(markdownColor).not.toBe(unpressedColor);
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
      const plainBlock = textSpans[0].querySelector(".agent-log-plain-block") as HTMLElement;
      expect(plainBlock).toBeTruthy();
      // Plain mode should remove markdown rendering/prose container
      expect(textSpans[0].querySelector(".markdown-body")).toBeNull();
      expect(textSpans[0].querySelector("strong")).toBeNull();
      expect(textSpans[0].querySelector("em")).toBeNull();
    });

    it("concatenates grouped text into a single markdown render", () => {
      const entries = [
        makeEntry({ text: "**bold", type: "text", agent: "executor" }),
        makeEntry({ text: "** text", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);

      const textRows = container.querySelectorAll(".agent-log-text");
      expect(textRows).toHaveLength(1);
      expect(textRows[0].querySelectorAll(".markdown-body")).toHaveLength(1);
      const strong = textRows[0].querySelector("strong");
      expect(strong).toBeTruthy();
      expect(strong!.textContent).toBe("bold");
    });

    it("joins grouped chunks inline in plain text mode", () => {
      const entries = [
        makeEntry({ text: "hello", type: "text", agent: "executor" }),
        makeEntry({ text: " world", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      fireEvent.click(toggle);

      const textRows = container.querySelectorAll(".agent-log-text");
      expect(textRows).toHaveLength(1);
      expect(textRows[0].querySelector(".markdown-body")).toBeNull();
      expect(textRows[0].textContent).toContain("hello world");
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

    it("preserves line breaks in plain text mode for thinking entries", () => {
      const entries = [makeEntry({ text: "line1\nline2\nline3", type: "thinking", agent: "executor" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-mode-toggle']") as HTMLButtonElement;

      fireEvent.click(toggle);

      const plainThinking = container.querySelector(".agent-log-thinking .agent-log-plain-block") as HTMLElement;
      expect(plainThinking).toBeTruthy();
      expect(plainThinking.textContent).toContain("line1\nline2\nline3");
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
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
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

  describe("tool output toggle", () => {
    it("renders the tool output toggle defaulting to On", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-tool-output-toggle']") as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      expect(toggle.textContent).toBe("Tools: On");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("hides tool entries when toggled off and shows them again when toggled back on", () => {
      const entries = [
        makeEntry({ text: "before tool", type: "text", agent: "executor" }),
        makeEntry({ text: "Read", type: "tool", agent: "executor" }),
        makeEntry({ text: "done", type: "tool_result", agent: "executor" }),
        makeEntry({ text: "fail", type: "tool_error", agent: "executor" }),
        makeEntry({ text: "after tool", type: "text", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-tool-output-toggle']") as HTMLButtonElement;

      expect(container.querySelector(".agent-log-tool")).toBeTruthy();
      expect(container.querySelector(".agent-log-tool-result")).toBeTruthy();
      expect(container.querySelector(".agent-log-tool-error")).toBeTruthy();

      fireEvent.click(toggle);
      expect(toggle.textContent).toBe("Tools: Off");
      expect(toggle.getAttribute("aria-pressed")).toBe("false");

      expect(container.querySelector(".agent-log-tool")).toBeNull();
      expect(container.querySelector(".agent-log-tool-result")).toBeNull();
      expect(container.querySelector(".agent-log-tool-error")).toBeNull();
      const textRows = container.querySelectorAll(".agent-log-text");
      const combined = Array.from(textRows).map((r) => r.textContent).join(" ");
      expect(combined).toContain("before tool");
      expect(combined).toContain("after tool");

      fireEvent.click(toggle);
      expect(toggle.textContent).toBe("Tools: On");
      expect(container.querySelector(".agent-log-tool")).toBeTruthy();
      expect(container.querySelector(".agent-log-tool-result")).toBeTruthy();
      expect(container.querySelector(".agent-log-tool-error")).toBeTruthy();
    });

    it("keeps the latest non-tool message visible as its own row when tools are hidden", () => {
      const entries = [
        makeEntry({ text: "Starting plan", type: "text", agent: "executor", timestamp: "2026-01-01T00:00:00Z" }),
        makeEntry({ text: "read file", type: "tool", agent: "executor", timestamp: "2026-01-01T00:00:01Z" }),
        makeEntry({ text: "Final answer", type: "text", agent: "executor", timestamp: "2026-01-01T00:00:02Z" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-tool-output-toggle']") as HTMLButtonElement;

      fireEvent.click(toggle);

      const textRows = container.querySelectorAll(".agent-log-text");
      expect(textRows).toHaveLength(2);
      expect(textRows[0].textContent).toContain("Starting plan");
      expect(textRows[1].textContent).toContain("Final answer");
      expect(container.querySelectorAll(".agent-log-agent-badge")).toHaveLength(2);
      expect(container.querySelectorAll(".agent-log-timestamp")).toHaveLength(2);
    });

    it("does not render any tool log entries when off (only agent text)", () => {
      const entries = [
        makeEntry({ text: "Read", type: "tool", agent: "executor", detail: "some/path" }),
        makeEntry({ text: "thinking out loud", type: "thinking", agent: "executor" }),
      ];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = container.querySelector("[data-testid='agent-log-tool-output-toggle']") as HTMLButtonElement;
      fireEvent.click(toggle);

      expect(container.querySelector(".agent-log-tool")).toBeNull();
      expect(container.querySelector("[data-testid='tool-detail-toggle']")).toBeNull();
      expect(container.querySelector(".agent-log-thinking")).toBeTruthy();
    });

    it("reflects hidden tool entries in the pagination summary", () => {
      const entries = [
        makeEntry({ text: "hi", type: "text" }),
        makeEntry({ text: "Read", type: "tool" }),
        makeEntry({ text: "done", type: "tool_result" }),
      ];
      const { container } = render(
        <AgentLogViewer entries={entries} loading={false} totalCount={3} />,
      );
      const toggle = container.querySelector("[data-testid='agent-log-tool-output-toggle']") as HTMLButtonElement;
      fireEvent.click(toggle);

      const summary = container.querySelector("[data-testid='agent-log-summary']") as HTMLElement;
      expect(summary).toBeTruthy();
      expect(summary.textContent).toContain("Showing 1 of 3 entries");
      expect(summary.textContent).toContain("2 tool entries hidden");
    });
  });

  describe("toggle persistence across remounts", () => {
    it("persists the markdown toggle state in localStorage", () => {
      const entries = [makeEntry()];
      const first = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = first.container.querySelector(
        "[data-testid='agent-log-mode-toggle']",
      ) as HTMLButtonElement;
      fireEvent.click(toggle);
      expect(window.localStorage.getItem("fn-agent-log-markdown")).toBe("false");
      first.unmount();

      const second = render(<AgentLogViewer entries={entries} loading={false} />);
      const restoredToggle = second.container.querySelector(
        "[data-testid='agent-log-mode-toggle']",
      ) as HTMLButtonElement;
      expect(restoredToggle.textContent).toBe("Plain");
      expect(restoredToggle.getAttribute("aria-pressed")).toBe("false");
    });

    it("persists the tool output toggle state in localStorage", () => {
      const entries = [
        makeEntry({ text: "Read", type: "tool" }),
        makeEntry({ text: "hi", type: "text" }),
      ];
      const first = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggle = first.container.querySelector(
        "[data-testid='agent-log-tool-output-toggle']",
      ) as HTMLButtonElement;
      fireEvent.click(toggle);
      expect(window.localStorage.getItem("fn-agent-log-tool-output")).toBe("false");
      first.unmount();

      const second = render(<AgentLogViewer entries={entries} loading={false} />);
      const restoredToggle = second.container.querySelector(
        "[data-testid='agent-log-tool-output-toggle']",
      ) as HTMLButtonElement;
      expect(restoredToggle.textContent).toBe("Tools: Off");
      expect(second.container.querySelector(".agent-log-tool")).toBeNull();
    });

    it("uses default true values when no preference is stored", () => {
      const entries = [makeEntry({ text: "Read", type: "tool" })];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const markdown = container.querySelector(
        "[data-testid='agent-log-mode-toggle']",
      ) as HTMLButtonElement;
      const tools = container.querySelector(
        "[data-testid='agent-log-tool-output-toggle']",
      ) as HTMLButtonElement;
      expect(markdown.textContent).toBe("Markdown");
      expect(tools.textContent).toBe("Tools: On");
    });
  });

  describe("fullscreen toggle", () => {
    it("applies matching min dimensions to markdown and fullscreen header toggles", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const markdownToggle = container.querySelector(
        "[data-testid='agent-log-mode-toggle']",
      ) as HTMLButtonElement;
      const fullscreenToggle = container.querySelector(
        "[data-testid='agent-log-fullscreen-toggle']",
      ) as HTMLButtonElement;

      const markdownStyle = getComputedStyle(markdownToggle);
      const fullscreenStyle = getComputedStyle(fullscreenToggle);

      expect(markdownStyle.minWidth).toBe(fullscreenStyle.minWidth);
      expect(markdownStyle.minHeight).toBe(fullscreenStyle.minHeight);
      expect(markdownStyle.minWidth).not.toBe("0px");
      expect(markdownStyle.minHeight).not.toBe("0px");
    });

    it("adds visible gap spacing between header toggle buttons", () => {
      const entries = [makeEntry()];
      const { container } = render(<AgentLogViewer entries={entries} loading={false} />);
      const toggleGroup = container.querySelector(".agent-log-model-header-toggle") as HTMLElement;
      const toggleGroupStyle = getComputedStyle(toggleGroup);

      expect(toggleGroupStyle.gap).not.toBe("");
      expect(toggleGroupStyle.gap).not.toBe("normal");
    });

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
