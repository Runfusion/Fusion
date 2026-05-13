import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatInFlightGenerationState, ChatMessage, EnrichedChatSession } from "@fusion/core";
import {
  fetchResumeChatSession,
  fetchChatSessions,
  fetchChatSession,
  createChatSession,
  fetchChatMessages,
  attachChatStream,
  streamChatResponse,
  cancelChatResponse,
} from "../api";

export const FN_AGENT_ID = "__fn_agent__";

// Re-export shared chat types so existing consumers keep working — single
// source of truth lives in chatTypes.ts and is shared with useChat.
// Note: useQuickChat's previous local `ChatMessageInfo` lacked the
// `attachments` field; the shared type adds it (a strict superset), which is
// safe for callers that ignore it.
export type { ChatMessageInfo, FallbackInfo, ToolCallInfo } from "./chatTypes";
import type { ChatMessageInfo, FallbackInfo, ToolCallInfo } from "./chatTypes";
import { createChatStreamHandlers } from "./createChatStreamHandlers";
import { isLikelyTabSuspensionError, useTabVisibilitySuspension } from "./visibilitySuspension";

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
  activeSession: EnrichedChatSession | null;
  sessions: EnrichedChatSession[];
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
  selectSession: (session: EnrichedChatSession) => Promise<void>;
  startModelChat: (modelProvider: string, modelId: string) => Promise<void>;
  startFreshSession: (agentId?: string, modelProvider?: string, modelId?: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  loadMessages: () => Promise<void>;
  reloadMessages: () => Promise<void>;

  /**
   * When true, the consuming component's session-init useEffect should
   * skip its automatic switchSession call.  Set during startFreshSession
   * to prevent the useEffect from racing with an explicit fresh-session
   * creation.
   */
  skipNextSessionInitRef: React.MutableRefObject<boolean>;
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

function parseModelDescriptor(model: string): ModelSelection {
  const value = typeof model === "string" ? model.trim() : "";
  const slashIndex = value.indexOf("/");
  if (!value || slashIndex <= 0 || slashIndex >= value.length - 1) {
    return {};
  }

  return {
    modelProvider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
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

function extractFallbackInfo(metadata: Record<string, unknown> | null | undefined): FallbackInfo | undefined {
  const rawFallback = metadata?.fallback;
  if (!rawFallback || typeof rawFallback !== "object") {
    return undefined;
  }

  const record = rawFallback as Record<string, unknown>;
  const primaryModel = typeof record.primaryModel === "string" ? record.primaryModel : "";
  const fallbackModel = typeof record.fallbackModel === "string" ? record.fallbackModel : "";
  const triggerPoint = record.triggerPoint;
  if (!primaryModel || !fallbackModel || (triggerPoint !== "session-creation" && triggerPoint !== "prompt-time")) {
    return undefined;
  }

  return {
    primaryModel,
    fallbackModel,
    triggerPoint,
  };
}

function mapChatMessageToInfo(message: ChatMessage): ChatMessageInfo {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    thinkingOutput: message.thinkingOutput,
    toolCalls: extractCompletedToolCalls(message.metadata),
    fallbackInfo: extractFallbackInfo(message.metadata),
    createdAt: message.createdAt,
  };
}

/**
 * Hook for the QuickChatFAB component.
 * Provides chat session management and SSE streaming for real-time AI responses.
 */
export function useQuickChat(
  projectId?: string,
  addToast?: (msg: string, type?: "success" | "error" | "warning") => void,
): UseQuickChatReturn {
  // Session state
  const [activeSession, setActiveSession] = useState<EnrichedChatSession | null>(null);
  const [sessions, setSessions] = useState<EnrichedChatSession[]>([]);
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
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const sendCompletionRef = useRef<{ resolve: () => void; reject: (error?: unknown) => void } | null>(null);

  // Track the current selected chat target for session management
  const currentSessionKeyRef = useRef<string>("");
  const currentSessionTargetRef = useRef<SessionTarget | null>(null);

  // Ref mirror of activeSession to avoid cascading re-renders through
  // switchSession's dependency array.  Reading activeSession from the
  // closure causes switchSession to get a new identity every time
  // activeSession changes — which then re-triggers the consuming
  // component's useEffect that depends on switchSession.
  const activeSessionRef = useRef<EnrichedChatSession | null>(activeSession);
  activeSessionRef.current = activeSession;

  // Max retries for session init to prevent infinite toast loops
  const initRetryCountRef = useRef(0);
  const INIT_MAX_RETRIES = 3;

  // When true, the consuming component's session-init useEffect should
  // skip its switchSession call.  Set by startFreshSession (and the
  // component's handleCreateFreshSession) to prevent the automatic
  // useEffect from racing with an explicit fresh-session creation.
  const skipNextSessionInitRef = useRef(false);

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
    async (target: SessionTarget): Promise<EnrichedChatSession> => {
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

  const clearPendingMessage = useCallback(() => {
    pendingMessageRef.current = "";
    setPendingMessage("");
  }, []);

  const flushPendingMessage = useCallback(() => {
    const queuedMessage = pendingMessageRef.current.trim();
    if (!queuedMessage) {
      return;
    }

    pendingMessageRef.current = "";
    setPendingMessage("");
    void sendMessageRef.current(queuedMessage);
  }, []);

  const attachIfGenerating = useCallback((
    sessionId: string,
    inFlightGeneration?: ChatInFlightGenerationState | null,
    options?: { silent?: boolean },
  ) => {
    if (streamRef.current || !sessionId) {
      return true;
    }

    cancelledByUserRef.current = false;
    if (inFlightGeneration) {
      setStreamingText(inFlightGeneration.streamingText);
      setStreamingThinking(inFlightGeneration.streamingThinking);
      setStreamingToolCalls(inFlightGeneration.toolCalls);
    }
    setIsStreaming(true);

    const { handlers } = createChatStreamHandlers({
      sessionId,
      tempUserMessageId: "",
      setStreamingText,
      setStreamingThinking,
      setStreamingToolCalls,
      cancelStreamingFlushesRef,
      addToast: options?.silent ? undefined : addToast,
      onFallbackSession: (data, fallbackSessionId) => {
        const nextModel = parseModelDescriptor(data.fallbackModel);
        setSessions((prev) => prev.map((session) =>
          session.id === fallbackSessionId ? { ...session, ...nextModel } : session,
        ));
        setActiveSession((prev) => prev && prev.id === fallbackSessionId ? { ...prev, ...nextModel } : prev);
      },
      onDone: () => {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(false);
        isStreamingRef.current = false;
        streamRef.current = null;
        void fetchChatMessages(sessionId, { limit: 50 }, projectId).then((data) => {
          setMessages(data.messages.map(mapChatMessageToInfo));
        }).catch(() => {});
        flushPendingMessage();
      },
      onError: (data) => {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(false);
        isStreamingRef.current = false;
        streamRef.current = null;
        const errorMessage = typeof data === "string" && data.trim() ? data : "Failed to get response";
        if (!options?.silent) {
          addToast?.(errorMessage, "error");
        }
        void fetchChatMessages(sessionId, { limit: 50 }, projectId).then((resp) => {
          setMessages(resp.messages.map(mapChatMessageToInfo));
        }).catch(() => {});
        flushPendingMessage();
      },
    });

    streamRef.current = attachChatStream(sessionId, handlers, projectId, {
      ...(typeof inFlightGeneration?.replayFromEventId === "number"
        ? { lastEventId: inFlightGeneration.replayFromEventId }
        : {}),
    });
    return true;
  }, [addToast, projectId, flushPendingMessage]);

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

          // Recover streaming state if server is still generating for this session.
          // After a reload/HMR, the server keeps generating but the UI loses
          // all streaming state. Show the "Connecting…" indicator immediately.
          if (existingSession.isGenerating) {
            attachIfGenerating(existingSession.id, existingSession.inFlightGeneration);
          }
        } else {
          const newSession = await createSessionForTarget(target);
          setActiveSession(newSession);
          currentSessionKeyRef.current = sessionKey;
        }

        // Reset retry counter on success so a later failure can retry again
        initRetryCountRef.current = 0;
      } catch (err) {
        console.error("[useQuickChat] Failed to initialize session:", err);
        // Only show the toast while under the retry limit — once the limit
        // is reached the user has already seen the warning and further
        // toasts just create noise.
        initRetryCountRef.current += 1;
        if (initRetryCountRef.current <= INIT_MAX_RETRIES) {
          addToast?.("Failed to initialize chat", "error");
        }
      } finally {
        setSessionsLoading(false);
      }
    },
    [attachIfGenerating, projectId, addToast, createSessionForTarget],
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

  // Poll for generation completion during recovery mode.
  // Recovery mode: isStreaming=true but streamRef.current is null (no local stream).
  // This happens after a reload/HMR when the server is still generating.
  // Poll every 3s until the server reports isGenerating=false, then reload messages
  // and clear streaming state.
  useEffect(() => {
    if (!activeSession?.isGenerating) return;

    if (!streamRef.current) {
      attachIfGenerating(activeSession.id, activeSession.inFlightGeneration);
    }

    if (!isStreamingRef.current || streamRef.current || !activeSession) return;

    const interval = setInterval(async () => {
      // Re-check conditions inside the callback (state may have changed)
      if (!isStreamingRef.current || streamRef.current || !activeSession) {
        clearInterval(interval);
        return;
      }

      try {
        const data = await fetchChatSession(activeSession.id, projectId);
        if (!data.session.isGenerating) {
          clearInterval(interval);
          // Reload messages to pick up the completed assistant message
          const msgData = await fetchChatMessages(activeSession.id, { limit: 50 }, projectId);
          setMessages(msgData.messages.map(mapChatMessageToInfo));
          setStreamingText("");
          setStreamingThinking("");
          setStreamingToolCalls([]);
          setIsStreaming(false);
          isStreamingRef.current = false;
          flushPendingMessage();
        }
      } catch {
        // Silently fail - will retry on next interval
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activeSession, attachIfGenerating, projectId, flushPendingMessage]);

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

      // Use ref to avoid cascading re-renders: reading activeSession from
      // the closure would make switchSession change identity every time
      // activeSession changes, triggering the consumer's useEffect again.
      const isSameSession = targetSessionKey === currentSessionKeyRef.current && activeSessionRef.current;

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
    [initializeSession, reloadMessages, resetTransientComposerState],
  );

  const selectSession = useCallback(async (session: EnrichedChatSession) => {
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
    if (session.isGenerating) {
      attachIfGenerating(session.id, session.inFlightGeneration);
    }
  }, [attachIfGenerating, resetTransientComposerState]);

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

    // Prevent the consuming component's automatic session-init useEffect
    // from racing with this explicit fresh-session creation.  The effect
    // will see the flag, record the target key as "seen", and skip.
    skipNextSessionInitRef.current = true;
    initRetryCountRef.current = 0;

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
      skipNextSessionInitRef.current = false;
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

  const sendMessageRef = useRef<(content: string, attachments?: File[]) => Promise<void>>(() => Promise.resolve());
  const visibilitySuspension = useTabVisibilitySuspension();

  const reconnectSessionSilently = useCallback(async (sessionId: string) => {
    try {
      await refreshSessions();
      const refreshed = await fetchChatSession(sessionId, projectId);
      const refreshedSession = refreshed.session;
      if (activeSessionRef.current?.id === sessionId) {
        setActiveSession((prev) => {
          if (!prev || prev.id !== sessionId) {
            return prev;
          }
          return {
            ...prev,
            ...refreshedSession,
          };
        });
      }

      if (refreshedSession.isGenerating) {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(true);
        isStreamingRef.current = true;
        attachIfGenerating(sessionId, refreshedSession.inFlightGeneration, { silent: true });
      } else {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(false);
        isStreamingRef.current = false;
        await reloadMessages();
      }
    } catch {
      // Intentionally silent reconnect path.
    }
  }, [attachIfGenerating, projectId, refreshSessions, reloadMessages]);

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

      if (isStreamingRef.current) {
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

        const { handlers } = createChatStreamHandlers({
          sessionId: activeSession.id,
          tempUserMessageId: tempId,
          setStreamingText,
          setStreamingThinking,
          setStreamingToolCalls,
          cancelStreamingFlushesRef,
          addToast,
          onFallbackSession: (data, sessionId) => {
            const nextModel = parseModelDescriptor(data.fallbackModel);
            setSessions((prev) => prev.map((session) =>
              session.id === sessionId ? { ...session, ...nextModel } : session,
            ));
            setActiveSession((prev) => prev && prev.id === sessionId ? { ...prev, ...nextModel } : prev);
          },
          onDone: ({ messageId, message: finalMessage, accumulated }) => {
            const assistantMessage: ChatMessageInfo = finalMessage
              ? mapChatMessageToInfo(finalMessage)
              : {
                  id: messageId || `msg-${Date.now()}`,
                  sessionId: activeSession.id,
                  role: "assistant",
                  content: accumulated.text,
                  thinkingOutput: accumulated.thinking || undefined,
                  toolCalls: accumulated.toolCalls.length > 0 ? accumulated.toolCalls : undefined,
                  fallbackInfo: accumulated.fallbackInfo,
                  createdAt: new Date().toISOString(),
                };

            // Preserve user message and add assistant message
            setMessages((prev) => [...prev, assistantMessage]);

            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolCalls([]);
            setIsStreaming(false);
            isStreamingRef.current = false;
            streamRef.current = null;
            sendCompletionRef.current?.resolve();
            sendCompletionRef.current = null;

            flushPendingMessage();
          },
          onError: (data) => {
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolCalls([]);
            setIsStreaming(false);
            isStreamingRef.current = false;
            streamRef.current = null;
            console.error("[useQuickChat] Stream error:", data);

            const errorMessage = typeof data === "string" && data.trim() ? data : "Failed to get response";
            const shouldSuppressSuspensionError = isLikelyTabSuspensionError(errorMessage);

            if (shouldSuppressSuspensionError) {
              console.info("[useQuickChat] Suppressed tab-suspension stream error:", data);
              if (activeSession?.id) {
                setStreamingText("");
                setStreamingThinking("");
                setStreamingToolCalls([]);
                setIsStreaming(true);
                isStreamingRef.current = true;
                void reconnectSessionSilently(activeSession.id);
              }
              sendCompletionRef.current?.resolve();
            } else {
              addToast?.(errorMessage, "error");
              sendCompletionRef.current?.reject(new Error(errorMessage));
            }
            sendCompletionRef.current = null;

            if (!cancelledByUserRef.current) {
              flushPendingMessage();
            }

            if (!shouldSuppressSuspensionError) {
              void reloadMessages();
            }
          },
        });

        streamRef.current = streamChatResponse(activeSession.id, content, handlers, attachments, projectId);
      });

      // Preserve rejection semantics for awaiters while preventing unhandled rejection noise
      // when legacy call sites intentionally fire-and-forget.
      void completionPromise.catch(() => {});
      return completionPromise;
    },
    [activeSession, projectId, addToast, reloadMessages, reconnectSessionSilently, flushPendingMessage],
  );

  sendMessageRef.current = sendMessage;

  useEffect(() => {
    const unsubscribe = visibilitySuspension.onBecameVisible(() => {
      if (skipNextSessionInitRef.current) {
        return;
      }
      const currentSession = activeSessionRef.current;
      if (!currentSession || streamRef.current) {
        return;
      }

      void Promise.resolve(fetchChatSession(currentSession.id, projectId))
        .then((data) => {
          if (streamRef.current || activeSessionRef.current?.id !== currentSession.id) {
            return;
          }

          if (data.session.isGenerating) {
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolCalls([]);
            setIsStreaming(true);
            isStreamingRef.current = true;
            attachIfGenerating(currentSession.id, data.session.inFlightGeneration, { silent: true });
            return;
          }

          if (isStreamingRef.current) {
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolCalls([]);
            setIsStreaming(false);
            isStreamingRef.current = false;
            flushPendingMessage();
            void reloadMessages();
          }
        })
        .catch(() => {
          // Intentionally silent for visibility reconnect path.
        });
    });

    return unsubscribe;
  }, [attachIfGenerating, projectId, reloadMessages, visibilitySuspension, flushPendingMessage]);

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
    skipNextSessionInitRef,
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
