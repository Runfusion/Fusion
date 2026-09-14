/*
FNXC:ChatBadge 2026-09-14-11:35:
Header/mobile-nav unread state follows effective Chat visibility rather than a route boolean. Any canonical or detached visible Chat surface clears and suppresses the badge; globally hidden windows remain unread-eligible.

FNXC:ChatBadge 2026-07-01-00:00:
Task-detail planner chats use synthetic `task-planner:<taskId>` direct sessions that are hidden from the common Chat feed unless the project explicitly opts them back in. Ignore planner assistant events only while the SSE visibility metadata says that planner session is absent from global Chat, so opt-in shared-feed projects still get normal unread badges.
*/

import { useEffect, useRef, useState } from "react";
import type { ChatRoomMessage } from "@fusion/core";
import { fetchChatSessions } from "../api";
import { subscribeSse } from "../sse-bus";

const TASK_PLANNER_CHAT_AGENT_ID_PREFIX = "task-planner:";

type ChatMessageAddedPayload = {
  role?: string;
  projectId?: string | null;
  agentId?: string | null;
  session?: { agentId?: string | null } | null;
  chatSession?: { agentId?: string | null } | null;
  taskChatVisibleInCommonFeed?: boolean | null;
};

function isTaskPlannerChatMessage(payload: ChatMessageAddedPayload): boolean {
  const candidateAgentIds = [
    payload.agentId,
    payload.session?.agentId,
    payload.chatSession?.agentId,
  ];
  return candidateAgentIds.some(
    (agentId) => typeof agentId === "string" && agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX),
  );
}

function isHiddenTaskPlannerChatMessage(payload: ChatMessageAddedPayload): boolean {
  return isTaskPlannerChatMessage(payload) && payload.taskChatVisibleInCommonFeed !== true;
}

export interface UseChatUnreadBadgeOptions {
  primaryHostActive: boolean;
}

export interface UseChatUnreadBadgeResult {
  chatHasUnreadResponse: boolean;
}

export function useChatUnreadBadge(
  currentProjectId: string | undefined,
  { primaryHostActive }: UseChatUnreadBadgeOptions,
): UseChatUnreadBadgeResult {
  const [chatHasUnreadResponse, setChatHasUnreadResponse] = useState(false);
  /*
  FNXC:ChatBadge 2026-07-26-14:38:
  Watermark for missed-event recovery: the ISO instant at which chat was last known to be fully read
  (mount, or whenever the badge is cleared by revealing any Chat surface). Anything the server reports
  as newer than this while chat is closed is unread.
  */
  const lastReadAtRef = useRef<string>(new Date().toISOString());

  useEffect(() => {
    if (primaryHostActive) {
      lastReadAtRef.current = new Date().toISOString();
      setChatHasUnreadResponse(false);
    }
  }, [primaryHostActive]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (currentProjectId) {
      params.set("projectId", currentProjectId);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    let disposed = false;

    /*
    FNXC:ChatBadge 2026-07-26-14:38:
    Missed-event recovery. The badge was set only by live `chat:message:added` /
    `chat:room:message:added` events, so replies that landed during any SSE gap — including the
    mobile hidden-tab suspend, which is exactly when replies arrive unattended — were never counted
    and the indicator stayed permanently dark. On reopen, compare the authoritative session list's
    last-message timestamps against the read watermark. Hidden task-planner sessions stay excluded
    (the list carries no per-session common-feed visibility flag, so match the default-hidden
    behavior of the event path rather than over-badging).
    */
    const resyncUnreadBadge = () => {
      if (primaryHostActive) return;
      void fetchChatSessions(currentProjectId)
        .then((data) => {
          // `disposed` also fences visibility changes, so revealing Chat cannot accept a stale closed-host response.
          if (disposed) return;
          const watermark = lastReadAtRef.current;
          const hasNewer = data.sessions.some((session) => {
            const agentId = session.agentId;
            if (typeof agentId === "string" && agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX)) return false;
            const lastMessageAt = session.lastMessageAt;
            return typeof lastMessageAt === "string" && lastMessageAt > watermark;
          });
          if (hasNewer) setChatHasUnreadResponse(true);
        })
        .catch(() => {
          // A failed resync leaves the current badge state; the next reopen retries.
        });
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      onReconnect: resyncUnreadBadge,
      events: {
        "chat:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as ChatMessageAddedPayload;
            if (payload.role !== "assistant") return;
            if (isHiddenTaskPlannerChatMessage(payload)) return;
            if (primaryHostActive) return;
            if (payload.projectId && currentProjectId && payload.projectId !== currentProjectId) return;
            setChatHasUnreadResponse(true);
          } catch {
            // no-op
          }
        },
        "chat:room:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as ChatRoomMessage & { projectId?: string | null };
            if (payload.role === "user") return;
            if (primaryHostActive) return;
            if (payload.projectId && currentProjectId && payload.projectId !== currentProjectId) return;
            setChatHasUnreadResponse(true);
          } catch {
            // no-op
          }
        },
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [currentProjectId, primaryHostActive]);

  return { chatHasUnreadResponse };
}
