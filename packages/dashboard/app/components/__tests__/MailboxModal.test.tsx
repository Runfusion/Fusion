import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MailboxModal } from "../MailboxModal";
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

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  addToast: vi.fn(),
  agents: mockAgents,
};

describe("MailboxModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchInbox.mockResolvedValue({ messages: [mockMessage, mockReadMessage], total: 2, unreadCount: 1 });
    mockFetchOutbox.mockResolvedValue({ messages: [], total: 0 });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });
    mockMarkAllMessagesRead.mockResolvedValue({ markedAsRead: 1 });
    mockDeleteMessage.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue({ ...mockMessage, id: "msg-sent" });
  });

  it("renders nothing when isOpen is false", () => {
    render(<MailboxModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByTestId("mailbox-modal")).toBeNull();
  });

  it("renders the modal when isOpen is true", () => {
    render(<MailboxModal {...defaultProps} />);
    expect(screen.getByTestId("mailbox-modal")).toBeDefined();
  });

  it("shows the Mailbox title with unread count badge", async () => {
    render(<MailboxModal {...defaultProps} />);
    expect(screen.getByText("Mailbox")).toBeDefined();
    // Wait for inbox to load which sets unreadCount
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-unread-badge")).toBeDefined();
    });
    expect(screen.getByTestId("mailbox-unread-badge").textContent).toBe("1");
  });

  it("renders all three tabs", () => {
    render(<MailboxModal {...defaultProps} />);
    expect(screen.getByTestId("mailbox-tab-inbox")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-outbox")).toBeDefined();
    expect(screen.getByTestId("mailbox-tab-agents")).toBeDefined();
  });

  it("shows inbox tab as active by default", () => {
    render(<MailboxModal {...defaultProps} />);
    const inboxTab = screen.getByTestId("mailbox-tab-inbox");
    expect(inboxTab.classList.contains("active")).toBe(true);
  });

  it("loads inbox on mount", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(mockFetchInbox).toHaveBeenCalledWith({ limit: 50 }, undefined);
    });
  });

  it("shows inbox messages after loading", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });
    // Should show both messages
    expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    expect(screen.getByTestId("mailbox-item-msg-002")).toBeDefined();
  });

  it("shows unread dot for unread messages", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-unread-dot-msg-001")).toBeDefined();
    });
  });

  it("does not show unread dot for read messages", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-002")).toBeDefined();
    });
    expect(screen.queryByTestId("mailbox-unread-dot-msg-002")).toBeNull();
  });

  it("switches to outbox tab on click", async () => {
    render(<MailboxModal {...defaultProps} />);
    const outboxTab = screen.getByTestId("mailbox-tab-outbox");
    fireEvent.click(outboxTab);
    await waitFor(() => {
      expect(mockFetchOutbox).toHaveBeenCalledWith({ limit: 50 }, undefined);
    });
  });

  it("shows empty state for empty outbox", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-outbox-empty")).toBeDefined();
    });
  });

  it("switches to agents tab on click", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agents")).toBeDefined();
    });
  });

  it("shows agent dropdown in agents tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
    });
    // Should have placeholder plus two agent options
    const select = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
    expect(select.options.length).toBe(3); // placeholder + 2 agents
    expect(select.options[0].textContent).toBe("Select an agent…");
    expect(select.options[1].textContent).toBe("Test Agent 1");
    expect(select.options[2].textContent).toBe("Test Agent 2");
  });

  it("shows Select an agent… placeholder in dropdown", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      const select = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(select.options[0].textContent).toBe("Select an agent…");
    });
  });

  it("loads agent mailbox when selecting an agent from dropdown", async () => {
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
      inbox: [],
      outbox: [],
    });
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
    });
    fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });
    await waitFor(() => {
      expect(mockFetchAgentMailbox).toHaveBeenCalledWith("agent-001", undefined);
    });
  });

  it("shows empty state when no agents exist", async () => {
    render(<MailboxModal {...defaultProps} agents={[]} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByText("No agents found")).toBeDefined();
    });
  });

  it("opens message detail when clicking a message", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toBeDefined();
    });
  });

  it("marks message as read when opening unread message", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    await waitFor(() => {
      expect(mockMarkMessageRead).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("shows back button in message detail", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-back-to-list")).toBeDefined();
    });
  });

  it("returns to list when clicking back button", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-back-to-list")).toBeDefined();
    });

    const backToListButton = screen.getByTestId("mailbox-back-to-list");
    expect(backToListButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    fireEvent.click(backToListButton);
    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
      expect(screen.getByTestId("mailbox-inbox-list")).toBeDefined();
    });
  });

  it("shows mark all read button when there are unread messages", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-mark-all-read")).toBeDefined();
    });
  });

  it("calls markAllMessagesRead when clicking mark all read", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-mark-all-read")).toBeDefined();
    });

    const markAllReadButton = screen.getByTestId("mailbox-mark-all-read");
    expect(markAllReadButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    fireEvent.click(markAllReadButton);
    await waitFor(() => {
      expect(mockMarkAllMessagesRead).toHaveBeenCalledWith(undefined);
    });
  });

  it("deletes message when clicking delete in detail view", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-delete")).toBeDefined();
    });

    const deleteButton = screen.getByTestId("mailbox-delete");
    expect(deleteButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("opens reply composer with linked reply context and sends metadata", async () => {
    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-reply")).toBeDefined();
    });

    const replyButton = screen.getByTestId("mailbox-reply");
    expect(replyButton).toHaveClass("btn", "btn-sm", "btn-secondary");

    fireEvent.click(replyButton);

    await waitFor(() => {
      expect(screen.getByTestId("message-composer")).toBeDefined();
      expect(screen.getByTestId("message-composer-reply-context")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Acknowledged." },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));

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

  it("renders reply context inside modal conversation thread", async () => {
    const root: Message = {
      ...mockMessage,
      id: "msg-root",
      content: "Need a status update.",
    };
    const reply: Message = {
      ...mockMessage,
      id: "msg-reply",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-001",
      toType: "agent",
      type: "user-to-agent",
      content: "Status shared.",
      read: true,
      metadata: { replyTo: { messageId: "msg-root" } },
    };

    mockFetchInbox.mockResolvedValue({ messages: [root], total: 1, unreadCount: 1 });
    mockFetchConversation.mockResolvedValue([root, reply]);

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-root")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-root"));

    await waitFor(() => {
      const replyContext = screen.getByTestId("mailbox-reply-context-msg-reply");
      expect(replyContext).toBeDefined();
      expect(replyContext).toHaveClass("mailbox-reply-context");
      expect(screen.getByText(/Replying to Need a status update\./)).toBeDefined();
    });
  });

  it("shows compose button in header on inbox tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-header-compose")).toBeDefined();
    });

    const headerComposeButton = screen.getByTestId("mailbox-header-compose");
    expect(headerComposeButton).toHaveClass("btn", "btn-sm", "btn-primary");
  });

  it("shows compose button in header on agents tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-header-compose")).toBeDefined();
    });
  });

  it("renders mailbox tabs and agent subtabs with shared button classes", async () => {
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
      inbox: [],
      outbox: [],
    });

    render(<MailboxModal {...defaultProps} />);

    expect(screen.getByTestId("mailbox-tab-inbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-tab");
    expect(screen.getByTestId("mailbox-tab-outbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-tab");
    expect(screen.getByTestId("mailbox-tab-agents")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-tab");

    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
    });

    expect(screen.getByTestId("mailbox-agent-subtab-inbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-agent-subtab");
    expect(screen.getByTestId("mailbox-agent-subtab-outbox")).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-agent-subtab");
  });

  it("shows compose button in Agents tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-compose-btn")).toBeDefined();
    });

    const agentsComposeButton = screen.getByTestId("mailbox-compose-btn");
    expect(agentsComposeButton).toHaveClass("btn", "btn-sm", "btn-secondary", "mailbox-compose-btn");
  });

  it("compose opened from Agents tab without selected agent shows recipient select", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-compose-btn")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-compose-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("message-composer")).toBeDefined();
    });
    // Should show recipient dropdown (not pre-filled)
    expect(screen.getByTestId("message-composer-recipient")).toBeDefined();
  });

  it("compose opened from Agents tab pre-fills selected agent recipient", async () => {
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
      inbox: [],
      outbox: [],
    });
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
    });
    // Select an agent
    fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });
    await waitFor(() => {
      expect(mockFetchAgentMailbox).toHaveBeenCalledWith("agent-001", undefined);
    });
    // Click compose
    fireEvent.click(screen.getByTestId("mailbox-compose-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("message-composer")).toBeDefined();
    });
    // Should show pre-filled recipient (not dropdown)
    expect(screen.getByText("agent-001")).toBeDefined();
  });

  it("successful send from Agents tab keeps user on Agents tab and preserves selected agent", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
    });
    // Select an agent
    fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });
    await waitFor(() => {
      expect(mockFetchAgentMailbox).toHaveBeenCalledWith("agent-001", undefined);
    });
    // Open compose (pre-filled)
    fireEvent.click(screen.getByTestId("mailbox-compose-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("message-composer")).toBeDefined();
    });
    // Type and send message
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Hello agent!" },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => {
      expect(screen.queryByTestId("message-composer")).toBeNull();
    });
    // Verify still on Agents tab and agent is still selected
    expect(screen.getByTestId("mailbox-agents")).toBeDefined();
    const select = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
    expect(select.value).toBe("agent-001");
  });

  it("shows loading skeleton while loading", async () => {
    mockFetchInbox.mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-skeleton")).toBeDefined();
    });
  });

  it("shows empty inbox state when no messages", async () => {
    mockFetchInbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-inbox-empty")).toBeDefined();
    });
  });

  it("calls onClose when clicking close button", async () => {
    const onClose = vi.fn();
    render(<MailboxModal {...defaultProps} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-close")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("passes projectId to API calls", async () => {
    render(<MailboxModal {...defaultProps} projectId="proj-1" />);
    await waitFor(() => {
      expect(mockFetchInbox).toHaveBeenCalledWith({ limit: 50 }, "proj-1");
    });
  });

  describe("agent mailbox sub-tabs", () => {
    it("shows inbox and outbox sub-tabs when agent is selected", async () => {
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 1,
        messages: [mockMessage],
        inbox: [mockMessage],
        outbox: [],
      });

      render(<MailboxModal {...defaultProps} />);

      // Switch to agents tab
      fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
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
    });

    it("switches to outbox view when clicking outbox sub-tab", async () => {
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 0,
        messages: [mockOutboxMessage],
        inbox: [],
        outbox: [mockOutboxMessage],
      });

      render(<MailboxModal {...defaultProps} />);

      // Switch to agents tab and select agent
      fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
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
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 0,
        messages: [],
        inbox: [],
        outbox: [mockOutboxMessage],
      });

      render(<MailboxModal {...defaultProps} />);

      // Switch to agents tab and select agent
      fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
      });

      // Click outbox first
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
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 0,
        messages: [mockOutboxMessage],
        inbox: [],
        outbox: [mockOutboxMessage],
      });

      render(<MailboxModal {...defaultProps} />);

      // Switch to agents tab
      fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
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
      mockFetchAgentMailbox.mockResolvedValue({
        ownerId: "agent-001",
        ownerType: "agent",
        unreadCount: 3,
        messages: [mockMessage],
        inbox: [mockMessage],
        outbox: [],
      });

      render(<MailboxModal {...defaultProps} />);

      // Switch to agents tab and select agent
      fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
      });

      fireEvent.change(screen.getByTestId("mailbox-agent-select"), { target: { value: "agent-001" } });

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-agent-subtabs")).toBeDefined();
      });

      // Inbox tab should have the unread badge
      const inboxTab = screen.getByTestId("mailbox-agent-subtab-inbox");
      expect(inboxTab.querySelector(".mailbox-tab-badge")?.textContent).toBe("3");
    });
  });

  describe("mobile layout CSS regressions", () => {
    it("defines mailbox base flex layout for modal and content containers", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      const modalBlockMatch = css.match(/\.mailbox-modal\s*\{([^}]*)\}/);
      expect(modalBlockMatch).toBeTruthy();
      const modalBlock = modalBlockMatch![1];
      expect(modalBlock).toContain("display: flex;");
      expect(modalBlock).toContain("flex-direction: column;");

      const contentBlockMatch = css.match(/\.mailbox-content\s*\{([^}]*)\}/);
      expect(contentBlockMatch).toBeTruthy();
      const contentBlock = contentBlockMatch![1];
      expect(contentBlock).toContain("flex: 1;");
      expect(contentBlock).toContain("min-height: 0;");
    });

    it("keeps mobile mailbox overrides in the dedicated media-query section", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const css = loadAllAppCss();

      const sectionStart = css.indexOf("/* ── Mailbox — Mobile");
      expect(sectionStart).toBeGreaterThan(-1);

      const sectionEnd = css.indexOf("/* ── Message Composer", sectionStart);
      expect(sectionEnd).toBeGreaterThan(sectionStart);

      const mailboxMobileSection = css.slice(sectionStart, sectionEnd);

      expect(mailboxMobileSection).toContain("@media (max-width: 768px)");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-header");
      expect(mailboxMobileSection).toContain("flex-wrap: wrap;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-title");
      expect(mailboxMobileSection).toContain("flex-shrink: 0;");
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions,\s*\.mailbox-view \.mailbox-header-actions\s*\{[^}]*gap:\s*var\(--space-sm\);[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.btn,[^}]*\.mailbox-view \.mailbox-header-actions \.btn-icon\s*\{[^}]*min-height:\s*36px;[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.btn-icon,[^}]*\.mailbox-view \.mailbox-header-actions \.btn-icon\s*\{[^}]*min-width:\s*36px;[^}]*display:\s*inline-flex;[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.modal-close\s*\{[^}]*padding:\s*0;[^}]*border-radius:\s*var\(--radius-sm\);[^}]*\}/);
      expect(mailboxMobileSection).toContain("overflow-x: auto;");
      expect(mailboxMobileSection).toContain("-webkit-overflow-scrolling: touch;");
      expect(mailboxMobileSection).toContain("scrollbar-width: none;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-tabs::-webkit-scrollbar");
      expect(mailboxMobileSection).toContain("display: none;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-tab");
      expect(mailboxMobileSection).toContain("padding: 8px 12px;");
      expect(mailboxMobileSection).toContain("font-size: 0.8rem;");
      expect(mailboxMobileSection).toContain("max-height: calc(100dvh - 120px);");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-message-detail-header");
      expect(mailboxMobileSection).toContain("flex-direction: column;");
      expect(mailboxMobileSection).toContain("align-items: flex-start;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-message-detail-actions");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-message-participants");
      expect(mailboxMobileSection).toContain("gap: 8px;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-conversation-msg");
      expect(mailboxMobileSection).toContain("padding: 6px 10px;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-agent-select");
      expect(mailboxMobileSection).toContain("max-width: 100%;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-agents");
      expect(mailboxMobileSection).toContain("min-height: 200px;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-empty");
      expect(mailboxMobileSection).toContain("padding: 32px 12px;");
    });

    it("renders detail-view structural hooks targeted by mobile overrides", async () => {
      const { container } = render(<MailboxModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("mailbox-item-msg-001"));

      await waitFor(() => {
        expect(container.querySelector(".mailbox-message-detail-header")).toBeTruthy();
        expect(container.querySelector(".mailbox-message-detail-actions")).toBeTruthy();
        expect(container.querySelector(".mailbox-message-participants")).toBeTruthy();
      });
    });
  });

  describe("theme-awareness CSS regressions", () => {
    // Read CSS file once for all tests in this block
    let css: string;
    beforeAll(async () => {
      const fs = await import("fs");
      const path = await import("path");
      css = loadAllAppCss();
    });

    it("mailbox unread badge uses theme-aware text token", () => {
      const blockMatch = css.match(/\.mailbox-unread-badge\s*\{([^}]*)\}/);
      expect(blockMatch).toBeTruthy();
      expect(blockMatch![1]).toContain("var(--fab-text)");
      expect(blockMatch![1]).not.toContain("color: white");
    });

    it("mailbox tab badge uses theme-aware text token", () => {
      const blockMatch = css.match(/\.mailbox-tab-badge\s*\{([^}]*)\}/);
      expect(blockMatch).toBeTruthy();
      expect(blockMatch![1]).toContain("var(--fab-text)");
      expect(blockMatch![1]).not.toContain("color: white");
    });

    it("mailbox tabs and subtabs do not force square-edge defaults", () => {
      const tabBlockMatch = css.match(/\.mailbox-tab\s*\{([^}]*)\}/);
      expect(tabBlockMatch).toBeTruthy();
      expect(tabBlockMatch![1]).toContain("border-color: var(--border)");
      expect(tabBlockMatch![1]).toContain("background: var(--surface)");
      expect(tabBlockMatch![1]).not.toContain("border: none");
      expect(tabBlockMatch![1]).not.toContain("background: none");
      expect(tabBlockMatch![1]).not.toContain("border-bottom: 2px solid transparent");

      const subtabBlockMatch = css.match(/\.mailbox-agent-subtab\s*\{([^}]*)\}/);
      expect(subtabBlockMatch).toBeTruthy();
      expect(subtabBlockMatch![1]).toContain("border-color: var(--border)");
      expect(subtabBlockMatch![1]).toContain("background: var(--surface)");
      expect(subtabBlockMatch![1]).not.toContain("border-radius: 0");
      expect(subtabBlockMatch![1]).not.toContain("border: none");
      expect(subtabBlockMatch![1]).not.toContain("background: transparent");
    });

    it("mission event type error uses CSS custom properties", () => {
      const blockMatch = css.match(/\.mission-event__type--error\s*\{([^}]*)\}/);
      expect(blockMatch).toBeTruthy();
      expect(blockMatch![1]).toContain("var(--event-error-text)");
      expect(blockMatch![1]).toContain("var(--event-error-bg)");
      expect(blockMatch![1]).not.toContain("#fca5a5");
      expect(blockMatch![1]).not.toContain("rgba(239, 68, 68, 0.15)");
    });

    it("mission autopilot pulse uses CSS custom property", () => {
      const blockMatch = css.match(/\.mission-detail__autopilot-pulse\s*\{([^}]*)\}/);
      expect(blockMatch).toBeTruthy();
      expect(blockMatch![1]).toContain("var(--autopilot-pulse)");
      expect(blockMatch![1]).not.toContain("#22c55e");
    });

    it("terminal container uses CSS custom property", () => {
      const blockMatch = css.match(/\.terminal-container\s*\{([^}]*)\}/);
      expect(blockMatch).toBeTruthy();
      expect(blockMatch![1]).toContain("var(--terminal-bg)");
      expect(blockMatch![1]).not.toContain("#1e1e1e");
    });

    it("new tokens are defined in :root", () => {
      // Find the :root block at the start of the file (before any other selectors)
      const rootStart = css.indexOf(":root {");
      const afterRoot = css.slice(rootStart);
      // Match until we find the closing } followed by html,
      const rootMatch = afterRoot.match(/:root\s*\{([\s\S]*?)^}\s*\n\s*html,/m);
      expect(rootMatch).toBeTruthy();
      const rootContent = rootMatch![1];
      expect(rootContent).toContain("--autopilot-icon");
      expect(rootContent).toContain("--event-error-text");
      expect(rootContent).toContain("--terminal-bg");
      expect(rootContent).toContain("--star-idle");
      expect(rootContent).toContain("--fab-text");
      expect(rootContent).toContain("--badge-mission-text");
    });

    it("light theme overrides new tokens", () => {
      // Find the base [data-theme="light"] block (not combined with other selectors)
      const lightBlockMatch = css.match(/^\[data-theme="light"\]\s*\{[\s\S]*?^\}\s*$/m);
      expect(lightBlockMatch).toBeTruthy();
      const lightContent = lightBlockMatch![0];
      expect(lightContent).toContain("--terminal-bg");
      expect(lightContent).toContain("--event-error-text");
      expect(lightContent).toContain("--autopilot-icon");
      expect(lightContent).toContain("--star-active");
    });
  });
});
