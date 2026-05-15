import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment, ChatRoom, ChatRoomMember, ChatRoomMessage } from "@fusion/core";
import {
  createChatRoom,
  deleteChatRoom,
  fetchChatRoomMembers,
  fetchChatRoomMessages,
  fetchChatRooms,
  postChatRoomMessage,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";

const ACTIVE_ROOM_STORAGE_KEY = "fusion:chat-active-room";

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
  deleteRoom: (roomId: string) => Promise<void>;
  sendRoomMessage: (content: string, opts?: { attachments?: ChatAttachment[] }) => Promise<void>;
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

function createOptimisticRoomMessage(roomId: string, content: string): ChatRoomMessage {
  return {
    id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    roomId,
    role: "user",
    content,
    thinkingOutput: null,
    metadata: null,
    senderAgentId: null,
    mentions: [],
    createdAt: new Date().toISOString(),
  };
}

export function useChatRooms(
  projectId?: string,
  addToast?: (msg: string, type?: "success" | "error" | "warning") => void,
): UseChatRoomsResult {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<ChatRoom | null>(null);
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

  const loadRoomData = useCallback(async (room: ChatRoom | null, clearFirst = true) => {
    if (!room) {
      setActiveRoomMembers([]);
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    if (clearFirst) {
      setMessages([]);
    }
    setMessagesLoading(true);

    try {
      const [membersData, messagesData] = await Promise.all([
        fetchChatRoomMembers(room.id, projectId),
        fetchChatRoomMessages(room.id, { limit: 100, order: "desc" }, projectId),
      ]);
      setActiveRoomMembers(membersData.members);
      setMessages(messagesData.messages);
    } catch {
      setActiveRoomMembers([]);
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, [projectId]);

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    try {
      const data = await fetchChatRooms({}, projectId);
      const sortedRooms = sortRooms(data.rooms);
      setRooms(sortedRooms);
      setRoomsError(null);

      const persistedRoomId = getScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
      if (persistedRoomId) {
        const persistedRoom = sortedRooms.find((room) => room.id === persistedRoomId) ?? null;
        if (persistedRoom) {
          setActiveRoom(persistedRoom);
          void loadRoomData(persistedRoom, true);
        } else {
          removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load chat rooms";
      setRoomsError(message);
      addToast?.(message, "error");
    } finally {
      setRoomsLoading(false);
    }
  }, [addToast, loadRoomData, projectId]);

  const selectRoom = useCallback((roomId: string | null) => {
    if (!roomId) {
      setActiveRoom(null);
      removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
      void loadRoomData(null, true);
      return;
    }

    const room = roomsRef.current.find((candidate) => candidate.id === roomId) ?? null;
    setActiveRoom(room);
    if (room) {
      setScopedItem(ACTIVE_ROOM_STORAGE_KEY, room.id, projectId);
      void loadRoomData(room, true);
    }
  }, [loadRoomData, projectId]);

  const createRoomLocal = useCallback(async (input: { name: string; memberAgentIds: string[] }) => {
    const created = await createChatRoom({ name: input.name, memberAgentIds: input.memberAgentIds }, projectId);
    const nextRoom = created.room;

    setRooms((previous) => upsertRoom(previous, nextRoom));
    setActiveRoom(nextRoom);
    setScopedItem(ACTIVE_ROOM_STORAGE_KEY, nextRoom.id, projectId);
    await loadRoomData(nextRoom, true);

    return nextRoom;
  }, [loadRoomData, projectId]);

  const deleteRoomLocal = useCallback(async (roomId: string) => {
    await deleteChatRoom(roomId, projectId);
    setRooms((previous) => previous.filter((room) => room.id !== roomId));

    if (activeRoomRef.current?.id === roomId) {
      setActiveRoom(null);
      setActiveRoomMembers([]);
      setMessages([]);
      removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
    }
  }, [projectId]);

  const sendRoomMessage = useCallback(async (content: string, opts?: { attachments?: ChatAttachment[] }) => {
    const activeRoomSnapshot = activeRoomRef.current;
    const roomId = activeRoomSnapshot?.id;
    if (!roomId) {
      throw new Error("Select a room before sending a message");
    }

    const optimisticMessage = createOptimisticRoomMessage(roomId, content);
    if (activeRoomRef.current?.id === roomId) {
      setMessages((previous) => [...previous, optimisticMessage]);
    }

    try {
      const postResult = await postChatRoomMessage(roomId, {
        content,
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      }, projectId);

      if (postResult.message?.createdAt && activeRoomSnapshot) {
        setRooms((previous) => upsertRoom(previous, { ...activeRoomSnapshot, updatedAt: postResult.message.createdAt }));
      }

      if (activeRoomRef.current?.id === roomId) {
        setMessages((previous) => previous.map((message) =>
          message.id === optimisticMessage.id ? postResult.message : message));
      }

      const latestMessages = await fetchChatRoomMessages(roomId, { limit: 100, order: "desc" }, projectId);
      if (activeRoomRef.current?.id !== roomId) {
        return;
      }
      setMessages(latestMessages.messages);
    } catch (error) {
      try {
        const latestMessages = await fetchChatRoomMessages(roomId, { limit: 100, order: "desc" }, projectId);
        if (activeRoomRef.current?.id === roomId) {
          setMessages(latestMessages.messages);
        }
      } catch {
        if (activeRoomRef.current?.id === roomId) {
          setMessages((previous) => previous.filter((message) => message.id !== optimisticMessage.id));
        }
      }
      throw error;
    }
  }, [projectId]);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  useEffect(() => {
    const contextVersionAtStart = projectContextVersionRef.current;
    const eventsUrl = projectId ? `/api/events?projectId=${encodeURIComponent(projectId)}` : "/api/events";

    return subscribeSse(eventsUrl, {
      onReconnect: () => {
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
            setActiveRoom(room);
          }
        },
        "chat:room:deleted": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ id: string }>(event);
          if (!payload?.id) return;
          setRooms((previous) => previous.filter((room) => room.id !== payload.id));
          if (activeRoomRef.current?.id === payload.id) {
            setActiveRoom(null);
            setActiveRoomMembers([]);
            setMessages([]);
            removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
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
            return [...previous, payload];
          });
        },
        "chat:room:member:removed": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ roomId: string; agentId: string }>(event);
          if (!payload || activeRoomRef.current?.id !== payload.roomId) return;
          setActiveRoomMembers((previous) => previous.filter((member) => member.agentId !== payload.agentId));
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
            if (previous.some((candidate) => candidate.id === message.id)) {
              return previous;
            }

            if (message.role === "user") {
              const optimisticIndex = previous.findIndex((candidate) =>
                candidate.role === "user"
                && candidate.id.startsWith("temp-")
                && candidate.content.trim() === message.content.trim());
              if (optimisticIndex >= 0) {
                const next = [...previous];
                next[optimisticIndex] = message;
                return next;
              }
            }

            return [...previous, message];
          });
        },
        "chat:room:message:updated": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const message = parseSsePayload<ChatRoomMessage>(event);
          if (!message || activeRoomRef.current?.id !== message.roomId) return;
          setMessages((previous) => previous.map((candidate) => (candidate.id === message.id ? message : candidate)));
        },
        "chat:room:message:deleted": (event) => {
          if (projectContextVersionRef.current !== contextVersionAtStart) return;
          const payload = parseSsePayload<{ id: string }>(event);
          if (!payload?.id) return;
          setMessages((previous) => previous.filter((message) => message.id !== payload.id));
        },
      },
    });
  }, [projectId, refreshRooms]);

  useEffect(() => {
    if (!activeRoom) return;
    if (!rooms.some((room) => room.id === activeRoom.id)) {
      setActiveRoom(null);
      setActiveRoomMembers([]);
      setMessages([]);
      removeScopedItem(ACTIVE_ROOM_STORAGE_KEY, projectId);
    }
  }, [activeRoom, projectId, rooms]);

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
    deleteRoom: deleteRoomLocal,
    sendRoomMessage,
    refreshRooms,
  };
}
