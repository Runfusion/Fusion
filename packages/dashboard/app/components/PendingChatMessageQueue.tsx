import React, { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Pencil, Send, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./PendingChatMessageQueue.css";

export interface PendingChatMessageQueueProps {
  messages?: readonly string[];
  disabled?: boolean;
  onEdit: (index: number, content: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (index: number) => void;
  onForceSend: (index: number) => void;
  /** Stable test ids for the two hosts without coupling this component to either host. */
  testIdPrefix?: string;
}

function previewMessage(message: string): string {
  return message.length > 50 ? `${message.slice(0, 50)}…` : message;
}

/**
 * FNXC:ChatPendingQueue 2026-08-19-05:47:
 * Direct and Planner model-loop chats share this presentation-only queue. Callers keep ownership
 * of session fences, persistence, and cancellation; this component only manages indexed editing
 * state so duplicate text remains addressable and an empty queue renders no interaction shell.
 */
export function PendingChatMessageQueue({
  messages,
  disabled = false,
  onEdit,
  onMove,
  onDelete,
  onForceSend,
  testIdPrefix = "pending-chat-message-queue",
}: PendingChatMessageQueueProps) {
  const { t } = useTranslation("app");
  const visibleMessages = (messages ?? []).filter((message) => typeof message === "string" && message.trim().length > 0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (editingIndex !== null && editingIndex >= visibleMessages.length) {
      setEditingIndex(null);
      setEditingText("");
      setEditError(null);
    }
  }, [editingIndex, visibleMessages.length]);

  if (visibleMessages.length === 0) return null;

  const beginEdit = (index: number) => {
    if (disabled) return;
    setEditingIndex(index);
    setEditingText(visibleMessages[index] ?? "");
    setEditError(null);
  };

  const saveEdit = (index: number) => {
    const content = editingText.trim();
    if (!content) {
      setEditError(t("chat.pendingEditEmpty", "Queued messages cannot be empty"));
      return;
    }
    onEdit(index, content);
    setEditingIndex(null);
    setEditingText("");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingText("");
    setEditError(null);
  };

  const rootTestId = testIdPrefix === "chat-pending" ? "chat-pending-stack" : `${testIdPrefix}-list`;
  const itemTestId = testIdPrefix === "chat-pending"
    ? ("chat-pending-indicator" as const)
    : (index: number) => `${testIdPrefix}-message-${index}`;

  return (
    <section
      className="pending-chat-message-queue chat-pending-stack"
      data-testid={rootTestId}
      aria-label={t("chat.pendingLabel", "Pending messages")}
    >
      <div className="pending-chat-message-queue-divider chat-pending-divider" aria-hidden="true" />
      <h6 className="pending-chat-message-queue-heading">{t("chat.pendingHeading", "Pending messages")}</h6>
      <ol className="pending-chat-message-queue-items">
        {visibleMessages.map((pendingMessage, index) => {
          const isEditing = editingIndex === index;
          const itemId = typeof itemTestId === "function" ? itemTestId(index) : itemTestId;
          return (
            <li
              className="pending-chat-message-queue-item chat-pending-message"
              data-testid={itemId}
              key={`${index}-${pendingMessage}`}
            >
              {isEditing ? (
                <input
                  className="input pending-chat-message-queue-edit-input"
                  aria-label={`${t("chat.editPending", "Edit queued message")} ${index + 1}`}
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  disabled={disabled}
                  autoFocus
                />
              ) : (
                <span className="pending-chat-message-queue-text chat-pending-message-text">
                  <span>{t("chat.queuedMessage", "Queued: {{preview}}", { preview: "" }).replace("{{preview}}", "")}</span>
                  <span>{previewMessage(pendingMessage)}</span>
                </span>
              )}
              <div className="pending-chat-message-queue-actions">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => saveEdit(index)}
                      disabled={disabled}
                      aria-label={t("chat.savePendingEdit", "Save queued message")}
                      data-testid={`${testIdPrefix}-save-${index}`}
                    >
                      <Check aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={cancelEdit}
                      disabled={disabled}
                      aria-label={t("chat.cancelPendingEdit", "Cancel queued message edit")}
                      data-testid={`${testIdPrefix}-cancel-${index}`}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-icon btn-sm"
                    onClick={() => beginEdit(index)}
                    disabled={disabled}
                    aria-label={`${t("chat.editPending", "Edit queued message")} ${index + 1}`}
                    data-testid={`${testIdPrefix}-edit-${index}`}
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-icon btn-sm"
                  onClick={() => onMove(index, -1)}
                  disabled={disabled || index === 0}
                  aria-label={`${t("chat.movePendingEarlier", "Move queued message earlier")} ${index + 1}`}
                  data-testid={`${testIdPrefix}-up-${index}`}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-sm"
                  onClick={() => onMove(index, 1)}
                  disabled={disabled || index === visibleMessages.length - 1}
                  aria-label={`${t("chat.movePendingLater", "Move queued message later")} ${index + 1}`}
                  data-testid={`${testIdPrefix}-down-${index}`}
                >
                  <ArrowDown aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-sm"
                  onClick={() => onDelete(index)}
                  disabled={disabled}
                  aria-label={`${t("chat.deletePending", "Delete queued message")} ${index + 1}`}
                  data-testid={testIdPrefix === "chat-pending" ? `chat-pending-dismiss-${index}` : `${testIdPrefix}-delete-${index}`}
                >
                  <Trash2 aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm pending-chat-message-queue-force"
                  onClick={() => onForceSend(index)}
                  disabled={disabled}
                  aria-label={`${t("chat.forcePending", "Force send queued message")} ${index + 1}`}
                  data-testid={`${testIdPrefix}-force-${index}`}
                >
                  <Send aria-hidden="true" />
                  <span>{t("chat.forcePendingShort", "Force send")}</span>
                </button>
              </div>
              {isEditing && editError && <div className="pending-chat-message-queue-error" role="alert">{editError}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
