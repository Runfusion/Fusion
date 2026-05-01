import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatSession } from "@fusion/core";
import {
  fetchResumeChatSession,
  fetchChatSessions,
  createChatSession,
  fetchChatMessages,
  streamChatResponse,
  cancelChatResponse,
} from "../api";

export const FN_AGENT_ID = "__fn_agent__";

export interface ToolCallInfo {
  toolName: string;
  args?: Record<string, unknown>;
  isError: boolean;
  result?: unknown;
  status: "running" | "completed";
}

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingOutput?: string | null;
  toolCalls?: ToolCallInfo[];
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
  sessions: ChatSession[];
  sessionsLoading: boolean;

  // Message state
  messages: ChatMessageInfo[];
  messagesLoading: boolean;
  isStreaming: boolean;
  streamingText: string;
  streamingThinking: string;
  streamingToolCalls: ToolCallInfo[];
  pendingMessage: string;

  // Operations
  sendMessage: (content: string, attachments?: File[]) => Promise<void>;
  stopStreaming: () => void;
  clearPendingMessage: () => void;
  switchSession: (agentId: string, modelProvider?: string, modelId?: string) => Promise<void>;
  selectSession: (session: ChatSession) => Promise<void>;
  startModelChat: (modelProvider: string, modelId: string) => Promise<void>;
  startFreshSession: (agentId?: string, modelProvider?: string, modelId?: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
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

  const targetAgentId = normalizedAgentId || (normalizedModel.modelProvider && normalizedModel.modelId ? FN_AGENT_ID : "");
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

function extractCompletedToolCalls(metadata: Record<string, unknown> | null | undefined): ToolCallInfo[] | undefined {
  const rawToolCalls = metadata?.toolCalls;
  if (!Array.isArray(rawToolCalls)) {
    return undefined;
  }

  const parsed = rawToolCalls
    .map((toolCall): ToolCallInfo | null => {
      if (!toolCall || typeof toolCall !== "object") {
        return null;
      }

      const record = toolCall as Record<string, unknown>;
      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      if (!toolName) {
        return null;
      }

      const args = record.args;

      return {
        toolName,
        ...(args && typeof args === "object" ? { args: args as Record<string, unknown> } : {}),
        isError: Boolean(record.isError),
        result: record.result,
        status: "completed" as const,
      };
    })
    .filter((toolCall): toolCall is ToolCallInfo => toolCall !== null);

  return parsed.length > 0 ? parsed : undefined;
}

function mapChatMessageToInfo(message: ChatMessage): ChatMessageInfo {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    thinkingOutput: message.thinkingOutput,
    toolCalls: extractCompletedToolCalls(message.metadata),
    createdAt: message.createdAt,
  };
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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Message state
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallInfo[]>([]);
  const [pendingMessage, setPendingMessage] = useState("");

  // Stream connection ref for cleanup
  const streamRef = useRef<{ close: () => void } | null>(null);
  const cancelledByUserRef = useRef(false);
  const cancelStreamingFlushesRef = useRef<(() => void) | null>(null);
  const pendingMessageRef = useRef("");
  const sendCompletionRef = useRef<{ resolve: () => void; reject: (error?: unknown) => void } | null>(null);

  // Track the current selected chat target for session management
  const currentSessionKeyRef = useRef<string>("");
  const currentSessionTargetRef = useRef<SessionTarget | null>(null);

  useEffect(() => {
    pendingMessageRef.current = pendingMessage;
  }, [pendingMessage]);

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const response = await fetchChatSessions(projectId);
      setSessions(response.sessions);
    } catch (err) {
      console.error("[useQuickChat] Failed to refresh sessions:", err);
    } finally {
      setSessionsLoading(false);
    }
  }, [projectId]);

  const createSessionForTarget = useCallback(
    async (target: SessionTarget): Promise<ChatSession> => {
      const newSessionInput: { agentId: string; modelProvider?: string; modelId?: string } = {
        agentId: target.agentId,
      };

      if (target.modelProvider && target.modelId) {
        newSessionInput.modelProvider = target.modelProvider;
        newSessionInput.modelId = target.modelId;
      }

      const newSession = await createChatSession(newSessionInput, projectId);
      return newSession.session;
    },
    [projectId],
  );

  // Fetch existing sessions and find/create one for the given target
  const initializeSession = useCallback(
    async (agentId: string, modelProvider?: string, modelId?: string) => {
      const target = resolveSessionTarget(agentId, modelProvider, modelId);
      if (!target) return;

      const sessionKey = buildSessionKey(target.agentId, target.modelProvider, target.modelId);

      setSessionsLoading(true);
      try {
        const { session: existingSession } = await fetchResumeChatSession(
          {
            agentId: target.agentId,
            modelProvider: target.modelProvider,
            modelId: target.modelId,
          },
          projectId,
        );

        if (existingSession) {
          setActiveSession(existingSession);
          currentSessionKeyRef.current = sessionKey;
        } else {
          const newSession = await createSessionForTarget(target);
          setActiveSession(newSession);
          currentSessionKeyRef.current = sessionKey;
        }
      } catch (err) {
        console.error("[useQuickChat] Failed to initialize session:", err);
        addToast?.("Failed to initialize chat", "error");
      } finally {
        setSessionsLoading(false);
      }
    },
    [projectId, addToast, createSessionForTarget],
  );

  // Load messages for the active session
  const loadMessages = useCallback(async () => {
    if (!activeSession) return;

    setMessagesLoading(true);
    try {
      const data = await fetchChatMessages(activeSession.id, { limit: 50 }, projectId);
      setMessages(data.messages.map(mapChatMessageToInfo));
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
      setMessages(data.messages.map(mapChatMessageToInfo));
    } catch (err) {
      console.error("[useQuickChat] Failed to reload messages:", err);
    } finally {
      setMessagesLoading(false);
    }
  }, [activeSession, projectId]);

  const resetTransientComposerState = useCallback(() => {
    cancelStreamingFlushesRef.current?.();
    cancelStreamingFlushesRef.current = null;
    pendingMessageRef.current = "";
    setPendingMessage("");
    setStreamingText("");
    setStreamingThinking("");
    setStreamingToolCalls([]);
    setIsStreaming(false);
  }, []);

  // Switch to a different chat target session
  const switchSession = useCallback(
    async (agentId: string, modelProvider?: string, modelId?: string) => {
      const target = resolveSessionTarget(agentId, modelProvider, modelId);
      if (!target) return;

      const targetSessionKey = buildSessionKey(target.agentId, target.modelProvider, target.modelId);
      currentSessionTargetRef.current = target;

      const isSameSession = targetSessionKey === currentSessionKeyRef.current && activeSession;

      if (!isSameSession) {
        // Close any existing stream
        if (streamRef.current) {
          streamRef.current.close();
          streamRef.current = null;
        }

        // Reset transient state
        resetTransientComposerState();
      }

      if (isSameSession) {
        // Same chat target — just reload messages from server
        await reloadMessages();
        return;
      }

      // Clear old session/messages immediately so stale conversation doesn't briefly flash
      // and input remains disabled until the new target session is ready.
      setActiveSession(null);
      setMessages([]);

      // New chat target — initialize session
      currentSessionKeyRef.current = targetSessionKey;
      await initializeSession(target.agentId, target.modelProvider, target.modelId);
    },
    [activeSession, initializeSession, reloadMessages, resetTransientComposerState],
  );

  const selectSession = useCallback(async (session: ChatSession) => {
    const target = resolveSessionTarget(session.agentId, session.modelProvider ?? undefined, session.modelId ?? undefined);
    if (!target) return;

    currentSessionTargetRef.current = target;
    currentSessionKeyRef.current = buildSessionKey(target.agentId, target.modelProvider, target.modelId);

    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    resetTransientComposerState();
    setActiveSession(session);
  }, [resetTransientComposerState]);

  const startModelChat = useCallback(
    async (modelProvider: string, modelId: string) => {
      await switchSession(FN_AGENT_ID, modelProvider, modelId);
    },
    [switchSession],
  );

  const startFreshSession = useCallback(async (agentId?: string, modelProvider?: string, modelId?: string) => {
    const overrideTarget = resolveSessionTarget(agentId ?? "", modelProvider, modelId);
    const target = overrideTarget ?? currentSessionTargetRef.current;
    if (!target) return;

    currentSessionTargetRef.current = target;

    // Explicit "new chat" action: keep the same target key but create a new persisted session.
    // This preserves normal switchSession resume behavior while allowing multiple threads per target.
    const targetSessionKey = buildSessionKey(target.agentId, target.modelProvider, target.modelId);

    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    resetTransientComposerState();
    setMessages([]);
    setActiveSession(null);

    setSessionsLoading(true);
    try {
      const newSession = await createSessionForTarget(target);
      setActiveSession(newSession);
      currentSessionKeyRef.current = targetSessionKey;

      const sessionList = await fetchChatSessions(projectId);
      setSessions(sessionList.sessions);
    } catch (err) {
      console.error("[useQuickChat] Failed to start a fresh session:", err);
      addToast?.("Failed to start a new chat", "error");
    } finally {
      setSessionsLoading(false);
    }
  }, [addToast, createSessionForTarget, projectId, resetTransientComposerState]);

  const stopStreaming = useCallback(() => {
    if (!activeSession) return;

    cancelledByUserRef.current = true;
    cancelStreamingFlushesRef.current?.();
    cancelStreamingFlushesRef.current = null;
    streamRef.current?.close();
    streamRef.current = null;

    void cancelChatResponse(activeSession.id, projectId).catch(() => {
      // Best-effort cancellation; ignore backend errors.
    });

    setIsStreaming(false);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingToolCalls([]);
  }, [activeSession, projectId]);

  const clearPendingMessage = useCallback(() => {
    pendingMessageRef.current = "";
    setPendingMessage("");
  }, []);

  /**
   * Send a message using SSE streaming.
   * @param content message text content
   * @param attachments optional files to send with the message; sent as multipart payload
   * @returns resolves after backend confirms message completion (`done`), rejects on stream error
   */
  const sendMessage = useCallback(
    (content: string, attachments?: File[]) => {
      if (!activeSession || (!content.trim() && (!attachments || attachments.length === 0))) {
        return Promise.resolve();
      }

      if (isStreaming) {
        if (attachments && attachments.length > 0) {
          return Promise.reject(new Error("Cannot send attachments while a response is streaming"));
        }

        pendingMessageRef.current = content;
        setPendingMessage(content);
        return Promise.resolve();
      }

      const completionPromise = new Promise<void>((resolve, reject) => {
        sendCompletionRef.current = { resolve, reject };

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
        setStreamingToolCalls([]);
        setIsStreaming(true);

        // Accumulate streaming text and tool calls in local variables
        let capturedText = "";
        let capturedThinking = "";
        let capturedToolCalls: ToolCallInfo[] = [];

        // Coalesce per-token state updates to one render per animation frame —
        // unthrottled setStreamingText pegs the main thread on long replies.
        let textRaf: number | null = null;
        let thinkingRaf: number | null = null;
        const flushText = () => {
          textRaf = null;
          setStreamingText(capturedText);
        };
        const flushThinking = () => {
          thinkingRaf = null;
          setStreamingThinking(capturedThinking);
        };
        const cancelStreamingFlushes = () => {
          if (textRaf !== null) {
            cancelAnimationFrame(textRaf);
            textRaf = null;
          }
          if (thinkingRaf !== null) {
            cancelAnimationFrame(thinkingRaf);
            thinkingRaf = null;
          }
        };
        cancelStreamingFlushesRef.current = cancelStreamingFlushes;

        const textHandlers = {
        onThinking: (data: string) => {
          capturedThinking += data;
          if (thinkingRaf === null) {
            thinkingRaf = requestAnimationFrame(flushThinking);
          }
        },
        onText: (data: string) => {
          capturedText += data;
          if (textRaf === null) {
            textRaf = requestAnimationFrame(flushText);
          }
        },
        onToolStart: (data: { toolName: string; args?: Record<string, unknown> }) => {
          capturedToolCalls = [
            ...capturedToolCalls,
            {
              toolName: data.toolName,
              args: data.args,
              isError: false,
              status: "running",
            },
          ];
          setStreamingToolCalls(capturedToolCalls);
        },
        onToolEnd: (data: { toolName: string; isError: boolean; result?: unknown }) => {
          const nextToolCalls = [...capturedToolCalls];
          for (let i = nextToolCalls.length - 1; i >= 0; i--) {
            const candidate = nextToolCalls[i];
            if (candidate?.toolName === data.toolName && candidate.status === "running") {
              nextToolCalls[i] = {
                ...candidate,
                status: "completed",
                isError: data.isError,
                result: data.result,
              };
              capturedToolCalls = nextToolCalls;
              setStreamingToolCalls(nextToolCalls);
              return;
            }
          }

          capturedToolCalls = [
            ...nextToolCalls,
            {
              toolName: data.toolName,
              isError: data.isError,
              result: data.result,
              status: "completed",
            },
          ];
          setStreamingToolCalls(capturedToolCalls);
        },
          onDone: (data: { messageId: string }) => {
          cancelStreamingFlushes();
          const assistantMessage: ChatMessageInfo = {
            id: data.messageId || `msg-${Date.now()}`,
            sessionId: activeSession.id,
            role: "assistant",
            content: capturedText,
            thinkingOutput: capturedThinking || undefined,
            toolCalls: capturedToolCalls.length > 0 ? capturedToolCalls : undefined,
            createdAt: new Date().toISOString(),
          };

            // Preserve user message and add assistant message
            setMessages((prev) => [...prev, assistantMessage]);

            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolCalls([]);
            setIsStreaming(false);
            streamRef.current = null;
            sendCompletionRef.current?.resolve();
            sendCompletionRef.current = null;

            const queuedMessage = pendingMessageRef.current.trim();
            if (queuedMessage) {
              pendingMessageRef.current = "";
              setPendingMessage("");
              void sendMessage(queuedMessage);
            }
          },
          onError: (data: string) => {
            cancelStreamingFlushes();
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolCalls([]);
            setIsStreaming(false);
            streamRef.current = null;
            console.error("[useQuickChat] Stream error:", data);
            addToast?.("Failed to get response", "error");
            sendCompletionRef.current?.reject(new Error(typeof data === "string" ? data : "Failed to get response"));
            sendCompletionRef.current = null;

            if (!cancelledByUserRef.current) {
              const queuedMessage = pendingMessageRef.current.trim();
              if (queuedMessage) {
                pendingMessageRef.current = "";
                setPendingMessage("");
                void sendMessage(queuedMessage);
              }
            }

            void reloadMessages();
          },
        };

        streamRef.current = streamChatResponse(activeSession.id, content, textHandlers, attachments, projectId);
      });

      // Preserve rejection semantics for awaiters while preventing unhandled rejection noise
      // when legacy call sites intentionally fire-and-forget.
      void completionPromise.catch(() => {});
      return completionPromise;
    },
    [activeSession, isStreaming, projectId, addToast, reloadMessages],
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
    sessions,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    pendingMessage,
    sendMessage,
    stopStreaming,
    clearPendingMessage,
    switchSession,
    selectSession,
    startModelChat,
    startFreshSession,
    refreshSessions,
    loadMessages,
    reloadMessages,
  }), [
    activeSession,
    sessions,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    pendingMessage,
    sendMessage,
    stopStreaming,
    clearPendingMessage,
    switchSession,
    selectSession,
    startModelChat,
    startFreshSession,
    refreshSessions,
    loadMessages,
    reloadMessages,
  ]);
}
