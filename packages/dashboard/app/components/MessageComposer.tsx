import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAutosizeTextarea } from "../hooks/useAutosizeTextarea";
import { X, Send, Loader2, Bot, AlertCircle } from "lucide-react";
import type { DragEvent } from "react";
import type { NativeStructureEmbed, NativeStructureRef, ParticipantType, MessageType } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { sendMessage } from "../api";
import type { Agent } from "../api";
import { NativeStructurePreview } from "./NativeStructurePreview";
import { ComposeChatPanel } from "./ComposeChatPanel";
import { openNativeStructure } from "./nativeStructureNavigation";
import { hasNativeStructureDrag, readNativeStructureRef } from "../utils/nativeStructureDrag";
import "./MessageComposer.css";

// ── Types ─────────────────────────────────────────────────────────────────

export interface NativeStructureCandidate {
  ref: NativeStructureRef;
  label: string;
}

export interface MessageComposerProps {
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
  /** Optional chat-to-mail report prefill. */
  initialMode?: "quick" | "report";
  initialContent?: string;
  initialReportTitle?: string;
  prefillNonce?: number;
}

const MAX_CONTENT_LENGTH = 2000;

/**
 * FNXC:NativeStructureProjectIsolation 2026-08-09-05:13:
 * DataTransfer is controlled by foreign windows and attackers. The parser validates only shape, so
 * this consumer rejects foreign project refs and stamps unscoped refs before they enter mail metadata.
 */
export function resolveDroppedNativeStructureRef(ref: NativeStructureRef | null, projectId?: string): NativeStructureRef | null {
  if (!ref) return null;
  if (!projectId) return ref;
  if (ref.projectId && ref.projectId !== projectId) return null;
  return { ...ref, projectId };
}

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
  initialMode = "quick",
  initialContent = "",
  initialReportTitle = "",
  prefillNonce,
}: MessageComposerProps) {
  const { t } = useTranslation("app");
  const [toId, setToId] = useState(recipient?.id ?? "");
  const [toType, setToType] = useState<ParticipantType>(recipient?.type ?? "agent");
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<"quick" | "report">(initialMode);
  const [reportTitle, setReportTitle] = useState(initialReportTitle);
  const sectionIdRef = useRef(0);
  const [sections, setSections] = useState<Array<{ id: number; heading: string; body: string }>>([]);
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

    setError(null);
    const reportSections = sections.filter((section) => section.heading.trim() || section.body.trim());
    if (mode === "report") {
      if (!reportTitle.trim()) { setError("A report needs a title"); return; }
      // FNXC:StructuralMail 2026-08-09-12:41: FN-8870 rejects empty report section arrays, so report-mode composition must stop locally rather than issuing a request the shared metadata validator cannot accept.
      if (reportSections.length === 0) { setError("A report needs at least one section"); return; }
      if (reportSections.some((section) => !section.heading.trim() || !section.body.trim())) { setError("Every report section needs a heading and a body"); return; }
    }
    setIsSending(true);

    try {
      const messageType: MessageType = toType === "agent" ? "user-to-agent" : "system";
      const metadata = {
        ...(replyContext ? { replyTo: { messageId: replyContext.messageId } } : {}),
        ...(nativeStructures.length > 0 ? { nativeStructures } : {}),
        ...(mode === "report" ? { mailKind: "report" as const, report: { title: reportTitle.trim(), sections: reportSections.map(({ heading, body }) => ({ heading: heading.trim(), body: body.trim() })) } } : {}),
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
  }, [isValid, isSending, toId, toType, content, wakeImmediately, replyContext, nativeStructures, projectId, onSend, addToast, mode, reportTitle, sections]);

  const handleAgentSelect = useCallback((agentId: string) => {
    setToId(agentId);
    setToType("agent");
  }, []);

  const addNativeStructure = useCallback((ref: NativeStructureRef, label?: string) => {
    setNativeStructures((current) => (
      current.some((embed) => embed.kind === ref.kind && embed.id === ref.id)
        ? current
        : [...current, { ...ref, ...(label ? { label } : {}) }]
    ));
  }, []);

  const attachNativeStructure = useCallback((candidateIndex: string) => {
    const candidate = nativeStructureCandidates[Number(candidateIndex)];
    if (candidate) addNativeStructure(candidate.ref, candidate.label);
  }, [addNativeStructure, nativeStructureCandidates]);

  const [isNativeStructureDragOver, setIsNativeStructureDragOver] = useState(false);
  const [isComposeChatOpen, setIsComposeChatOpen] = useState(initialMode === "report");

  useEffect(() => {
    if (prefillNonce === undefined) return;
    setMode(initialMode);
    setContent(initialContent);
    setReportTitle(initialReportTitle);
    setSections([]);
    setIsComposeChatOpen(initialMode === "report");
  }, [prefillNonce, initialContent, initialMode, initialReportTitle]);

  /*
  FNXC:NativeStructureEmbed 2026-07-22-10:30:
  Desktop drags attach the same deduplicated embed state as the keyboard/mobile picker below.
  Non-native payloads are deliberately not prevented so file and other browser drops retain their behavior.
  */
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasNativeStructureDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsNativeStructureDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsNativeStructureDragOver(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasNativeStructureDrag(event.dataTransfer)) return;
    event.preventDefault();
    setIsNativeStructureDragOver(false);
    const ref = resolveDroppedNativeStructureRef(readNativeStructureRef(event.dataTransfer), projectId);
    if (ref) addNativeStructure(ref);
  }, [addNativeStructure, projectId]);

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
    <div
      className={`message-composer${isNativeStructureDragOver ? " message-composer--native-structure-drag-over" : ""}`}
      data-testid="message-composer"
      aria-label="Message composer; drop a structure to attach it"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
        {/* FNXC:StructuralMail 2026-08-09-12:41: Quick mail remains the default and never adds metadata; report validation stays at send time so recipient gating remains independent. FN-8870 requires at least one complete section for structural reports. */}
        <div className="message-composer-mode" role="group" aria-label="Message mode">
          <button type="button" className="btn btn-sm btn-secondary" aria-pressed={mode === "quick"} data-testid="message-composer-mode-quick" onClick={() => { setMode("quick"); setIsComposeChatOpen(false); }}>Quick message</button>
          <button type="button" className="btn btn-sm btn-secondary" aria-pressed={mode === "report"} data-testid="message-composer-mode-report" onClick={() => { setMode("report"); setIsComposeChatOpen(true); }}>Report</button>
        </div>
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

        {mode === "report" && <div className="message-composer-report" data-testid="message-composer-report">
          <div className="message-composer-field"><label className="message-composer-label" htmlFor="report-title">Report title</label><input id="report-title" className="input" value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} data-testid="report-title" /></div>
          {sections.map((section) => <div className="message-composer-report-section" key={section.id}>
            <input className="input" value={section.heading} placeholder="Section heading" onChange={(event) => setSections((current) => current.map((item) => item.id === section.id ? { ...item, heading: event.target.value } : item))} data-testid={`report-section-heading-${section.id}`} />
            <textarea className="message-composer-textarea" value={section.body} placeholder="Section body" onChange={(event) => setSections((current) => current.map((item) => item.id === section.id ? { ...item, body: event.target.value } : item))} data-testid={`report-section-body-${section.id}`} />
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSections((current) => current.filter((item) => item.id !== section.id))} data-testid={`report-section-remove-${section.id}`}>Remove section</button>
          </div>)}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSections((current) => [...current, { id: sectionIdRef.current++, heading: "", body: "" }])} data-testid="report-section-add">Add section</button>
        </div>}

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
        The picker is the accessible keyboard/mobile fallback for the desktop drag protocol.
        Both paths append only a reference plus captured label, dedupe by kind/id, and share the
        persisted message metadata so reports carry first-class, independently reviewable embeds.
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
                {nativeStructures.map((embed) => (
                  <li key={`${embed.kind}:${embed.id}`}>
                    <NativeStructurePreview
                      ref={{ kind: embed.kind, id: embed.id, projectId: embed.projectId }}
                      capturedLabel={embed.label}
                      onOpen={openNativeStructure}
                    />
                    <button className="btn btn-sm btn-secondary" type="button" onClick={() => setNativeStructures((current) => current.filter((currentEmbed) => currentEmbed.kind !== embed.kind || currentEmbed.id !== embed.id))} aria-label={`Remove ${embed.label ?? embed.id}`}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="message-composer-field">
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => setIsComposeChatOpen((open) => !open)} aria-expanded={isComposeChatOpen} aria-controls="compose-chat-panel">
            {isComposeChatOpen ? "Hide compose chat" : "Draft with AI"}
          </button>
          {isComposeChatOpen && (
            <ComposeChatPanel
              projectId={projectId}
              embeds={nativeStructures}
              draftBody={mode === "report" ? `Report: ${reportTitle}\n${sections.map((section) => section.heading).filter(Boolean).join("\n")}\n${content}` : content}
              onUseDraft={(draft) => {
                if (content.trim() && !window.confirm("Replace the message you have already typed with this draft?")) return;
                setContent(draft);
              }}
              onClose={() => setIsComposeChatOpen(false)}
            />
          )}
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
