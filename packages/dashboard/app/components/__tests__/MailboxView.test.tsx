import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MailboxView } from "../MailboxView";
import * as apiModule from "../../api";
import * as viewportModule from "../../hooks/useViewportMode";
import * as mobileKeyboardModule from "../../hooks/useMobileKeyboard";
import * as sseBusModule from "../../sse-bus";
import type { Agent } from "../../api";
import type { Message } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchInbox: vi.fn(),
  fetchOutbox: vi.fn(),
  fetchUnreadCount: vi.fn(),
  fetchAgentMailbox: vi.fn(),
  fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(),
  markAllMessagesRead: vi.fn(),
  deleteMessage: vi.fn(),
  fetchConversation: vi.fn(),
  sendMessage: vi.fn(),
  fetchAgents: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchApprovalDetail: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn();
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    useViewportMode,
  };
});

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: vi.fn(),
}));

const sseSubscriptions: Array<Record<string, () => void>> = [];
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events: Record<string, () => void> }) => {
    sseSubscriptions.push(options.events);
    return () => {};
  }),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x">X</span>,
  Mail: () => <span data-testid="icon-mail">Mail</span>,
  Send: () => <span data-testid="icon-send">Send</span>,
  Inbox: () => <span data-testid="icon-inbox">Inbox</span>,
  Bot: () => <span data-testid="icon-bot">Bot</span>,
  Trash2: () => <span data-testid="icon-trash">Trash</span>,
  Check: () => <span data-testid="icon-check">Check</span>,
  CheckCheck: () => <span data-testid="icon-checkcheck">CheckCheck</span>,
  Loader2: ({ className }: { className?: string }) => (
    <span data-testid="icon-loader" className={className}>Loader</span>
  ),
  RefreshCw: () => <span data-testid="icon-refresh">Refresh</span>,
  MessageSquare: () => <span data-testid="icon-message">Message</span>,
  User: () => <span data-testid="icon-user">User</span>,
  AlertCircle: () => <span data-testid="icon-alert">Alert</span>,
}));

const mockFetchInbox = vi.mocked(apiModule.fetchInbox);
const mockFetchOutbox = vi.mocked(apiModule.fetchOutbox);
const mockFetchUnreadCount = vi.mocked(apiModule.fetchUnreadCount);
const mockFetchAgentMailbox = vi.mocked(apiModule.fetchAgentMailbox);
const mockFetchAllAgentMailbox = vi.mocked(apiModule.fetchAllAgentMailbox);
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockMarkMessageRead = vi.mocked(apiModule.markMessageRead);
const mockMarkAllMessagesRead = vi.mocked(apiModule.markAllMessagesRead);
const mockDeleteMessage = vi.mocked(apiModule.deleteMessage);
const mockFetchConversation = vi.mocked(apiModule.fetchConversation);
const mockSendMessage = vi.mocked(apiModule.sendMessage);
const mockFetchApprovals = vi.mocked(apiModule.fetchApprovals);
const mockFetchApprovalDetail = vi.mocked(apiModule.fetchApprovalDetail);
const mockDecideApproval = vi.mocked(apiModule.decideApproval);
const mockSubscribeSse = vi.mocked(sseBusModule.subscribeSse);
const mockUseViewportMode = vi.mocked(viewportModule.useViewportMode);
const mockUseMobileKeyboard = vi.mocked(mobileKeyboardModule.useMobileKeyboard);

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Test Agent 1",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Test Agent 2",
    role: "triage",
    state: "active",
    taskId: "FN-001",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const mockMessage: Message = {
  id: "msg-001",
  fromId: "agent-001",
  fromType: "agent",
  toId: "dashboard",
  toType: "user",
  content: "Hello, this is a test message from the agent.",
  type: "agent-to-user",
  read: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockReadMessage: Message = {
  ...mockMessage,
  id: "msg-002",
  read: true,
  content: "This message has been read already.",
};

const mockOutboxMessage: Message = {
  id: "msg-003",
  fromId: "agent-001",
  fromType: "agent",
  toId: "user-001",
  toType: "user",
  content: "This is a sent message from the agent.",
  type: "agent-to-user",
  read: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockAgentToAgentMessage: Message = {
  id: "msg-004",
  fromId: "agent-001",
  fromType: "agent",
  toId: "agent-002",
  toType: "agent",
  content: "Agent to agent ping.",
  type: "agent-to-agent",
  read: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockUnknownAgentMessage: Message = {
  ...mockMessage,
  id: "msg-005",
  fromId: "agent-999",
};

const defaultProps = {
  addToast: vi.fn(),
};

/** Build a valid InboxResponse shape — `total` defaults to `messages.length` */
function makeInboxResponse(messages: Message[], unreadCount = 0) {
  return { messages, unreadCount, total: messages.length };
}

/** Build a valid OutboxResponse shape (no unreadCount) */
function makeOutboxResponse(messages: Message[]) {
  return { messages, total: messages.length };
}

describe("MailboxView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sseSubscriptions.length = 0;
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 2 });
    mockFetchAgents.mockResolvedValue(mockAgents);
    mockSendMessage.mockResolvedValue({ ...mockMessage, id: "msg-sent" });
    mockFetchApprovals.mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });
  });

  it("renders the mailbox view", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    expect(screen.getByTestId("mailbox-view")).toBeDefined();
    expect(screen.getByTestId("mailbox-tabs")).toBeDefined();
  });

  it("shows the Mailbox title with unread count badge", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-unread-badge")).toBeDefined();
    });
  });

  it("preserves composed inbox timestamp buckets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T20:00:00.000Z"));
    const messages = [
      ["now", "2026-06-17T19:59:30.000Z"],
      ["minute", "2026-06-17T19:55:00.000Z"],
      ["hour", "2026-06-17T17:00:00.000Z"],
      ["day", "2026-06-14T20:00:00.000Z"],
      ["future", "2026-06-17T20:00:01.000Z"],
      ["invalid", "not-a-date"],
      ["older", "2026-06-10T20:00:00.000Z"],
    ].map(([id, createdAt]) => ({ ...mockMessage, id: `msg-${id}`, createdAt, updatedAt: createdAt, content: id, read: true }));
    mockFetchInbox.mockResolvedValue(makeInboxResponse(messages, 0));

    const { container } = render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      const times = Array.from(container.querySelectorAll(".mailbox-item-time")).map((node) => node.textContent);
      expect(times).toEqual(expect.arrayContaining([
        "Just now",
        "5m ago",
        "3h ago",
        "3d ago",
        "Invalid Date",
        new Date("2026-06-10T20:00:00.000Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      ]));
    });
  });

  it("renders all four tabs", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    expect(screen.getByTestId("mailbox-tab-inbox")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-outbox")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-agents")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-approvals")).toBeDefined();
  });

  it("shows approvals pending badge on mount without opening Approvals tab", async () => {
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 0, pendingApprovalCount: 3 });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-tab-inbox")).toHaveClass("active");
      expect(screen.getByTestId("mailbox-approvals-pending-badge")).toHaveTextContent("3");
    });

    expect(mockFetchApprovals).not.toHaveBeenCalled();
  });

  it("shows approvals pending badge and loads approvals tab", async () => {
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({
      requests: [{
        id: "apr-1",
        status: "pending",
        actionCategory: "command_execution",
        actionSummary: "Run npm test",
        agentId: "agent-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      total: 1,
      pendingCount: 2,
    });

    render(<MailboxView {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-tab-approvals"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-approvals-pending-badge")).toHaveTextContent("2");
      expect(screen.getByTestId("mailbox-approval-item-apr-1")).toBeDefined();
    });
  });

  it("renders approval detail metadata and history", async () => {
    const now = new Date().toISOString();
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({
      requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", taskId: "FN-1", createdAt: now, updatedAt: now }],
      total: 1,
      pendingCount: 1,
    });
    mockFetchApprovalDetail.mockResolvedValue({
      id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", taskId: "FN-1", createdAt: now, updatedAt: now,
      requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now,
      targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" },
      history: [{ id: "evt-1", eventType: "created", actor: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, createdAt: now }],
    });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-approval-detail")).toBeDefined();
      expect(screen.getByText(/Requester: Agent 1/)).toBeDefined();
      expect(screen.getByText(/Task: FN-1/)).toBeDefined();
      expect(screen.getByTestId("mailbox-approval-history")).toBeDefined();
    });
  });

  it("renders worktrunk install details for worktrunk approvals", async () => {
    const now = new Date().toISOString();
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({
      requests: [{ id: "apr-1", status: "pending", actionCategory: "network_api", actionSummary: "Install worktrunk", agentId: "user", createdAt: now, updatedAt: now }],
      total: 1,
      pendingCount: 1,
    });
    mockFetchApprovalDetail.mockResolvedValue({
      id: "apr-1", status: "pending", actionCategory: "network_api", actionSummary: "Install worktrunk", agentId: "user", createdAt: now, updatedAt: now,
      requester: { actorId: "user", actorType: "user", actorName: "User" }, requestedAt: now,
      targetAction: {
        category: "network_api",
        action: "worktrunk_install",
        summary: "Install worktrunk",
        resourceType: "binary",
        resourceId: "~/.fusion/bin/worktrunk",
        context: {
          version: "v1.2.3",
          installPath: "~/.fusion/bin/worktrunk",
          assets: {
            darwin_arm64: {
              url: "https://example.com/worktrunk.tar.gz",
              sha256: "abc123",
            },
          },
        },
      },
      history: [{ id: "evt-1", eventType: "created", actor: { actorId: "user", actorType: "user", actorName: "User" }, createdAt: now }],
    });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });

    await waitFor(() => {
      expect(screen.getByTestId("worktrunk-install-approval-details")).toBeInTheDocument();
      expect(screen.getByText("v1.2.3")).toBeInTheDocument();
    });
  });

  it("allows approving a pending approval request", async () => {
    const now = new Date().toISOString();
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({
      requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }],
      total: 1,
      pendingCount: 1,
    });
    mockFetchApprovalDetail.mockResolvedValue({
      id: "apr-1",
      status: "pending",
      actionCategory: "command_execution",
      actionSummary: "Run npm test",
      agentId: "agent-001",
      createdAt: now,
      updatedAt: now,
      requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" },
      requestedAt: now,
      targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" },
      history: [{ id: "evt-1", eventType: "created", actor: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, createdAt: now }],
    });
    mockDecideApproval.mockResolvedValue({
      id: "apr-1",
      status: "approved",
      actionCategory: "command_execution",
      actionSummary: "Run npm test",
      agentId: "agent-001",
      createdAt: now,
      updatedAt: now,
      requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" },
      requestedAt: now,
      targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" },
      history: [{ id: "evt-2", eventType: "approved", actor: { actorId: "user", actorType: "user", actorName: "User" }, createdAt: now }],
    });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-approve")); });

    await waitFor(() => {
      expect(mockDecideApproval).toHaveBeenCalledWith("apr-1", { decision: "approve", comment: undefined }, undefined);
    });
  });

  it("allows denying a pending approval request", async () => {
    const now = new Date().toISOString();
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({ requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }], total: 1, pendingCount: 1 });
    mockFetchApprovalDetail.mockResolvedValue({ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now, requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now, targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" }, history: [] });
    mockDecideApproval.mockResolvedValue({ id: "apr-1", status: "denied", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now, requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now, targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" }, history: [] });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-deny")); });

    await waitFor(() => {
      expect(mockDecideApproval).toHaveBeenCalledWith("apr-1", { decision: "deny", comment: undefined }, undefined);
    });
  });

  it("disables decision buttons while submission is pending", async () => {
    const now = new Date().toISOString();
    let resolveDecision: (() => void) | undefined;
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({ requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }], total: 1, pendingCount: 1 });
    mockFetchApprovalDetail.mockResolvedValue({ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now, requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now, targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" }, history: [] });
    mockDecideApproval.mockImplementation(() => new Promise((resolve) => { resolveDecision = () => resolve({} as any); }));

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-approve")); });

    expect(screen.getByTestId("mailbox-approval-approve")).toBeDisabled();
    expect(screen.getByTestId("mailbox-approval-deny")).toBeDisabled();
    expect(mockDecideApproval).toHaveBeenCalledTimes(1);
    resolveDecision?.();
  });

  it("uses mobile stacked layout for approvals detail and back navigation", async () => {
    const now = new Date().toISOString();
    mockUseViewportMode.mockReturnValue("mobile");
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({ requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }], total: 1, pendingCount: 1 });
    mockFetchApprovalDetail.mockResolvedValue({ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now, requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now, targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" }, history: [] });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-approval-detail")).toBeDefined();
      expect(screen.queryByTestId("mailbox-approval-list")).toBeNull();
      expect(screen.getByTestId("mailbox-approval-back-to-list")).toBeDefined();
    });

    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-approval-back-to-list")); });
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-approval-list")).toBeDefined();
    });
  });

  it("updates approvals pending badge on approval:requested SSE without opening Approvals tab", async () => {
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchUnreadCount
      .mockResolvedValueOnce({ unreadCount: 0, pendingApprovalCount: 1 })
      .mockResolvedValueOnce({ unreadCount: 0, pendingApprovalCount: 5 });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-approvals-pending-badge")).toHaveTextContent("1");
    });

    const latest = sseSubscriptions.at(-1);
    expect(latest).toBeDefined();
    await act(async () => {
      latest?.["approval:requested"]?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-approvals-pending-badge")).toHaveTextContent("5");
    });

    expect(mockFetchApprovals).not.toHaveBeenCalled();
  });

  it("refreshes approvals on approval SSE events", async () => {
    const now = new Date().toISOString();
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals.mockResolvedValue({ requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }], total: 1, pendingCount: 1 });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });

    const latest = sseSubscriptions.at(-1);
    expect(latest).toBeDefined();
    await act(async () => {
      latest?.["approval:requested"]?.();
      latest?.["approval:updated"]?.();
      latest?.["approval:decided"]?.();
    });

    await waitFor(() => {
      expect(mockFetchApprovals).toHaveBeenCalled();
      expect(mockSubscribeSse).toHaveBeenCalled();
    });
  });

  it("moves decided requests into history view", async () => {
    const now = new Date().toISOString();
    mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
    mockFetchApprovals
      .mockResolvedValueOnce({ requests: [{ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }], total: 1, pendingCount: 1 })
      .mockResolvedValueOnce({ requests: [], total: 0, pendingCount: 0 })
      .mockResolvedValueOnce({ requests: [{ id: "apr-1", status: "approved", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now }], total: 1, pendingCount: 0 })
      .mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });
    mockFetchApprovalDetail.mockResolvedValue({ id: "apr-1", status: "pending", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now, requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now, targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" }, history: [] });
    mockDecideApproval.mockResolvedValue({ id: "apr-1", status: "approved", actionCategory: "command_execution", actionSummary: "Run npm test", agentId: "agent-001", createdAt: now, updatedAt: now, requester: { actorId: "agent-001", actorType: "agent", actorName: "Agent 1" }, requestedAt: now, targetAction: { category: "command_execution", action: "bash", summary: "Run npm test", resourceType: "command", resourceId: "cmd" }, history: [] });

    render(<MailboxView {...defaultProps} />);
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-approvals")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-item-apr-1")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("mailbox-approval-approve")); });
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-approval-filter-history")); });

    await waitFor(() => {
      expect(mockFetchApprovals).toHaveBeenCalled();
    });
  });

  it("shows inbox tab as active by default", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const inboxTab = screen.getByTestId("mailbox-tab-inbox");
    expect(inboxTab).toHaveClass("active");
  });

  it("loads inbox on mount", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage, mockReadMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(mockFetchInbox).toHaveBeenCalled();
    });
  });

  it("shows inbox messages after loading", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage, mockReadMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });
  });

  it("renders known agent senders by name in inbox conversation rows", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Agent: Test Agent 1 (agent-001)")).toBeDefined();
    });
  });

  it("falls back to stable agent identifier when agent metadata is missing", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockUnknownAgentMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Agent: agent-999")).toBeDefined();
    });
  });

  it("renders separate inbox rows for independent messages from the same sender", async () => {
    const secondMessage = {
      ...mockMessage,
      id: "msg-003",
      content: "Second top-level message",
      metadata: undefined,
    };
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage, secondMessage],
      unreadCount: 2,
      total: 2,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
      expect(screen.getByTestId("mailbox-item-msg-003")).toBeDefined();
      expect(screen.getByTestId("mailbox-unread-dot-msg-001")).toBeDefined();
      expect(screen.getByTestId("mailbox-unread-dot-msg-003")).toBeDefined();
    });
  });

  it("opens the specific selected inbox row when same-sender messages are separate", async () => {
    const secondMessage: Message = {
      ...mockMessage,
      id: "msg-003",
      content: "Second top-level message",
      createdAt: new Date(Date.now() + 1000).toISOString(),
    };

    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage, secondMessage],
      unreadCount: 2,
      total: 2,
    });
    mockFetchConversation.mockResolvedValue([secondMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...secondMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-003")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-003"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent("Second top-level message");
      expect(mockMarkMessageRead).toHaveBeenCalledWith("msg-003", undefined);
    });
  });

  it("shows unread dot for unread messages", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-unread-dot-msg-001")).toBeDefined();
    });
  });

  it("does not show unread dot for read messages", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockReadMessage],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-unread-dot-msg-002")).toBeNull();
    });
  });

  it("switches to outbox tab on click", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });
    mockFetchOutbox.mockResolvedValue({
      messages: [],
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const outboxTab = screen.getByTestId("mailbox-tab-outbox");
    await act(async () => {
      fireEvent.click(outboxTab);
    });

    expect(mockFetchOutbox).toHaveBeenCalled();
  });

  it("switches to agents tab on click", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const agentsTab = screen.getByTestId("mailbox-tab-agents");
    await act(async () => {
      fireEvent.click(agentsTab);
    });

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalled();
    });
  });

  it("opens message detail when clicking a message", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    // Mock markMessageRead to return undefined (simulating no read update needed)
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
    });
  });

  it("keeps list pane visible alongside detail pane on desktop/tablet", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-split-layout")).toBeDefined();
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
      expect(screen.queryByTestId("mailbox-back-to-list")).toBeNull();
    });
  });

  it("shows split-pane empty state when no message is selected on desktop/tablet", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-split-empty")).toBeDefined();
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });
  });

  it("applies visual viewport CSS variables when mobile keyboard is open", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 240,
      viewportHeight: 480,
      viewportOffsetTop: 32,
      keyboardOpen: true,
    });
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const mailboxView = await screen.findByTestId("mailbox-view");
    expect(mailboxView.getAttribute("style")).toContain("--vv-offset-top: 32px");
    expect(mailboxView.getAttribute("style")).toContain("--vv-height: 480px");
  });

  it("keeps mobile single-pane flow for detail open and back navigation", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-split-layout")).toBeNull();
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
      expect(screen.queryByTestId("mailbox-inbox-list")).toBeNull();
      expect(screen.getByTestId("mailbox-back-to-list")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-back-to-list"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });
  });

  it("shows agent names in message detail participant rows", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockAgentToAgentMessage],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([mockAgentToAgentMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-004")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-004"));
    });

    await waitFor(() => {
      expect(screen.getAllByText("Agent: Test Agent 1 (agent-001)").length).toBeGreaterThan(0);
      expect(screen.getByText("Agent: Test Agent 2 (agent-002)")).toBeDefined();
    });
  });

  it("marks message as read when opening unread message", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });
    mockFetchConversation.mockResolvedValue([mockMessage]);

    const onUnreadCountChange = vi.fn();
    render(<MailboxView {...defaultProps} onUnreadCountChange={onUnreadCountChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    });

    await waitFor(() => {
      expect(mockMarkMessageRead).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("calls markAllMessagesRead when clicking mark all read", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockMarkAllMessagesRead.mockResolvedValue({ markedAsRead: 1 });

    const onUnreadCountChange = vi.fn();
    render(<MailboxView {...defaultProps} onUnreadCountChange={onUnreadCountChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-mark-all-read")).toBeDefined();
    });

    const markAllReadButton = screen.getByTestId("mailbox-mark-all-read");
    expect(markAllReadButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    await act(async () => {
      fireEvent.click(markAllReadButton);
    });

    await waitFor(() => {
      expect(mockMarkAllMessagesRead).toHaveBeenCalledWith(undefined);
      expect(onUnreadCountChange).toHaveBeenCalledWith(0);
    });
  });

  it("deletes message when clicking delete in detail view", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockDeleteMessage.mockResolvedValue(undefined);
    mockFetchConversation.mockResolvedValue([mockMessage]);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
    });

    const deleteButton = screen.getByTestId("mailbox-delete");
    expect(screen.queryByTestId("mailbox-back-to-list")).toBeNull();
    expect(deleteButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    await act(async () => {
      fireEvent.click(deleteButton);
    });

    await waitFor(() => {
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("opens reply composer with linked reply context and sends metadata", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-reply")).toBeDefined();
    });

    const replyButton = screen.getByTestId("mailbox-reply");
    expect(replyButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    await act(async () => {
      fireEvent.click(replyButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-composer")).toBeDefined();
      expect(screen.getByTestId("message-composer-reply-context")).toBeDefined();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("message-composer-content"), { target: { value: "Thanks for the update." } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("message-composer-send"));
    });

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          toId: "agent-001",
          toType: "agent",
          type: "user-to-agent",
          metadata: { replyTo: { messageId: "msg-001" } },
        }),
        undefined,
      );
    });
  });

  it("renders reply context inside conversation thread", async () => {
    const agentMessage: Message = {
      ...mockMessage,
      id: "msg-thread-root",
      content: "Can you share your current status?",
    };
    const userReply: Message = {
      ...mockMessage,
      id: "msg-thread-reply",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-001",
      toType: "agent",
      type: "user-to-agent",
      content: "Status: still investigating",
      metadata: { replyTo: { messageId: "msg-thread-root" } },
      read: true,
    };

    mockFetchInbox.mockResolvedValue({
      messages: [agentMessage],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([agentMessage, userReply]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-thread-root")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-thread-root"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation")).toBeDefined();
      const replyContext = screen.getByTestId("mailbox-reply-context-msg-thread-reply");
      expect(replyContext).toBeDefined();
      expect(replyContext).toHaveClass("mailbox-reply-context-static");
      expect(screen.getByText(/Replying to Can you share your current status\?/)).toBeDefined();
    });
  });

  it("does not pull unrelated same-sender messages into selected detail thread", async () => {
    const root: Message = {
      ...mockMessage,
      id: "msg-thread-root-only",
      content: "Root request",
    };
    const unrelated: Message = {
      ...mockMessage,
      id: "msg-unrelated",
      content: "Independent update",
      createdAt: new Date(Date.now() + 10_000).toISOString(),
    };

    mockFetchInbox.mockResolvedValue({
      messages: [root],
      unreadCount: 1,
      total: 1,
    });
    mockFetchConversation.mockResolvedValue([root, unrelated]);
    mockMarkMessageRead.mockResolvedValue({ ...root, read: true });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-thread-root-only")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-thread-root-only"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-conversation")).toBeNull();
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent("Root request");
      expect(screen.queryByText("Independent update")).toBeNull();
    });
  });

  it("renders selected-message reply context with dedicated styling", async () => {
    const replyMessage: Message = {
      ...mockMessage,
      id: "msg-reply-single",
      content: "I have the answer now",
      metadata: { replyTo: { messageId: "msg-root-single" } },
      read: true,
    };

    mockFetchInbox.mockResolvedValue({
      messages: [replyMessage],
      unreadCount: 0,
      total: 0,
    });
    mockFetchConversation.mockResolvedValue([replyMessage]);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-reply-single")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-item-msg-reply-single"));
    });

    await waitFor(() => {
      const replyContext = screen.getByTestId("mailbox-selected-reply-context");
      expect(replyContext).toBeDefined();
      expect(replyContext).toHaveClass("mailbox-reply-context-static");
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent("I have the answer now");
    });
  });

  it("shows compose button in header on inbox tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-header-compose")).toBeDefined();
    });

    const headerComposeButton = screen.getByTestId("mailbox-header-compose");
    expect(headerComposeButton).toHaveClass("btn", "btn-sm", "btn-primary");
  });

  it("shows compose button in header on agents tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const agentsTab = screen.getByTestId("mailbox-tab-agents");
    await act(async () => {
      fireEvent.click(agentsTab);
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-header-compose")).toBeDefined();
    });
  });

  it("renders mailbox tabs and agent subtabs with shared button classes", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
      inbox: [],
      outbox: [],
    });

    render(<MailboxView {...defaultProps} />);

    expect(screen.getByTestId("mailbox-tab-inbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-tab");
    expect(screen.getByTestId("mailbox-tab-outbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-tab");
    expect(screen.getByTestId("mailbox-tab-agents")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-tab");

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    });

    fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
    });

    expect(screen.getByTestId("mailbox-agent-subtab-inbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-agent-subtab");
    expect(screen.getByTestId("mailbox-agent-subtab-outbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-agent-subtab");
  });

  it("shows loading skeleton while loading", async () => {
    mockFetchInbox.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-skeleton")).toBeDefined();
    });
  });

  it("shows empty inbox state when no messages", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-inbox-empty")).toBeDefined();
    });
  });

  it("passes projectId to API calls", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} projectId="test-project" />);

    await waitFor(() => {
      expect(mockFetchInbox).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
        "test-project"
      );
      expect(mockFetchUnreadCount).toHaveBeenCalledWith("test-project");
    });
  });

  it("passes projectId to fetchAgents in agents tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} projectId="test-project" />);

    // Switch to agents tab
    const agentsTab = screen.getByTestId("mailbox-tab-agents");
    await act(async () => {
      fireEvent.click(agentsTab);
    });

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "test-project");
    });
  });

  it("calls onUnreadCountChange when unread count changes", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 5,
      total: 5,
    });

    const onUnreadCountChange = vi.fn();
    render(<MailboxView {...defaultProps} onUnreadCountChange={onUnreadCountChange} />);

    await waitFor(() => {
      expect(onUnreadCountChange).toHaveBeenCalledWith(5);
    });
  });

  it("shows MessageComposer with agents when clicking compose button from header", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
      total: 0,
    });

    render(<MailboxView {...defaultProps} />);

    // Verify compose button is visible in header
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-header-compose")).toBeDefined();
    });

    // Click compose button
    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-header-compose"));
    });

    // Verify MessageComposer is shown
    await waitFor(() => {
      expect(screen.getByTestId("message-composer")).toBeDefined();
    });

    // Verify agents are available (not "No agents available")
    // The select should have agents as options, not just the placeholder
    const recipientSelect = screen.getByTestId("message-composer-recipient");
    expect(recipientSelect).toBeDefined();
    // Should have agents option, not just "No agents available" placeholder
    expect(screen.queryByText("No agents available")).toBeNull();
    // Should show the mock agents
    expect(screen.getByText("Test Agent 1")).toBeDefined();
    expect(screen.getByText("Test Agent 2")).toBeDefined();
  });

  describe("agent mailbox sub-tabs", () => {
    it("FN-4103 defaults the Agents tab selector to All agents without a placeholder", async () => {
      mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
      mockFetchAllAgentMailbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });

      render(<MailboxView {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
      });

      await waitFor(() => {
        expect(mockFetchAllAgentMailbox).toHaveBeenCalledWith(undefined);
      });

      const agentSelect = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
      expect(agentSelect.value).toBe("__all_agents__");

      const firstOption = agentSelect.options[0];
      expect(firstOption?.value).toBe("__all_agents__");
      expect(firstOption?.text).toBe("All agents");
      expect(screen.queryByText("Select an agent to view their mailbox")).toBeNull();
      expect(screen.getByText("No agent-to-agent messages")).toBeDefined();
    });

    it("shows All agents option and renders aggregate stream without subtabs", async () => {
      const aggregateMessage: Message = {
        ...mockAgentToAgentMessage,
        id: "msg-all-agents",
        fromId: "agent-001",
        toId: "agent-002",
        type: "agent-to-agent",
      };

      mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
      mockFetchAllAgentMailbox.mockResolvedValue({
        messages: [aggregateMessage],
        total: 1,
        unreadCount: 1,
      });
      mockFetchConversation.mockResolvedValue([aggregateMessage]);

      render(<MailboxView {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
      });

      await waitFor(() => {
        expect(mockFetchAllAgentMailbox).toHaveBeenCalledWith(undefined);
        expect(screen.queryByTestId("mailbox-agent-subtabs")).toBeNull();
        expect(screen.getByTestId("mailbox-item-participants-msg-all-agents")).toHaveTextContent("From: Agent: Test Agent 1 (agent-001)");
        expect(screen.getByTestId("mailbox-item-participants-msg-all-agents")).toHaveTextContent("To: Agent: Test Agent 2 (agent-002)");
      });
    });

    it("does not preselect a recipient when composing from All agents", async () => {
      mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
      mockFetchAllAgentMailbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });

      render(<MailboxView {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("mailbox-compose-btn"));
      });

      await waitFor(() => {
        const recipientSelect = screen.getByTestId("message-composer-recipient") as HTMLSelectElement;
        expect(recipientSelect.value).toBe("");
      });
    });

    it("refreshes all-agents mailbox on message SSE events", async () => {
      mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
      mockFetchAllAgentMailbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });

      render(<MailboxView {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
      });

      const latest = sseSubscriptions.at(-1);
      await act(async () => {
        latest?.["message:sent"]?.();
      });

      await waitFor(() => {
        expect(mockFetchAllAgentMailbox).toHaveBeenCalled();
      });
    });
    it("shows inbox and outbox sub-tabs when agent is selected", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
      total: 0,
      });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 1,
        messages: [mockMessage],
        inbox: [mockMessage],
        outbox: [],
      });

      render(<MailboxView {...defaultProps} />);

      // Switch to agents tab
      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalled();
      });

      // Select an agent
      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(mockFetchAgentMailbox).toHaveBeenCalledWith("agent-001", undefined);
      });

      // Sub-tabs should be visible
      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
        expect(screen.getByTestId("mailbox-agent-subtab-inbox")).toBeDefined();
        expect(screen.getByTestId("mailbox-agent-subtab-outbox")).toBeDefined();
      });

      const agentsComposeButton = screen.getByTestId("mailbox-compose-btn");
      expect(agentsComposeButton).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-compose-btn");
    });

    it("shows agent sender names in agent inbox rows", async () => {
      const agentInboxMessage: Message = {
        id: "msg-agent-inbox",
        fromId: "agent-002",
        fromType: "agent",
        toId: "agent-001",
        toType: "agent",
        content: "Hello from another agent",
        type: "agent-to-agent",
        read: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
      total: 0,
      });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 1,
        messages: [agentInboxMessage],
        inbox: [agentInboxMessage],
        outbox: [],
      });

      render(<MailboxView {...defaultProps} />);

      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByText("Agent: Test Agent 2 (agent-002)")).toBeDefined();
      });
    });

    it("does not mark agent inbox messages as read when the dashboard user opens them", async () => {
      const agentInboxMessage: Message = {
        id: "msg-agent-unread",
        fromId: "user-001",
        fromType: "user",
        toId: "agent-001",
        toType: "agent",
        content: "Important — please reply",
        type: "user-to-agent",
        read: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockFetchInbox.mockResolvedValue({ messages: [], unreadCount: 0, total: 0 });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 1,
        messages: [agentInboxMessage],
        inbox: [agentInboxMessage],
        outbox: [],
      });
      mockFetchConversation.mockResolvedValue([agentInboxMessage]);

      render(<MailboxView {...defaultProps} />);

      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-item-msg-agent-unread")).toBeDefined();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("mailbox-item-msg-agent-unread"));
      });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
      });

      // Critical: the dashboard user browsing an agent's mailbox MUST NOT
      // consume the agent's unread state — the agent's heartbeat is the
      // authoritative reader.
      expect(mockMarkMessageRead).not.toHaveBeenCalled();
    });

    it("switches to outbox view when clicking outbox sub-tab", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
      total: 0,
      });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 1,
        messages: [mockMessage],
        inbox: [mockMessage],
        outbox: [mockOutboxMessage],
      });

      render(<MailboxView {...defaultProps} />);

      // Switch to agents tab and select agent
      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
      });

      // Click outbox sub-tab
      const outboxTab = screen.getByTestId("mailbox-agent-subtab-outbox");
      await act(async () => {
        fireEvent.click(outboxTab);
      });

      // Should show outbox message (with "To:" label)
      await waitFor(() => {
        expect(screen.getByText("To: User: user-001")).toBeDefined();
      });
    });

    it("switches back to inbox view when clicking inbox sub-tab", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
      total: 0,
      });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 0,
        messages: [mockOutboxMessage],
        inbox: [],
        outbox: [mockOutboxMessage],
      });

      render(<MailboxView {...defaultProps} />);

      // Switch to agents tab and select agent
      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
      });

      // Click outbox first (default should be inbox)
      const outboxTab = screen.getByTestId("mailbox-agent-subtab-outbox");
      await act(async () => {
        fireEvent.click(outboxTab);
      });

      await waitFor(() => {
        expect(screen.getByText("To: User: user-001")).toBeDefined();
      });

      // Click inbox sub-tab
      const inboxTab = screen.getByTestId("mailbox-agent-subtab-inbox");
      await act(async () => {
        fireEvent.click(inboxTab);
      });

      // Should show empty inbox state
      await waitFor(() => {
        expect(screen.getByText("No received messages for this agent")).toBeDefined();
      });
    });

    it("resets sub-tab to inbox when switching agents", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
      total: 0,
      });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 0,
        messages: [],
        inbox: [],
        outbox: [mockOutboxMessage],
      });

      render(<MailboxView {...defaultProps} />);

      // Switch to agents tab
      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      // Select first agent
      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
      });

      // Switch to outbox
      const outboxTab = screen.getByTestId("mailbox-agent-subtab-outbox");
      await act(async () => {
        fireEvent.click(outboxTab);
      });

      await waitFor(() => {
        expect(screen.getByText("To: User: user-001")).toBeDefined();
      });

      // Switch to second agent - should reset to inbox
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-002",
        ownerType: "agent",
        unreadCount: 1,
        messages: [mockMessage],
        inbox: [mockMessage],
        outbox: [],
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-002" } });

      await waitFor(() => {
        // Should be on inbox (default) with the message
        expect(screen.getByTestId("mailbox-agent-subtab-inbox")).toHaveClass("active");
      });
    });

    it("shows unread count badge on inbox sub-tab when agent has unread messages", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
      total: 0,
      });
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 3,
        messages: [mockMessage],
        inbox: [mockMessage],
        outbox: [],
      });

      render(<MailboxView {...defaultProps} />);

      // Switch to agents tab and select agent
      const agentsTab = screen.getByTestId("mailbox-tab-agents");
      await act(async () => {
        fireEvent.click(agentsTab);
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        const inboxTab = screen.getByTestId("mailbox-agent-subtab-inbox");
        expect(inboxTab.querySelector(".mailbox-tab-badge")?.textContent).toBe("3");
      });
    });
  });

  describe("resizable split pane", () => {
    it("renders a desktop resize handle with separator aria semantics", async () => {
      mockUseViewportMode.mockReturnValue("desktop");
      mockFetchInbox.mockResolvedValue(makeInboxResponse([mockMessage], 1));

      render(<MailboxView {...defaultProps} projectId="proj-resize" />);

      const handle = await screen.findByTestId("mailbox-split-resize-handle");
      expect(handle.getAttribute("role")).toBe("separator");
      expect(handle.getAttribute("aria-orientation")).toBe("vertical");
      expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    });

    it("does not render the resize handle on mobile", async () => {
      mockUseViewportMode.mockReturnValue("mobile");
      mockFetchInbox.mockResolvedValue(makeInboxResponse([mockMessage], 1));

      render(<MailboxView {...defaultProps} />);

      await screen.findByTestId("mailbox-view");
      expect(screen.queryByTestId("mailbox-split-resize-handle")).toBeNull();
    });

    it("supports keyboard resize and Home/End clamping", async () => {
      mockUseViewportMode.mockReturnValue("desktop");
      mockFetchInbox.mockResolvedValue(makeInboxResponse([mockMessage], 1));

      render(<MailboxView {...defaultProps} projectId="proj-keys" />);

      const handle = await screen.findByTestId("mailbox-split-resize-handle");
      const initial = Number(handle.getAttribute("aria-valuenow"));

      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      const afterLeft = Number(handle.getAttribute("aria-valuenow"));
      expect(afterLeft).toBeLessThan(initial);

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      const afterRight = Number(handle.getAttribute("aria-valuenow"));
      expect(afterRight).toBeGreaterThanOrEqual(afterLeft);

      // FNXC:Mailbox 2026-06-22-18:05: Home clamps to MAILBOX_SIDEBAR_MIN_WIDTH (locked at 180); End clamps to the container max ratio.
      fireEvent.keyDown(handle, { key: "Home" });
      expect(Number(handle.getAttribute("aria-valuenow"))).toBe(180);

      fireEvent.keyDown(handle, { key: "End" });
      expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(180);
    });

    it("persists and restores scoped mailbox sidebar width", async () => {
      mockUseViewportMode.mockReturnValue("desktop");
      mockFetchInbox.mockResolvedValue(makeInboxResponse([mockMessage], 1));

      const projectId = "proj-persist";
      const storageKey = `kb:${projectId}:kb-dashboard-mailbox-sidebar-width`;
      window.localStorage.setItem(storageKey, "360");

      const { unmount } = render(<MailboxView {...defaultProps} projectId={projectId} />);

      const handle = await screen.findByTestId("mailbox-split-resize-handle");
      expect(Number(handle.getAttribute("aria-valuenow"))).toBe(360);

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      await waitFor(() => {
        const savedWidth = Number(window.localStorage.getItem(storageKey));
        expect(savedWidth).toBeGreaterThan(360);
      });

      unmount();
      render(<MailboxView {...defaultProps} projectId={projectId} />);
      const remountedHandle = await screen.findByTestId("mailbox-split-resize-handle");
      const persistedWidth = Number(window.localStorage.getItem(storageKey));
      expect(Number(remountedHandle.getAttribute("aria-valuenow"))).toBe(Math.round(persistedWidth));
    });
  });

  describe("mobile layout CSS regressions", () => {
    it("defines .mailbox-view base flex layout with min-height: 0", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      const viewBlockMatch = css.match(/\.mailbox-view\s*\{([^}]*)\}/);
      expect(viewBlockMatch).toBeTruthy();
      const viewBlock = viewBlockMatch![1];
      expect(viewBlock).toContain("display: flex;");
      expect(viewBlock).toContain("flex-direction: column;");
      expect(viewBlock).toContain("height: 100%;");
      expect(viewBlock).toContain("min-height: 0;");
      expect(viewBlock).toContain("overflow: hidden;");
    });

    it("defines .mailbox-view .mailbox-content as a bounded flex child", async () => {
      const css = loadAllAppCss();

      const contentBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-content\s*\{([^}]*)\}/);
      expect(contentBlockMatch).toBeTruthy();
      const contentBlock = contentBlockMatch![1];
      expect(contentBlock).toContain("flex: 1;");
      expect(contentBlock).toContain("min-height: 0;");
      expect(contentBlock).toContain("overflow-y: auto;");
      expect(contentBlock).toContain("max-height: none;");
    });

    it("defines desktop/tablet split-pane selectors under .mailbox-view scope", async () => {
      const css = loadAllAppCss();

      // FNXC:Mailbox 2026-06-22-18:05: split layout is a flex row so the list pane's inline width is honored (drag-resizable); grid `auto` tracks ignored it.
      expect(css).toMatch(/\.mailbox-view\s+\.mailbox-split-layout\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*row;[^}]*gap:\s*0;[^}]*min-height:\s*0;[^}]*\}/);

      const splitPaneBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-split-list-pane,\s*\n\.mailbox-view\s+\.mailbox-split-detail-pane\s*\{([^}]*)\}/);
      expect(splitPaneBlockMatch).toBeTruthy();
      const splitPaneBlock = splitPaneBlockMatch![1];
      expect(splitPaneBlock).toContain("overflow-y: auto;");
      expect(splitPaneBlock).toContain("border: var(--btn-border-width) solid var(--border);");
      expect(splitPaneBlock).toContain("background: var(--surface);");

      // FNXC:Mailbox 2026-06-22-18:05: list pane fixed to inline width; detail pane fills remainder and may shrink below content.
      const listPaneBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-split-list-pane\s*\{([^}]*)\}/);
      expect(listPaneBlockMatch).toBeTruthy();
      expect(listPaneBlockMatch![1]).toContain("flex: 0 0 auto;");

      // Match the standalone detail-pane rule (the one declaring `display: flex;`), not the shared border/background block.
      const detailPaneBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-split-detail-pane\s*\{([^}]*display:\s*flex;[^}]*)\}/);
      expect(detailPaneBlockMatch).toBeTruthy();
      expect(detailPaneBlockMatch![1]).toContain("flex: 1 1 auto;");
      expect(detailPaneBlockMatch![1]).toContain("min-width: 0;");

      const resizeHandleBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-split-resize-handle\s*\{([^}]*)\}/);
      expect(resizeHandleBlockMatch).toBeTruthy();
      const resizeHandleBlock = resizeHandleBlockMatch![1];
      // FNXC:Mailbox 2026-06-22-18:20: handle mirrors the Chat sidebar divider — hit area var(--space-sm), transparent until hover, centered var(--space-xs) line.
      expect(resizeHandleBlock).toContain("width: var(--space-sm);");
      expect(resizeHandleBlock).toContain("cursor: col-resize;");
      expect(resizeHandleBlock).toContain("background: transparent;");

      const resizeHandleTargetBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-split-resize-handle::before\s*\{([^}]*)\}/);
      expect(resizeHandleTargetBlockMatch).toBeTruthy();
      expect(resizeHandleTargetBlockMatch![1]).toContain("width: var(--space-xs);");
      expect(css).toMatch(/\.mailbox-view\s+\.mailbox-split-resize-handle:hover::before,\s*\n\.mailbox-view\s+\.mailbox-split-resize-handle:active::before\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--todo\)\s*35%,\s*transparent\);[^}]*\}/);

      const splitEmptyBlockMatch = css.match(/\.mailbox-view\s+\.mailbox-split-empty\s*\{([^}]*)\}/);
      expect(splitEmptyBlockMatch).toBeTruthy();
      expect(splitEmptyBlockMatch![1]).toContain("color: var(--text-muted);");
      expect(splitEmptyBlockMatch![1]).toContain("color-mix");
    });

    it("keeps mobile .mailbox-view overrides in the dedicated media-query section", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      const sectionStart = css.indexOf("/* ── Mailbox — Mobile");
      expect(sectionStart).toBeGreaterThan(-1);

      const sectionEnd = css.indexOf("/* ── Message Composer", sectionStart);
      expect(sectionEnd).toBeGreaterThan(sectionStart);

      const mailboxMobileSection = css.slice(sectionStart, sectionEnd);

      expect(mailboxMobileSection).toContain("@media (max-width: 768px)");
      // Verify .mailbox-view selectors are in mobile section
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-header");
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions,\s*\.mailbox-view \.mailbox-header-actions\s*\{[^}]*gap:\s*var\(--space-sm\);[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.btn,[^}]*\.mailbox-view \.mailbox-header-actions \.btn-icon\s*\{[^}]*min-height:\s*2\.25rem;[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.btn-icon,[^}]*\.mailbox-view \.mailbox-header-actions \.btn-icon\s*\{[^}]*min-width:\s*2\.25rem;[^}]*display:\s*inline-flex;[^}]*\}/);
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-tabs");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-content");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-split-layout");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-split-list-pane");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-split-detail-pane");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-split-resize-handle");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-empty");
      expect(mailboxMobileSection).toMatch(/\.mailbox-view\s+\.mailbox-split-resize-handle\s*\{[^}]*display:\s*none;[^}]*\}/);
    });

    it("uses mobile-specific values for .mailbox-view content and FAB", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      const sectionStart = css.indexOf("/* ── Mailbox — Mobile");
      expect(sectionStart).toBeGreaterThan(-1);

      const sectionEnd = css.indexOf("/* ── Message Composer", sectionStart);
      const mailboxMobileSection = css.slice(sectionStart, sectionEnd);

      // Content should have max-height: none (not modal's calc)
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-content");
      // Match descendant selector: .mailbox-view followed by space, then .mailbox-content
      const contentRuleMatch = mailboxMobileSection.match(/\.mailbox-view\s+\.mailbox-content\s*\{[^}]*\}/);
      expect(contentRuleMatch).toBeTruthy();
      expect(contentRuleMatch![0]).toContain("max-height: none");
      expect(contentRuleMatch![0]).toContain("overflow-y: auto");
      expect(contentRuleMatch![0]).toContain("min-height: 0");
      expect(contentRuleMatch![0]).toContain("overscroll-behavior: contain");
      expect(contentRuleMatch![0]).toContain("-webkit-overflow-scrolling: touch");

      // Content should have padding-bottom accounting for mobile nav
      expect(contentRuleMatch![0]).toContain("padding-bottom");

    });

    it("keeps mailbox tab selectors aligned with shared rounded-button defaults", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      expect(css).toMatch(/\.mailbox-tab\s*\{[^}]*border-color:\s*var\(--border\);[^}]*background:\s*var\(--surface\);[^}]*\}/);
      expect(css).not.toMatch(/\.mailbox-tab\s*\{[^}]*border:\s*none;[^}]*\}/);
      expect(css).not.toMatch(/\.mailbox-tab\s*\{[^}]*background:\s*none;[^}]*\}/);
      expect(css).not.toMatch(/\.mailbox-tab\s*\{[^}]*border-bottom:\s*2px\s+solid\s+transparent;[^}]*\}/);

      expect(css).toMatch(/\.mailbox-agent-subtab\s*\{[^}]*border-color:\s*var\(--border\);[^}]*background:\s*var\(--surface\);[^}]*\}/);
      expect(css).not.toMatch(/\.mailbox-agent-subtab\s*\{[^}]*border-radius:\s*0;[^}]*\}/);
      expect(css).not.toMatch(/\.mailbox-agent-subtab\s*\{[^}]*border:\s*none;[^}]*\}/);
      expect(css).not.toMatch(/\.mailbox-agent-subtab\s*\{[^}]*background:\s*transparent;[^}]*\}/);
    });

    it("includes keyboard-overlap viewport anchoring rules for mailbox containers", async () => {
      const css = loadAllAppCss();

      expect(css).toContain('.mailbox-view[style*="--keyboard-overlap"],');
      expect(css).toContain('.mailbox-modal[style*="--keyboard-overlap"]');
      expect(css).toContain("height: var(--vv-height, 100dvh);");
      expect(css).toContain("transform: translateY(var(--vv-offset-top, 0px));");
    });

    it("preserves mobile mailbox scroll after SSE refreshes inbox data", async () => {
      mockUseViewportMode.mockReturnValue("mobile");
      const originalRequestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }) as typeof window.requestAnimationFrame;
      mockFetchInbox
        .mockResolvedValueOnce(makeInboxResponse([mockMessage], 1))
        .mockResolvedValueOnce(makeInboxResponse([{ ...mockReadMessage, id: "msg-sse", content: "Message refreshed by SSE" }], 0));
      mockFetchUnreadCount.mockResolvedValue({ unreadCount: 0 });

      try {
        render(<MailboxView {...defaultProps} />);
        await screen.findByText("Hello, this is a test message from the agent.");

        const content = screen.getByTestId("mailbox-content");
        content.scrollTop = 144;

        const latest = sseSubscriptions.at(-1);
        expect(latest).toBeDefined();
        await act(async () => {
          latest?.["message:received"]?.();
        });

        await waitFor(() => {
          expect(screen.getByText("Message refreshed by SSE")).toBeDefined();
        });
        expect(content.scrollTop).toBe(144);
      } finally {
        window.requestAnimationFrame = originalRequestAnimationFrame;
      }
    });

    it("renders structural elements that mobile CSS targets", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [mockMessage],
        unreadCount: 1,
      total: 1,
      });

      const { container } = render(<MailboxView {...defaultProps} />);

      // Verify root element with data-testid
      expect(screen.getByTestId("mailbox-view")).toBeDefined();

      // FNXC:Navigation 2026-06-22-01:10: MailboxView migrated its bespoke
      // .mailbox-header to the shared ViewHeader (.view-header) modeled after
      // Command Center; assert the shared header element with the Mailbox title.
      const header = container.querySelector(".view-header");
      expect(header).toBeTruthy();
      expect(header?.querySelector(".view-header__title")?.textContent).toContain("Mailbox");

      // Verify tabs
      const tabs = container.querySelector(".mailbox-tabs");
      expect(tabs).toBeTruthy();

      // Verify content
      const content = container.querySelector(".mailbox-content");
      expect(content).toBeTruthy();
    });

    it("highlights deep-linked mailbox message from URL", async () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      window.history.replaceState({}, "", "?view=mailbox&mailbox-message=msg-001#message-msg-001");

      mockFetchInbox.mockResolvedValue(makeInboxResponse([mockMessage], 1));
      mockFetchConversation.mockResolvedValue([mockMessage]);

      render(<MailboxView {...defaultProps} />);

      const messageNode = await screen.findByTestId("mailbox-message-detail");
      await waitFor(() => {
        expect(messageNode).toHaveAttribute("id", "mailbox-detail-message-msg-001");
        expect(messageNode).toHaveClass("mailbox-message-highlight");
      });
      expect(scrollIntoView).toHaveBeenCalled();
    });
  });
});
