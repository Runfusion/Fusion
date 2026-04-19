import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchChatSessions,
  createChatSession as apiCreateChatSession,
  fetchChatMessages,
  updateChatSession,
  deleteChatSession,
  streamChatResponse,
  cancelChatResponse,
  fetchAgents,
  type ChatSessionListResponse,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { getScopedItem, setScopedItem, removeScopedItem } from "../utils/projectStorage";
import type { Agent } from "@fusion/core";

const ACTIVE_SESSION_STORAGE_KEY = "kb-chat-active-session";

export interface ChatSessionInfo {
  id: string;
  title?: string | null;
  agentId: string;
  status: string;
  modelProvider?: string | null;
  modelId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
}

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingOutput?: string | null;
  createdAt: string;
}

export interface UseChatReturn {
  // Session state
  sessions: ChatSessionInfo[];
  activeSession: ChatSessionInfo | null;
  sessionsLoading: boolean;

  // Message state
  messages: ChatMessageInfo[];
  messagesLoading: boolean;
  isStreaming: boolean;
  streamingText: string;
  streamingThinking: string;
  pendingMessage: string;

  // Session operations
  selectSession: (id: string) => void;
  createSession: (
    input: { agentId: string; title?: string; modelProvider?: string; modelId?: string },
  ) => Promise<ChatSessionInfo>;
  archiveSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  // Message operations
  sendMessage: (content: string) => void;
  stopStreaming: () => void;
  clearPendingMessage: () => void;
  loadMoreMessages: () => Promise<void>;
  hasMoreMessages: boolean;

  // Search/filter
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredSessions: ChatSessionInfo[];

  // Refresh
  refreshSessions: () => Promise<void>;

  // Agent name resolution
  agentsMap: Map<string, Agent>;
}

export function useChat(projectId?: string): UseChatReturn {
  // Session state
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSessionInfo | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Message state
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");

  // Search/filter
  const [searchQuery, setSearchQuery] = useState("");

  // Pagination
  const [hasMoreMessages, setHasMoreMessages] = useState(true);

  // Agent name resolution map
  const [agentsMap, setAgentsMap] = useState<Map<string, Agent>>(new Map());

  // Stream connection ref for cleanup
  const streamRef = useRef<{ close: () => void } | null>(null);
  const cancelledByUserRef = useRef(false);
  const pendingMessageRef = useRef("");

  // Refs for SSE event handlers to access current state
  const sessionsRef = useRef(sessions);
  const activeSessionRef = useRef(activeSession);
  const isStreamingRef = useRef(isStreaming);
  sessionsRef.current = sessions;
  activeSessionRef.current = activeSession;
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    pendingMessageRef.current = pendingMessage;
  }, [pendingMessage]);

  // Tracks message IDs that were added via streaming completion.
  // Used to prevent duplicate messages when SSE event arrives before streaming state clears.
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());

  // Tracks the project context version to detect stale SSE events after project switches.
  // Incremented whenever projectId changes, invalidating any in-flight SSE handlers.
  const projectContextVersionRef = useRef(0);
  // Track previous projectId to detect changes
  const previousProjectIdRef = useRef<string | undefined>(projectId);

  // Detect project changes and invalidate SSE context
  if (previousProjectIdRef.current !== projectId) {
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current++;
  }

  // Fetch agents on mount for name resolution
  useEffect(() => {
    fetchAgents()
      .then((agents) => {
        const map = new Map<string, Agent>();
        for (const agent of agents) {
          map.set(agent.id, agent);
        }
        setAgentsMap(map);
      })
      .catch(() => {
        // Silently fail - keep empty map
      });
  }, []);

  // Fetch sessions
  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const data: ChatSessionListResponse = await fetchChatSessions(projectId);
      // Sort by updatedAt descending
      const sorted = [...data.sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      setSessions(sorted);
    } catch {
      // Silently fail on refresh
    } finally {
      setSessionsLoading(false);
    }
  }, [projectId]);

  // Initial load
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Restore active session from localStorage after initial load
  // Uses a ref to avoid circular dependency with selectSession
  const selectSessionRef = useRef<(id: string) => void>(() => {
    /* noop - will be replaced after selectSession is defined */
  });
  useEffect(() => {
    if (sessionsLoading) return; // Wait for sessions to load

    const savedSessionId = getScopedItem(ACTIVE_SESSION_STORAGE_KEY, projectId);
    if (savedSessionId) {
      // Check if the saved session exists in the loaded sessions
      const session = sessions.find((s) => s.id === savedSessionId);
      if (session) {
        selectSessionRef.current(savedSessionId);
      }
    }
  }, [sessionsLoading, sessions, projectId]);

  // Load messages when active session changes
  const loadMessages = useCallback(
    async (sessionId: string, opts?: { offset?: number }) => {
      setMessagesLoading(true);
      try {
        const data = await fetchChatMessages(sessionId, { limit: 50, ...opts }, projectId);
        if (opts?.offset && opts.offset > 0) {
          // Prepend older messages
          setMessages((prev) => [...data.messages, ...prev]);
        } else {
          setMessages(data.messages);
        }
        setHasMoreMessages(data.messages.length >= 50);
      } catch {
        // Silently fail
      } finally {
        setMessagesLoading(false);
      }
    },
    [projectId],
  );

  // Select a session
  const selectSession = useCallback(
    (id: string) => {
      // Close any existing stream
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }

      // Find and set active session
      const session = sessions.find((s) => s.id === id);
      setActiveSession(session || null);

      // Reset streaming state
      setStreamingText("");
      setStreamingThinking("");
      setIsStreaming(false);
      setHasMoreMessages(true);

      // Load messages for this session
      if (id) {
        loadMessages(id);
      } else {
        setMessages([]);
      }

      // Persist active session to localStorage
      if (id) {
        setScopedItem(ACTIVE_SESSION_STORAGE_KEY, id, projectId);
      } else {
        removeScopedItem(ACTIVE_SESSION_STORAGE_KEY, projectId);
      }
    },
    [sessions, loadMessages, projectId],
  );

  // Update the ref to point to the actual selectSession function
  // This is needed to avoid circular dependencies in useEffect
  selectSessionRef.current = selectSession;

  // Create a new session
  const createSession = useCallback(
    async (input: { agentId: string; title?: string; modelProvider?: string; modelId?: string }) => {
      const data = await apiCreateChatSession(input, projectId);
      const newSession: ChatSessionInfo = {
        id: data.session.id,
        title: data.session.title,
        agentId: data.session.agentId,
        status: data.session.status,
        modelProvider: data.session.modelProvider,
        modelId: data.session.modelId,
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt,
      };

      // Add to sessions list at the top
      setSessions((prev) => [newSession, ...prev]);

      // Select the new session
      setActiveSession(newSession);
      setMessages([]);
      setStreamingText("");
      setStreamingThinking("");
      setIsStreaming(false);
      setHasMoreMessages(true);

      return newSession;
    },
    [projectId],
  );

  // Archive a session
  const archiveSession = useCallback(
    async (id: string) => {
      await updateChatSession(id, { status: "archived" }, projectId);
      // Remove from sessions list
      setSessions((prev) => prev.filter((s) => s.id !== id));
      // If it was the active session, clear it
      if (activeSession?.id === id) {
        setActiveSession(null);
        setMessages([]);
      }
    },
    [activeSession, projectId],
  );

  // Delete a session
  const deleteSession = useCallback(
    async (id: string) => {
      // Close stream if active
      if (activeSession?.id === id && streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }

      await deleteChatSession(id, projectId);
      // Remove from sessions list
      setSessions((prev) => prev.filter((s) => s.id !== id));
      // If it was the active session, clear it
      if (activeSession?.id === id) {
        setActiveSession(null);
        setMessages([]);
      }
    },
    [activeSession, projectId],
  );

  // Load more messages (pagination)
  const loadMoreMessages = useCallback(async () => {
    if (!activeSession || !hasMoreMessages) return;
    await loadMessages(activeSession.id, { offset: messages.length });
  }, [activeSession, hasMoreMessages, loadMessages, messages.length]);

  const stopStreaming = useCallback(() => {
    if (!activeSession) return;

    cancelledByUserRef.current = true;
    streamRef.current?.close();
    streamRef.current = null;

    void cancelChatResponse(activeSession.id, projectId).catch(() => {
      // Best-effort cancellation; ignore backend errors.
    });

    setIsStreaming(false);
    setStreamingText("");
    setStreamingThinking("");
  }, [activeSession, projectId]);

  const clearPendingMessage = useCallback(() => {
    pendingMessageRef.current = "";
    setPendingMessage("");
  }, []);

  // Send a message
  const sendMessage = useCallback(
    (content: string) => {
      if (!activeSession) return;

      if (isStreaming) {
        pendingMessageRef.current = content;
        setPendingMessage(content);
        return;
      }

      cancelledByUserRef.current = false;

      // Close any existing stream
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }

      // Optimistically add user message
      const tempId = `temp-${Date.now()}`;
      const userMessage: ChatMessageInfo = {
        id: tempId,
        sessionId: activeSession.id,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Clear streaming state
      setStreamingText("");
      setStreamingThinking("");
      setIsStreaming(true);

      // Accumulate streaming text in local variables
      let capturedText = "";
      let capturedThinking = "";

      const textHandlers = {
        onThinking: (data: string) => {
          capturedThinking += data;
          setStreamingThinking(capturedThinking);
        },
        onText: (data: string) => {
          capturedText += data;
          setStreamingText(capturedText);
        },
        onDone: (data: { messageId: string }) => {
          const assistantMessage: ChatMessageInfo = {
            id: data.messageId || `msg-${Date.now()}`,
            sessionId: activeSession.id,
            role: "assistant",
            content: capturedText,
            thinkingOutput: capturedThinking,
            createdAt: new Date().toISOString(),
          };

          // Track this message ID so SSE handler skips it if event arrives first
          streamingMessageIdsRef.current.add(assistantMessage.id);

          // Preserve user message and add assistant message
          setMessages((prev) => [...prev, assistantMessage]);

          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;

          // Clean up tracked ID after a short delay (SSE event should arrive quickly)
          setTimeout(() => {
            streamingMessageIdsRef.current.delete(assistantMessage.id);
          }, 1000);

          refreshSessions();

          const queuedMessage = pendingMessageRef.current.trim();
          if (queuedMessage) {
            pendingMessageRef.current = "";
            setPendingMessage("");
            sendMessage(queuedMessage);
          }
        },
        onError: (data: string) => {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;
          console.error("[useChat] Stream error:", data);

          if (!cancelledByUserRef.current) {
            const queuedMessage = pendingMessageRef.current.trim();
            if (queuedMessage) {
              pendingMessageRef.current = "";
              setPendingMessage("");
              sendMessage(queuedMessage);
            }
          }
        },
      };

      streamRef.current = streamChatResponse(activeSession.id, content, textHandlers, projectId);
    },
    [activeSession, isStreaming, projectId, refreshSessions],
  );

  // Filter sessions based on search query
  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.agentId.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : sessions;

  // SSE real-time updates
  useEffect(() => {
    const contextVersionAtStart = projectContextVersionRef.current;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;

    const handleChatSessionCreated = (e: MessageEvent) => {
      if (isStale()) return;
      const session: ChatSessionInfo = JSON.parse(e.data);
      // Avoid duplicates
      setSessions((prev) => {
        if (prev.some((s) => s.id === session.id)) return prev;
        // Add at the top (sessions are sorted by updatedAt desc)
        return [session, ...prev];
      });
    };

    const handleChatSessionUpdated = (e: MessageEvent) => {
      if (isStale()) return;
      const updatedSession: ChatSessionInfo = JSON.parse(e.data);
      setSessions((prev) => {
        const updated = prev.map((s) => (s.id === updatedSession.id ? updatedSession : s));
        return [...updated];
      });
      // If this is the active session, update it too
      if (activeSessionRef.current?.id === updatedSession.id) {
        setActiveSession(updatedSession);
      }
    };

    const handleChatSessionDeleted = (e: MessageEvent) => {
      if (isStale()) return;
      const { id: sessionId }: { id: string } = JSON.parse(e.data);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      // If this was the active session, clear it
      if (activeSessionRef.current?.id === sessionId) {
        setActiveSession(null);
        setMessages([]);
      }
    };

    const handleChatMessageAdded = (e: MessageEvent) => {
      if (isStale()) return;
      const message: ChatMessageInfo = JSON.parse(e.data);

      // Skip if this message was already added via streaming completion
      // (SSE event may arrive before streaming state clears)
      if (streamingMessageIdsRef.current.has(message.id)) {
        return;
      }

      // Only add if this is the active session AND we're not streaming
      // (during streaming, messages are managed locally to avoid duplicates)
      // Use ref to get the current value (state may not be updated yet when handler runs)
      if (activeSessionRef.current?.id === message.sessionId && !isStreamingRef.current) {
        setMessages((prev) => {
          // Avoid duplicates
          if (prev.some((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }
    };

    const handleChatMessageDeleted = (e: MessageEvent) => {
      if (isStale()) return;
      const { id: messageId }: { id: string } = JSON.parse(e.data);
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "chat:session:created": handleChatSessionCreated,
        "chat:session:updated": handleChatSessionUpdated,
        "chat:session:deleted": handleChatSessionDeleted,
        "chat:message:added": handleChatMessageAdded,
        "chat:message:deleted": handleChatMessageDeleted,
      },
    });

    return unsubscribe;
  }, [projectId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  return {
    sessions,
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    pendingMessage,
    selectSession,
    createSession,
    archiveSession,
    deleteSession,
    sendMessage,
    stopStreaming,
    clearPendingMessage,
    loadMoreMessages,
    hasMoreMessages,
    searchQuery,
    setSearchQuery,
    filteredSessions,
    refreshSessions,
    agentsMap,
  };
}
