import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { mockViewportMode, renderWithAct, setupMockChat, installChatViewEnv } from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});
vi.mock("../../api", () => ({ fetchSettings: vi.fn().mockResolvedValue({}), fetchModels: vi.fn().mockResolvedValue({ models: [] }), fetchAgents: vi.fn().mockResolvedValue([]), fetchDiscoveredSkills: vi.fn().mockResolvedValue([]), fetchTasks: vi.fn().mockResolvedValue([]), searchFiles: vi.fn().mockResolvedValue({ files: [] }), updateGlobalSettings: vi.fn() }));
installChatViewEnv();

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "s-1", agentId: "__fn_agent__", status: "active", title: "Chat", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides,
});

function setupAssistantChat(overrides: Record<string, unknown> = {}) {
  const activeSession = session(overrides);
  setupMockChat({
    sessions: [activeSession],
    filteredSessions: [activeSession],
    activeSession,
    messages: [{ id: "m-1", sessionId: "s-1", role: "assistant", content: "# Release report\nReady", createdAt: "2026-01-01" }],
  });
}

describe("ChatView send as report", () => {
  it("routes a completed assistant response as the canonical object handoff", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    setupAssistantChat();
    const onSendAsReport = vi.fn();
    await renderWithAct(<ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={onSendAsReport} />);
    const reportAction = await screen.findByTestId("chat-send-as-report-m-1");
    await user.click(reportAction);
    expect(onSendAsReport).toHaveBeenCalledTimes(1);
    expect(onSendAsReport).toHaveBeenCalledWith({ body: "# Release report\nReady", title: "Release report" });
    expect(reportAction.parentElement).toHaveClass("chat-message-actions");
    expect(reportAction.parentElement?.querySelector("[data-testid='chat-copy-response-m-1']")).toBeInTheDocument();
  });

  it("wires completed messages in both streaming branches but never the unfinished streaming item", async () => {
    setupAssistantChat();
    const { rerender } = await renderWithAct(<ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={vi.fn()} />);
    expect(await screen.findByTestId("chat-send-as-report-m-1")).toBeInTheDocument();

    setupMockChat({
      sessions: [session()], filteredSessions: [session()], activeSession: session(), isStreaming: true,
      streamingText: "Still writing", messages: [{ id: "m-1", sessionId: "s-1", role: "assistant", content: "Finished report", createdAt: "2026-01-01" }],
    });
    rerender(<ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={vi.fn()} />);
    expect(await screen.findByTestId("chat-send-as-report-m-1")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-send-as-report-__streaming__")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-copy-response-streaming")).toBeInTheDocument();
  });

  it("renders for mobile and CLI transcript hosts but not blank, user, or handler-less messages", async () => {
    const mobile = mockViewportMode("mobile");
    setupAssistantChat();
    const { rerender } = await renderWithAct(<ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={vi.fn()} />);
    expect(await screen.findByTestId("chat-send-as-report-m-1")).toBeInTheDocument();

    mobile.mockRestore();
    setupAssistantChat({ cliExecutorAdapterId: "codex" });
    rerender(<ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={vi.fn()} />);
    expect(await screen.findByTestId("chat-send-as-report-m-1")).toBeInTheDocument();

    setupMockChat({ sessions: [session()], filteredSessions: [session()], activeSession: session(), messages: [
      { id: "user", sessionId: "s-1", role: "user", content: "No report", createdAt: "2026-01-01" },
      { id: "blank", sessionId: "s-1", role: "assistant", content: "   ", createdAt: "2026-01-01" },
    ] });
    rerender(<ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={vi.fn()} />);
    expect(screen.queryByTestId("chat-send-as-report-user")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-send-as-report-blank")).not.toBeInTheDocument();

    setupAssistantChat();
    rerender(<ChatView projectId="project-1" addToast={vi.fn()} />);
    expect(screen.queryByTestId("chat-send-as-report-m-1")).not.toBeInTheDocument();
  });

  it("trims oversized reports and warns before handing them off", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const addToast = vi.fn();
    const onSendAsReport = vi.fn();
    const content = `# Long report\n${"x".repeat(2_100)}`;
    const activeSession = session();
    setupMockChat({ sessions: [activeSession], filteredSessions: [activeSession], activeSession, messages: [{ id: "long", sessionId: "s-1", role: "assistant", content, createdAt: "2026-01-01" }] });
    await renderWithAct(<ChatView projectId="project-1" addToast={addToast} onSendAsReport={onSendAsReport} />);
    await user.click(await screen.findByTestId("chat-send-as-report-long"));
    expect(onSendAsReport.mock.calls[0][0]).toEqual(expect.objectContaining({ title: "Long report" }));
    expect(onSendAsReport.mock.calls[0][0].body).toHaveLength(2000);
    expect(addToast).toHaveBeenCalledWith("Message trimmed to 2000 characters for mail", "warning");
  });
});
