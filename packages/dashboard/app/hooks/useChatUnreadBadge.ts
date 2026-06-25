/*
FNXC:ChatBadge 2026-06-24-00:00:
Header/mobile-nav unread indicator for assistant chat responses. Set when an assistant message arrives over SSE while the user is not viewing chat, and cleared when the chat view (or quick-chat window) opens. Extracted verbatim from AppInner.
*/

import { useEffect, useState } from "react";
import type { ChatRoomMessage } from "@fusion/core";
import { subscribeSse } from "../sse-bus";
import type { TaskView } from "./useViewState";

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

  useEffect(() => {
    if (taskView === "chat" || quickChatOpen) {
      setChatHasUnreadResponse(false);
    }
  }, [quickChatOpen, taskView]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (currentProjectId) {
      params.set("projectId", currentProjectId);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    return subscribeSse(`/api/events${query}`, {
      events: {
        "chat:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as { role?: string; projectId?: string | null };
            if (payload.role !== "assistant") return;
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
  }, [currentProjectId, quickChatOpen, taskView]);

  return { chatHasUnreadResponse };
}
