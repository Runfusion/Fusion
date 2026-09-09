import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const { handlers } = vi.hoisted(() => ({ handlers: {} as Record<string, (event: MessageEvent) => void> & { onReconnect?: () => void } }));
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { onReconnect?: () => void; events: Record<string, (event: MessageEvent) => void> }) => {
    handlers.onReconnect = options.onReconnect;
    Object.assign(handlers, options.events);
    return () => undefined;
  }),
}));
const fetchUnreadCount = vi.fn();
vi.mock("../../api", () => ({ fetchUnreadCount: (...args: unknown[]) => fetchUnreadCount(...args) }));
import { useMailboxUnread } from "../useMailboxUnread";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useMailboxUnread", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete (handlers as Record<string, unknown>)[key];
    fetchUnreadCount.mockReset();
  });

  it("uses the all-category total and keeps pending approvals", async () => {
    fetchUnreadCount.mockResolvedValue({ unreadCount: 9, pendingApprovalCount: 2, categoryUnreadCounts: { message: 4, recommendation: 3, artifact: 2 } });
    const { result } = renderHook(() => useMailboxUnread("p1"));
    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(9));
    expect(result.current.mailboxPendingApprovalCount).toBe(2);
    expect(result.current).not.toHaveProperty("recommendationUnreadCount");
    expect(result.current).not.toHaveProperty("artifactUnreadCount");
    expect(result.current).not.toHaveProperty("markCategorySeen");
  });

  it("fences late responses when the project changes", async () => {
    const projectA = deferred<{ unreadCount: number }>();
    fetchUnreadCount.mockImplementation((projectId: string) => projectId === "a" ? projectA.promise : Promise.resolve({ unreadCount: 7 }));
    const { result, rerender } = renderHook(({ projectId }) => useMailboxUnread(projectId), { initialProps: { projectId: "a" } });
    rerender({ projectId: "b" });
    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(7));
    projectA.resolve({ unreadCount: 99 });
    await act(async () => { await projectA.promise; });
    expect(result.current.mailboxUnreadCount).toBe(7);
  });

  it("refreshes the complete count on mailbox SSE and accepts host updates", async () => {
    fetchUnreadCount.mockResolvedValueOnce({ unreadCount: 1 }).mockResolvedValue({ unreadCount: 6 });
    const { result } = renderHook(() => useMailboxUnread("p1"));
    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(1));
    await act(async () => { handlers["message:sent"]?.({} as MessageEvent); });
    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(6));
    act(() => result.current.setMailboxUnreadCount(3));
    expect(result.current.mailboxUnreadCount).toBe(3);
  });
});
