import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useViewportMode as useHeaderViewportMode } from "../Header";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(), fetchMessage: vi.fn(),
  sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(), fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(), fetchNativeStructurePreview: vi.fn(), fetchTaskDetail: vi.fn(), createTaskFromRecommendation: vi.fn(), archiveMessage: vi.fn(), unarchiveMessage: vi.fn(),
}));
vi.mock("../../hooks/useViewportMode", () => ({ useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("lucide-react", () => ({ Mail: () => null, Send: () => null, Inbox: () => null, Bot: () => null, Trash2: () => null, Archive: () => null, CheckCheck: () => null, Loader2: () => null, RefreshCw: () => null, MessageSquare: () => null, User: () => null, X: () => null, Check: () => null, ChevronRight: () => null, ChevronDown: () => null, AlertCircle: () => null, Map: () => null, Flag: () => null, Lightbulb: () => null, BarChart3: () => null, Target: () => null, CircleAlert: () => null }));

import * as api from "../../api";

const agents = [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z", metadata: {} }];
const recommendationNotice = (id: string): Message => ({ id, fromId: "agent-1", fromType: "agent", toId: "dashboard", toType: "user", type: "agent-to-user", read: true, content: "Recommendations", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z", metadata: { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationIds: ["rec-1"] } });
const ordinary = (id: string): Message => ({ ...recommendationNotice(id), metadata: undefined, content: "Ordinary" });

/**
 * FNXC:TaskRecommendations 2026-08-15-22:39:
 * The create control is mounted separately in each selected and conversation body. Recommendation
 * notices have moved out of the active Inbox, so archived history is the retained mailbox route that
 * must keep every detail action working across real hosts and breakpoints.
 */
describe("mailbox task recommendation production surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const archivedMessages = [recommendationNotice("notice")];
    const inboxMessages = [ordinary("ordinary")];
    vi.mocked(api.fetchInbox).mockImplementation(async (filter) => filter?.archived
      ? { messages: archivedMessages, total: archivedMessages.length, unreadCount: 0 }
      : { messages: inboxMessages, total: inboxMessages.length, unreadCount: 0 });
    vi.mocked(api.fetchOutbox).mockResolvedValue({ messages: [], total: 0 });
    vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 0 });
    vi.mocked(api.fetchAgents).mockResolvedValue(agents as never);
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    vi.mocked(api.fetchTaskDetail).mockResolvedValue({ id: "FN-9100", recommendations: [{ id: "rec-1", title: "Follow up", description: "Optional follow-up", category: "feature" }] } as never);
  });

  it.each([
    ["MailboxView", "desktop", "selected", (props: any) => <MailboxView {...props} />],
    ["MailboxView", "desktop", "conversation", (props: any) => <MailboxView {...props} />],
    ["MailboxView", "mobile", "selected", (props: any) => <MailboxView {...props} />],
    ["MailboxView", "mobile", "conversation", (props: any) => <MailboxView {...props} />],
    ["MailboxModal", "desktop", "selected", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
    ["MailboxModal", "desktop", "conversation", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
    ["MailboxModal", "mobile", "selected", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
    ["MailboxModal", "mobile", "conversation", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
  ] as const)("renders Create task in %s %s %s body", async (_name, viewport, pane, Host) => {
    vi.mocked(useViewportMode).mockReturnValue(viewport);
    vi.mocked(useHeaderViewportMode).mockReturnValue(viewport);
    const messages = [recommendationNotice("notice"), { ...ordinary("ordinary"), metadata: { replyTo: { messageId: "notice" } } }];
    vi.mocked(api.fetchConversation).mockResolvedValue(pane === "conversation" ? messages as never : []);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
    await user.click(await screen.findByTestId("mailbox-tab-archived"));
    await user.click(await screen.findByTestId("mailbox-item-notice"));
    if (pane === "conversation") await waitFor(() => expect(screen.getByTestId("mailbox-conversation")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Create task" })).toBeInTheDocument();
    const card = screen.getByTestId("mailbox-task-recommendations").querySelector("article");
    expect(card).toHaveClass("mailbox-task-recommendations__item");
    expect(card).not.toHaveClass("card");
  });

  it.each([
    ["MailboxView", (props: any) => <MailboxView {...props} />],
    ["MailboxModal", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
  ])("keeps ordinary %s messages shell-free", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
    await user.click(await screen.findByTestId("mailbox-item-ordinary"));
    expect(screen.queryByTestId("mailbox-task-recommendations")).not.toBeInTheDocument();
  });
});
