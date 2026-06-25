import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const { handlers } = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: MessageEvent) => void> & { onReconnect?: () => void },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { onReconnect?: () => void; events: Record<string, (e: MessageEvent) => void> }) => {
    handlers.onReconnect = opts.onReconnect;
    Object.assign(handlers, opts.events);
    return () => {};
  }),
}));

const fetchUnreadCount = vi.fn();
vi.mock("../../api", () => ({ fetchUnreadCount: (...a: unknown[]) => fetchUnreadCount(...a) }));

import { useMailboxUnread } from "../useMailboxUnread";

describe("useMailboxUnread", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete (handlers as Record<string, unknown>)[key];
    fetchUnreadCount.mockReset();
  });

  it("seeds counts from the initial fetch", async () => {
    fetchUnreadCount.mockResolvedValue({ unreadCount: 4, pendingApprovalCount: 2 });
    const { result } = renderHook(() => useMailboxUnread("p1"));

    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(4));
    expect(result.current.mailboxPendingApprovalCount).toBe(2);
  });

  it("refreshes counts on a message:sent SSE event", async () => {
    fetchUnreadCount.mockResolvedValue({ unreadCount: 1 });
    const { result } = renderHook(() => useMailboxUnread("p1"));
    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(1));

    fetchUnreadCount.mockResolvedValue({ unreadCount: 9 });
    await act(async () => {
      handlers["message:sent"]?.({} as MessageEvent);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(9));
  });

  it("exposes setMailboxUnreadCount for MailboxView's onUnreadCountChange", () => {
    fetchUnreadCount.mockResolvedValue({ unreadCount: 0 });
    const { result } = renderHook(() => useMailboxUnread(undefined));

    act(() => {
      result.current.setMailboxUnreadCount(42);
    });

    expect(result.current.mailboxUnreadCount).toBe(42);
  });
});
