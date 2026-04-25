import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
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
const mockSendMessage = vi.mocked(apiModule.sendMessage);

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

describe("MailboxView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 2 });
    mockFetchAgents.mockResolvedValue(mockAgents);
    mockSendMessage.mockResolvedValue({ ...mockMessage, id: "msg-sent" });
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

  it("renders known agent senders by name in inbox conversation rows", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockMessage],
      unreadCount: 1,
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
    });

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Agent: agent-999")).toBeDefined();
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

  it("shows agent names in message detail participant rows", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [mockAgentToAgentMessage],
      unreadCount: 1,
    });
    mockFetchConversation.mockResolvedValue([mockAgentToAgentMessage]);
    mockMarkMessageRead.mockResolvedValue(undefined);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
    });

    await waitFor(() => {
      expect(screen.getByText("Agent: Test Agent 1 (agent-001)")).toBeDefined();
      expect(screen.getByText("Agent: Test Agent 2 (agent-002)")).toBeDefined();
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

    const backToListButton = screen.getByTestId("mailbox-back-to-list");
    const deleteButton = screen.getByTestId("mailbox-delete");
    expect(backToListButton).toHaveClass("btn", "btn-sm", "btn-secondary");
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
    });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockResolvedValue(undefined);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
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
    });
    mockFetchConversation.mockResolvedValue([agentMessage, userReply]);
    mockMarkMessageRead.mockResolvedValue(undefined);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation")).toBeDefined();
      const replyContext = screen.getByTestId("mailbox-reply-context-msg-thread-reply");
      expect(replyContext).toBeDefined();
      expect(replyContext).toHaveClass("mailbox-reply-context");
      expect(screen.getByText(/Replying to Can you share your current status\?/)).toBeDefined();
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
    });
    mockFetchConversation.mockResolvedValue([replyMessage]);

    render(<MailboxView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-conversation-agent:agent-001")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-conversation-agent:agent-001"));
    });

    await waitFor(() => {
      const replyContext = screen.getByTestId("mailbox-selected-reply-context");
      expect(replyContext).toBeDefined();
      expect(replyContext).toHaveClass("mailbox-reply-context");
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent("I have the answer now");
    });
  });

  it("shows compose button in header on inbox tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
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

  it("passes projectId to fetchAgents in agents tab", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [],
      unreadCount: 0,
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
    it("shows inbox and outbox sub-tabs when agent is selected", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
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

    it("switches to outbox view when clicking outbox sub-tab", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [],
        unreadCount: 0,
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
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-tabs");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-content");
      expect(mailboxMobileSection).toContain(".mailbox-view .mailbox-empty");
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

      // Content should have padding-bottom accounting for mobile nav
      expect(contentRuleMatch![0]).toContain("padding-bottom");

    });

    it("keeps mailbox tab selectors aligned with shared rounded-button defaults", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      const mailboxTabBlockMatch = css.match(/\.mailbox-tab\s*\{([^}]*)\}/);
      expect(mailboxTabBlockMatch).toBeTruthy();
      const mailboxTabBlock = mailboxTabBlockMatch![1];
      expect(mailboxTabBlock).toContain("border-color: var(--border);");
      expect(mailboxTabBlock).toContain("background: var(--surface);");
      expect(mailboxTabBlock).not.toContain("border: none");
      expect(mailboxTabBlock).not.toContain("background: none");
      expect(mailboxTabBlock).not.toContain("border-bottom: 2px solid transparent");

      const agentSubtabBlockMatch = css.match(/\.mailbox-agent-subtab\s*\{([^}]*)\}/);
      expect(agentSubtabBlockMatch).toBeTruthy();
      const agentSubtabBlock = agentSubtabBlockMatch![1];
      expect(agentSubtabBlock).toContain("border-color: var(--border);");
      expect(agentSubtabBlock).toContain("background: var(--surface);");
      expect(agentSubtabBlock).not.toContain("border-radius: 0");
      expect(agentSubtabBlock).not.toContain("border: none");
      expect(agentSubtabBlock).not.toContain("background: transparent");
    });

    it("renders structural elements that mobile CSS targets", async () => {
      mockFetchInbox.mockResolvedValue({
        messages: [mockMessage],
        unreadCount: 1,
      });

      const { container } = render(<MailboxView {...defaultProps} />);

      // Verify root element with data-testid
      expect(screen.getByTestId("mailbox-view")).toBeDefined();

      // Verify header
      const header = container.querySelector(".mailbox-header");
      expect(header).toBeTruthy();

      // Verify tabs
      const tabs = container.querySelector(".mailbox-tabs");
      expect(tabs).toBeTruthy();

      // Verify content
      const content = container.querySelector(".mailbox-content");
      expect(content).toBeTruthy();
    });
  });
});
