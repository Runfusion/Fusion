import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MainContentProps } from "../dashboard/types";
import { MainContent } from "../dashboard/MainContent";
import { ChatView } from "../ChatView";
import { useChatMailReportRouting } from "../chatReportHandoff";
import { useViewportMode } from "../../hooks/useViewportMode";
import { installChatViewEnv, setupMockChat } from "./ChatView.test-harness";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(async () => ({ messages: [], total: 0, unreadCount: 0 })), fetchOutbox: vi.fn(async () => ({ messages: [], total: 0 })),
  fetchUnreadCount: vi.fn(async () => ({ unreadCount: 0 })), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(async () => ({ messages: [], total: 0, unreadCount: 0 })),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(async () => []), fetchMessage: vi.fn(),
  sendMessage: vi.fn(async () => ({ id: "sent" })), fetchAgents: vi.fn(async () => [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-08-09", updatedAt: "2026-08-09", metadata: {} }]),
  fetchApprovals: vi.fn(async () => ({ requests: [], total: 0, pendingCount: 0 })), fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(),
  fetchMission: vi.fn(), fetchMissions: vi.fn(async () => []), fetchInsights: vi.fn(async () => ({ insights: [], count: 0 })), listEvals: vi.fn(async () => ({ results: [], count: 0 })), fetchTaskDetail: vi.fn(), fetchNativeStructurePreview: vi.fn(), artifactMediaUrlWithToken: vi.fn(),
  fetchSettings: vi.fn(async () => ({})), fetchModels: vi.fn(async () => ({ models: [] })), fetchDiscoveredSkills: vi.fn(async () => ({ skills: [] })), fetchTasks: vi.fn(async () => []), searchFiles: vi.fn(async () => ({ files: [] })), updateGlobalSettings: vi.fn(),
}));
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});
installChatViewEnv();
vi.mock("../../hooks/useViewportMode", () => ({ useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })), _resetInitialViewportHeight: vi.fn() }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));

function mailboxProps(prefill: MainContentProps["mailComposerPrefill"], taskView: "chat" | "mailbox", handleChangeTaskView: (view: "chat" | "mailbox") => void, onSendAsReport: MainContentProps["onSendAsReport"]): MainContentProps {
  return {
    showBackendConnectionErrorPage: false, projectsError: null, t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"], retryingProjects: false,
    handleRetryProjects: vi.fn(), shellApi: null, taskView, modalManager: {} as MainContentProps["modalManager"], handleChangeTaskView,
    refreshAppSettings: vi.fn(), addToast: vi.fn(), currentProject: { id: "project-1", name: "Project" } as MainContentProps["currentProject"], viewMode: "project",
    tasks: [], workflowSteps: [], openDetailTask: vi.fn(), popOutTaskDetail: vi.fn(), setMailboxUnreadCount: vi.fn(), settingsLoaded: true, skillsEnabled: true,
    insightsEnabled: true, researchEnabled: true, evalsEnabled: true, memoryEnabled: true, goalsEnabled: true, todosEnabled: true, nodesEnabled: true,
    capacityRiskBannerEnabled: false, capacityRiskDismissed: false, capacityRiskSignal: { level: "low", reasons: [] } as any, mailComposerPrefill: prefill, onSendAsReport,
  } as unknown as MainContentProps;
}

function ChatMailRoutingHost() {
  const [taskView, setTaskView] = useState<"chat" | "mailbox">("chat");
  const [quickChatOpen, setQuickChatOpen] = useState(true);
  const { mailComposerPrefill, onSendAsReport } = useChatMailReportRouting(
    () => setTaskView("mailbox"),
    () => setQuickChatOpen(false),
  );
  return <>
    <span data-testid="quick-chat-open">{String(quickChatOpen)}</span>
    <button type="button" data-testid="reopen-quick-chat" onClick={() => { setQuickChatOpen(true); setTaskView("chat"); }}>Reopen Quick Chat</button>
    {taskView === "chat" ? <ChatView projectId="project-1" addToast={vi.fn()} onSendAsReport={onSendAsReport} /> : <MainContent {...mailboxProps(mailComposerPrefill, taskView, setTaskView, onSendAsReport)} />}
  </>;
}

/**
 * FNXC:StructuralMail 2026-08-09-11:40:
 * This uses the shipped MainContent → MailboxView → MessageComposer route so a handoff cannot pass
 * merely because a unit test called a mocked callback; recipient selection remains operator-owned.
 */
describe("chat-to-mail report routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useViewportMode).mockReturnValue("desktop");
  });

  it("clicks the real ChatView action through the production routing seam and sends structural metadata after recipient selection", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const activeSession = { id: "chat-1", agentId: "__fn_agent__", status: "active", title: "Chat", createdAt: "2026-08-09", updatedAt: "2026-08-09" };
    setupMockChat({ sessions: [activeSession], filteredSessions: [activeSession], activeSession, messages: [{ id: "assistant-1", sessionId: "chat-1", role: "assistant", content: "# Status\nReady", createdAt: "2026-08-09" }] });
    render(<ChatMailRoutingHost />);
    await user.click(await screen.findByTestId("chat-send-as-report-assistant-1"));
    expect(screen.getByTestId("quick-chat-open")).toHaveTextContent("false");
    expect(await screen.findByTestId("report-title")).toHaveValue("Status");
    expect(screen.getByTestId("message-composer-content")).toHaveValue("# Status\nReady");
    expect(screen.getByTestId("message-composer-send")).toBeDisabled();
    await user.selectOptions(screen.getByTestId("message-composer-recipient"), "agent-1");
    expect(screen.getByTestId("message-composer-send")).toBeEnabled();
    await user.click(screen.getByTestId("report-section-add"));
    await user.type(screen.getByTestId(/report-section-heading-/), "Summary");
    await user.type(screen.getByTestId(/report-section-body-/), "Ready");
    await user.click(screen.getByTestId("message-composer-send"));
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ mailKind: "report", report: { title: "Status", sections: [{ heading: "Summary", body: "Ready" }] } }),
    }), "project-1");
    expect(screen.queryByTestId("message-composer-error")).not.toBeInTheDocument();
  });

  it("routes the real handoff through the mobile mailbox composer with a bounded body", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(useViewportMode).mockReturnValue("mobile");
    const activeSession = { id: "chat-mobile", agentId: "__fn_agent__", status: "active", title: "Chat", createdAt: "2026-08-09", updatedAt: "2026-08-09" };
    const body = `# Mobile status\n${"x".repeat(2_100)}`;
    setupMockChat({ sessions: [activeSession], filteredSessions: [activeSession], activeSession, messages: [{ id: "assistant-mobile", sessionId: "chat-mobile", role: "assistant", content: body, createdAt: "2026-08-09" }] });
    render(<ChatMailRoutingHost />);

    await user.click(await screen.findByTestId("chat-send-as-report-assistant-mobile"));
    expect(screen.getByTestId("quick-chat-open")).toHaveTextContent("false");
    expect(await screen.findByTestId("report-title")).toHaveValue("Mobile status");
    const composerBody = screen.getByTestId("message-composer-content") as HTMLTextAreaElement;
    expect(composerBody).toHaveValue(body.slice(0, 2000));
    expect(composerBody.value).toMatch(/^# Mobile status/);
    expect(composerBody.value).toHaveLength(2000);
    expect(screen.getByTestId("message-composer-send")).toBeDisabled();

    // FNXC:StructuralMail 2026-08-09-12:41: FN-8870 rejects empty report section arrays, so mobile routing proves the recipient-gated send after the operator supplies the required structural section.
    await user.selectOptions(screen.getByTestId("message-composer-recipient"), "agent-1");
    expect(screen.getByTestId("message-composer-send")).toBeEnabled();
    await user.click(screen.getByTestId("message-composer-send"));
    expect(screen.getByTestId("message-composer-error")).toHaveTextContent("A report needs at least one section");
    expect(api.sendMessage).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("report-section-add"));
    await user.type(screen.getByTestId(/report-section-heading-/), "Summary");
    await user.type(screen.getByTestId(/report-section-body-/), "Ready");
    await user.click(screen.getByTestId("message-composer-send"));
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        mailKind: "report",
        report: { title: "Mobile status", sections: [{ heading: "Summary", body: "Ready" }] },
      }),
    }), "project-1");
    expect(screen.queryByTestId("message-composer-error")).not.toBeInTheDocument();
  });

  it("uses a fresh nonce to reopen a composer after the operator closes the previous handoff", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const activeSession = { id: "chat-repeat", agentId: "__fn_agent__", status: "active", title: "Chat", createdAt: "2026-08-09", updatedAt: "2026-08-09" };
    setupMockChat({ sessions: [activeSession], filteredSessions: [activeSession], activeSession, messages: [{ id: "assistant-repeat", sessionId: "chat-repeat", role: "assistant", content: "# First report\nReady", createdAt: "2026-08-09" }] });
    render(<ChatMailRoutingHost />);

    await user.click(await screen.findByTestId("chat-send-as-report-assistant-repeat"));
    await screen.findByTestId("message-composer");
    await user.click(screen.getByTestId("message-composer-cancel"));
    expect(screen.queryByTestId("message-composer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("reopen-quick-chat"));
    await user.click(await screen.findByTestId("chat-send-as-report-assistant-repeat"));
    expect(await screen.findByTestId("message-composer")).toBeInTheDocument();
    expect(screen.getByTestId("report-title")).toHaveValue("First report");
  });
});
