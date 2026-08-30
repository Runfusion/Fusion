import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentLogEntry } from "@fusion/core";
import { AgentLogViewer } from "../AgentLogViewer";
import { ConversationHistory } from "../ConversationHistory";
import { StandardChatMessageItem, StandardStreamingMessage } from "../StandardChatSurface";
import type { ChatMessageInfo } from "../../hooks/chatTypes";

const trace = [
  "**Ensuring Docker build includes dev dependencies for tests**",
  "",
  "Docker tests need development dependencies.",
  "",
  "**Planning deployment commit structure**",
  "",
  "Deployment commits remain independently reviewable.",
  "",
  "**Editing README content**",
  "",
  "README edits remain visible in their own section.",
].join("\n");

function expectTraceIsolation(container: HTMLElement) {
  const sections = container.querySelectorAll<HTMLElement>("[data-testid='thinking-trace-section']");
  expect(sections).toHaveLength(3);
  const deployment = [...sections].find((section) => section.textContent?.includes("Planning deployment commit structure"))!;
  expect(deployment).toHaveAttribute("open");
  expect(deployment.textContent).toContain("Deployment commits remain independently reviewable.");
  expect([...sections].filter((section) => section !== deployment).some((section) => section.textContent?.includes("Deployment commits remain independently reviewable."))).toBe(false);
  const readme = [...sections].find((section) => section.textContent?.includes("Editing README content"))!;
  fireEvent.click(deployment.querySelector("summary")!);
  expect(deployment).not.toHaveAttribute("open");
  expect(readme).toHaveAttribute("open");
}

afterEach(cleanup);

describe("ThinkingTrace production transcript surfaces", () => {
  it("renders independently collapsible, expanded streaming-chat sections", () => {
    const { container } = render(<StandardStreamingMessage streamingText="" streamingThinking={trace} />);
    const disclosure = container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(disclosure.querySelector("summary")!);
    expectTraceIsolation(disclosure);
  });

  it("keeps detailed bodies in the mobile live-thinking pane", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      const { container } = render(<StandardStreamingMessage streamingText="" streamingThinking={trace} />);
      const disclosure = container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
      fireEvent.click(disclosure.querySelector("summary")!);

      const sections = disclosure.querySelectorAll<HTMLElement>("[data-testid='thinking-trace-section']");
      expect(sections).toHaveLength(3);
      expect(sections[0]).toHaveAttribute("open");
      expect(sections[0]).toHaveTextContent("Docker tests need development dependencies.");
      expect(sections[1]).toHaveTextContent("Deployment commits remain independently reviewable.");
      expect(sections[2]).toHaveTextContent("README edits remain visible in their own section.");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("renders the same isolated trace in agent logs in markdown and plain modes", () => {
    const entries = [{ taskId: "FN-155", timestamp: "2026-08-22T00:00:00.000Z", type: "thinking", text: trace }] as AgentLogEntry[];
    const { container, rerender } = render(<AgentLogViewer entries={entries} loading={false} renderMarkdown />);
    expectTraceIsolation(container.querySelector(".agent-log-thinking")!);

    rerender(<AgentLogViewer entries={entries} loading={false} renderMarkdown={false} />);
    const plainSections = container.querySelectorAll(".agent-log-thinking [data-testid='thinking-trace-section']");
    expect(plainSections).toHaveLength(3);
    expect([...plainSections].find((section) => section.textContent?.includes("Planning deployment commit structure"))).not.toHaveAttribute("open");
    expect([...plainSections].find((section) => section.textContent?.includes("Editing README content"))).toHaveAttribute("open");
  });

  it("keeps ConversationHistory's existing outer control while sectioning its opened transcript", () => {
    const { container } = render(<ConversationHistory defaultShowThinking entries={[{ thinkingOutput: trace }]} />);
    expectTraceIsolation(container.querySelector(".conversation-entry-thinking")!);
  });

  it("keeps titles-only headings visible without rows across live, persisted, log, and history transcripts", () => {
    const titlesOnly = "**One**\n\n**Two**\n\n**Three**";
    const expectFoldedTrace = (root: HTMLElement) => {
      expect(root.querySelectorAll("[data-testid='thinking-trace-section']")).toHaveLength(0);
      expect(root).toHaveTextContent("One");
      expect(within(root).queryAllByText("No reasoning captured for this step")).toHaveLength(0);
      expect(within(root).getByTestId("thinking-trace-raw-toggle")).toBeInTheDocument();
    };

    const live = render(<StandardStreamingMessage streamingText="" streamingThinking={titlesOnly} />);
    const liveDisclosure = live.container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(liveDisclosure.querySelector("summary")!);
    expectFoldedTrace(liveDisclosure);
    fireEvent.click(within(liveDisclosure).getByTestId("thinking-trace-raw-toggle"));
    expect(within(liveDisclosure).getByTestId("thinking-trace-raw")).toHaveTextContent("**One**");
    live.unmount();

    const persistedMessage = { id: "persisted", sessionId: "session", role: "assistant", content: "Reply", createdAt: "2026-08-23T00:00:00.000Z", thinkingOutput: titlesOnly } as ChatMessageInfo;
    const persisted = render(<StandardChatMessageItem message={persistedMessage} forcePlain={false} agentName="Assistant" hideAssistantIdentity={false} showAssistantModelTag={false} activeModelTag={null} activeModelProvider={null} activeSessionId="session" />);
    const persistedDisclosure = persisted.container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(persistedDisclosure.querySelector("summary")!);
    expectFoldedTrace(persistedDisclosure);
    persisted.unmount();

    const entries = [{ taskId: "FN-177", timestamp: "2026-08-23T00:00:00.000Z", type: "thinking", text: titlesOnly }] as AgentLogEntry[];
    const logs = render(<AgentLogViewer entries={entries} loading={false} renderMarkdown />);
    expectFoldedTrace(logs.container.querySelector(".agent-log-thinking")!);
    fireEvent.click(within(logs.container.querySelector(".agent-log-thinking")!).getByTestId("thinking-trace-raw-toggle"));
    expect(within(logs.container.querySelector(".agent-log-thinking")!).getByTestId("thinking-trace-raw")).toHaveTextContent("**One**");
    logs.rerender(<AgentLogViewer entries={entries} loading={false} renderMarkdown={false} />);
    expectFoldedTrace(logs.container.querySelector(".agent-log-thinking")!);
    logs.unmount();

    const history = render(<ConversationHistory defaultShowThinking entries={[{ thinkingOutput: titlesOnly }]} />);
    expectFoldedTrace(history.container.querySelector(".conversation-entry-thinking")!);
  });

  it("keeps only populated headings as rows and preserves folded headings across transcript surfaces", () => {
    const mixed = "**A**\n\nBody A\n\n**B**\n\n**C**\n\nBody C";
    const expectMixedTrace = (root: HTMLElement) => {
      const sections = root.querySelectorAll<HTMLElement>("[data-testid='thinking-trace-section']");
      expect(sections).toHaveLength(2);
      expect(sections[0]).toHaveTextContent("B");
      expect(within(root).getByTestId("thinking-trace-raw-toggle")).toBeInTheDocument();
    };

    const live = render(<StandardStreamingMessage streamingText="" streamingThinking={mixed} />);
    const liveDisclosure = live.container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(liveDisclosure.querySelector("summary")!);
    expectMixedTrace(liveDisclosure);
    live.unmount();

    const persisted = render(<StandardChatMessageItem message={{ id: "mixed", sessionId: "session", role: "assistant", content: "Reply", createdAt: "2026-08-23T00:00:00.000Z", thinkingOutput: mixed } as ChatMessageInfo} forcePlain={false} agentName="Assistant" hideAssistantIdentity={false} showAssistantModelTag={false} activeModelTag={null} activeModelProvider={null} activeSessionId="session" />);
    const persistedDisclosure = persisted.container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(persistedDisclosure.querySelector("summary")!);
    expectMixedTrace(persistedDisclosure);
    persisted.unmount();

    const entries = [{ taskId: "FN-177", timestamp: "2026-08-23T00:00:00.000Z", type: "thinking", text: mixed }] as AgentLogEntry[];
    const logs = render(<AgentLogViewer entries={entries} loading={false} renderMarkdown />);
    expectMixedTrace(logs.container.querySelector(".agent-log-thinking")!);
    logs.rerender(<AgentLogViewer entries={entries} loading={false} renderMarkdown={false} />);
    expectMixedTrace(logs.container.querySelector(".agent-log-thinking")!);
    logs.unmount();

    const history = render(<ConversationHistory defaultShowThinking entries={[{ thinkingOutput: mixed }]} />);
    expectMixedTrace(history.container.querySelector(".conversation-entry-thinking")!);
  });

  it("keeps a streaming section mounted until a trailing heading receives its body", () => {
    const partial = "**A**\n\nBody A\n\n**B**";
    const { container, rerender } = render(<StandardStreamingMessage streamingText="" streamingThinking={partial} />);
    const disclosure = container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(disclosure.querySelector("summary")!);
    const first = disclosure.querySelector("[data-testid='thinking-trace-section']");
    expect(first).toBeTruthy();
    rerender(<StandardStreamingMessage streamingText="" streamingThinking={`${partial}\n\nBody B`} />);
    expect(disclosure.querySelectorAll("[data-testid='thinking-trace-section']")).toHaveLength(2);
    expect(disclosure.querySelector("[data-testid='thinking-trace-section']")).toBe(first);
  });

  it("renders no trace shell for whitespace and no raw toggle for heading-free text", () => {
    const blank = render(<StandardStreamingMessage streamingText="" streamingThinking=" \n\t" />);
    expect(blank.container.querySelector(".thinking-trace-header")).toBeNull();
    expect(blank.container.querySelector("[data-testid='thinking-trace-raw-toggle']")).toBeNull();
    expect(blank.container.querySelector("[data-testid='thinking-trace-section']")).toBeNull();
    blank.unmount();
    const untitled = render(<ConversationHistory defaultShowThinking entries={[{ thinkingOutput: "Plain reasoning" }]} />);
    expect(untitled.container.querySelector(".thinking-trace-header")).toBeNull();
    expect(untitled.container.querySelector("[data-testid='thinking-trace-raw-toggle']")).toBeNull();
  });
});
