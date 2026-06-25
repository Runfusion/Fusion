/*
FNXC:MailboxBadge 2026-06-24-00:00:
Header/mobile-nav unread + pending-approval counts for the mailbox, refreshed on message and approval SSE events. Extracted from AppInner; exposes `refresh` (so the approval-banner hook can re-fetch counts when a task enters awaiting-approval, preserving the former single-subscriber side effect) and `setMailboxUnreadCount` (MailboxView reports its own count changes through onUnreadCountChange).
*/

import { useCallback, useEffect, useState } from "react";
import { fetchUnreadCount } from "../api";
import { subscribeSse } from "../sse-bus";

export interface UseMailboxUnreadResult {
  mailboxUnreadCount: number;
  mailboxPendingApprovalCount: number;
  setMailboxUnreadCount: (count: number) => void;
  refresh: () => void;
}

export function useMailboxUnread(currentProjectId: string | undefined): UseMailboxUnreadResult {
  const [mailboxUnreadCount, setMailboxUnreadCount] = useState(0);
  const [mailboxPendingApprovalCount, setMailboxPendingApprovalCount] = useState(0);

  const refresh = useCallback(() => {
    fetchUnreadCount(currentProjectId)
      .then((data: { unreadCount: number; pendingApprovalCount?: number }) => {
        setMailboxUnreadCount(data.unreadCount);
        setMailboxPendingApprovalCount(data.pendingApprovalCount ?? 0);
      })
      .catch((err) => {
        console.warn("[App] Failed to fetch mailbox unread count:", err);
      });
  }, [currentProjectId]);

  useEffect(() => {
    refresh();

    const params = new URLSearchParams();
    if (currentProjectId) {
      params.set("projectId", currentProjectId);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    return subscribeSse(`/api/events${query}`, {
      onReconnect: refresh,
      events: {
        "message:sent": refresh,
        "message:received": refresh,
        "message:read": refresh,
        "message:deleted": refresh,
        "approval:requested": refresh,
        "approval:updated": refresh,
        "approval:decided": refresh,
      },
    });
  }, [currentProjectId, refresh]);

  return { mailboxUnreadCount, mailboxPendingApprovalCount, setMailboxUnreadCount, refresh };
}
