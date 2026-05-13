// ChatView.css is imported eagerly from App.tsx to avoid a flash of
// unstyled content when the lazy chunk loads. Do not re-import here.
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  MessageSquare,
  Send,
  Plus,
  Search,
  Trash2,
  Archive,
  ChevronLeft,
  Bot,
  Square,
  Eye,
  EyeOff,
  Paperclip,
  File,
  Wrench,
  ChevronDown,
  Copy,
  Check,
  TriangleAlert,
} from "lucide-react";
import { useChat, type ChatMessageInfo, type FailureInfo, type ToolCallInfo } from "../hooks/useChat";
import { useChatRooms } from "../hooks/useChatRooms";
import { useViewportMode } from "./Header";
import { fetchAgents, fetchDiscoveredSkills, fetchModels, updateGlobalSettings } from "../api";
import type { Agent } from "@fusion/core";
import type { DiscoveredSkill } from "@fusion/dashboard";
import type { ModelInfo } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";
import { AgentMentionPopup } from "./AgentMentionPopup";
import { AgentAvatar } from "./AgentAvatar";
import { FileMentionPopup } from "./FileMentionPopup";
import { CreateRoomModal } from "./CreateRoomModal";
import { useFileMention } from "../hooks/useFileMention";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { matchesAgentMentionFilter } from "./mentionMatching";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";

export interface ChatViewProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error" | "warning") => void;
  experimentalFeatures?: Record<string, boolean>;
}

const CHAT_INPUT_MAX_HEIGHT_PX = 320;

export function clampChatInputHeight(scrollHeight: number): number {
  return Math.min(scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX);
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
 * Format a model provider and ID into a human-readable tag.
 * Returns null if provider or modelId is missing/empty.
 */
function formatModelTag(provider?: string | null, modelId?: string | null): string | null {
  if (!provider || !modelId) return null;

  // Handle known provider/model patterns
  const normalizedModel = modelId.toLowerCase();

  // Claude models: "claude-sonnet-4-5" -> "Claude Sonnet 4.5"
  if (normalizedModel.includes("claude")) {
    let formatted = modelId
      .replace(/^claude[- ]/i, "Claude ")
      .replace(/sonnet[- ](\d+)[- ](\d+)/i, "Sonnet $1.$2")
      .replace(/sonnet[- ](\d+)/i, "Sonnet $1")
      .replace(/haiku[- ](\d+)/i, "Haiku $1")
      .replace(/opus[- ](\d+)/i, "Opus $1")
      .replace(/sonnet/i, "Sonnet")
      .replace(/haiku/i, "Haiku")
      .replace(/opus/i, "Opus")
      .replace(/-/g, " ")
      .trim();
    // Fix double spaces
    formatted = formatted.replace(/\s+/g, " ");
    return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
  }

  // OpenAI models: "gpt-4o" -> "GPT-4o", "gpt-4-turbo" -> "GPT-4 Turbo"
  if (normalizedModel.includes("gpt") || normalizedModel.includes("openai")) {
    // Format GPT model names: handle special cases first, then capitalize
    // Note: We don't replace hyphens globally because special cases preserve them
    const formatted = modelId
      .replace(/^gpt-4-turbo$/i, "GPT-4 Turbo")
      .replace(/^gpt-4o-mini$/i, "GPT-4o Mini")
      .replace(/^gpt-4o$/i, "GPT-4o")
      .replace(/^gpt-4$/i, "GPT-4")
      .replace(/^gpt-o1-preview$/i, "GPT-o1 Preview")
      .replace(/^gpt-o1-mini$/i, "GPT-o1 Mini")
      .replace(/^gpt-o1$/i, "GPT-o1")
      .replace(/^gpt/i, "GPT")  // Capitalize remaining GPT prefix
      .trim();
    return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
  }

  // Gemini models: "gemini-2.5-pro" -> "Gemini 2.5 Pro"
  if (normalizedModel.includes("gemini")) {
    const formatted = modelId
      .replace(/^gemini[- ]/i, "Gemini ")
      .replace(/pro[- ](\d+)[- ](\d+)/i, "Pro $1.$2")
      .replace(/pro[- ](\d+)/i, "Pro $1")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
  }

  // Generic fallback: capitalize first letter, replace hyphens with spaces
  const formatted = modelId
    .replace(/-/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
  return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
}

function truncateToolValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function formatToolArgsSummary(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  const entries = Object.entries(args);
  if (entries.length === 0) return null;

  return entries
    .map(([key, value]) => {
      const stringValue =
        typeof value === "string"
          ? value
          : (() => {
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            })();
      return `${key}=${truncateToolValue(stringValue, 50)}`;
    })
    .join(", ");
}

function formatToolResultSummary(result: unknown): string | null {
  if (result === undefined) return null;
  if (typeof result === "string") return truncateToolValue(result, 200);
  try {
    return truncateToolValue(JSON.stringify(result), 200);
  } catch {
    return truncateToolValue(String(result), 200);
  }
}

function buildFailureReferenceHref(reference: FailureInfo["reference"]): string | null {
  if (!reference) {
    return null;
  }

  if (reference.kind === "mailbox" || reference.kind === "mailbox-message") {
    const pathname = typeof window === "undefined" ? "/" : window.location.pathname || "/";
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    params.set("view", "mailbox");
    params.set("mailbox-message", reference.id);
    return `${pathname}?${params.toString()}#message-${encodeURIComponent(reference.id)}`;
  }

  return null;
}

function renderFailureReference(reference: FailureInfo["reference"]): ReactNode {
  if (!reference) {
    return null;
  }

  const referenceLabel = reference.label ?? `${reference.kind} ${reference.id}`;
  const referenceHref = buildFailureReferenceHref(reference);
  const referenceDetailsId = `chat-failure-reference-${reference.kind}-${reference.id}`
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase();

  return (
    <div className="chat-message-failure-reference">
      <span className="chat-message-failure-reference-label">Reference</span>
      <span className="chat-message-failure-reference-value">{referenceLabel}</span>
      {referenceHref ? (
        <a className="btn btn-sm chat-message-failure-reference-link" href={referenceHref}>
          Open mailbox message
        </a>
      ) : (
        <details className="chat-message-failure-reference-details">
          <summary className="btn btn-sm chat-message-failure-reference-link">View failure details</summary>
          <dl className="chat-message-failure-reference-meta" id={referenceDetailsId}>
            <div>
              <dt>Kind</dt>
              <dd>{reference.kind}</dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd>{reference.id}</dd>
            </div>
            {reference.label && (
              <div>
                <dt>Label</dt>
                <dd>{reference.label}</dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}

function renderToolCalls(toolCalls?: ToolCallInfo[]): ReactNode {
  if (!toolCalls || toolCalls.length === 0) return null;

  const renderToolCallItem = (toolCall: ToolCallInfo, index: number) => {
    const isRunning = toolCall.status === "running";
    const isError = toolCall.status === "completed" && toolCall.isError;
    const argsSummary = formatToolArgsSummary(toolCall.args);
    const resultSummary = formatToolResultSummary(toolCall.result);
    const summaryPreview = isRunning
      ? argsSummary
      : resultSummary
        ? `result: ${resultSummary}`
        : argsSummary
          ? `args: ${argsSummary}`
          : null;
    const statusLabel = isRunning ? "running" : isError ? "error" : "completed";

    return (
      <details
        key={`${toolCall.toolName}-${index}`}
        className={`chat-tool-call${isRunning ? " chat-tool-call--running" : ""}${isError ? " chat-tool-call--error" : ""}`}
        open={isRunning}
      >
        <summary>
          <span className="chat-tool-call-status-dot" aria-hidden="true" />
          <span className="chat-tool-call-name" title={toolCall.toolName}>{toolCall.toolName}</span>
          {summaryPreview && (
            <span className="chat-tool-call-preview" title={summaryPreview}>
              {summaryPreview}
            </span>
          )}
          <span className="chat-tool-call-status-text">{statusLabel}</span>
        </summary>
        <div className="chat-tool-call-content">
          {argsSummary && (
            <div className="chat-tool-call-row">
              <span className="chat-tool-call-label">args</span>
              <span className="chat-tool-call-value">{argsSummary}</span>
            </div>
          )}
          {resultSummary && (
            <div className={`chat-tool-call-row${isError ? " chat-tool-call-row--error" : ""}`}>
              <span className="chat-tool-call-label">result</span>
              <span className="chat-tool-call-value">{resultSummary}</span>
            </div>
          )}
        </div>
      </details>
    );
  };

  const className = "chat-tool-calls";
  if (toolCalls.length === 1) {
    return (
      <div className={className} data-testid="chat-tool-calls">
        <div className="chat-tool-calls-header">
          <Wrench size={12} aria-hidden="true" />
          <span>Tool calls</span>
        </div>
        {renderToolCallItem(toolCalls[0], 0)}
      </div>
    );
  }

  const runningCount = toolCalls.filter((toolCall) => toolCall.status === "running").length;
  const errorCount = toolCalls.filter((toolCall) => toolCall.status === "completed" && toolCall.isError).length;
  const hasRunning = runningCount > 0;
  const uniqueNames = Array.from(new Set(toolCalls.map((toolCall) => toolCall.toolName)));
  const visibleNames = uniqueNames.slice(0, 5);
  const overflowCount = Math.max(0, uniqueNames.length - visibleNames.length);
  const namesSummary = overflowCount > 0
    ? `${visibleNames.join(", ")}, +${overflowCount} more`
    : visibleNames.join(", ");
  const statusSummary = hasRunning
    ? `(${runningCount} running)`
    : errorCount > 0
      ? `(${errorCount} ${errorCount === 1 ? "error" : "errors"})`
      : null;

  return (
    <div className={className} data-testid="chat-tool-calls">
      <details className="chat-tool-calls-group" data-testid="chat-tool-calls-group" open={hasRunning}>
        <summary className="chat-tool-calls-group-summary">
          <Wrench size={12} aria-hidden="true" />
          <span className="chat-tool-calls-count">{toolCalls.length} tool calls</span>
          <span className="chat-tool-calls-names" title={namesSummary}>{namesSummary}</span>
          {statusSummary && <span className="chat-tool-calls-group-status">{statusSummary}</span>}
        </summary>
        {toolCalls.map((toolCall, index) => renderToolCallItem(toolCall, index))}
      </details>
    </div>
  );
}

const chatMarkdownComponents: Components = {
  p: ({ children, ...props }) => (
    <p {...props}>{linkifyReactChildren(children)}</p>
  ),
  li: ({ children, ...props }) => (
    <li {...props}>{linkifyReactChildren(children)}</li>
  ),
  pre: ({ children, ...props }) => (
    <pre {...props} className="chat-markdown-pre">
      {children}
    </pre>
  ),
  code: ({ children, ...props }) => {
    const text = typeof children === "string" ? children : React.Children.toArray(children).join("");
    const linkedChildren = linkifyFilePaths(text);
    if (linkedChildren.length === 1 && typeof linkedChildren[0] === "string") {
      return <code {...props}>{children}</code>;
    }
    return <code {...props}>{linkedChildren}</code>;
  },
  table: ({ children, ...props }) => (
    <table {...props} className="chat-markdown-table">
      {children}
    </table>
  ),
};

/**
 * Constant agent ID for the built-in fn agent.
 * The chat system always uses createFnAgent with CHAT_SYSTEM_PROMPT regardless
 * of the agentId stored on the session. This ID serves as metadata only.
 */
const FN_AGENT_ID = "__fn_agent__";
const CHAT_SIDEBAR_DEFAULT_WIDTH = 280;
const CHAT_SIDEBAR_MIN_WIDTH = 180;
const CHAT_SIDEBAR_MAX_WIDTH = 500;
const CHAT_SIDEBAR_STORAGE_KEY = "fusion:chat-sidebar-width";
const CHAT_SCOPE_STORAGE_KEY = "fusion:chat-scope";
const CHAT_DRAFT_STORAGE_PREFIX = "fusion:chat-draft:";

function getChatDraftKey(scope: "direct" | "rooms", id: string | null | undefined): string | null {
  if (!id) {
    return null;
  }

  return `${CHAT_DRAFT_STORAGE_PREFIX}${scope}:${id}`;
}

function getPersistedChatDraft(key: string | null): string {
  if (!key) {
    return "";
  }

  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

interface PendingAttachment {
  file: File;
  previewUrl: string;
}

const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "application/json",
  "text/yaml",
  "text/markdown",
  "text/csv",
  "application/xml",
  "text/x-log",
];

function getSkillTriggerMatch(value: string): { filter: string; start: number; end: number } | null {
  const triggerMatch = /(^|[\s])\/([^\s]*)$/.exec(value);
  if (!triggerMatch) {
    return null;
  }

  const prefix = triggerMatch[1] ?? "";
  const filter = triggerMatch[2] ?? "";
  const start = triggerMatch.index + prefix.length;
  return {
    filter,
    start,
    end: value.length,
  };
}

function getMentionTriggerMatch(
  value: string,
  cursorPos: number,
): { filter: string; start: number; end: number } | null {
  const textBeforeCursor = value.slice(0, cursorPos);
  const triggerMatch = /(^|[\s\n])@([\w-]*)$/.exec(textBeforeCursor);
  if (!triggerMatch) {
    return null;
  }

  const filter = triggerMatch[2] ?? "";
  const start = textBeforeCursor.length - filter.length - 1;
  return {
    filter,
    start,
    end: cursorPos,
  };
}

interface NewChatDialogProps {
  projectId?: string;
  onClose: () => void;
  onCreate: (input: { agentId: string; modelProvider?: string; modelId?: string }) => void;
}

function NewChatDialog({ projectId, onClose, onCreate }: NewChatDialogProps) {
  const [chatMode, setChatMode] = useState<"agent" | "model">("agent");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);

  // Load agents on mount (project-scoped)
  useEffect(() => {
    let cancelled = false;
    setAgentsLoading(true);
    fetchAgents(undefined, projectId)
      .then((response) => {
        if (!cancelled) {
          setAgents(response);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Silently fail - show empty list
          setAgents([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load models on mount
  useEffect(() => {
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setModels(response.models);
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
      })
      .catch(() => {
        // Silently fail - show empty list
        setModels([]);
        setFavoriteProviders([]);
        setFavoriteModels([]);
      })
      .finally(() => {
        setModelsLoading(false);
      });
  }, []);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((value) => value !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((value) => value !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders]);

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (chatMode === "agent") {
      if (!selectedAgentId) return;
      onCreate({ agentId: selectedAgentId });
      return;
    }

    // model mode
    if (!selectedModel) return;
    const slashIdx = selectedModel.indexOf("/");
    if (slashIdx <= 0) return;
    const modelProvider = selectedModel.slice(0, slashIdx);
    const modelId = selectedModel.slice(slashIdx + 1);
    onCreate({ agentId: FN_AGENT_ID, modelProvider, modelId });
  };

  const isSubmitDisabled =
    chatMode === "agent" ? !selectedAgentId : !selectedModel;

  return (
    <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="chat-new-dialog chat-view-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Chat</h3>
        <div className="chat-new-dialog-mode-toggle" data-testid="chat-new-dialog-mode-toggle">
          <button
            type="button"
            className={`chat-new-dialog-mode-btn${chatMode === "agent" ? " chat-new-dialog-mode-btn--active" : ""}`}
            data-testid="chat-new-dialog-mode-agent"
            onClick={() => {
              setChatMode("agent");
              setSelectedModel("");
            }}
          >
            Agent
          </button>
          <button
            type="button"
            className={`chat-new-dialog-mode-btn${chatMode === "model" ? " chat-new-dialog-mode-btn--active" : ""}`}
            data-testid="chat-new-dialog-mode-model"
            onClick={() => {
              setChatMode("model");
              setSelectedAgentId("");
            }}
          >
            Model
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          {chatMode === "agent" && (
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
          )}
          {chatMode === "model" && (
            <div className="chat-new-dialog-model-dropdown" data-testid="chat-new-dialog-model-section">
              {modelsLoading ? (
                <div className="chat-new-dialog-loading">Loading models...</div>
              ) : (
                <CustomModelDropdown
                  models={models}
                  value={selectedModel}
                  onChange={setSelectedModel}
                  label="Model"
                  placeholder="Select a model"
                  favoriteProviders={favoriteProviders}
                  onToggleFavorite={handleToggleFavorite}
                  favoriteModels={favoriteModels}
                  onToggleModelFavorite={handleToggleModelFavorite}
                />
              )}
            </div>
          )}
          <div className="chat-new-dialog-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={isSubmitDisabled}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



type CopyFeedbackState = "success" | "error" | null;

interface RoomContext {
  roomId: string;
  roomName: string;
  memberIds: ReadonlySet<string>;
}

interface ChatMessageItemProps {
  message: ChatMessageInfo;
  /**
   * When true, render assistant message content as plain text instead of
   * Markdown. The per-message eye toggle has been removed in favor of a
   * single thread-level toggle in the chat header, so this is a global
   * mirror of that header state.
   */
  forcePlain: boolean;
  agentName: string;
  /**
   * Hide the per-message agent identity (icon + name + model tag) on
   * assistant bubbles. In model-only chats the agent identity *is* the
   * active model and it's already shown in the thread header.
   */
  hideAssistantIdentity: boolean;
  showAssistantModelTag: boolean;
  activeModelTag: string | null;
  activeModelProvider: string | null;
  activeSessionId: string | null;
  mentionAgentsByName: Map<string, Agent>;
  roomContext: RoomContext | null;
  copyAction?: ReactNode;
}

// Renders a single chat message bubble. Memoized so the streaming bubble's
// per-frame state churn does not re-render every prior message (each one
// would re-run ReactMarkdown over its full content otherwise).
const ChatMessageItem = memo(function ChatMessageItem({
  message,
  forcePlain,
  agentName,
  hideAssistantIdentity,
  showAssistantModelTag,
  activeModelTag,
  activeModelProvider,
  activeSessionId,
  mentionAgentsByName,
  roomContext,
  copyAction,
}: ChatMessageItemProps) {
  const isAssistantMessage = message.role === "assistant";
  const failureInfo = isAssistantMessage ? message.failureInfo : undefined;
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
        const nonMemberLabel = isNonMember ? `Not a member of ${roomContext?.roomName}` : undefined;
        parts.push(
          <span
            key={`${mentionedAgent.id}-${start}`}
            className={`chat-mention-chip${isNonMember ? " chat-mention-chip--non-member" : ""}`}
            title={nonMemberLabel}
            aria-label={nonMemberLabel}
          >
            @{mentionedAgent.name.replace(/\s+/g, "_")}
          </span>,
        );
      } else {
        parts.push(fullMatch);
      }
      lastIndex = start + fullMatch.length;
      match = mentionRegex.exec(content);
    }
    if (lastIndex < content.length) parts.push(content.slice(lastIndex));
    return parts.length === 0 ? content : parts;
  }, [isAssistantMessage, message.content, mentionAgentsByName, roomContext]);

  const renderedAttachments = useMemo<ReactNode>(() => {
    const attachments = message.attachments;
    if (!attachments || attachments.length === 0 || !activeSessionId) return null;
    const attachmentUrlBase = `/api/chat/sessions/${encodeURIComponent(activeSessionId)}/attachments/`;
    return (
      <div className="chat-message-attachments">
        {attachments.map((attachment) => {
          const isImage = attachment.mimeType.startsWith("image/");
          const key = attachment.id || attachment.filename;
          const href = `${attachmentUrlBase}${encodeURIComponent(attachment.filename)}`;
          if (isImage) {
            return (
              <a
                key={key}
                className="chat-message-attachment-link"
                data-testid="chat-message-attachment"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  className="chat-message-attachment"
                  src={href}
                  alt={attachment.originalName}
                />
              </a>
            );
          }
          return (
            <a
              key={key}
              className="chat-message-attachment-file"
              data-testid="chat-message-attachment"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <File size={14} />
              <span>{attachment.originalName}</span>
            </a>
          );
        })}
      </div>
    );
  }, [message.attachments, activeSessionId]);

  const assistantBody = useMemo<ReactNode>(() => {
    if (!isAssistantMessage) return null;
    if (failureInfo) {
      return (
        <div className="chat-message-content chat-message-content--failure">
          <div className="chat-message-failure-summary-row">
            <span className="status-dot status-dot--error" aria-hidden="true" />
            <span className="chat-message-failure-label">Response failed</span>
          </div>
          <div className="chat-message-failure-summary">{failureInfo.summary}</div>
          {(failureInfo.errorClass || failureInfo.code) && (
            <div className="chat-message-failure-badges">
              {failureInfo.errorClass && <span className="chat-message-failure-badge">{failureInfo.errorClass}</span>}
              {failureInfo.code && <span className="chat-message-failure-badge">{failureInfo.code}</span>}
            </div>
          )}
          {(failureInfo.detail || failureInfo.reference) && (
            <details className="chat-message-failure-details">
              <summary>
                <TriangleAlert size={14} aria-hidden="true" />
                <span>Failure details</span>
              </summary>
              {failureInfo.detail && <pre className="chat-message-failure-detail">{linkifyFilePaths(failureInfo.detail)}</pre>}
              {renderFailureReference(failureInfo.reference)}
            </details>
          )}
        </div>
      );
    }
    if (forcePlain) {
      return <div className="chat-message-content chat-message-content--plain">{message.content}</div>;
    }
    return (
      <div className="chat-message-content chat-message-content--markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
          {message.content}
        </ReactMarkdown>
      </div>
    );
  }, [failureInfo, forcePlain, isAssistantMessage, message.content]);

  return (
    <div
      className={`chat-message chat-message--${message.role}${failureInfo ? " chat-message--failure" : ""}`}
      data-testid={`chat-message-${message.id}`}
    >
      {showAssistantIdentity && (
        <div className="chat-message-avatar">
          {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="sm" /> : <Bot size={14} />}
          <span>{agentName}</span>
          {showAssistantModelTag && activeModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
        </div>
      )}
      {isAssistantMessage
        ? assistantBody
        : <div className="chat-message-content">{renderedUserContent}</div>}
      {!failureInfo && copyAction}
      {renderToolCalls(message.toolCalls)}
      {message.thinkingOutput && (
        <details className="chat-message-thinking">
          <summary>Thinking</summary>
          <pre className="chat-message-thinking-content">{linkifyFilePaths(message.thinkingOutput)}</pre>
        </details>
      )}
      {renderedAttachments}
      <div className="chat-message-time">{formatRelativeTime(message.createdAt)}</div>
    </div>
  );
});

export function ChatView({ projectId, addToast, experimentalFeatures }: ChatViewProps) {
  const {
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    selectSession,
    createSession,
    archiveSession,
    deleteSession,
    sendMessage,
    stopStreaming,
    pendingMessage,
    clearPendingMessage,
    searchQuery,
    setSearchQuery,
    filteredSessions,
  } = useChat(projectId, addToast);

  const [showNewDialog, setShowNewDialog] = useState(false);
  const chatRoomsEnabled = experimentalFeatures?.chatRooms === true;
  const [chatScope, setChatScope] = useState<"direct" | "rooms">(() => {
    try {
      const persistedScope = localStorage.getItem(CHAT_SCOPE_STORAGE_KEY);
      if (persistedScope === "rooms" && chatRoomsEnabled) {
        return "rooms";
      }
    } catch {
      // Ignore storage errors.
    }

    return "direct";
  });
  // Keep this hook unconditional to preserve hook ordering and test stability.
  // Rooms UI and interactions are fully gated by `chatRoomsEnabled`.
  const rooms = useChatRooms(projectId, addToast);
  const [messageInput, setMessageInput] = useState(() => {
    const initialDraftKey = getChatDraftKey(
      chatScope,
      chatScope === "rooms" ? rooms.activeRoom?.id : activeSession?.id,
    );
    return getPersistedChatDraft(initialDraftKey);
  });
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteRoomId, setConfirmDeleteRoomId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(CHAT_SIDEBAR_DEFAULT_WIDTH);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [agentsMap, setAgentsMap] = useState<Map<string, Agent>>(new Map());
  const [discoveredSkills, setDiscoveredSkills] = useState<DiscoveredSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPopupVisible, setMentionPopupVisible] = useState(false);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  // Single thread-wide toggle: when true, all assistant content (including the
  // streaming bubble) renders as plain text instead of Markdown. Replaces the
  // earlier per-message toggle so the chat header owns this control instead
  // of every reply having its own button.
  const [showAllAsPlain, setShowAllAsPlain] = useState(false);
  // Attachment state mirrors QuickEntryBox: pending files selected before send.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [copyFeedbackByMessageId, setCopyFeedbackByMessageId] = useState<Record<string, CopyFeedbackState>>({});
  const [mobileSessionMenuOpen, setMobileSessionMenuOpen] = useState(false);
  const { pushNav } = useNavigationHistoryContext();

  // File mention state and hook
  const [, setFileMentionPopupVisible] = useState(false);
  const [fileMentionPosition, setFileMentionPosition] = useState({ top: 0, left: 0 });

  const fileMention = useFileMention({ projectId });

  // Calculate popup position based on caret position in textarea
  const updateFileMentionPosition = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea || !fileMention.mentionActive) return;

    // Get textarea position
    const rect = textarea.getBoundingClientRect();

    // Position above the textarea, using viewport coordinates
    // The popup is absolutely positioned, so we use window coordinates
    setFileMentionPosition({
      top: rect.top - 260, // Popup appears above with gap (accounting for popup height)
      left: rect.left + 8, // Small left offset
    });
  }, [fileMention.mentionActive]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mobileSessionMenuRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const lastAnchoredThreadStateRef = useRef<{ threadId: string; loaded: boolean; hasMessages: boolean } | null>(null);
  const hideSkillMenuTimeoutRef = useRef<number | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const mentionCursorPosRef = useRef(0);
  const copyFeedbackTimeoutsRef = useRef<Map<string, number>>(new Map());
  const mode = useViewportMode();
  const isMobile = mode === "mobile";

  useEffect(() => {
    try {
      const rawWidth = localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY);
      if (!rawWidth) return;
      const parsedWidth = Number.parseInt(rawWidth, 10);
      if (Number.isNaN(parsedWidth)) return;
      const clampedWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, parsedWidth));
      setSidebarWidth(clampedWidth);
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useEffect(() => {
    try {
      const persistedScope = localStorage.getItem(CHAT_SCOPE_STORAGE_KEY);
      if (persistedScope === "direct") {
        setChatScope("direct");
        return;
      }
      if (persistedScope === "rooms" && chatRoomsEnabled) {
        setChatScope("rooms");
      }
    } catch {
      // Ignore storage errors.
    }
  }, [chatRoomsEnabled]);

  useEffect(() => {
    if (!chatRoomsEnabled && chatScope === "rooms") {
      setChatScope("direct");
      return;
    }
    try {
      localStorage.setItem(CHAT_SCOPE_STORAGE_KEY, chatScope);
    } catch {
      // Ignore storage errors.
    }
  }, [chatRoomsEnabled, chatScope]);

  const activeDraftKey = getChatDraftKey(
    chatScope,
    chatScope === "rooms" ? rooms.activeRoom?.id : activeSession?.id,
  );
  const lastDraftKeyRef = useRef<string | null>(activeDraftKey);

  useEffect(() => {
    if (activeDraftKey === lastDraftKeyRef.current) {
      return;
    }

    lastDraftKeyRef.current = activeDraftKey;
    setMessageInput(getPersistedChatDraft(activeDraftKey));
  }, [activeDraftKey]);

  useEffect(() => {
    if (!activeDraftKey || lastDraftKeyRef.current !== activeDraftKey) {
      return;
    }

    try {
      if (messageInput) {
        localStorage.setItem(activeDraftKey, messageInput);
        return;
      }
      localStorage.removeItem(activeDraftKey);
    } catch {
      // Ignore storage errors.
    }
  }, [activeDraftKey, messageInput]);

  const roomThreadActive = chatRoomsEnabled && chatScope === "rooms" && !!rooms.activeRoom;
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: isMobile && (!!activeSession || roomThreadActive),
  });

  // Only opt into visual-viewport sizing when we have concrete keyboard
  // displacement (overlap or offset). The shared hook can report `keyboardOpen`
  // during iOS settle/shrink phases with zero overlap; forcing vv-height in that
  // transient state shrinks the thread and pushes the composer upward.
  const hasKeyboardViewportDisplacement = keyboardOverlap > 0 || viewportOffsetTop > 0;
  const threadKeyboardStyle: CSSProperties =
    keyboardOpen && hasKeyboardViewportDisplacement
      ? ({
          "--keyboard-overlap": `${keyboardOverlap}px`,
          "--vv-offset-top": `${viewportOffsetTop}px`,
          ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
        } as CSSProperties)
      : {};
  const threadClassName = `chat-thread${keyboardOpen && hasKeyboardViewportDisplacement ? " chat-thread--keyboard-active" : ""}`;

  const filteredSkills = useMemo(() => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    const matchingSkills = normalizedFilter
      ? discoveredSkills.filter((skill) => skill.name.toLowerCase().includes(normalizedFilter))
      : discoveredSkills;
    return matchingSkills.slice(0, 10);
  }, [discoveredSkills, skillFilter]);

  const mentionAgents = useMemo(() => Array.from(agentsMap.values()), [agentsMap]);

  const roomContext = useMemo<RoomContext | null>(() => {
    if (!chatRoomsEnabled || chatScope !== "rooms" || !rooms.activeRoom) {
      return null;
    }
    return {
      roomId: rooms.activeRoom.id,
      roomName: rooms.activeRoom.name,
      memberIds: new Set(rooms.activeRoomMembers.map((member) => member.agentId)),
    };
  }, [chatRoomsEnabled, chatScope, rooms.activeRoom, rooms.activeRoomMembers]);

  const filteredMentionAgents = useMemo(() => {
    const matchingAgents = mentionAgents.filter((agent) => matchesAgentMentionFilter(agent.name, mentionFilter));
    if (!roomContext) {
      return matchingAgents;
    }

    const memberAgents = matchingAgents.filter((agent) => roomContext.memberIds.has(agent.id));
    if (mentionFilter.trim().length === 0) {
      return memberAgents;
    }

    const otherAgents = matchingAgents.filter((agent) => !roomContext.memberIds.has(agent.id));
    return [...memberAgents, ...otherAgents];
  }, [mentionAgents, mentionFilter, roomContext]);

  const mentionAgentsByName = useMemo(() => {
    const byName = new Map<string, Agent>();
    for (const agent of mentionAgents) {
      byName.set(agent.name.toLowerCase(), agent);
    }
    return byName;
  }, [mentionAgents]);

  useEffect(() => {
    setHighlightedSkillIndex(0);
  }, [filteredSkills]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionFilter, mentionPopupVisible]);

  useEffect(() => {
    return () => {
      if (hideSkillMenuTimeoutRef.current !== null) {
        window.clearTimeout(hideSkillMenuTimeoutRef.current);
      }
    };
  }, []);

  const updateScrollState = useCallback(() => {
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;

    const threshold = 50;
    const atBottom = messagesContainer.scrollTop + messagesContainer.clientHeight >= messagesContainer.scrollHeight - threshold;
    setIsUserScrolling(!atBottom);
    isUserScrollingRef.current = !atBottom;
  }, []);

  const anchorToBottom = useCallback((container: HTMLElement) => {
    if (!container.isConnected) return;

    let frame = 0;
    let stableFrames = 0;
    let lastScrollHeight = -1;
    const maxFrames = 6;

    const writeBottom = () => {
      if (!container.isConnected) return;

      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastScrollHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastScrollHeight = container.scrollHeight;
      }

      frame += 1;
      if (frame >= maxFrames || stableFrames >= 2) {
        setIsUserScrolling(false);
        isUserScrollingRef.current = false;
        return;
      }

      window.requestAnimationFrame(writeBottom);
    };

    writeBottom();
  }, []);

  const scrollToBottom = useCallback(() => {
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;
    anchorToBottom(messagesContainer);
  }, [anchorToBottom]);

  useLayoutEffect(() => {
    const threadId = roomThreadActive ? (rooms.activeRoom?.id ?? null) : (activeSession?.id ?? null);
    if (!threadId) {
      lastAnchoredThreadStateRef.current = null;
      return;
    }

    const nextState = {
      threadId,
      loaded: roomThreadActive ? !rooms.messagesLoading : !messagesLoading,
      hasMessages: roomThreadActive ? rooms.messages.length > 0 : messages.length > 0,
    };
    const previousState = lastAnchoredThreadStateRef.current;
    const isThreadChanged = previousState?.threadId !== threadId;
    const finishedLoading = previousState?.threadId === threadId && !previousState.loaded && nextState.loaded;
    const firstMessagesArrived =
      previousState?.threadId === threadId && !previousState.hasMessages && nextState.hasMessages;

    const shouldAnchor = previousState === null || isThreadChanged || finishedLoading || firstMessagesArrived;
    if (!shouldAnchor) {
      return;
    }

    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    anchorToBottom(messagesContainer);
    lastAnchoredThreadStateRef.current = nextState;
  }, [
    roomThreadActive,
    rooms.activeRoom?.id,
    rooms.messages.length,
    rooms.messagesLoading,
    activeSession?.id,
    messages.length,
    messagesLoading,
    anchorToBottom,
  ]);

  const activeThreadMessages = roomThreadActive ? rooms.messages : messages;

  // Scroll thread container to bottom on new messages or streaming when user is near live tail.
  // Avoid Element.scrollIntoView() here because on mobile Safari it can
  // scroll the page viewport instead of only the chat thread.
  useEffect(() => {
    if (!isUserScrollingRef.current) {
      scrollToBottom();
    }
  }, [activeThreadMessages, streamingText, streamingThinking, isStreaming, scrollToBottom]);

  useEffect(() => {
    if (keyboardOverlap <= 0) {
      return;
    }

    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    scrollToBottom();
  }, [keyboardOverlap, scrollToBottom]);

  // Lock body scroll on mobile while the keyboard is up so iOS can't shift
  // the visual viewport (offsetTop > 0). Shared hook also restores
  // window.scrollTo(0, 0) on cleanup to recover from any iOS drift.
  useMobileScrollLock(isMobile && keyboardOpen);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  // While the keyboard is up on mobile, block touchmove gestures that
  // would otherwise pan the iOS visualViewport (or scroll the document)
  // and let the composer / header drift. We attach a non-passive listener
  // to document so that gestures starting anywhere — header, composer
  // padding, body — are cancelled. The exception is when the touch path
  // crosses the messages list, which is the one place we DO want pan-y.
  // useMobileScrollLock only pins document scroll; this complements it
  // by stopping vv pan on top of the locked layout.
  // React's synthetic onTouchMove is passive by default, so this has to
  // be a native addEventListener with { passive: false }.
  useEffect(() => {
    if (!isMobile || !keyboardOpen) return;
    const onTouchMove = (event: TouchEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".chat-messages")) return; // allow messages scroll
      event.preventDefault();
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, [isMobile, keyboardOpen]);

  // On mount and on visibility/page restore, if iOS thinks the keyboard is
  // up but the textarea isn't actually focused (or vice versa), the
  // visualViewport metrics get stuck in a half-state — composer pushed up
  // or covered by a blank pane. Force a blur+refocus on the textarea to
  // make iOS resync. Only runs on mobile and only when ChatView holds the
  // active session (avoids stealing focus from other views).
  useEffect(() => {
    if (!isMobile || !activeSession) return;
    const resync = () => {
      const ta = inputRef.current;
      if (!ta) return;
      if (document.activeElement !== ta) return; // only if it was focused
      ta.blur();
      window.setTimeout(() => {
        ta.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("pageshow", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("pageshow", resync);
    };
  }, [isMobile, activeSession]);

  useEffect(() => {
    if (!activeSession && !roomThreadActive) {
      return;
    }
    if (roomThreadActive && !isMobile) {
      return;
    }

    const reAnchorToLatest = () => {
      const messagesContainer = messagesContainerRef.current;
      if (!messagesContainer) {
        return;
      }
      anchorToBottom(messagesContainer);
      isUserScrollingRef.current = false;
      setIsUserScrolling(false);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      reAnchorToLatest();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", reAnchorToLatest);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", reAnchorToLatest);
    };
  }, [isMobile, activeSession, roomThreadActive, anchorToBottom]);

  // Fetch agents on mount for name resolution (project-scoped with stale-request protection)
  useEffect(() => {
    let cancelled = false;
    const currentProjectId = projectId;
    fetchAgents(undefined, projectId)
      .then((agents) => {
        // Ignore response if project changed during fetch
        if (cancelled || currentProjectId !== projectId) return;
        const map = new Map<string, Agent>();
        for (const agent of agents) {
          map.set(agent.id, agent);
        }
        setAgentsMap(map);
      })
      .catch(() => {
        // Silently fail - keep empty map
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch discovered skills for slash command autocomplete
  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);

    fetchDiscoveredSkills(projectId)
      .then((skills) => {
        if (!cancelled) {
          setDiscoveredSkills(skills);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiscoveredSkills([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSkillsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      for (const attachment of pendingAttachmentsRef.current) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      for (const timeoutId of copyFeedbackTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      copyFeedbackTimeoutsRef.current.clear();
    };
  }, []);

  const handleAttachmentFiles = useCallback((files: FileList | File[] | null | undefined) => {
    if (!files || files.length === 0) return;

    const nextAttachments: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
        continue;
      }
      const isImage = file.type.startsWith("image/");
      nextAttachments.push({
        file,
        previewUrl: isImage ? URL.createObjectURL(file) : "",
      });
    }

    if (nextAttachments.length > 0) {
      setPendingAttachments((prev) => [...prev, ...nextAttachments]);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => {
      const attachment = prev[index];
      if (attachment?.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return prev.filter((_, attachmentIndex) => attachmentIndex !== index);
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = event.clipboardData?.files;
    if (!clipboardFiles || clipboardFiles.length === 0) return;
    const imageFiles = Array.from(clipboardFiles).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    handleAttachmentFiles(imageFiles);
  }, [handleAttachmentFiles]);

  // Handle create session
  const handleCreateSession = useCallback(
    async (input: { agentId: string; modelProvider?: string; modelId?: string }) => {
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

  const resizeComposer = useCallback((textarea?: HTMLTextAreaElement | null) => {
    const composer = textarea ?? inputRef.current;
    if (!composer) {
      return;
    }

    composer.style.height = "auto";
    composer.style.height = `${clampChatInputHeight(composer.scrollHeight)}px`;
  }, []);

  useLayoutEffect(() => {
    resizeComposer();
  }, [messageInput, resizeComposer]);

  const clearComposerState = useCallback(() => {
    setMessageInput("");
    if (activeDraftKey) {
      try {
        localStorage.removeItem(activeDraftKey);
      } catch {
        // Ignore storage errors.
      }
    }
    setShowSkillMenu(false);
    setSkillFilter("");
    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
    setPendingAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return [];
    });
  }, [activeDraftKey]);

  // Handle send message including pending attachment uploads.
  const handleSend = useCallback(() => {
    const trimmed = messageInput.trim();
    const files = pendingAttachments.map((attachment) => attachment.file);
    if ((!trimmed && files.length === 0) || !activeSession) return;

    if (trimmed === "/clear" || trimmed === "/new") {
      clearComposerState();
      stopStreaming();
      clearPendingMessage();
      void createSession({
        agentId: activeSession.agentId,
        modelProvider: activeSession.modelProvider ?? undefined,
        modelId: activeSession.modelId ?? undefined,
      }).catch(() => {
        addToast("Failed to clear conversation", "error");
      });
      return;
    }

    clearComposerState();
    sendMessage(trimmed, files);
  }, [
    messageInput,
    pendingAttachments,
    activeSession,
    clearComposerState,
    stopStreaming,
    clearPendingMessage,
    createSession,
    addToast,
    sendMessage,
  ]);


  const handleSendDispatch = useCallback(async () => {
    const trimmed = messageInput.trim();
    if (!trimmed) {
      return;
    }

    if (chatRoomsEnabled && chatScope === "rooms") {
      if (!rooms.activeRoom) {
        return;
      }

      const previousInput = messageInput;
      clearComposerState();

      try {
        await rooms.sendRoomMessage(trimmed);
      } catch (error) {
        setMessageInput(previousInput);
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : "Failed to send room message";
        addToast(message, "error");
      }
      return;
    }

    handleSend();
  }, [messageInput, chatRoomsEnabled, chatScope, rooms, clearComposerState, addToast, handleSend]);

  const handleSkillSelect = useCallback(
    (skill: DiscoveredSkill) => {
      setMessageInput((currentInput) => {
        const triggerMatch = getSkillTriggerMatch(currentInput);
        if (!triggerMatch) {
          return currentInput;
        }

        const replacement = `/skill:${skill.name} `;
        const nextInput =
          currentInput.slice(0, triggerMatch.start) + replacement + currentInput.slice(triggerMatch.end);

        window.requestAnimationFrame(() => {
          if (!inputRef.current) return;
          resizeComposer(inputRef.current);
          inputRef.current.focus();
        });

        return nextInput;
      });

      setShowSkillMenu(false);
      setSkillFilter("");
      setHighlightedSkillIndex(0);
    },
    [resizeComposer],
  );

  const handleMentionSelect = useCallback(
    (agent: Agent) => {
      const textarea = inputRef.current;
      if (!textarea || mentionStartPos < 0) {
        return;
      }

      const selectionStart = textarea.selectionStart ?? mentionCursorPosRef.current;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      const cursorPos = Math.max(selectionStart, selectionEnd);
      const safeStart = Math.min(mentionStartPos, cursorPos);
      const mentionText = `@${agent.name.replace(/\s+/g, "_")}`;
      const replacement = `${mentionText} `;
      const nextInput = messageInput.slice(0, safeStart) + replacement + messageInput.slice(cursorPos);
      const nextCursorPos = safeStart + replacement.length;

      setMessageInput(nextInput);
      setMentionPopupVisible(false);
      setMentionFilter("");
      setMentionHighlightIndex(0);
      setMentionStartPos(-1);

      window.requestAnimationFrame(() => {
        if (!inputRef.current) return;
        resizeComposer(inputRef.current);
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [mentionStartPos, messageInput, resizeComposer],
  );


  // Handle input key down
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      mentionCursorPosRef.current = e.currentTarget.selectionStart ?? mentionCursorPosRef.current;

      // Handle file mention popup keyboard navigation first
      if (fileMention.mentionActive && fileMention.files.length > 0) {
        fileMention.handleKeyDown(e, messageInput);
        if (e.key === "Enter" || e.key === "Tab") {
          // Select the highlighted file
          const file = fileMention.files[fileMention.selectedIndex];
          if (file) {
            const newText = fileMention.selectFile(file, messageInput);
            setMessageInput(newText);
            fileMention.dismissMention();
            setFileMentionPopupVisible(false);
          }
        }
        return;
      }

      if (mentionPopupVisible && e.key === "ArrowDown") {
        e.preventDefault();
        if (filteredMentionAgents.length > 0) {
          setMentionHighlightIndex((prev) => (prev + 1) % filteredMentionAgents.length);
        }
        return;
      }

      if (mentionPopupVisible && e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredMentionAgents.length > 0) {
          setMentionHighlightIndex((prev) =>
            prev === 0 ? filteredMentionAgents.length - 1 : prev - 1,
          );
        }
        return;
      }

      if (mentionPopupVisible && e.key === "Enter") {
        e.preventDefault();
        const agentToSelect = filteredMentionAgents[mentionHighlightIndex] ?? filteredMentionAgents[0];
        if (agentToSelect) {
          handleMentionSelect(agentToSelect);
        }
        return;
      }

      if (mentionPopupVisible && e.key === "Escape") {
        e.preventDefault();
        setMentionPopupVisible(false);
        setMentionFilter("");
        setMentionStartPos(-1);
        return;
      }

      if (showSkillMenu && e.key === "ArrowDown") {
        e.preventDefault();
        if (filteredSkills.length > 0) {
          setHighlightedSkillIndex((prev) => (prev + 1) % filteredSkills.length);
        }
        return;
      }

      if (showSkillMenu && e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredSkills.length > 0) {
          setHighlightedSkillIndex((prev) =>
            prev === 0 ? filteredSkills.length - 1 : prev - 1,
          );
        }
        return;
      }

      if (showSkillMenu && (e.key === "Enter" || e.key === "Tab") && filteredSkills.length > 0) {
        e.preventDefault();
        const skillToSelect = filteredSkills[highlightedSkillIndex] ?? filteredSkills[0];
        if (skillToSelect) {
          handleSkillSelect(skillToSelect);
        }
        return;
      }

      if (showSkillMenu && e.key === "Escape") {
        e.preventDefault();
        setShowSkillMenu(false);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSendDispatch();
      }
    },
    [
      mentionPopupVisible,
      filteredMentionAgents,
      mentionHighlightIndex,
      handleMentionSelect,
      showSkillMenu,
      filteredSkills,
      highlightedSkillIndex,
      handleSkillSelect,
      handleSendDispatch,
      fileMention,
      messageInput,
    ],
  );

  const updateMentionState = useCallback((value: string, cursorPos: number) => {
    const mentionTriggerMatch = getMentionTriggerMatch(value, cursorPos);
    if (mentionTriggerMatch) {
      setMentionPopupVisible(true);
      setMentionFilter(mentionTriggerMatch.filter);
      setMentionStartPos(mentionTriggerMatch.start);
      return;
    }

    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
  }, []);

  // Handle textarea resize
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    const nextValue = textarea.value;
    const cursorPos = textarea.selectionStart ?? nextValue.length;

    mentionCursorPosRef.current = cursorPos;
    setMessageInput(nextValue);

    const skillTriggerMatch = getSkillTriggerMatch(nextValue);
    if (skillTriggerMatch) {
      setShowSkillMenu(true);
      setSkillFilter(skillTriggerMatch.filter);
    } else {
      setShowSkillMenu(false);
      setSkillFilter("");
    }

    updateMentionState(nextValue, cursorPos);

    // Detect file mentions
    fileMention.detectMention(nextValue, cursorPos);
    setFileMentionPopupVisible(fileMention.mentionActive);
    if (fileMention.mentionActive) {
      updateFileMentionPosition(textarea);
    }

    resizeComposer(textarea);
  }, [updateMentionState, resizeComposer]);

  const handleInputSelectionChange = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart ?? textarea.value.length;
      mentionCursorPosRef.current = cursorPos;
      updateMentionState(textarea.value, cursorPos);

      // Detect file mentions
      fileMention.detectMention(textarea.value, cursorPos);
      setFileMentionPopupVisible(fileMention.mentionActive);
      if (fileMention.mentionActive) {
        updateFileMentionPosition(textarea);
      }
    },
    [updateMentionState, fileMention, updateFileMentionPosition],
  );

  const handleInputKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        return;
      }
      handleInputSelectionChange(e);
    },
    [handleInputSelectionChange],
  );

  const handleInputBlur = useCallback(() => {
    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
    }

    hideSkillMenuTimeoutRef.current = window.setTimeout(() => {
      setShowSkillMenu(false);
      setMentionPopupVisible(false);
      setMentionFilter("");
      setMentionStartPos(-1);
      setFileMentionPopupVisible(false);
      fileMention.dismissMention();
      hideSkillMenuTimeoutRef.current = null;
    }, 120);
  }, [fileMention]);

  const handleInputFocus = useCallback(() => {
    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
      hideSkillMenuTimeoutRef.current = null;
    }
    // iOS quirk: after the keyboard has been dismissed once, re-focusing
    // an input leaves window.scrollY > 0 *and* visualViewport.offsetTop
    // > 0 — the layout viewport drifts up, and the position:fixed
    // useMobileScrollLock applies to a body that is no longer at the
    // top of the document. Result: the message thread anchors above
    // the visible viewport with a large blank area below it. Forcing
    // scroll back to (0,0) on the focus event neutralizes the drift
    // before lock applies. Done in a microtask so iOS finishes its
    // own scroll-into-view first.
    if (typeof window !== "undefined" && window.innerWidth <= 768) {
      window.setTimeout(() => {
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
      }, 0);
    }
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

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const resizeHandle = event.currentTarget;
    if (typeof resizeHandle.setPointerCapture === "function") {
      resizeHandle.setPointerCapture(event.pointerId);
    }

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, startWidth + deltaX));
      latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
      persistSidebarWidth(nextWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (typeof resizeHandle.releasePointerCapture === "function") {
        resizeHandle.releasePointerCapture(upEvent.pointerId);
      }

      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      persistSidebarWidth(latestWidth);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) {
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();

    const step = event.shiftKey ? 50 : 10;
    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, sidebarWidth + delta));
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  // Handle session click
  const handleSessionClick = useCallback(
    (id: string) => {
      selectSession(id);
      setMobileSessionMenuOpen(false);
      if (isMobile) setSidebarVisible(false);
    },
    [selectSession, isMobile],
  );

  // Handle back to sidebar (mobile)
  const handleBack = useCallback(() => {
    selectSession("");
    setSidebarVisible(true);
    setMobileSessionMenuOpen(false);
  }, [selectSession]);

  const handleRoomBack = useCallback(() => {
    rooms.selectRoom(null);
    setSidebarVisible(true);
    setMobileSessionMenuOpen(false);
  }, [rooms]);

  // Render empty state (no active session)
  const renderEmptyState = () => {
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

  const activeModelTag = formatModelTag(activeSession?.modelProvider, activeSession?.modelId);
  const activeModelProvider = activeSession?.modelProvider ?? null;
  const hasThreadInView = Boolean(activeSession || isStreaming || messages.length > 0);
  const hasMobileDetailSelection = chatScope === "rooms" ? roomThreadActive : Boolean(activeSession);
  const previousHasMobileDetailSelectionRef = useRef(hasMobileDetailSelection);

  useEffect(() => {
    const previousHasMobileDetailSelection = previousHasMobileDetailSelectionRef.current;
    previousHasMobileDetailSelectionRef.current = hasMobileDetailSelection;

    if (!isMobile) {
      return;
    }

    if (previousHasMobileDetailSelection || !hasMobileDetailSelection) {
      return;
    }

    // Mobile list/detail surfaces must stack a view entry on top of the
    // shared browser-history nav entry so swipe-back returns to the list.
    pushNav({
      type: "view",
      revert: chatScope === "rooms" ? handleRoomBack : handleBack,
    });
  }, [chatScope, handleBack, handleRoomBack, hasMobileDetailSelection, isMobile, pushNav]);

  const threadHeaderTitle = activeSession?.agentId === FN_AGENT_ID
    ? (activeModelTag ?? "Fusion")
    : activeSession?.title || agentsMap.get(activeSession?.agentId ?? "")?.name || activeSession?.agentId || "Chat";

  const showThreadHeaderModelTag = Boolean(activeModelTag && activeModelTag !== threadHeaderTitle);
  const showMobileSessionSwitcher = isMobile && chatScope === "direct" && !!activeSession;

  const agentName =
    agentsMap.get(activeSession?.agentId ?? "")?.name ||
    (activeSession?.agentId === FN_AGENT_ID
      ? (activeModelTag ?? "Fusion")
      : (activeSession?.agentId?.slice(0, 30) ?? "Fusion"));

  // The model tag is already visible in the thread header — repeating it on
  // every assistant message is noise. Keep it suppressed for regular chat
  // (real agent name is the identity); QuickChat already collapses the tag
  // because its `agentName` IS the model tag, so the per-message slot was
  // always empty there too.
  const showAssistantModelTag = false;

  // In model-only chats (no real agent picked) the agent identity *is* the
  // model name, which is already in the thread header. Repeating it on every
  // assistant bubble is noise. Hide the per-message identity row entirely;
  // the render-mode toggle still appears in a slim toolbar.
  const hideAssistantIdentity = activeSession?.agentId === FN_AGENT_ID;

  const pendingPreview = pendingMessage.length > 50
    ? `${pendingMessage.slice(0, 50)}…`
    : pendingMessage;

  const toggleAllAsPlain = useCallback(() => {
    setShowAllAsPlain((value) => !value);
  }, []);

  useEffect(() => {
    if (!mobileSessionMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (mobileSessionMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setMobileSessionMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [mobileSessionMenuOpen]);

  useEffect(() => {
    if (!isMobile || chatScope !== "direct" || sidebarVisible) {
      setMobileSessionMenuOpen(false);
    }
  }, [isMobile, chatScope, sidebarVisible]);

  const setCopyFeedback = useCallback((messageId: string, feedback: CopyFeedbackState) => {
    const existingTimeout = copyFeedbackTimeoutsRef.current.get(messageId);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    setCopyFeedbackByMessageId((current) => ({ ...current, [messageId]: feedback }));

    const timeoutId = window.setTimeout(() => {
      setCopyFeedbackByMessageId((current) => {
        const { [messageId]: _removed, ...rest } = current;
        return rest;
      });
      copyFeedbackTimeoutsRef.current.delete(messageId);
    }, 2000);

    copyFeedbackTimeoutsRef.current.set(messageId, timeoutId);
  }, []);

  const handleCopyResponse = useCallback(async (messageId: string, content: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(content);
      setCopyFeedback(messageId, "success");
    } catch {
      setCopyFeedback(messageId, "error");
    }
  }, [setCopyFeedback]);

  const renderAssistantContent = useCallback(
    (content: string, forcePlain = false) => {
      const showPlainText = forcePlain;
      if (showPlainText) {
        return <div className="chat-message-content chat-message-content--plain">{content}</div>;
      }

      return (
        <div className="chat-message-content chat-message-content--markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      );
    },
    [],
  );

  const showProviderResponseCopy = activeSession?.agentId === FN_AGENT_ID;

  const renderCopyAction = useCallback((messageId: string, content: string, testId?: string) => (
    <button
      type="button"
      className={`btn-icon chat-message-copy-action${copyFeedbackByMessageId[messageId] === "success" ? " chat-message-copy-action--success" : ""}${copyFeedbackByMessageId[messageId] === "error" ? " chat-message-copy-action--error" : ""}`}
      data-testid={testId ?? `chat-copy-response-${messageId}`}
      aria-label={copyFeedbackByMessageId[messageId] === "success" ? "Response copied" : copyFeedbackByMessageId[messageId] === "error" ? "Copy failed" : "Copy response"}
      onClick={() => {
        void handleCopyResponse(messageId, content);
      }}
    >
      {copyFeedbackByMessageId[messageId] === "success" ? <Check size={14} /> : <Copy size={14} />}
    </button>
  ), [copyFeedbackByMessageId, handleCopyResponse]);

  return (
    <div className="chat-view">
      {/* Sidebar */}
      <div
        className={`chat-sidebar${!sidebarVisible ? " chat-sidebar--hidden" : ""}`}
        style={isMobile ? undefined : { width: `${sidebarWidth}px` }}
      >
        {chatRoomsEnabled && (
          <div className="chat-sidebar-scope-toggle" role="tablist" data-testid="chat-sidebar-scope-toggle">
            <button
              type="button"
              role="tab"
              className={`chat-sidebar-scope-btn${chatScope === "direct" ? " chat-sidebar-scope-btn--active" : ""}`}
              aria-selected={chatScope === "direct"}
              data-testid="chat-sidebar-scope-direct"
              onClick={() => setChatScope("direct")}
            >
              Direct
            </button>
            <button
              type="button"
              role="tab"
              className={`chat-sidebar-scope-btn${chatScope === "rooms" ? " chat-sidebar-scope-btn--active" : ""}`}
              aria-selected={chatScope === "rooms"}
              data-testid="chat-sidebar-scope-rooms"
              onClick={() => setChatScope("rooms")}
            >
              Rooms
            </button>
          </div>
        )}
        {!chatRoomsEnabled || chatScope === "direct" ? (
          <>
            {/* Search section */}
            <div className="chat-sidebar-search-container">
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
            {/* Session list section */}
            <div className="chat-session-list chat-sidebar-list">
              {sessionsLoading ? (
                <div className="chat-empty-state chat-empty-state--padded">Loading...</div>
              ) : filteredSessions.length === 0 ? (
                <div className="chat-empty-state chat-empty-state--padded">No conversations yet</div>
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
                    <button
                      className="chat-session-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(session.id);
                      }}
                      data-testid="chat-session-delete-btn"
                      aria-label="Delete conversation"
                    >
                      <Trash2 size={14} />
                    </button>
                    <div className="chat-session-title">{session.title || "Untitled"}</div>
                    <div className="chat-session-preview">
                      {session.lastMessagePreview || "No messages"}
                    </div>
                    <div className="chat-session-meta">
                      <span className="chat-session-meta-model">
                        {session.modelProvider && (
                          <ProviderIcon provider={session.modelProvider} size="sm" />
                        )}
                        <span>
                          {agentsMap.get(session.agentId)?.name ||
                            (session.agentId === FN_AGENT_ID
                              ? (formatModelTag(session.modelProvider, session.modelId) ?? "Fusion")
                              : session.agentId.slice(0, 30))}
                        </span>
                      </span>
                      <span>{session.updatedAt ? formatRelativeTime(session.updatedAt) : ""}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="chat-sidebar-rooms" data-testid="chat-sidebar-rooms">
            <div className="chat-sidebar-rooms-header">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="chat-create-room-btn"
                onClick={() => setCreateRoomOpen(true)}
              >
                <Plus size={14} />
                Create room
              </button>
            </div>
            {rooms.rooms.length === 0 ? (
              <div className="chat-sidebar-rooms-empty" data-testid="chat-sidebar-rooms-empty">
                No rooms yet.
              </div>
            ) : (
              <div className="chat-session-list chat-sidebar-list">
                {rooms.rooms.map((room) => {
                  const isActive = rooms.activeRoom?.id === room.id;
                  return (
                    <div
                      key={room.id}
                      role="button"
                      tabIndex={0}
                      className={`chat-room-item${isActive ? " chat-room-item--active" : ""}`}
                      data-testid={`chat-room-item-${room.slug}`}
                      onClick={() => {
                        rooms.selectRoom(room.id);
                        if (isMobile) {
                          setSidebarVisible(false);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          rooms.selectRoom(room.id);
                          if (isMobile) {
                            setSidebarVisible(false);
                          }
                        }
                      }}
                    >
                      <span className="chat-room-item-details">
                        <span className="chat-room-item-name">#{room.name}</span>
                        {isActive ? (
                          <span className="chat-room-item-meta">
                            {rooms.activeRoomMembers.length} {rooms.activeRoomMembers.length === 1 ? "member" : "members"}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        className="btn-icon chat-room-item-delete"
                        data-testid={`chat-room-delete-${room.slug}`}
                        aria-label={`Delete room ${room.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmDeleteRoomId(room.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* Mobile footer with New Chat action */}
        <div className="chat-sidebar-footer">
          <button
            className="btn btn-sm btn-primary chat-sidebar-footer-btn"
            onClick={() => setShowNewDialog(true)}
            data-testid="chat-new-btn"
          >
            <Plus size={14} />
            New Chat
          </button>
        </div>
      </div>

      {!isMobile && sidebarVisible && (
        <div
          className="chat-sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={CHAT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={CHAT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          aria-label="Resize chat sidebar"
          tabIndex={0}
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
        />
      )}

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
        <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="chat-new-dialog chat-view-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Conversation?</h3>
            <p className="chat-view-delete-dialog-copy">
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

      {chatRoomsEnabled && confirmDeleteRoomId && (
        <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={() => setConfirmDeleteRoomId(null)}>
          <div className="chat-new-dialog chat-view-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Room?</h3>
            <p className="chat-view-delete-dialog-copy">
              This action cannot be undone. This room and all its messages will be permanently deleted.
            </p>
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setConfirmDeleteRoomId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  void (async () => {
                    try {
                      await rooms.deleteRoom(confirmDeleteRoomId);
                      setConfirmDeleteRoomId(null);
                    } catch {
                      addToast("Failed to delete room", "error");
                    }
                  })();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Thread */}
      {chatRoomsEnabled && chatScope === "rooms" ? (
        <div className={threadClassName} style={threadKeyboardStyle}>
          {rooms.activeRoom ? (
            <>
              <div className="chat-room-thread-header">
                {isMobile && (
                  <button className="btn-icon" onClick={handleRoomBack} data-testid="chat-back-btn">
                    <ChevronLeft size={16} />
                  </button>
                )}
                <div className="chat-thread-header-title">#{rooms.activeRoom.name}</div>
                <div className="chat-room-thread-members">
                  {rooms.activeRoomMembers.map((member) => (
                    <AgentAvatar
                      key={member.agentId}
                      agent={
                        agentsMap.get(member.agentId) ?? {
                          id: member.agentId,
                          name: member.agentId.slice(0, 30),
                        }
                      }
                    />
                  ))}
                </div>
              </div>
              <div className="chat-messages" ref={messagesContainerRef} onScroll={updateScrollState}>
                {rooms.messagesLoading ? (
                  <div className="chat-empty-state">Loading messages...</div>
                ) : rooms.messages.length === 0 ? (
                  <div className="chat-empty-state">No messages yet. Start the conversation!</div>
                ) : (
                  rooms.messages.map((message) => {
                    const senderName = message.senderAgentId ? (agentsMap.get(message.senderAgentId)?.name ?? message.senderAgentId.slice(0, 30)) : "You";
                    const roomMessage: ChatMessageInfo = {
                      id: message.id,
                      sessionId: message.roomId,
                      role: message.role,
                      content: message.content,
                      thinkingOutput: message.thinkingOutput ?? undefined,
                      toolCalls: undefined,
                      fallbackInfo: undefined,
                      attachments: message.attachments,
                      createdAt: message.createdAt,
                    };
                    return (
                      <ChatMessageItem
                        key={message.id}
                        message={roomMessage}
                        forcePlain={showAllAsPlain}
                        agentName={senderName}
                        hideAssistantIdentity={false}
                        showAssistantModelTag={false}
                        activeModelTag={null}
                        activeModelProvider={null}
                        activeSessionId={rooms.activeRoom?.id ?? null}
                        mentionAgentsByName={mentionAgentsByName}
                        roomContext={roomContext}
                      />
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
            </>
          ) : (
            <div className="chat-room-empty-pane" data-testid="chat-rooms-empty-pane">Select a room or create one</div>
          )}

          {rooms.activeRoom && (
            <div className="chat-input-area">
              <div className="chat-input-row">
                <div className="chat-input-wrapper">
                  <textarea
                    ref={inputRef}
                    className="chat-input-textarea"
                    placeholder="Type a message..."
                    value={messageInput}
                    onChange={handleInputChange}
                    onKeyDown={handleInputKeyDown}
                    onKeyUp={handleInputKeyUp}
                    onClick={handleInputSelectionChange}
                    onBlur={handleInputBlur}
                    onFocus={handleInputFocus}
                    onTouchStart={(event) => {
                      if (typeof window === "undefined") return;
                      if (window.innerWidth > 768) return;
                      if (document.activeElement === event.currentTarget) return;
                      event.preventDefault();
                      event.currentTarget.focus({ preventScroll: true });
                    }}
                    rows={1}
                    data-testid="chat-input"
                  />
                  <AgentMentionPopup
                    agents={mentionAgents}
                    filter={mentionFilter}
                    highlightedIndex={mentionHighlightIndex}
                    visible={mentionPopupVisible}
                    onSelect={handleMentionSelect}
                    position="below"
                    roomMemberIds={roomContext?.memberIds}
                    roomName={roomContext?.roomName}
                  />
                </div>
                <button
                  type="button"
                  className="chat-input-send"
                  // Keep keyboard up when sending. preventDefault fires on
                  // pointerdown for touch pointers (BEFORE iOS blurs the
                  // textarea — the synthesized mousedown is too late on
                  // iOS), and on mousedown for desktop. Crucially we do NOT
                  // call preventDefault on touchstart and we do NOT run the
                  // action here — both of those broke quick taps. Click
                  // still fires from the iOS touch sequence and runs the
                  // action reliably.
                  onPointerDown={(event) => {
                    if (event.pointerType && event.pointerType !== "mouse") {
                      event.preventDefault();
                    }
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    void handleSendDispatch();
                  }}
                  disabled={!messageInput.trim()}
                  data-testid="chat-send-btn"
                  style={{ touchAction: "manipulation" }}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
      <div className={threadClassName} style={threadKeyboardStyle}>
        {/* Header - always rendered in desktop/tablet, only rendered in mobile when viewing a thread */}
        {(hasThreadInView || !isMobile) && (
          <div className="chat-thread-header">
            {isMobile && hasThreadInView && (
              <button className="btn-icon" onClick={handleBack} data-testid="chat-back-btn">
                <ChevronLeft size={16} />
              </button>
            )}
            <div className="chat-thread-header-identity" data-testid="chat-thread-header-identity">
              {showMobileSessionSwitcher ? (
                <div className="chat-mobile-session-menu" ref={mobileSessionMenuRef}>
                  <button
                    type="button"
                    className="btn chat-mobile-session-trigger"
                    data-testid="chat-mobile-session-trigger"
                    aria-haspopup="menu"
                    aria-expanded={mobileSessionMenuOpen}
                    onClick={() => setMobileSessionMenuOpen((open) => !open)}
                  >
                    {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="md" /> : <Bot size={16} />}
                    <span className="chat-thread-header-title">{threadHeaderTitle}</span>
                    {showThreadHeaderModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                  {mobileSessionMenuOpen && (
                    <div className="chat-mobile-session-dropdown" role="menu" data-testid="chat-mobile-session-dropdown">
                      {filteredSessions.map((session) => (
                        <button
                          key={session.id}
                          type="button"
                          role="menuitem"
                          className={`chat-mobile-session-option${activeSession?.id === session.id ? " chat-mobile-session-option--active" : ""}`}
                          data-testid={`chat-mobile-session-option-${session.id}`}
                          onClick={() => handleSessionClick(session.id)}
                        >
                          <span className="chat-mobile-session-option-title">{session.title || "Untitled"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="md" /> : <Bot size={16} />}
                  <span className="chat-thread-header-title">{threadHeaderTitle}</span>
                  {showThreadHeaderModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
                </>
              )}
            </div>
            {hasThreadInView && (
              <button
                type="button"
                className={`chat-thread-header-render-toggle${showAllAsPlain ? " chat-thread-header-render-toggle--plain" : ""}`}
                data-testid="chat-thread-render-toggle"
                aria-label={showAllAsPlain ? "Show all messages as rendered Markdown" : "Show all messages as plain text"}
                onClick={toggleAllAsPlain}
              >
                {showAllAsPlain ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
            {!isMobile && (
              <button
                className="btn btn-sm btn-primary chat-thread-header-new-chat"
                onClick={() => setShowNewDialog(true)}
                data-testid="chat-thread-new-chat-btn"
              >
                <Plus size={14} />
                New Chat
              </button>
            )}

          </div>
        )}

        {/* Messages */}
        <div className="chat-messages" ref={messagesContainerRef} onScroll={updateScrollState}>
          {isStreaming ? (
            <>
              {messages.map((message) => (
                <ChatMessageItem
                  key={message.id}
                  message={message}
                  forcePlain={showAllAsPlain}
                  agentName={agentName}
                  hideAssistantIdentity={hideAssistantIdentity}
                  showAssistantModelTag={showAssistantModelTag}
                  activeModelTag={activeModelTag}
                  activeModelProvider={activeModelProvider}
                  activeSessionId={activeSession?.id ?? null}
                  mentionAgentsByName={mentionAgentsByName}
                  roomContext={null}
                  copyAction={showProviderResponseCopy && message.role === "assistant" ? renderCopyAction(message.id, message.content) : undefined}
                />
              ))}
              <div className="chat-message chat-message--assistant chat-message--streaming">
                {!hideAssistantIdentity && (
                  <div className="chat-message-avatar">
                    {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="sm" /> : <Bot size={14} />}
                    <span>{agentName}</span>
                    {showAssistantModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
                  </div>
                )}
                {streamingText ? (
                  renderAssistantContent(streamingText, showAllAsPlain)
                ) : (
                  <div className="chat-message-content chat-message-content--waiting">
                    {streamingThinking ? "Thinking…" : "Connecting…"}
                  </div>
                )}
                {showProviderResponseCopy && streamingText && renderCopyAction("__streaming__", streamingText, "chat-copy-response-streaming")}
                {renderToolCalls(streamingToolCalls)}
                {streamingThinking && (
                  <details className="chat-message-thinking">
                    <summary>Thinking</summary>
                    <pre className="chat-message-thinking-content">{linkifyFilePaths(streamingThinking)}</pre>
                  </details>
                )}
                <div className="chat-typing-indicator">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </>
          ) : messagesLoading ? (
            <div className="chat-empty-state">Loading messages...</div>
          ) : messages.length === 0 && !activeSession ? (
            renderEmptyState()
          ) : messages.length === 0 && activeSession ? (
            <div className="chat-empty-state">No messages yet. Start the conversation!</div>
          ) : (
            <>
              {messages.map((message) => (
                <ChatMessageItem
                  key={message.id}
                  message={message}
                  forcePlain={showAllAsPlain}
                  agentName={agentName}
                  hideAssistantIdentity={hideAssistantIdentity}
                  showAssistantModelTag={showAssistantModelTag}
                  activeModelTag={activeModelTag}
                  activeModelProvider={activeModelProvider}
                  activeSessionId={activeSession?.id ?? null}
                  mentionAgentsByName={mentionAgentsByName}
                  roomContext={null}
                  copyAction={showProviderResponseCopy && message.role === "assistant" ? renderCopyAction(message.id, message.content) : undefined}
                />
              ))}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
        {isUserScrolling && (
          <button
            type="button"
            className="btn btn-sm chat-jump-to-latest"
            data-testid="chat-jump-to-latest"
            onClick={scrollToBottom}
          >
            <ChevronDown size={14} />
            Latest
          </button>
        )}

        {/* Input */}
        {activeSession && (
          <div className="chat-input-area">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.txt,.json,.yaml,.yml,.log,.csv,.xml,.md"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                handleAttachmentFiles(event.target.files);
                event.target.value = "";
              }}
            />
            {showSkillMenu && (
              <div className="chat-skill-menu" data-testid="chat-skill-menu" role="listbox" aria-label="Skill suggestions">
                {skillsLoading ? (
                  <div className="chat-skill-menu-empty">Loading skills…</div>
                ) : filteredSkills.length === 0 ? (
                  <div className="chat-skill-menu-empty">
                    {skillFilter ? "No skills found" : "No skills available"}
                  </div>
                ) : (
                  filteredSkills.map((skill, index) => (
                    <button
                      key={skill.id}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedSkillIndex}
                      className={`chat-skill-menu-item${index === highlightedSkillIndex ? " chat-skill-menu-item--highlighted" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setHighlightedSkillIndex(index)}
                      onClick={() => handleSkillSelect(skill)}
                    >
                      <span className="chat-skill-menu-item-name">{skill.name}</span>
                      <span className="chat-skill-menu-item-description" title={skill.relativePath}>
                        {skill.relativePath}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            {pendingAttachments.length > 0 && (
              <div className="chat-attachment-previews" data-testid="chat-attachment-previews">
                {pendingAttachments.map((attachment, index) => (
                  <div
                    key={attachment.previewUrl || `${attachment.file.name}-${index}`}
                    className="chat-attachment-preview"
                    data-testid={`chat-attachment-preview-${index}`}
                  >
                    {attachment.previewUrl ? (
                      <img src={attachment.previewUrl} alt={attachment.file.name} />
                    ) : (
                      <span className="chat-attachment-preview-name">{attachment.file.name}</span>
                    )}
                    <button
                      type="button"
                      className="chat-attachment-remove"
                      onClick={() => removeAttachment(index)}
                      data-testid={`chat-attachment-remove-${index}`}
                      aria-label={`Remove ${attachment.file.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-input-row">
              <button
                type="button"
                className="btn-icon chat-attach-btn"
                data-testid="chat-attach-btn"
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} />
              </button>
              <div
                className={`chat-input-wrapper${isDragOver ? " chat-input-wrapper--dragover" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragOver(false);
                  handleAttachmentFiles(event.dataTransfer.files);
                }}
              >
                <textarea
                  ref={inputRef}
                  className="chat-input-textarea"
                  placeholder="Type a message..."
                  value={messageInput}
                  onChange={handleInputChange}
                  onKeyDown={handleInputKeyDown}
                  onKeyUp={handleInputKeyUp}
                  onClick={handleInputSelectionChange}
                  onBlur={handleInputBlur}
                  onFocus={handleInputFocus}
                  onPaste={handlePaste}
                  onTouchStart={(event) => {
                    if (typeof window === "undefined") return;
                    if (window.innerWidth > 768) return;
                    if (document.activeElement === event.currentTarget) return;
                    event.preventDefault();
                    event.currentTarget.focus({ preventScroll: true });
                  }}
                  rows={1}
                  data-testid="chat-input"
                />
                <AgentMentionPopup
                  agents={mentionAgents}
                  filter={mentionFilter}
                  highlightedIndex={mentionHighlightIndex}
                  visible={mentionPopupVisible}
                  onSelect={handleMentionSelect}
                  position="below"
                  roomMemberIds={roomContext?.memberIds}
                  roomName={roomContext?.roomName}
                />
                <FileMentionPopup
                  visible={fileMention.mentionActive && !mentionPopupVisible}
                  position={fileMentionPosition}
                  files={fileMention.files}
                  selectedIndex={fileMention.selectedIndex}
                  onSelect={(file) => {
                    const newText = fileMention.selectFile(file, messageInput);
                    setMessageInput(newText);
                    fileMention.dismissMention();
                    setFileMentionPopupVisible(false);
                    inputRef.current?.focus();
                  }}
                  loading={fileMention.loading}
                />
                {pendingMessage && (
                  <div className="chat-pending-message" data-testid="chat-pending-indicator">
                    <span>{`Queued: ${pendingPreview}`}</span>
                    <button
                      type="button"
                      className="chat-pending-message-dismiss"
                      aria-label="Dismiss queued message"
                      data-testid="chat-pending-dismiss"
                      onClick={clearPendingMessage}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              {isStreaming ? (
                <button
                  className="chat-input-stop"
                  onClick={stopStreaming}
                  aria-label="Stop generation"
                  data-testid="chat-stop-btn"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-input-send"
                  // Keep keyboard up when sending. preventDefault fires on
                  // pointerdown for touch pointers (BEFORE iOS blurs the
                  // textarea — the synthesized mousedown is too late on
                  // iOS), and on mousedown for desktop. Crucially we do NOT
                  // call preventDefault on touchstart and we do NOT run the
                  // action here — both of those broke quick taps. Click
                  // still fires from the iOS touch sequence and runs the
                  // action reliably.
                  onPointerDown={(event) => {
                    if (event.pointerType && event.pointerType !== "mouse") {
                      event.preventDefault();
                    }
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    void handleSend();
                  }}
                  disabled={!messageInput.trim() && pendingAttachments.length === 0}
                  data-testid="chat-send-btn"
                  style={{ touchAction: "manipulation" }}
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {chatRoomsEnabled && (
        <CreateRoomModal
          isOpen={createRoomOpen}
          onClose={() => setCreateRoomOpen(false)}
          projectId={projectId}
          existingRoomNames={rooms.rooms.map((room) => room.name)}
          onCreate={async (draft) => {
            await rooms.createRoom({ name: draft.name, memberAgentIds: draft.memberAgentIds });
            if (chatScope !== "rooms") {
              setChatScope("rooms");
            }
            setCreateRoomOpen(false);
            if (isMobile) {
              setSidebarVisible(false);
            }
          }}
        />
      )}

      {/* New Chat Dialog (rendered at root level) */}
      {showNewDialog && (
        <NewChatDialog
          projectId={projectId}
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </div>
  );
}
