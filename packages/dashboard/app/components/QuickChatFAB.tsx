import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { Message } from "@fusion/core";
import type { Agent } from "../api";
import { fetchConversation, sendMessage } from "../api";
import { useAgents } from "../hooks/useAgents";

interface QuickChatFABProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
  /** When false, the FAB button is hidden but the panel can still be opened programmatically via the open prop */
  showFAB?: boolean;
  /** When true, the chat panel is open */
  open?: boolean;
  /** Callback when the panel should be opened/closed */
  onOpenChange?: (open: boolean) => void;
}

function getAgentLabel(agent: Agent): string {
  const base = agent.name?.trim() || agent.id;
  return `${base} (${agent.role})`;
}

export function QuickChatFAB({ projectId, addToast, showFAB = true, open, onOpenChange }: QuickChatFABProps) {
  const { agents } = useAgents(projectId);
  // Internal state for uncontrolled mode, controlled state when open prop is provided
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled
    ? (value: boolean | ((prev: boolean) => boolean)) => {
        if (typeof value === "function") {
          onOpenChange?.(value(isOpen));
        } else {
          onOpenChange?.(value);
        }
      }
    : setInternalOpen;
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConversationLoading, setIsConversationLoading] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId("");
      setMessages([]);
      return;
    }

    const selectedStillExists = agents.some((agent) => agent.id === selectedAgentId);
    if (!selectedStillExists) {
      setSelectedAgentId(agents[0]?.id ?? "");
    }
  }, [agents, selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const loadConversation = useCallback(async (agentId: string) => {
    if (!agentId) {
      setMessages([]);
      return;
    }

    setIsConversationLoading(true);
    try {
      const conversation = await fetchConversation(agentId, "agent", projectId);
      setMessages(conversation);
    } catch {
      addToast("Failed to load conversation", "error");
      setMessages([]);
    } finally {
      setIsConversationLoading(false);
    }
  }, [addToast, projectId]);

  useEffect(() => {
    if (!isOpen || !selectedAgentId) return;
    void loadConversation(selectedAgentId);
  }, [isOpen, selectedAgentId, loadConversation]);

  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const messagesEl = messagesRef.current;
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, [messages, isOpen]);

  const handleSendMessage = useCallback(async () => {
    const trimmed = messageInput.trim();
    if (!selectedAgentId || !trimmed || isSending) return;

    setIsSending(true);
    try {
      await sendMessage(
        {
          toId: selectedAgentId,
          toType: "agent",
          content: trimmed,
          type: "user-to-agent",
        },
        projectId,
      );
      setMessageInput("");
      await loadConversation(selectedAgentId);
    } catch {
      addToast("Failed to send message", "error");
    } finally {
      setIsSending(false);
    }
  }, [addToast, isSending, loadConversation, messageInput, projectId, selectedAgentId]);

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void handleSendMessage();
  }, [handleSendMessage]);

  if (agents.length === 0) {
    return null;
  }

  return (
    <>
      {showFAB && (
        <button
          ref={fabRef}
          type="button"
          className="quick-chat-fab"
          aria-label="Open quick chat"
          data-testid="quick-chat-fab"
          onClick={() => setIsOpen((open) => !open)}
        >
          <MessageSquare size={24} />
        </button>
      )}

      {isOpen && (
        <div className="quick-chat-panel" ref={panelRef} data-testid="quick-chat-panel">
          <div className="quick-chat-panel-header">
            <h3>Quick Chat</h3>
            <button
              type="button"
              className="btn-icon"
              aria-label="Close quick chat"
              data-testid="quick-chat-close"
              onClick={() => setIsOpen(false)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="quick-chat-panel-agent-select">
            <label htmlFor="quick-chat-agent-select" className="visually-hidden">Select agent</label>
            <select
              id="quick-chat-agent-select"
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
              data-testid="quick-chat-agent-select"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {getAgentLabel(agent)}
                </option>
              ))}
            </select>
          </div>

          <div className="quick-chat-panel-messages" ref={messagesRef} data-testid="quick-chat-messages">
            {isConversationLoading ? (
              <div className="quick-chat-panel-empty">Loading conversation…</div>
            ) : messages.length === 0 ? (
              <div className="quick-chat-panel-empty">No messages yet. Start the conversation!</div>
            ) : (
              messages.map((message) => {
                const isSent = message.fromType === "user";
                return (
                  <div
                    key={message.id}
                    className={`quick-chat-panel-message ${isSent ? "quick-chat-panel-message--sent" : "quick-chat-panel-message--received"}`}
                    data-testid={`quick-chat-message-${message.id}`}
                  >
                    <p>{message.content}</p>
                  </div>
                );
              })
            )}
          </div>

          <div className="quick-chat-panel-input">
            <input
              type="text"
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={selectedAgent ? `Message ${selectedAgent.name || selectedAgent.id}` : "Type a message"}
              disabled={!selectedAgentId || isSending}
              data-testid="quick-chat-input"
            />
            <button
              type="button"
              onClick={() => void handleSendMessage()}
              disabled={!selectedAgentId || messageInput.trim().length === 0 || isSending}
              data-testid="quick-chat-send"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
