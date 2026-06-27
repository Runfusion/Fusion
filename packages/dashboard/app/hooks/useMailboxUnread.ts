/*
FNXC:MailboxBadge 2026-06-24-00:00:
Header/mobile-nav unread + pending-approval counts for the mailbox, refreshed on message and approval SSE events. Extracted from AppInner; exposes `refresh` for reconnect/SSE-driven count refresh and `setMailboxUnreadCount` because MailboxView reports its own count changes through onUnreadCountChange.

FNXC:MailboxBadge 2026-06-26-00:00:
Pending approval counts are mailbox-only and refresh from approval:* events backed by ApprovalRequest rows. Task awaiting-approval transitions must not refresh or inflate these mailbox counts.
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
