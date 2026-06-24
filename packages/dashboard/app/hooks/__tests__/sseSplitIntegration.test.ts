import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Task } from "@fusion/core";

interface CapturedSubscription {
  url: string;
  onReconnect?: () => void;
  events: Record<string, (e: MessageEvent) => void>;
}

const { subscriptions } = vi.hoisted(() => ({
  subscriptions: [] as CapturedSubscription[],
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(
    (
      url: string,
      sub: { onReconnect?: () => void; events: Record<string, (e: MessageEvent) => void> },
    ) => {
      subscriptions.push({ url, onReconnect: sub.onReconnect, events: { ...sub.events } });
      return () => {};
    },
  ),
}));

const fetchUnreadCount = vi.fn(async () => ({ unreadCount: 0 }));
vi.mock("../../api", () => ({
  fetchUnreadCount: (...a: unknown[]) => fetchUnreadCount(...a),
}));

import { useMailboxUnread } from "../useMailboxUnread";
import { useApprovalBanner } from "../useApprovalBanner";

function msg(data: object): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

describe("SSE split (KTD4): mailbox-refresh vs approval-banner", () => {
  beforeEach(() => {
    subscriptions.length = 0;
    fetchUnreadCount.mockReset();
    fetchUnreadCount.mockResolvedValue({ unreadCount: 0 });
  });

  it("co-mount keeps the awaiting-approval refresh single-fired and the banner independent", async () => {
    const mailboxSpy = vi.fn();
    const tasks: Task[] = [];
    const onStarPrompt = vi.fn();

    // Two independent mounts → two subscribeSse calls captured separately so
    // the split handlers never overwrite each other.
    renderHook(() => useMailboxUnread("p1"));
    const approval = renderHook(() =>
      useApprovalBanner({
        tasks,
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt,
        onMailboxRefresh: mailboxSpy,
      }),
    );

    // Drain the mailbox hook's mount fetch so no setState leaks past the test.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Distinguish the two subscriptions: mailbox listens to message:sent,
    // the banner listens to task:updated.
    const mailboxSub = subscriptions.find((s) => "message:sent" in s.events);
    const approvalSub = subscriptions.find((s) => "task:updated" in s.events);
    expect(mailboxSub).toBeTruthy();
    expect(approvalSub).toBeTruthy();

    // (i) approval:requested sets the banner candidate but does NOT fire
    //     mailbox-refresh; the mailbox hook's approval:requested handler
    //     (count refresh) is a distinct function from the banner's.
    act(() => {
      approvalSub!.events["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(approval.result.current.candidate?.dedupeKey).toBe("approval:a1");
    expect(mailboxSpy).not.toHaveBeenCalled();
    expect(mailboxSub!.events["approval:requested"]).toBeTruthy();
    expect(mailboxSub!.events["approval:requested"]).not.toBe(approvalSub!.events["approval:requested"]);

    // (ii) task:updated → awaiting-approval sets the candidate + fires the
    //      mailbox refresh exactly once.
    act(() => {
      approvalSub!.events["task:updated"]?.(
        msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-02T00:00:00Z" }),
      );
    });
    expect(approval.result.current.candidate?.dedupeKey).toBe("task:t1");
    expect(mailboxSpy).toHaveBeenCalledTimes(1);

    // (iii) a second awaiting-approval for the same task is deduped — no second refresh.
    act(() => {
      approvalSub!.events["task:updated"]?.(
        msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-03T00:00:00Z" }),
      );
    });
    expect(mailboxSpy).toHaveBeenCalledTimes(1);
  });
});
