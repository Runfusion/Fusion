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
import { useViewportMode } from "./Header";
import { fetchAgents } from "../api";
import type { Agent } from "@fusion/core";

export interface ChatViewProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
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

/**
 * Constant agent ID for the built-in kb agent.
 * The chat system always uses createKbAgent with CHAT_SYSTEM_PROMPT regardless
 * of the agentId stored on the session. This ID serves as metadata only.
 */
const KB_AGENT_ID = "__kb_agent__";

interface NewChatDialogProps {
  onClose: () => void;
  onCreate: (input: { agentId: string }) => void;
}

function NewChatDialog({ onClose, onCreate }: NewChatDialogProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  // Load agents on mount
  useEffect(() => {
    setAgentsLoading(true);
    fetchAgents()
      .then((response) => {
        setAgents(response);
      })
      .catch(() => {
        // Silently fail - show empty list
        setAgents([]);
      })
      .finally(() => {
        setAgentsLoading(false);
      });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgentId) return;
    onCreate({ agentId: selectedAgentId });
  };

  return (
    <div className="chat-new-dialog-backdrop" onClick={onClose}>
      <div className="chat-new-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Chat</h3>
        <form onSubmit={handleSubmit}>
          <label className="chat-new-dialog-model-label">
            Agent
            {agentsLoading ? (
              <div className="chat-new-dialog-loading">Loading agents...</div>
            ) : agents.length === 0 ? (
              <div className="chat-new-dialog-empty">No agents available</div>
            ) : (
              <div className="chat-new-dialog-agent-list">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`chat-new-dialog-agent-item${selectedAgentId === agent.id ? " chat-new-dialog-agent-item--selected" : ""}`}
                    onClick={() => setSelectedAgentId(agent.id)}
                    data-testid={`agent-option-${agent.id}`}
                  >
                    <Bot size={16} />
                    <span className="chat-new-dialog-agent-name">{agent.name}</span>
                    <span className="chat-new-dialog-agent-role">{agent.role}</span>
                  </button>
                ))}
              </div>
            )}
          </label>
          <div className="chat-new-dialog-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={!selectedAgentId}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



export function ChatView({ projectId, addToast }: ChatViewProps) {
  const {
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
  const [agentsMap, setAgentsMap] = useState<Map<string, Agent>>(new Map());

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

  // Handle create session
  const handleCreateSession = useCallback(
    async (input: { agentId: string }) => {
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
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      );
    }

    return (
      <div className="chat-empty-state">
        <MessageSquare size={48} strokeWidth={1.5} />
        <h2>Start a new conversation</h2>
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
                  <span>{agentsMap.get(session.agentId)?.name || (session.agentId === KB_AGENT_ID ? "AI Assistant" : session.agentId.slice(0, 30))}</span>
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
            {activeSession?.title || agentsMap.get(activeSession?.agentId ?? "")?.name || activeSession?.agentId || "Chat"}
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
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </div>
  );
}
