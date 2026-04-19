import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSession } from "@fusion/core";
import {
  fetchChatSessions,
  createChatSession,
  fetchChatMessages,
  streamChatResponse,
} from "../api";

export const KB_AGENT_ID = "__kb_agent__";

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingOutput?: string | null;
  createdAt: string;
}

interface ModelSelection {
  modelProvider?: string;
  modelId?: string;
}

interface SessionTarget {
  agentId: string;
  modelProvider?: string;
  modelId?: string;
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
  sendMessage: (content: string) => void;
  switchSession: (agentId: string, modelProvider?: string, modelId?: string) => Promise<void>;
  startModelChat: (modelProvider: string, modelId: string) => Promise<void>;
  loadMessages: () => Promise<void>;
  reloadMessages: () => Promise<void>;
}

function normalizeModelSelection(modelProvider?: string, modelId?: string): ModelSelection {
  const provider = typeof modelProvider === "string" ? modelProvider.trim() : "";
  const id = typeof modelId === "string" ? modelId.trim() : "";

  if (!provider || !id) {
    return {};
  }

  return { modelProvider: provider, modelId: id };
}

function resolveSessionTarget(agentId: string, modelProvider?: string, modelId?: string): SessionTarget | null {
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  const normalizedModel = normalizeModelSelection(modelProvider, modelId);

  const targetAgentId = normalizedAgentId || (normalizedModel.modelProvider && normalizedModel.modelId ? KB_AGENT_ID : "");
  if (!targetAgentId) {
    return null;
  }

  return {
    agentId: targetAgentId,
    ...normalizedModel,
  };
}

function buildSessionKey(agentId: string, modelProvider?: string, modelId?: string): string {
  const normalizedModel = normalizeModelSelection(modelProvider, modelId);
  const provider = normalizedModel.modelProvider ?? "";
  const id = normalizedModel.modelId ?? "";
  return `${agentId}::${provider}/${id}`;
}

function findMatchingSession(sessions: ChatSession[], target: SessionTarget): ChatSession | undefined {
  const candidateSessions = sessions.filter((session) => session.agentId === target.agentId);
  if (candidateSessions.length === 0) {
    return undefined;
  }

  if (target.modelProvider && target.modelId) {
    return candidateSessions.find(
      (session) => session.modelProvider === target.modelProvider && session.modelId === target.modelId,
    );
  }

  // Prefer sessions without explicit model data when available,
  // then fall back to the first session for this agent to preserve
  // existing behavior.
  return candidateSessions.find((session) => !session.modelProvider && !session.modelId) ?? candidateSessions[0];
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

  // Track the current selected chat target for session management
  const currentSessionKeyRef = useRef<string>("");

  // Fetch existing sessions and find/create one for the given target
  const initializeSession = useCallback(
    async (agentId: string, modelProvider?: string, modelId?: string) => {
      const target = resolveSessionTarget(agentId, modelProvider, modelId);
      if (!target) return;

      const sessionKey = buildSessionKey(target.agentId, target.modelProvider, target.modelId);

      setSessionsLoading(true);
      try {
        const data = await fetchChatSessions(projectId, "active");
        const existingSession = findMatchingSession(data.sessions, target);

        if (existingSession) {
          setActiveSession(existingSession);
          currentSessionKeyRef.current = sessionKey;
        } else {
          const newSessionInput: { agentId: string; modelProvider?: string; modelId?: string } = {
            agentId: target.agentId,
          };

          if (target.modelProvider && target.modelId) {
            newSessionInput.modelProvider = target.modelProvider;
            newSessionInput.modelId = target.modelId;
          }

          const newSession = await createChatSession(newSessionInput, projectId);
          setActiveSession(newSession.session);
          currentSessionKeyRef.current = sessionKey;
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
      setMessages(data.messages);
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

  // Reload messages from server (for same-session revisit)
  const reloadMessages = useCallback(async () => {
    if (!activeSession) return;
    setMessagesLoading(true);
    try {
      const data = await fetchChatMessages(activeSession.id, { limit: 50 }, projectId);
      setMessages(data.messages);
    } catch (err) {
      console.error("[useQuickChat] Failed to reload messages:", err);
    } finally {
      setMessagesLoading(false);
    }
  }, [activeSession, projectId]);

  // Switch to a different chat target session
  const switchSession = useCallback(
    async (agentId: string, modelProvider?: string, modelId?: string) => {
      const target = resolveSessionTarget(agentId, modelProvider, modelId);
      if (!target) return;

      const targetSessionKey = buildSessionKey(target.agentId, target.modelProvider, target.modelId);

      // Close any existing stream
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }

      // Reset streaming state
      setStreamingText("");
      setStreamingThinking("");
      setIsStreaming(false);

      if (targetSessionKey === currentSessionKeyRef.current && activeSession) {
        // Same chat target — just reload messages from server
        await reloadMessages();
        return;
      }

      // Clear old messages immediately so stale conversation doesn't briefly flash
      // while the new session loads
      setMessages([]);

      // New chat target — initialize session
      currentSessionKeyRef.current = targetSessionKey;
      await initializeSession(target.agentId, target.modelProvider, target.modelId);
    },
    [initializeSession, reloadMessages, activeSession],
  );

  const startModelChat = useCallback(
    async (modelProvider: string, modelId: string) => {
      await switchSession(KB_AGENT_ID, modelProvider, modelId);
    },
    [switchSession],
  );

  // Send a message using SSE streaming
  const sendMessage = useCallback(
    (content: string) => {
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
          setStreamingText("");
          setStreamingThinking("");
          setIsStreaming(false);
          streamRef.current = null;
          console.error("[useQuickChat] Stream error:", data);
          addToast?.("Failed to get response", "error");
          void reloadMessages();
        },
      };

      streamRef.current = streamChatResponse(activeSession.id, content, textHandlers, projectId);
    },
    [activeSession, projectId, addToast, reloadMessages],
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

  return useMemo(() => ({
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    sendMessage,
    switchSession,
    startModelChat,
    loadMessages,
    reloadMessages,
  }), [
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    sendMessage,
    switchSession,
    startModelChat,
    loadMessages,
    reloadMessages,
  ]);
}
