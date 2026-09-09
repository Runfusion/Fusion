import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { DashboardInboxCategory } from "@fusion/core";

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
const markAllMessagesRead = vi.fn();
vi.mock("../../api", () => ({
  fetchUnreadCount: (...args: unknown[]) => fetchUnreadCount(...args),
  markAllMessagesRead: (...args: unknown[]) => markAllMessagesRead(...args),
}));

vi.mock("../useTaskRecommendations", () => ({
  useTaskRecommendations: () => ({
    items: [],
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    totalRowCount: 0,
    truncated: false,
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    createTask: vi.fn(async () => {}),
    createStates: new Map(),
  }),
}));

import { RecommendationsView } from "../../components/RecommendationsView";
import { useMailboxUnread } from "../useMailboxUnread";

function categoryResponse(
  message: number,
  recommendation: number,
  artifact: number,
  pendingApprovalCount = 0,
) {
  return {
    unreadCount: message + recommendation + artifact,
    pendingApprovalCount,
    categoryUnreadCounts: { message, recommendation, artifact },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function counts(result: { current: ReturnType<typeof useMailboxUnread> }) {
  return {
    message: result.current.mailboxUnreadCount,
    recommendation: result.current.recommendationUnreadCount,
    artifact: result.current.artifactUnreadCount,
  };
}

function RecommendationsUnreadHarness({ projectId }: { projectId: string }) {
  const unread = useMailboxUnread(projectId);
  return createElement(
    "div",
    null,
    createElement(
      "output",
      { "data-testid": "recommendation-unread-count" },
      String(unread.recommendationUnreadCount),
    ),
    createElement(RecommendationsView, {
      projectId,
      unreadCount: unread.recommendationUnreadCount,
      onSeen: () => { void unread.markCategorySeen("recommendation"); },
    }),
  );
}

describe("useMailboxUnread", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete (handlers as Record<string, unknown>)[key];
    fetchUnreadCount.mockReset();
    markAllMessagesRead.mockReset();
    markAllMessagesRead.mockResolvedValue({ markedAsRead: 1 });
  });

  it("exposes category counts while keeping ordinary mail separate", async () => {
    fetchUnreadCount.mockResolvedValue(categoryResponse(4, 3, 2, 1));
    const { result } = renderHook(() => useMailboxUnread("p1"));

    await waitFor(() => expect(counts(result)).toEqual({ message: 4, recommendation: 3, artifact: 2 }));
    expect(result.current.mailboxPendingApprovalCount).toBe(1);
  });

  it("falls back to the historical total when category counts are unavailable", async () => {
    fetchUnreadCount.mockResolvedValue({ unreadCount: 4, pendingApprovalCount: 2 });
    const { result } = renderHook(() => useMailboxUnread("p1"));

    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(4));
    expect(result.current.recommendationUnreadCount).toBe(0);
    expect(result.current.artifactUnreadCount).toBe(0);
    expect(result.current.mailboxPendingApprovalCount).toBe(2);
  });

  it("marks artifacts seen and publishes the scoped zero without changing other categories", async () => {
    fetchUnreadCount
      .mockResolvedValueOnce(categoryResponse(1, 1, 1))
      .mockResolvedValueOnce(categoryResponse(1, 1, 0));
    const { result } = renderHook(() => useMailboxUnread("p1"));
    await waitFor(() => expect(counts(result)).toEqual({ message: 1, recommendation: 1, artifact: 1 }));

    await act(async () => {
      await result.current.markCategorySeen("artifact");
    });

    expect(markAllMessagesRead).toHaveBeenCalledWith("p1", { category: "artifact" });
    expect(counts(result)).toEqual({ message: 1, recommendation: 1, artifact: 0 });
  });

  it("marks recommendations seen without changing mail or artifacts", async () => {
    fetchUnreadCount
      .mockResolvedValueOnce(categoryResponse(1, 1, 1))
      .mockResolvedValueOnce(categoryResponse(1, 0, 1));
    const { result } = renderHook(() => useMailboxUnread("p1"));
    await waitFor(() => expect(counts(result)).toEqual({ message: 1, recommendation: 1, artifact: 1 }));

    await act(async () => {
      await result.current.markCategorySeen("recommendation");
    });

    expect(markAllMessagesRead).toHaveBeenCalledWith("p1", { category: "recommendation" });
    expect(counts(result)).toEqual({ message: 1, recommendation: 0, artifact: 1 });
  });

  it("clears stale badges immediately and loads only the new project's counts", async () => {
    const projectB = deferred<ReturnType<typeof categoryResponse>>();
    fetchUnreadCount.mockImplementation((projectId: string | undefined) =>
      projectId === "proj-a" ? Promise.resolve(categoryResponse(1, 2, 3)) : projectB.promise);
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useMailboxUnread(projectId),
      { initialProps: { projectId: "proj-a" } },
    );
    await waitFor(() => expect(counts(result)).toEqual({ message: 1, recommendation: 2, artifact: 3 }));

    rerender({ projectId: "proj-b" });
    expect(counts(result)).toEqual({ message: 0, recommendation: 0, artifact: 0 });
    expect(fetchUnreadCount).toHaveBeenLastCalledWith("proj-b");

    projectB.resolve(categoryResponse(5, 6, 7));
    await waitFor(() => expect(counts(result)).toEqual({ message: 5, recommendation: 6, artifact: 7 }));
  });

  it("marks the newly rendered project through the view while an old mark-seen request is pending", async () => {
    const staleProjectAMark = deferred<{ markedAsRead: number }>();
    let projectBFetches = 0;
    fetchUnreadCount.mockImplementation((projectId: string | undefined) => {
      if (projectId === "proj-a") return Promise.resolve(categoryResponse(0, 1, 0));
      projectBFetches += 1;
      return Promise.resolve(projectBFetches === 1
        ? categoryResponse(0, 2, 0)
        : categoryResponse(0, 0, 0));
    });
    markAllMessagesRead.mockImplementation((projectId: string | undefined) => (
      projectId === "proj-a"
        ? staleProjectAMark.promise
        : Promise.resolve({ markedAsRead: 2 })
    ));

    const rendered = render(createElement(RecommendationsUnreadHarness, { projectId: "proj-a" }));
    await waitFor(() => {
      expect(markAllMessagesRead).toHaveBeenCalledWith("proj-a", { category: "recommendation" });
    });

    rendered.rerender(createElement(RecommendationsUnreadHarness, { projectId: "proj-b" }));
    await waitFor(() => {
      expect(markAllMessagesRead).toHaveBeenCalledWith("proj-b", { category: "recommendation" });
    });
    await waitFor(() => {
      expect(rendered.getByTestId("recommendation-unread-count")).toHaveTextContent("0");
      expect(projectBFetches).toBe(2);
    });

    staleProjectAMark.resolve({ markedAsRead: 1 });
    await act(async () => { await staleProjectAMark.promise; });
    expect(rendered.getByTestId("recommendation-unread-count")).toHaveTextContent("0");
  });

  it("ignores a stale mark-seen refresh after the project changes", async () => {
    const staleProjectARefresh = deferred<ReturnType<typeof categoryResponse>>();
    let projectAFetches = 0;
    fetchUnreadCount.mockImplementation((projectId: string | undefined) => {
      if (projectId === "proj-b") return Promise.resolve(categoryResponse(5, 5, 5));
      projectAFetches += 1;
      return projectAFetches === 1
        ? Promise.resolve(categoryResponse(1, 1, 1))
        : staleProjectARefresh.promise;
    });
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useMailboxUnread(projectId),
      { initialProps: { projectId: "proj-a" } },
    );
    await waitFor(() => expect(counts(result)).toEqual({ message: 1, recommendation: 1, artifact: 1 }));

    let staleMark!: Promise<void>;
    act(() => {
      staleMark = result.current.markCategorySeen("artifact");
    });
    await waitFor(() => expect(projectAFetches).toBe(2));

    rerender({ projectId: "proj-b" });
    await waitFor(() => expect(counts(result)).toEqual({ message: 5, recommendation: 5, artifact: 5 }));

    staleProjectARefresh.resolve(categoryResponse(0, 0, 0));
    await act(async () => { await staleMark; });
    expect(counts(result)).toEqual({ message: 5, recommendation: 5, artifact: 5 });
    expect(markAllMessagesRead).toHaveBeenCalledWith("proj-a", { category: "artifact" });
  });

  it("refreshes counts on a message:sent SSE event", async () => {
    fetchUnreadCount.mockResolvedValue(categoryResponse(1, 0, 0));
    const { result } = renderHook(() => useMailboxUnread("p1"));
    await waitFor(() => expect(result.current.mailboxUnreadCount).toBe(1));

    fetchUnreadCount.mockResolvedValue(categoryResponse(9, 0, 0));
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

  it.each(["message", "recommendation", "artifact"] as DashboardInboxCategory[])(
    "accepts the canonical %s category",
    async (category) => {
      fetchUnreadCount.mockResolvedValue(categoryResponse(0, 0, 0));
      const { result } = renderHook(() => useMailboxUnread("p1"));
      await act(async () => { await result.current.markCategorySeen(category); });
      expect(markAllMessagesRead).toHaveBeenCalledWith("p1", { category });
    },
  );
});
