import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSession } from "@fusion/core";
import {
  fetchChatSessions,
  createChatSession,
  fetchChatMessages,
  streamChatResponse,
} from "../api";

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingOutput?: string | null;
  createdAt: string;
}

export interface UseQuickChatReturn {
  // Session state
  activeSession: ChatSession | null;
  sessionsLoading: boolean;

  // Message state
  messages: ChatMessageInfo[];
  messagesLoading: boolean;
  isStreaming: boolean;
  streamingText: string;
  streamingThinking: string;

  // Operations
  sendMessage: (content: string) => Promise<void>;
  switchSession: (agentId: string) => Promise<void>;
  loadMessages: () => Promise<void>;
  reloadMessages: () => Promise<void>;
}

/**
 * Hook for the QuickChatFAB component.
 * Provides chat session management and SSE streaming for real-time AI responses.
 */
export function useQuickChat(
  projectId?: string,
  addToast?: (msg: string, type?: "success" | "error") => void,
): UseQuickChatReturn {
  // Session state
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Message state
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");

  // Stream connection ref for cleanup
  const streamRef = useRef<{ close: () => void } | null>(null);

  // Track the current selected agent ID for session management
  const currentAgentIdRef = useRef<string>("");

  // Fetch existing sessions and find/create one for the given agent
  const initializeSession = useCallback(
    async (agentId: string) => {
      if (!agentId) return;

      setSessionsLoading(true);
      try {
        const data = await fetchChatSessions(projectId, "active");
        // Find existing session for this agent
        const existingSession = data.sessions.find((s) => s.agentId === agentId);

        if (existingSession) {
          setActiveSession(existingSession);
          currentAgentIdRef.current = agentId;
        } else {
          // Create a new session for this agent
          const newSession = await createChatSession({ agentId }, projectId);
          setActiveSession(newSession.session);
          currentAgentIdRef.current = agentId;
        }
      } catch (err) {
        console.error("[useQuickChat] Failed to initialize session:", err);
        addToast?.("Failed to initialize chat", "error");
      } finally {
        setSessionsLoading(false);
      }
    },
    [projectId, addToast],
  );

  // Load messages for the active session
  const loadMessages = useCallback(async () => {
    if (!activeSession) return;

    setMessagesLoading(true);
    try {
      const data = await fetchChatMessages(activeSession.id, { limit: 50 }, projectId);
      // Reverse to show oldest first
      setMessages(data.messages.reverse());
    } catch (err) {
      console.error("[useQuickChat] Failed to load messages:", err);
    } finally {
      setMessagesLoading(false);
    }
  }, [activeSession, projectId]);

  // Load messages when session changes
  useEffect(() => {
    if (activeSession) {
      void loadMessages();
    } else {
      setMessages([]);
    }
  }, [activeSession, loadMessages]);

  // Reload messages from server (for same-agent revisit)
  const reloadMessages = useCallback(async () => {
    if (!activeSession) return;
    setMessagesLoading(true);
    try {
      const data = await fetchChatMessages(activeSession.id, { limit: 50 }, projectId);
      setMessages(data.messages.reverse());
    } catch (err) {
      console.error("[useQuickChat] Failed to reload messages:", err);
    } finally {
      setMessagesLoading(false);
    }
  }, [activeSession, projectId]);

  // Switch to a different agent's session
  const switchSession = useCallback(
    async (agentId: string) => {
      // Close any existing stream
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }

      // Reset streaming state
      setStreamingText("");
      setStreamingThinking("");
      setIsStreaming(false);

      if (agentId === currentAgentIdRef.current) {
        // Same agent — just reload messages from server
        await reloadMessages();
        return;
      }

      // Clear old messages immediately so stale conversation doesn't briefly flash
      // while the new agent's session loads
      setMessages([]);

      // New agent — initialize session
      currentAgentIdRef.current = agentId;
      await initializeSession(agentId);
    },
    [initializeSession, reloadMessages],
  );

  // Send a message using SSE streaming
  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeSession || !content.trim()) return;

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
            thinkingOutput: capturedThinking || undefined,
            createdAt: new Date().toISOString(),
          };

          // Preserve user message and add assistant message
          setMessages((prev) => [...prev, assistantMessage]);

          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;
        },
        onError: (data: string) => {
          // Remove the optimistic user message on error
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;
          console.error("[useQuickChat] Stream error:", data);
          addToast?.("Failed to send message", "error");
        },
      };

      streamRef.current = streamChatResponse(activeSession.id, content, textHandlers, projectId);
    },
    [activeSession, projectId, addToast],
  );

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
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    sendMessage,
    switchSession,
    loadMessages,
    reloadMessages,
  };
}
