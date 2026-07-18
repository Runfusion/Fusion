import "./MailboxModal.css";
import { useState, useEffect, useCallback, useContext, useMemo, useRef, type CSSProperties } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
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
  fetchAgents,
  fetchApprovals,
  fetchApprovalDetail,
  decideApproval,
  type InboxResponse,
  type OutboxResponse,
  type AgentMailboxResponse,
  type AllAgentsMailboxResponse,
  type Agent,
  type ApprovalRequestSummary,
  type ApprovalRequestDetail,
} from "../api";
import { MailboxMessageContent } from "./MailboxMessageContent";
import { MailboxArtifactAttachment } from "./MailboxArtifactAttachment";
import { MailboxTaskProposal } from "./MailboxTaskProposal";
import { MessageComposer } from "./MessageComposer";
import { ViewHeader } from "./ViewHeader";
import { WorktrunkInstallApprovalDetails } from "./WorktrunkInstallApprovalDetails";
import { GatedActionApprovalDetails } from "./GatedActionApprovalDetails";
import { subscribeSse } from "../sse-bus";
import { useViewportMode } from "../hooks/useViewportMode";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { NavigationHistoryContext } from "../hooks/useNavigationHistory";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

// ── Types ─────────────────────────────────────────────────────────────────

type MailboxTab = "inbox" | "outbox" | "agents" | "approvals";

interface MailboxViewProps {
  projectId?: string;
  addToast?: (msg: string, type?: "success" | "error") => void;
  onOpenTask?: (taskId: string) => void;
  /** Callback when unread count changes (for header badge updates) */
  onUnreadCountChange?: (count: number) => void;
}

const ALL_AGENTS_MAILBOX_ID = "__all_agents__";

/*
FNXC:Mailbox 2026-06-22-16:00:
The mailbox message-list pane defaults narrow and can be dragged narrower than before. Lowered min 280->180 and default 320->220 so the conversation list takes less horizontal room by default while the active-message pane gets more; users can still widen via the resize handle (persisted per project).
*/
const MAILBOX_SIDEBAR_MIN_WIDTH = 180;
const MAILBOX_SIDEBAR_MAX_RATIO = 0.65;
const MAILBOX_SIDEBAR_KEYBOARD_STEP = 16;
const MAILBOX_SIDEBAR_DEFAULT_WIDTH = 220;

function getMailboxSidebarMaxWidth(containerWidth: number): number {
  return Math.max(MAILBOX_SIDEBAR_MIN_WIDTH, containerWidth * MAILBOX_SIDEBAR_MAX_RATIO);
}

function clampMailboxSidebarWidth(width: number, containerWidth: number): number {
  const maxWidth = getMailboxSidebarMaxWidth(containerWidth);
  return Math.min(Math.max(width, MAILBOX_SIDEBAR_MIN_WIDTH), maxWidth);
}

function readMailboxSidebarWidth(projectId?: string): number {
  try {
    const saved = getScopedItem("kb-dashboard-mailbox-sidebar-width", projectId);
    if (!saved) return MAILBOX_SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number(saved);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // Invalid localStorage data - fall through to default
  }

  return MAILBOX_SIDEBAR_DEFAULT_WIDTH;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: string, t?: TFunction<"app">): string {
  /*
   * FNXC:RelativeTime 2026-06-17-20:48:
   * FN-6618 shares bucket math while preserving MailboxView's composed count + mailbox.ago i18n shape, future-as-Just-now behavior, and Invalid Date fallback.
   */
  const bucket = getRelativeTimeBucket(ts);
  if (!bucket) {
    const timestampMs = Date.parse(ts);
    if (Number.isFinite(timestampMs) && Date.now() - timestampMs < 0) return t ? t("mailbox.justNow", "Just now") : "Just now";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  switch (bucket.bucket) {
    case "just-now":
      return t ? t("mailbox.justNow", "Just now") : "Just now";
    case "minutes":
      return `${bucket.count}m ${t ? t("mailbox.ago", "ago") : "ago"}`;
    case "hours":
      return `${bucket.count}h ${t ? t("mailbox.ago", "ago") : "ago"}`;
    case "days":
      return `${bucket.count}d ${t ? t("mailbox.ago", "ago") : "ago"}`;
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
  if (type === "user") return id === "dashboard" ? (t ? t("mailbox.you", "You") : "You") : `${t ? t("mailbox.user", "User") : "User"}: ${id}`;
  if (type === "agent") {
    const name = agentNamesById?.get(id)?.trim();
    if (!name) return `${t ? t("mailbox.agent", "Agent") : "Agent"}: ${id}`;
    if (name === id) return `${t ? t("mailbox.agent", "Agent") : "Agent"}: ${id}`;
    return `${t ? t("mailbox.agent", "Agent") : "Agent"}: ${name} (${id})`;
  }
  return t ? t("mailbox.system", "System") : "System";
}

function messageTypeLabel(type: MessageType): string {
  switch (type) {
    case "agent-to-agent": return "Agent ↔ Agent";
    case "agent-to-user": return "Agent → You";
    case "user-to-agent": return "You → Agent";
    case "system": return "System";
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

function listMessageAnchorId(messageId: string): string {
  return `mailbox-list-message-${messageId}`;
}

function detailMessageAnchorId(messageId: string): string {
  return `mailbox-detail-message-${messageId}`;
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

export function MailboxView({
  projectId,
  addToast,
  onOpenTask,
  onUnreadCountChange,
}: MailboxViewProps) {
  const { t } = useTranslation("app");
  const [activeTab, setActiveTab] = useState<MailboxTab>("inbox");
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [outbox, setOutbox] = useState<OutboxResponse | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [approvalSubTab, setApprovalSubTab] = useState<"pending" | "history">("pending");
  const [approvals, setApprovals] = useState<ApprovalRequestSummary[]>([]);
  const [approvalPendingCount, setApprovalPendingCount] = useState(0);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalRequestDetail | null>(null);
  const [approvalComment, setApprovalComment] = useState("");
  const [approvalDecisionLoading, setApprovalDecisionLoading] = useState<false | "approve" | "deny">(false);
  const consumedDeepLinkedMessageIdRef = useRef<string | null>(null);
  const highlightedDeepLinkedMessageIdRef = useRef<string | null>(null);

  /*
   * FNXC:MailboxMobile 2026-06-23-10:55:
   * URL mailbox deep links initialize one message selection for reload/share flows, but mobile Back, tab switches, compose/delete/approval actions, and direct row clicks are explicit user navigation. Consume the current URL target before those actions so refresh or conversation effects cannot restore an older message over the user's chosen row.
   */
  const consumeCurrentDeepLink = useCallback(() => {
    const deepLinkedMessageId = getDeepLinkedMessageId();
    if (deepLinkedMessageId) {
      consumedDeepLinkedMessageIdRef.current = deepLinkedMessageId;
    }
  }, []);

  const agentNamesById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name ?? ""])),
    [agents],
  );
  const getParticipantLabel = useCallback(
    (id: string, type: ParticipantType) => participantLabel(id, type, agentNamesById, t),
    [agentNamesById, t],
  );
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const navigationHistory = useContext(NavigationHistoryContext);
  const isSplitPane = !isMobile;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readMailboxSidebarWidth(projectId));
  const splitLayoutRef = useRef<HTMLDivElement>(null);
  const mailboxContentRef = useRef<HTMLDivElement>(null);
  /*
  FNXC:Mailbox 2026-06-22-18:05:
  Teardown ref for the pointer-driven divider drag. The pointer move/up/cancel listeners and the captured pointer must be released exactly once on pointerup, pointercancel, or unmount; storing the cleanup here guarantees we never leak a global listener or a stuck pointer capture if the component unmounts mid-drag.
  */
  const splitResizeTeardownRef = useRef<(() => void) | null>(null);
  const pendingScrollTopRef = useRef<number | null>(null);
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

  useEffect(() => {
    setSidebarWidth(readMailboxSidebarWidth(projectId));
  }, [projectId]);

  useEffect(() => {
    if (!isSplitPane) return;
    const containerWidth = splitLayoutRef.current?.clientWidth;
    if (!containerWidth) return;

    setSidebarWidth((current) => clampMailboxSidebarWidth(current, containerWidth));
  }, [isSplitPane]);

  useEffect(() => {
    if (!isSplitPane) return;
    try {
      setScopedItem("kb-dashboard-mailbox-sidebar-width", String(sidebarWidth), projectId);
    } catch {
      // localStorage persistence is best-effort.
    }
  }, [isSplitPane, projectId, sidebarWidth]);

  /*
  FNXC:Mailbox 2026-06-22-18:05:
  Divider drag uses pointer events + setPointerCapture so the drag keeps tracking even when the cursor leaves the thin handle. Each move maps the pointer's X to a list-pane width relative to the split-layout left edge, clamped to [MIN, container * MAX_RATIO]. setSidebarWidth feeds the pane's inline `width`, which the flex row now honors, so the resize is live; the existing persistence effect writes the final width to scoped storage. The teardown (release capture + remove listeners) runs once on pointerup/pointercancel and is parked in splitResizeTeardownRef for unmount safety.
  */
  const handleSplitResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isSplitPane) return;
    event.preventDefault();
    const container = splitLayoutRef.current;
    if (!container) return;

    splitResizeTeardownRef.current?.();

    const handle = event.currentTarget;
    const rect = container.getBoundingClientRect();
    const pointerId = event.pointerId;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const proposedWidth = moveEvent.clientX - rect.left;
      setSidebarWidth(clampMailboxSidebarWidth(proposedWidth, rect.width));
    };

    const teardown = () => {
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", teardown);
      handle.removeEventListener("pointercancel", teardown);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may already be released; ignore.
      }
      splitResizeTeardownRef.current = null;
    };

    splitResizeTeardownRef.current = teardown;

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // setPointerCapture can throw in non-DOM test environments; drag still works via listeners.
    }
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", teardown);
    handle.addEventListener("pointercancel", teardown);
  }, [isSplitPane]);

  useEffect(() => () => {
    splitResizeTeardownRef.current?.();
  }, []);

  const handleSplitResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isSplitPane) return;
    const measuredWidth = splitLayoutRef.current?.clientWidth ?? 0;
    const fallbackWidth = sidebarWidth / MAILBOX_SIDEBAR_MAX_RATIO + MAILBOX_SIDEBAR_KEYBOARD_STEP;
    const containerWidth = Math.max(measuredWidth, fallbackWidth);

    const maxWidth = getMailboxSidebarMaxWidth(containerWidth);

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -MAILBOX_SIDEBAR_KEYBOARD_STEP : MAILBOX_SIDEBAR_KEYBOARD_STEP;
      setSidebarWidth((current) => clampMailboxSidebarWidth(current + delta, containerWidth));
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MAILBOX_SIDEBAR_MIN_WIDTH);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(maxWidth);
    }
  }, [isSplitPane, sidebarWidth]);

  const captureMailboxScroll = useCallback(() => {
    if (!isMobile) {
      return;
    }

    const content = mailboxContentRef.current;
    if (!content) {
      return;
    }

    pendingScrollTopRef.current = content.scrollTop;
  }, [isMobile]);

  const restoreMailboxScroll = useCallback(() => {
    const scrollTop = pendingScrollTopRef.current;
    if (scrollTop === null) {
      return;
    }

    const restore = () => {
      const content = mailboxContentRef.current;
      if (content) {
        content.scrollTop = scrollTop;
      }
      pendingScrollTopRef.current = null;
    };

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(restore);
      return;
    }

    restore();
  }, []);

  // ── Data fetching ─────────────────────────────────────────────────────

  const loadInbox = useCallback(async () => {
    captureMailboxScroll();
    setIsLoading(true);
    try {
      const data = await fetchInbox({ limit: 50 }, projectId);
      setInbox(data);
      setUnreadCount(data.unreadCount);
      onUnreadCountChange?.(data.unreadCount);
    } catch {
      // Silently fail — empty state will show
    } finally {
      setIsLoading(false);
    }
  }, [projectId, onUnreadCountChange, captureMailboxScroll]);

  const loadOutbox = useCallback(async () => {
    captureMailboxScroll();
    setIsLoading(true);
    try {
      const data = await fetchOutbox({ limit: 50 }, projectId);
      setOutbox(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId, captureMailboxScroll]);

  const loadAgentMailbox = useCallback(async (agentId: string) => {
    captureMailboxScroll();
    setIsLoading(true);
    try {
      const data = await fetchAgentMailbox(agentId, projectId);
      setAgentMailbox(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId, captureMailboxScroll]);

  const loadAllAgentsMailbox = useCallback(async () => {
    captureMailboxScroll();
    setIsLoading(true);
    try {
      const data = await fetchAllAgentMailbox(projectId);
      setAllAgentsMailbox(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId, captureMailboxScroll]);

  useEffect(() => {
    restoreMailboxScroll();
  }, [inbox, outbox, agentMailbox, allAgentsMailbox, approvals, selectedApproval, restoreMailboxScroll]);

  const loadAgents = useCallback(async () => {
    try {
      const data = await fetchAgents(undefined, projectId);
      setAgents(data);
    } catch {
      // Silently fail
    }
  }, [projectId]);

  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await fetchUnreadCount(projectId);
      setUnreadCount(data.unreadCount);
      setApprovalPendingCount(data.pendingApprovalCount ?? 0);
      onUnreadCountChange?.(data.unreadCount);
    } catch {
      // Silently fail
    }
  }, [projectId, onUnreadCountChange]);

  const loadApprovals = useCallback(async (status: "pending" | "history") => {
    captureMailboxScroll();
    setIsLoading(true);
    try {
      const list = await fetchApprovals({ status: status === "pending" ? "pending" : undefined, limit: 100 }, projectId);
      if (status === "pending") {
        setApprovals(list.requests);
      } else {
        const [approved, denied, completed] = await Promise.all([
          fetchApprovals({ status: "approved", limit: 100 }, projectId),
          fetchApprovals({ status: "denied", limit: 100 }, projectId),
          fetchApprovals({ status: "completed", limit: 100 }, projectId),
        ]);
        setApprovals([...approved.requests, ...denied.requests, ...completed.requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
      setApprovalPendingCount(list.pendingCount);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId, captureMailboxScroll]);

  // Load data on tab change
  useEffect(() => {
    if (activeTab === "inbox") loadInbox();
    else if (activeTab === "outbox") loadOutbox();
    else if (activeTab === "agents") loadAgents();
    else if (activeTab === "approvals") {
      void loadApprovals(approvalSubTab);
    }
  }, [activeTab, loadInbox, loadOutbox, loadAgents, loadApprovals, approvalSubTab]);

  // Load agent mailbox when selected
  useEffect(() => {
    if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) {
      void loadAllAgentsMailbox();
      return;
    }
    void loadAgentMailbox(selectedAgentId);
  }, [selectedAgentId, loadAgentMailbox, loadAllAgentsMailbox]);

  // Load unread count on mount
  useEffect(() => {
    refreshUnreadCount();
  }, [refreshUnreadCount]);

  // Load agents on mount so they're available for compose from any tab (not just agents tab)
  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Subscribe to mailbox SSE events for near-real-time refresh.
  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return;
    }

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const onMailboxUpdate = () => {
      void refreshUnreadCount();
      if (activeTab === "inbox") {
        void loadInbox();
      } else if (activeTab === "outbox") {
        void loadOutbox();
      } else if (activeTab === "approvals") {
        void loadApprovals(approvalSubTab);
      }

      if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) {
        void loadAllAgentsMailbox();
      } else if (selectedAgentId) {
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
        "approval:requested": onMailboxUpdate,
        "approval:updated": onMailboxUpdate,
        "approval:decided": onMailboxUpdate,
      },
    });
  }, [projectId, activeTab, selectedAgentId, refreshUnreadCount, loadInbox, loadOutbox, loadAgentMailbox, loadAllAgentsMailbox, loadApprovals, approvalSubTab]);

  // ── Actions ───────────────────────────────────────────────────────────

  const handleOpenMessage = useCallback(async (message: Message, source: "deep-link" | "user" = "user") => {
    if (source === "user") {
      consumeCurrentDeepLink();
    }
    setSelectedMessage(message);
    // Only auto-mark as read when viewing the dashboard user's own inbox.
    // Browsing another agent's mailbox must not consume their unread messages
    // out from under them — the agent's heartbeat is the one that reads + acks.
    if (!message.read && activeTab === "inbox") {
      try {
        const updated = await markMessageRead(message.id, projectId);
        // Update inbox state
        if (updated) {
          setInbox((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)),
                  unreadCount: Math.max(0, prev.unreadCount - 1),
                }
              : prev,
          );
        }
        const newCount = Math.max(0, unreadCount - 1);
        setUnreadCount(newCount);
        onUnreadCountChange?.(newCount);
      } catch {
        // Non-critical
      }
    }
    // Load conversation thread
    try {
      const conv = await fetchConversation(message.fromId, message.fromType, projectId);
      setConversationMessages(conv);
    } catch {
      setConversationMessages([message]);
    }
  }, [projectId, unreadCount, onUnreadCountChange, activeTab, consumeCurrentDeepLink]);

  // Deep-link: open and highlight a specific message from URL params.
  useEffect(() => {
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
  }, [inbox, outbox, agentMailbox, allAgentsMailbox, conversationMessages, handleOpenMessage]);
  useEffect(() => {
    const deepLinkedMessageId = getDeepLinkedMessageId();
    if (!deepLinkedMessageId || selectedMessage?.id !== deepLinkedMessageId || highlightedDeepLinkedMessageIdRef.current === deepLinkedMessageId) {
      return;
    }

    const element = document.getElementById(detailMessageAnchorId(deepLinkedMessageId));
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
  }, [selectedMessage, conversationMessages]);

  const handleCloseMessage = useCallback(() => {
    consumeCurrentDeepLink();
    setSelectedMessage(null);
    setConversationMessages([]);
  }, [consumeCurrentDeepLink]);

  const dismissMessage = useCallback(() => {
    navigationHistory?.removeNav(handleCloseMessage);
    handleCloseMessage();
  }, [handleCloseMessage, navigationHistory]);

  const handleMarkAllRead = useCallback(async () => {
    try {
      const result = await markAllMessagesRead(projectId);
      setUnreadCount(0);
      onUnreadCountChange?.(0);
      setInbox((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.map((m) => ({ ...m, read: true })),
              unreadCount: 0,
            }
          : prev,
      );
      addToast?.(`Marked ${result.markedAsRead} messages as read`, "success");
    } catch {
      addToast?.("Failed to mark messages as read", "error");
    }
  }, [projectId, addToast, onUnreadCountChange]);

  const handleDeleteMessage = useCallback(async (id: string) => {
    consumeCurrentDeepLink();
    try {
      await deleteMessage(id, projectId);
      dismissMessage();
      // Refresh current tab
      if (activeTab === "inbox") loadInbox();
      else if (activeTab === "outbox") loadOutbox();
      else if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) loadAllAgentsMailbox();
      else if (selectedAgentId) loadAgentMailbox(selectedAgentId);
      addToast?.("Message deleted", "success");
    } catch {
      addToast?.("Failed to delete message", "error");
    }
  }, [projectId, activeTab, selectedAgentId, loadInbox, loadOutbox, loadAgentMailbox, loadAllAgentsMailbox, addToast, consumeCurrentDeepLink, dismissMessage]);

  const handleReply = useCallback((message: Message) => {
    dismissMessage();
    setComposeRecipient({ id: message.fromId, type: message.fromType });
    setComposeReplyContext({
      messageId: message.id,
      preview: messagePreview(message.content, 120),
    });
    setShowComposer(true);
  }, [dismissMessage]);

  const handleCloseComposer = useCallback(() => {
    consumeCurrentDeepLink();
    setShowComposer(false);
    setComposeRecipient(null);
    setComposeReplyContext(null);
  }, [consumeCurrentDeepLink]);

  const dismissComposer = useCallback(() => {
    navigationHistory?.removeNav(handleCloseComposer);
    handleCloseComposer();
  }, [handleCloseComposer, navigationHistory]);

  const handleMessageSent = useCallback(() => {
    dismissComposer();
    addToast?.("Message sent", "success");
    // Refresh current tab
    if (activeTab === "outbox") loadOutbox();
    else if (activeTab === "agents" && selectedAgentId === ALL_AGENTS_MAILBOX_ID) loadAllAgentsMailbox();
    else if (activeTab === "agents" && selectedAgentId) loadAgentMailbox(selectedAgentId);
    refreshUnreadCount();
  }, [activeTab, loadOutbox, selectedAgentId, loadAgentMailbox, loadAllAgentsMailbox, addToast, refreshUnreadCount, dismissComposer]);

  const handleOpenCompose = useCallback(() => {
    if (isMobile && selectedMessage) {
      dismissMessage();
    }
    consumeCurrentDeepLink();
    // Pre-fill recipient from selected agent if available
    if (activeTab === "agents" && selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID) {
      setComposeRecipient({ id: selectedAgentId, type: "agent" });
    } else {
      setComposeRecipient(null);
    }
    setComposeReplyContext(null);
    setShowComposer(true);
  }, [activeTab, selectedAgentId, consumeCurrentDeepLink, dismissMessage, isMobile, selectedMessage]);

  const handleComposeCancel = dismissComposer;

  const handleOpenApproval = useCallback(async (request: ApprovalRequestSummary) => {
    consumeCurrentDeepLink();
    try {
      const detail = await fetchApprovalDetail(request.id, projectId);
      setSelectedApproval(detail);
      setApprovalComment("");
    } catch {
      addToast?.("Failed to load approval request", "error");
    }
  }, [projectId, addToast, consumeCurrentDeepLink]);

  const handleCloseApproval = useCallback(() => {
    setSelectedApproval(null);
  }, []);

  const dismissApproval = useCallback(() => {
    navigationHistory?.removeNav(handleCloseApproval);
    handleCloseApproval();
  }, [handleCloseApproval, navigationHistory]);

  const handleApprovalDecision = useCallback(async (decision: "approve" | "deny") => {
    if (!selectedApproval || approvalDecisionLoading) return;
    setApprovalDecisionLoading(decision);
    try {
      await decideApproval(selectedApproval.id, { decision, comment: approvalComment || undefined }, projectId);
      await loadApprovals(approvalSubTab);
      const updated = await fetchApprovalDetail(selectedApproval.id, projectId);
      setSelectedApproval(updated);
      setApprovalComment("");
      addToast?.(`Request ${decision === "approve" ? "approved" : "denied"}`, "success");
    } catch {
      addToast?.("Failed to submit decision", "error");
    } finally {
      setApprovalDecisionLoading(false);
    }
  }, [selectedApproval, approvalDecisionLoading, approvalComment, projectId, loadApprovals, approvalSubTab, addToast]);

  /*
  FNXC:MailboxMobile 2026-07-16-16:00:
  Mobile mailbox overlays must register modal history entries so iOS swipe-back,
  Android native Back, and browser Back dismiss the current overlay before leaving
  the mailbox. Programmatic closers remove their matching entries; nullable context
  keeps the provider-less MailboxView test and embedded renders operational.
  */
  useEffect(() => {
    if (!isMobile || !selectedMessage || showComposer || !navigationHistory) return;
    navigationHistory.pushNav({ type: "modal", close: handleCloseMessage });
  }, [handleCloseMessage, isMobile, navigationHistory, selectedMessage, showComposer]);

  useEffect(() => {
    if (!isMobile || !showComposer || !navigationHistory) return;
    navigationHistory.pushNav({ type: "modal", close: handleCloseComposer });
  }, [handleCloseComposer, isMobile, navigationHistory, showComposer]);

  useEffect(() => {
    if (!isMobile || !selectedApproval || !navigationHistory) return;
    navigationHistory.pushNav({ type: "modal", close: handleCloseApproval });
  }, [handleCloseApproval, isMobile, navigationHistory, selectedApproval]);

  const handleSelectTab = useCallback((tab: MailboxTab) => {
    consumeCurrentDeepLink();
    dismissMessage();
    dismissApproval();
    setActiveTab(tab);
  }, [consumeCurrentDeepLink, dismissApproval, dismissMessage]);

  const handleAgentSelection = useCallback((agentId: string) => {
    consumeCurrentDeepLink();
    dismissMessage();
    setSelectedAgentId(agentId);
    setAgentSubTab("inbox");
  }, [consumeCurrentDeepLink, dismissMessage]);

  const handleAgentSubTab = useCallback((tab: "inbox" | "outbox") => {
    consumeCurrentDeepLink();
    dismissMessage();
    setAgentSubTab(tab);
  }, [consumeCurrentDeepLink, dismissMessage]);

  // ── Render ────────────────────────────────────────────────────────────

  const renderMessageDetail = () => {
    if (!selectedMessage || showComposer) return null;

    const threadMessages = buildReplyThread(conversationMessages, selectedMessage);

    return (
      <div className="mailbox-message-detail" data-testid="mailbox-message-detail" id={detailMessageAnchorId(selectedMessage.id)}>
        <div className="mailbox-message-detail-header">
          {isMobile && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={dismissMessage}
              data-testid="mailbox-back-to-list"
            >
              ← {t("mailbox.back", "Back")}
            </button>
          )}
          <div className="mailbox-message-detail-meta">
            <span className="mailbox-message-type">{messageTypeLabel(selectedMessage.type)}</span>
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
                <span>{t("mailbox.reply", "Reply")}</span>
              </button>
            )}
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => handleDeleteMessage(selectedMessage.id)}
              data-testid="mailbox-delete"
            >
              <Trash2 size={14} />
              <span>{t("mailbox.delete", "Delete")}</span>
            </button>
          </div>
        </div>
        <div className="mailbox-message-participants">
          <div className="mailbox-participant">
            <span className="mailbox-participant-label">{t("mailbox.from", "From")}:</span>
            <span className="mailbox-participant-value">
              {selectedMessage.fromType === "agent" ? <Bot size={14} /> : <User size={14} />}
              {getParticipantLabel(selectedMessage.fromId, selectedMessage.fromType)}
            </span>
          </div>
          <div className="mailbox-participant">
            <span className="mailbox-participant-label">{t("mailbox.to", "To")}:</span>
            <span className="mailbox-participant-value">
              {selectedMessage.toType === "agent" ? <Bot size={14} /> : <User size={14} />}
              {getParticipantLabel(selectedMessage.toId, selectedMessage.toType)}
            </span>
          </div>
        </div>
        {threadMessages.length > 1 && (
          <div className="mailbox-conversation" data-testid="mailbox-conversation">
            <div className="mailbox-conversation-label">{t("mailbox.conversation", "Conversation")}</div>
            {threadMessages.map((msg) => {
              const replyToId = msg.metadata?.replyTo?.messageId;
              const replyToMessage = replyToId
                ? threadMessages.find((candidate) => candidate.id === replyToId)
                : undefined;

              return (
                <div
                  key={msg.id}
                  id={detailMessageAnchorId(msg.id)}
                  className={`mailbox-conversation-msg ${msg.id === selectedMessage.id ? "current" : ""}`}
                >
                  <div className="mailbox-conversation-msg-header">
                    <span>{getParticipantLabel(msg.fromId, msg.fromType)}</span>
                    <span className="mailbox-message-time">{formatTimestamp(msg.createdAt, t)}</span>
                  </div>
                  {replyToId && (
                    <div className="mailbox-reply-context-static" data-testid={`mailbox-reply-context-${msg.id}`}>
                      ↪ {t("mailbox.replyingTo", "Replying to")} {replyToMessage ? messagePreview(replyToMessage.content, 60) : `message ${replyToId}`}
                    </div>
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
        {(threadMessages.length <= 1) && (
          <>
            {selectedMessage.metadata?.replyTo?.messageId && (
              <div className="mailbox-reply-context-static" data-testid="mailbox-selected-reply-context">
                ↪ {t("mailbox.replyingToMessage", "Replying to message")} {selectedMessage.metadata.replyTo.messageId}
              </div>
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
    );
  };

  const renderListPane = () => (
    <>
      {activeTab === "inbox" && (
        <div className="mailbox-list" data-testid="mailbox-inbox-list">
          {isLoading && !inbox && <MailboxSkeleton />}
          {inbox && inbox.messages.length === 0 && (
            <div className="mailbox-empty" data-testid="mailbox-inbox-empty">
              <InboxIcon size={32} />
              <p>{t("mailbox.noMessagesInbox", "No messages in your inbox")}</p>
            </div>
          )}
          {inbox?.messages.map((msg) => (
            <div
              key={msg.id}
              id={listMessageAnchorId(msg.id)}
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
                    {getParticipantLabel(msg.fromId, msg.fromType)}
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

      {activeTab === "outbox" && (
        <div className="mailbox-list" data-testid="mailbox-outbox-list">
          {isLoading && !outbox && <MailboxSkeleton />}
          {outbox && outbox.messages.length === 0 && (
            <div className="mailbox-empty" data-testid="mailbox-outbox-empty">
              <Send size={32} />
              <p>{t("mailbox.noSentMessages", "No sent messages")}</p>
            </div>
          )}
          {outbox?.messages.map((msg) => (
            <div
              key={msg.id}
              id={listMessageAnchorId(msg.id)}
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
                    {t("mailbox.toRecipient", "To: {{recipient}}", { recipient: getParticipantLabel(msg.toId, msg.toType) })}
                  </span>
                  <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                </div>
                <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === "approvals" && (
        <div className="mailbox-approvals" data-testid="mailbox-approvals">
          <div className="mailbox-approval-filters" data-testid="mailbox-approval-filters">
            <button
              className={`btn btn-sm btn-secondary mailbox-agent-subtab ${approvalSubTab === "pending" ? "active" : ""}`}
              onClick={() => { setApprovalSubTab("pending"); dismissApproval(); }}
              data-testid="mailbox-approval-filter-pending"
            >
              {t("mailbox.pending", "Pending")}
            </button>
            <button
              className={`btn btn-sm btn-secondary mailbox-agent-subtab ${approvalSubTab === "history" ? "active" : ""}`}
              onClick={() => { setApprovalSubTab("history"); dismissApproval(); }}
              data-testid="mailbox-approval-filter-history"
            >
              {t("mailbox.history", "History")}
            </button>
          </div>
          <div className="mailbox-list" data-testid="mailbox-approval-list">
            {approvals.length === 0 && !isLoading && (
              <div className="mailbox-empty" data-testid="mailbox-approval-empty">
                <InboxIcon size={32} />
                <p>{approvalSubTab === "pending" ? t("mailbox.noPendingApprovals", "No pending approvals") : t("mailbox.noHistoricalApprovals", "No historical approvals")}</p>
              </div>
            )}
            {approvals.map((request) => (
              <div
                key={request.id}
                className="mailbox-item mailbox-approval-item"
                onClick={() => void handleOpenApproval(request)}
                data-testid={`mailbox-approval-item-${request.id}`}
              >
                <div className={`status-dot mailbox-approval-status-dot mailbox-approval-status-dot--${request.status}`} />
                <div className="mailbox-item-content">
                  <div className="mailbox-item-header">
                    <span className="mailbox-item-from">{request.agentId} · {request.actionCategory}</span>
                    <span className="mailbox-item-time">{formatTimestamp(request.createdAt)}</span>
                  </div>
                  <div className="mailbox-item-preview">{request.actionSummary}</div>
                </div>
                <span className={`mailbox-approval-status mailbox-approval-status--${request.status}`}>{request.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "agents" && (
        <div className="mailbox-agents" data-testid="mailbox-agents">
          {agents.length === 0 ? (
            <div className="mailbox-empty">
              <Bot size={32} />
              <p>{t("mailbox.noAgentsFound", "No agents found")}</p>
            </div>
          ) : (
            <>
              <div className="mailbox-agents-header">
                <div className="mailbox-agents-dropdown">
                  <select
                    className="message-composer-select mailbox-agent-select"
                    value={selectedAgentId}
                    onChange={(e) => handleAgentSelection(e.target.value)}
                    data-testid="mailbox-agent-select"
                  >
                    <option value={ALL_AGENTS_MAILBOX_ID}>{t("mailbox.allAgents", "All agents")}</option>
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
                  <span>{t("mailbox.compose", "Compose")}</span>
                </button>
              </div>

              {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && (
                <div className="mailbox-agent-subtabs" data-testid="mailbox-agent-subtabs">
                  <button
                    className={`btn btn-sm btn-secondary mailbox-agent-subtab ${agentSubTab === "inbox" ? "active" : ""}`}
                    onClick={() => handleAgentSubTab("inbox")}
                    data-testid="mailbox-agent-subtab-inbox"
                  >
                    <InboxIcon size={12} />
                    <span>{t("mailbox.inbox", "Inbox")}</span>
                    {agentMailbox && agentMailbox.unreadCount > 0 && (
                      <span className="mailbox-tab-badge">{agentMailbox.unreadCount}</span>
                    )}
                  </button>
                  <button
                    className={`btn btn-sm btn-secondary mailbox-agent-subtab ${agentSubTab === "outbox" ? "active" : ""}`}
                    onClick={() => handleAgentSubTab("outbox")}
                    data-testid="mailbox-agent-subtab-outbox"
                  >
                    <Send size={12} />
                    <span>{t("mailbox.outbox", "Outbox")}</span>
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
                    id={listMessageAnchorId(msg.id)}
                    className={`mailbox-item ${!msg.read ? "unread" : ""}`}
                    onClick={() => handleOpenMessage(msg)}
                    data-testid={`mailbox-item-${msg.id}`}
                  >
                    <div className="mailbox-item-avatar">
                      {msg.fromType === "agent" ? <Bot size={16} /> : <User size={16} />}
                    </div>
                    <div className="mailbox-item-content">
                      <div className="mailbox-item-header">
                        <span className="mailbox-item-from">{getParticipantLabel(msg.fromId, msg.fromType)}</span>
                        <span className="mailbox-item-time">{formatTimestamp(msg.createdAt, t)}</span>
                      </div>
                      <div className="mailbox-item-participants" data-testid={`mailbox-item-participants-${msg.id}`}>
                        <span>{t("mailbox.from", "From")}: {getParticipantLabel(msg.fromId, msg.fromType)}</span>
                        <span>{t("mailbox.to", "To")}: {getParticipantLabel(msg.toId, msg.toType)}</span>
                      </div>
                      <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                    </div>
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
                    <p>{t("mailbox.noSentMessagesAgent", "No sent messages for this agent")}</p>
                  </div>
                )}
                {selectedAgentId && selectedAgentId !== ALL_AGENTS_MAILBOX_ID && agentMailbox && agentSubTab === "inbox" && agentMailbox.inbox.map((msg) => (
                  <div
                    key={msg.id}
                    id={listMessageAnchorId(msg.id)}
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
                          {getParticipantLabel(msg.fromId, msg.fromType)}
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
                    id={listMessageAnchorId(msg.id)}
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
                          {t("mailbox.toRecipient", "To: {{recipient}}", { recipient: getParticipantLabel(msg.toId, msg.toType) })}
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
  );

  const renderDetailPane = () => {
    if (showComposer) {
      return (
        <MessageComposer
          recipient={composeRecipient}
          replyContext={composeReplyContext}
          agents={agents}
          projectId={projectId}
          onSend={handleMessageSent}
          onCancel={handleComposeCancel}
          addToast={addToast}
        />
      );
    }

    if (selectedMessage) {
      return renderMessageDetail();
    }

    if (activeTab === "approvals" && selectedApproval) {
      return (
        <div className="mailbox-message-detail mailbox-approval-detail" data-testid="mailbox-approval-detail">
          {isMobile && (
            <button className="btn btn-sm btn-secondary" onClick={dismissApproval} data-testid="mailbox-approval-back-to-list">← {t("mailbox.back", "Back")}</button>
          )}
          <div className="mailbox-message-detail-header">
            <div className="mailbox-message-detail-meta">
              <span className="mailbox-message-type">{selectedApproval.actionCategory}</span>
              <span className="mailbox-message-time">{selectedApproval.status}</span>
            </div>
          </div>
          <div className="mailbox-message-body">
            <strong>{selectedApproval.actionSummary}</strong>
            <p>{t("mailbox.approvalRequester", "Requester")}: {selectedApproval.requester.actorName} ({selectedApproval.agentId})</p>
            {selectedApproval.taskId && <p>{t("mailbox.approvalTask", "Task")}: {selectedApproval.taskId}</p>}
            <p>{t("mailbox.approvalRequested", "Requested")}: {formatTimestamp(selectedApproval.createdAt)}</p>
          </div>
          {selectedApproval.targetAction.category === "network_api" && selectedApproval.targetAction.action === "worktrunk_install" && (
            <WorktrunkInstallApprovalDetails targetAction={selectedApproval.targetAction} />
          )}
          {/*
            FNXC:Approvals 2026-07-05-00:00:
            FN-7609: render the generic gated-action payload (command/args/cwd)
            whenever the request came from the agent-gating path, on both
            desktop and mobile layouts. Mutually exclusive with the dedicated
            worktrunk_install branch above, which must keep rendering unchanged.
          */}
          {selectedApproval.targetAction.action !== "worktrunk_install"
            && (selectedApproval.targetAction.context as Record<string, unknown> | undefined)?.source === "agent-gating" && (
            <GatedActionApprovalDetails targetAction={selectedApproval.targetAction} />
          )}
          <div className="mailbox-conversation" data-testid="mailbox-approval-history">
            {selectedApproval.history.map((event) => (
              <div key={event.id} className="mailbox-conversation-msg">
                <div className="mailbox-conversation-msg-header">
                  <span>{event.eventType}</span>
                  <span>{event.actor.actorName}</span>
                </div>
                {event.note && <div className="mailbox-item-preview">{event.note}</div>}
              </div>
            ))}
          </div>
          {selectedApproval.status === "pending" && (
            <div className="mailbox-approval-decision" data-testid="mailbox-approval-decision">
              <textarea
                className="message-composer-textarea mailbox-approval-comment"
                value={approvalComment}
                onChange={(event) => setApprovalComment(event.target.value)}
                placeholder={t("mailbox.approvalCommentPlaceholder", "Optional comment")}
                data-testid="mailbox-approval-comment"
              />
              <div className="mailbox-header-actions">
                <button className="btn btn-sm btn-secondary" onClick={() => void handleApprovalDecision("deny")} disabled={approvalDecisionLoading !== false} data-testid="mailbox-approval-deny">
                  {t("mailbox.approvalDeny", "Deny")}
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => void handleApprovalDecision("approve")} disabled={approvalDecisionLoading !== false} data-testid="mailbox-approval-approve">
                  {t("mailbox.approvalApprove", "Approve")}
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mailbox-split-empty" data-testid="mailbox-split-empty">
        <Mail size={24} />
        <p>{t("mailbox.selectMessageToRead", "Select a message to read")}</p>
      </div>
    );
  };

  /*
  FNXC:MailboxMobile 2026-07-17-13:43:
  FN-8238 gates the full-page mailbox's compact mobile layout on this class, mirroring
  isMobileViewport() exactly. CSS media or pointer queries cannot read the runtime
  physical-screen and visualViewport signals that determine the mobile classification.
  */
  return (
    <div
      className={`mailbox-view${isMobile ? " mailbox-view--mobile" : ""}`}
      style={containerKeyboardStyle}
      data-testid="mailbox-view"
    >
      {/*
      FNXC:Navigation 2026-06-22-01:10:
      Mailbox adopts the shared ViewHeader (Command Center-modeled) for a consistent main-content title row. The unread count badge stays beside the title (preserving the mailbox-unread-badge test id), and Compose / Mark-all-read / Refresh controls move into the header actions cluster so they keep working. Tabs remain below the header as their own row.
      */}
      <ViewHeader
        icon={Mail}
        title={t("mailbox.title", "Mailbox")}
        actions={
          <>
            {unreadCount > 0 && (
              <span className="mailbox-unread-badge" data-testid="mailbox-unread-badge">
                {unreadCount}
              </span>
            )}
            <button
              className="btn btn-sm btn-primary"
              onClick={handleOpenCompose}
              title={t("mailbox.composeMessageTitle", "Compose message")}
              data-testid="mailbox-header-compose"
            >
              <MessageSquare size={14} />
              <span>{t("mailbox.compose", "Compose")}</span>
            </button>
            {activeTab === "inbox" && unreadCount > 0 && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={handleMarkAllRead}
                title={t("mailbox.markAllReadTitle", "Mark all as read")}
                data-testid="mailbox-mark-all-read"
              >
                <CheckCheck size={14} />
                <span>{t("mailbox.markAllRead", "Mark all read")}</span>
              </button>
            )}
            <button
              className="btn-icon"
              onClick={() => {
                if (activeTab === "inbox") loadInbox();
                else if (activeTab === "outbox") loadOutbox();
                else if (activeTab === "approvals") loadApprovals(approvalSubTab);
                else if (selectedAgentId === ALL_AGENTS_MAILBOX_ID) loadAllAgentsMailbox();
                else if (selectedAgentId) loadAgentMailbox(selectedAgentId);
              }}
              disabled={isLoading}
              title={t("mailbox.refreshTitle", "Refresh")}
              data-testid="mailbox-refresh"
            >
              {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>
          </>
        }
      />

      {/* Tabs */}
      <div className="mailbox-tabs" data-testid="mailbox-tabs">
        <button
          className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "inbox" ? "active" : ""}`}
          onClick={() => handleSelectTab("inbox")}
          data-testid="mailbox-tab-inbox"
        >
          <InboxIcon size={14} />
          <span>{t("mailbox.inbox", "Inbox")}</span>
          {unreadCount > 0 && <span className="mailbox-tab-badge">{unreadCount}</span>}
        </button>
        <button
          className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "outbox" ? "active" : ""}`}
          onClick={() => handleSelectTab("outbox")}
          data-testid="mailbox-tab-outbox"
        >
          <Send size={14} />
          <span>{t("mailbox.outbox", "Outbox")}</span>
        </button>
        <button
          className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "agents" ? "active" : ""}`}
          onClick={() => handleSelectTab("agents")}
          data-testid="mailbox-tab-agents"
        >
          <Bot size={14} />
          <span>{t("mailbox.agents", "Agents")}</span>
        </button>
        <button
          className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "approvals" ? "active" : ""}`}
          onClick={() => handleSelectTab("approvals")}
          data-testid="mailbox-tab-approvals"
        >
          <CheckCheck size={14} />
          <span>{t("mailbox.approvals", "Approvals")}</span>
          {approvalPendingCount > 0 && <span className="mailbox-tab-badge" data-testid="mailbox-approvals-pending-badge">{approvalPendingCount}</span>}
        </button>
      </div>

      <div className="mailbox-content" data-testid="mailbox-content" ref={mailboxContentRef}>
        {isSplitPane ? (
          <div className="mailbox-split-layout" data-testid="mailbox-split-layout" ref={splitLayoutRef}>
            <div
              className="mailbox-split-list-pane"
              data-testid="mailbox-split-list-pane"
              style={{ width: `${sidebarWidth}px` }}
            >
              {renderListPane()}
            </div>
            <div
              className="mailbox-split-resize-handle"
              data-testid="mailbox-split-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("mailbox.resizeMessageListPane", "Resize message list pane")}
              tabIndex={0}
              aria-valuemin={MAILBOX_SIDEBAR_MIN_WIDTH}
              aria-valuemax={Math.round(getMailboxSidebarMaxWidth(splitLayoutRef.current?.clientWidth ?? sidebarWidth / MAILBOX_SIDEBAR_MAX_RATIO))}
              aria-valuenow={Math.round(sidebarWidth)}
              onPointerDown={handleSplitResizeStart}
              onKeyDown={handleSplitResizeKeyDown}
            />
            <div className="mailbox-split-detail-pane" data-testid="mailbox-split-detail-pane">
              {renderDetailPane()}
            </div>
          </div>
        ) : (
          <>
            {renderMessageDetail()}
            {activeTab === "approvals" && selectedApproval && renderDetailPane()}
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
            {!selectedMessage && !selectedApproval && !showComposer && renderListPane()}
          </>
        )}
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
