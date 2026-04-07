import { useState, useCallback } from "react";
import { X, Send, Loader2, Bot, AlertCircle } from "lucide-react";
import type { ParticipantType, MessageType } from "@fusion/core";
import { sendMessage } from "../api";
import type { Agent } from "../api";

// ── Types ─────────────────────────────────────────────────────────────────

interface MessageComposerProps {
  /** Pre-fill recipient (e.g. when replying) */
  recipient?: { id: string; type: ParticipantType } | null;
  /** List of agents for recipient selection */
  agents?: Agent[];
  /** Project ID for multi-project */
  projectId?: string;
  /** Called when message is successfully sent */
  onSend: () => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Toast notification callback */
  addToast?: (msg: string, type?: "success" | "error") => void;
}

const MAX_CONTENT_LENGTH = 2000;

// ── Component ─────────────────────────────────────────────────────────────

export function MessageComposer({
  recipient,
  agents = [],
  projectId,
  onSend,
  onCancel,
  addToast,
}: MessageComposerProps) {
  const [toId, setToId] = useState(recipient?.id ?? "");
  const [toType, setToType] = useState<ParticipantType>(recipient?.type ?? "agent");
  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = toId.trim() !== "" && content.trim().length > 0 && content.length <= MAX_CONTENT_LENGTH;

  const handleSend = useCallback(async () => {
    if (!isValid || isSending) return;

    setIsSending(true);
    setError(null);

    try {
      const messageType: MessageType = toType === "agent" ? "user-to-agent" : "system";
      await sendMessage(
        {
          toId: toId.trim(),
          toType,
          content: content.trim(),
          type: messageType,
        },
        projectId,
      );
      onSend();
    } catch (err: any) {
      const msg = err?.message ?? "Failed to send message";
      setError(msg);
      addToast?.(msg, "error");
    } finally {
      setIsSending(false);
    }
  }, [isValid, isSending, toId, toType, content, projectId, onSend, addToast]);

  const handleAgentSelect = useCallback((agentId: string) => {
    setToId(agentId);
    setToType("agent");
  }, []);

  return (
    <div className="message-composer" data-testid="message-composer">
      <div className="message-composer-header">
        <span>New Message</span>
        <button
          className="btn-icon"
          onClick={onCancel}
          aria-label="Cancel"
          data-testid="message-composer-cancel"
        >
          <X size={16} />
        </button>
      </div>

      <div className="message-composer-body">
        {/* Recipient selection */}
        {!recipient && (
          <div className="message-composer-field">
            <label className="message-composer-label" htmlFor="message-recipient">
              To:
            </label>
            {agents.length > 0 ? (
              <select
                id="message-recipient"
                className="message-composer-select"
                value={toId}
                onChange={(e) => handleAgentSelect(e.target.value)}
                data-testid="message-composer-recipient"
              >
                <option value="">Select agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name || agent.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="message-recipient"
                className="message-composer-input"
                type="text"
                placeholder="Recipient ID"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
                data-testid="message-composer-recipient"
              />
            )}
          </div>
        )}

        {/* Recipient display (when pre-filled from reply) */}
        {recipient && (
          <div className="message-composer-field">
            <span className="message-composer-label">To:</span>
            <span className="message-composer-recipient-fixed">
              <Bot size={14} />
              {recipient.id}
            </span>
          </div>
        )}

        {/* Content */}
        <div className="message-composer-field message-composer-field--content">
          <label className="message-composer-label" htmlFor="message-content">
            Message:
          </label>
          <textarea
            id="message-content"
            className="message-composer-textarea"
            placeholder="Type your message…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={MAX_CONTENT_LENGTH}
            rows={4}
            data-testid="message-composer-content"
          />
          <div className="message-composer-charcount" data-testid="message-composer-charcount">
            <span className={content.length > MAX_CONTENT_LENGTH ? "over-limit" : ""}>
              {content.length}/{MAX_CONTENT_LENGTH}
            </span>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="message-composer-error" data-testid="message-composer-error">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="message-composer-footer">
        <button
          className="btn-sm btn-secondary"
          onClick={onCancel}
          data-testid="message-composer-cancel-btn"
        >
          Cancel
        </button>
        <button
          className="btn-sm btn-primary"
          onClick={handleSend}
          disabled={!isValid || isSending}
          data-testid="message-composer-send"
        >
          {isSending ? (
            <>
              <Loader2 size={14} className="spin" />
              <span>Sending…</span>
            </>
          ) : (
            <>
              <Send size={14} />
              <span>Send</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
