import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentLogEntry } from "@fusion/core";
import { AgentLogViewer } from "../AgentLogViewer";
import { ConversationHistory } from "../ConversationHistory";
import { StandardStreamingMessage } from "../StandardChatSurface";

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

  it("labels every titles-only section instead of silently rendering an empty body", () => {
    const titlesOnly = "**One**\n\n**Two**\n\n**Three**";
    const { container } = render(<StandardStreamingMessage streamingText="" streamingThinking={titlesOnly} />);
    const disclosure = container.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure.querySelectorAll("[data-testid='thinking-trace-section']")).toHaveLength(3);
    expect(screen.getAllByText("No reasoning captured for this step").length).toBeGreaterThanOrEqual(3);
  });
});
