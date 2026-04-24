import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import type { Message, MessageType, ParticipantType } from "@fusion/core";
import {
  fetchInbox,
  fetchOutbox,
  fetchUnreadCount,
  fetchAgentMailbox,
  markMessageRead,
  markAllMessagesRead,
  deleteMessage,
  fetchConversation,
  type InboxResponse,
  type OutboxResponse,
  type AgentMailboxResponse,
} from "../api";
import { MessageComposer } from "./MessageComposer";
import type { Agent } from "../api";
import { subscribeSse } from "../sse-bus";

// ── Types ─────────────────────────────────────────────────────────────────

type MailboxTab = "inbox" | "outbox" | "agents";

interface MailboxModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  addToast?: (msg: string, type?: "success" | "error") => void;
  agents?: Agent[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function participantLabel(id: string, type: ParticipantType): string {
  if (type === "user") return id === "dashboard" ? "You" : `User: ${id}`;
  if (type === "agent") return `Agent: ${id}`;
  return "System";
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

// ── Component ─────────────────────────────────────────────────────────────

export function MailboxModal({
  isOpen,
  onClose,
  projectId,
  addToast,
  agents = [],
}: MailboxModalProps) {
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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentSubTab, setAgentSubTab] = useState<"inbox" | "outbox">("inbox");
  const [agentMailbox, setAgentMailbox] = useState<AgentMailboxResponse | null>(null);

  // ── Data fetching ─────────────────────────────────────────────────────

  const loadInbox = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchInbox({ limit: 50 }, projectId);
      setInbox(data);
      setUnreadCount(data.unreadCount);
    } catch {
      // Silently fail — empty state will show
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const loadOutbox = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchOutbox({ limit: 50 }, projectId);
      setOutbox(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

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

  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await fetchUnreadCount(projectId);
      setUnreadCount(data.unreadCount);
    } catch {
      // Silently fail
    }
  }, [projectId]);

  // Load data on tab change
  useEffect(() => {
    if (!isOpen) return;
    if (activeTab === "inbox") loadInbox();
    else if (activeTab === "outbox") loadOutbox();
  }, [isOpen, activeTab, loadInbox, loadOutbox]);

  // Load agent mailbox when selected
  useEffect(() => {
    if (!isOpen || !selectedAgentId) return;
    loadAgentMailbox(selectedAgentId);
  }, [isOpen, selectedAgentId, loadAgentMailbox]);

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

      if (selectedAgentId) {
        void loadAgentMailbox(selectedAgentId);
      }
    };

    return subscribeSse(`/api/events${query}`, {
      events: {
        "message:sent": onMailboxUpdate,
        "message:received": onMailboxUpdate,
        "message:read": onMailboxUpdate,
        "message:deleted": onMailboxUpdate,
      },
    });
  }, [isOpen, projectId, activeTab, selectedAgentId, refreshUnreadCount, loadInbox, loadOutbox, loadAgentMailbox]);

  // ── Actions ───────────────────────────────────────────────────────────

  const handleOpenMessage = useCallback(async (message: Message) => {
    setSelectedMessage(message);
    // Mark as read if unread
    if (!message.read) {
      try {
        const updated = await markMessageRead(message.id, projectId);
        // Update inbox state
        setInbox((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)),
                unreadCount: Math.max(0, prev.unreadCount - 1),
              }
            : prev,
        );
        setUnreadCount((c) => Math.max(0, c - 1));
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
  }, [projectId]);

  const handleCloseMessage = useCallback(() => {
    setSelectedMessage(null);
    setConversationMessages([]);
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    try {
      const result = await markAllMessagesRead(projectId);
      setUnreadCount(0);
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
  }, [projectId, addToast]);

  const handleDeleteMessage = useCallback(async (id: string) => {
    try {
      await deleteMessage(id, projectId);
      setSelectedMessage(null);
      setConversationMessages([]);
      // Refresh current tab
      if (activeTab === "inbox") loadInbox();
      else if (activeTab === "outbox") loadOutbox();
      else if (selectedAgentId) loadAgentMailbox(selectedAgentId);
      addToast?.("Message deleted", "success");
    } catch {
      addToast?.("Failed to delete message", "error");
    }
  }, [projectId, activeTab, selectedAgentId, loadInbox, loadOutbox, loadAgentMailbox, addToast]);

  const handleReply = useCallback((message: Message) => {
    setComposeRecipient({ id: message.fromId, type: message.fromType });
    setComposeReplyContext({
      messageId: message.id,
      preview: messagePreview(message.content, 120),
    });
    setShowComposer(true);
  }, []);

  const handleMessageSent = useCallback(() => {
    setShowComposer(false);
    setComposeRecipient(null);
    setComposeReplyContext(null);
    addToast?.("Message sent", "success");
    // Refresh current tab
    if (activeTab === "outbox") loadOutbox();
    else if (activeTab === "agents" && selectedAgentId) loadAgentMailbox(selectedAgentId);
  }, [activeTab, loadOutbox, selectedAgentId, loadAgentMailbox, addToast]);

  const handleOpenCompose = useCallback(() => {
    // Pre-fill recipient from selected agent if available
    if (activeTab === "agents" && selectedAgentId) {
      setComposeRecipient({ id: selectedAgentId, type: "agent" });
    } else {
      setComposeRecipient(null);
    }
    setComposeReplyContext(null);
    setShowComposer(true);
  }, [activeTab, selectedAgentId]);

  const handleComposeCancel = useCallback(() => {
    setShowComposer(false);
    setComposeRecipient(null);
    setComposeReplyContext(null);
  }, []);

  if (!isOpen) return null;

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
      <div className="modal modal-lg mailbox-modal" data-testid="mailbox-modal">
        {/* Header */}
        <div className="modal-header mailbox-header">
          <div className="mailbox-title">
            <Mail size={18} />
            <span>Mailbox</span>
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
              title="Compose message"
              data-testid="mailbox-header-compose"
            >
              <MessageSquare size={14} />
              <span>Compose</span>
            </button>
            {activeTab === "inbox" && unreadCount > 0 && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={handleMarkAllRead}
                title="Mark all as read"
                data-testid="mailbox-mark-all-read"
              >
                <CheckCheck size={14} />
                <span>Mark all read</span>
              </button>
            )}
            <button
              className="btn-icon"
              onClick={() => {
                if (activeTab === "inbox") loadInbox();
                else if (activeTab === "outbox") loadOutbox();
                else if (selectedAgentId) loadAgentMailbox(selectedAgentId);
              }}
              disabled={isLoading}
              title="Refresh"
              data-testid="mailbox-refresh"
            >
              {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>
            <button
              className="modal-close"
              onClick={onClose}
              aria-label="Close"
              title="Close"
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
            onClick={() => { setActiveTab("inbox"); setSelectedMessage(null); }}
            data-testid="mailbox-tab-inbox"
          >
            <InboxIcon size={14} />
            <span>Inbox</span>
            {unreadCount > 0 && <span className="mailbox-tab-badge">{unreadCount}</span>}
          </button>
          <button
            className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "outbox" ? "active" : ""}`}
            onClick={() => { setActiveTab("outbox"); setSelectedMessage(null); }}
            data-testid="mailbox-tab-outbox"
          >
            <Send size={14} />
            <span>Outbox</span>
          </button>
          <button
            className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "agents" ? "active" : ""}`}
            onClick={() => { setActiveTab("agents"); setSelectedMessage(null); }}
            data-testid="mailbox-tab-agents"
          >
            <Bot size={14} />
            <span>Agents</span>
          </button>
        </div>

        {/* Content */}
        <div className="mailbox-content" data-testid="mailbox-content">
          {/* Message Detail View */}
          {selectedMessage && !showComposer && (
            <div className="mailbox-message-detail" data-testid="mailbox-message-detail">
              <div className="mailbox-message-detail-header">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={handleCloseMessage}
                  data-testid="mailbox-back-to-list"
                >
                  ← Back
                </button>
                <div className="mailbox-message-detail-meta">
                  <span className="mailbox-message-type">{messageTypeLabel(selectedMessage.type)}</span>
                  <span className="mailbox-message-time">{formatTimestamp(selectedMessage.createdAt)}</span>
                </div>
                <div className="mailbox-message-detail-actions">
                  {selectedMessage.fromType === "agent" && (
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => handleReply(selectedMessage)}
                      data-testid="mailbox-reply"
                    >
                      <MessageSquare size={14} />
                      <span>Reply</span>
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => handleDeleteMessage(selectedMessage.id)}
                    data-testid="mailbox-delete"
                  >
                    <Trash2 size={14} />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
              <div className="mailbox-message-participants">
                <div className="mailbox-participant">
                  <span className="mailbox-participant-label">From:</span>
                  <span className="mailbox-participant-value">
                    {selectedMessage.fromType === "agent" ? <Bot size={14} /> : <User size={14} />}
                    {participantLabel(selectedMessage.fromId, selectedMessage.fromType)}
                  </span>
                </div>
                <div className="mailbox-participant">
                  <span className="mailbox-participant-label">To:</span>
                  <span className="mailbox-participant-value">
                    {selectedMessage.toType === "agent" ? <Bot size={14} /> : <User size={14} />}
                    {participantLabel(selectedMessage.toId, selectedMessage.toType)}
                  </span>
                </div>
              </div>
              {/* Conversation thread */}
              {conversationMessages.length > 1 && (
                <div className="mailbox-conversation" data-testid="mailbox-conversation">
                  <div className="mailbox-conversation-label">Conversation</div>
                  {conversationMessages.map((msg) => {
                    const replyToId = msg.metadata?.replyTo?.messageId;
                    const replyToMessage = replyToId
                      ? conversationMessages.find((candidate) => candidate.id === replyToId)
                      : undefined;

                    return (
                      <div
                        key={msg.id}
                        className={`mailbox-conversation-msg ${msg.id === selectedMessage.id ? "current" : ""}`}
                      >
                        <div className="mailbox-conversation-msg-header">
                          <span>{participantLabel(msg.fromId, msg.fromType)}</span>
                          <span className="mailbox-message-time">{formatTimestamp(msg.createdAt)}</span>
                        </div>
                        {replyToId && (
                          <div className="mailbox-reply-context" data-testid={`mailbox-reply-context-${msg.id}`}>
                            ↪ Replying to {replyToMessage ? messagePreview(replyToMessage.content, 60) : `message ${replyToId}`}
                          </div>
                        )}
                        <div className="mailbox-conversation-msg-body">{msg.content}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Full message content */}
              {(conversationMessages.length <= 1) && (
                <>
                  {selectedMessage.metadata?.replyTo?.messageId && (
                    <div className="mailbox-reply-context" data-testid="mailbox-selected-reply-context">
                      ↪ Replying to message {selectedMessage.metadata.replyTo.messageId}
                    </div>
                  )}
                  <div className="mailbox-message-body" data-testid="mailbox-message-body">
                    {selectedMessage.content}
                  </div>
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
                      <p>No messages in your inbox</p>
                    </div>
                  )}
                  {inbox?.messages.map((msg) => (
                    <div
                      key={msg.id}
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
                            {participantLabel(msg.fromId, msg.fromType)}
                          </span>
                          <span className="mailbox-item-time">{formatTimestamp(msg.createdAt)}</span>
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
                      <p>No sent messages</p>
                    </div>
                  )}
                  {outbox?.messages.map((msg) => (
                    <div
                      key={msg.id}
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
                            To: {participantLabel(msg.toId, msg.toType)}
                          </span>
                          <span className="mailbox-item-time">{formatTimestamp(msg.createdAt)}</span>
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
                      <p>No agents found</p>
                    </div>
                  ) : (
                    <>
                      <div className="mailbox-agents-header">
                        <div className="mailbox-agents-dropdown">
                          <select
                            className="message-composer-select mailbox-agent-select"
                            value={selectedAgentId ?? ""}
                            onChange={(e) => { setSelectedAgentId(e.target.value || null); setAgentSubTab("inbox"); }}
                            data-testid="mailbox-agent-select"
                          >
                            <option value="">Select an agent…</option>
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
                          <span>Compose</span>
                        </button>
                      </div>

                      {/* Agent Sub-Tabs (Inbox/Outbox) */}
                      {selectedAgentId && (
                        <div className="mailbox-agent-subtabs" data-testid="mailbox-agent-subtabs">
                          <button
                            className={`btn btn-sm btn-secondary mailbox-agent-subtab ${agentSubTab === "inbox" ? "active" : ""}`}
                            onClick={() => setAgentSubTab("inbox")}
                            data-testid="mailbox-agent-subtab-inbox"
                          >
                            <InboxIcon size={12} />
                            <span>Inbox</span>
                            {agentMailbox && agentMailbox.unreadCount > 0 && (
                              <span className="mailbox-tab-badge">{agentMailbox.unreadCount}</span>
                            )}
                          </button>
                          <button
                            className={`btn btn-sm btn-secondary mailbox-agent-subtab ${agentSubTab === "outbox" ? "active" : ""}`}
                            onClick={() => setAgentSubTab("outbox")}
                            data-testid="mailbox-agent-subtab-outbox"
                          >
                            <Send size={12} />
                            <span>Outbox</span>
                          </button>
                        </div>
                      )}
                      <div className="mailbox-agents-content">
                        {!selectedAgentId && (
                          <div className="mailbox-empty">
                            <Bot size={32} />
                            <p>Select an agent to view their mailbox</p>
                          </div>
                        )}
                        {selectedAgentId && isLoading && !agentMailbox && <MailboxSkeleton />}
                        {selectedAgentId && agentMailbox && agentSubTab === "inbox" && agentMailbox.inbox.length === 0 && (
                          <div className="mailbox-empty">
                            <InboxIcon size={32} />
                            <p>No received messages for this agent</p>
                          </div>
                        )}
                        {selectedAgentId && agentMailbox && agentSubTab === "outbox" && agentMailbox.outbox.length === 0 && (
                          <div className="mailbox-empty">
                            <Send size={32} />
                            <p>No sent messages for this agent</p>
                          </div>
                        )}
                        {selectedAgentId && agentMailbox && agentSubTab === "inbox" && agentMailbox.inbox.map((msg) => (
                          <div
                            key={msg.id}
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
                                  {msg.fromType === "agent"
                                    ? participantLabel(msg.toId, msg.toType)
                                    : participantLabel(msg.fromId, msg.fromType)}
                                </span>
                                <span className="mailbox-item-time">{formatTimestamp(msg.createdAt)}</span>
                              </div>
                              <div className="mailbox-item-preview">{msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</div>
                            </div>
                          </div>
                        ))}
                        {selectedAgentId && agentMailbox && agentSubTab === "outbox" && agentMailbox.outbox.map((msg) => (
                          <div
                            key={msg.id}
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
                                  To: {participantLabel(msg.toId, msg.toType)}
                                </span>
                                <span className="mailbox-item-time">{formatTimestamp(msg.createdAt)}</span>
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
