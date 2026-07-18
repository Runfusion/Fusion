import "./MailboxModal.css";
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  X,
  Mail,
  Send,
  Inbox as InboxIcon,
  Bot,
  Trash2,
  CheckCheck,
  Loader2,
  RefreshCw,
  MessageSquare,
  User,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { Message, MessageType, ParticipantType } from "@fusion/core";
import {
  fetchInbox,
  fetchOutbox,
  fetchUnreadCount,
  fetchAgentMailbox,
  fetchAllAgentMailbox,
  markMessageRead,
  markAllMessagesRead,
  deleteMessage,
  fetchConversation,
  fetchMessage,
  type InboxResponse,
  type OutboxResponse,
  type AgentMailboxResponse,
  type AllAgentsMailboxResponse,
} from "../api";
import { MessageComposer } from "./MessageComposer";
import { MailboxMessageContent } from "./MailboxMessageContent";
import { MailboxArtifactAttachment } from "./MailboxArtifactAttachment";
import { MailboxTaskProposal } from "./MailboxTaskProposal";
import type { Agent } from "../api";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useViewportMode } from "./Header";
import { subscribeSse } from "../sse-bus";
import { readCache, SWR_CACHE_KEYS, writeCache } from "../utils/swrCache";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

// ── Types ─────────────────────────────────────────────────────────────────

type MailboxTab = "inbox" | "outbox" | "agents";

const ALL_AGENTS_MAILBOX_ID = "__all_agents__";

interface MailboxModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  addToast?: (msg: string, type?: "success" | "error") => void;
  onOpenTask?: (taskId: string) => void;
  agents?: Agent[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: string, t?: TFunction<"app">): string {
  /*
   * FNXC:RelativeTime 2026-06-17-20:48:
   * FN-6618 reuses shared bucket math while preserving MailboxModal's optional-t fallbacks, future-as-Just-now behavior, and Invalid Date fallback.
   */
  const bucket = getRelativeTimeBucket(ts);
  if (!bucket) {
    const timestampMs = Date.parse(ts);
    if (Number.isFinite(timestampMs) && Date.now() - timestampMs < 0) return t?.("mailbox.timeJustNow", "Just now") ?? "Just now";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  switch (bucket.bucket) {
    case "just-now":
      return t?.("mailbox.timeJustNow", "Just now") ?? "Just now";
    case "minutes":
      return t?.("mailbox.timeMinsAgo", "{{count}}m ago", { count: bucket.count }) ?? `${bucket.count}m ago`;
    case "hours":
      return t?.("mailbox.timeHoursAgo", "{{count}}h ago", { count: bucket.count }) ?? `${bucket.count}h ago`;
    case "days":
      return t?.("mailbox.timeDaysAgo", "{{count}}d ago", { count: bucket.count }) ?? `${bucket.count}d ago`;
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

function participantLabel(
  id: string,
  type: ParticipantType,
  agentNamesById?: ReadonlyMap<string, string>,
  t?: TFunction<"app">,
): string {
  if (type === "user") return id === "dashboard" ? (t?.("mailbox.labelYou", "You") ?? "You") : (t?.("mailbox.labelUser", "User: {{id}}", { id }) ?? `User: ${id}`);
  if (type === "agent") {
    const name = agentNamesById?.get(id)?.trim();
    if (!name || name === id) return (t?.("mailbox.labelAgent", "Agent: {{id}}", { id }) ?? `Agent: ${id}`);
    return (t?.("mailbox.labelAgentNamed", "Agent: {{name}}", { name }) ?? `Agent: ${name}`);
  }
  return t?.("mailbox.labelSystem", "System") ?? "System";
}

function messageTypeLabel(type: MessageType, t?: TFunction<"app">): string {
  switch (type) {
    case "agent-to-agent": return t?.("mailbox.typeAgentToAgent", "Agent ↔ Agent") ?? "Agent ↔ Agent";
    case "agent-to-user": return t?.("mailbox.typeAgentToUser", "Agent → You") ?? "Agent → You";
    case "user-to-agent": return t?.("mailbox.typeUserToAgent", "You → Agent") ?? "You → Agent";
    case "system": return t?.("mailbox.typeSystem", "System") ?? "System";
  }
}

function messagePreview(content: string, max = 80): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}…`;
}

function getDeepLinkedMessageId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const paramId = params.get("mailbox-message");
  if (paramId) {
    return paramId;
  }

  const hashMatch = /^#message-(.+)$/.exec(window.location.hash);
  return hashMatch?.[1] ?? null;
}

function buildReplyThread(messages: Message[], selectedMessage: Message): Message[] {
  const allMessages = [...messages];
  if (!allMessages.some((message) => message.id === selectedMessage.id)) {
    allMessages.push(selectedMessage);
  }

  const threadIds = new Set<string>([selectedMessage.id]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const message of allMessages) {
      const replyToId = message.metadata?.replyTo?.messageId;
      if (threadIds.has(message.id) && replyToId && !threadIds.has(replyToId)) {
        threadIds.add(replyToId);
        changed = true;
      }
      if (replyToId && threadIds.has(replyToId) && !threadIds.has(message.id)) {
        threadIds.add(message.id);
        changed = true;
      }
    }
  }

  return allMessages
    .filter((message) => threadIds.has(message.id))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

// ── Component ─────────────────────────────────────────────────────────────

export function MailboxModal({
  isOpen,
  onClose,
  projectId,
  addToast,
  onOpenTask,
  agents = [],
}: MailboxModalProps) {
  const { t } = useTranslation("app");
  const cacheSuffix = projectId ?? "";
  const inboxCacheKey = `${SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX}${cacheSuffix}`;
  const outboxCacheKey = `${SWR_CACHE_KEYS.MAILBOX_OUTBOX_PREFIX}${cacheSuffix}`;
  const unreadCountCacheKey = `${SWR_CACHE_KEYS.MAILBOX_UNREAD_COUNT_PREFIX}${cacheSuffix}`;
  const initialInbox = readCache<InboxResponse | null>(inboxCacheKey);
  const initialOutbox = readCache<OutboxResponse | null>(outboxCacheKey);
  const initialUnreadCount = readCache<number>(unreadCountCacheKey);

  useMobileScrollLock(isOpen);
  const [activeTab, setActiveTab] = useState<MailboxTab>("inbox");
  const [inbox, setInbox] = useState<InboxResponse | null>(() => initialInbox ?? null);
  const [outbox, setOutbox] = useState<OutboxResponse | null>(() => initialOutbox ?? null);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount ?? 0);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [conversationMessages, setConversationMessages] = useState<Message[]>([]);
  const [showComposer, setShowComposer] = useState(false);
  const [composeRecipient, setComposeRecipient] = useState<{ id: string; type: ParticipantType } | null>(null);
  const [composeReplyContext, setComposeReplyContext] = useState<{ messageId: string; preview: string } | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(ALL_AGENTS_MAILBOX_ID);
  const [agentSubTab, setAgentSubTab] = useState<"inbox" | "outbox">("inbox");
  const [agentMailbox, setAgentMailbox] = useState<AgentMailboxResponse | null>(null);
  const [allAgentsMailbox, setAllAgentsMailbox] = useState<AllAgentsMailboxResponse | null>(null);
  const [replyContextExpanded, setReplyContextExpanded] = useState<Record<string, boolean>>({});
  const [replyContextLoading, setReplyContextLoading] = useState<Record<string, boolean>>({});
  const [replyContextErrors, setReplyContextErrors] = useState<Record<string, string>>({});
  const [replyContextCache, setReplyContextCache] = useState<Map<string, Message>>(new Map());
  const consumedDeepLinkedMessageIdRef = useRef<string | null>(null);
  const highlightedDeepLinkedMessageIdRef = useRef<string | null>(null);

  /*
   * FNXC:MailboxMobile 2026-06-23-10:55:
   * Modal mailbox deep links are one-shot initializers. Once the user taps Back, changes tabs, composes, deletes, or opens another row, the URL target is stale state and must not win over the explicit mobile selection.
   */
  const consumeCurrentDeepLink = useCallback(() => {
    const deepLinkedMessageId = getDeepLinkedMessageId();
    if (deepLinkedMessageId) {
      consumedDeepLinkedMessageIdRef.current = deepLinkedMessageId;
    }
  }, []);

  const skipOpenSpinnerInboxRef = useRef(false);
  const skipOpenSpinnerOutboxRef = useRef(false);
  const agentNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      if (!agent.id) continue;
      const name = typeof agent.name === "string" ? agent.name.trim() : "";
      if (name.length > 0) {
        map.set(agent.id, name);
      }
    }
    return map;
  }, [agents]);

  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({ enabled: isMobile });
  const containerKeyboardStyle = useMemo<CSSProperties | undefined>(() => {
    if (!keyboardOpen) {
      return undefined;
    }

    return {
      "--keyboard-overlap": `${keyboardOverlap}px`,
      "--vv-offset-top": `${viewportOffsetTop}px`,
      ...(viewportHeight != null ? { "--vv-height": `${viewportHeight}px` } : {}),
    } as CSSProperties;
  }, [keyboardOpen, keyboardOverlap, viewportHeight, viewportOffsetTop]);

  // ── Data fetching ─────────────────────────────────────────────────────

  const loadInbox = useCallback(async () => {
    const shouldSkipOpenSpinner = skipOpenSpinnerInboxRef.current;
    if (!shouldSkipOpenSpinner) {
      setIsLoading(true);
    }
    skipOpenSpinnerInboxRef.current = false;
    try {
      const data = await fetchInbox({ limit: 50 }, projectId);
      setInbox(data);
      setUnreadCount(data.unreadCount);
      writeCache(
        inboxCacheKey,
        { ...data, messages: data.messages.slice(0, 100) },
        { maxBytes: 500_000 },
      );
      writeCache(unreadCountCacheKey, data.unreadCount, { maxBytes: 500_000 });
    } catch {
      // Silently fail — empty state will show
    } finally {
      setIsLoading(false);
    }
  }, [inboxCacheKey, projectId, unreadCountCacheKey]);

  const loadOutbox = useCallback(async () => {
    const shouldSkipOpenSpinner = skipOpenSpinnerOutboxRef.current;
    if (!shouldSkipOpenSpinner) {
      setIsLoading(true);
    }
    skipOpenSpinnerOutboxRef.current = false;
    try {
      const data = await fetchOutbox({ limit: 50 }, projectId);
      setOutbox(data);
      writeCache(
        outboxCacheKey,
        { ...data, messages: data.messages.slice(0, 100) },
        { maxBytes: 500_000 },
      );
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [outboxCacheKey, projectId]);

  const loadAgentMailbox = useCallback(async (agentId: string) => {
    setIsLoading(true);
    try {
      const data = await fetchAgentMailbox(agentId, projectId);
      setAgentMailbox(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const loadAllAgentsMailbox = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchAllAgentMailbox(projectId);
      setAllAgentsMailbox(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await fetchUnreadCount(projectId);
      setUnreadCount(data.unreadCount);
      writeCache(unreadCountCacheKey, data.unreadCount, { maxBytes: 500_000 });
    } catch {
      // Silently fail
    }
  }, [projectId, unreadCountCacheKey]);

  useEffect(() => {
    setInbox(readCache<InboxResponse | null>(inboxCacheKey) ?? null);
    setOutbox(readCache<OutboxResponse | null>(outboxCacheKey) ?? null);
    setUnreadCount(readCache<number>(unreadCountCacheKey) ?? 0);
  }, [inboxCacheKey, outboxCacheKey, unreadCountCacheKey]);

  useEffect(() => {
    if (!isOpen) {
      skipOpenSpinnerInboxRef.current = false;
      skipOpenSpinnerOutboxRef.current = false;
      return;
    }

    const cachedInbox = readCache<InboxResponse | null>(inboxCacheKey);
    const cachedOutbox = readCache<OutboxResponse | null>(outboxCacheKey);
    skipOpenSpinnerInboxRef.current = Boolean(cachedInbox);
    skipOpenSpinnerOutboxRef.current = Boolean(cachedOutbox);
  }, [isOpen, inboxCacheKey, outboxCacheKey]);

  // Load data on tab change
  useEffect(() => {
    if (!isOpen) return;
    if (activeTab === "inbox") loadInbox();
    else if (activeTab === "outbox") loadOutbox();
  }, [isOpen, activeTab, loadInbox, loadOutbox]);

  // Load agent mailbox when selected
  useEffect(() => {
    if (!isOpen) return;
    if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) {
      void loadAllAgentsMailbox();
      return;
    }
    void loadAgentMailbox(selectedAgentId);
  }, [isOpen, selectedAgentId, loadAgentMailbox, loadAllAgentsMailbox]);

  // Refresh unread count on open
  useEffect(() => {
    if (isOpen) refreshUnreadCount();
  }, [isOpen, refreshUnreadCount]);

  // Subscribe to mailbox SSE events while the modal is open.
  useEffect(() => {
    if (!isOpen || typeof EventSource === "undefined") {
      return;
    }

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const onMailboxUpdate = () => {
      void refreshUnreadCount();
      if (activeTab === "inbox") {
        void loadInbox();
      } else if (activeTab === "outbox") {
        void loadOutbox();
      }

      if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) {
        void loadAllAgentsMailbox();
      } else {
        void loadAgentMailbox(selectedAgentId);
      }
    };

    return subscribeSse(`/api/events${query}`, {
      events: {
        "message:sent": onMailboxUpdate,
        "message:received": onMailboxUpdate,
        "message:read": onMailboxUpdate,
        "message:deleted": onMailboxUpdate,
        "message:updated": onMailboxUpdate,
      },
    });
  }, [isOpen, projectId, activeTab, selectedAgentId, refreshUnreadCount, loadInbox, loadOutbox, loadAgentMailbox, loadAllAgentsMailbox]);

  // ── Actions ───────────────────────────────────────────────────────────

  const handleOpenMessage = useCallback(async (message: Message, source: "deep-link" | "user" = "user") => {
    if (source === "user") {
      consumeCurrentDeepLink();
    }
    setSelectedMessage(message);
    setReplyContextExpanded({});
    setReplyContextLoading({});
    setReplyContextErrors({});
    // Only auto-mark as read when viewing the dashboard user's own inbox.
    // Browsing another agent's mailbox must not consume their unread messages
    // out from under them — the agent's heartbeat is the one that reads + acks.
    if (!message.read && activeTab === "inbox") {
      try {
        const updated = await markMessageRead(message.id, projectId);
        // Update inbox state
        setInbox((prev) => {
          const next = prev
            ? {
                ...prev,
                messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)),
                unreadCount: Math.max(0, prev.unreadCount - 1),
              }
            : prev;
          if (next) {
            writeCache(inboxCacheKey, { ...next, messages: next.messages.slice(0, 100) }, { maxBytes: 500_000 });
          }
          return next;
        });
        setUnreadCount((c) => {
          const next = Math.max(0, c - 1);
          writeCache(unreadCountCacheKey, next, { maxBytes: 500_000 });
          return next;
        });
      } catch {
        // Non-critical failure marking message as read
      }
    }
    // Load conversation thread
    try {
      const conv = await fetchConversation(message.fromId, message.fromType, projectId);
      setConversationMessages(conv);
    } catch {
      setConversationMessages([message]);
    }
  }, [activeTab, inboxCacheKey, projectId, unreadCountCacheKey, consumeCurrentDeepLink]);

  // Deep-link: open and highlight a specific message from URL params.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const deepLinkedMessageId = getDeepLinkedMessageId();
    if (!deepLinkedMessageId || consumedDeepLinkedMessageIdRef.current === deepLinkedMessageId) {
      return;
    }

    const message = [
      ...(inbox?.messages ?? []),
      ...(outbox?.messages ?? []),
      ...(agentMailbox?.inbox ?? []),
      ...(agentMailbox?.outbox ?? []),
      ...(allAgentsMailbox?.messages ?? []),
      ...conversationMessages,
    ].find((candidate) => candidate.id === deepLinkedMessageId);

    if (!message) {
      return;
    }

    consumedDeepLinkedMessageIdRef.current = deepLinkedMessageId;
    void handleOpenMessage(message, "deep-link");
  }, [isOpen, inbox, outbox, agentMailbox, allAgentsMailbox, conversationMessages, handleOpenMessage]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const deepLinkedMessageId = getDeepLinkedMessageId();
    if (!deepLinkedMessageId || selectedMessage?.id !== deepLinkedMessageId || highlightedDeepLinkedMessageIdRef.current === deepLinkedMessageId) {
      return;
    }

    const element = document.getElementById(`message-${deepLinkedMessageId}`);
    if (!element) {
      return;
    }

    highlightedDeepLinkedMessageIdRef.current = deepLinkedMessageId;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.add("mailbox-message-highlight");
    const timer = window.setTimeout(() => {
      element.classList.remove("mailbox-message-highlight");
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isOpen, selectedMessage, conversationMessages]);

  const handleCloseMessage = useCallback(() => {
    consumeCurrentDeepLink();
    setSelectedMessage(null);
    setConversationMessages([]);
    setReplyContextExpanded({});
    setReplyContextLoading({});
    setReplyContextErrors({});
  }, [consumeCurrentDeepLink]);

  const handleMarkAllRead = useCallback(async () => {
    try {
      const result = await markAllMessagesRead(projectId);
      setUnreadCount(0);
      writeCache(unreadCountCacheKey, 0, { maxBytes: 500_000 });
      setInbox((prev) => {
        const next = prev
          ? {
              ...prev,
              messages: prev.messages.map((m) => ({ ...m, read: true })),
              unreadCount: 0,
            }
          : prev;
        if (next) {
          writeCache(inboxCacheKey, { ...next, messages: next.messages.slice(0, 100) }, { maxBytes: 500_000 });
        }
        return next;
      });
      addToast?.(t("mailbox.markedAsRead", "Marked {{count}} messages as read", { count: result.markedAsRead }), "success");
    } catch {
      addToast?.(t("mailbox.markReadFailed", "Failed to mark messages as read"), "error");
    }
  }, [addToast, inboxCacheKey, projectId, unreadCountCacheKey, t]);

  const handleDeleteMessage = useCallback(async (id: string) => {
    consumeCurrentDeepLink();
    try {
      await deleteMessage(id, projectId);
      setSelectedMessage(null);
      setConversationMessages([]);
      // Refresh current tab
      if (activeTab === "inbox") loadInbox();
      else if (activeTab === "outbox") loadOutbox();
      else if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) loadAllAgentsMailbox();
      else if (selectedAgentId) loadAgentMailbox(selectedAgentId);
      addToast?.(t("mailbox.messageDeleted", "Message deleted"), "success");
    } catch {
      addToast?.(t("mailbox.deleteFailed", "Failed to delete message"), "error");
    }
  }, [projectId, activeTab, selectedAgentId, loadInbox, loadOutbox, loadAgentMailbox, loadAllAgentsMailbox, addToast, t, consumeCurrentDeepLink]);

  const handleReply = useCallback((message: Message) => {
    consumeCurrentDeepLink();
    setComposeRecipient({ id: message.fromId, type: message.fromType });
    setComposeReplyContext({
      messageId: message.id,
      preview: messagePreview(message.content, 120),
    });
    setShowComposer(true);
  }, [consumeCurrentDeepLink]);

  const handleMessageSent = useCallback(() => {
    setShowComposer(false);
    setComposeRecipient(null);
    setComposeReplyContext(null);
    addToast?.(t("mailbox.messageSent", "Message sent"), "success");
    // Refresh current tab
    if (activeTab === "outbox") loadOutbox();
    else if (activeTab === "agents" && selectedAgentId === ALL_AGENTS_MAILBOX_ID) loadAllAgentsMailbox();
    else if (activeTab === "agents" && selectedAgentId) loadAgentMailbox(selectedAgentId);
  }, [activeTab, loadOutbox, selectedAgentId, loadAgentMailbox, loadAllAgentsMailbox, addToast, t]);

  const handleOpenCompose = useCallback(() => {
    consumeCurrentDeepLink();
    // Pre-fill recipient from selected agent if available
    if (activeTab === "agents" && selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID) {
      setComposeRecipient({ id: selectedAgentId, type: "agent" });
    } else {
      setComposeRecipient(null);
    }
    setComposeReplyContext(null);
    setShowComposer(true);
  }, [activeTab, selectedAgentId, consumeCurrentDeepLink]);

  const handleComposeCancel = useCallback(() => {
    consumeCurrentDeepLink();
    setShowComposer(false);
    setComposeRecipient(null);
    setComposeReplyContext(null);
  }, [consumeCurrentDeepLink]);

  const threadMessages = selectedMessage ? buildReplyThread(conversationMessages, selectedMessage) : [];

  const setReplyExpanded = (key: string, isExpanded: boolean) => {
    setReplyContextExpanded((prev) => ({ ...prev, [key]: isExpanded }));
  };

  const loadReplyMessage = async (messageId: string) => {
    const cachedMessage = replyContextCache.get(messageId);
    if (cachedMessage) {
      return cachedMessage;
    }

    setReplyContextLoading((prev) => ({ ...prev, [messageId]: true }));
    setReplyContextErrors((prev) => ({ ...prev, [messageId]: "" }));

    try {
      const message = await fetchMessage(messageId, projectId);
      setReplyContextCache((prev) => {
        const next = new Map(prev);
        next.set(messageId, message);
        return next;
      });
      return message;
    } catch {
      setReplyContextErrors((prev) => ({ ...prev, [messageId]: t("mailbox.replyLoadFailed", "Failed to load replied message. Click to retry.") }));
      return null;
    } finally {
      setReplyContextLoading((prev) => ({ ...prev, [messageId]: false }));
    }
  };

  if (!isOpen) return null;

  const ReplyContextExpandable = ({
    ownerMessageId,
    replyToId,
    initialMessage,
    ancestorIds,
    testId,
  }: {
    ownerMessageId: string;
    replyToId: string;
    initialMessage?: Message;
    ancestorIds: Set<string>;
    testId?: string;
  }) => {
    const cacheMessage = replyContextCache.get(replyToId) ?? initialMessage;
    const rowKey = `${ownerMessageId}-${replyToId}`;
    const isExpanded = Boolean(replyContextExpanded[rowKey]);
    const isLoadingReply = Boolean(replyContextLoading[replyToId]);
    const errorMessage = replyContextErrors[replyToId];
    const hasCycle = ancestorIds.has(replyToId);

    const handleToggle = async () => {
      if (isExpanded) {
        setReplyExpanded(rowKey, false);
        return;
      }
      setReplyExpanded(rowKey, true);
      if (!cacheMessage && !hasCycle) {
        await loadReplyMessage(replyToId);
      }
    };

    const nextAncestorIds = new Set(ancestorIds);
    nextAncestorIds.add(replyToId);

    return (
      <div className="mailbox-reply-context-wrapper">
        <button
          type="button"
          className="mailbox-reply-context"
          onClick={() => {
            void handleToggle();
          }}
          aria-expanded={isExpanded}
          data-testid={testId}
        >
          <span className="mailbox-reply-context__chevron" aria-hidden="true">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span>
            ↪ {t("mailbox.replyingTo", "Replying to {{preview}}", { preview: cacheMessage ? messagePreview(cacheMessage.content, 60) : `message ${replyToId}` })}
          </span>
          {isLoadingReply && <Loader2 size={14} className="spin" />}
        </button>

        {isExpanded && (
          <div className="mailbox-reply-context__nested" data-testid={`mailbox-reply-expanded-${replyToId}`}>
            {errorMessage && <div className="mailbox-reply-context__error">{errorMessage}</div>}
            {cacheMessage && (
              <>
                <div className="mailbox-conversation-msg-header">
                  <span>{participantLabel(cacheMessage.fromId, cacheMessage.fromType, agentNamesById, t)}</span>
                  <span className="mailbox-message-time">{formatTimestamp(cacheMessage.createdAt, t)}</span>
                </div>
                <div className="mailbox-conversation-msg-body">{cacheMessage.content}</div>
                {cacheMessage.metadata?.replyTo?.messageId && !nextAncestorIds.has(cacheMessage.metadata.replyTo.messageId) && (
                  <ReplyContextExpandable
                    ownerMessageId={cacheMessage.id}
                    replyToId={cacheMessage.metadata.replyTo.messageId}
                    ancestorIds={nextAncestorIds}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      data-testid="mailbox-modal-overlay"
    >
      <div className="modal modal-lg mailbox-modal" style={containerKeyboardStyle} data-testid="mailbox-modal">
        {/* Header */}
        <div className="modal-header mailbox-header">
          <div className="mailbox-title">
            <Mail size={18} />
            <span>{t("mailbox.title", "Mailbox")}</span>
            {unreadCount > 0 && (
              <span className="mailbox-unread-badge" data-testid="mailbox-unread-badge">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="mailbox-header-actions">
            <button
              className="btn btn-sm btn-primary"
              onClick={handleOpenCompose}
              title={t("mailbox.composeTitle", "Compose message")}
              data-testid="mailbox-header-compose"
            >
              <MessageSquare size={14} />
              <span>{t("mailbox.composeButton", "Compose")}</span>
            </button>
            {activeTab === "inbox" && unreadCount > 0 && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={handleMarkAllRead}
                title={t("mailbox.markAllReadTitle", "Mark all as read")}
                data-testid="mailbox-mark-all-read"
              >
                <CheckCheck size={14} />
                <span>{t("mailbox.markAllReadButton", "Mark all read")}</span>
              </button>
            )}
            <button
              className="btn-icon"
              onClick={() => {
                if (activeTab === "inbox") loadInbox();
                else if (activeTab === "outbox") loadOutbox();
                else if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) loadAllAgentsMailbox();
                else if (selectedAgentId) loadAgentMailbox(selectedAgentId);
              }}
              disabled={isLoading}
              title={t("mailbox.refreshTitle", "Refresh")}
              data-testid="mailbox-refresh"
            >
              {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>
            <button
              className="modal-close"
              onClick={onClose}
              aria-label={t("mailbox.closeAriaLabel", "Close")}
              title={t("mailbox.closeTitle", "Close")}
              data-testid="mailbox-close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mailbox-tabs" data-testid="mailbox-tabs">
          <button
            className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "inbox" ? "active" : ""}`}
            onClick={() => { consumeCurrentDeepLink(); setActiveTab("inbox"); setSelectedMessage(null); }}
            data-testid="mailbox-tab-inbox"
          >
            <InboxIcon size={14} />
            <span>{t("mailbox.inboxTab", "Inbox")}</span>
            {unreadCount > 0 && <span className="mailbox-tab-badge">{unreadCount}</span>}
          </button>
          <button
            className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "outbox" ? "active" : ""}`}
            onClick={() => { consumeCurrentDeepLink(); setActiveTab("outbox"); setSelectedMessage(null); }}
            data-testid="mailbox-tab-outbox"
          >
            <Send size={14} />
            <span>{t("mailbox.outboxTab", "Outbox")}</span>
          </button>
          <button
            className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "agents" ? "active" : ""}`}
            onClick={() => { consumeCurrentDeepLink(); setActiveTab("agents"); setSelectedMessage(null); }}
            data-testid="mailbox-tab-agents"
          >
            <Bot size={14} />
            <span>{t("mailbox.agentsTab", "Agents")}</span>
          </button>
        </div>

        {/* Content */}
        <div className="mailbox-content" data-testid="mailbox-content">
          {/* Message Detail View */}
          {selectedMessage && !showComposer && (
            <div className="mailbox-message-detail" data-testid="mailbox-message-detail" id={`message-${selectedMessage.id}`}>
              <div className="mailbox-message-detail-header">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={handleCloseMessage}
                  data-testid="mailbox-back-to-list"
                >
                  {t("mailbox.backButton", "← Back")}
                </button>
                <div className="mailbox-message-detail-meta">
                  <span className="mailbox-message-type">{messageTypeLabel(selectedMessage.type, t)}</span>
                  <span className="mailbox-message-time">{formatTimestamp(selectedMessage.createdAt, t)}</span>
                </div>
                <div className="mailbox-message-detail-actions">
                  {selectedMessage.fromType === "agent" && (
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => handleReply(selectedMessage)}
                      data-testid="mailbox-reply"
                    >
                      <MessageSquare size={14} />
                      <span>{t("mailbox.replyButton", "Reply")}</span>
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => handleDeleteMessage(selectedMessage.id)}
                    data-testid="mailbox-delete"
                  >
                    <Trash2 size={14} />
                    <span>{t("mailbox.deleteButton", "Delete")}</span>
                  </button>
                </div>
              </div>
              <div className="mailbox-message-participants">
                <div className="mailbox-participant">
                  <span className="mailbox-participant-label">{t("mailbox.fromLabel", "From:")}
</span>
                  <span className="mailbox-participant-value">
                    {selectedMessage.fromType === "agent" ? <Bot size={14} /> : <User size={14} />}
                    {participantLabel(selectedMessage.fromId, selectedMessage.fromType, agentNamesById, t)}
                  </span>
                </div>
                <div className="mailbox-participant">
                  <span className="mailbox-participant-label">{t("mailbox.toLabel", "To:")}</span>
                  <span className="mailbox-participant-value">
                    {selectedMessage.toType === "agent" ? <Bot size={14} /> : <User size={14} />}
                    {participantLabel(selectedMessage.toId, selectedMessage.toType, agentNamesById, t)}
                  </span>
                </div>
              </div>
              {/* Conversation thread */}
              {threadMessages.length > 1 && (
                <div className="mailbox-conversation" data-testid="mailbox-conversation">
                  <div className="mailbox-conversation-label">{t("mailbox.conversationLabel", "Conversation")}</div>
                  {threadMessages.map((msg) => {
                    const replyToId = msg.metadata?.replyTo?.messageId;
                    const replyToMessage = replyToId
                      ? threadMessages.find((candidate) => candidate.id === replyToId)
                      : undefined;

                    return (
                      <div
                        key={msg.id}
                        id={`message-${msg.id}`}
                        className={`mailbox-conversation-msg ${msg.id === selectedMessage.id ? "current" : ""}`}
                      >
                        <div className="mailbox-conversation-msg-header">
                          <span>{participantLabel(msg.fromId, msg.fromType, agentNamesById, t)}</span>
                          <span className="mailbox-message-time">{formatTimestamp(msg.createdAt, t)}</span>
                        </div>
                        {replyToId && (
                          <ReplyContextExpandable
                            ownerMessageId={msg.id}
                            replyToId={replyToId}
                            initialMessage={replyToMessage}
                            ancestorIds={new Set([msg.id])}
                            testId={`mailbox-reply-context-${msg.id}`}
                          />
                        )}
                        <MailboxMessageContent
                          content={msg.content}
                          className="mailbox-conversation-msg-body"
                        />
                        <MailboxArtifactAttachment
                          artifactId={msg.metadata?.artifactId}
                          artifactType={msg.metadata?.artifactType}
                          title={msg.metadata?.title}
                          mimeType={msg.metadata?.mimeType}
                          projectId={projectId}
                          taskId={msg.metadata?.taskId}
                          onOpenTask={onOpenTask}
                        />
                        <MailboxTaskProposal messageId={msg.id} metadata={msg.metadata} projectId={projectId} onOpenTask={onOpenTask} />
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Full message content */}
              {(threadMessages.length <= 1) && (
                <>
                  {selectedMessage.metadata?.replyTo?.messageId && (
                    <ReplyContextExpandable
                      ownerMessageId={selectedMessage.id}
                      replyToId={selectedMessage.metadata.replyTo.messageId}
                      initialMessage={threadMessages.find((candidate) => candidate.id === selectedMessage.metadata?.replyTo?.messageId)}
                      ancestorIds={new Set([selectedMessage.id])}
                      testId="mailbox-selected-reply-context"
                    />
                  )}
                  <MailboxMessageContent
                    content={selectedMessage.content}
                    className="mailbox-message-body"
                    testId="mailbox-message-body"
                  />
                  <MailboxArtifactAttachment
                    artifactId={selectedMessage.metadata?.artifactId}
                    artifactType={selectedMessage.metadata?.artifactType}
                    title={selectedMessage.metadata?.title}
                    mimeType={selectedMessage.metadata?.mimeType}
                    projectId={projectId}
                    taskId={selectedMessage.metadata?.taskId}
                    onOpenTask={onOpenTask}
                  />
                  <MailboxTaskProposal messageId={selectedMessage.id} metadata={selectedMessage.metadata} projectId={projectId} onOpenTask={onOpenTask} />
                </>
              )}
            </div>
          )}

          {/* Message Composer */}
          {showComposer && (
            <MessageComposer
              recipient={composeRecipient}
              replyContext={composeReplyContext}
              agents={agents}
              projectId={projectId}
              onSend={handleMessageSent}
              onCancel={handleComposeCancel}
              addToast={addToast}
            />
          )}

          {/* Tab Content — message lists */}
          {!selectedMessage && !showComposer && (
            <>
              {/* Inbox Tab */}
              {activeTab === "inbox" && (
                <div className="mailbox-list" data-testid="mailbox-inbox-list">
                  {isLoading && !inbox && <MailboxSkeleton />}
                  {inbox && inbox.messages.length === 0 && (
                    <div className="mailbox-empty" data-testid="mailbox-inbox-empty">
                      <InboxIcon size={32} />
                      <p>{t("mailbox.noInbox", "No messages in your inbox")}</p>
                    </div>
                  )}
                  {inbox?.messages.map((msg) => (
                    <div
                      key={msg.id}
                      id={`message-${msg.id}`}
                      className={`mailbox-item ${!msg.read ? "unread" : ""}`}
                      onClick={() => handleOpenMessage(msg)}
                      data-testid={`mailbox-item-${msg.id}`}
                    >
                      <div className="mailbox-item-avatar">
                        {msg.fromType === "agent" ? <Bot size={16} /> : <User size={16} />}
                      </div>
                      <div className="mailbox-item-content">
                        <div className="mailbox-item-header">
                          <span className="mailbox-item-from">
                            {participantLabel(msg.fromId, msg.fromType, agentNamesById, t)}
                          </span>
                          <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                        </div>
                        <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                      </div>
                      {!msg.read && <div className="mailbox-item-unread-dot" data-testid={`mailbox-unread-dot-${msg.id}`} />}
                    </div>
                  ))}
                </div>
              )}

              {/* Outbox Tab */}
              {activeTab === "outbox" && (
                <div className="mailbox-list" data-testid="mailbox-outbox-list">
                  {isLoading && !outbox && <MailboxSkeleton />}
                  {outbox && outbox.messages.length === 0 && (
                    <div className="mailbox-empty" data-testid="mailbox-outbox-empty">
                      <Send size={32} />
                      <p>{t("mailbox.noOutbox", "No sent messages")}</p>
                    </div>
                  )}
                  {outbox?.messages.map((msg) => (
                    <div
                      key={msg.id}
                      id={`message-${msg.id}`}
                      className="mailbox-item"
                      onClick={() => handleOpenMessage(msg)}
                      data-testid={`mailbox-item-${msg.id}`}
                    >
                      <div className="mailbox-item-avatar">
                        {msg.toType === "agent" ? <Bot size={16} /> : <User size={16} />}
                      </div>
                      <div className="mailbox-item-content">
                        <div className="mailbox-item-header">
                          <span className="mailbox-item-to">
                            {t("mailbox.toPrefix", "To: {{recipient}}", { recipient: participantLabel(msg.toId, msg.toType, agentNamesById, t) })}
                          </span>
                          <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                        </div>
                        <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Agent Mailboxes Tab */}
              {activeTab === "agents" && (
                <div className="mailbox-agents" data-testid="mailbox-agents">
                  {agents.length === 0 ? (
                    <div className="mailbox-empty">
                      <Bot size={32} />
                      <p>{t("mailbox.noAgents", "No agents found")}</p>
                    </div>
                  ) : (
                    <>
                      <div className="mailbox-agents-header">
                        <div className="mailbox-agents-dropdown">
                          <select
                            className="message-composer-select mailbox-agent-select"
                            value={selectedAgentId}
                            onChange={(e) => { consumeCurrentDeepLink(); setSelectedAgentId(e.target.value); setAgentSubTab("inbox"); setSelectedMessage(null); }}
                            data-testid="mailbox-agent-select"
                          >
                            <option value={ALL_AGENTS_MAILBOX_ID}>{t("mailbox.allAgentsOption", "All agents")}</option>
                            {agents.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name || agent.id}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          className="btn btn-sm btn-secondary mailbox-compose-btn"
                          onClick={handleOpenCompose}
                          data-testid="mailbox-compose-btn"
                        >
                          <MessageSquare size={14} />
                          <span>{t("mailbox.composeButton", "Compose")}</span>
                        </button>
                      </div>

                      {/* Agent Sub-Tabs (Inbox/Outbox) */}
                      {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && (
                        <div className="mailbox-agent-subtabs" data-testid="mailbox-agent-subtabs">
                          <button
                            className={`btn btn-sm btn-secondary mailbox-agent-subtab ${agentSubTab === "inbox" ? "active" : ""}`}
                            onClick={() => { consumeCurrentDeepLink(); setAgentSubTab("inbox"); setSelectedMessage(null); }}
                            data-testid="mailbox-agent-subtab-inbox"
                          >
                            <InboxIcon size={12} />
                            <span>{t("mailbox.inboxTab", "Inbox")}</span>
                            {agentMailbox && agentMailbox.unreadCount > 0 && (
                              <span className="mailbox-tab-badge">{agentMailbox.unreadCount}</span>
                            )}
                          </button>
                          <button
                            className={`btn btn-sm btn-secondary mailbox-agent-subtab ${agentSubTab === "outbox" ? "active" : ""}`}
                            onClick={() => { consumeCurrentDeepLink(); setAgentSubTab("outbox"); setSelectedMessage(null); }}
                            data-testid="mailbox-agent-subtab-outbox"
                          >
                            <Send size={12} />
                            <span>{t("mailbox.outboxTab", "Outbox")}</span>
                          </button>
                        </div>
                      )}
                      <div className="mailbox-agents-content">
                        {selectedAgentId === ALL_AGENTS_MAILBOX_ID && isLoading && !allAgentsMailbox && <MailboxSkeleton />}
                        {selectedAgentId === ALL_AGENTS_MAILBOX_ID && allAgentsMailbox && allAgentsMailbox.messages.length === 0 && (
                          <div className="mailbox-empty">
                            <InboxIcon size={32} />
                            <p>{t("mailbox.noAgentMessages", "No agent-to-agent messages")}</p>
                          </div>
                        )}
                        {selectedAgentId === ALL_AGENTS_MAILBOX_ID && allAgentsMailbox && allAgentsMailbox.messages.map((msg) => (
                          <div
                            key={msg.id}
                            id={`message-${msg.id}`}
                            className={`mailbox-item ${!msg.read ? "unread" : ""}`}
                            onClick={() => handleOpenMessage(msg)}
                            data-testid={`mailbox-item-${msg.id}`}
                          >
                            <div className="mailbox-item-avatar">
                              {msg.fromType === "agent" ? <Bot size={16} /> : <User size={16} />}
                            </div>
                            <div className="mailbox-item-content">
                              <div className="mailbox-item-header">
                                <span className="mailbox-item-from">
                                  {participantLabel(msg.fromId, msg.fromType, agentNamesById, t)}
                                </span>
                                <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                              </div>
                              <div className="mailbox-item-participants" data-testid={`mailbox-item-participants-${msg.id}`}>
                                <span>{t("mailbox.fromPrefix", "From: {{participant}}", { participant: participantLabel(msg.fromId, msg.fromType, agentNamesById, t) })}</span>
                                <span>{t("mailbox.toPrefix", "To: {{recipient}}", { recipient: participantLabel(msg.toId, msg.toType, agentNamesById, t) })}</span>
                              </div>
                              <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                            </div>
                            {!msg.read && <div className="mailbox-item-unread-dot" data-testid={`mailbox-unread-dot-${msg.id}`} />}
                          </div>
                        ))}
                        {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && isLoading && !agentMailbox && <MailboxSkeleton />}
                        {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && agentMailbox && agentSubTab === "inbox" && agentMailbox.inbox.length === 0 && (
                          <div className="mailbox-empty">
                            <InboxIcon size={32} />
                            <p>{t("mailbox.noReceivedMessages", "No received messages for this agent")}</p>
                          </div>
                        )}
                        {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && agentMailbox && agentSubTab === "outbox" && agentMailbox.outbox.length === 0 && (
                          <div className="mailbox-empty">
                            <Send size={32} />
                            <p>{t("mailbox.noSentMessages", "No sent messages for this agent")}</p>
                          </div>
                        )}
                        {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && agentMailbox && agentSubTab === "inbox" && agentMailbox.inbox.map((msg) => (
                          <div
                            key={msg.id}
                            id={`message-${msg.id}`}
                            className={`mailbox-item ${!msg.read ? "unread" : ""}`}
                            onClick={() => handleOpenMessage(msg)}
                            data-testid={`mailbox-item-${msg.id}`}
                          >
                            <div className="mailbox-item-avatar">
                              {msg.fromType === "agent" ? <Bot size={16} /> : <User size={16} />}
                            </div>
                            <div className="mailbox-item-content">
                              <div className="mailbox-item-header">
                                <span className="mailbox-item-from">
                                  {participantLabel(msg.fromId, msg.fromType, agentNamesById, t)}
                                </span>
                                <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                              </div>
                              <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                            </div>
                          </div>
                        ))}
                        {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && agentMailbox && agentSubTab === "outbox" && agentMailbox.outbox.map((msg) => (
                          <div
                            key={msg.id}
                            id={`message-${msg.id}`}
                            className="mailbox-item"
                            onClick={() => handleOpenMessage(msg)}
                            data-testid={`mailbox-item-${msg.id}`}
                          >
                            <div className="mailbox-item-avatar">
                              {msg.toType === "agent" ? <Bot size={16} /> : <User size={16} />}
                            </div>
                            <div className="mailbox-item-content">
                              <div className="mailbox-item-header">
                                <span className="mailbox-item-to">
                                  {t("mailbox.toPrefix", "To: {{recipient}}", { recipient: participantLabel(msg.toId, msg.toType, agentNamesById, t) })}
                                </span>
                                <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                              </div>
                              <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────

function MailboxSkeleton() {
  return (
    <div className="mailbox-skeleton" data-testid="mailbox-skeleton">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="mailbox-skeleton-item">
          <div className="mailbox-skeleton-avatar" />
          <div className="mailbox-skeleton-content">
            <div className="mailbox-skeleton-line mailbox-skeleton-line--short" />
            <div className="mailbox-skeleton-line mailbox-skeleton-line--long" />
          </div>
        </div>
      ))}
    </div>
  );
}
