import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchChatSessions,
  fetchChatSession,
  createChatSession as apiCreateChatSession,
  fetchChatMessages,
  updateChatSession,
  deleteChatSession,
  editChatMessage,
  attachChatStream,
  streamChatResponse,
  cancelChatResponse,
  type ChatFailureInfo,
  type ChatSessionListResponse,
  type ChatStreamErrorMeta,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { getScopedItem, setScopedItem, removeScopedItem } from "../utils/projectStorage";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import type { Agent, ChatInFlightGenerationState, ChatMessage } from "@fusion/core";

const ACTIVE_SESSION_STORAGE_KEY = "kb-chat-active-session";
/**
 * FNXC:Chat-ModelSwitch 2026-07-12-00:00:
 * Model-loop direct sessions store this sentinel agent id so the UI and hook share one target-mode check instead of duplicating the literal in each composer surface.
 */
export const FN_AGENT_ID = "__fn_agent__";
const TASK_PLANNER_CHAT_AGENT_ID_PREFIX = "task-planner:";

/** FNXC:ChatPinned 2026-07-16-12:00: one comparator keeps refresh, cache,
 * optimistic mutations, SSE updates, and search results pinned-first. */
export function compareChatSessions(a: ChatSessionInfo, b: ChatSessionInfo): number {
  const aPinned = a.pinnedAt !== null && a.pinnedAt !== undefined;
  const bPinned = b.pinnedAt !== null && b.pinnedAt !== undefined;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  const primary = aPinned
    ? new Date(b.pinnedAt!).getTime() - new Date(a.pinnedAt!).getTime()
    : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  return primary || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function sortChatSessions(sessions: ChatSessionInfo[]): ChatSessionInfo[] {
  return [...sessions].sort(compareChatSessions);
}

function isTaskPlannerSession(session: ChatSessionInfo): boolean {
  return session.agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX);
}

function isEmptyTaskPlannerSession(session: ChatSessionInfo): boolean {
  return isTaskPlannerSession(session) && !session.lastMessageAt && !session.lastMessagePreview;
}

export interface ChatSessionInfo {
  id: string;
  title?: string | null;
  agentId: string;
  status: string;
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  pinnedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  isGenerating?: boolean;
  inFlightGeneration?: ChatInFlightGenerationState | null;
  /**
   * When set, this chat session is driven by a cli-agent executor (U12). The
   * message-pane + composer region is delegated to <CliChatSurface> instead of
   * the standard provider transcript/composer.
   */
  cliExecutorAdapterId?: string | null;
  /** Native CLI session id linkage (used as the terminal attach id for resume). */
  cliSessionFile?: string | null;
  /**
   * FNXC:ChatSearch 2026-07-07-00:00:
   * Set only when this session's inclusion in `filteredSessions` (content mode) was driven by
   * a server-side message-content match rather than the title/agentId filter, so the sidebar
   * can show "why did this match" without a second round trip.
   */
  matchedMessagePreview?: string;
}

// Re-export shared chat types so existing consumers (`import { ChatMessageInfo } from "../hooks/useChat"`)
// keep working — single source of truth lives in chatTypes.ts.
export type { ChatMessageInfo, FailureInfo, FallbackInfo, ToolCallInfo } from "./chatTypes";
import type { ChatMessageInfo, FailureInfo, FallbackInfo, ToolCallInfo } from "./chatTypes";
import { createChatStreamHandlers } from "./createChatStreamHandlers";
import {
  getPersistedPendingChatMessages,
  removePersistedPendingChatMessages,
  setPersistedPendingChatMessages,
} from "./chatPendingMessageStorage";
import { isLikelyTabSuspensionError, useTabVisibilitySuspension } from "./visibilitySuspension";
import { clearCache, readCache, SWR_CACHE_KEYS, SWR_TASKS_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { useAgentsMapCache } from "./useAgentsMapCache";

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
  streamingToolCalls: ToolCallInfo[];
  pendingMessages: string[];

  // Session operations
  selectSession: (id: string, sessionOverride?: ChatSessionInfo) => void;
  createSession: (
    input: { agentId: string; title?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ) => Promise<ChatSessionInfo>;
  archiveSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  pinSession: (id: string, pinned: boolean) => Promise<void>;
  pinnedCount: number;
  setSessionModel: (
    id: string,
    selection: { agentId?: string; modelProvider?: string | null; modelId?: string | null },
  ) => Promise<void>;
  /**
   * FNXC:Chat-ThinkingLevel 2026-07-12-19:30:
   * Change an existing (already-created) session's reasoning-effort level mid-conversation via
   * PATCH /api/chat/sessions/:id; distinct from the create-time picker in NewChatDialog
   * (FN-7775). `level: ""` clears the override back to inherit the project/global default.
   * Mirrors renameSession's optimistic-update-with-rollback contract.
   */
  setSessionThinkingLevel: (id: string, level: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  // Message operations
  /**
   * Send a message, optionally with file attachments to upload with the prompt. Attachment
   * callbacks distinguish a rejected upload from a server-accepted turn whose reply later fails.
   */
  sendMessage: (
    content: string,
    attachments?: File[],
    callbacks?: { onDelivered?: () => void; onFailed?: () => void },
  ) => void;
  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Edit an earlier user message: truncates local + persisted history from that message onward
   * (server also rewinds the pi session context so the model forgets discarded turns), then
   * resends the edited content through the normal `sendMessage` streaming path. No-ops while a
   * generation is streaming or when there is no active session.
   */
  editMessageAndResend: (messageId: string, newContent: string) => Promise<void>;
  stopStreaming: () => void;
  clearPendingMessage: (index?: number) => void;
  loadMoreMessages: () => Promise<void>;
  hasMoreMessages: boolean;

  // Search/filter
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /**
   * FNXC:ChatSearch 2026-07-07-12:00:
   * Search always matches session title/agentId AND message content via a debounced server
   * round trip; matched sessions are unioned into `filteredSessions`. There is no client toggle
   * to restrict search back to title-only (FN-7651 removed the "Search in title only" button).
   */
  filteredSessions: ChatSessionInfo[];

  // Refresh
  refreshSessions: () => Promise<void>;

  // Agent name resolution
  agentsMap: Map<string, Agent>;
}

function parseModelDescriptor(model: string): { modelProvider?: string; modelId?: string } {
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

function extractFailureInfo(metadata: Record<string, unknown> | null | undefined): FailureInfo | undefined {
  const rawFailure = metadata?.failureInfo;
  if (!rawFailure || typeof rawFailure !== "object") {
    return undefined;
  }

  const record = rawFailure as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return undefined;
  }

  const reference = (() => {
    const rawReference = record.reference;
    if (!rawReference || typeof rawReference !== "object") {
      return undefined;
    }
    const referenceRecord = rawReference as Record<string, unknown>;
    const kind = typeof referenceRecord.kind === "string" ? referenceRecord.kind.trim() : "";
    const id = typeof referenceRecord.id === "string" ? referenceRecord.id.trim() : "";
    if (!kind || !id) {
      return undefined;
    }
    return {
      kind,
      id,
      ...(typeof referenceRecord.label === "string" && referenceRecord.label.trim()
        ? { label: referenceRecord.label.trim() }
        : {}),
    };
  })();

  return {
    summary,
    ...(typeof record.errorClass === "string" && record.errorClass.trim()
      ? { errorClass: record.errorClass.trim() }
      : {}),
    ...(typeof record.code === "string" && record.code.trim()
      ? { code: record.code.trim() }
      : {}),
    ...(typeof record.detail === "string" && record.detail.trim()
      ? { detail: record.detail.trim() }
      : {}),
    ...(reference ? { reference } : {}),
  };
}

function normalizeFailureInfo(data: string | ChatFailureInfo, t?: (key: string, defaultValue: string) => string): FailureInfo {
  const defaultErrorMsg = t ? t("chat.failedToGetResponse", "Failed to get response") : "Failed to get response";
  if (typeof data === "string") {
    const summary = data.trim() || defaultErrorMsg;
    return { summary };
  }

  const summary = typeof data.summary === "string" && data.summary.trim()
    ? data.summary.trim()
    : defaultErrorMsg;

  return {
    summary,
    ...(typeof data.errorClass === "string" && data.errorClass.trim()
      ? { errorClass: data.errorClass.trim() }
      : {}),
    ...(typeof data.code === "string" && data.code.trim()
      ? { code: data.code.trim() }
      : {}),
    ...(typeof data.detail === "string" && data.detail.trim()
      ? { detail: data.detail.trim() }
      : {}),
    ...(data.reference ? { reference: data.reference } : {}),
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
    failureInfo: extractFailureInfo(message.metadata),
    attachments: message.attachments,
    createdAt: message.createdAt,
  };
}

/*
FNXC:ChatMessageOrder 2026-07-19-00:00:
Leaving and returning to direct Chat during an active generation can merge a persisted user echo
into a partial cache after a later assistant turn. Every client-side transcript merge must restore
ascending createdAt order, with id as a deterministic tie-breaker, so optimistic replacement,
mid-stream reloads, and SSE echoes cannot move user bubbles past later turns.
*/
function sortChatMessagesChronologically(messages: ChatMessageInfo[]): ChatMessageInfo[] {
  return [...messages].sort((a, b) => {
    const createdAtDifference = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return Number.isFinite(createdAtDifference) && createdAtDifference !== 0
      ? createdAtDifference
      : a.id.localeCompare(b.id);
  });
}

function reconcileOptimisticSentMessage(previous: ChatMessageInfo[], persisted: ChatMessageInfo): ChatMessageInfo[] {
  if (previous.some((message) => message.id === persisted.id)) return sortChatMessagesChronologically(previous);
  const optimisticIndex = previous.findIndex((candidate) =>
    candidate.role === "user"
    && candidate.id.startsWith("temp-")
    && candidate.sessionId === persisted.sessionId
    && candidate.content.trim() === persisted.content.trim(),
  );
  if (optimisticIndex < 0) return sortChatMessagesChronologically([...previous, persisted]);
  const next = [...previous];
  next[optimisticIndex] = persisted;
  return sortChatMessagesChronologically(next);
}

export function useChat(
  projectId?: string,
  addToast?: (msg: string, type?: "success" | "error" | "warning") => void,
): UseChatReturn {
  // Note: We use i18n lazy - the t function is only used for fallback messages
  // and can be undefined since normalizeFailureInfo has a safe default
  const getChatSessionsCacheKey = useCallback(
    (targetProjectId?: string) => (targetProjectId ? `${SWR_CACHE_KEYS.CHAT_SESSIONS_PREFIX}${targetProjectId}` : null),
    [],
  );
  const getChatMessagesCacheKey = useCallback(
    (targetProjectId?: string, sessionId?: string | null) =>
      targetProjectId && sessionId ? `${SWR_CACHE_KEYS.CHAT_MESSAGES_PREFIX}${targetProjectId}:${sessionId}` : null,
    [],
  );

  const readCachedSessions = useCallback(
    (targetProjectId?: string) => {
      const cacheKey = getChatSessionsCacheKey(targetProjectId);
      if (!cacheKey) {
        return [] as ChatSessionInfo[];
      }

      const cachedSessions = readCache<ChatSessionInfo[]>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS }) ?? [];
      /*
      FNXC:ChatModal 2026-07-01-00:00:
      Server settings decide whether task-planner sessions belong in the common feed. Do not hydrate cached task chats before that filtered list returns, otherwise a stale cache can briefly expose hidden task-detail conversations and their controls.
      */
      return cachedSessions.filter((session) => !isTaskPlannerSession(session));
    },
    [getChatSessionsCacheKey],
  );

  // Session state
  const [sessions, setSessions] = useState<ChatSessionInfo[]>(() => readCachedSessions(projectId));
  const [activeSession, setActiveSession] = useState<ChatSessionInfo | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(() => readCachedSessions(projectId).length === 0);

  // Message state
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallInfo[]>([]);
  const [pendingMessages, setPendingMessages] = useState<string[]>([]);

  // Search/filter
  const [searchQuery, setSearchQuery] = useState("");
  /*
  FNXC:ChatSearch 2026-07-07-12:00:
  Content mode is always on: the query matches title/agentId AND message content. There is no
  client toggle to restrict this back to title/agentId-only (FN-7651 removed the button).
  */
  const [contentMatchedPreviews, setContentMatchedPreviews] = useState<Map<string, string>>(new Map());
  // Monotonic request counter: guards against an out-of-order/superseded debounced content
  // search response overwriting a newer query's results.
  const contentSearchRequestIdRef = useRef(0);

  // Pagination
  const [hasMoreMessages, setHasMoreMessages] = useState(false);

  // Agent name resolution map
  const { agentsMap } = useAgentsMapCache(projectId);

  // Stream connection ref for cleanup
  const streamRef = useRef<{ close: () => void } | null>(null);
  const lastAttachedGenerationRef = useRef<{ sessionId: string; replayFromEventId: number | null } | null>(null);
  const cancelledByUserRef = useRef(false);
  const pendingMessagesRef = useRef<string[]>([]);
  const attachIfGeneratingRef = useRef<(
    sessionId: string,
    inFlightGeneration?: ChatInFlightGenerationState | null,
    options?: { silent?: boolean; priorThreadLoadAlreadyStarted?: boolean },
  ) => boolean>(() => false);
  // Cancel any pending requestAnimationFrame flushes from the active stream.
  // Set when sendMessage starts, cleared on done/error. Called from stopStreaming
  // so a clear-then-rAF-fires sequence doesn't flash stale text back in.
  const cancelStreamingFlushesRef = useRef<(() => void) | null>(null);

  // Refs for SSE event handlers to access current state
  const sessionsRef = useRef(sessions);
  const activeSessionRef = useRef(activeSession);
  const messagesRef = useRef(messages);
  const isStreamingRef = useRef(isStreaming);
  sessionsRef.current = sessions;
  activeSessionRef.current = activeSession;
  messagesRef.current = messages;
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    pendingMessagesRef.current = pendingMessages;
  }, [pendingMessages]);

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
    recordResumeEvent({
      view: "useChat",
      trigger: "project-context-change",
      projectId,
      replayAttempted: false,
      detail: { previousProjectId: previousProjectIdRef.current ?? null },
    });
    previousProjectIdRef.current = projectId;
    projectContextVersionRef.current++;
  }

  // Fetch sessions
  const refreshSessions = useCallback(async () => {
    if (sessionsRef.current.length === 0) {
      setSessionsLoading(true);
    }
    try {
      const data: ChatSessionListResponse = await fetchChatSessions(projectId);
      const sorted = sortChatSessions(data.sessions);
      setSessions(sorted);
      const cacheKey = getChatSessionsCacheKey(projectId);
      if (cacheKey) {
        writeCache(cacheKey, sorted, { maxBytes: 500_000 });
      }
    } catch {
      const cacheHydratedSessions = readCachedSessions(projectId);
      if (sessionsRef.current.length === 0 && cacheHydratedSessions.length === 0) {
        const cacheKey = getChatSessionsCacheKey(projectId);
        if (cacheKey) {
          clearCache(cacheKey);
        }
      }
      // Silently fail on refresh
    } finally {
      setSessionsLoading(false);
    }
  }, [getChatSessionsCacheKey, projectId]);

  useEffect(() => {
    const cachedSessions = sortChatSessions(readCachedSessions(projectId));
    setSessions(cachedSessions);
    setSessionsLoading(cachedSessions.length === 0);
  }, [projectId, readCachedSessions]);

  // Initial load
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, projectId]);

  // Restore active session from localStorage after initial load.
  // Uses refs to avoid circular dependency with selectSession and to avoid
  // re-selecting/resetting the thread on every sessions refresh.
  const selectSessionRef = useRef<(id: string, sessionOverride?: ChatSessionInfo) => void>(() => {
    /* noop - will be replaced after selectSession is defined */
  });
  const hasRestoredActiveSessionRef = useRef(false);

  useEffect(() => {
    hasRestoredActiveSessionRef.current = false;
    lastAttachedGenerationRef.current = null;
  }, [projectId]);

  useEffect(() => {
    if (sessionsLoading || hasRestoredActiveSessionRef.current || activeSessionRef.current) return;

    const savedSessionId = getScopedItem(ACTIVE_SESSION_STORAGE_KEY, projectId);
    if (!savedSessionId) {
      hasRestoredActiveSessionRef.current = true;
      return;
    }

    const session = sessions.find((s) => s.id === savedSessionId);
    if (session) {
      hasRestoredActiveSessionRef.current = true;
      selectSessionRef.current(savedSessionId, session);
      return;
    }

    hasRestoredActiveSessionRef.current = true;
  }, [sessionsLoading, sessions, projectId]);

  const readCachedMessages = useCallback(
    (targetProjectId?: string, sessionId?: string | null) => {
      const cacheKey = getChatMessagesCacheKey(targetProjectId, sessionId);
      if (!cacheKey) {
        return [] as ChatMessageInfo[];
      }

      return readCache<ChatMessageInfo[]>(cacheKey, { maxAgeMs: SWR_TASKS_MAX_AGE_MS }) ?? [];
    },
    [getChatMessagesCacheKey],
  );

  const hydrateMessagesFromCache = useCallback(
    (sessionId?: string | null, opts?: { clearOnMiss?: boolean }) => {
      const cachedMessages = readCachedMessages(projectId, sessionId);
      if (cachedMessages.length > 0) {
        setMessages(sortChatMessagesChronologically(cachedMessages));
        setMessagesLoading(false);
        return true;
      }

      if (opts?.clearOnMiss !== false) {
        setMessages([]);
      }
      return false;
    },
    [projectId, readCachedMessages],
  );

  // Load messages when active session changes
  const loadMessages = useCallback(
    async (sessionId: string, opts?: { offset?: number; before?: string; commitForStreamingAttach?: boolean }) => {
      const isPaginationRequest = (typeof opts?.offset === "number" && opts.offset > 0) || typeof opts?.before === "string";
      const cacheKey = getChatMessagesCacheKey(projectId, sessionId);
      const cachedMessages = !isPaginationRequest ? readCachedMessages(projectId, sessionId) : [];
      const hasCachedMessages = cachedMessages.length > 0;

      if (!isPaginationRequest && hasCachedMessages) {
        setMessages(sortChatMessagesChronologically(cachedMessages));
        setMessagesLoading(false);
      } else {
        setMessagesLoading(true);
      }

      try {
        const data = await fetchChatMessages(sessionId, { limit: 50, order: "desc", ...opts }, projectId);
        // API returns newest-first (order=desc); normalize display order instead of trusting
        // reversal alone so equal timestamps also use the canonical id tie-breaker.
        const mappedMessages = sortChatMessagesChronologically(data.messages.map(mapChatMessageToInfo));
        const shouldCommitMessages = activeSessionRef.current?.id === sessionId
          || (opts?.commitForStreamingAttach === true && lastAttachedGenerationRef.current?.sessionId === sessionId);
        if (isPaginationRequest) {
          if (shouldCommitMessages) {
            setMessages((prev) => sortChatMessagesChronologically([...mappedMessages, ...prev]));
            setHasMoreMessages(data.messages.length >= 50);
          }
        } else {
          if (shouldCommitMessages) {
            const isActiveStreamingSession = isStreamingRef.current && activeSessionRef.current?.id === sessionId;
            const responseBelongsToSession = mappedMessages.every((message) => message.sessionId === sessionId);
            const currentMessagesBelongToSession = messagesRef.current.length > 0 && messagesRef.current.every((message) => message.sessionId === sessionId);
            const shouldPreserveActiveStreamingThread = isActiveStreamingSession
              && currentMessagesBelongToSession
              && (!responseBelongsToSession || mappedMessages.length === 0);
            setMessages((prev) => {
              if (isActiveStreamingSession && prev.length > 0) {
                const previousBelongsToSession = prev.every((message) => message.sessionId === sessionId);
                if (previousBelongsToSession && (!responseBelongsToSession || mappedMessages.length === 0)) {
                  /*
                  FNXC:ChatStreaming 2026-07-12-11:08:
                  During an active assistant turn, the visible prior thread is append-only until onDone/recovery performs the authoritative reload. Mid-turn chat:session:updated, tool-call, and streaming churn can leave an older loadMessages request in flight; an empty or cross-session response must not blank/reflow messages because chat:message:added assistant echoes are suppressed while streaming.
                  */
                  return prev;
                }

                if (previousBelongsToSession && mappedMessages.length > 0) {
                  const merged = [...prev];
                  const seen = new Set(prev.map((message) => message.id));
                  for (const message of mappedMessages) {
                    if (!seen.has(message.id)) {
                      merged.push(message);
                      seen.add(message.id);
                    }
                  }
                  return sortChatMessagesChronologically(merged);
                }
              }

              return mappedMessages;
            });
            setHasMoreMessages(data.messages.length >= 50);
            if (cacheKey && responseBelongsToSession && !shouldPreserveActiveStreamingThread) writeCache(cacheKey, mappedMessages, { maxBytes: 500_000 });
          }
        }
      } catch {
        if (!isPaginationRequest && messagesRef.current.length === 0 && hasCachedMessages) {
          setMessages(sortChatMessagesChronologically(cachedMessages));
          setMessagesLoading(false);
        }
        // Silently fail
      } finally {
        setMessagesLoading(false);
      }
    },
    [getChatMessagesCacheKey, projectId, readCachedMessages],
  );

  const resetTransientComposerState = useCallback(() => {
    cancelStreamingFlushesRef.current?.();
    cancelStreamingFlushesRef.current = null;
    pendingMessagesRef.current = [];
    setPendingMessages([]);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingToolCalls([]);
    setIsStreaming(false);
  }, []);

  const clearPendingMessage = useCallback((index?: number) => {
    const sessionId = activeSessionRef.current?.id;
    if (typeof index === "number") {
      const nextMessages = pendingMessagesRef.current.filter((_, messageIndex) => messageIndex !== index);
      pendingMessagesRef.current = nextMessages;
      setPendingMessages(nextMessages);
      setPersistedPendingChatMessages(sessionId, nextMessages);
      return;
    }

    removePersistedPendingChatMessages(sessionId);
    pendingMessagesRef.current = [];
    setPendingMessages([]);
  }, []);

  const flushPendingMessage = useCallback(() => {
    const [queuedMessage, ...remainingMessages] = pendingMessagesRef.current;
    const trimmedQueuedMessage = queuedMessage?.trim();
    if (!trimmedQueuedMessage) {
      return;
    }

    const sessionId = activeSessionRef.current?.id;
    pendingMessagesRef.current = remainingMessages;
    setPendingMessages(remainingMessages);
    setPersistedPendingChatMessages(sessionId, remainingMessages);
    sendMessageRef.current(trimmedQueuedMessage);
  }, []);

  const flushPendingMessageAfterAttachedError = useCallback(async (
    sessionId: string,
    options?: { silent?: boolean },
  ) => {
    try {
      const { session: refreshedSession } = await fetchChatSession(sessionId, projectId);
      if (activeSessionRef.current?.id !== sessionId || pendingMessagesRef.current.length === 0) {
        return;
      }

      if (refreshedSession.isGenerating || refreshedSession.inFlightGeneration) {
        /*
        FNXC:ChatComposer 2026-06-27-00:00:
        Attach-stream errors must not dequeue restored messages until an authoritative session fetch proves the server is idle; otherwise a reconnect race can send the FIFO front while the previous generation is still in flight.
        */
        attachIfGeneratingRef.current(sessionId, refreshedSession.inFlightGeneration, {
          silent: options?.silent,
          priorThreadLoadAlreadyStarted: true,
        });
        return;
      }

      flushPendingMessage();
    } catch {
      // Keep the queue durable when the authoritative generation check is unavailable.
    }
  }, [flushPendingMessage, projectId]);

  const attachIfGenerating = useCallback((
    sessionId: string,
    inFlightGeneration?: ChatInFlightGenerationState | null,
    options?: { silent?: boolean; priorThreadLoadAlreadyStarted?: boolean },
  ) => {
    if (streamRef.current || !sessionId) {
      return true;
    }

    cancelledByUserRef.current = false;
    const currentMessages = messagesRef.current;
    const needsPriorThreadLoad = currentMessages.length === 0 || currentMessages[0]?.sessionId !== sessionId;
    lastAttachedGenerationRef.current = {
      sessionId,
      replayFromEventId: typeof inFlightGeneration?.replayFromEventId === "number"
        ? inFlightGeneration.replayFromEventId
        : null,
    };
    if (needsPriorThreadLoad && !options?.priorThreadLoadAlreadyStarted) {
      /*
      FNXC:ChatStreaming 2026-06-17-16:50:
      Main chat must keep the persisted prior thread visible while an assistant response streams, including attach paths that run before React commits activeSession into activeSessionRef.
      Because chat:message:added echoes are suppressed during streaming, attach-triggered thread loads must commit for the attached session and cache misses must not blank an existing thread while the load is in flight.
      */
      hydrateMessagesFromCache(sessionId, { clearOnMiss: false });
      void loadMessages(sessionId, { commitForStreamingAttach: true });
    }
    if (inFlightGeneration) {
      /*
      FNXC:ChatStreaming 2026-06-18-06:00:
      Main chat paints the durable in-flight snapshot immediately for reattach UX, and passes the same snapshot into createChatStreamHandlers so the first replayed delta appends to accumulated text/thinking/tool calls instead of replacing the visible prefix.
      */
      setStreamingText(inFlightGeneration.streamingText);
      setStreamingThinking(inFlightGeneration.streamingThinking);
      setStreamingToolCalls(inFlightGeneration.toolCalls);
    }
    setIsStreaming(true);

    const { handlers } = createChatStreamHandlers({
      sessionId,
      tempUserMessageId: "",
      initialText: inFlightGeneration?.streamingText,
      initialThinking: inFlightGeneration?.streamingThinking,
      initialToolCalls: inFlightGeneration?.toolCalls,
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
        lastAttachedGenerationRef.current = null;
        void loadMessages(sessionId);
        flushPendingMessage();
      },
      onError: (data) => {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(false);
        isStreamingRef.current = false;
        streamRef.current = null;
        lastAttachedGenerationRef.current = null;
        const failureInfo = normalizeFailureInfo(data);
        if (!options?.silent) {
          addToast?.(failureInfo.summary, "error");
        }
        void loadMessages(sessionId);
        void flushPendingMessageAfterAttachedError(sessionId, { silent: options?.silent });
      },
    });

    recordResumeEvent({
      view: "useChat",
      trigger: "sse-open",
      projectId,
      replayAttempted: typeof inFlightGeneration?.replayFromEventId === "number",
      replayFromEventId: inFlightGeneration?.replayFromEventId ?? null,
      lastEventId: inFlightGeneration?.replayFromEventId ?? null,
    });
    const stream = attachChatStream(sessionId, handlers, projectId, {
      ...(typeof inFlightGeneration?.replayFromEventId === "number"
        ? { lastEventId: inFlightGeneration.replayFromEventId }
        : {}),
    });
    streamRef.current = stream;
    return true;
  }, [addToast, flushPendingMessage, flushPendingMessageAfterAttachedError, hydrateMessagesFromCache, loadMessages, projectId]);
  attachIfGeneratingRef.current = attachIfGenerating;

  // Select a session
  const selectSession = useCallback(
    (id: string, sessionOverride?: ChatSessionInfo) => {
      const currentActiveSessionId = activeSessionRef.current?.id ?? null;
      if (id && currentActiveSessionId === id && !sessionOverride) {
        return;
      }
      // Close any existing stream
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      lastAttachedGenerationRef.current = null;

      // Find and set active session
      const session = sessionOverride ?? sessions.find((s) => s.id === id);
      setActiveSession(session || null);
      activeSessionRef.current = session || null;

      if (id) {
        void fetchChatSession(id, projectId)
          .then(({ session: refreshedSession }) => {
            if (!refreshedSession.isGenerating) {
              return;
            }
            // Only act if the user hasn't navigated away from this session
            // while the authoritative refresh was in flight.
            if (activeSessionRef.current?.id !== id) {
              return;
            }
            setActiveSession((prev) => {
              if (!prev || prev.id !== id) {
                return prev;
              }
              return {
                ...prev,
                ...refreshedSession,
              };
            });
            /*
            FNXC:ChatStreaming 2026-07-07-00:00:
            FN-7656: returning to a session with an in-flight generation must restore the
            working/"Thinking…" indicator immediately, even before the first response delta.
            The local `sessions` cache's `isGenerating` flag is often stale (chat:session:updated
            SSE payloads lack the route-level isGenerating/inFlightGeneration enrichment), and
            early in a generation the server reports isGenerating:true with inFlightGeneration
            still null (no delta emitted yet). Reattach on isGenerating alone via this
            authoritative fetchChatSession refresh rather than requiring inFlightGeneration too;
            attachIfGenerating already handles a null inFlightGeneration snapshot gracefully and
            guards against double-attach via streamRef.current.
            */
            if (!streamRef.current) {
              attachIfGenerating(id, refreshedSession.inFlightGeneration, { silent: true });
            }
          })
          .catch(() => {
            // Ignore stale-cache recovery fetch failures.
          });
      }

      // Reset transient state
      resetTransientComposerState();
      setHasMoreMessages(false);

      // Load messages for this session
      if (id) {
        hydrateMessagesFromCache(id);
        loadMessages(id);
      } else {
        setMessages([]);
      }

      // Recover streaming state if the server reports an active generation.
      // After a reload/HMR, the server keeps generating but the UI loses
      // all streaming state. Showing "Working…" immediately tells the
      // user the AI is still processing the request.
      if (session?.isGenerating) {
        attachIfGenerating(session.id, session.inFlightGeneration, { priorThreadLoadAlreadyStarted: true });
      }

      // Persist active session to localStorage
      if (id) {
        setScopedItem(ACTIVE_SESSION_STORAGE_KEY, id, projectId);
      } else {
        removeScopedItem(ACTIVE_SESSION_STORAGE_KEY, projectId);
      }
    },
    [attachIfGenerating, hydrateMessagesFromCache, sessions, loadMessages, projectId, resetTransientComposerState],
  );

  // Update the ref to point to the actual selectSession function
  // This is needed to avoid circular dependencies in useEffect
  selectSessionRef.current = selectSession;

  useEffect(() => {
    const sessionId = activeSession?.id;
    if (!sessionId) {
      return;
    }

    const restoredPendingMessages = getPersistedPendingChatMessages(sessionId);
    if (restoredPendingMessages.length === 0) {
      return;
    }

    /*
    FNXC:ChatComposer 2026-06-27-00:00:
    Queued direct-chat sends are a FIFO array: every send during streaming stacks above the composer and exactly one front item flushes after each stream completion, preserving FN-5852's server-in-flight guard.
    */
    pendingMessagesRef.current = restoredPendingMessages;
    setPendingMessages(restoredPendingMessages);

    // Flush only once the server confirms no generation is in flight. The
    // local sessions list can hold a stale falsy `isGenerating` (it is a
    // route-level enrichment that the chat:session:updated SSE payload
    // lacks), so flushing from local state alone fires a send that aborts a
    // live generation server-side and can lose the queued message (FN-5852).
    let cancelled = false;
    void fetchChatSession(sessionId, projectId)
      .then(({ session: refreshedSession }) => {
        if (
          cancelled ||
          activeSessionRef.current?.id !== sessionId ||
          pendingMessagesRef.current.length === 0
        ) {
          return;
        }

        if (refreshedSession.isGenerating) {
          // Still generating: attach (if not already) and let the stream's
          // onDone/onError flush the queued message.
          if (!streamRef.current) {
            attachIfGenerating(sessionId, refreshedSession.inFlightGeneration);
          }
          return;
        }

        if (!isStreamingRef.current && !streamRef.current) {
          flushPendingMessage();
        }
      })
      .catch(() => {
        // Keep the restored bubble; another flush trigger (stream
        // completion, visibility resume, manual send) will deliver it.
      });

    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, attachIfGenerating, flushPendingMessage, projectId]);

  // Create a new session
  const createSession = useCallback(
    async (input: { agentId: string; title?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string }) => {
      const previousSessionId = activeSessionRef.current?.id;
      const data = await apiCreateChatSession(input, projectId);

      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      lastAttachedGenerationRef.current = null;
      const newSession: ChatSessionInfo = {
        id: data.session.id,
        title: data.session.title,
        agentId: data.session.agentId,
        status: data.session.status,
        modelProvider: data.session.modelProvider,
        modelId: data.session.modelId,
        thinkingLevel: data.session.thinkingLevel,
        pinnedAt: data.session.pinnedAt,
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt,
      };

      setSessions((prev) => {
        if (prev.some((s) => s.id === newSession.id)) return prev;
        return sortChatSessions([newSession, ...prev]);
      });

      removePersistedPendingChatMessages(previousSessionId);
      resetTransientComposerState();
      selectSession(newSession.id, newSession);

      return newSession;
    },
    [projectId, resetTransientComposerState, selectSession],
  );

  // Archive a session
  const archiveSession = useCallback(
    async (id: string) => {
      removePersistedPendingChatMessages(id);
      await updateChatSession(id, { status: "archived" }, projectId);
      // Remove from sessions list
      setSessions((prev) => prev.filter((s) => s.id !== id));
      // If it was the active session, clear it
      if (activeSession?.id === id) {
        lastAttachedGenerationRef.current = null;
        setActiveSession(null);
        setMessages([]);
      }
    },
    [activeSession, projectId],
  );

  /**
   * FNXC:Chat 2026-06-16-22:01:
   * Users can rename regular and quick chat sessions through existing PATCH title plumbing; update the list and active header optimistically so every visible session title reflects the new value immediately while rolling back on API failure.
   */
  const renameSession = useCallback(
    async (id: string, title: string) => {
      const normalizedTitle = title.trim() || null;
      const previousSessions = sessions;
      const previousActiveSession = activeSession;

      setSessions((prev) => prev.map((session) => (session.id === id ? { ...session, title: normalizedTitle } : session)));
      setActiveSession((prev) => (prev?.id === id ? { ...prev, title: normalizedTitle } : prev));

      try {
        const data = await updateChatSession(id, { title: normalizedTitle }, projectId);
        const updatedSession = data.session;
        setSessions((prev) =>
          prev.map((session) =>
            session.id === id
              ? {
                  ...session,
                  title: updatedSession.title,
                  updatedAt: updatedSession.updatedAt,
                }
              : session,
          ),
        );
        setActiveSession((prev) =>
          prev?.id === id
            ? {
                ...prev,
                title: updatedSession.title,
                updatedAt: updatedSession.updatedAt,
              }
            : prev,
        );
      } catch (error) {
        setSessions(previousSessions);
        setActiveSession(previousActiveSession);
        addToast?.("Failed to rename conversation", "error");
        throw error;
      }
    },
    [activeSession, addToast, projectId, sessions],
  );

  /**
   * FNXC:ChatPinned 2026-07-16-12:00:
   * Optimistically pin/unpin both displayed session state and the active header;
   * the server remains authoritative for the advisory-locked limit and restores
   * the prior snapshot when that limit rejects a fourth conversation.
   */
  const pinSession = useCallback(
    async (id: string, pinned: boolean) => {
      const previousSessions = sessions;
      const previousActiveSession = activeSession;
      const optimisticPinnedAt = pinned ? new Date().toISOString() : null;
      setSessions((prev) => sortChatSessions(prev.map((session) =>
        session.id === id ? { ...session, pinnedAt: optimisticPinnedAt } : session,
      )));
      setActiveSession((prev) => prev?.id === id ? { ...prev, pinnedAt: optimisticPinnedAt } : prev);
      try {
        const data = await updateChatSession(id, { pinned }, projectId);
        const patch = { pinnedAt: data.session.pinnedAt, updatedAt: data.session.updatedAt };
        setSessions((prev) => sortChatSessions(prev.map((session) => session.id === id ? { ...session, ...patch } : session)));
        setActiveSession((prev) => prev?.id === id ? { ...prev, ...patch } : prev);
      } catch (error) {
        setSessions(previousSessions);
        setActiveSession(previousActiveSession);
        addToast?.(error instanceof Error ? error.message : "You can pin up to 3 conversations", "error");
        throw error;
      }
    },
    [activeSession, addToast, projectId, sessions],
  );

  /**
   * FNXC:Chat-ModelSwitch 2026-07-12-00:00:
   * The brain-icon popup can retarget an active direct conversation to either a model pair or a real agent mid-conversation. Optimistically patch both session collections so the next send and visible header use the new persisted target without creating a replacement chat.
   *
   * FNXC:Chat-ModelSwitch 2026-07-12-21:40:
   * The PATCH payload must explicitly clear the field the user is switching AWAY from (agentId
   * when picking a model; modelProvider/modelId when picking an agent), not just the optimistic
   * local patch. Forwarding only the caller's partial `selection` would leave a stale agentId
   * (or stale modelProvider/modelId) persisted server-side, so the next send could still resolve
   * against the PREVIOUS target — silently breaking the retarget this control exists for.
   */
  const setSessionModel = useCallback(
    async (id: string, selection: { agentId?: string; modelProvider?: string | null; modelId?: string | null }) => {
      const previousSessions = sessions;
      const previousActiveSession = activeSession;
      const isAgentSwitch = selection.agentId !== undefined;
      const optimisticPatch = isAgentSwitch
        ? { agentId: selection.agentId!, modelProvider: null, modelId: null }
        : { agentId: FN_AGENT_ID, modelProvider: selection.modelProvider ?? null, modelId: selection.modelId ?? null };

      setSessions((prev) => prev.map((session) => (session.id === id ? { ...session, ...optimisticPatch } : session)));
      setActiveSession((prev) => (prev?.id === id ? { ...prev, ...optimisticPatch } : prev));

      try {
        const data = await updateChatSession(id, optimisticPatch, projectId);
        const updatedSession = data.session;
        const reconciledPatch = {
          agentId: updatedSession.agentId,
          modelProvider: updatedSession.modelProvider,
          modelId: updatedSession.modelId,
          updatedAt: updatedSession.updatedAt,
        };
        setSessions((prev) =>
          prev.map((session) => (session.id === id ? { ...session, ...reconciledPatch } : session)),
        );
        setActiveSession((prev) => (prev?.id === id ? { ...prev, ...reconciledPatch } : prev));
      } catch (error) {
        setSessions(previousSessions);
        setActiveSession(previousActiveSession);
        addToast?.("Failed to update chat model", "error");
        throw error;
      }
    },
    [activeSession, addToast, projectId, sessions],
  );

  /**
   * FNXC:Chat-ThinkingLevel 2026-07-12-19:30:
   * Lets a user change an already-created direct chat session's thinking (reasoning-effort)
   * level from the in-chat composer control, mid-conversation — FN-7775 only supported picking
   * it once at session creation. Mirrors renameSession's optimistic-update-with-rollback
   * contract exactly: update both `sessions` and `activeSession` immediately, reconcile with the
   * server response, and roll back both on failure with an error toast.
   */
  const setSessionThinkingLevel = useCallback(
    async (id: string, level: string) => {
      const normalizedLevel = level.trim() || null;
      const previousSessions = sessions;
      const previousActiveSession = activeSession;

      setSessions((prev) => prev.map((session) => (session.id === id ? { ...session, thinkingLevel: normalizedLevel } : session)));
      setActiveSession((prev) => (prev?.id === id ? { ...prev, thinkingLevel: normalizedLevel } : prev));

      try {
        const data = await updateChatSession(id, { thinkingLevel: normalizedLevel }, projectId);
        const updatedSession = data.session;
        setSessions((prev) =>
          prev.map((session) =>
            session.id === id
              ? {
                  ...session,
                  thinkingLevel: updatedSession.thinkingLevel,
                  updatedAt: updatedSession.updatedAt,
                }
              : session,
          ),
        );
        setActiveSession((prev) =>
          prev?.id === id
            ? {
                ...prev,
                thinkingLevel: updatedSession.thinkingLevel,
                updatedAt: updatedSession.updatedAt,
              }
            : prev,
        );
      } catch (error) {
        setSessions(previousSessions);
        setActiveSession(previousActiveSession);
        addToast?.("Failed to update thinking level", "error");
        throw error;
      }
    },
    [activeSession, addToast, projectId, sessions],
  );

  // Delete a session
  const deleteSession = useCallback(
    async (id: string) => {
      removePersistedPendingChatMessages(id);
      // Close stream if active
      if (activeSession?.id === id && streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      if (activeSession?.id === id) {
        lastAttachedGenerationRef.current = null;
      }

      await deleteChatSession(id, projectId);
      const cacheKey = getChatMessagesCacheKey(projectId, id);
      if (cacheKey) {
        clearCache(cacheKey);
      }
      // Remove from sessions list
      setSessions((prev) => prev.filter((s) => s.id !== id));
      // If it was the active session, clear it
      if (activeSession?.id === id) {
        setActiveSession(null);
        setMessages([]);
      }
    },
    [activeSession, getChatMessagesCacheKey, projectId],
  );

  // Load more messages (pagination — use before cursor for oldest displayed message)
  // messagesRef is assigned on every render; reading from the ref here avoids
  // closing over `messages` and prevents this callback from being recreated on
  // every streamed token (which would cause the IntersectionObserver to churn).
  const loadMoreMessages = useCallback(async () => {
    if (!activeSession || !hasMoreMessages) return;
    // messagesRef.current[0] is the oldest visible message; fetch older ones using its createdAt
    const cursor = messagesRef.current[0]?.createdAt;
    if (!cursor) return;
    await loadMessages(activeSession.id, { before: cursor });
  }, [activeSession, hasMoreMessages, loadMessages]);

  const stopStreaming = useCallback(() => {
    if (!activeSession) return;

    cancelledByUserRef.current = true;
    cancelStreamingFlushesRef.current?.();
    cancelStreamingFlushesRef.current = null;
    streamRef.current?.close();
    streamRef.current = null;
    lastAttachedGenerationRef.current = null;

    void cancelChatResponse(activeSession.id, projectId).catch(() => {
      // Best-effort cancellation; ignore backend errors.
    });

    setIsStreaming(false);
    isStreamingRef.current = false;
    setStreamingText("");
    setStreamingThinking("");
    setStreamingToolCalls([]);
    flushPendingMessage();
  }, [activeSession, projectId, flushPendingMessage]);

  /**
   * Send a user message to the active chat session.
   * @param content Message text content to send.
   * @param attachments Optional files to upload with the message in the same request.
   */
  const sendMessageRef = useRef<(
    content: string,
    attachments?: File[],
    callbacks?: { onDelivered?: () => void; onFailed?: () => void },
  ) => void>(() => {
    // no-op until sendMessage is defined
  });
  const visibilitySuspension = useTabVisibilitySuspension();

  const reconnectSessionSilently = useCallback(async (sessionId: string) => {
    try {
      await refreshSessions();
      const refreshedSession = await fetchChatSession(sessionId, projectId);

      if (activeSessionRef.current?.id === sessionId) {
        setActiveSession((prev) => {
          if (!prev || prev.id !== sessionId) {
            return prev;
          }
          return {
            ...prev,
            ...refreshedSession.session,
          };
        });
      }

      if (refreshedSession.session.isGenerating) {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(true);
        isStreamingRef.current = true;
        attachIfGenerating(sessionId, refreshedSession.session.inFlightGeneration, { silent: true });
      } else {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(false);
        isStreamingRef.current = false;
        await loadMessages(sessionId);
      }
    } catch {
      // Intentionally swallow reconnect failures for suspension-style recovery.
    }
  }, [attachIfGenerating, loadMessages, projectId, refreshSessions]);

  const sendMessage = useCallback(
    (
      content: string,
      attachments?: File[],
      callbacks?: { onDelivered?: () => void; onFailed?: () => void },
    ) => {
      if (!activeSession) {
        callbacks?.onFailed?.();
        return;
      }

      if (isStreamingRef.current) {
        const trimmedContent = content.trim();
        if (!trimmedContent) {
          return;
        }
        const nextMessages = [...pendingMessagesRef.current, trimmedContent];
        pendingMessagesRef.current = nextMessages;
        setPendingMessages(nextMessages);
        setPersistedPendingChatMessages(activeSession.id, nextMessages);
        return;
      }

      cancelledByUserRef.current = false;

      // Close any existing stream
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      lastAttachedGenerationRef.current = null;

      // Optimistically add user message
      const tempId = `temp-${Date.now()}`;
      const userMessage: ChatMessageInfo = {
        id: tempId,
        sessionId: activeSession.id,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => sortChatMessagesChronologically([...prev, userMessage]));

      // Clear streaming state
      setStreamingText("");
      setStreamingThinking("");
      setStreamingToolCalls([]);
      setIsStreaming(true);
      isStreamingRef.current = true;

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
            ? {
                ...mapChatMessageToInfo(finalMessage),
                // FN-4835 (downstream of FN-3817): the streamed accumulator is
                // the authoritative wire transcript, so keep it when present.
                ...(accumulated.text.length > 0 ? { content: accumulated.text } : {}),
              }
            : {
                id: messageId || `msg-${Date.now()}`,
                sessionId: activeSession.id,
                role: "assistant",
                content: accumulated.text,
                thinkingOutput: accumulated.thinking,
                toolCalls: accumulated.toolCalls.length > 0 ? accumulated.toolCalls : undefined,
                fallbackInfo: accumulated.fallbackInfo,
                createdAt: new Date().toISOString(),
              };

          // Track this message ID so the SSE chatMessageAdded handler skips it
          // if the broadcast event arrives before our optimistic add settles.
          streamingMessageIdsRef.current.add(assistantMessage.id);

          // Preserve user message and add assistant message
          setMessages((prev) => sortChatMessagesChronologically([...prev, assistantMessage]));

          setStreamingText("");
          setStreamingThinking("");
          setStreamingToolCalls([]);
          setIsStreaming(false);
          isStreamingRef.current = false;
          streamRef.current = null;
          lastAttachedGenerationRef.current = null;
          callbacks?.onDelivered?.();

          // Clean up tracked ID after a short delay (SSE event should arrive quickly)
          setTimeout(() => {
            streamingMessageIdsRef.current.delete(assistantMessage.id);
          }, 1000);

          refreshSessions();

          flushPendingMessage();
        },
        onError: (data, tempUserMessageId, meta?: ChatStreamErrorMeta) => {
          const failureInfo = normalizeFailureInfo(data);
          const suspensionMessage = typeof data === "string" ? data : failureInfo.summary;
          const shouldSuppressSuspensionError = isLikelyTabSuspensionError(suspensionMessage);
          const acceptedByServer = meta?.requestAccepted === true;

          /*
          FNXC:ChatAttachments 2026-08-03-00:00:
          A direct composer owns its staged File objects and preview URLs until the server accepts
          the multipart turn. Tell it to retain those files on pre-delivery/upload failure, but
          release them after an accepted turn even when the provider cannot produce a reply.
          */
          if (acceptedByServer) {
            callbacks?.onDelivered?.();
          } else {
            callbacks?.onFailed?.();
          }

          /*
          FNXC:ChatReliability 2026-07-01-00:00:
          Provider errors can arrive after ChatManager has already persisted and sent the user's turn to the model context. Keep the visible user bubble for accepted streams and reconcile it with the persisted transcript instead of rolling it back like a pre-delivery HTTP validation failure.
          */
          setMessages((prev) => {
            const nextMessages = acceptedByServer
              ? prev
              : prev.filter((message) => message.id !== tempUserMessageId);
            if (shouldSuppressSuspensionError) {
              return nextMessages;
            }
            return sortChatMessagesChronologically([
              ...nextMessages,
              {
                id: `error-${Date.now()}`,
                sessionId: activeSession.id,
                role: "assistant",
                content: failureInfo.summary,
                failureInfo,
                createdAt: new Date().toISOString(),
              },
            ]);
          });
          setStreamingText("");
          setStreamingThinking("");
          setStreamingToolCalls([]);
          setIsStreaming(false);
          isStreamingRef.current = false;
          streamRef.current = null;
          lastAttachedGenerationRef.current = null;
          console.error("[useChat] Stream error:", data);

          if (shouldSuppressSuspensionError) {
            console.info("[useChat] Suppressed tab-suspension stream error:", data);
            if (activeSession?.id) {
              setStreamingText("");
              setStreamingThinking("");
              setStreamingToolCalls([]);
              setIsStreaming(true);
              isStreamingRef.current = true;
              void reconnectSessionSilently(activeSession.id);
            }
          } else {
            addToast?.(failureInfo.summary, "error");
            if (acceptedByServer) {
              void fetchChatMessages(activeSession.id, { limit: 50, order: "desc" }, projectId)
                .then((data) => {
                  if (activeSessionRef.current?.id !== activeSession.id) return;
                  const refreshed = data.messages.slice().reverse().map(mapChatMessageToInfo);
                  setMessages((current) => refreshed.reduce(reconcileOptimisticSentMessage, current));
                })
                .catch(() => {
                  // The optimistic accepted user bubble is already visible; the next SSE/refresh will reconcile the server id.
                });
            }
            void refreshSessions();
          }

          if (!cancelledByUserRef.current) {
            flushPendingMessage();
          }
        },
      });

      streamRef.current = streamChatResponse(activeSession.id, content, handlers, attachments, projectId);
    },
    [activeSession, projectId, refreshSessions, addToast, attachIfGenerating, reconnectSessionSilently, flushPendingMessage],
  );

  sendMessageRef.current = sendMessage;

  /*
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Editing an earlier message must resume the conversation from that point, forgetting
   * everything after it, so future responses are not biased by discarded turns. The optimistic
   * local truncation happens first (immediate UI feedback), then the server truncates its
   * persisted rows AND rewinds the pi session context (ChatManager.rewindSessionForEdit) before
   * we resend the edited content through the normal streaming sendMessage path. Blocked while
   * streaming so an edit cannot race a live generation.
   */
  const editMessageAndResend = useCallback(
    async (messageId: string, newContent: string) => {
      if (isStreamingRef.current || !activeSession) {
        return;
      }

      const trimmed = newContent.trim();
      if (!trimmed) {
        return;
      }

      const sessionId = activeSession.id;
      const previousMessages = messagesRef.current;
      const targetIndex = previousMessages.findIndex((m) => m.id === messageId);
      if (targetIndex === -1) {
        return;
      }

      try {
        await editChatMessage(sessionId, messageId, trimmed, projectId);
        // Keep the editor's message mounted until the PATCH succeeds so a rejected save retains its correction.
        setMessages(previousMessages.slice(0, targetIndex));
      } catch (error) {
        console.error("[useChat] Failed to edit message:", error);
        addToast?.("Failed to edit message", "error");
        // Restore truthful state from the server rather than trusting the optimistic truncation.
        await loadMessages(sessionId);
        /*
         * FNXC:ChatMessageEdit 2026-07-19-00:00:
         * The inline editor closes only when its async handler fulfills. Rethrow a failed PATCH
         * after recovery so Direct Chat keeps the user's correction available instead of treating
         * a toast-only failure as a successful save.
         */
        throw error;
      }

      const cacheKey = getChatMessagesCacheKey(projectId, sessionId);
      if (cacheKey) {
        clearCache(cacheKey);
      }

      sendMessage(trimmed);
    },
    [activeSession, projectId, addToast, loadMessages, getChatMessagesCacheKey, sendMessage],
  );

  /*
  FNXC:ChatSearch 2026-07-07-12:00:
  Content search requires a server round trip (message bodies are not fully loaded
  client-side), so it is debounced (300ms) and guarded against out-of-order responses via a
  monotonic request id: a superseded query (typed-ahead) invalidates in-flight responses
  instead of letting a stale result flash in. Clearing the query resets
  `contentMatchedPreviews` synchronously so there is no stale-result flash while the
  (now-irrelevant) debounced fetch is still pending/aborted.
  */
  const trimmedSearchQuery = searchQuery.trim();
  useEffect(() => {
    if (!trimmedSearchQuery) {
      contentSearchRequestIdRef.current++;
      setContentMatchedPreviews(new Map());
      return;
    }

    const requestId = ++contentSearchRequestIdRef.current;
    const timeoutId = setTimeout(() => {
      void (async () => {
        try {
          const data = await fetchChatSessions(projectId, undefined, {
            q: trimmedSearchQuery,
            titleOnly: false,
          });
          if (contentSearchRequestIdRef.current !== requestId) return;
          const previews = new Map<string, string>();
          for (const s of data.sessions) {
            if (s.matchedMessagePreview) previews.set(s.id, s.matchedMessagePreview);
          }
          setContentMatchedPreviews(previews);
        } catch {
          if (contentSearchRequestIdRef.current === requestId) {
            setContentMatchedPreviews(new Map());
          }
        }
      })();
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [trimmedSearchQuery, projectId]);

  // Filter sessions based on search query: title/agentId match always applies; content
  // matches (from contentMatchedPreviews) are always unioned in.
  const filteredSessions = (() => {
    if (!trimmedSearchQuery) return sessions;

    const lowerQuery = trimmedSearchQuery.toLowerCase();
    const titleMatched = sessions.filter(
      (s) =>
        s.title?.toLowerCase().includes(lowerQuery) ||
        s.agentId.toLowerCase().includes(lowerQuery),
    );

    if (contentMatchedPreviews.size === 0) {
      return titleMatched;
    }

    const merged = new Map<string, ChatSessionInfo>();
    for (const s of titleMatched) merged.set(s.id, s);
    for (const session of sessions) {
      const preview = contentMatchedPreviews.get(session.id);
      if (preview === undefined) continue;
      const existing = merged.get(session.id);
      merged.set(session.id, { ...(existing ?? session), matchedMessagePreview: preview });
    }
    return sortChatSessions(Array.from(merged.values()));
  })();

  useEffect(() => {
    if (!activeSession?.id || activeSession.isGenerating !== true || streamRef.current) {
      return;
    }

    const replayFromEventId = typeof activeSession.inFlightGeneration?.replayFromEventId === "number"
      ? activeSession.inFlightGeneration.replayFromEventId
      : null;
    const lastAttached = lastAttachedGenerationRef.current;
    if (lastAttached?.sessionId === activeSession.id && lastAttached.replayFromEventId === replayFromEventId) {
      return;
    }

    attachIfGenerating(activeSession.id, activeSession.inFlightGeneration, { silent: true });
  }, [activeSession?.id, activeSession?.isGenerating, activeSession?.inFlightGeneration, attachIfGenerating]);

  // Recovery mode polling: if reloaded mid-generation, keep waiting state alive
  // until generation finishes and messages can be reloaded.
  useEffect(() => {
    if (!activeSessionRef.current?.isGenerating) return;

    if (!streamRef.current) {
      attachIfGenerating(activeSessionRef.current.id, activeSessionRef.current.inFlightGeneration);
    }

    if (!isStreamingRef.current || streamRef.current || !activeSessionRef.current) return;

    const interval = setInterval(async () => {
      if (!isStreamingRef.current || streamRef.current || !activeSessionRef.current) {
        clearInterval(interval);
        return;
      }

      try {
        const data: ChatSessionListResponse = await fetchChatSessions(projectId);
        const session = data.sessions.find((candidate) => candidate.id === activeSessionRef.current?.id);
        if (!session?.isGenerating) {
          clearInterval(interval);
          await loadMessages(activeSessionRef.current.id);
          setStreamingText("");
          setStreamingThinking("");
          setStreamingToolCalls([]);
          setIsStreaming(false);
          isStreamingRef.current = false;
          flushPendingMessage();
        }
      } catch {
        // Silently fail - will retry next interval
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [attachIfGenerating, loadMessages, projectId, activeSession, flushPendingMessage]);

  useEffect(() => {
    const unsubscribe = visibilitySuspension.onBecameVisible(() => {
      const currentSession = activeSessionRef.current;
      if (!currentSession || streamRef.current) {
        return;
      }

      const contextVersionAtStart = projectContextVersionRef.current;
      void fetchChatSession(currentSession.id, projectId)
        .then((data) => {
          if (projectContextVersionRef.current !== contextVersionAtStart || streamRef.current) {
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
            void loadMessages(currentSession.id);
          }
        })
        .catch(() => {
          // Intentionally silent for visibility reconnect path.
        });
    });

    return unsubscribe;
  }, [attachIfGenerating, loadMessages, projectId, visibilitySuspension, flushPendingMessage]);

  // SSE real-time updates
  useEffect(() => {
    const contextVersionAtStart = projectContextVersionRef.current;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;

    const handleChatSessionCreated = (e: MessageEvent) => {
      if (isStale()) return;
      const session: ChatSessionInfo = JSON.parse(e.data);
      /*
      FNXC:TaskDetailPlannerChat 2026-07-01-00:00:
      Task-planner visibility is project-settings controlled on the server. Treat any planner SSE create as a refresh hint instead of inserting it directly, so the common feed only shows populated planner sessions when the project explicitly opts in and never shows empty planner rows.
      */
      if (isTaskPlannerSession(session)) {
        if (!isEmptyTaskPlannerSession(session)) void refreshSessions();
        return;
      }
      // Avoid duplicates
      setSessions((prev) => {
        if (prev.some((s) => s.id === session.id)) return prev;
        return sortChatSessions([session, ...prev]);
      });
    };

    const handleChatSessionUpdated = (e: MessageEvent) => {
      if (isStale()) return;
      const updatedSession: ChatSessionInfo = JSON.parse(e.data);
      setSessions((prev) => {
        const updated = prev.map((s) => (s.id === updatedSession.id ? updatedSession : s));
        return sortChatSessions(updated);
      });
      // If this is the active session, update it too
      if (activeSessionRef.current?.id === updatedSession.id) {
        setActiveSession(updatedSession);
        if (updatedSession.isGenerating && !streamRef.current) {
          attachIfGenerating(updatedSession.id, updatedSession.inFlightGeneration);
        }
      }
    };

    const handleChatSessionDeleted = (e: MessageEvent) => {
      if (isStale()) return;
      const { id: sessionId }: { id: string } = JSON.parse(e.data);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      const cacheKey = getChatMessagesCacheKey(projectId, sessionId);
      if (cacheKey) {
        clearCache(cacheKey);
      }
      // If this was the active session, clear it
      if (activeSessionRef.current?.id === sessionId) {
        setActiveSession(null);
        setMessages([]);
      }
    };

    const handleChatMessageAdded = (e: MessageEvent) => {
      if (isStale()) return;
      const rawMessage = JSON.parse(e.data) as ChatMessage;
      const message = mapChatMessageToInfo(rawMessage);
      if (!sessionsRef.current.some((session) => session.id === message.sessionId)) {
        void refreshSessions();
      }

      // Skip if this message was already added via streaming completion
      // (SSE event may arrive before streaming state clears)
      if (streamingMessageIdsRef.current.has(message.id)) {
        return;
      }

      /**
       * FNXC:ChatAttachments 2026-07-12-00:00:
       * FN-7849 requires direct-chat uploaded attachments to render immediately after send. During streaming, reconcile the optimistic temp user bubble with the persisted user-message SSE echo because that echo carries the real id and attachment filenames; otherwise images/files only appear after leaving and re-entering the thread.
       */
      if (
        activeSessionRef.current?.id === message.sessionId &&
        isStreamingRef.current &&
        message.role === "user"
      ) {
        setMessages((prev) => reconcileOptimisticSentMessage(prev, message));
        return;
      }

      // Recovery mode: isStreaming is true but there's no active stream (streamRef is null).
      // This happens after a page reload/HMR when the server is still generating.
      // When the assistant message arrives via SSE, add it and clear the recovery state.
      if (
        activeSessionRef.current?.id === message.sessionId &&
        isStreamingRef.current &&
        !streamRef.current &&
        message.role === "assistant"
      ) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return sortChatMessagesChronologically([...prev, message]);
        });
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolCalls([]);
        setIsStreaming(false);
        isStreamingRef.current = false;
        flushPendingMessage();
        return;
      }

      // Only add if this is the active session AND we're not streaming
      // (during streaming, messages are managed locally to avoid duplicates)
      // Use ref to get the current value (state may not be updated yet when handler runs)
      if (activeSessionRef.current?.id === message.sessionId && !isStreamingRef.current) {
        setMessages((prev) => {
          // Avoid duplicates by persisted id first.
          if (prev.some((m) => m.id === message.id)) return prev;

          // Reconcile optimistic local user messages against persisted SSE echoes.
          // The optimistic message uses a temp id and should be replaced instead of appended.
          if (message.role === "user") {
            return reconcileOptimisticSentMessage(prev, message);
          }

          return sortChatMessagesChronologically([...prev, message]);
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
  }, [attachIfGenerating, getChatMessagesCacheKey, projectId, flushPendingMessage, refreshSessions]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      lastAttachedGenerationRef.current = null;
    };
  }, []);

  const pinnedCount = sessions.filter((session) => session.status === "active" && session.pinnedAt != null).length;

  return {
    sessions,
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    pendingMessages,
    selectSession,
    createSession,
    archiveSession,
    renameSession,
    pinSession,
    pinnedCount,
    setSessionModel,
    setSessionThinkingLevel,
    deleteSession,
    sendMessage,
    editMessageAndResend,
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
