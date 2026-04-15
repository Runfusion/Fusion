import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MailboxView } from "../MailboxView";
import * as apiModule from "../../api";
import type { Agent } from "../../api";
import type { Message } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchInbox: vi.fn(),
  fetchOutbox: vi.fn(),
  fetchUnreadCount: vi.fn(),
  fetchAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(),
  markAllMessagesRead: vi.fn(),
  deleteMessage: vi.fn(),
  fetchConversation: vi.fn(),
  sendMessage: vi.fn(),
  fetchAgents: vi.fn(),
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
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockMarkMessageRead = vi.mocked(apiModule.markMessageRead);
const mockMarkAllMessagesRead = vi.mocked(apiModule.markAllMessagesRead);
const mockDeleteMessage = vi.mocked(apiModule.deleteMessage);
const mockFetchConversation = vi.mocked(apiModule.fetchConversation);

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

const defaultProps = {
  addToast: vi.fn(),
};

describe("MailboxView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 2 });
    mockFetchAgents.mockResolvedValue(mockAgents);
  });

  it("renders the mailbox view", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
    });

    render(<MailboxView {...defaultProps} />);

    expect(screen.getByTestId("mailbox-view")).toBeDefined();
    expect(screen.getByTestId("mailbox-tabs")).toBeDefined();
  });

  it("shows the Mailbox title with unread count badge", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-unread-badge")).toBeDefined();
    });
  });

  it("renders all three tabs", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
    });

    render(<MailboxView {...defaultProps} />);

    expect(screen.getByTestId("mailbox-tab-inbox")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-outbox")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-agents")).toBeDefined();
  });

  it("shows inbox tab as active by default", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const inboxTab = screen.getByTestId("mailbox-tab-inbox");
    expect(inboxTab).toHaveClass("active");
  });

  it("loads inbox on mount", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage, mockReadMessage],
      unreadCount: 1,
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
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversations")).toBeDefined();
    });
  });

  it("groups messages by sender and shows unread count per group", async () => {
    const secondMessage = { ...mockMessage, id: "msg-003", read: false };
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage, secondMessage], // Same sender, both unread
      unreadCount: 2,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      // Should show one conversation group with 2 unread
      const group = screen.getByTestId("mailbox-conversation-agent:agent-001");
      expect(group).toBeDefined();
      expect(screen.getByTestId("mailbox-unread-badge-agent:agent-001")).toBeDefined();
    });
  });

  it("shows unread dot for unread messages", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-unread-badge-agent:agent-001")).toBeDefined();
    });
  });

  it("does not show unread dot for read messages", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockReadMessage],
      unreadCount: 0,
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
    });
    mockFetchOutbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
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
    });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    // Mock markMessageRead to return undefined (simulating no read update needed)
    mockMarkMessageRead.mockResolvedValue(undefined);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
    });
  });

  it("marks message as read when opening unread message", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
    });
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });
    mockFetchConversation.mockResolvedValue([mockMessage]);

    const onUnreadCountChange = vi.fn();
    render(<MailboxView {...defaultProps} onUnreadCountChange={onUnreadCountChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
    });

    await waitFor(() => {
      expect(mockMarkMessageRead).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("calls markAllMessagesRead when clicking mark all read", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
    });
    mockMarkAllMessagesRead.mockResolvedValue({ markedAsRead: 1 });

    const onUnreadCountChange = vi.fn();
    render(<MailboxView {...defaultProps} onUnreadCountChange={onUnreadCountChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-mark-all-read")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-mark-all-read"));
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
    });
    mockDeleteMessage.mockResolvedValue(undefined);
    mockFetchConversation.mockResolvedValue([mockMessage]);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-delete"));
    });

    await waitFor(() => {
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("shows compose FAB in inbox tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-compose-fab")).toBeDefined();
    });
  });

  it("does not show compose FAB in agents tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
    });

    render(<MailboxView {...defaultProps} />);

    const agentsTab = screen.getByTestId("mailbox-tab-agents");
    await act(async () => {
      fireEvent.click(agentsTab);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-compose-fab")).toBeNull();
    });
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

  it("calls onUnreadCountChange when unread count changes", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 5,
    });

    const onUnreadCountChange = vi.fn();
    render(<MailboxView {...defaultProps} onUnreadCountChange={onUnreadCountChange} />);

    await waitFor(() => {
      expect(onUnreadCountChange).toHaveBeenCalledWith(5);
    });
  });
});
