import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MailboxModal } from "../MailboxModal";
import * as apiModule from "../../api";
import * as mobileKeyboardModule from "../../hooks/useMobileKeyboard";
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
  fetchMessage: vi.fn(),
  sendMessage: vi.fn(),
  fetchNativeStructurePreview: vi.fn(),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: vi.fn(),
}));

vi.mock("../Header", () => ({
  useViewportMode: vi.fn(() => "mobile"),
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
  ChevronRight: () => <span data-testid="icon-chevron-right">ChevronRight</span>,
  ChevronDown: () => <span data-testid="icon-chevron-down">ChevronDown</span>,
  AlertCircle: () => <span data-testid="icon-alert">Alert</span>,
  Map: () => <span data-testid="icon-map">Map</span>,
  Flag: () => <span data-testid="icon-flag">Flag</span>,
  Lightbulb: () => <span data-testid="icon-lightbulb">Lightbulb</span>,
  BarChart3: () => <span data-testid="icon-chart">Chart</span>,
  Target: () => <span data-testid="icon-target">Target</span>,
  CircleAlert: () => <span data-testid="icon-circle-alert">CircleAlert</span>,
}));

const mockFetchInbox = vi.mocked(apiModule.fetchInbox);
const mockFetchOutbox = vi.mocked(apiModule.fetchOutbox);
const mockFetchUnreadCount = vi.mocked(apiModule.fetchUnreadCount);
const mockFetchAgentMailbox = vi.mocked(apiModule.fetchAgentMailbox);
const mockFetchAllAgentMailbox = vi.mocked(apiModule.fetchAllAgentMailbox);
const mockMarkMessageRead = vi.mocked(apiModule.markMessageRead);
const mockMarkAllMessagesRead = vi.mocked(apiModule.markAllMessagesRead);
const mockDeleteMessage = vi.mocked(apiModule.deleteMessage);
const mockFetchConversation = vi.mocked(apiModule.fetchConversation);
const mockFetchMessage = vi.mocked(apiModule.fetchMessage);
const mockSendMessage = vi.mocked(apiModule.sendMessage);
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

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  addToast: vi.fn(),
  onOpenNativeStructure: vi.fn(),
  nativeStructureCandidates: [],
  agents: mockAgents,
};

describe("MailboxModal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    Element.prototype.scrollIntoView = vi.fn();
    // Clear SWR cache between tests so prior runs don't pre-hydrate inbox/outbox
    // state and mask the loading/empty/error UI assertions.
    localStorage.clear();
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    mockFetchInbox.mockResolvedValue({ messages: [mockMessage, mockReadMessage], total: 2, unreadCount: 1 });
    mockFetchOutbox.mockResolvedValue({ messages: [], total: 0 });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 });
    mockFetchAllAgentMailbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockFetchMessage.mockResolvedValue(mockMessage);
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

  it("applies visual viewport CSS variables when mobile keyboard is open", async () => {
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 220,
      viewportHeight: 460,
      viewportOffsetTop: 28,
      keyboardOpen: true,
    });

    render(<MailboxModal {...defaultProps} />);

    const modal = await screen.findByTestId("mailbox-modal");
    expect(modal.getAttribute("style")).toContain("--vv-offset-top: 28px");
    expect(modal.getAttribute("style")).toContain("--vv-height: 460px");
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
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
      expect(screen.getByTestId("mailbox-item-msg-002")).toBeDefined();
    });
  });

  it("preserves byte-identical inbox timestamp buckets", async () => {
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
    mockFetchInbox.mockResolvedValue({ messages, total: messages.length, unreadCount: 0 });

    const { container } = render(<MailboxModal {...defaultProps} />);

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

  it("renders agent participant labels with name and id, then falls back to id", async () => {
    mockFetchInbox.mockResolvedValue({
      messages: [
        { ...mockMessage, id: "msg-known", fromId: "agent-001" },
        { ...mockMessage, id: "msg-unknown", fromId: "agent-999" },
      ],
      total: 2,
      unreadCount: 2,
    });

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-known")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-known"));
    await waitFor(() => {
      expect(screen.getByText("Agent: Test Agent 1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-back-to-list"));
    fireEvent.click(screen.getByTestId("mailbox-item-msg-unknown"));
    await waitFor(() => {
      expect(screen.getByText("Agent: agent-999")).toBeDefined();
    });
  });

  it("shows unread dot for unread messages", async () => {
    render(<MailboxModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-001")).toBeDefined();
      expect(screen.getByTestId("mailbox-item-msg-002")).toBeDefined();
    });
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
    const select = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.options[0].value).toBe("__all_agents__");
    expect(select.options[0].textContent).toBe("All agents");
    expect(select.options[1].textContent).toBe("Test Agent 1");
    expect(select.options[2].textContent).toBe("Test Agent 2");
  });

  it("defaults the agent dropdown to All agents with no empty placeholder", async () => {
    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      const select = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
      expect(select.value).toBe("__all_agents__");
      expect(select.options[0].value).toBe("__all_agents__");
      expect(select.options[0].textContent).toBe("All agents");
      expect(Array.from(select.options).some((option) => option.value === "")).toBe(false);
    });
  });

  it("FN-4109 defaults the Agents tab to All agents and loads the aggregate mailbox", async () => {
    mockFetchAllAgentMailbox.mockResolvedValue({
      messages: [
        {
          id: "msg-agent-thread",
          fromId: "agent-001",
          fromType: "agent",
          toId: "agent-002",
          toType: "agent",
          content: "Coordinator handoff update for the mailbox modal.",
          type: "agent-to-agent",
          read: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      unreadCount: 1,
    });

    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));

    await waitFor(() => {
      const select = screen.getByTestId("mailbox-agent-select") as HTMLSelectElement;
      expect(select.value).toBe("__all_agents__");
      expect(select.options[0].value).toBe("__all_agents__");
      expect(select.options[0].textContent).toBe("All agents");
      expect(mockFetchAllAgentMailbox).toHaveBeenCalledWith(undefined);
      expect(screen.getByTestId("mailbox-item-msg-agent-thread")).toBeDefined();
    });

    expect(screen.getByTestId("mailbox-item-participants-msg-agent-thread").textContent).toContain("From: Agent: Test Agent 1");
    expect(screen.getByTestId("mailbox-item-participants-msg-agent-thread").textContent).toContain("To: Agent: Test Agent 2");
    expect(screen.queryByText("No agent-to-agent messages")).toBeNull();
    expect(screen.queryByTestId("mailbox-agent-subtabs")).toBeNull();
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
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 1,
      messages: [agentInboxMessage],
      inbox: [agentInboxMessage],
      outbox: [],
    });
    mockFetchConversation.mockResolvedValue([agentInboxMessage]);

    render(<MailboxModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("mailbox-tab-agents"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-agent-select")).toBeDefined();
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

  it("keeps a manually selected modal message after a stale deep link", async () => {
    window.history.replaceState({}, "", "?view=mailbox&mailbox-message=msg-001#message-msg-001");
    const clickedMessage: Message = {
      ...mockReadMessage,
      read: false,
      content: "Modal clicked selection body",
      fromId: mockMessage.fromId,
      fromType: mockMessage.fromType,
    };

    mockFetchInbox.mockResolvedValue({ messages: [mockMessage, clickedMessage], total: 2, unreadCount: 2 });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockImplementation(async (messageId) => ({
      ...(messageId === clickedMessage.id ? clickedMessage : mockMessage),
      read: true,
    }));

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent(mockMessage.content);
    });

    fireEvent.click(screen.getByTestId("mailbox-back-to-list"));
    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-002")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-002"));

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent("Modal clicked selection body");
      expect(screen.getByTestId("mailbox-message-detail")).toHaveAttribute("id", "message-msg-002");
      expect(mockMarkMessageRead).toHaveBeenCalledWith("msg-002", undefined);
    });
  });

  it("ignores unknown modal deep links and empty inboxes without selecting stale data", async () => {
    window.history.replaceState({}, "", "?view=mailbox&mailbox-message=missing#message-missing");
    mockFetchInbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    mockFetchConversation.mockResolvedValue([]);

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-inbox-empty")).toBeDefined();
    });

    expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
    expect(mockMarkMessageRead).not.toHaveBeenCalled();
    expect(mockFetchConversation).not.toHaveBeenCalled();
  });

  it("keeps modal tab changes from restoring a consumed mailbox deep link", async () => {
    window.history.replaceState({}, "", "?view=mailbox&mailbox-message=msg-001#message-msg-001");
    mockFetchInbox.mockResolvedValue({ messages: [mockMessage], total: 1, unreadCount: 1 });
    mockFetchOutbox.mockResolvedValue({ messages: [], total: 0 });
    mockFetchConversation.mockResolvedValue([mockMessage]);
    mockMarkMessageRead.mockResolvedValue({ ...mockMessage, read: true });

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-message-detail")).toHaveAttribute("id", "message-msg-001");
    });

    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-outbox-empty")).toBeDefined();
      expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
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

  it("renders selected-message reply context row when metadata includes replyTo", async () => {
    const reply: Message = {
      ...mockMessage,
      id: "msg-reply-selected",
      metadata: { replyTo: { messageId: "msg-root-remote" } },
    };

    mockFetchInbox.mockResolvedValue({ messages: [reply], total: 1, unreadCount: 1 });
    mockFetchConversation.mockResolvedValue([reply]);
    mockMarkMessageRead.mockResolvedValue({ ...reply, read: true });

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-reply-selected")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-reply-selected"));

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-selected-reply-context")).toBeDefined();
    });
  });

  it("expands reply context without fetch when parent is already in thread", async () => {
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

    const replyContext = await screen.findByTestId("mailbox-reply-context-msg-reply");
    fireEvent.click(replyContext);

    await waitFor(() => {
      expect(mockFetchMessage).not.toHaveBeenCalled();
      expect(screen.getAllByText("Need a status update.").length).toBeGreaterThan(0);
    });
  });

  it("renders nested reply context rows for multi-level thread metadata", async () => {
    const grandparent: Message = { ...mockMessage, id: "msg-grandparent", content: "Original message" };
    const parent: Message = {
      ...mockMessage,
      id: "msg-parent",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-001",
      toType: "agent",
      type: "user-to-agent",
      content: "Second reply",
      metadata: { replyTo: { messageId: "msg-grandparent" } },
    };
    const child: Message = {
      ...mockMessage,
      id: "msg-child",
      fromId: "agent-001",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Third reply",
      metadata: { replyTo: { messageId: "msg-parent" } },
    };

    mockFetchInbox.mockResolvedValue({ messages: [grandparent], total: 1, unreadCount: 1 });
    mockFetchConversation.mockResolvedValue([grandparent, parent, child]);

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-grandparent")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-grandparent"));

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-reply-context-msg-parent")).toBeDefined();
      expect(screen.getByTestId("mailbox-reply-context-msg-child")).toBeDefined();
    });
  });

  it("stops recursive rendering when ancestor cycle is detected", async () => {
    const cycleA: Message = { ...mockMessage, id: "msg-cycle-a", metadata: { replyTo: { messageId: "msg-cycle-b" } } };
    const cycleB: Message = {
      ...mockMessage,
      id: "msg-cycle-b",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-001",
      toType: "agent",
      type: "user-to-agent",
      metadata: { replyTo: { messageId: "msg-cycle-a" } },
    };

    mockFetchInbox.mockResolvedValue({ messages: [cycleA], total: 1, unreadCount: 1 });
    mockFetchConversation.mockResolvedValue([cycleA, cycleB]);

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-cycle-a")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-cycle-a"));

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-reply-context-msg-cycle-b")).toBeNull();
    });
  });

  it("does not show unrelated same-sender messages as a thread in detail", async () => {
    const root: Message = {
      ...mockMessage,
      id: "msg-modal-root-only",
      content: "Primary inbox request",
    };
    const unrelated: Message = {
      ...mockMessage,
      id: "msg-modal-unrelated",
      content: "Unrelated top-level note",
      createdAt: new Date(Date.now() + 10_000).toISOString(),
    };

    mockFetchInbox.mockResolvedValue({ messages: [root], total: 1, unreadCount: 1 });
    mockFetchConversation.mockResolvedValue([root, unrelated]);

    render(<MailboxModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-item-msg-modal-root-only")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mailbox-item-msg-modal-root-only"));

    await waitFor(() => {
      expect(screen.queryByTestId("mailbox-conversation")).toBeNull();
      expect(screen.getByTestId("mailbox-message-body")).toHaveTextContent("Primary inbox request");
      expect(screen.queryByText("Unrelated top-level note")).toBeNull();
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

  it("compose opened from Agents tab with All agents selected shows recipient select", async () => {
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
    expect(screen.getByText("Test Agent 1")).toBeDefined();
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
      await waitFor(() => {
        const inboxTab = screen.getByTestId("mailbox-agent-subtab-inbox");
        expect(inboxTab.querySelector(".mailbox-tab-badge")?.textContent).toBe("3");
      });
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
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.btn,[^}]*\.mailbox-view \.mailbox-header-actions \.btn-icon\s*\{[^}]*min-height:\s*2\.25rem;[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.btn-icon,[^}]*\.mailbox-view \.mailbox-header-actions \.btn-icon\s*\{[^}]*min-width:\s*2\.25rem;[^}]*display:\s*inline-flex;[^}]*\}/);
      expect(mailboxMobileSection).toMatch(/\.mailbox-modal \.mailbox-header-actions \.modal-close\s*\{[^}]*padding:\s*0;[^}]*border-radius:\s*var\(--radius-sm\);[^}]*\}/);
      expect(mailboxMobileSection).toContain("overflow-x: auto;");
      expect(mailboxMobileSection).toContain("-webkit-overflow-scrolling: touch;");
      expect(mailboxMobileSection).toContain("scrollbar-width: none;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-tabs::-webkit-scrollbar");
      expect(mailboxMobileSection).toContain("display: none;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-tab");
      expect(mailboxMobileSection).toContain("padding: var(--space-sm) var(--space-md);");
      expect(mailboxMobileSection).toContain("font-size: var(--font-size-xs, 0.8rem);");
      expect(mailboxMobileSection).toContain("max-height: calc(100dvh - var(--header-height) - var(--space-2xl) - var(--space-xl));");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-message-detail-header");
      expect(mailboxMobileSection).toContain("flex-direction: column;");
      expect(mailboxMobileSection).toContain("align-items: flex-start;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-message-detail-actions");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-message-participants");
      expect(mailboxMobileSection).toContain("gap: var(--space-sm);");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-conversation-msg");
      expect(mailboxMobileSection).toContain("padding: var(--space-xs) var(--space-md);");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-agent-select");
      expect(mailboxMobileSection).toContain("max-width: 100%;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-agents");
      expect(mailboxMobileSection).toContain("min-height: 12.5rem;");
      expect(mailboxMobileSection).toContain(".mailbox-modal .mailbox-empty");
      expect(mailboxMobileSection).toContain("padding: var(--space-2xl) var(--space-md);");
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

      const subtabBlocks = [...css.matchAll(/\.mailbox-agent-subtab\s*\{([^}]*)\}/g)].map((match) => match[1]);
      const baseSubtabBlock = subtabBlocks.find((block) => block.includes("border-color: var(--border)"));
      expect(baseSubtabBlock).toBeTruthy();
      expect(baseSubtabBlock!).toContain("background: var(--surface)");
      expect(baseSubtabBlock!).not.toContain("border-radius: 0");
      expect(baseSubtabBlock!).not.toContain("border: none");
      expect(baseSubtabBlock!).not.toContain("background: transparent");
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
      // Match the root-scoped light theme token block used by the app stylesheet.
      const lightBlockMatch = css.match(/^:root\[data-theme="light"\]\s*\{[\s\S]*?^\}\s*$/m);
      expect(lightBlockMatch).toBeTruthy();
      const lightContent = lightBlockMatch![0];
      expect(lightContent).toContain("--terminal-bg");
      expect(lightContent).toContain("--event-error-text");
      expect(lightContent).toContain("--autopilot-icon");
      expect(lightContent).toContain("--star-active");
    });
  });

  it("highlights hash-linked message when modal opens", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState({}, "", "#message-msg-001");

    render(<MailboxModal {...defaultProps} />);

    // The deep-link opens the message detail view, so the element with id="message-msg-001"
    // is in the detail section, not the inbox list.
    const messageNode = await screen.findByTestId("mailbox-message-detail");
    expect(messageNode).toHaveAttribute("id", "message-msg-001");
    await waitFor(() => {
      expect(messageNode).toHaveClass("mailbox-message-highlight");
    });
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
