/*
FNXC:MailboxBadge 2026-09-09-19:59:
Mailbox is the sole dashboard destination for ordinary messages, historical notices, and completion
recaps. Its badge uses the complete project-scoped unread total, while pending approvals remain an
additional Mailbox badge contribution. Project identity and request epochs fence every async write.
*/
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUnreadCount, type UnreadCountResponse } from "../api";
import { subscribeSse } from "../sse-bus";

export interface UseMailboxUnreadResult {
  mailboxUnreadCount: number;
  mailboxPendingApprovalCount: number;
  setMailboxUnreadCount: (count: number) => void;
  refresh: () => void;
}

interface ProjectUnreadCounts {
  projectId: string | undefined;
  mailboxUnreadCount: number;
  mailboxPendingApprovalCount: number;
}

function emptyProjectUnreadCounts(projectId: string | undefined): ProjectUnreadCounts {
  return { projectId, mailboxUnreadCount: 0, mailboxPendingApprovalCount: 0 };
}

export function useMailboxUnread(currentProjectId: string | undefined): UseMailboxUnreadResult {
  const [storedCounts, setStoredCounts] = useState<ProjectUnreadCounts>(() => emptyProjectUnreadCounts(currentProjectId));
  const epochRef = useRef(0);
  const renderedProjectIdRef = useRef(currentProjectId);
  renderedProjectIdRef.current = currentProjectId;

  const refreshProject = useCallback(async (projectId: string | undefined, epoch: number) => {
    try {
      const data: UnreadCountResponse = await fetchUnreadCount(projectId);
      if (epoch !== epochRef.current) return;
      setStoredCounts({
        projectId,
        mailboxUnreadCount: data.unreadCount,
        mailboxPendingApprovalCount: data.pendingApprovalCount ?? 0,
      });
    } catch (error) {
      if (epoch === epochRef.current) console.warn("[App] Failed to fetch mailbox unread count:", error);
    }
  }, []);

  const refresh = useCallback(() => {
    void refreshProject(currentProjectId, epochRef.current);
  }, [currentProjectId, refreshProject]);

  const setMailboxUnreadCount = useCallback((count: number) => {
    const callbackProjectId = currentProjectId;
    if (renderedProjectIdRef.current !== callbackProjectId) return;
    setStoredCounts((current) => {
      if (renderedProjectIdRef.current !== callbackProjectId) return current;
      return {
        ...(current.projectId === callbackProjectId ? current : emptyProjectUnreadCounts(callbackProjectId)),
        mailboxUnreadCount: count,
      };
    });
  }, [currentProjectId]);

  useEffect(() => {
    epochRef.current += 1;
    setStoredCounts(emptyProjectUnreadCounts(currentProjectId));
    refresh();
    const params = new URLSearchParams();
    if (currentProjectId) params.set("projectId", currentProjectId);
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

  const visibleCounts = storedCounts.projectId === currentProjectId
    ? storedCounts
    : emptyProjectUnreadCounts(currentProjectId);
  return {
    mailboxUnreadCount: visibleCounts.mailboxUnreadCount,
    mailboxPendingApprovalCount: visibleCounts.mailboxPendingApprovalCount,
    setMailboxUnreadCount,
    refresh,
  };
}
