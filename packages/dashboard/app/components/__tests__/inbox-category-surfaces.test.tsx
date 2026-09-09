import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { classifyDashboardInboxMessage, type Message } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { InsightsView } from "../InsightsView";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useViewportMode as useHeaderViewportMode } from "../Header";
import { useInsights } from "../../hooks/useInsights";
import { useTaskRecommendations } from "../../hooks/useTaskRecommendations";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(), fetchMessage: vi.fn(),
  sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(), fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(), fetchNativeStructurePreview: vi.fn(), fetchTaskDetail: vi.fn(), createTaskFromRecommendation: vi.fn(), archiveMessage: vi.fn(), unarchiveMessage: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));
vi.mock("../../hooks/useViewportMode", () => ({ useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../hooks/useInsights", () => ({
  useInsights: vi.fn(),
  INSIGHT_CATEGORIES: ["features", "architecture", "competitive_analysis", "research", "trends"],
  CATEGORY_LABELS: { features: "Features", architecture: "Architecture", competitive_analysis: "Competitive Analysis", research: "Research", trends: "Trends" },
}));
vi.mock("../../hooks/useTaskRecommendations", () => ({ useTaskRecommendations: vi.fn() }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));

import * as api from "../../api";

const ordinaryMessage: Message = {
  id: "ordinary",
  fromId: "agent-1",
  fromType: "agent",
  toId: "dashboard",
  toType: "user",
  type: "agent-to-user",
  read: false,
  content: "An ordinary message",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};

const recommendationNotice: Message = {
  ...ordinaryMessage,
  id: "recommendation-notice",
  read: true,
  content: "Archived recommendation",
  metadata: {
    kind: "task-recommendation-notice",
    taskId: "FN-9000",
    recommendationIds: ["rec-1"],
  },
};

const artifactNotice: Message = {
  ...ordinaryMessage,
  id: "artifact-notice",
  content: "Artifact registered",
  metadata: { artifactId: "artifact-1" },
};

const agents = [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z", metadata: {} }];

const hostCases = [
  ["MailboxView", "desktop", (props: Record<string, unknown>) => <MailboxView {...props} />],
  ["MailboxView", "mobile", (props: Record<string, unknown>) => <MailboxView {...props} />],
  ["MailboxModal", "desktop", (props: Record<string, unknown>) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
  ["MailboxModal", "mobile", (props: Record<string, unknown>) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
] as const;

function renderHost(Host: (props: Record<string, unknown>) => JSX.Element) {
  return render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
}

function setViewport(viewport: "desktop" | "mobile") {
  vi.mocked(useViewportMode).mockReturnValue(viewport);
  vi.mocked(useHeaderViewportMode).mockReturnValue(viewport);
}

function configureActiveInbox(messages: Message[]) {
  vi.mocked(api.fetchInbox).mockImplementation(async (filter) => {
    if (filter?.archived) {
      return { messages: [recommendationNotice], total: 1, unreadCount: 0 };
    }
    expect(filter).toEqual({ limit: 50, category: "message" });
    const filteredMessages = messages.filter((message) => classifyDashboardInboxMessage(message.metadata) === filter.category);
    return { messages: filteredMessages, total: filteredMessages.length, unreadCount: filteredMessages.filter((message) => !message.read).length, categoryUnreadCounts: { message: filteredMessages.filter((message) => !message.read).length, recommendation: 1, artifact: 1 } };
  });
}

/**
 * FNXC:InboxCategories 2026-09-06-03:16:
 * Both mailbox hosts and breakpoints must expose only ordinary active mail while preserving archived
 * notice details. The test server double enforces the category request so a host cannot regress by
 * merely hiding a rendered row after loading mixed unread state.
 */
describe("inbox category surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    configureActiveInbox([ordinaryMessage, recommendationNotice, artifactNotice]);
    vi.mocked(api.fetchOutbox).mockResolvedValue({ messages: [], total: 0 });
    vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 3, categoryUnreadCounts: { message: 1, recommendation: 1, artifact: 1 } });
    vi.mocked(api.fetchAgentMailbox).mockResolvedValue({ inbox: [], outbox: [], unreadCount: 0 });
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    vi.mocked(api.fetchAgents).mockResolvedValue(agents as never);
    vi.mocked(api.fetchApprovals).mockResolvedValue([] as never);
    vi.mocked(api.fetchConversation).mockResolvedValue([recommendationNotice]);
    vi.mocked(api.markAllMessagesRead).mockResolvedValue({ markedAsRead: 1 });
    vi.mocked(api.fetchTaskDetail).mockResolvedValue({
      id: "FN-9000",
      recommendations: [{ id: "rec-1", title: "Follow up", description: "Optional follow-up", category: "feature" }],
    } as never);
    vi.mocked(useInsights).mockReturnValue({
      sections: [], loading: false, error: null, latestRun: null, isRunInFlight: false, runError: null,
      refresh: vi.fn(), runInsights: vi.fn(), dismiss: vi.fn(), createTask: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), toggleShowArchived: vi.fn(),
      dismissStates: new Map(), createTaskStates: new Map(), archiveStates: new Map(), unarchiveStates: new Map(),
      totalCount: 0, dismissedCount: 0, archivedCount: 0, showArchived: false,
    } as never);
    vi.mocked(useTaskRecommendations).mockReturnValue({
      items: [{ taskId: "FN-9000", taskTitle: "Source task", recommendation: { id: "rec-1", title: "Follow up", description: "Optional follow-up", category: "feature" } }],
      loading: false, loadingMore: false, error: null, hasMore: false, totalRowCount: 1, truncated: false,
      refresh: vi.fn(), loadMore: vi.fn(), createTask: vi.fn(), createStates: new Map(),
    });
  });

  it.each(hostCases)("shows only ordinary active mail in %s on %s", async (_name, viewport, Host) => {
    setViewport(viewport);
    renderHost(Host);

    expect(await screen.findByTestId("mailbox-item-ordinary")).toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-item-recommendation-notice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-item-artifact-notice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-task-recommendations")).not.toBeInTheDocument();
    expect(api.fetchInbox).toHaveBeenCalledWith({ limit: 50, category: "message" }, undefined);
  });

  it.each(hostCases.filter(([, viewport]) => viewport === "desktop"))("marks only ordinary %s messages read", async (_name, _viewport, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(Host);

    await user.click(await screen.findByTestId("mailbox-mark-all-read"));
    expect(api.markAllMessagesRead).toHaveBeenCalledWith(undefined, { category: "message" });
  });

  it.each(hostCases)("renders an empty %s inbox without residual notice shells on %s", async (_name, viewport, Host) => {
    setViewport(viewport);
    configureActiveInbox([recommendationNotice, artifactNotice]);
    renderHost(Host);

    expect(await screen.findByTestId("mailbox-inbox-empty")).toBeInTheDocument();
    expect(document.querySelector('[data-testid^="mailbox-item-"]')).not.toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-task-recommendations")).not.toBeInTheDocument();
  });

  it.each(hostCases.filter(([, viewport]) => viewport === "desktop"))("keeps archived recommendation notices accessible in %s", async (_name, _viewport, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(Host);

    await user.click(await screen.findByTestId("mailbox-tab-archived"));
    const archivedNotice = await screen.findByTestId("mailbox-item-recommendation-notice");
    expect(archivedNotice).toBeInTheDocument();
    await user.click(archivedNotice);
    expect(await screen.findByTestId("mailbox-task-recommendations")).toBeInTheDocument();
    expect(api.fetchInbox).toHaveBeenCalledWith({ limit: 50, archived: true }, undefined);
  });

  it("keeps the existing Insights recommendation section", async () => {
    render(<InsightsView addToast={vi.fn()} models={[]} />);

    await waitFor(() => expect(screen.getByTestId("insights-section-recommendations")).toBeInTheDocument());
  });

  it.each(["desktop", "mobile"] as const)("leaves no recommendation shell in the MailboxView list on %s", async (viewport) => {
    setViewport(viewport);
    renderHost((props) => <MailboxView {...props} />);

    expect(await screen.findByTestId("mailbox-item-ordinary")).toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-task-recommendations")).not.toBeInTheDocument();
    expect(document.querySelector(".mailbox-task-recommendations")).not.toBeInTheDocument();
  });
});
