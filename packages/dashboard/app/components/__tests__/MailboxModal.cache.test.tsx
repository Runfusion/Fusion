import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MailboxModal } from "../MailboxModal";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import * as apiModule from "../../api";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
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
  };
});

const mockFetchInbox = vi.mocked(apiModule.fetchInbox);
const mockFetchOutbox = vi.mocked(apiModule.fetchOutbox);
const mockFetchUnreadCount = vi.mocked(apiModule.fetchUnreadCount);
const mockFetchAllAgentMailbox = vi.mocked(apiModule.fetchAllAgentMailbox);

describe("MailboxModal cache hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchInbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    mockFetchOutbox.mockResolvedValue({ messages: [], total: 0 });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 0 });
    mockFetchAllAgentMailbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
  });

  it("shows cached inbox rows on first open", async () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX}p1`,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          messages: [{ id: "msg-cache", fromId: "agent-1", fromType: "agent", toId: "dashboard", toType: "user", content: "cached", type: "agent-to-user", read: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          total: 1,
          unreadCount: 1,
        },
      }),
    );
    mockFetchInbox.mockImplementation(() => new Promise(() => {}));

    render(<MailboxModal isOpen onClose={() => {}} projectId="p1" agents={[]} />);

    expect(screen.getByTestId("mailbox-item-msg-cache")).toBeInTheDocument();
  });

  it("writes inbox cache on successful load", async () => {
    mockFetchInbox.mockResolvedValueOnce({
      messages: [{ id: "msg-1", fromId: "agent-1", fromType: "agent", toId: "dashboard", toType: "user", content: "live", type: "agent-to-user", read: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      total: 1,
      unreadCount: 1,
    });

    render(<MailboxModal isOpen onClose={() => {}} projectId="p1" agents={[]} />);

    await waitFor(() => {
      const cachedRaw = localStorage.getItem(`${SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX}p1`);
      expect(cachedRaw).not.toBeNull();
      const envelope = JSON.parse(cachedRaw ?? "{}");
      expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
      const cached = envelope.data;
      expect(cached?.messages?.[0]?.id).toBe("msg-1");
      expect(cached).not.toHaveProperty("conversationMessages");
    });
  });

  it("caps inbox cache at 100 and isolates by project", async () => {
    const oversized = Array.from({ length: 140 }, (_, index) => ({
      id: `msg-${index}`,
      fromId: "agent-1",
      fromType: "agent" as const,
      toId: "dashboard",
      toType: "user" as const,
      content: `message ${index}`,
      type: "agent-to-user" as const,
      read: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    mockFetchInbox.mockResolvedValueOnce({ messages: oversized, total: oversized.length, unreadCount: oversized.length });

    const { rerender } = render(<MailboxModal isOpen onClose={() => {}} projectId="p1" agents={[]} />);

    await waitFor(() => {
      const envelope = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX}p1`) ?? "{}");
      expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
      const cached = envelope.data;
      expect(cached?.messages).toHaveLength(100);
    });

    localStorage.setItem(
      `${SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX}p2`,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          messages: [{ id: "msg-p2", fromId: "agent-2", fromType: "agent", toId: "dashboard", toType: "user", content: "p2", type: "agent-to-user", read: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          total: 1,
          unreadCount: 1,
        },
      }),
    );
    mockFetchInbox.mockImplementation(() => new Promise(() => {}));
    rerender(<MailboxModal isOpen onClose={() => {}} projectId="p2" agents={[]} />);

    expect(screen.getByTestId("mailbox-item-msg-p2")).toBeInTheDocument();
  });
});
