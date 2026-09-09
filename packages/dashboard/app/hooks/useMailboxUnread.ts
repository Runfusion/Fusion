/*
FNXC:MailboxBadge 2026-06-24-00:00:
Header/mobile-nav unread + pending-approval counts for the mailbox, refreshed on message and approval SSE events. Extracted from AppInner; exposes `refresh` for reconnect/SSE-driven count refresh and `setMailboxUnreadCount` because MailboxView reports its own count changes through onUnreadCountChange.

FNXC:MailboxBadge 2026-06-26-00:00:
Pending approval counts are mailbox-only and refresh from approval:* events backed by ApprovalRequest rows. Task awaiting-approval transitions must not refresh or inflate these mailbox counts.

FNXC:MailboxBadge 2026-09-06-03:16:
Category-aware servers make the mailbox badge represent only ordinary messages; older servers still expose only the historical total, so that value remains the compatibility fallback while recommendation and artifact badges stay at zero.

FNXC:MailboxBadge 2026-09-06-03:16:
A project switch clears every visible count before fetching because a brief zero is safer than a clickable badge belonging to another project. The epoch fence mirrors useTaskRecommendations: stale fetch and mark-seen continuations must never publish one project's counts after another project becomes current.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardInboxCategory } from "@fusion/core";
import { fetchUnreadCount, markAllMessagesRead, type UnreadCountResponse } from "../api";
import { subscribeSse } from "../sse-bus";

export interface UseMailboxUnreadResult {
  mailboxUnreadCount: number;
  recommendationUnreadCount: number;
  artifactUnreadCount: number;
  mailboxPendingApprovalCount: number;
  setMailboxUnreadCount: (count: number) => void;
  markCategorySeen: (category: DashboardInboxCategory) => Promise<void>;
  refresh: () => void;
}

interface ProjectUnreadCounts {
  projectId: string | undefined;
  mailboxUnreadCount: number;
  recommendationUnreadCount: number;
  artifactUnreadCount: number;
  mailboxPendingApprovalCount: number;
}

function emptyProjectUnreadCounts(projectId: string | undefined): ProjectUnreadCounts {
  return {
    projectId,
    mailboxUnreadCount: 0,
    recommendationUnreadCount: 0,
    artifactUnreadCount: 0,
    mailboxPendingApprovalCount: 0,
  };
}

export function useMailboxUnread(currentProjectId: string | undefined): UseMailboxUnreadResult {
  const [storedCounts, setStoredCounts] = useState<ProjectUnreadCounts>(() => (
    emptyProjectUnreadCounts(currentProjectId)
  ));
  const epochRef = useRef(0);
  const renderedProjectIdRef = useRef(currentProjectId);
  renderedProjectIdRef.current = currentProjectId;

  const refreshProject = useCallback(async (projectId: string | undefined, epoch: number) => {
    try {
      const data: UnreadCountResponse = await fetchUnreadCount(projectId);
      if (epoch !== epochRef.current) return;
      setStoredCounts({
        projectId,
        mailboxUnreadCount: data.categoryUnreadCounts?.message ?? data.unreadCount,
        recommendationUnreadCount: data.categoryUnreadCounts?.recommendation ?? 0,
        artifactUnreadCount: data.categoryUnreadCounts?.artifact ?? 0,
        mailboxPendingApprovalCount: data.pendingApprovalCount ?? 0,
      });
    } catch (error) {
      if (epoch === epochRef.current) {
        console.warn("[App] Failed to fetch mailbox unread count:", error);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void refreshProject(currentProjectId, epochRef.current);
  }, [currentProjectId, refreshProject]);

  const markCategorySeen = useCallback(async (category: DashboardInboxCategory) => {
    const epoch = epochRef.current;
    const projectId = currentProjectId;
    try {
      await markAllMessagesRead(projectId, { category });
      if (epoch !== epochRef.current) return;
      await refreshProject(projectId, epoch);
    } catch (error) {
      if (epoch === epochRef.current) {
        console.warn(`[App] Failed to mark ${category} messages as read:`, error);
      }
    }
  }, [currentProjectId, refreshProject]);

  /*
  FNXC:MailboxBadge 2026-09-06-04:20:
  MailboxView can finish an inbox or unread-count request after its project prop changes. Fence both callback admission and the state updater against the project rendered now so a callback captured by the old view cannot replace the new project's complete badge snapshot with old mailbox data.
  */
  const setMailboxUnreadCount = useCallback((count: number) => {
    const callbackProjectId = currentProjectId;
    if (renderedProjectIdRef.current !== callbackProjectId) return;

    setStoredCounts((current) => {
      if (renderedProjectIdRef.current !== callbackProjectId) return current;
      return {
        ...(current.projectId === callbackProjectId
          ? current
          : emptyProjectUnreadCounts(callbackProjectId)),
        mailboxUnreadCount: count,
      };
    });
  }, [currentProjectId]);

  useEffect(() => {
    epochRef.current += 1;
    setStoredCounts(emptyProjectUnreadCounts(currentProjectId));
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

  /*
  FNXC:MailboxBadge 2026-09-06-04:07:
  Count snapshots carry the project that produced them. A render for another project exposes zero immediately, before passive effects run, so a child view cannot consume its new seen latch with an old project's count; markCategorySeen captures the render's project identity rather than a later mutable ref.
  */
  const visibleCounts = storedCounts.projectId === currentProjectId
    ? storedCounts
    : emptyProjectUnreadCounts(currentProjectId);

  return {
    mailboxUnreadCount: visibleCounts.mailboxUnreadCount,
    recommendationUnreadCount: visibleCounts.recommendationUnreadCount,
    artifactUnreadCount: visibleCounts.artifactUnreadCount,
    mailboxPendingApprovalCount: visibleCounts.mailboxPendingApprovalCount,
    setMailboxUnreadCount,
    markCategorySeen,
    refresh,
  };
}
