import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchChatSessions,
  createChatSession as apiCreateChatSession,
  fetchChatMessages,
  updateChatSession,
  deleteChatSession,
  streamChatResponse,
  fetchAgents,
  type ChatSessionListResponse,
} from "../api";
import type { Agent } from "@fusion/core";

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

  // Session operations
  selectSession: (id: string) => void;
  createSession: (
    input: { agentId: string; title?: string; modelProvider?: string; modelId?: string },
  ) => Promise<ChatSessionInfo>;
  archiveSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  // Message operations
  sendMessage: (content: string) => Promise<void>;
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

  // Search/filter
  const [searchQuery, setSearchQuery] = useState("");

  // Pagination
  const [hasMoreMessages, setHasMoreMessages] = useState(true);

  // Agent name resolution map
  const [agentsMap, setAgentsMap] = useState<Map<string, Agent>>(new Map());

  // Stream connection ref for cleanup
  const streamRef = useRef<{ close: () => void } | null>(null);

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

  // Load messages when active session changes
  const loadMessages = useCallback(
    async (sessionId: string, opts?: { offset?: number }) => {
      setMessagesLoading(true);
      try {
        const data = await fetchChatMessages(sessionId, { limit: 50, ...opts }, projectId);
        if (opts?.offset && opts.offset > 0) {
          // Prepend older messages
          setMessages((prev) => [...data.messages.reverse(), ...prev]);
        } else {
          setMessages(data.messages.reverse());
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
    },
    [sessions, loadMessages],
  );

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

  // Send a message
  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeSession) return;

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

          // Preserve user message and add assistant message
          setMessages((prev) => [...prev, assistantMessage]);

          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;
          refreshSessions();
        },
        onError: (data: string) => {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;
          console.error("[useChat] Stream error:", data);
        },
      };

      streamRef.current = streamChatResponse(activeSession.id, content, textHandlers, projectId);
    },
    [activeSession, projectId, refreshSessions],
  );

  // Filter sessions based on search query
  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.agentId.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : sessions;

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
    selectSession,
    createSession,
    archiveSession,
    deleteSession,
    sendMessage,
    loadMoreMessages,
    hasMoreMessages,
    searchQuery,
    setSearchQuery,
    filteredSessions,
    refreshSessions,
    agentsMap,
  };
}
