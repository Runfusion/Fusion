import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment, ChatRoom, ChatRoomMember, ChatRoomMessage } from "@fusion/core";
import {
  clearChatRoomMessages,
  createChatRoom,
  deleteChatRoom,
  fetchChatRoomMembers,
  fetchChatRoomMessages,
  fetchChatRooms,
  postChatRoomMessage,
  updateChatRoom,
  uploadChatRoomAttachment,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import {
  readCache,
  SWR_CACHE_KEYS,
  SWR_CHAT_ROOM_MAX_AGE_MS,
  SWR_DEFAULT_MAX_AGE_MS,
  SWR_LONG_MAX_AGE_MS,
  writeCache,
} from "../utils/swrCache";
import { startRoomOpenTimer } from "../utils/roomOpenDiagnostics";

const ACTIVE_ROOM_STORAGE_KEY = "fusion:chat-active-room";

export class RoomMessageDeliveredButReplyFailedError extends Error {
  roomId: string;

  constructor(message: string, roomId: string) {
    super(message);
    this.name = "RoomMessageDeliveredButReplyFailedError";
    this.roomId = roomId;
  }
}

export interface UseChatRoomsResult {
  rooms: ChatRoom[];
  roomsLoading: boolean;
  roomsError: string | null;
  activeRoom: ChatRoom | null;
  activeRoomMembers: ChatRoomMember[];
  messages: ChatRoomMessage[];
  messagesLoading: boolean;
  selectRoom: (roomId: string | null) => void;
  createRoom: (input: { name: string; memberAgentIds: string[] }) => Promise<ChatRoom>;
  updateRoomSettings: (roomId: string, updates: { thinkingLevel?: string | null }) => Promise<ChatRoom>;
  deleteRoom: (roomId: string) => Promise<void>;
  sendRoomMessage: (content: string, opts?: { attachments?: ChatAttachment[]; files?: File[] }) => Promise<void>;
  clearRoom: (roomId: string) => Promise<void>;
  refreshRooms: () => Promise<void>;
}

function sortRooms(nextRooms: ChatRoom[]): ChatRoom[] {
  return [...nextRooms].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function upsertRoom(existingRooms: ChatRoom[], room: ChatRoom): ChatRoom[] {
  const idx = existingRooms.findIndex((candidate) => candidate.id === room.id);
  if (idx === -1) return sortRooms([room, ...existingRooms]);
  const next = [...existingRooms];
  next[idx] = room;
  return sortRooms(next);
}

function parseSsePayload<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

/*
FNXC:ChatRooms 2026-07-16-00:00:
Room transcripts must render oldest-first, even though the room API fetches the newest
window first with `order: "desc"`. FN-8062 normalizes every fetched snapshot here so
optimistic, delivered, SSE, read-tracking, and render paths can consistently append/use
`messages[messages.length - 1]` as the newest message.
*/
function toAscending(messages: ChatRoomMessage[]): ChatRoomMessage[] {
  return messages.slice().reverse();
}

function createOptimisticRoomMessage(roomId: string, content: string, attachments?: ChatAttachment[]): ChatRoomMessage {
  return {
    id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    roomId,
    role: "user",
    content,
    thinkingOutput: null,
    metadata: null,
    senderAgentId: null,
    mentions: [],
    ...(attachments?.length ? { attachments } : {}),
    createdAt: new Date().toISOString(),
  };
}

function reconcileOptimisticUserMessage(
  previous: ChatRoomMessage[],
  delivered: ChatRoomMessage,
  optimisticId?: string,
): ChatRoomMessage[] {
  if (previous.some((candidate) => candidate.id === delivered.id)) {
    return previous;
  }

  const optimisticIndexById = optimisticId
    ? previous.findIndex((candidate) => candidate.id === optimisticId)
    : -1;
  if (optimisticIndexById >= 0) {
    const next = [...previous];
    next[optimisticIndexById] = delivered;
    return next;
  }

  if (delivered.role === "user") {
    const optimisticIndexByContent = previous.findIndex((candidate) =>
      candidate.role === "user"
      && candidate.id.startsWith("temp-")
      && candidate.content.trim() === delivered.content.trim());
    if (optimisticIndexByContent >= 0) {
      const next = [...previous];
      next[optimisticIndexByContent] = delivered;
      return next;
    }
  }

  return [...previous, delivered];
}

export function useChatRooms(
  projectId?: string,
  addToast?: (msg: string, type?: "success" | "error" | "warning") => void,
): UseChatRoomsResult {
  const { t } = useTranslation("app");
  const roomsCacheKey = `${SWR_CACHE_KEYS.CHAT_ROOMS}:${projectId ?? "global"}`;
  const activeRoomCacheKey = `${SWR_CACHE_KEYS.ACTIVE_CHAT_ROOM_ID}:${projectId ?? "global"}`;
  const messagesCacheKey = useCallback(
    (roomId: string) => `${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}${projectId ?? "global"}:${roomId}`,
    [projectId],
  );
  const membersCacheKey = useCallback(
    (roomId: string) => `${SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX}${projectId ?? "global"}:${roomId}`,
    [projectId],
  );
  const [rooms, setRooms] = useState<ChatRoom[]>(() => {
    const cached = readCache<ChatRoom[]>(roomsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [roomsLoading, setRoomsLoading] = useState(() => rooms.length === 0);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<ChatRoom | null>(() => {
    const cachedRoomId = readCache<string>(activeRoomCacheKey, { maxAgeMs: SWR_LONG_MAX_AGE_MS });
    if (!cachedRoomId) {
      return null;
    }
    return rooms.find((room) => room.id === cachedRoomId) ?? null;
  });
  const [activeRoomMembers, setActiveRoomMembers] = useState<ChatRoomMember[]>([]);
  const [messages, setMessages] = useState<ChatRoomMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const roomsRef = useRef(rooms);
  const activeRoomRef = useRef(activeRoom);
  const projectContextVersionRef = useRef(0);
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  roomsRef.current = rooms;
  activeRoomRef.current = activeRoom;

  if (previousProjectIdRef.current !== projectId) {
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current += 1;
  }

  const loadRoomData = useCallback(async (room: ChatRoom | null) => {
    if (!room) {
      setActiveRoomMembers([]);
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    const timer = startRoomOpenTimer(room.id, { warm: false });
    timer.mark("select");

    const cachedMessages = readCache<ChatRoomMessage[]>(messagesCacheKey(room.id), { maxAgeMs: SWR_CHAT_ROOM_MAX_AGE_MS });
    const cachedMembers = readCache<ChatRoomMember[]>(membersCacheKey(room.id), { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const hasCachedMessages = Array.isArray(cachedMessages) && cachedMessages.length > 0;
    const hasCachedMembers = Array.isArray(cachedMembers) && cachedMembers.length > 0;

    if (hasCachedMessages || hasCachedMembers) {
      timer.mark("cache-hit");
      if (hasCachedMessages) {
        setMessages(cachedMessages);
        timer.mark("hydrate");
      }
      if (hasCachedMembers) {
        setActiveRoomMembers(cachedMembers);
      }
      setMessagesLoading(false);
    } else {
      setMessages([]);
      setMessagesLoading(true);
    }

    try {
      const [membersData, messagesData] = await Promise.all([
        fetchChatRoomMembers(room.id, projectId),
        fetchChatRoomMessages(room.id, { limit: 100, order: "desc" }, projectId),
      ]);
      timer.mark("members-fetch");
      timer.mark("messages-fetch");
      writeCache(membersCacheKey(room.id), membersData.members, { maxBytes: 500_000 });
      const ascendingMessages = toAscending(messagesData.messages);
      // Cache snapshots are normalized oldest-first so warm hydration cannot reintroduce server order.
      writeCache(messagesCacheKey(room.id), ascendingMessages, { maxBytes: 500_000 });

      if (activeRoomRef.current?.id === room.id) {
        setActiveRoomMembers(membersData.members);
        setMessages(ascendingMessages);
        timer.mark("hydrate");
      }
    } catch {
      if (!hasCachedMessages && !hasCachedMembers) {
        setActiveRoomMembers([]);
        setMessages([]);
      }
    } finally {
      setMessagesLoading(false);
      timer.complete({ warm: hasCachedMessages, membersCached: hasCachedMembers });
    }
  }, [membersCacheKey, messagesCacheKey, projectId]);

  const refreshRooms = useCallback(async () => {
    if (roomsRef.current.length === 0) {
      setRoomsLoading(true);
    }
    try {
      const data = await fetchChatRooms({}, projectId);
      const sortedRooms = sortRooms(data.rooms);
      setRooms(sortedRooms);
      writeCache(roomsCacheKey, sortedRooms, { maxBytes: 500_000 });
      setRoomsError(null);

      const persistedRoomId = readCache<string>(activeRoomCacheKey, { maxAgeMs: SWR_LONG_MAX_AGE_MS }) ?? getScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
      if (persistedRoomId) {
        const persistedRoom = sortedRooms.find((room) => room.id === persistedRoomId) ?? null;
        if (persistedRoom) {
          setActiveRoom(persistedRoom);
          void loadRoomData(persistedRoom);
        } else {
          removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
          writeCache(activeRoomCacheKey, "", { maxBytes: 500_000 });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t("chatRooms.error.failedToLoad", "Failed to load chat rooms");
      setRoomsError(message);
      addToast?.(message, "error");
    } finally {
      setRoomsLoading(false);
    }
  }, [activeRoomCacheKey, addToast, loadRoomData, projectId, roomsCacheKey]);

  const selectRoom = useCallback((roomId: string | null) => {
    if (!roomId) {
      activeRoomRef.current = null;
      setActiveRoom(null);
      removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
      writeCache(activeRoomCacheKey, "", { maxBytes: 500_000 });
      void loadRoomData(null);
      return;
    }

    const room = roomsRef.current.find((candidate) => candidate.id === roomId) ?? null;
    activeRoomRef.current = room;
    setActiveRoom(room);
    if (room) {
      setScopedItem(ACTIVE_ROOM_STORAGE_KEY, room.id, projectId);
      writeCache(activeRoomCacheKey, room.id, { maxBytes: 500_000 });
      void loadRoomData(room);
    }
  }, [activeRoomCacheKey, loadRoomData, projectId]);

  const createRoomLocal = useCallback(async (input: { name: string; memberAgentIds: string[] }) => {
    const created = await createChatRoom({ name: input.name, memberAgentIds: input.memberAgentIds }, projectId);
    const nextRoom = created.room;

    setRooms((previous) => upsertRoom(previous, nextRoom));
    activeRoomRef.current = nextRoom;
    setActiveRoom(nextRoom);
    setScopedItem(ACTIVE_ROOM_STORAGE_KEY, nextRoom.id, projectId);
    writeCache(activeRoomCacheKey, nextRoom.id, { maxBytes: 500_000 });
    await loadRoomData(nextRoom);

    return nextRoom;
  }, [activeRoomCacheKey, loadRoomData, projectId]);

  const updateRoomSettings = useCallback(async (roomId: string, updates: { thinkingLevel?: string | null }) => {
    const response = await updateChatRoom(roomId, updates, projectId);
    const nextRoom = response.room;

    setRooms((previous) => upsertRoom(previous, nextRoom));
    if (activeRoomRef.current?.id === nextRoom.id) {
      activeRoomRef.current = nextRoom;
      setActiveRoom(nextRoom);
    }
    return nextRoom;
  }, [projectId]);

  const deleteRoomLocal = useCallback(async (roomId: string) => {
    await deleteChatRoom(roomId, projectId);
    setRooms((previous) => previous.filter((room) => room.id !== roomId));
    // Invalidate by writing empty snapshots for deterministic warm-open behavior.
    writeCache(messagesCacheKey(roomId), [], { maxBytes: 500_000 });
    writeCache(membersCacheKey(roomId), [], { maxBytes: 500_000 });

    if (activeRoomRef.current?.id === roomId) {
      activeRoomRef.current = null;
      setActiveRoom(null);
      setActiveRoomMembers([]);
      setMessages([]);
      removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
      writeCache(activeRoomCacheKey, "", { maxBytes: 500_000 });
    }
  }, [activeRoomCacheKey, membersCacheKey, messagesCacheKey, projectId]);

  /**
   * Sends a room message with optimistic UI.
   *
   * Error contract:
   * - Throws the original error when delivery did not happen (before `postChatRoomMessage` resolves); callers may restore composer text.
   * - Throws `RoomMessageDeliveredButReplyFailedError` when delivery succeeded but a post-send step failed; callers must keep composer cleared.
   *
   * FNXC:RoomChatReliability 2026-07-01-00:00:
   * Responder/provider failures can occur after the room user message is persisted. Keep the optimistic or recovered user row visible for delivered sends even when the reply-generation or refresh step fails, because that turn is already part of the room transcript context.
   */
  const sendRoomMessage = useCallback(async (content: string, opts?: { attachments?: ChatAttachment[]; files?: File[] }) => {
    const activeRoomSnapshot = activeRoomRef.current;
    const roomId = activeRoomSnapshot?.id;
    if (!roomId) {
      throw new Error(t("chatRooms.error.selectRoomFirst", "Select a room before sending a message"));
    }

    const timer = startRoomOpenTimer(roomId, { warm: false });
    const placeholderAttachments = opts?.files?.map((file) => ({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename: file.name,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      createdAt: new Date().toISOString(),
    } satisfies ChatAttachment));

    const optimisticMessage = createOptimisticRoomMessage(roomId, content, placeholderAttachments?.length ? placeholderAttachments : opts?.attachments);
    if (activeRoomRef.current?.id === roomId) {
      setMessages((previous) => {
        const next = [...previous, optimisticMessage];
        // Cache snapshots are stored oldest-first, matching the room display contract.
        writeCache(messagesCacheKey(roomId), next, { maxBytes: 500_000 });
        return next;
      });
    }

    let userMessageDelivered = false;

    try {
      const uploadedAttachments: ChatAttachment[] = [];
      if (opts?.files?.length) {
        for (const file of opts.files) {
          try {
            const uploaded = await uploadChatRoomAttachment(roomId, file, projectId);
            uploadedAttachments.push(uploaded.attachment);
          } catch {
            throw new Error(t("chatRooms.error.failedToUpload", "Failed to upload attachment: {{filename}}", { filename: file.name }));
          }
        }
      }

      const mergedAttachments = [...(opts?.attachments ?? []), ...uploadedAttachments];

      const postResult = await postChatRoomMessage(roomId, {
        content,
        ...(mergedAttachments.length ? { attachments: mergedAttachments } : {}),
      }, projectId);
      userMessageDelivered = true;

      if (postResult.message?.createdAt && activeRoomSnapshot) {
        setRooms((previous) => upsertRoom(previous, { ...activeRoomSnapshot, updatedAt: postResult.message.createdAt }));
      }

      if (activeRoomRef.current?.id === roomId) {
        setMessages((previous) => {
          const next = reconcileOptimisticUserMessage(previous, postResult.message, optimisticMessage.id);
          // Cache snapshots are stored oldest-first, matching the room display contract.
          writeCache(messagesCacheKey(roomId), next, { maxBytes: 500_000 });
          return next;
        });
      }

      const latestMessages = await fetchChatRoomMessages(roomId, { limit: 100, order: "desc" }, projectId);
      const ascendingMessages = toAscending(latestMessages.messages);
      // Cache snapshots are normalized oldest-first for display and warm hydration.
      writeCache(messagesCacheKey(roomId), ascendingMessages, { maxBytes: 500_000 });
      if (activeRoomRef.current?.id !== roomId) {
        return;
      }
      setMessages(ascendingMessages);
      timer.mark("hydrate");
    } catch (error) {
      let recoveredMessages: ChatRoomMessage[] | null = null;
      try {
        const latestMessages = await fetchChatRoomMessages(roomId, { limit: 100, order: "desc" }, projectId);
        recoveredMessages = toAscending(latestMessages.messages);
        // Cache snapshots are normalized oldest-first for display and warm hydration.
        writeCache(messagesCacheKey(roomId), recoveredMessages, { maxBytes: 500_000 });
        if (activeRoomRef.current?.id === roomId) {
          setMessages(recoveredMessages);
          timer.mark("hydrate");
        }
      } catch {
        if (!userMessageDelivered && activeRoomRef.current?.id === roomId) {
          setMessages((previous) => {
            const next = previous.filter((message) => message.id !== optimisticMessage.id);
            // Cache snapshots are stored oldest-first, matching the room display contract.
            writeCache(messagesCacheKey(roomId), next, { maxBytes: 500_000 });
            return next;
          });
        }
      }

      const messageDeliveredAfterRecovery = recoveredMessages?.some((candidate) =>
        candidate.role === "user" && candidate.content.trim() === optimisticMessage.content.trim());

      if (userMessageDelivered || messageDeliveredAfterRecovery) {
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : t("chatRooms.error.deliveredButRefreshFailed", "Message delivered, but failed to refresh room replies");
        throw new RoomMessageDeliveredButReplyFailedError(message, roomId);
      }

      throw error;
    } finally {
      timer.complete({ source: "send-room-message" });
    }
  }, [messagesCacheKey, projectId]);

  const clearRoom = useCallback(async (roomId: string) => {
    if (!roomId || !roomsRef.current.some((room) => room.id === roomId)) {
      return;
    }

    await clearChatRoomMessages(roomId, projectId);
    // Invalidate by writing an empty snapshot for deterministic warm-open behavior.
    writeCache(messagesCacheKey(roomId), [], { maxBytes: 500_000 });
    if (activeRoomRef.current?.id === roomId) {
      setMessages([]);
    }
  }, [messagesCacheKey, projectId]);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  useEffect(() => {
    const contextVersionAtStart = projectContextVersionRef.current;
    const eventsUrl = projectId ? `/api/events?projectId=${encodeURIComponent(projectId)}` : "/api/events";

    return subscribeSse(eventsUrl, {
      onReconnect: () => {
        recordResumeEvent({
          view: "useChatRooms",
          trigger: "sse-reconnect",
          projectId,
          replayAttempted: false,
        });
        const roomId = activeRoomRef.current?.id;
        if (roomId) {
          const timer = startRoomOpenTimer(roomId, { warm: true });
          timer.mark("sse-reconnect-refresh");
          void refreshRooms().finally(() => timer.complete({ source: "sse-reconnect" }));
          return;
        }
        void refreshRooms();
      },
      events: {
        "chat:room:created": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const room = parseSsePayload<ChatRoom>(event);
          if (!room) return;
          setRooms((previous) => upsertRoom(previous, room));
        },
        "chat:room:updated": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const room = parseSsePayload<ChatRoom>(event);
          if (!room) return;
          setRooms((previous) => upsertRoom(previous, room));
          if (activeRoomRef.current?.id === room.id) {
            activeRoomRef.current = room;
            setActiveRoom(room);
          }
        },
        "chat:room:deleted": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ id: string }>(event);
          if (!payload?.id) return;
          setRooms((previous) => previous.filter((room) => room.id !== payload.id));
          // Invalidate by writing empty snapshots for deterministic warm-open behavior.
          writeCache(messagesCacheKey(payload.id), [], { maxBytes: 500_000 });
          writeCache(membersCacheKey(payload.id), [], { maxBytes: 500_000 });
          if (activeRoomRef.current?.id === payload.id) {
            activeRoomRef.current = null;
            setActiveRoom(null);
            setActiveRoomMembers([]);
            setMessages([]);
            removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
            writeCache(activeRoomCacheKey, "", { maxBytes: 500_000 });
          }
        },
        "chat:room:member:added": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<ChatRoomMember>(event);
          if (!payload || activeRoomRef.current?.id !== payload.roomId) return;
          setActiveRoomMembers((previous) => {
            if (previous.some((member) => member.agentId === payload.agentId)) {
              return previous;
            }
            const next = [...previous, payload];
            writeCache(membersCacheKey(payload.roomId), next, { maxBytes: 500_000 });
            return next;
          });
        },
        "chat:room:member:removed": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ roomId: string; agentId: string }>(event);
          if (!payload || activeRoomRef.current?.id !== payload.roomId) return;
          setActiveRoomMembers((previous) => {
            const next = previous.filter((member) => member.agentId !== payload.agentId);
            writeCache(membersCacheKey(payload.roomId), next, { maxBytes: 500_000 });
            return next;
          });
        },
        "chat:room:message:added": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const message = parseSsePayload<ChatRoomMessage>(event);
          if (!message) return;

          setRooms((previous) => {
            const room = previous.find((candidate) => candidate.id === message.roomId);
            if (!room) return previous;
            return upsertRoom(previous, { ...room, updatedAt: message.createdAt });
          });

          if (activeRoomRef.current?.id !== message.roomId) return;
          setMessages((previous) => {
            const next = reconcileOptimisticUserMessage(previous, message);
            if (next === previous) {
              return previous;
            }
            // Cache snapshots are stored oldest-first, matching the room display contract.
            writeCache(messagesCacheKey(message.roomId), next, { maxBytes: 500_000 });
            return next;
          });
        },
        "chat:room:message:updated": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const message = parseSsePayload<ChatRoomMessage>(event);
          if (!message || activeRoomRef.current?.id !== message.roomId) return;
          setMessages((previous) => {
            const next = previous.map((candidate) => (candidate.id === message.id ? message : candidate));
            // Cache snapshots are stored oldest-first, matching the room display contract.
            writeCache(messagesCacheKey(message.roomId), next, { maxBytes: 500_000 });
            return next;
          });
        },
        "chat:room:message:deleted": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ id: string }>(event);
          if (!payload?.id) return;
          setMessages((previous) => {
            const next = previous.filter((message) => message.id !== payload.id);
            const activeRoomId = activeRoomRef.current?.id;
            if (activeRoomId) {
              // Cache snapshots are stored oldest-first, matching the room display contract.
              writeCache(messagesCacheKey(activeRoomId), next, { maxBytes: 500_000 });
            }
            return next;
          });
        },
        "chat:room:messages:cleared": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ roomId: string; deletedCount: number }>(event);
          if (!payload?.roomId) return;

          // Invalidate by writing an empty snapshot for deterministic warm-open behavior.
          writeCache(messagesCacheKey(payload.roomId), [], { maxBytes: 500_000 });
          if (activeRoomRef.current?.id === payload.roomId) {
            setMessages([]);
          }

          setRooms((previous) => {
            const room = previous.find((candidate) => candidate.id === payload.roomId);
            if (!room) return previous;
            return upsertRoom(previous, { ...room, updatedAt: new Date().toISOString() });
          });
        },
      },
    });
  }, [activeRoomCacheKey, membersCacheKey, messagesCacheKey, projectId, refreshRooms]);

  useEffect(() => {
    if (!activeRoom) return;
    if (!rooms.some((room) => room.id === activeRoom.id)) {
      activeRoomRef.current = null;
      setActiveRoom(null);
      setActiveRoomMembers([]);
      setMessages([]);
      removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
      writeCache(activeRoomCacheKey, "", { maxBytes: 500_000 });
    }
  }, [activeRoom, activeRoomCacheKey, projectId, rooms]);

  return {
    rooms,
    roomsLoading,
    roomsError,
    activeRoom,
    activeRoomMembers,
    messages,
    messagesLoading,
    selectRoom,
    createRoom: createRoomLocal,
    updateRoomSettings,
    deleteRoom: deleteRoomLocal,
    sendRoomMessage,
    clearRoom,
    refreshRooms,
  };
}
