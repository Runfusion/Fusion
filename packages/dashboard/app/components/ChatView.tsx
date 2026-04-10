import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Send,
  Plus,
  Search,
  Trash2,
  Archive,
  ChevronLeft,
  Bot,
} from "lucide-react";
import { useChat } from "../hooks/useChat";
import { useAgents } from "../hooks/useAgents";
import { useViewportMode } from "./Header";
import type { Agent } from "../api";

export interface ChatViewProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
}

function getAgentLabel(agent: Agent): string {
  const base = agent.name?.trim() || agent.id;
  return `${base} (${agent.role})`;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

interface NewChatDialogProps {
  agents: Agent[];
  onClose: () => void;
  onCreate: (input: { agentId: string; title?: string; modelProvider?: string; modelId?: string }) => void;
}

function NewChatDialog({ agents, onClose, onCreate }: NewChatDialogProps) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId) return;
    onCreate({ agentId, title: title || undefined, modelProvider: modelProvider || undefined, modelId: modelId || undefined });
  };

  return (
    <div className="chat-new-dialog-backdrop" onClick={onClose}>
      <div className="chat-new-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Chat</h3>
        <form onSubmit={handleSubmit}>
          <label>
            Agent
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              required
            >
              <option value="">Select an agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {getAgentLabel(agent)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title (optional)
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Conversation title"
            />
          </label>
          <label>
            Model Provider (optional)
            <input
              type="text"
              value={modelProvider}
              onChange={(e) => setModelProvider(e.target.value)}
              placeholder="e.g., anthropic"
            />
          </label>
          <label>
            Model ID (optional)
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g., claude-sonnet-4-5"
            />
          </label>
          <div className="chat-new-dialog-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!agentId}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ChatView({ projectId, addToast }: ChatViewProps) {
  const { agents } = useAgents(projectId);
  const {
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
    searchQuery,
    setSearchQuery,
    filteredSessions,
  } = useChat(projectId);

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mode = useViewportMode();
  const isMobile = mode === "mobile";

  // Scroll to bottom on new messages or streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  // Handle create session
  const handleCreateSession = useCallback(
    async (input: { agentId: string; title?: string; modelProvider?: string; modelId?: string }) => {
      try {
        await createSession(input);
        setShowNewDialog(false);
        // On mobile, hide sidebar after selecting
        if (isMobile) setSidebarVisible(false);
      } catch {
        addToast("Failed to create chat session", "error");
      }
    },
    [createSession, addToast, isMobile],
  );

  // Handle send message
  const handleSend = useCallback(async () => {
    const trimmed = messageInput.trim();
    if (!trimmed || isStreaming || !activeSession) return;
    setMessageInput("");
    try {
      await sendMessage(trimmed);
    } catch {
      addToast("Failed to send message", "error");
    }
  }, [messageInput, isStreaming, activeSession, sendMessage, addToast]);

  // Handle input key down
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  // Handle textarea resize
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    setMessageInput(textarea.value);
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, []);

  // Handle archive
  const handleArchive = useCallback(
    async (id: string) => {
      setContextMenu(null);
      try {
        await archiveSession(id);
        addToast("Conversation archived", "success");
      } catch {
        addToast("Failed to archive conversation", "error");
      }
    },
    [archiveSession, addToast],
  );

  // Handle delete
  const handleDelete = useCallback(
    async (id: string) => {
      setConfirmDelete(null);
      setContextMenu(null);
      try {
        await deleteSession(id);
        addToast("Conversation deleted", "success");
      } catch {
        addToast("Failed to delete conversation", "error");
      }
    },
    [deleteSession, addToast],
  );

  // Handle session click
  const handleSessionClick = useCallback(
    (id: string) => {
      selectSession(id);
      if (isMobile) setSidebarVisible(false);
    },
    [selectSession, isMobile],
  );

  // Handle back to sidebar (mobile)
  const handleBack = useCallback(() => {
    selectSession("");
    setSidebarVisible(true);
  }, [selectSession]);

  // Render empty state (no active session)
  const renderEmptyState = () => {
    if (showNewDialog) {
      return (
        <NewChatDialog
          agents={agents}
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      );
    }

    return (
      <div className="chat-empty-state">
        <MessageSquare size={48} strokeWidth={1.5} />
        <h2>Start a new conversation</h2>
        <div className="chat-empty-state-agent-select">
          <select
            onChange={(e) => {
              if (e.target.value) {
                void handleCreateSession({ agentId: e.target.value });
              }
            }}
            value=""
          >
            <option value="">Select an agent to start chatting</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {getAgentLabel(agent)}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNewDialog(true)}>
          <Plus size={16} />
          New Chat
        </button>
      </div>
    );
  };

  return (
    <div className="chat-view">
      {/* Sidebar */}
      <div className={`chat-sidebar${!sidebarVisible ? " chat-sidebar--hidden" : ""}`}>
        <div className="chat-sidebar-header">
          <button
            className="btn btn-sm chat-new-btn"
            onClick={() => setShowNewDialog(true)}
            data-testid="chat-new-btn"
          >
            <Plus size={14} />
            New Chat
          </button>
        </div>
        <div style={{ padding: "0 12px 8px" }}>
          <div className="chat-sidebar-search-wrapper">
            <Search size={14} className="chat-sidebar-search-icon" />
            <input
              type="text"
              className="chat-sidebar-search"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="chat-search-input"
            />
          </div>
        </div>
        <div className="chat-session-list">
          {sessionsLoading ? (
            <div style={{ padding: "12px", color: "var(--text-secondary)", fontSize: "13px" }}>
              Loading...
            </div>
          ) : filteredSessions.length === 0 ? (
            <div style={{ padding: "12px", color: "var(--text-secondary)", fontSize: "13px" }}>
              No conversations yet
            </div>
          ) : (
            filteredSessions.map((session) => (
              <div
                key={session.id}
                className={`chat-session-item${activeSession?.id === session.id ? " chat-session-item--active" : ""}`}
                onClick={() => handleSessionClick(session.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
                }}
                data-testid={`chat-session-${session.id}`}
              >
                <div className="chat-session-title">{session.title || "Untitled"}</div>
                <div className="chat-session-preview">
                  {session.lastMessagePreview || "No messages"}
                </div>
                <div className="chat-session-meta">
                  <span>{session.agentId.slice(0, 30)}</span>
                  <span>{session.updatedAt ? formatRelativeTime(session.updatedAt) : ""}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="chat-session-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleArchive(contextMenu.sessionId)}
            data-testid="chat-context-archive"
          >
            <Archive size={14} />
            Archive
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              setConfirmDelete(contextMenu.sessionId);
            }}
            data-testid="chat-context-delete"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && (
        <div className="chat-new-dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="chat-new-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Conversation?</h3>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "16px" }}>
              This action cannot be undone. All messages in this conversation will be permanently deleted.
            </p>
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void handleDelete(confirmDelete)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Thread */}
      <div className="chat-thread">
        {/* Header */}
        <div className="chat-thread-header">
          {isMobile && (
            <button className="btn-icon" onClick={handleBack} data-testid="chat-back-btn">
              <ChevronLeft size={16} />
            </button>
          )}
          <Bot size={16} />
          <span className="chat-thread-header-title">
            {activeSession?.title || activeSession?.agentId || "Chat"}
          </span>
        </div>

        {/* Messages */}
        <div className="chat-messages" ref={messagesContainerRef}>
          {messagesLoading ? (
            <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>Loading messages...</div>
          ) : messages.length === 0 && !activeSession ? (
            renderEmptyState()
          ) : messages.length === 0 && activeSession ? (
            <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
              No messages yet. Start the conversation!
            </div>
          ) : (
            <>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`chat-message chat-message--${message.role}`}
                  data-testid={`chat-message-${message.id}`}
                >
                  {message.role === "assistant" && (
                    <div className="chat-message-avatar">
                      <Bot size={14} />
                      <span>Assistant</span>
                    </div>
                  )}
                  <div className="chat-message-content">{message.content}</div>
                  {message.thinkingOutput && (
                    <details className="chat-message-thinking">
                      <summary>Thinking</summary>
                      <pre className="chat-message-thinking-content">{message.thinkingOutput}</pre>
                    </details>
                  )}
                  <div className="chat-message-time">{formatRelativeTime(message.createdAt)}</div>
                </div>
              ))}
              {isStreaming && streamingText && (
                <div className="chat-message chat-message--assistant chat-message--streaming">
                  <div className="chat-message-avatar">
                    <Bot size={14} />
                    <span>Assistant</span>
                  </div>
                  <div className="chat-message-content">{streamingText}</div>
                  {streamingThinking && (
                    <details className="chat-message-thinking">
                      <summary>Thinking</summary>
                      <pre className="chat-message-thinking-content">{streamingThinking}</pre>
                    </details>
                  )}
                  <div className="chat-typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        {activeSession && (
          <div className="chat-input-area">
            <textarea
              ref={inputRef}
              className="chat-input-textarea"
              placeholder="Type a message..."
              value={messageInput}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              disabled={isStreaming}
              rows={1}
              data-testid="chat-input"
            />
            <button
              className="chat-input-send"
              onClick={() => void handleSend()}
              disabled={!messageInput.trim() || isStreaming}
              data-testid="chat-send-btn"
            >
              <Send size={16} />
            </button>
          </div>
        )}
      </div>

      {/* New Chat Dialog (rendered at root level) */}
      {showNewDialog && (
        <NewChatDialog
          agents={agents}
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </div>
  );
}
