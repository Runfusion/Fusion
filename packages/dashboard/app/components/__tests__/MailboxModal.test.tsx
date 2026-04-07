import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("shows agent buttons in agents tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-btn-agent-001")).toBeDefined();
      expect(screen.getByTestId("mailbox-agent-btn-agent-002")).toBeDefined();
    });
  });

  it("loads agent mailbox when agent is selected", async () => {
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
    });
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-btn-agent-001")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("mailbox-agent-btn-agent-001"));
    await waitFor(() => {
      expect(mockFetchAgentMailbox).toHaveBeenCalledWith("agent-001", undefined);
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
    fireEvent.click(screen.getByTestId("mailbox-back-to-list"));
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
    fireEvent.click(screen.getByTestId("mailbox-mark-all-read"));
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
    fireEvent.click(screen.getByTestId("mailbox-delete"));
    await waitFor(() => {
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-001", undefined);
    });
  });

  it("shows compose FAB in inbox tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-compose-fab")).toBeDefined();
    });
  });

  it("does not show compose FAB in agents tab", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-compose-fab")).toBeNull();
    });
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
});
