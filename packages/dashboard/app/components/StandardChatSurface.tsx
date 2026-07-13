import type { Agent } from "@fusion/core";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpToLine, Bot, File, Pencil, Send, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatMessageInfo, FailureInfo, ToolCallInfo } from "../hooks/chatTypes";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { parseQuestionToolCall } from "../utils/parseQuestionToolCall";
import { ChatQuestionResponse } from "./ChatQuestionResponse";
import { ProviderIcon } from "./ProviderIcon";

export interface StandardRoomContext {
  roomName: string;
  memberIds: ReadonlySet<string>;
}

export interface StandardChatMessageItemProps {
  message: ChatMessageInfo;
  forcePlain: boolean;
  agentName: string;
  hideAssistantIdentity: boolean;
  showAssistantModelTag: boolean;
  activeModelTag: string | null;
  activeModelProvider: string | null;
  activeSessionId: string | null;
  mentionAgentsByName?: Map<string, Agent>;
  roomContext?: StandardRoomContext | null;
  copyAction?: ReactNode;
  onScrollToTop?: (messageId: string) => void;
  /**
   * FNXC:ChatMessageScrollToTop 2026-07-12-23:09:
   * ChatView owns scroll-container measurement and sets this when the message top is clipped above the visible container top. StandardChatSurface keeps eligible go-to-top controls mounted for tests/accessibility wiring but hides them until this state is true, and renders the control inline with the Thinking row instead of a standalone action line.
   */
  isTopClipped?: boolean;
  isAwaitingQuestionAnswer?: boolean;
  submittedQuestionAnswer?: string;
  onQuestionSubmit?: (answerText: string, structured: Record<string, unknown>) => void;
  toolCallRenderer?: (toolCall: ToolCallInfo, index: number) => ReactNode | undefined;
  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * When set together with `canEdit`, a user message renders an edit affordance that swaps its
   * content for an inline textarea. Saving calls this with the edited text; the caller is
   * responsible for truncating server + local history from this message onward and resending
   * (see useChat.editMessageAndResend) so the model forgets everything after the edited turn.
   * Only rendered for `role === "user"` messages — never for assistant/system messages.
   */
  onEditMessage?: (messageId: string, newContent: string) => void | Promise<void>;
  /**
   * Gate for whether editing is currently supported/allowed for this message's surface (direct
   * model-loop chat, not Rooms or CLI-agent sessions) and state (not while streaming). When
   * false or `onEditMessage` is absent, no affordance renders at all — never a disabled/dead one.
   */
  canEdit?: boolean;
}

export interface StandardStreamingMessageProps {
  streamingText: string;
  streamingThinking?: string;
  streamingToolCalls?: ToolCallInfo[];
  forcePlain: boolean;
  agentName: string;
  hideAssistantIdentity: boolean;
  showAssistantModelTag: boolean;
  activeModelTag: string | null;
  activeModelProvider: string | null;
  copyAction?: ReactNode;
  onQuestionSubmit?: (answerText: string, structured: Record<string, unknown>) => void;
  toolCallRenderer?: (toolCall: ToolCallInfo, index: number) => ReactNode | undefined;
}

export interface StandardChatActionButtonProps {
  isStreaming: boolean;
  canSend: boolean;
  onSend: () => void | Promise<void>;
  onStop?: () => void;
  sendLabel?: string;
  stopLabel?: string;
  classNameSend?: string;
  classNameStop?: string;
  showSendText?: boolean;
  /**
   * FNXC:StandardChatSurface 2026-07-07-00:00:
   * Send and Stop visible-text are independently controllable so callers like
   * the planner (FN-7655) can render the Stop button icon-only while keeping
   * the Send button's text label. Defaults to `showSendText` when unset so
   * existing callers keep prior combined behavior (accessible name via
   * aria-label is always preserved regardless of this flag).
   */
  showStopText?: boolean;
  sendTestId?: string;
  stopTestId?: string;
}

/**
 * FNXC:StandardChatSurface 2026-07-01-09:31:
 * Task-detail planner Chat must reuse the standard Chat message, thinking, tool-call, and mobile send/stop surface without statically importing the lazy ChatView chunk. Keep this module presentation-only so ChatView can stay lazy while TaskPlannerChatTab preserves task-scoped planner session lifecycle.
 */
export function formatModelTag(provider?: string | null, modelId?: string | null): string | null {
  if (!provider || !modelId) return null;
  const normalizedModel = modelId.toLowerCase();
  if (normalizedModel.includes("claude")) {
    const formatted = modelId
      .replace(/^claude[- ]/i, "Claude ")
      .replace(/sonnet[- ](\d+)[- ](\d+)/i, "Sonnet $1.$2")
      .replace(/sonnet[- ](\d+)/i, "Sonnet $1")
      .replace(/haiku[- ](\d+)/i, "Haiku $1")
      .replace(/opus[- ](\d+)/i, "Opus $1")
      .replace(/sonnet/i, "Sonnet")
      .replace(/haiku/i, "Haiku")
      .replace(/opus/i, "Opus")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return formatted.length > 30 ? `${formatted.slice(0, 30)}…` : formatted;
  }
  if (normalizedModel.includes("gpt") || normalizedModel.includes("openai")) {
    const formatted = modelId
      .replace(/^gpt-4-turbo$/i, "GPT-4 Turbo")
      .replace(/^gpt-4o-mini$/i, "GPT-4o Mini")
      .replace(/^gpt-4o$/i, "GPT-4o")
      .replace(/^gpt-4$/i, "GPT-4")
      .replace(/^gpt-o1-preview$/i, "GPT-o1 Preview")
      .replace(/^gpt-o1-mini$/i, "GPT-o1 Mini")
      .replace(/^gpt-o1$/i, "GPT-o1")
      .replace(/^gpt/i, "GPT")
      .trim();
    return formatted.length > 30 ? `${formatted.slice(0, 30)}…` : formatted;
  }
  if (normalizedModel.includes("gemini")) {
    const formatted = modelId
      .replace(/^gemini[- ]/i, "Gemini ")
      .replace(/pro[- ](\d+)[- ](\d+)/i, "Pro $1.$2")
      .replace(/pro[- ](\d+)/i, "Pro $1")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return formatted.length > 30 ? `${formatted.slice(0, 30)}…` : formatted;
  }
  const formatted = modelId.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
  return formatted.length > 30 ? `${formatted.slice(0, 30)}…` : formatted;
}

function truncateToolValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function formatToolArgsSummary(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => {
    const stringValue = typeof value === "string" ? value : (() => {
      try { return JSON.stringify(value); } catch { return String(value); }
    })();
    return `${key}=${truncateToolValue(stringValue, 50)}`;
  }).join(", ");
}

function formatToolResultSummary(result: unknown): string | null {
  if (result === undefined) return null;
  if (typeof result === "string") return truncateToolValue(result, 200);
  try { return truncateToolValue(JSON.stringify(result), 200); } catch { return truncateToolValue(String(result), 200); }
}

function buildFailureReferenceHref(reference: FailureInfo["reference"]): string | null {
  if (!reference) return null;
  if (reference.kind === "mailbox" || reference.kind === "mailbox-message") {
    const pathname = typeof window === "undefined" ? "/" : window.location.pathname || "/";
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    params.set("view", "mailbox");
    params.set("mailbox-message", reference.id);
    return `${pathname}?${params.toString()}#message-${encodeURIComponent(reference.id)}`;
  }
  return null;
}

function renderFailureReference(reference: FailureInfo["reference"], t: (key: string, defaultValue: string) => string): ReactNode {
  if (!reference) return null;
  const referenceLabel = reference.label ?? `${reference.kind} ${reference.id}`;
  const referenceHref = buildFailureReferenceHref(reference);
  const referenceDetailsId = `chat-failure-reference-${reference.kind}-${reference.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
  return (
    <div className="chat-message-failure-reference">
      <span className="chat-message-failure-reference-label">{t("chat.failureReferenceLabel", "Reference")}</span>
      <span className="chat-message-failure-reference-value">{referenceLabel}</span>
      {referenceHref ? (
        <a className="btn btn-sm chat-message-failure-reference-link" href={referenceHref}>{t("chat.openMailboxMessage", "Open mailbox message")}</a>
      ) : (
        <details className="chat-message-failure-reference-details">
          <summary className="btn btn-sm chat-message-failure-reference-link">{t("chat.viewFailureDetails", "View failure details")}</summary>
          <dl className="chat-message-failure-reference-meta" id={referenceDetailsId}>
            <div><dt>{t("chat.failureReferenceKind", "Kind")}</dt><dd>{reference.kind}</dd></div>
            <div><dt>{t("chat.failureReferenceId", "ID")}</dt><dd>{reference.id}</dd></div>
            {reference.label && <div><dt>{t("chat.failureReferenceMetaLabel", "Label")}</dt><dd>{reference.label}</dd></div>}
          </dl>
        </details>
      )}
    </div>
  );
}

export function renderStandardToolCalls(
  toolCalls: ToolCallInfo[] | undefined,
  t: (key: string, defaultValue: string, opts?: Record<string, unknown>) => string,
  options?: {
    isAwaitingAnswer?: boolean;
    submittedAnswer?: string;
    onQuestionSubmit?: (answerText: string, structured: Record<string, unknown>) => void;
    toolCallRenderer?: (toolCall: ToolCallInfo, index: number) => ReactNode | undefined;
  },
): ReactNode {
  if (!toolCalls || toolCalls.length === 0) return null;
  /*
  FNXC:StandardChatSurface 2026-07-01-09:20:
  Planner Chat and regular Chat must surface `fn_ask_question` as an actionable ChatQuestionResponse even when the model also calls tools such as `bash`. Question cards render outside the collapsed grouped tool-call details so users are not stranded on summary text, while non-question tools keep their generic visibility.
  */
  const renderToolCallItem = (toolCall: ToolCallInfo, index: number) => {
    const custom = options?.toolCallRenderer?.(toolCall, index);
    if (custom !== undefined) return custom;
    const parsedQuestion = parseQuestionToolCall(toolCall);
    if (parsedQuestion) {
      const isAwaitingAnswer = options?.isAwaitingAnswer === true;
      return (
        <ChatQuestionResponse
          key={`${toolCall.toolName}-${index}`}
          parsed={parsedQuestion}
          answered={!isAwaitingAnswer}
          submittedAnswer={options?.submittedAnswer}
          disabled={!isAwaitingAnswer}
          onSubmit={(answerText, structured) => options?.onQuestionSubmit?.(answerText, structured)}
        />
      );
    }
    const isRunning = toolCall.status === "running";
    const isError = toolCall.status === "completed" && toolCall.isError;
    const argsSummary = formatToolArgsSummary(toolCall.args);
    const resultSummary = formatToolResultSummary(toolCall.result);
    const summaryPreview = isRunning ? argsSummary : resultSummary ? `${t("chat.toolCallResultPrefix", "result")}: ${resultSummary}` : argsSummary ? `${t("chat.toolCallArgsPrefix", "args")}: ${argsSummary}` : null;
    const statusLabel = isRunning ? t("chat.toolCallStatusRunning", "running") : isError ? t("chat.toolCallStatusError", "error") : t("chat.toolCallStatusCompleted", "completed");
    return (
      <details key={`${toolCall.toolName}-${index}`} className={`chat-tool-call${isRunning ? " chat-tool-call--running" : ""}${isError ? " chat-tool-call--error" : ""}`} open={isRunning}>
        <summary>
          <span className="chat-tool-call-status-dot" aria-hidden="true" />
          <span className="chat-tool-call-name" title={toolCall.toolName}>{toolCall.toolName}</span>
          {summaryPreview && <span className="chat-tool-call-preview" title={summaryPreview}>{summaryPreview}</span>}
          <span className="chat-tool-call-status-text">{statusLabel}</span>
        </summary>
        <div className="chat-tool-call-content">
          {argsSummary && <div className="chat-tool-call-row"><span className="chat-tool-call-label">{t("chat.toolCallArgsPrefix", "args")}</span><span className="chat-tool-call-value">{argsSummary}</span></div>}
          {resultSummary && <div className={`chat-tool-call-row${isError ? " chat-tool-call-row--error" : ""}`}><span className="chat-tool-call-label">{t("chat.toolCallResultPrefix", "result")}</span><span className="chat-tool-call-value">{resultSummary}</span></div>}
        </div>
      </details>
    );
  };
  const questionEntries: ReactNode[] = [];
  const nonQuestionEntries: Array<{ toolCall: ToolCallInfo; index: number }> = [];
  toolCalls.forEach((toolCall, index) => {
    if (parseQuestionToolCall(toolCall)) {
      const renderedQuestion = renderToolCallItem(toolCall, index);
      if (renderedQuestion !== null && renderedQuestion !== undefined && renderedQuestion !== false) {
        questionEntries.push(renderedQuestion);
      }
      return;
    }
    nonQuestionEntries.push({ toolCall, index });
  });
  const renderNonQuestionToolCalls = (): ReactNode => {
    if (nonQuestionEntries.length === 0) return null;
    if (nonQuestionEntries.length === 1) {
      const entry = nonQuestionEntries[0]!;
      return <div className="chat-tool-calls" data-testid="chat-tool-calls"><div className="chat-tool-calls-header"><span className="chat-tool-calls-header-icon" aria-hidden="true">•</span><span>{t("chat.toolCallsHeader", "Tool calls")}</span></div>{renderToolCallItem(entry.toolCall, entry.index)}</div>;
    }
    const nonQuestionToolCalls = nonQuestionEntries.map((entry) => entry.toolCall);
    const runningCount = nonQuestionToolCalls.filter((toolCall) => toolCall.status === "running").length;
    const errorCount = nonQuestionToolCalls.filter((toolCall) => toolCall.status === "completed" && toolCall.isError).length;
    const hasRunning = runningCount > 0;
    const uniqueNames = Array.from(new Set(nonQuestionToolCalls.map((toolCall) => toolCall.toolName)));
    const visibleNames = uniqueNames.slice(0, 5);
    const overflowCount = Math.max(0, uniqueNames.length - visibleNames.length);
    const namesSummary = overflowCount > 0 ? `${visibleNames.join(", ")}, +${overflowCount} more` : visibleNames.join(", ");
    const statusSummary = hasRunning ? `(${runningCount} ${t("chat.toolCallStatusRunning", "running")})` : errorCount > 0 ? `(${errorCount} ${errorCount === 1 ? t("chat.toolCallStatusError", "error") : t("chat.toolCallStatusErrors", "errors")})` : null;
    return (
      <div className="chat-tool-calls" data-testid="chat-tool-calls">
        <details className="chat-tool-calls-group" data-testid="chat-tool-calls-group" open={hasRunning}>
          <summary className="chat-tool-calls-group-summary">
            <span className="chat-tool-calls-header-icon" aria-hidden="true">•</span>
            <span className="chat-tool-calls-count">{t("chat.toolCallsCount", "{{count}} tool calls", { count: nonQuestionToolCalls.length })}</span>
            <span className="chat-tool-calls-names" title={namesSummary}>{namesSummary}</span>
            {statusSummary && <span className="chat-tool-calls-group-status">{statusSummary}</span>}
          </summary>
          {nonQuestionEntries.map(({ toolCall, index }) => renderToolCallItem(toolCall, index))}
        </details>
      </div>
    );
  };
  const renderedNonQuestionToolCalls = renderNonQuestionToolCalls();
  if (questionEntries.length === 0) return renderedNonQuestionToolCalls;
  return (
    <>
      {questionEntries}
      {renderedNonQuestionToolCalls}
    </>
  );
}

export const standardChatMarkdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  pre: ({ children, ...props }) => <pre {...props} className="chat-markdown-pre">{children}</pre>,
  code: ({ children, ...props }) => {
    const text = typeof children === "string" ? children : React.Children.toArray(children).join("");
    const linkedChildren = linkifyFilePaths(text);
    if (linkedChildren.length === 1 && typeof linkedChildren[0] === "string") return <code {...props}>{children}</code>;
    return <code {...props}>{linkedChildren}</code>;
  },
  table: ({ children, ...props }) => <table {...props} className="chat-markdown-table">{children}</table>,
};

function formatRelativeTime(dateStr: string, t: (key: string, defaultValue: string, opts?: Record<string, unknown>) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffSecs = Math.floor((now.getTime() - date.getTime()) / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffSecs < 60) return t("chat.relativeTimeJustNow", "just now");
  if (diffMins < 60) return t("chat.relativeTimeMinutes", "{{count}}m ago", { count: diffMins });
  if (diffHours < 24) return t("chat.relativeTimeHours", "{{count}}h ago", { count: diffHours });
  if (diffDays < 7) return t("chat.relativeTimeDays", "{{count}}d ago", { count: diffDays });
  return date.toLocaleDateString();
}

export function renderStandardAssistantContent(content: string, forcePlain: boolean): ReactNode {
  if (forcePlain) return <div className="chat-message-content chat-message-content--plain">{content}</div>;
  return <div className="chat-message-content chat-message-content--markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={standardChatMarkdownComponents}>{content}</ReactMarkdown></div>;
}

export const StandardChatMessageItem = memo(function StandardChatMessageItem({
  message,
  forcePlain,
  agentName,
  hideAssistantIdentity,
  showAssistantModelTag,
  activeModelTag,
  activeModelProvider,
  activeSessionId,
  mentionAgentsByName = new Map(),
  roomContext = null,
  copyAction,
  onScrollToTop,
  isAwaitingQuestionAnswer = false,
  submittedQuestionAnswer,
  onQuestionSubmit,
  toolCallRenderer,
  onEditMessage,
  canEdit = false,
  isTopClipped = false,
}: StandardChatMessageItemProps) {
  const { t } = useTranslation("app");
  const isAssistantMessage = message.role === "assistant";
  const isUserMessage = message.role === "user";
  /*
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Edit affordance is scoped strictly to user messages on surfaces that opt in via both
   * `canEdit` and `onEditMessage`; absent either, `showEditAction` is false and nothing renders
   * (no dead button, no empty shell) — e.g. assistant/system messages, Rooms, CLI-agent chat, or
   * while a generation is streaming. The compact pencil renders in the timestamp footer so user
   * bubbles do not grow an extra action row above their time metadata.
   */
  const showEditAction = isUserMessage && canEdit && Boolean(onEditMessage);
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(message.content);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const startEditing = useCallback(() => {
    setEditedText(message.content);
    setIsEditing(true);
  }, [message.content]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditedText(message.content);
  }, [message.content]);

  const saveEdit = useCallback(() => {
    const trimmed = editedText.trim();
    if (!trimmed || trimmed === message.content) return;
    setIsEditing(false);
    void onEditMessage?.(message.id, trimmed);
  }, [editedText, message.content, message.id, onEditMessage]);

  useEffect(() => {
    if (isEditing) {
      editTextareaRef.current?.focus();
      editTextareaRef.current?.select();
    }
  }, [isEditing]);
  const failureInfo = isAssistantMessage ? message.failureInfo : undefined;
  /*
   * FNXC:ChatEmptyMessage 2026-07-10-00:00:
   * Empty assistant responses, including Grok CLI runs that finish with no text, must show a muted "No message" placeholder instead of a blank bubble. Only final persisted assistant messages with no renderable body qualify; tool calls, thinking output, attachments, or failure info already carry meaningful content and must not trigger the placeholder.
   */
  const isEmptyAssistantMessage = isAssistantMessage
    && message.content.trim().length === 0
    && !failureInfo
    && (!message.toolCalls || message.toolCalls.length === 0)
    && !message.thinkingOutput
    && (!message.attachments || message.attachments.length === 0);
  const showAssistantIdentity = isAssistantMessage && (!hideAssistantIdentity || Boolean(failureInfo));
  const renderedUserContent = useMemo<ReactNode>(() => {
    if (isAssistantMessage) return null;
    const content = message.content;
    const mentionRegex = /@([\w-]+)/g;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let match = mentionRegex.exec(content);
    while (match) {
      const [fullMatch, rawName = ""] = match;
      const start = match.index;
      if (start > lastIndex) parts.push(content.slice(lastIndex, start));
      const normalizedName = rawName.replace(/_/g, " ").toLowerCase();
      const mentionedAgent = mentionAgentsByName.get(normalizedName);
      if (mentionedAgent) {
        const isNonMember = Boolean(roomContext && !roomContext.memberIds.has(mentionedAgent.id));
        const nonMemberLabel = isNonMember ? t("chat.mentionNonMember", "Not a member of {{roomName}}", { roomName: roomContext?.roomName }) : undefined;
        parts.push(<span key={`${mentionedAgent.id}-${start}`} className={`chat-mention-chip${isNonMember ? " chat-mention-chip--non-member" : ""}`} title={nonMemberLabel} aria-label={nonMemberLabel}>@{mentionedAgent.name.replace(/\s+/g, "_")}</span>);
      } else {
        parts.push(fullMatch);
      }
      lastIndex = start + fullMatch.length;
      match = mentionRegex.exec(content);
    }
    if (lastIndex < content.length) parts.push(content.slice(lastIndex));
    return parts.length === 0 ? content : parts;
  }, [isAssistantMessage, message.content, mentionAgentsByName, roomContext, t]);
  const renderedAttachments = useMemo<ReactNode>(() => {
    const attachments = message.attachments;
    if (!attachments || attachments.length === 0) return null;
    const attachmentUrlBase = message.roomId ? `/api/chat/rooms/${encodeURIComponent(message.roomId)}/attachments/` : activeSessionId ? `/api/chat/sessions/${encodeURIComponent(activeSessionId)}/attachments/` : null;
    if (!attachmentUrlBase) return null;
    return <div className="chat-message-attachments">{attachments.map((attachment) => {
      const isImage = attachment.mimeType.startsWith("image/");
      const key = attachment.id || attachment.filename;
      const href = `${attachmentUrlBase}${encodeURIComponent(attachment.filename)}`;
      if (isImage) return <a key={key} className="chat-message-attachment-link" data-testid="chat-message-attachment" href={href} target="_blank" rel="noopener noreferrer"><img className="chat-message-attachment" src={href} alt={attachment.originalName} /></a>;
      return <a key={key} className="chat-message-attachment-file" data-testid="chat-message-attachment" href={href} target="_blank" rel="noopener noreferrer"><File size={14} /><span>{attachment.originalName}</span></a>;
    })}</div>;
  }, [message.attachments, message.roomId, activeSessionId]);
  const assistantBody = useMemo<ReactNode>(() => {
    if (!isAssistantMessage) return null;
    if (failureInfo) {
      return <div className="chat-message-content chat-message-content--failure"><div className="chat-message-failure-summary-row"><span className="status-dot status-dot--error" aria-hidden="true" /><span className="chat-message-failure-label">{t("chat.responseFailed", "Response failed")}</span></div><div className="chat-message-failure-summary">{failureInfo.summary}</div>{(failureInfo.errorClass || failureInfo.code) && <div className="chat-message-failure-badges">{failureInfo.errorClass && <span className="chat-message-failure-badge">{failureInfo.errorClass}</span>}{failureInfo.code && <span className="chat-message-failure-badge">{failureInfo.code}</span>}</div>}{(failureInfo.detail || failureInfo.reference) && <details className="chat-message-failure-details"><summary><TriangleAlert size={14} aria-hidden="true" /><span>{t("chat.failureDetails", "Failure details")}</span></summary>{failureInfo.detail && <pre className="chat-message-failure-detail">{linkifyFilePaths(failureInfo.detail)}</pre>}{renderFailureReference(failureInfo.reference, t)}</details>}</div>;
    }
    if (isEmptyAssistantMessage) {
      return <div className="chat-message-content chat-message-content--empty" data-testid="chat-message-empty">{t("chat.noMessage", "No message")}</div>;
    }
    return renderStandardAssistantContent(message.content, forcePlain);
  }, [failureInfo, forcePlain, isAssistantMessage, isEmptyAssistantMessage, message.content, t]);
  const hasAssistantFooterRow = isAssistantMessage && !failureInfo && Boolean(message.thinkingOutput || copyAction || onScrollToTop);
  const hasVisibleAssistantFooterContent = Boolean(message.thinkingOutput || copyAction || (onScrollToTop && isTopClipped));
  const messageTime = <div className="chat-message-time">{formatRelativeTime(message.createdAt, t)}</div>;
  return (
    <div className={`chat-message chat-message--${message.role}${failureInfo ? " chat-message--failure" : ""}${isEditing ? " chat-message--editing" : ""}`} data-testid={`chat-message-${message.id}`} data-message-id={message.id}>
      {showAssistantIdentity && <div className="chat-message-avatar">{activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="sm" /> : <Bot size={14} />}<span>{agentName}</span>{showAssistantModelTag && activeModelTag && <span className="chat-model-tag">{activeModelTag}</span>}</div>}
      {isEditing ? (
        <div className="chat-message-edit-editor" data-testid={`chat-message-edit-editor-${message.id}`}>
          <textarea
            ref={editTextareaRef}
            className="input chat-message-edit-textarea"
            value={editedText}
            onChange={(event) => setEditedText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                saveEdit();
              }
            }}
            rows={3}
          />
          <div className="chat-message-edit-actions">
            <button type="button" className="btn btn-sm" onClick={cancelEditing}>{t("chat.editMessageCancel", "Cancel")}</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!editedText.trim() || editedText.trim() === message.content} onClick={saveEdit}>{t("chat.editMessageSave", "Save")}</button>
          </div>
        </div>
      ) : (
        isAssistantMessage ? assistantBody : <div className="chat-message-content">{renderedUserContent}</div>
      )}
      {hasAssistantFooterRow && (
        <div className={`chat-message-thinking-row${hasVisibleAssistantFooterContent ? "" : " chat-message-thinking-row--collapsed"}`}>
          {message.thinkingOutput && <details className="chat-message-thinking"><summary>{t("chat.thinking", "Thinking")}</summary><pre className="chat-message-thinking-content">{linkifyFilePaths(message.thinkingOutput)}</pre></details>}
          {(copyAction || onScrollToTop) && (
            <div className="chat-message-actions">
              {copyAction}
              {onScrollToTop && <button type="button" className={`btn-icon chat-message-scroll-to-top-action${isTopClipped ? "" : " chat-message-scroll-to-top-action--hidden"}`} aria-label={t("chat.scrollMessageToTop", "Scroll message to top")} data-testid={`chat-message-scroll-to-top-${message.id}`} onClick={() => onScrollToTop(message.id)}><ArrowUpToLine size={14} /></button>}
            </div>
          )}
        </div>
      )}
      {renderStandardToolCalls(message.toolCalls, t, { isAwaitingAnswer: isAwaitingQuestionAnswer, submittedAnswer: submittedQuestionAnswer, onQuestionSubmit, toolCallRenderer })}
      {renderedAttachments}
      {isUserMessage ? (
        <div className="chat-message-time-row">
          {messageTime}
          {showEditAction && !isEditing && <button type="button" className="btn-icon chat-message-edit-action chat-message-edit-action--inline" aria-label={t("chat.editMessage", "Edit message")} data-testid={`chat-message-edit-${message.id}`} onClick={startEditing}><Pencil size={14} /></button>}
        </div>
      ) : messageTime}
    </div>
  );
});

export function StandardStreamingMessage({ streamingText, streamingThinking = "", streamingToolCalls = [], forcePlain, agentName, hideAssistantIdentity, showAssistantModelTag, activeModelTag, activeModelProvider, copyAction, onQuestionSubmit, toolCallRenderer }: StandardStreamingMessageProps) {
  const { t } = useTranslation("app");
  return (
    <div className="chat-message chat-message--assistant chat-message--streaming" data-testid="chat-message-__streaming__">
      {!hideAssistantIdentity && <div className="chat-message-avatar">{activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="sm" /> : <Bot size={14} />}<span>{agentName}</span>{showAssistantModelTag && activeModelTag && <span className="chat-model-tag">{activeModelTag}</span>}</div>}
      {streamingText ? renderStandardAssistantContent(streamingText, forcePlain) : <div className="chat-message-content chat-message-content--waiting">{streamingThinking ? t("chat.thinkingStatus", "Thinking…") : t("chat.workingStatus", "Working…")}</div>}
      {copyAction}
      {renderStandardToolCalls(streamingToolCalls, t, { isAwaitingAnswer: true, onQuestionSubmit, toolCallRenderer })}
      {streamingThinking && <details className="chat-message-thinking"><summary>{t("chat.thinking", "Thinking")}</summary><pre className="chat-message-thinking-content">{linkifyFilePaths(streamingThinking)}</pre></details>}
      <div className="chat-typing-indicator"><span /><span /><span /></div>
    </div>
  );
}

export function useStandardChatActionGesture() {
  const handledSendTouchRef = useRef(false);
  const handledSendTouchTimerRef = useRef<number | null>(null);
  const touchActionGestureRef = useRef(false);
  const markHandledSendTouch = useCallback(() => {
    handledSendTouchRef.current = true;
    if (handledSendTouchTimerRef.current != null) clearTimeout(handledSendTouchTimerRef.current);
    handledSendTouchTimerRef.current = window.setTimeout(() => {
      handledSendTouchRef.current = false;
      handledSendTouchTimerRef.current = null;
    }, 700);
  }, []);
  const beginTouchActionGesture = useCallback(() => {
    if (touchActionGestureRef.current) return false;
    touchActionGestureRef.current = true;
    window.setTimeout(() => { touchActionGestureRef.current = false; }, 0);
    return true;
  }, []);
  const consumeHandledSendTouch = useCallback(() => {
    if (!handledSendTouchRef.current) return false;
    handledSendTouchRef.current = false;
    if (handledSendTouchTimerRef.current != null) {
      clearTimeout(handledSendTouchTimerRef.current);
      handledSendTouchTimerRef.current = null;
    }
    return true;
  }, []);
  useEffect(() => () => {
    if (handledSendTouchTimerRef.current != null) clearTimeout(handledSendTouchTimerRef.current);
  }, []);
  return { beginTouchActionGesture, markHandledSendTouch, consumeHandledSendTouch };
}

export function StandardChatActionButton({ isStreaming, canSend, onSend, onStop, sendLabel, stopLabel, classNameSend = "chat-input-send", classNameStop = "chat-input-stop", showSendText = false, showStopText, sendTestId = "chat-send-btn", stopTestId = "chat-stop-btn" }: StandardChatActionButtonProps) {
  const { t } = useTranslation("app");
  const { beginTouchActionGesture, markHandledSendTouch, consumeHandledSendTouch } = useStandardChatActionGesture();
  // FNXC:StandardChatSurface 2026-07-07-00:00: resolve the Stop button's visible-text flag
  // independently of Send's, defaulting to showSendText when the caller doesn't opt in (FN-7655).
  const showStop = showStopText ?? showSendText;
  if (isStreaming) {
    return <button type="button" className={classNameStop} onPointerDown={(event) => { if (event.pointerType && event.pointerType !== "mouse") { event.preventDefault(); if (!beginTouchActionGesture()) return; markHandledSendTouch(); onStop?.(); } }} onTouchStart={(event) => { event.preventDefault(); if (!beginTouchActionGesture()) return; markHandledSendTouch(); onStop?.(); }} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (consumeHandledSendTouch()) return; onStop?.(); }} aria-label={stopLabel ?? t("chat.stopGeneration", "Stop generation")} data-testid={stopTestId} style={{ touchAction: "manipulation" }}><span className="chat-input-stop-icon" aria-hidden="true" />{showStop && <span>{stopLabel ?? t("chat.stopGeneration", "Stop generation")}</span>}</button>;
  }
  return <button type="button" className={classNameSend} onPointerDown={(event) => { if (event.pointerType && event.pointerType !== "mouse") { event.preventDefault(); if (!beginTouchActionGesture()) return; markHandledSendTouch(); void onSend(); } }} onTouchStart={(event) => { event.preventDefault(); if (!beginTouchActionGesture()) return; markHandledSendTouch(); void onSend(); }} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (consumeHandledSendTouch()) return; void onSend(); }} disabled={!canSend} data-testid={sendTestId} aria-label={sendLabel ?? t("chat.send", "Send")} style={{ touchAction: "manipulation" }}><Send size={16} />{showSendText && <span>{sendLabel ?? t("chat.send", "Send")}</span>}</button>;
}
