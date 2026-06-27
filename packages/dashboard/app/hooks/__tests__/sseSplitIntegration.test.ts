import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
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
import { msg } from "./sseTestHelpers";

describe("SSE split (KTD4): mailbox-refresh vs approval-banner", () => {
  beforeEach(() => {
    subscriptions.length = 0;
    fetchUnreadCount.mockReset();
    fetchUnreadCount.mockResolvedValue({ unreadCount: 0 });
  });

  it("co-mount keeps mailbox counts on approval events and task plan-approval out of the banner", async () => {
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
      }),
    );

    // Drain the mailbox hook's mount fetch deterministically — wait for the
    // refresh call to fire and settle, so its setState doesn't leak past the
    // test. (Replaces a magic 2x microtask flush.)
    await act(async () => {
      await waitFor(() => expect(fetchUnreadCount).toHaveBeenCalled());
    });

    // Distinguish the two subscriptions: mailbox listens to message:sent,
    // the banner listens to task:updated.
    const mailboxSub = subscriptions.find((s) => "message:sent" in s.events);
    const approvalSub = subscriptions.find((s) => "task:updated" in s.events);
    expect(mailboxSub).toBeTruthy();
    expect(approvalSub).toBeTruthy();
    // The split extends to reconnect handling: the mailbox subscription wires
    // an onReconnect (re-fetch counts), the approval banner does not.
    expect(mailboxSub!.onReconnect).toBeTruthy();
    expect(approvalSub!.onReconnect).toBeUndefined();

    // (i) approval:requested sets the banner candidate; the mailbox hook's
    //     approval:requested handler (count refresh) remains a distinct
    //     function from the banner's.
    act(() => {
      approvalSub!.events["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(approval.result.current.candidate?.dedupeKey).toBe("approval:a1");
    expect(mailboxSub!.events["approval:requested"]).toBeTruthy();
    expect(mailboxSub!.events["approval:requested"]).not.toBe(approvalSub!.events["approval:requested"]);
    // (ib) … and the mailbox handler actually refreshes the count (wires to
    //      fetchUnreadCount), proving it's a live handler — not merely present.
    const refreshCallsBefore = fetchUnreadCount.mock.calls.length;
    act(() => {
      mailboxSub!.events["approval:requested"]?.(msg({ id: "a2", updatedAt: "2026-01-02T00:00:00Z" }));
    });
    expect(fetchUnreadCount).toHaveBeenCalledTimes(refreshCallsBefore + 1);

    act(() => {
      approval.result.current.dismissApproval(approval.result.current.candidate!);
    });

    // (ii) task:updated → awaiting-approval is plan approval, not mailbox
    //      approval: no banner candidate and no mailbox-count refresh.
    const refreshCallsAfterApproval = fetchUnreadCount.mock.calls.length;
    act(() => {
      approvalSub!.events["task:updated"]?.(
        msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-02T00:00:00Z" }),
      );
    });
    expect(approval.result.current.candidate).toBeNull();
    expect(fetchUnreadCount).toHaveBeenCalledTimes(refreshCallsAfterApproval);
  });
});
