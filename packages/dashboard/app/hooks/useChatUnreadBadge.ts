/*
FNXC:ChatBadge 2026-06-24-00:00:
Header/mobile-nav unread indicator for assistant chat responses. Set when an assistant message arrives over SSE while the user is not viewing chat, and cleared when the chat view (or quick-chat window) opens. Extracted verbatim from AppInner.

FNXC:ChatBadge 2026-07-01-00:00:
Task-detail planner chats use synthetic `task-planner:<taskId>` direct sessions that are hidden from the common Chat feed unless the project explicitly opts them back in. Ignore planner assistant events only while the SSE visibility metadata says that planner session is absent from global Chat, so opt-in shared-feed projects still get normal unread badges.
*/

import { useEffect, useRef, useState } from "react";
import type { ChatRoomMessage } from "@fusion/core";
import { fetchChatSessions } from "../api";
import { subscribeSse } from "../sse-bus";
import type { TaskView } from "./useViewState";

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
  taskView: TaskView;
  quickChatOpen: boolean;
}

export interface UseChatUnreadBadgeResult {
  chatHasUnreadResponse: boolean;
}

export function useChatUnreadBadge(
  currentProjectId: string | undefined,
  { taskView, quickChatOpen }: UseChatUnreadBadgeOptions,
): UseChatUnreadBadgeResult {
  const [chatHasUnreadResponse, setChatHasUnreadResponse] = useState(false);
  /*
  FNXC:ChatBadge 2026-07-26-14:38:
  Watermark for missed-event recovery: the ISO instant at which chat was last known to be fully read
  (mount, or whenever the badge is cleared by opening chat/quick-chat). Anything the server reports
  as newer than this while chat is closed is unread.
  */
  const lastReadAtRef = useRef<string>(new Date().toISOString());

  useEffect(() => {
    if (taskView === "chat" || quickChatOpen) {
      lastReadAtRef.current = new Date().toISOString();
      setChatHasUnreadResponse(false);
    }
  }, [quickChatOpen, taskView]);

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
      if (taskView === "chat" || quickChatOpen) return;
      void fetchChatSessions(currentProjectId)
        .then((data) => {
          // `disposed` covers a taskView/quickChatOpen change too: both are effect deps, so opening
          // chat tears this subscription down before the response can land.
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
            if (taskView === "chat" || quickChatOpen) return;
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
            if (taskView === "chat" || quickChatOpen) return;
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
  }, [currentProjectId, quickChatOpen, taskView]);

  return { chatHasUnreadResponse };
}
