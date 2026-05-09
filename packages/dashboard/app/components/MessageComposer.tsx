import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { X, Send, Loader2, Bot, AlertCircle } from "lucide-react";
import type { ParticipantType, MessageType } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { sendMessage } from "../api";
import type { Agent } from "../api";

// ── Types ─────────────────────────────────────────────────────────────────

interface MessageComposerProps {
  /** Pre-fill recipient (e.g. when replying) */
  recipient?: { id: string; type: ParticipantType } | null;
  /** Reply context for linked replies */
  replyContext?: { messageId: string; preview?: string } | null;
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
  /** Loading state for agents (shows placeholder) */
  isLoadingAgents?: boolean;
}

const MAX_CONTENT_LENGTH = 2000;

// ── Component ─────────────────────────────────────────────────────────────

export function MessageComposer({
  recipient,
  replyContext,
  agents = [],
  projectId,
  onSend,
  onCancel,
  addToast,
  isLoadingAgents = false,
}: MessageComposerProps) {
  const [toId, setToId] = useState(recipient?.id ?? "");
  const [toType, setToType] = useState<ParticipantType>(recipient?.type ?? "agent");
  const [content, setContent] = useState("");
  const [wakeRecipient, setWakeRecipient] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === toId), [agents, toId]);
  const prefilledRecipientAgent = useMemo(
    () => (recipient ? agents.find((agent) => agent.id === recipient.id) : undefined),
    [agents, recipient],
  );
  const recipientIsAgent = toType === "agent";
  const recipientAlwaysImmediate = recipientIsAgent && selectedAgent?.runtimeConfig?.messageResponseMode === "immediate";
  const wakeImmediately = recipientIsAgent && (wakeRecipient || recipientAlwaysImmediate);

  const isValid = toId.trim() !== "" && content.trim().length > 0 && content.length <= MAX_CONTENT_LENGTH;

  const handleSend = useCallback(async () => {
    if (!isValid || isSending) return;

    setIsSending(true);
    setError(null);

    try {
      const messageType: MessageType = toType === "agent" ? "user-to-agent" : "system";
      const metadata =
        replyContext
          ? { replyTo: { messageId: replyContext.messageId } }
          : undefined;
      const sendWakeImmediately = wakeImmediately;
      await sendMessage(
        {
          toId: toId.trim(),
          toType,
          content: content.trim(),
          type: messageType,
          ...(metadata ? { metadata } : {}),
          ...(sendWakeImmediately ? { wakeImmediately: true } : {}),
        },
        projectId,
      );
      onSend();
    } catch (err) {
      const msg = getErrorMessage(err) || "Failed to send message";
      setError(msg);
      addToast?.(msg, "error");
    } finally {
      setIsSending(false);
    }
  }, [isValid, isSending, toId, toType, content, wakeImmediately, replyContext, projectId, onSend, addToast]);

  const handleAgentSelect = useCallback((agentId: string) => {
    setToId(agentId);
    setToType("agent");
  }, []);

  useEffect(() => {
    if (!replyContext) {
      return;
    }

    textareaRef.current?.focus();
  }, [replyContext]);

  useEffect(() => {
    if (!replyContext || typeof window === "undefined" || window.visualViewport == null) {
      return;
    }

    const handleVisualViewportResize = () => {
      textareaRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    };

    window.visualViewport.addEventListener("resize", handleVisualViewportResize);
    return () => {
      window.visualViewport?.removeEventListener("resize", handleVisualViewportResize);
    };
  }, [replyContext]);

  return (
    <div className="message-composer" data-testid="message-composer">
      <div className="message-composer-header">
        <span>{replyContext ? "Reply" : "New Message"}</span>
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
            <select
              id="message-recipient"
              className="message-composer-select"
              value={toId}
              onChange={(e) => handleAgentSelect(e.target.value)}
              disabled={isLoadingAgents || agents.length === 0}
              data-testid="message-composer-recipient"
            >
              <option value="">
                {isLoadingAgents ? "Loading agents…" : agents.length === 0 ? "No agents available" : "Select agent…"}
              </option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name || agent.id}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Recipient display (when pre-filled from reply) */}
        {recipient && (
          <div className="message-composer-field">
            <span className="message-composer-label">To:</span>
            <span className="message-composer-recipient-fixed">
              <Bot size={14} />
              {prefilledRecipientAgent?.name || recipient.id}
            </span>
          </div>
        )}

        {replyContext && (
          <div className="message-composer-field" data-testid="message-composer-reply-context">
            <span className="message-composer-label">Replying to:</span>
            <span className="message-composer-recipient-fixed">
              {replyContext.preview?.trim() ? replyContext.preview : `Message ${replyContext.messageId}`}
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
            ref={textareaRef}
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

        {/* Wake recipient toggle (agents only) */}
        {recipientIsAgent && (
          <div className="message-composer-field message-composer-field--wake">
            <label className="message-composer-wake-label">
              <input
                type="checkbox"
                checked={wakeImmediately}
                disabled={recipientAlwaysImmediate}
                onChange={(e) => setWakeRecipient(e.target.checked)}
                data-testid="message-composer-wake"
              />
              <span>
                Wake agent immediately
                <span className="message-composer-wake-hint" data-testid="message-composer-wake-hint">
                  {recipientAlwaysImmediate
                    ? "(agent is already set to immediate response mode)"
                    : "(one-off override for this message only)"}
                </span>
              </span>
            </label>
          </div>
        )}

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
          className="btn btn-sm btn-secondary"
          onClick={onCancel}
          data-testid="message-composer-cancel-btn"
        >
          Cancel
        </button>
        <button
          className="btn btn-sm btn-primary"
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
