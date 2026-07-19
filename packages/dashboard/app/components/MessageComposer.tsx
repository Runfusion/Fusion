import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAutosizeTextarea } from "../hooks/useAutosizeTextarea";
import { X, Send, Loader2, Bot, AlertCircle } from "lucide-react";
import type { NativeStructureEmbed, NativeStructureRef, ParticipantType, MessageType } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { sendMessage } from "../api";
import type { Agent } from "../api";

// ── Types ─────────────────────────────────────────────────────────────────

export interface NativeStructureCandidate {
  ref: NativeStructureRef;
  label: string;
}

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
  /** Project-scoped structures the mail parent makes available for attachment. */
  nativeStructureCandidates?: NativeStructureCandidate[];
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
  nativeStructureCandidates = [],
}: MessageComposerProps) {
  const { t } = useTranslation("app");
  const [toId, setToId] = useState(recipient?.id ?? "");
  const [toType, setToType] = useState<ParticipantType>(recipient?.type ?? "agent");
  const [content, setContent] = useState("");
  const [wakeRecipient, setWakeRecipient] = useState(false);
  const [nativeStructures, setNativeStructures] = useState<NativeStructureEmbed[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Aligned with ChatView's 640px cap so pasted multi-paragraph messages stay
  // visible without internal scroll.
  const { ref: autosizeRef } = useAutosizeTextarea({
    value: content,
    minHeight: 68,
    maxHeight: 640,
  });

  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    autosizeRef(node);
  }, [autosizeRef]);

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
      const metadata = {
        ...(replyContext ? { replyTo: { messageId: replyContext.messageId } } : {}),
        ...(nativeStructures.length > 0 ? { nativeStructures } : {}),
      };
      const hasMetadata = Object.keys(metadata).length > 0;
      const sendWakeImmediately = wakeImmediately;
      await sendMessage(
        {
          toId: toId.trim(),
          toType,
          content: content.trim(),
          type: messageType,
          ...(hasMetadata ? { metadata } : {}),
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
  }, [isValid, isSending, toId, toType, content, wakeImmediately, replyContext, nativeStructures, projectId, onSend, addToast]);

  const handleAgentSelect = useCallback((agentId: string) => {
    setToId(agentId);
    setToType("agent");
  }, []);

  const attachNativeStructure = useCallback((candidateIndex: string) => {
    const candidate = nativeStructureCandidates[Number(candidateIndex)];
    if (!candidate) return;
    setNativeStructures((current) => [...current, { ...candidate.ref, label: candidate.label }]);
  }, [nativeStructureCandidates]);

  const scrollTextareaIntoView = useCallback(() => {
    if (typeof textareaRef.current?.scrollIntoView !== "function") {
      return;
    }
    textareaRef.current.scrollIntoView({ block: "center", behavior: "auto" });
  }, []);

  useEffect(() => {
    if (!replyContext) {
      return;
    }

    textareaRef.current?.focus();
  }, [replyContext]);

  useEffect(() => {
    if (typeof window === "undefined" || window.visualViewport == null) {
      return;
    }

    window.visualViewport.addEventListener("resize", scrollTextareaIntoView);
    return () => {
      window.visualViewport?.removeEventListener("resize", scrollTextareaIntoView);
    };
  }, [scrollTextareaIntoView]);

  return (
    <div className="message-composer" data-testid="message-composer">
      <div className="message-composer-header">
        <span>{replyContext ? t("composer.replyTitle", "Reply") : t("composer.newMessageTitle", "New Message")}</span>
        <button
          className="btn-icon"
          onClick={onCancel}
          aria-label={t("actions.cancel", "Cancel")}
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
              {t("composer.toLabel", "To:")}
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
                {isLoadingAgents ? t("composer.loadingAgents", "Loading agents…") : agents.length === 0 ? t("composer.noAgentsAvailable", "No agents available") : t("composer.selectAgent", "Select agent…")}
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
            <span className="message-composer-label">{t("composer.toLabel", "To:")}</span>
            <span className="message-composer-recipient-fixed">
              <Bot size={14} />
              {prefilledRecipientAgent?.name || recipient.id}
            </span>
          </div>
        )}

        {replyContext && (
          <div className="message-composer-field" data-testid="message-composer-reply-context">
            <span className="message-composer-label">{t("composer.replyingToLabel", "Replying to:")}</span>
            <span className="message-composer-recipient-fixed">
              {replyContext.preview?.trim() ? replyContext.preview : t("composer.messageId", "Message {{id}}", { id: replyContext.messageId })}
            </span>
          </div>
        )}

        {/* Content */}
        <div className="message-composer-field message-composer-field--content">
          <label className="message-composer-label" htmlFor="message-content">
            {t("composer.messageLabel", "Message:")}
          </label>
          <textarea
            id="message-content"
            ref={setTextareaRef}
            className="message-composer-textarea"
            placeholder={t("composer.messagePlaceholder", "Type your message…")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onFocus={scrollTextareaIntoView}
            maxLength={MAX_CONTENT_LENGTH}
            data-testid="message-composer-content"
          />
          <div className="message-composer-charcount" data-testid="message-composer-charcount">
            <span className={content.length > MAX_CONTENT_LENGTH ? "over-limit" : ""}>
              {content.length}/{MAX_CONTENT_LENGTH}
            </span>
          </div>
        </div>

        {/*
        FNXC:NativeStructureEmbed 2026-07-20-12:00:
        The composer receives project-scoped candidates from its mailbox parent and persists only
        each reference plus label. Selection appends to the draft so reports can carry multiple
        independently reviewable structures without serializing preview payloads.
        */}
        <div className="message-composer-field message-composer-field--structures">
          <label className="message-composer-label" htmlFor="message-native-structure">Attach structure</label>
          <div className="message-composer-structure-controls">
            <select
              id="message-native-structure"
              className="message-composer-select"
              value=""
              disabled={nativeStructureCandidates.length === 0}
              onChange={(event) => attachNativeStructure(event.target.value)}
              data-testid="message-composer-attach-structure"
            >
              <option value="">{nativeStructureCandidates.length === 0 ? "No structures available" : "Select structure…"}</option>
              {nativeStructureCandidates.map((candidate, index) => (
                <option key={`${candidate.ref.kind}:${candidate.ref.id}`} value={index}>{candidate.ref.kind}: {candidate.label}</option>
              ))}
            </select>
            {nativeStructures.length > 0 && (
              <ul className="message-composer-structure-list" data-testid="message-composer-attached-structures">
                {nativeStructures.map((embed, index) => (
                  <li key={`${embed.kind}:${embed.id}:${index}`}>
                    <span>{embed.kind}: {embed.label ?? embed.id}</span>
                    <button className="btn btn-sm btn-secondary" type="button" onClick={() => setNativeStructures((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`Remove ${embed.label ?? embed.id}`}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
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
                {t("composer.wakeAgentCheckbox", "Wake agent immediately")}
                <span className="message-composer-wake-hint" data-testid="message-composer-wake-hint">
                  {recipientAlwaysImmediate
                    ? t("composer.wakeAlwaysImmediate", "(agent is already set to immediate response mode)")
                    : t("composer.wakeOneOff", "(one-off override for this message only)")}
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
          {t("actions.cancel", "Cancel")}
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
              <span>{t("composer.sendingButton", "Sending…")}</span>
            </>
          ) : (
            <>
              <Send size={14} />
              <span>{t("actions.send", "Send")}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
