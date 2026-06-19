import "./QuickChatFAB.css";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { ChevronDown, Eye, EyeOff, Hash, MessageSquare, Paperclip, Pencil, Plus, Send, Square, Wrench, X } from "lucide-react";
import { attachmentBaseUrlForRoom, type Agent, type ModelInfo } from "../api";
import type { DiscoveredSkill } from "@fusion/dashboard";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ChatQuestionResponse } from "./ChatQuestionResponse";
import { ProviderIcon } from "./ProviderIcon";
import { AgentMentionPopup } from "./AgentMentionPopup";
import { matchesAgentMentionFilter } from "./mentionMatching";
import { FN_AGENT_ID, useQuickChat, type ChatMessageInfo, type ToolCallInfo } from "../hooks/useQuickChat";
import { useAgents } from "../hooks/useAgents";
import { useModelsCache } from "../hooks/useModelsCache";
import { useDiscoveredSkillsCache } from "../hooks/useDiscoveredSkillsCache";
import { FileMentionPopup } from "./FileMentionPopup";
import { useFileMention } from "../hooks/useFileMention";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { isIOS } from "../hooks/useMobileScrollLock";
import { useViewportMode } from "../hooks/useViewportMode";
import { useAppSettings } from "../hooks/useAppSettings";
import { useChatRooms } from "../hooks/useChatRooms";
import { useChatUnread } from "../hooks/useChatUnread";
import { getPersistedLastQuickChatSessionId } from "../hooks/quickChatLastSessionStorage";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { parseQuestionToolCall } from "../utils/parseQuestionToolCall";

interface PendingAttachment {
  file: File;
  /** Object URL for image previews; empty string for non-image attachments. */
  previewUrl: string;
}

interface QuickChatRoomContext {
  roomName: string;
  memberIds: ReadonlySet<string>;
}

interface QuickChatFABProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error" | "warning") => void;
  /** When false, the FAB button is hidden but the panel can still be opened programmatically via the open prop */
  showFAB?: boolean;
  /** When true, the chat panel is open */
  open?: boolean;
  /** Callback when the panel should be opened/closed */
  onOpenChange?: (open: boolean) => void;
  /** List of favorite provider names in preferred order */
  favoriteProviders?: string[];
  /** List of favorited model identifiers in format "{provider}/{modelId}" */
  favoriteModels?: string[];
  /** Called when user toggles a provider's favorite status */
  onToggleFavorite?: (provider: string) => void;
  /** Called when user toggles a model's favorite status */
  onToggleModelFavorite?: (modelId: string) => void;
  /** Optional room context for member-aware mention UX */
  roomContext?: QuickChatRoomContext | null;
}

interface ParsedModelSelection {
  modelProvider: string;
  modelId: string;
}

function getAgentLabel(agent: Agent): string {
  const base = agent.name?.trim() || agent.id;
  return `${base} (${agent.role})`;
}

function parseModelSelection(selectedModel: string): ParsedModelSelection | null {
  const value = selectedModel.trim();
  const slashIndex = value.indexOf("/");

  if (!value || slashIndex <= 0 || slashIndex >= value.length - 1) {
    return null;
  }

  return {
    modelProvider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

function formatModelTagName(modelInfo: ModelInfo | null, parsedSelection: ParsedModelSelection | null): string | null {
  if (!parsedSelection) {
    return null;
  }

  if (modelInfo?.name?.trim()) {
    return modelInfo.name.trim();
  }

  return parsedSelection.modelId
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase())
    .trim();
}

export function clampQuickChatInputHeight(scrollHeight: number, maxHeight: number = 640): number {
  // Match ChatView's 640px cap so pasted multi-paragraph text remains visible,
  // while keeping an upper bound that protects message visibility on short screens.
  return Math.max(40, Math.min(scrollHeight, maxHeight));
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
      const stringValue = typeof value === "string" ? value : (() => {
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

function renderToolCalls(
  toolCalls: ToolCallInfo[] | undefined,
  compact: boolean,
  t: TFunction<"app">,
  options?: {
    isAwaitingAnswer?: boolean;
    submittedAnswer?: string;
    onQuestionSubmit?: (answerText: string, structured: Record<string, unknown>) => void;
  },
): ReactNode {
  if (!toolCalls || toolCalls.length === 0) return null;

  const renderToolCallItem = (toolCall: ToolCallInfo, index: number) => {
    const parsedQuestion = parseQuestionToolCall(toolCall);
    if (parsedQuestion) {
      const isAwaitingAnswer = options?.isAwaitingAnswer === true;
      return (
        <ChatQuestionResponse
          key={`${toolCall.toolName}-${index}`}
          parsed={parsedQuestion}
          compact={compact}
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
    const baseSummaryPreview = isRunning
      ? argsSummary
      : resultSummary
        ? `result: ${resultSummary}`
        : argsSummary
          ? `args: ${argsSummary}`
          : null;
    const summaryPreview = compact ? null : baseSummaryPreview;
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
          {summaryPreview && <span className="chat-tool-call-preview" title={summaryPreview}>{summaryPreview}</span>}
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

  const className = `chat-tool-calls${compact ? " chat-tool-calls--compact" : ""}`;
  if (toolCalls.length === 1) {
    return (
      <div className={className} data-testid="chat-tool-calls">
        <div className="chat-tool-calls-header">
          <Wrench size={12} aria-hidden="true" />
          <span>{t("chat.toolCalls", "Tool calls")}</span>
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
      <details className={`chat-tool-calls-group${compact ? " chat-tool-calls-group--compact" : ""}`} data-testid="chat-tool-calls-group" open={hasRunning}>
        <summary className="chat-tool-calls-group-summary">
          <Wrench size={12} aria-hidden="true" />
          <span className="chat-tool-calls-count">{t("chat.toolCallsCount", "{{count}} tool calls", { count: toolCalls.length })}</span>
          <span className="chat-tool-calls-names" title={namesSummary}>{namesSummary}</span>
          {statusSummary && <span className="chat-tool-calls-group-status">{statusSummary}</span>}
        </summary>
        {toolCalls.map((toolCall, index) => renderToolCallItem(toolCall, index))}
      </details>
    </div>
  );
}

const quickChatMarkdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  pre: ({ children, ...props }) => (
    <pre {...props} className="quick-chat-markdown-pre">
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <table {...props} className="quick-chat-markdown-table">
      {children}
    </table>
  ),
};

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
  const triggerMatch = /(^|[\s])@([\w-]*)$/.exec(textBeforeCursor);
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

/** Position type for FAB positioning (right and bottom offsets from viewport edges) */
interface Position {
  x: number;
  y: number;
}

interface PanelSize {
  width: number;
  height: number;
}

type ResizeDirection = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** Offset of the panel anchor relative to the FAB position (right/bottom deltas in px). */
interface PanelAnchorOffset {
  right: number;
  bottom: number;
}

const QUICK_CHAT_DEFAULT_PANEL_SIZE: PanelSize = {
  width: 320,
  height: 400,
};

/**
 * FNXC:QuickChatPanelSize 2026-06-16-23:03:
 * FN-6502 requires Quick Chat to open taller by default on floating-panel mobile/tablet viewports while portrait mobile stays full-screen through CSS and desktop defaults plus persisted sizes remain unchanged.
 */
function getDefaultQuickChatPanelSize(): PanelSize {
  if (typeof window === "undefined" || window.innerWidth <= QUICK_CHAT_DESKTOP_BREAKPOINT || window.innerWidth > 1024) {
    return QUICK_CHAT_DEFAULT_PANEL_SIZE;
  }

  return {
    width: QUICK_CHAT_DEFAULT_PANEL_SIZE.width,
    height: Math.max(QUICK_CHAT_DEFAULT_PANEL_SIZE.height, Math.floor(window.innerHeight * 0.8)),
  };
}

const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "application/json",
  "text/yaml",
  "text/x-log",
  "text/csv",
  "application/xml",
  "text/markdown",
]);

const ALLOWED_ATTACHMENT_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
  ".xml",
  ".md",
];

function isImageAttachment(file: File): boolean {
  return file.type.startsWith("image/");
}

function isAllowedAttachment(file: File): boolean {
  if (ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
    return true;
  }

  const lowerName = file.name.toLowerCase();
  return ALLOWED_ATTACHMENT_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

const QUICK_CHAT_MIN_PANEL_SIZE: PanelSize = {
  width: 280,
  height: 260,
};

const QUICK_CHAT_DESKTOP_BREAKPOINT = 768;
const QUICK_CHAT_VIEWPORT_PADDING = 8;

/**
 * Custom hook for draggable behavior.
 * Positions are stored as right/bottom offsets (matching the current positioning model).
 * Position persists in localStorage keyed per-project.
 * @param projectId - Optional project ID for localStorage key
 * @param externalDidDragRef - External ref to track drag state for click detection
 */
function useDraggable(
  projectId?: string,
  externalDidDragRef?: React.MutableRefObject<boolean>,
  onTap?: () => void,
) {
  // Latest onTap kept in a ref so the imperatively-bound document
  // pointerup handler always calls the current closure without forcing
  // listener re-binds.
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  // Get executor footer height from CSS variable
  const getFooterHeight = useCallback((): number => {
    if (typeof window === "undefined") return 0;
    const height = getComputedStyle(document.documentElement)
      .getPropertyValue("--executor-footer-height")
      .trim();
    return height ? parseFloat(height) || 0 : 0;
  }, []);

  // Default positions
  const getDefaultPosition = useCallback((): Position => {
    // Mobile uses tighter default offset (4px vs 24px) to maximize screen space
    if (typeof window !== "undefined" && window.innerWidth <= 768) {
      return { x: 4, y: 4 + getFooterHeight() };
    }
    return { x: 24, y: 24 + getFooterHeight() };
  }, [getFooterHeight]);

  // Load position from localStorage on mount
  const [position, setPosition] = useState<Position>(() => {
    if (typeof window === "undefined") return getDefaultPosition();

    const storageKey = `fusion-quick-chat-position-${projectId || "default"}`;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Position;
        // Validate the parsed position has valid numbers
        if (typeof parsed.x === "number" && typeof parsed.y === "number" && !isNaN(parsed.x) && !isNaN(parsed.y)) {
          return parsed;
        }
      }
    } catch {
      // Ignore parse errors, fall back to default
    }
    return getDefaultPosition();
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; pointerX: number; pointerY: number } | null>(null);
  const positionRef = useRef(position);
  const activePointerIdRef = useRef<number | null>(null);
  const dragTargetRef = useRef<HTMLElement | null>(null);
  // Use external ref if provided, otherwise create internal one
  const didDragRef = externalDidDragRef ?? useRef(false);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  // Clamp position to keep FAB within viewport
  const clampPosition = useCallback((pos: Position): Position => {
    if (typeof window === "undefined") return pos;

    const fabSize = 48; // FAB is 48x48px
    // Mobile uses tighter margin (4px) to maximize screen space on small devices
    const edgeMargin = window.innerWidth <= 768 ? 4 : 8;
    // Account for mobile nav height when clamping bottom
    const mobileNavHeight = window.innerWidth <= 768 ? 44 : 0;
    // Account for executor footer height on desktop
    const footerHeight = window.innerWidth > 768 ? getFooterHeight() : 0;

    const maxX = window.innerWidth - fabSize - edgeMargin;
    const maxY = window.innerHeight - fabSize - edgeMargin - mobileNavHeight - footerHeight;

    return {
      x: Math.max(edgeMargin, Math.min(maxX, pos.x)),
      y: Math.max(edgeMargin, Math.min(maxY, pos.y)),
    };
  }, [getFooterHeight]);

  // Persist position to localStorage
  const savePosition = useCallback((pos: Position) => {
    if (typeof window === "undefined") return;

    const storageKey = `fusion-quick-chat-position-${projectId || "default"}`;
    try {
      localStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      // Ignore storage errors
    }
  }, [projectId]);

  const endDrag = useCallback(() => {
    if (!dragStartRef.current) {
      return;
    }

    const dragTarget = dragTargetRef.current;
    const pointerId = activePointerIdRef.current;

    if (dragTarget && pointerId !== null && typeof dragTarget.releasePointerCapture === "function") {
      dragTarget.releasePointerCapture(pointerId);
    }

    dragStartRef.current = null;
    activePointerIdRef.current = null;
    dragTargetRef.current = null;
    setIsDragging(false);
    document.body.style.userSelect = "";

    if (didDragRef.current) {
      savePosition(positionRef.current);
    } else {
      // A tap (not a drag). Fire the toggle from pointerup rather than
      // relying on the synthetic click: iOS Safari suppresses the click
      // when setPointerCapture() was called in pointerdown (a WebKit
      // quirk), so onClick alone never opens the panel on iPhone.
      onTapRef.current?.();
    }

    document.removeEventListener("pointermove", handleDocumentPointerMove);
    document.removeEventListener("pointerup", handleDocumentPointerUp);
    document.removeEventListener("pointercancel", handleDocumentPointerCancel);
  }, [savePosition]);

  const handleDocumentPointerMove = useCallback((event: PointerEvent) => {
    if (!dragStartRef.current) {
      return;
    }

    if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
      return;
    }

    const deltaX = event.clientX - dragStartRef.current.pointerX;
    const deltaY = event.clientY - dragStartRef.current.pointerY;

    // Check if we've moved enough to be considered a drag (>= 5px)
    if (Math.abs(deltaX) >= 5 || Math.abs(deltaY) >= 5) {
      didDragRef.current = true;
    }

    if (!didDragRef.current) {
      return;
    }

    // Move in the opposite direction (dragging right moves FAB right, which means reducing right offset)
    const newX = dragStartRef.current.x - deltaX;
    const newY = dragStartRef.current.y - deltaY;

    const clamped = clampPosition({ x: newX, y: newY });
    positionRef.current = clamped;
    setPosition(clamped);
  }, [clampPosition]);

  const handleDocumentPointerUp = useCallback((event: PointerEvent) => {
    if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
      return;
    }

    endDrag();
  }, [endDrag]);

  const handleDocumentPointerCancel = useCallback((event: PointerEvent) => {
    if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
      return;
    }

    endDrag();
  }, [endDrag]);

  // Handle pointer down (start drag)
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    // Only handle primary button (left click) or touch
    if (event.button !== 0 && event.pointerType === "mouse") return;

    const fabButton = event.currentTarget;

    event.preventDefault();
    // setPointerCapture may not exist in jsdom/tests
    if (typeof fabButton.setPointerCapture === "function") {
      fabButton.setPointerCapture(event.pointerId);
    }

    const currentPosition = positionRef.current;
    dragStartRef.current = {
      x: currentPosition.x,
      y: currentPosition.y,
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
    activePointerIdRef.current = event.pointerId;
    dragTargetRef.current = fabButton;
    didDragRef.current = false;
    setIsDragging(true);

    // Prevent text selection during drag
    document.body.style.userSelect = "none";

    document.addEventListener("pointermove", handleDocumentPointerMove, { passive: true });
    document.addEventListener("pointerup", handleDocumentPointerUp);
    document.addEventListener("pointercancel", handleDocumentPointerCancel);
  }, [handleDocumentPointerCancel, handleDocumentPointerMove, handleDocumentPointerUp]);

  useEffect(() => () => {
    document.removeEventListener("pointermove", handleDocumentPointerMove);
    document.removeEventListener("pointerup", handleDocumentPointerUp);
    document.removeEventListener("pointercancel", handleDocumentPointerCancel);
    document.body.style.userSelect = "";
  }, [handleDocumentPointerCancel, handleDocumentPointerMove, handleDocumentPointerUp]);

  return {
    position,
    isDragging,
    handlePointerDown,
  };
}

function usePanelResize(projectId: string | undefined, fabRight: number, fabBottom: number, isOpen: boolean) {
  const storageKey = `fusion:quick-chat-size-${projectId || "default"}`;

  const isDesktopViewport = useCallback(
    () => typeof window !== "undefined" && window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT,
    [],
  );

  /** Clamp width/height given the effective anchor point (right/bottom offsets from viewport edges). */
  const clampPanelSize = useCallback(
    (size: PanelSize, anchorRight: number, anchorBottom: number): PanelSize => {
      if (typeof window === "undefined") {
        return size;
      }

      const maxWidth = Math.max(
        QUICK_CHAT_MIN_PANEL_SIZE.width,
        window.innerWidth - anchorRight - QUICK_CHAT_VIEWPORT_PADDING,
      );
      const maxHeight = Math.max(
        QUICK_CHAT_MIN_PANEL_SIZE.height,
        window.innerHeight - anchorBottom - QUICK_CHAT_VIEWPORT_PADDING,
      );

      return {
        width: Math.max(QUICK_CHAT_MIN_PANEL_SIZE.width, Math.min(maxWidth, size.width)),
        height: Math.max(QUICK_CHAT_MIN_PANEL_SIZE.height, Math.min(maxHeight, size.height)),
      };
    },
    [],
  );

  const loadPersistedSize = useCallback((): PanelSize => {
    const defaultSize = getDefaultQuickChatPanelSize();
    if (typeof window === "undefined" || window.innerWidth <= QUICK_CHAT_DESKTOP_BREAKPOINT) {
      return defaultSize;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return defaultSize;
      const parsed = JSON.parse(raw) as Partial<PanelSize>;
      if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
        return defaultSize;
      }
      return { width: parsed.width, height: parsed.height };
    } catch {
      return defaultSize;
    }
  }, [storageKey]);

  const [panelSize, setPanelSize] = useState<PanelSize>(loadPersistedSize);
  const panelSizeRef = useRef(panelSize);
  const hasUserResizedPanelRef = useRef(false);

  useEffect(() => {
    panelSizeRef.current = panelSize;
  }, [panelSize]);

  /**
   * Anchor offset relative to the FAB position.
   * When the user drags the south or east handle, we shift the anchor so the
   * panel top/left edge moves while the opposite edge stays fixed.
   */
  const [anchorOffset, setAnchorOffset] = useState<PanelAnchorOffset>({ right: 0, bottom: 0 });

  useEffect(() => {
    if (!isOpen || !isDesktopViewport()) return;
    const effective = { right: fabRight + anchorOffset.right, bottom: fabBottom + anchorOffset.bottom };
    setPanelSize((current) => clampPanelSize(current, effective.right, effective.bottom));
  }, [anchorOffset, clampPanelSize, fabBottom, fabRight, isDesktopViewport, isOpen]);

  useEffect(() => {
    if (!isOpen || !isDesktopViewport() || !hasUserResizedPanelRef.current) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(panelSize));
    } catch {
      // Ignore storage errors (private mode / quota)
    }
  }, [isDesktopViewport, isOpen, panelSize, storageKey]);

  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDesktopViewport()) return;

      const direction = event.currentTarget.dataset.resizeDirection as ResizeDirection | undefined;
      if (!direction) return;

      event.preventDefault();
      event.stopPropagation();

      const resizeHandle = event.currentTarget;
      if (typeof resizeHandle.setPointerCapture === "function") {
        resizeHandle.setPointerCapture(event.pointerId);
      }

      const startState = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        width: panelSize.width,
        height: panelSize.height,
        anchorRight: anchorOffset.right,
        anchorBottom: anchorOffset.bottom,
      };

      document.body.style.userSelect = "none";

      const onPointerMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startState.pointerX;
        const dy = moveEvent.clientY - startState.pointerY;

        let nextWidth = startState.width;
        let nextHeight = startState.height;
        let nextAnchorRight = startState.anchorRight;
        let nextAnchorBottom = startState.anchorBottom;

        // West handle: dragging left grows width (panel expands left).
        if (direction.includes("w")) {
          nextWidth = startState.width - dx;
        }

        // East handle: dragging right grows width (panel expands right).
        // The right anchor must shift leftward (decrease) to keep left edge fixed.
        if (direction.includes("e")) {
          const widthDelta = dx;
          nextWidth = startState.width + widthDelta;
          nextAnchorRight = startState.anchorRight - widthDelta;
        }

        // North handle: dragging up grows height (panel expands upward).
        if (direction.includes("n")) {
          nextHeight = startState.height - dy;
        }

        // South handle: dragging down grows height (panel expands downward).
        // The bottom anchor must shift upward (decrease) to keep the top edge fixed.
        if (direction.includes("s")) {
          const heightDelta = dy;
          nextHeight = startState.height + heightDelta;
          nextAnchorBottom = startState.anchorBottom - heightDelta;
        }

        // Clamp size against effective anchor position.
        const effectiveRight = fabRight + nextAnchorRight;
        const effectiveBottom = fabBottom + nextAnchorBottom;
        const clamped = clampPanelSize({ width: nextWidth, height: nextHeight }, effectiveRight, effectiveBottom);

        // Also clamp the anchor offsets so the panel doesn't go off-screen.
        const clampedAnchorRight = Math.max(
          QUICK_CHAT_VIEWPORT_PADDING - fabRight,
          Math.min(
            window.innerWidth - fabRight - QUICK_CHAT_MIN_PANEL_SIZE.width - QUICK_CHAT_VIEWPORT_PADDING,
            nextAnchorRight,
          ),
        );
        const clampedAnchorBottom = Math.max(
          QUICK_CHAT_VIEWPORT_PADDING - fabBottom,
          Math.min(
            window.innerHeight - fabBottom - QUICK_CHAT_MIN_PANEL_SIZE.height - QUICK_CHAT_VIEWPORT_PADDING,
            nextAnchorBottom,
          ),
        );

        hasUserResizedPanelRef.current = true;
        setPanelSize(clamped);
        setAnchorOffset({ right: clampedAnchorRight, bottom: clampedAnchorBottom });
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        if (typeof resizeHandle.releasePointerCapture === "function") {
          resizeHandle.releasePointerCapture(upEvent.pointerId);
        }
        document.body.style.userSelect = "";
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);

        // Persist final size.
        try {
          localStorage.setItem(storageKey, JSON.stringify(panelSizeRef.current));
        } catch {
          // Best-effort
        }
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [
      anchorOffset.bottom,
      anchorOffset.right,
      clampPanelSize,
      fabBottom,
      fabRight,
      isDesktopViewport,
      storageKey,
    ],
  );

  return {
    panelSize,
    anchorOffset,
    handleResizeStart,
  };
}

interface QuickChatMessageItemProps {
  message: ChatMessageInfo;
  forcePlain: boolean;
  mentionAgentsByName: Map<string, Agent>;
  roomContext: QuickChatRoomContext | null;
  projectId?: string;
  onToggleRender: (id: string) => void;
  isAwaitingQuestionAnswer: boolean;
  submittedQuestionAnswer?: string;
  onQuestionSubmit: (answerText: string, structured: Record<string, unknown>) => void;
}

// Memoized so streaming state churn doesn't re-render every prior message
// (each one would re-run ReactMarkdown over its full content otherwise).
function findSubmittedQuestionAnswer(messages: ChatMessageInfo[], messageIndex: number): string | undefined {
  return messages.slice(messageIndex + 1).find((message) => message.role === "user")?.content;
}

const QuickChatMessageItem = memo(function QuickChatMessageItem({
  message,
  forcePlain,
  mentionAgentsByName,
  roomContext,
  projectId,
  onToggleRender,
  isAwaitingQuestionAnswer,
  submittedQuestionAnswer,
  onQuestionSubmit,
}: QuickChatMessageItemProps) {
  const { t } = useTranslation("app");
  const isSent = message.role === "user";

  const renderedUserContent = useMemo<ReactNode>(() => {
    if (!isSent) return null;
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
  }, [isSent, message.content, mentionAgentsByName, roomContext]);

  const assistantBody = useMemo<ReactNode>(() => {
    if (isSent) return null;
    if (forcePlain) {
      return <div className="quick-chat-message-content quick-chat-message-content--plain">{linkifyFilePaths(message.content)}</div>;
    }
    return (
      <div className="quick-chat-message-content quick-chat-message-content--markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={quickChatMarkdownComponents}>
          {message.content}
        </ReactMarkdown>
      </div>
    );
  }, [isSent, forcePlain, message.content]);

  const renderedAttachments = useMemo(() => {
    if (!message.attachments?.length || !message.roomId) return null;
    const baseUrl = attachmentBaseUrlForRoom(message.roomId, projectId);
    return (
      <div className="chat-message-attachments">
        {message.attachments.map((attachment) => {
          const href = `${baseUrl}${encodeURIComponent(attachment.filename)}`;
          const isImage = attachment.mimeType.startsWith("image/");
          return (
            <a
              key={attachment.id}
              className="chat-message-attachment"
              href={href}
              target="_blank"
              rel="noreferrer"
              data-testid="quick-chat-message-attachment"
            >
              {isImage ? <img src={href} alt={attachment.originalName} className="chat-attachment-image" loading="lazy" /> : <span>{attachment.originalName}</span>}
            </a>
          );
        })}
      </div>
    );
  }, [message.attachments, message.roomId, projectId]);

  return (
    <div
      className={`quick-chat-panel-message ${isSent ? "quick-chat-panel-message--sent" : "quick-chat-panel-message--received"}`}
      data-testid={`quick-chat-message-${message.id}`}
    >
      {isSent
        ? <p>{renderedUserContent}</p>
        : (
          <>
            {assistantBody}
            <button
              type="button"
              className={`quick-chat-message-render-toggle${forcePlain ? " quick-chat-message-render-toggle--plain" : ""}`}
              data-testid="quick-chat-message-render-toggle"
              aria-label={forcePlain ? t("chat.showRenderedMarkdown", "Show rendered markdown") : t("chat.showPlainText", "Show plain text")}
              onClick={() => onToggleRender(message.id)}
            >
              {forcePlain ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </>
        )}
      {renderedAttachments}
      {renderToolCalls(message.toolCalls, true, t, {
        isAwaitingAnswer: isAwaitingQuestionAnswer,
        submittedAnswer: submittedQuestionAnswer,
        onQuestionSubmit,
      })}
    </div>
  );
});

export function QuickChatFAB({
  projectId,
  addToast,
  showFAB = true,
  open,
  onOpenChange,
  favoriteProviders = [],
  favoriteModels = [],
  onToggleFavorite,
  onToggleModelFavorite,
  roomContext = null,
}: QuickChatFABProps) {
  const { t } = useTranslation("app");
  const { agents } = useAgents(projectId);
  const {
    models,
    defaultProvider,
    defaultModelId,
    loading: modelsLoading,
  } = useModelsCache();
  const { skills: discoveredSkills, loading: skillsLoading } = useDiscoveredSkillsCache(projectId);
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

  // We still consume keyboardOpen for layout decisions outside the panel,
  // but the high-frequency --vv-offset-top / --vv-height tracking is set
  // directly on the panel DOM in a layout effect below — going through
  // React state introduces a per-event reconciliation lag that the human
  // eye reads as jank while the iOS keyboard is animating in.
  const { keyboardOpen } = useMobileKeyboard({ enabled: isOpen });
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";

  const [chatMode, setChatMode] = useState<"agent" | "model">("agent");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [newSessionChooserOpen, setNewSessionChooserOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [renameDialog, setRenameDialog] = useState<{ sessionId: string; title: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [newSessionMode, setNewSessionMode] = useState<"agent" | "model">("model");
  const [newSessionAgentId, setNewSessionAgentId] = useState<string>("");
  const [newSessionModel, setNewSessionModel] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [configuredDefaultModelSelection, setConfiguredDefaultModelSelection] = useState<string>("");
  const [messageInput, setMessageInput] = useState("");
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPopupVisible, setMentionPopupVisible] = useState(false);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const [plainTextMessageIds, setPlainTextMessageIds] = useState<Set<string>>(() => new Set());
  const [helpMessageVisible, setHelpMessageVisible] = useState(false);
  /** Pending attachments staged in the composer before being sent. */
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);

  // File mention state and hook
  const [, setFileMentionPopupVisible] = useState(false);
  const [fileMentionPosition, setFileMentionPosition] = useState({ top: 0, left: 0 });
  const fileMention = useFileMention({ projectId });

  // Calculate popup position based on caret position in input
  const updateFileMentionPosition = useCallback((input: HTMLTextAreaElement | null) => {
    if (!input || !fileMention.mentionActive) return;

    // Get input position
    const rect = input.getBoundingClientRect();

    // Position above the input, using viewport coordinates
    // The popup is absolutely positioned, so we use window coordinates
    setFileMentionPosition({
      top: rect.top - 260, // Popup appears above with gap (accounting for popup height)
      left: rect.left + 8, // Small left offset
    });
  }, [fileMention.mentionActive]);

  // Track if we just finished a drag (to prevent click from firing after drag)
  const didDragRef = useRef(false);
  const modelsRequestedRef = useRef(false);
  const modelsInitSettledRef = useRef(false);
  const prevSessionTargetRef = useRef("");
  const hasAppliedInitialSessionRef = useRef(false);
  const restoredFromExistingSessionRef = useRef(false);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const selectedModelRef = useRef(selectedModel);
  const mentionCursorPosRef = useRef(0);
  const hideMentionPopupTimeoutRef = useRef<number | null>(null);
  const hideSkillMenuTimeoutRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);
  // Set by the latest tap handler (defined further down, after isOpen /
  // stealthInputRef exist). Indirection keeps the useDraggable call above
  // those declarations.
  const fabTapHandlerRef = useRef<(() => void) | null>(null);
  // True for ~the click-delay window after a pointerup tap fired the
  // toggle, so the trailing synthetic click (when iOS does emit one)
  // doesn't double-toggle.
  const suppressNextFabClickRef = useRef(false);

  // Draggable hook for FAB positioning
  const {
    position,
    isDragging,
    handlePointerDown,
  } = useDraggable(projectId, didDragRef, () => fabTapHandlerRef.current?.());

  // Panel stays 60px above FAB (FAB is 48px tall + 12px gap)
  const panelY = position.y + 60;
  const { panelSize, anchorOffset, handleResizeStart } = usePanelResize(projectId, position.x, panelY, isOpen);
  const shouldApplyDesktopPanelSize = typeof window !== "undefined" && window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT;

  // Chat session hook
  const {
    activeSession,
    messages,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    sessions,
    sessionsLoading,
    messagesLoading,
    sendMessage,
    stopStreaming,
    pendingMessage,
    clearPendingMessage,
    switchSession,
    selectSession,
    startModelChat,
    startFreshSession,
    renameSession,
    refreshSessions,
    skipNextSessionInitRef,
  } = useQuickChat(projectId, addToast);
  const { experimentalFeatures } = useAppSettings();
  const chatRoomsEnabled = experimentalFeatures?.chatRooms === true;
  const roomsState = useChatRooms(projectId, addToast);
  const { isUnread, markRead } = useChatUnread(projectId);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const shouldAutoFocusComposerRef = useRef(false);
  const handledMobileActionRef = useRef(false);
  const handledMobileActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dedupe pointerdown vs touchstart within a single tap: a real touch fires
  // both, and each handler runs its action before React flushes the input
  // clear, so without this the action runs twice per tap.
  const touchActionGestureRef = useRef(false);
  const preserveComposerFocusRef = useRef(false);
  // Always-mounted offscreen input used to claim the iOS soft keyboard
  // synchronously inside the FAB click gesture, before the real composer
  // input has rendered (or while it is still `disabled` waiting for the
  // session). Focus is transferred to the real input once it is enabled —
  // iOS keeps the keyboard up across that transfer.
  const stealthInputRef = useRef<HTMLInputElement | null>(null);
  // Set true briefly while the keyboard is dismissing. While set, the
  // visualViewport apply() ignores incoming vv.height values so iOS's
  // mid-dismiss reports cannot shrink the panel back down — the panel
  // visually grows to full height immediately on blur and the keyboard
  // slides down on top of it.
  const suppressVvShrinkRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const previousOpenStateRef = useRef<{ isOpen: boolean; sessionId: string | null; messagesLoading: boolean }>({
    isOpen: false,
    sessionId: null,
    messagesLoading: false,
  });

  // Pin the document at the top while the panel is open on mobile.
  // Otherwise iOS can leave window.scrollY > 0 (e.g. after the keyboard
  // was opened and dismissed once), and on the next open the
  // position:fixed panel anchors to layout top:0 which is *above* the
  // visible viewport — only the bottom of the panel (the input bar)
  // pokes into view at the top of the screen.
  //
  // We deliberately do NOT use `body { position: fixed }` to lock scroll:
  // that would make the body the containing block for the panel's
  // position:fixed and reintroduce the same translation bug. Instead we
  // scroll to 0 and lock overflow on <html> and <body>; the panel's
  // viewport anchor stays correct.
  useEffect(() => {
    if (!isOpen) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;

    const scrollY = window.scrollY;
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
    };

    window.scrollTo(0, 0);
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [isOpen]);

  // Mirror visualViewport metrics onto the panel as CSS variables
  // directly, bypassing React state. --vv-height shrinks the panel to
  // the visible area; --vv-offset-top compensates for iOS shifting the
  // visual viewport on input focus (without it the position:fixed panel
  // slides off-screen on the second focus after the keyboard has been
  // dismissed once).
  //
  // We deliberately do NOT throttle via requestAnimationFrame here.
  // iOS fires visualViewport resize/scroll events on the same frame as
  // its own keyboard animation; deferring our write to the next frame
  // makes the panel lag iOS by one paint, which is visible as a slide.
  // Synchronous writes keep the panel locked to the visual viewport.
  /*
  FNXC:QuickChatMobileResize 2026-06-16-18:14:
  FN-6498 requires the mobile fullscreen sheet to track visualViewport samples smoothly across iOS and Android. Keep iOS second-focus offsetTop compensation and keyboard-dismiss pre-grow, but avoid redundant same-sample resize/scroll writes that add layout thrash on Android Chrome interactive-widget=resizes-content.

  FNXC:QuickChatMobileResize 2026-06-16-23:45:
  FN-6503 requires the first Android open to re-sample visualViewport after the stealth-input to composer focus handoff. Android Chrome can settle the keyboard shrink without a later resize observed by this panel effect, so focusin runs an immediate synchronous apply plus a short settle tail while resize/scroll remain synchronous for iOS animation lock-step.
  */
  useLayoutEffect(() => {
    if (!isOpen) return;
    if (!isMobile) return;
    if (typeof window === "undefined" || !window.visualViewport) return;
    if (window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
    const panel = panelRef.current;
    if (!panel) return;

    const vv = window.visualViewport;
    let lastAppliedSample: { height: number; offsetTop: number } | null = null;
    const apply = () => {
      if (suppressVvShrinkRef.current) return;
      const nextSample = { height: vv.height, offsetTop: vv.offsetTop || 0 };
      if (
        lastAppliedSample
        && lastAppliedSample.height === nextSample.height
        && lastAppliedSample.offsetTop === nextSample.offsetTop
      ) {
        return;
      }
      lastAppliedSample = nextSample;
      panel.style.setProperty("--vv-height", `${nextSample.height}px`);
      panel.style.setProperty("--vv-offset-top", `${nextSample.offsetTop}px`);
    };

    const timeoutIds: number[] = [];
    let rafId: number | null = null;
    let pollDeadline = 0;
    let lastTailSample: { height: number; offsetTop: number } | null = null;
    let stableFrames = 0;

    const cancelTailPoll = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const pollTailFrame = () => {
      apply();
      const currentSample = { height: vv.height, offsetTop: vv.offsetTop || 0 };
      if (
        lastTailSample
        && lastTailSample.height === currentSample.height
        && lastTailSample.offsetTop === currentSample.offsetTop
      ) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastTailSample = currentSample;
      }

      if (stableFrames >= 2 || performance.now() > pollDeadline) {
        rafId = null;
        return;
      }

      rafId = window.requestAnimationFrame(pollTailFrame);
    };

    const scheduleTailUpdates = () => {
      for (const delayMs of [50, 200, 500]) {
        const timeoutId = window.setTimeout(apply, delayMs);
        timeoutIds.push(timeoutId);
      }

      if (typeof window.requestAnimationFrame !== "function") return;
      cancelTailPoll();
      pollDeadline = performance.now() + 500;
      lastTailSample = null;
      stableFrames = 0;
      rafId = window.requestAnimationFrame(pollTailFrame);
    };

    const applyWithTail = () => {
      apply();
      scheduleTailUpdates();
    };

    applyWithTail();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    document.addEventListener("focusin", applyWithTail);
    return () => {
      suppressVvShrinkRef.current = false;
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", applyWithTail);
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      cancelTailPoll();
      panel.style.removeProperty("--vv-height");
      panel.style.removeProperty("--vv-offset-top");
    };
  }, [isMobile, isOpen]);

  const resolvedModelSelection = selectedModel || configuredDefaultModelSelection;
  const targetModelSelection = useMemo(
    () => parseModelSelection(resolvedModelSelection),
    [resolvedModelSelection],
  );
  const displayedModelSelection = useMemo(() => {
    if (chatMode === "model" && activeSession?.modelProvider && activeSession?.modelId) {
      return `${activeSession.modelProvider}/${activeSession.modelId}`;
    }
    return resolvedModelSelection;
  }, [activeSession?.modelId, activeSession?.modelProvider, chatMode, resolvedModelSelection]);

  const parsedModelSelection = useMemo(() => parseModelSelection(displayedModelSelection), [displayedModelSelection]);
  const selectedModelInfo = useMemo(
    () => models.find((model) => `${model.provider}/${model.id}` === displayedModelSelection) ?? null,
    [displayedModelSelection, models],
  );
  const selectedModelTag = useMemo(
    () => formatModelTagName(selectedModelInfo, parsedModelSelection),
    [selectedModelInfo, parsedModelSelection],
  );

  const sessionTargetKey = useMemo(() => {
    if (chatMode === "model") {
      if (targetModelSelection) {
        return `${FN_AGENT_ID}::${targetModelSelection.modelProvider}/${targetModelSelection.modelId}`;
      }
      return "";
    }
    // chatMode === "agent"
    if (selectedAgentId) {
      return `${selectedAgentId}::`;
    }
    return "";
  }, [chatMode, selectedAgentId, targetModelSelection]);

  const hasChatTarget = chatMode === "agent" ? Boolean(selectedAgentId) : Boolean(targetModelSelection);
  const roomThreadActive = chatRoomsEnabled && Boolean(roomsState.activeRoom);
  const displayedMessages = useMemo<ChatMessageInfo[]>(() => {
    if (!roomThreadActive) {
      return messages;
    }
    return roomsState.messages.map((message) => ({
      id: message.id,
      sessionId: message.roomId,
      roomId: message.roomId,
      role: message.role,
      content: message.content,
      thinkingOutput: message.thinkingOutput,
      toolCalls: undefined,
      attachments: message.attachments,
      createdAt: message.createdAt,
    }));
  }, [messages, roomThreadActive, roomsState.messages]);
  const inputDisabled = roomThreadActive ? false : (!hasChatTarget || !activeSession);
  const sendDisabled =
    (messageInput.trim().length === 0 && pendingAttachments.length === 0)
    || (!roomThreadActive && !hasChatTarget)
    || (!roomThreadActive && !activeSession);
  const hasPersistedAgentSessionSelection = useMemo(
    () => Boolean(selectedAgentId) && sessions.some((session) => !session.modelProvider && !session.modelId && session.agentId === selectedAgentId),
    [selectedAgentId, sessions],
  );

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId("");
      setChatMode("model");
      return;
    }

    if (hasAppliedInitialSessionRef.current && hasPersistedAgentSessionSelection) {
      return;
    }

    const selectedStillExists = agents.some((agent) => agent.id === selectedAgentId);
    if (!selectedStillExists) {
      setSelectedAgentId(agents[0]?.id ?? "");
    }
  }, [agents, hasPersistedAgentSessionSelection, selectedAgentId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!modelsRequestedRef.current) {
      modelsRequestedRef.current = true;
      modelsInitSettledRef.current = false;
    }

    if (modelsLoading || !modelsRequestedRef.current || modelsInitSettledRef.current) {
      return;
    }

    if (!selectedModelRef.current && models.length > 0) {
      if (defaultProvider && defaultModelId) {
        const defaultSelection = `${defaultProvider}/${defaultModelId}`;
        const hasDefaultModel = models.some((model) => `${model.provider}/${model.id}` === defaultSelection);
        if (hasDefaultModel) {
          setConfiguredDefaultModelSelection(defaultSelection);
          if (!selectedModelRef.current) {
            setSelectedModel(defaultSelection);
          }
          if (!hasAppliedInitialSessionRef.current) {
            setChatMode("model");
          }
          modelsInitSettledRef.current = true;
          return;
        }
      }

      setConfiguredDefaultModelSelection("");
      const firstModel = models[0];
      if (firstModel && !selectedModelRef.current) {
        setSelectedModel(`${firstModel.provider}/${firstModel.id}`);
      }
    }

    modelsInitSettledRef.current = true;
  }, [defaultModelId, defaultProvider, isOpen, models, modelsLoading]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshSessions();
  }, [isOpen, refreshSessions]);

  useEffect(() => {
    if (!isOpen || sessionsLoading || hasAppliedInitialSessionRef.current || sessions.length === 0) {
      return;
    }

    const activeSessions = sessions.filter((session) => session.status !== "archived");
    const persistedSessionId = getPersistedLastQuickChatSessionId(projectId);
    const persistedSession = persistedSessionId
      ? activeSessions.find((session) => session.id === persistedSessionId) ?? null
      : null;
    const timestamp = (value?: string | null): number => {
      if (!value) return 0;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    /*
    FNXC:QuickChatRestore 2026-06-17-00:17:
    Quick Chat must resume the exact direct session the user last opened; only stale or missing persisted ids may fall back.
    Rank fallback sessions by conversation activity first because metadata-only updatedAt bumps can make an older same-target thread look newer than the user's last real chat.
    */
    const latestSession = [...activeSessions].sort((a, b) => {
      const aLastTouched = timestamp(a.lastMessageAt) || timestamp(a.updatedAt);
      const bLastTouched = timestamp(b.lastMessageAt) || timestamp(b.updatedAt);
      return bLastTouched - aLastTouched;
    })[0];
    const sessionToRestore = persistedSession ?? latestSession;

    if (sessionToRestore) {
      if (sessionToRestore.modelProvider && sessionToRestore.modelId) {
        setChatMode("model");
        setSelectedModel(`${sessionToRestore.modelProvider}/${sessionToRestore.modelId}`);
      } else {
        setChatMode("agent");
        setSelectedAgentId(sessionToRestore.agentId);
      }

      restoredFromExistingSessionRef.current = true;
      void selectSession(sessionToRestore);
    } else {
      restoredFromExistingSessionRef.current = false;
    }

    hasAppliedInitialSessionRef.current = true;
  }, [isOpen, projectId, selectSession, sessions, sessionsLoading]);

  // Initialize/switch quick chat session whenever the selected target changes.
  // NOTE: activeSession and sessionsLoading are in the dependency array to
  // enable retry-when-null (see shouldRetrySessionInit), but the hook's
  // switchSession now reads activeSession from a ref so it doesn't get a
  // new identity on every activeSession change.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const waitingForInitialModelResolution = !hasAppliedInitialSessionRef.current
      && sessions.length === 0
      && modelsRequestedRef.current
      && !modelsInitSettledRef.current;
    if (waitingForInitialModelResolution) {
      return;
    }

    const persistedSessionId = getPersistedLastQuickChatSessionId(projectId);
    const waitingForPersistedSessionRestore = !hasAppliedInitialSessionRef.current
      && Boolean(persistedSessionId)
      && sessionsLoading;
    if (waitingForPersistedSessionRestore) {
      return;
    }

    if (!sessionTargetKey) {
      prevSessionTargetRef.current = "";
      return;
    }

    // When startFreshSession is in progress, skip the automatic init to
    // prevent racing with the explicit fresh-session creation.  Record the
    // target key as "seen" so a later render won't re-trigger for the same
    // target.
    if (skipNextSessionInitRef.current) {
      prevSessionTargetRef.current = sessionTargetKey;
      return;
    }

    const shouldRetrySessionInit = sessionTargetKey === prevSessionTargetRef.current
      && !activeSession
      && !sessionsLoading;

    if (restoredFromExistingSessionRef.current) {
      /*
      FNXC:QuickChatRestore 2026-06-17-00:18:
      A restored direct session is id-specific, not just target-specific.
      Skip the first automatic same-target switch so fetchResumeChatSession cannot replace the restored session with a different thread that shares the agent or model target and then clobber localStorage.
      */
      restoredFromExistingSessionRef.current = false;
      prevSessionTargetRef.current = sessionTargetKey;
      return;
    }

    if (sessionTargetKey === prevSessionTargetRef.current && !shouldRetrySessionInit) {
      return;
    }

    prevSessionTargetRef.current = sessionTargetKey;

    if (chatMode === "model" && targetModelSelection) {
      void startModelChat(targetModelSelection.modelProvider, targetModelSelection.modelId);
      return;
    }

    if (chatMode === "agent" && selectedAgentId) {
      void switchSession(selectedAgentId);
    }
  }, [
    isOpen,
    chatMode,
    targetModelSelection,
    selectedAgentId,
    sessionTargetKey,
    activeSession,
    sessionsLoading,
    startModelChat,
    switchSession,
    skipNextSessionInitRef,
    projectId,
  ]);

  useEffect(() => {
    if (isOpen) {
      return;
    }

    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
    setShowSkillMenu(false);
    setSkillFilter("");
    setHighlightedSkillIndex(0);
    pendingAttachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    });
    setPendingAttachments([]);
  }, [isOpen]);

  useEffect(() => {
    hasAppliedInitialSessionRef.current = false;
    restoredFromExistingSessionRef.current = false;
    modelsRequestedRef.current = false;
    modelsInitSettledRef.current = false;
    prevSessionTargetRef.current = "";
  }, [projectId]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    if (!isOpen) {
      shouldAutoFocusComposerRef.current = false;
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    /*
    FNXC:QuickChat 2026-06-17-02:50:
    Bringing up Quick Chat must focus the composer on every viewport so typing can start immediately. Mobile still claims the iOS keyboard through the stealth input first; the ready-state focus effect keeps that synchronous handoff while desktop reaches its requestAnimationFrame focus path.
    */
    shouldAutoFocusComposerRef.current = true;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || inputDisabled || !shouldAutoFocusComposerRef.current) {
      return;
    }

    const input = inputRef.current;
    if (!input) {
      return;
    }

    const activeElement = document.activeElement;
    const panelContainsFocus = activeElement ? panelRef.current?.contains(activeElement) : false;
    const isBodyFocused = activeElement === document.body;
    const stealthIsFocused = activeElement === stealthInputRef.current;

    if (!panelContainsFocus && !isBodyFocused && !stealthIsFocused) {
      shouldAutoFocusComposerRef.current = false;
      return;
    }

    // When the stealth input is currently holding the iOS keyboard, transfer
    // focus synchronously — going through requestAnimationFrame breaks the
    // keyboard handoff on Safari and the keyboard dismisses.
    if (stealthIsFocused) {
      input.focus({ preventScroll: true });
      shouldAutoFocusComposerRef.current = false;
      return;
    }

    const frame = requestAnimationFrame(() => {
      input.focus();
      shouldAutoFocusComposerRef.current = false;
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen, inputDisabled]);

  // Attachment object URLs must be revoked when the composer unmounts.
  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, []);

  const handleStartFreshChat = useCallback(() => {
    setNewSessionChooserOpen(true);
    setNewSessionMode("model");
    setNewSessionAgentId(agents[0]?.id ?? "");
    setNewSessionModel(selectedModel || configuredDefaultModelSelection || "");
  }, [agents, configuredDefaultModelSelection, selectedModel]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const filteredSkills = useMemo(() => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    const matchingSkills = normalizedFilter
      ? discoveredSkills.filter((skill) => skill.name.toLowerCase().includes(normalizedFilter))
      : discoveredSkills;
    return matchingSkills.slice(0, 10);
  }, [discoveredSkills, skillFilter]);

  const filteredMentionAgents = useMemo(() => {
    const matchingAgents = agents.filter((agent) => matchesAgentMentionFilter(agent.name, mentionFilter));
    if (!roomContext) {
      return matchingAgents;
    }

    const memberAgents = matchingAgents.filter((agent) => roomContext.memberIds.has(agent.id));
    if (mentionFilter.trim().length === 0) {
      return memberAgents;
    }

    const otherAgents = matchingAgents.filter((agent) => !roomContext.memberIds.has(agent.id));
    return [...memberAgents, ...otherAgents];
  }, [agents, mentionFilter, roomContext]);

  const mentionAgentsByName = useMemo(() => {
    const byName = new Map<string, Agent>();
    for (const agent of agents) {
      byName.set(agent.name.toLowerCase(), agent);
    }
    return byName;
  }, [agents]);

  // Key the reset on skill ids, not array identity: useDiscoveredSkillsCache
  // (SWR) re-delivers content-identical lists with fresh identities, and an
  // identity-keyed reset wipes the user's keyboard highlight mid-navigation
  // when a revalidation lands (see docs/solutions/ui-bugs/
  // skill-autocomplete-highlight-reset-on-swr-revalidation.md).
  const filteredSkillsKey = useMemo(
    () => filteredSkills.map((skill) => skill.id).join(" "),
    [filteredSkills],
  );
  useEffect(() => {
    setHighlightedSkillIndex(0);
  }, [filteredSkillsKey]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionFilter, mentionPopupVisible]);

  useEffect(() => {
    return () => {
      if (hideMentionPopupTimeoutRef.current !== null) {
        window.clearTimeout(hideMentionPopupTimeoutRef.current);
        hideMentionPopupTimeoutRef.current = null;
      }
      if (hideSkillMenuTimeoutRef.current !== null) {
        window.clearTimeout(hideSkillMenuTimeoutRef.current);
        hideSkillMenuTimeoutRef.current = null;
      }
    };
  }, []);

  // Click outside and escape handling
  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      // Don't close if clicking inside a portaled dropdown (e.g., CustomModelDropdown)
      if ((target as HTMLElement).closest(".model-combobox-dropdown--portal")) return;
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
  }, [isOpen, setIsOpen]);

  const updateScrollState = useCallback(() => {
    const messagesEl = messagesRef.current;
    if (!messagesEl) return;

    const threshold = 50;
    const atBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - threshold;
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
    const messagesEl = messagesRef.current;
    if (!messagesEl) return;
    anchorToBottom(messagesEl);
  }, [anchorToBottom]);

  useLayoutEffect(() => {
    const threadId = roomThreadActive ? (roomsState.activeRoom?.id ?? null) : (activeSession?.id ?? null);
    const threadMessagesLoading = roomThreadActive ? roomsState.messagesLoading : messagesLoading;
    const previousState = previousOpenStateRef.current;
    previousOpenStateRef.current = { isOpen, sessionId: threadId, messagesLoading: threadMessagesLoading };

    if (!isOpen || !threadId) {
      return;
    }

    const openingNow = !previousState.isOpen && isOpen;
    const sessionChangedWhileOpen = previousState.isOpen && previousState.sessionId !== threadId;
    const messagesSettledAfterOpen = previousState.isOpen
      && previousState.sessionId === threadId
      && previousState.messagesLoading
      && !threadMessagesLoading;
    if (!openingNow && !sessionChangedWhileOpen && !messagesSettledAfterOpen) {
      return;
    }

    const messagesEl = messagesRef.current;
    if (!messagesEl) return;

    /*
    FNXC:QuickChatScroll 2026-06-17-01:06:
    FN-6513 requires quick chat opens to land on the live tail after asynchronous messages settle across direct sessions and room threads, on desktop and mobile. Re-run the same anchor path on loading-to-loaded transitions so a bounded initial-open frame loop cannot finish against the loading placeholder and leave isUserScrolling suppressing tail auto-scroll.
    */
    anchorToBottom(messagesEl);
  }, [isOpen, activeSession?.id, anchorToBottom, messagesLoading, roomThreadActive, roomsState.activeRoom?.id, roomsState.messagesLoading]);

  useEffect(() => {
    if (!isMobile || !isOpen || !activeSession) {
      return;
    }

    const reAnchorToLatest = () => {
      const messagesEl = messagesRef.current;
      if (!messagesEl) {
        return;
      }
      anchorToBottom(messagesEl);
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
  }, [isMobile, isOpen, activeSession, anchorToBottom]);

  // Auto-scroll messages when user is near the live tail.
  useEffect(() => {
    if (!isOpen) return;
    if (!isUserScrollingRef.current) {
      scrollToBottom();
    }
  }, [displayedMessages, streamingText, streamingThinking, isStreaming, isOpen, roomThreadActive, scrollToBottom]);

  useEffect(() => {
    if (!activeSession?.id) {
      return;
    }

    markRead("direct", activeSession.id, activeSession.lastMessageAt ?? activeSession.updatedAt);
  }, [activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, markRead]);

  useEffect(() => {
    if (!roomsState.activeRoom?.id) {
      return;
    }

    markRead("room", roomsState.activeRoom.id, roomsState.activeRoom.updatedAt);
  }, [markRead, roomsState.activeRoom?.id, roomsState.activeRoom?.updatedAt]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (roomsState.activeRoom?.id) {
      markRead("room", roomsState.activeRoom.id, roomsState.activeRoom.updatedAt);
      return;
    }

    if (activeSession?.id) {
      markRead("direct", activeSession.id, activeSession.lastMessageAt ?? activeSession.updatedAt);
    }
  }, [activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, isOpen, markRead, roomsState.activeRoom?.id, roomsState.activeRoom?.updatedAt]);

  useEffect(() => {
    if (isStreaming) {
      return;
    }

    if (roomsState.activeRoom?.id && roomsState.messages.length > 0) {
      const latestRoomMessage = roomsState.messages[roomsState.messages.length - 1];
      markRead("room", roomsState.activeRoom.id, latestRoomMessage?.createdAt ?? roomsState.activeRoom.updatedAt);
      return;
    }

    if (activeSession?.id && messages.length > 0) {
      const latestMessage = messages[messages.length - 1];
      markRead("direct", activeSession.id, latestMessage?.createdAt ?? activeSession.lastMessageAt ?? activeSession.updatedAt);
    }
  }, [activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, isStreaming, markRead, messages, roomsState.activeRoom?.id, roomsState.activeRoom?.updatedAt, roomsState.messages]);

  const sessionOptions = useMemo(() => {
    const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name?.trim() || agent.id]));
    const modelNameByKey = new Map(
      models.map((model) => [`${model.provider}/${model.id}`, model.name?.trim() || ""]),
    );

    return sessions.map((session, index) => {
      const baseLabel = session.title?.trim() || `Session ${index + 1}`;

      let descriptor: string | null = null;
      if (session.agentId && session.agentId !== FN_AGENT_ID) {
        descriptor = agentNameById.get(session.agentId) || session.agentId;
      } else if (session.modelProvider && session.modelId) {
        const modelKey = `${session.modelProvider}/${session.modelId}`;
        const modelName = modelNameByKey.get(modelKey);
        descriptor = modelName ? `${modelName} [${modelKey}]` : modelKey;
      }

      return {
        id: session.id,
        label: descriptor ? `${baseLabel} — ${descriptor}` : baseLabel,
      };
    });
  }, [agents, models, sessions]);

  const roomOptions = useMemo(
    () => (chatRoomsEnabled ? roomsState.rooms : []),
    [chatRoomsEnabled, roomsState.rooms],
  );

  const showRoomGroups = chatRoomsEnabled && roomOptions.length > 0;

  const activeSessionLabel = useMemo(() => {
    if (showRoomGroups && roomThreadActive && roomsState.activeRoom) {
      return `#${roomsState.activeRoom.name}`;
    }
    const activeOption = sessionOptions.find((option) => option.id === activeSession?.id);
    if (activeOption) {
      return activeOption.label;
    }
    if (sessionsLoading) {
      return t("chat.loadingSessions", "Loading sessions…");
    }
    return t("chat.selectSession", "Select a session");
  }, [activeSession?.id, roomThreadActive, roomsState.activeRoom, sessionOptions, sessionsLoading, showRoomGroups]);

  useEffect(() => {
    if (!isOpen) {
      setSessionMenuOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) {
      return;
    }

    const handleSessionMenuOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sessionMenuRef.current?.contains(target)) {
        return;
      }
      setSessionMenuOpen(false);
    };

    const handleSessionMenuEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSessionMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleSessionMenuOutsideClick);
    document.addEventListener("keydown", handleSessionMenuEscape);
    return () => {
      document.removeEventListener("mousedown", handleSessionMenuOutsideClick);
      document.removeEventListener("keydown", handleSessionMenuEscape);
    };
  }, [sessionMenuOpen]);

  const inputPlaceholder = useMemo(() => {
    if (roomThreadActive && roomsState.activeRoom) {
      return t("chat.messageRoomPlaceholder", "Message #{{name}}", { name: roomsState.activeRoom.name });
    }
    if (chatMode === "agent") {
      if (selectedAgent) {
        return t("chat.messageAgentPlaceholder", "Message {{name}}", { name: selectedAgent.name || selectedAgent.id });
      }
      return t("chat.selectAgentPlaceholder", "Select an agent to start chatting");
    }
    // model mode
    if (selectedModelTag) {
      return t("chat.messageModelPlaceholder", "Message {{name}}", { name: selectedModelTag });
    }
    return t("chat.selectModelPlaceholder", "Select a model to start chatting");
  }, [chatMode, roomThreadActive, roomsState.activeRoom, selectedAgent, selectedModelTag, t]);

  const handleSessionSwitch = useCallback((sessionId: string) => {
    const selectedSession = sessions.find((session) => session.id === sessionId);
    if (!selectedSession) {
      return;
    }

    if (roomThreadActive) {
      roomsState.selectRoom(null);
    }

    markRead("direct", selectedSession.id, selectedSession.lastMessageAt ?? selectedSession.updatedAt);
    hasAppliedInitialSessionRef.current = true;

    if (selectedSession.modelProvider && selectedSession.modelId) {
      const targetKey = `${FN_AGENT_ID}::${selectedSession.modelProvider}/${selectedSession.modelId}`;
      restoredFromExistingSessionRef.current = true;
      prevSessionTargetRef.current = targetKey;
      setChatMode("model");
      setSelectedModel(`${selectedSession.modelProvider}/${selectedSession.modelId}`);
    } else {
      const targetKey = `${selectedSession.agentId}::`;
      restoredFromExistingSessionRef.current = true;
      prevSessionTargetRef.current = targetKey;
      setChatMode("agent");
      setSelectedAgentId(selectedSession.agentId);
    }

    void selectSession(selectedSession);
    setSessionMenuOpen(false);
  }, [markRead, roomThreadActive, roomsState, selectSession, sessions]);

  const openRenameDialog = useCallback(
    (sessionId: string) => {
      const selectedSession = sessions.find((session) => session.id === sessionId) ?? (activeSession?.id === sessionId ? activeSession : null);
      setRenameTitle(selectedSession?.title ?? "");
      setRenameDialog({ sessionId, title: selectedSession?.title ?? "" });
      setSessionMenuOpen(false);
    },
    [activeSession, sessions],
  );

  /**
   * FNXC:Chat 2026-06-16-22:24:
   * Quick chat session rows need an inline rename affordance that preserves unread-dot layout and updates the active panel title through the hook's optimistic session-title state.
   */
  const handleRenameSession = useCallback(async () => {
    if (!renameDialog) return;
    try {
      await renameSession(renameDialog.sessionId, renameTitle);
      setRenameDialog(null);
      setRenameTitle("");
      addToast(t("chat.conversationRenamed", "Conversation renamed"), "success");
    } catch {
      // The hook rolls back and reports the failure so regular and quick chat share error behavior.
    }
  }, [addToast, renameDialog, renameSession, renameTitle, t]);

  const handleRoomSwitch = useCallback((roomId: string) => {
    const selectedRoom = roomsState.rooms.find((room) => room.id === roomId);
    markRead("room", roomId, selectedRoom?.updatedAt);
    roomsState.selectRoom(roomId);
    hasAppliedInitialSessionRef.current = true;
    setSessionMenuOpen(false);
  }, [markRead, roomsState]);

  const handleCreateFreshSession = useCallback(async () => {
    if (sessionsLoading) return;

    hasAppliedInitialSessionRef.current = true;

    if (newSessionMode === "agent") {
      if (!newSessionAgentId) return;
      setChatMode("agent");
      setSelectedAgentId(newSessionAgentId);
      await startFreshSession(newSessionAgentId);
    } else {
      const parsed = parseModelSelection(newSessionModel || selectedModel || configuredDefaultModelSelection);
      if (!parsed) return;
      setChatMode("model");
      setSelectedModel(`${parsed.modelProvider}/${parsed.modelId}`);
      await startFreshSession(FN_AGENT_ID, parsed.modelProvider, parsed.modelId);
    }

    await refreshSessions();
    setNewSessionChooserOpen(false);
    setNewSessionMode("model");
  }, [
    configuredDefaultModelSelection,
    newSessionAgentId,
    newSessionMode,
    newSessionModel,
    refreshSessions,
    selectedModel,
    sessionsLoading,
    startFreshSession,
  ]);

  const pendingPreview = pendingMessage.length > 50
    ? `${pendingMessage.slice(0, 50)}…`
    : pendingMessage;

  /**
   * Capture file selections from picker, paste, or drop and stage them in composer state.
   */
  const handleAttachmentFiles = useCallback((files: FileList | null | undefined) => {
    if (!files || files.length === 0) {
      return;
    }

    const newAttachments: PendingAttachment[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!isAllowedAttachment(file)) {
        continue;
      }

      newAttachments.push({
        file,
        previewUrl: isImageAttachment(file) ? URL.createObjectURL(file) : "",
      });
    }

    if (newAttachments.length > 0) {
      setPendingAttachments((previous) => [...previous, ...newAttachments]);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setPendingAttachments((previous) => {
      const removed = previous[index];
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return previous.filter((_, attachmentIndex) => attachmentIndex !== index);
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    handleAttachmentFiles(event.clipboardData?.files);
  }, [handleAttachmentFiles]);

  const focusComposerInput = useCallback(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
    const input = inputRef.current;
    if (!input || input.disabled) return;
    input.focus({ preventScroll: true });
  }, []);

  const markPreserveComposerFocus = useCallback(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
    preserveComposerFocusRef.current = true;
  }, []);

  // Latch that a mobile pointer/touch handler already performed a button's
  // action, so the synthetic onClick that trails the gesture is ignored
  // (prevents a double send/stop). On iOS, preventDefault() in
  // touchstart/pointerdown frequently suppresses that click entirely, so we
  // also clear the latch on a timer: without it the ref stays stuck `true` and
  // swallows the *next* real click (e.g. after switching chats), making the
  // button look dead. The latch is shared by the send and stop buttons, so a
  // stuck value cross-contaminates between them.
  const markHandledMobileAction = useCallback(() => {
    handledMobileActionRef.current = true;
    if (handledMobileActionTimerRef.current != null) {
      clearTimeout(handledMobileActionTimerRef.current);
    }
    handledMobileActionTimerRef.current = setTimeout(() => {
      handledMobileActionRef.current = false;
      handledMobileActionTimerRef.current = null;
    }, 700);
  }, []);

  // Claim a touch gesture for a single action. A real touch tap dispatches both
  // pointerdown and touchstart, and each handler runs before React flushes the
  // composer-clear, so both would otherwise fire the action (double send, or a
  // second send that aborts the first's freshly-opened stream). The first event
  // of the tap claims; the second bails. The claim auto-clears after the current
  // input task so a later tap — or a different button (e.g. stop right after
  // send) — starts fresh, unlike the 700ms onClick latch above.
  const beginTouchActionGesture = useCallback(() => {
    if (touchActionGestureRef.current) return false;
    touchActionGestureRef.current = true;
    setTimeout(() => {
      touchActionGestureRef.current = false;
    }, 0);
    return true;
  }, []);

  // If a mobile handler already ran this gesture's action, consume the latch
  // (and cancel its timer) so the trailing onClick bails without double-firing.
  const consumeHandledMobileAction = useCallback(() => {
    if (!handledMobileActionRef.current) return false;
    handledMobileActionRef.current = false;
    if (handledMobileActionTimerRef.current != null) {
      clearTimeout(handledMobileActionTimerRef.current);
      handledMobileActionTimerRef.current = null;
    }
    return true;
  }, []);

  useEffect(() => () => {
    if (handledMobileActionTimerRef.current != null) {
      clearTimeout(handledMobileActionTimerRef.current);
    }
  }, []);

  const handleSendMessage = useCallback(async () => {
    const trimmed = messageInput.trim();
    const attachmentsToSend = pendingAttachmentsRef.current;
    if (!trimmed && attachmentsToSend.length === 0) return;
    if (inputDisabled) return;

    setMessageInput("");
    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);

    if (trimmed === "/help") {
      setHelpMessageVisible(true);
      focusComposerInput();
      preserveComposerFocusRef.current = false;
      return;
    }

    if (trimmed === "/clear" || trimmed === "/new") {
      attachmentsToSend.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      setPendingAttachments((previous) => previous.filter((attachment) => !attachmentsToSend.includes(attachment)));

      try {
        if (roomThreadActive && roomsState.activeRoom?.id) {
          await roomsState.clearRoom(roomsState.activeRoom.id);
          setHelpMessageVisible(false);
        } else if (chatMode === "model") {
          clearPendingMessage();
          stopStreaming();
          const parsed = parseModelSelection(resolvedModelSelection);
          if (!parsed) {
            return;
          }
          await startFreshSession(FN_AGENT_ID, parsed.modelProvider, parsed.modelId);
        } else if (selectedAgentId) {
          clearPendingMessage();
          stopStreaming();
          await startFreshSession(selectedAgentId);
        }
      } catch {
        addToast(t("chat.clearConversationFailed", "Failed to clear conversation"), "error");
      } finally {
        focusComposerInput();
        preserveComposerFocusRef.current = false;
      }
      return;
    }

    try {
      setHelpMessageVisible(false);
      if (chatRoomsEnabled && roomsState.activeRoom) {
        await roomsState.sendRoomMessage(trimmed, { files: attachmentsToSend.map((attachment) => attachment.file) });
      } else {
        await sendMessage(trimmed, attachmentsToSend.map((attachment) => attachment.file));
      }
      attachmentsToSend.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      setPendingAttachments((previous) => previous.filter((attachment) => !attachmentsToSend.includes(attachment)));
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : (chatRoomsEnabled && roomsState.activeRoom ? t("chat.sendRoomMessageFailed", "Failed to send room message") : t("chat.sendMessageFailed", "Failed to send message"));
      addToast(message, "error");
      // Keep pending attachments on failure so user can retry.
    } finally {
      focusComposerInput();
      preserveComposerFocusRef.current = false;
    }
  }, [
    addToast,
    chatMode,
    chatRoomsEnabled,
    clearPendingMessage,
    focusComposerInput,
    inputDisabled,
    messageInput,
    resolvedModelSelection,
    roomThreadActive,
    roomsState,
    selectedAgentId,
    sendMessage,
    startFreshSession,
    stopStreaming,
  ]);

  const handleQuestionSubmit = useCallback(async (answerText: string) => {
    try {
      setHelpMessageVisible(false);
      if (chatRoomsEnabled && roomsState.activeRoom) {
        await roomsState.sendRoomMessage(answerText);
      } else {
        await sendMessage(answerText);
      }
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : (chatRoomsEnabled && roomsState.activeRoom ? t("chat.sendRoomMessageFailed", "Failed to send room message") : t("chat.sendMessageFailed", "Failed to send message"));
      addToast(message, "error");
    } finally {
      focusComposerInput();
      preserveComposerFocusRef.current = false;
    }
  }, [addToast, chatRoomsEnabled, focusComposerInput, roomsState, sendMessage, t]);

  const handleAttachmentDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsAttachmentDragOver(true);
  }, []);

  const handleAttachmentDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsAttachmentDragOver(true);
  }, []);

  const handleAttachmentDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsAttachmentDragOver(false);
    }
  }, []);

  const handleAttachmentDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsAttachmentDragOver(false);
    handleAttachmentFiles(event.dataTransfer?.files);
  }, [handleAttachmentFiles]);

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

  const resizeQuickChatComposer = useCallback((composer: HTMLTextAreaElement | null = inputRef.current) => {
    if (!composer) {
      return;
    }

    composer.style.height = "auto";
    composer.style.height = `${clampQuickChatInputHeight(composer.scrollHeight)}px`;
  }, []);

  const handleSkillSelect = useCallback((skill: DiscoveredSkill) => {
    setMessageInput((currentInput) => {
      const triggerMatch = getSkillTriggerMatch(currentInput);
      if (!triggerMatch) {
        return currentInput;
      }

      const replacement = `/skill:${skill.name} `;
      const nextInput = currentInput.slice(0, triggerMatch.start) + replacement + currentInput.slice(triggerMatch.end);

      window.requestAnimationFrame(() => {
        if (!inputRef.current) return;
        resizeQuickChatComposer(inputRef.current);
        inputRef.current.focus();
      });

      return nextInput;
    });

    setShowSkillMenu(false);
    setSkillFilter("");
    setHighlightedSkillIndex(0);
  }, [resizeQuickChatComposer]);

  const handleMentionSelect = useCallback(
    (agent: Agent) => {
      const input = inputRef.current;
      if (!input || mentionStartPos < 0) {
        return;
      }

      const selectionStart = input.selectionStart ?? mentionCursorPosRef.current;
      const selectionEnd = input.selectionEnd ?? selectionStart;
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
        resizeQuickChatComposer(inputRef.current);
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [mentionStartPos, messageInput, resizeQuickChatComposer],
  );

  const insertHashMention = useCallback(
    (nextInput: string, insertedToken: string) => {
      const input = inputRef.current;
      const cursorPos = input?.selectionStart ?? mentionCursorPosRef.current;
      const mentionStart = messageInput.lastIndexOf("#", cursorPos);
      const nextCursorPos = mentionStart >= 0
        ? mentionStart + insertedToken.length
        : nextInput.length;

      setMessageInput(nextInput);
      fileMention.dismissMention();
      setFileMentionPopupVisible(false);

      window.requestAnimationFrame(() => {
        if (!inputRef.current) return;
        resizeQuickChatComposer(inputRef.current);
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [fileMention, messageInput, resizeQuickChatComposer],
  );

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      const cursorPos = event.target.selectionStart ?? nextValue.length;
      resizeQuickChatComposer(event.target);
      mentionCursorPosRef.current = cursorPos;
      setMessageInput(nextValue);
      if (helpMessageVisible && nextValue.trim().length > 0) {
        setHelpMessageVisible(false);
      }
      updateMentionState(nextValue, cursorPos);

      const skillTriggerMatch = getSkillTriggerMatch(nextValue);
      if (skillTriggerMatch) {
        setShowSkillMenu(true);
        setSkillFilter(skillTriggerMatch.filter);
      } else {
        setShowSkillMenu(false);
        setSkillFilter("");
      }

      // Detect file mentions
      fileMention.detectMention(nextValue, cursorPos);
      setFileMentionPopupVisible(fileMention.mentionActive);
      if (fileMention.mentionActive) {
        updateFileMentionPosition(event.target);
      }
    },
    [fileMention, helpMessageVisible, resizeQuickChatComposer, updateFileMentionPosition, updateMentionState],
  );

  useLayoutEffect(() => {
    resizeQuickChatComposer();
  }, [messageInput, resizeQuickChatComposer]);

  const handleInputBlur = useCallback(() => {
    if (preserveComposerFocusRef.current) {
      window.requestAnimationFrame(() => {
        focusComposerInput();
      });
      return;
    }

    // Pre-grow the panel ahead of iOS's keyboard dismiss animation so the
    // user sees the panel snap to full height immediately instead of
    // following the keyboard slide-down. The suppress flag prevents the
    // visualViewport listener from clobbering this with mid-dismiss
    // reports while iOS is still animating the keyboard out.
    if (
      typeof window !== "undefined"
      && window.innerWidth <= QUICK_CHAT_DESKTOP_BREAKPOINT
      && panelRef.current
    ) {
      suppressVvShrinkRef.current = true;
      panelRef.current.style.removeProperty("--vv-height");
      panelRef.current.style.removeProperty("--vv-offset-top");
      window.setTimeout(() => {
        suppressVvShrinkRef.current = false;
      }, 450);
    }

    if (hideMentionPopupTimeoutRef.current !== null) {
      window.clearTimeout(hideMentionPopupTimeoutRef.current);
    }

    hideMentionPopupTimeoutRef.current = window.setTimeout(() => {
      setMentionPopupVisible(false);
      setMentionFilter("");
      setMentionStartPos(-1);
      setFileMentionPopupVisible(false);
      fileMention.dismissMention();
      hideMentionPopupTimeoutRef.current = null;
    }, 120);

    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
    }

    hideSkillMenuTimeoutRef.current = window.setTimeout(() => {
      setShowSkillMenu(false);
      hideSkillMenuTimeoutRef.current = null;
    }, 120);
  }, [fileMention, focusComposerInput]);

  const handleInputFocus = useCallback(() => {
    // Re-enable visualViewport tracking — the suppress flag set on blur
    // would otherwise still be in effect if the user re-focused inside
    // the suppress window.
    suppressVvShrinkRef.current = false;
    if (hideMentionPopupTimeoutRef.current !== null) {
      window.clearTimeout(hideMentionPopupTimeoutRef.current);
      hideMentionPopupTimeoutRef.current = null;
    }
    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
      hideSkillMenuTimeoutRef.current = null;
    }
  }, []);

  const handleInputSelectionChange = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const input = event.currentTarget;
      const cursorPos = input.selectionStart ?? input.value.length;
      mentionCursorPosRef.current = cursorPos;
      updateMentionState(input.value, cursorPos);

      // Detect file mentions
      fileMention.detectMention(input.value, cursorPos);
      setFileMentionPopupVisible(fileMention.mentionActive);
      if (fileMention.mentionActive) {
        updateFileMentionPosition(input);
      }
    },
    [updateMentionState, fileMention, updateFileMentionPosition],
  );

  const handleInputKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        return;
      }
      handleInputSelectionChange(event);
    },
    [handleInputSelectionChange],
  );

  const toggleMessageRenderMode = useCallback((messageId: string) => {
    setPlainTextMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const renderAssistantMessageContent = useCallback(
    (content: string, forcePlain = false) => {
      if (forcePlain) {
        return <div className="quick-chat-message-content quick-chat-message-content--plain">{linkifyFilePaths(content)}</div>;
      }

      return (
        <div className="quick-chat-message-content quick-chat-message-content--markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={quickChatMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      );
    },
    [],
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      mentionCursorPosRef.current = event.currentTarget.selectionStart ?? mentionCursorPosRef.current;

      // Handle file mention popup keyboard navigation first
      if (fileMention.mentionActive && fileMention.combinedItems.length > 0) {
        fileMention.handleKeyDown(event, messageInput);
        if (event.key === "Enter" || event.key === "Tab") {
          const item = fileMention.combinedItems[fileMention.selectedIndex];
          if (item?.kind === "task") {
            insertHashMention(fileMention.selectTask(item.task, messageInput), `#${item.task.id}`);
          } else if (item?.kind === "file") {
            insertHashMention(fileMention.selectFile(item.file, messageInput), `#${item.file.path}`);
          }
        }
        return;
      }

      if (mentionPopupVisible && event.key === "ArrowDown") {
        event.preventDefault();
        if (filteredMentionAgents.length > 0) {
          setMentionHighlightIndex((prev) => (prev + 1) % filteredMentionAgents.length);
        }
        return;
      }

      if (mentionPopupVisible && event.key === "ArrowUp") {
        event.preventDefault();
        if (filteredMentionAgents.length > 0) {
          setMentionHighlightIndex((prev) =>
            prev === 0 ? filteredMentionAgents.length - 1 : prev - 1,
          );
        }
        return;
      }

      if (mentionPopupVisible && event.key === "Enter") {
        event.preventDefault();
        const agentToSelect = filteredMentionAgents[mentionHighlightIndex] ?? filteredMentionAgents[0];
        if (agentToSelect) {
          handleMentionSelect(agentToSelect);
        }
        return;
      }

      if (mentionPopupVisible && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMentionPopupVisible(false);
        setMentionFilter("");
        setMentionStartPos(-1);
        return;
      }

      if (showSkillMenu && filteredSkills.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedSkillIndex((prev) => (prev + 1) % filteredSkills.length);
        return;
      }

      if (showSkillMenu && filteredSkills.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedSkillIndex((prev) => (prev === 0 ? filteredSkills.length - 1 : prev - 1));
        return;
      }

      if (showSkillMenu && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        const selectedSkill = filteredSkills[highlightedSkillIndex] ?? filteredSkills[0];
        if (selectedSkill) {
          handleSkillSelect(selectedSkill);
        }
        return;
      }

      if (showSkillMenu && event.key === "Escape") {
        event.preventDefault();
        setShowSkillMenu(false);
        setSkillFilter("");
        return;
      }

      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void handleSendMessage();
    },
    [
      mentionPopupVisible,
      filteredMentionAgents,
      mentionHighlightIndex,
      handleMentionSelect,
      handleSendMessage,
      fileMention,
      insertHashMention,
      messageInput,
      showSkillMenu,
      filteredSkills,
      highlightedSkillIndex,
      handleSkillSelect,
    ],
  );

  // Core open/close toggle. Only toggles if this was a tap (not a drag);
  // resets didDragRef after checking to prevent a double-toggle.
  const toggleQuickChat = useCallback(() => {
    if (didDragRef.current) {
      // Was a drag, don't toggle
      didDragRef.current = false;
      return;
    }
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    // iOS only opens the soft keyboard from a focus() that runs while
    // the originating user-gesture is still active, AND the focused
    // element must not be `disabled`. The real composer input renders
    // disabled until the chat session is created, so we focus an
    // always-mounted stealth input here to claim the keyboard now; the
    // auto-focus effect below transfers focus to the real input once
    // it is enabled, which keeps the keyboard up.
    if (typeof window !== "undefined" && window.innerWidth <= QUICK_CHAT_DESKTOP_BREAKPOINT) {
      stealthInputRef.current?.focus({ preventScroll: true });
    }
    setIsOpen(true);
  }, [isOpen, setIsOpen]);

  // Fired from the drag hook's pointerup when the gesture was a tap, not a
  // drag. This is the reliable open path on iOS: setPointerCapture() in
  // pointerdown makes iOS Safari swallow the synthetic click, so onClick
  // alone never opens the panel on iPhone. pointerup is itself a user
  // gesture, so the stealth-input focus inside toggleQuickChat still
  // raises the keyboard.
  const handleFABTap = useCallback(() => {
    suppressNextFabClickRef.current = true;
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        suppressNextFabClickRef.current = false;
      }, 500);
    }
    toggleQuickChat();
  }, [toggleQuickChat]);
  fabTapHandlerRef.current = handleFABTap;

  // Synthetic click path — still used for mouse (where pointerup also
  // fires handleFABTap, so we de-dupe) and for click-only callers like
  // tests (no preceding pointerup tap, so we handle it).
  const handleFABClick = useCallback(() => {
    if (suppressNextFabClickRef.current) {
      suppressNextFabClickRef.current = false;
      return;
    }
    toggleQuickChat();
  }, [toggleQuickChat]);

  return (
    <>
      <input
        ref={stealthInputRef}
        type="text"
        className="quick-chat-stealth-input"
        aria-hidden="true"
        tabIndex={-1}
      />
      {showFAB && (
        <button
          ref={fabRef}
          type="button"
          className="quick-chat-fab"
          aria-label={t("chat.openQuickChat", "Open quick chat")}
          data-testid="quick-chat-fab"
          data-dragging={isDragging ? "true" : "false"}
          style={{ right: position.x, bottom: position.y }}
          onPointerDown={handlePointerDown}
          onClick={handleFABClick}
        >
          <MessageSquare size={24} />
        </button>
      )}

      {isOpen && (
        <div
          className={`quick-chat-panel${isMobile && keyboardOpen ? " quick-chat-panel--keyboard-open" : ""}`}
          ref={panelRef}
          data-testid="quick-chat-panel"
          style={{
            ...(shouldApplyDesktopPanelSize
              ? {
                  right: position.x + anchorOffset.right,
                  bottom: panelY + anchorOffset.bottom,
                  width: panelSize.width,
                  height: panelSize.height,
                }
              : {}),
          }}
        >
          {shouldApplyDesktopPanelSize && (
            <>
              {/* Edge handles */}
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="n"
                data-testid="quick-chat-resize-n"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("chat.resizePanelTop", "Resize panel from top")}
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="s"
                data-testid="quick-chat-resize-s"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("chat.resizePanelBottom", "Resize panel from bottom")}
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="e"
                data-testid="quick-chat-resize-e"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("chat.resizePanelRight", "Resize panel from right")}
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="w"
                data-testid="quick-chat-resize-w"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("chat.resizePanelLeft", "Resize panel from left")}
              />
              {/* Corner handles */}
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="nw"
                data-testid="quick-chat-resize-nw"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label={t("chat.resizePanelTopLeft", "Resize panel from top-left corner")}
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="ne"
                data-testid="quick-chat-resize-ne"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label={t("chat.resizePanelTopRight", "Resize panel from top-right corner")}
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="sw"
                data-testid="quick-chat-resize-sw"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label={t("chat.resizePanelBottomLeft", "Resize panel from bottom-left corner")}
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="se"
                data-testid="quick-chat-resize-se"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label={t("chat.resizePanelBottomRight", "Resize panel from bottom-right corner")}
              />
            </>
          )}

          <div className="quick-chat-panel-header">
            <div className="quick-chat-panel-title-wrap">
              <h3>{t("chat.quickChatTitle", "Quick Chat")}</h3>
              {!roomThreadActive && activeSession ? (
                <span className="quick-chat-session-title-tag" data-testid="quick-chat-active-session-title" title={activeSessionLabel}>
                  {activeSessionLabel}
                </span>
              ) : null}
              {roomThreadActive && roomsState.activeRoom ? (
                <span className="quick-chat-model-tag" data-testid="quick-chat-room-tag" title={`#${roomsState.activeRoom.name}`}>
                  #{roomsState.activeRoom.name}
                </span>
              ) : (
                chatMode === "model" && selectedModelTag && (() => {
                  const provider =
                    selectedModelInfo?.provider ?? parsedModelSelection?.modelProvider ?? "";
                  // On mobile the header pill is squeezed by mode toggle + new-chat
                  // + close buttons, so swap a long model name for the provider
                  // icon to keep the title row tidy.
                  const tagTooLong = viewportMode === "mobile" && selectedModelTag.length > 12;
                  if (tagTooLong && provider) {
                    return (
                      <span
                        className="quick-chat-model-tag quick-chat-model-tag--icon"
                        data-testid="quick-chat-model-tag"
                        title={selectedModelTag}
                        aria-label={selectedModelTag}
                      >
                        <ProviderIcon provider={provider} size="sm" />
                      </span>
                    );
                  }
                  return (
                    <span className="quick-chat-model-tag" data-testid="quick-chat-model-tag" title={selectedModelTag}>
                      {selectedModelTag}
                    </span>
                  );
                })()
              )}
            </div>
            <div className="quick-chat-panel-header-actions">
              <button
                type="button"
                className="btn-icon quick-chat-new-chat-btn"
                data-testid="quick-chat-new-thread"
                aria-label={t("chat.startNewChat", "Start a new chat")}
                onClick={handleStartFreshChat}
                disabled={sessionsLoading}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                className="btn-icon"
                aria-label={t("chat.closeQuickChat", "Close quick chat")}
                data-testid="quick-chat-close"
                onClick={() => setIsOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="quick-chat-panel-agent-select" data-testid="quick-chat-session-select">
            <div className="quick-chat-session-menu" ref={sessionMenuRef}>
              <label htmlFor="quick-chat-session-dropdown-trigger" className="visually-hidden">{t("chat.selectSessionLabel", "Select session")}</label>
              <input
                type="hidden"
                data-testid="quick-chat-session-dropdown"
                value={showRoomGroups && roomThreadActive ? "" : activeSession?.id ?? ""}
                readOnly
              />
              <button
                id="quick-chat-session-dropdown-trigger"
                type="button"
                className="btn quick-chat-session-trigger"
                aria-haspopup="menu"
                aria-expanded={sessionMenuOpen}
                data-testid="quick-chat-session-dropdown-trigger"
                onClick={() => setSessionMenuOpen((current) => !current)}
              >
                {roomThreadActive && roomsState.activeRoom ? (
                  <Hash size={16} aria-hidden="true" />
                ) : activeSession?.modelProvider ? (
                  <ProviderIcon provider={activeSession.modelProvider} size="sm" />
                ) : (
                  <MessageSquare size={16} aria-hidden="true" />
                )}
                <span>{activeSessionLabel}</span>
                <ChevronDown size={16} aria-hidden="true" />
              </button>

              {sessionMenuOpen && (
                <div className="quick-chat-session-dropdown" role="menu" data-testid="quick-chat-session-dropdown-menu">
                  {showRoomGroups && (
                    <>
                      <div className="quick-chat-session-dropdown-group-label">{t("chat.roomsGroupLabel", "Rooms")}</div>
                      {roomOptions.map((room) => {
                        const isActiveRoom = roomsState.activeRoom?.id === room.id;
                        const showUnreadDot = !isActiveRoom && isUnread("room", room.id, room.updatedAt);
                        return (
                        <button
                          key={room.id}
                          type="button"
                          role="menuitem"
                          data-testid={`quick-chat-session-option-room-${room.slug}`}
                          className={`quick-chat-session-option${isActiveRoom ? " quick-chat-session-option--active" : ""}`}
                          onClick={() => handleRoomSwitch(room.id)}
                        >
                          <span>#{room.name}</span>
                          {showUnreadDot ? (
                            <span
                              className="chat-unread-dot quick-chat-session-unread-dot"
                              data-testid={`quick-chat-unread-dot-${room.id}`}
                              aria-label={t("chat.unreadMessages", "Unread messages")}
                            />
                          ) : null}
                        </button>
                        );
                      })}
                      <div className="quick-chat-session-dropdown-group-label">{t("chat.sessionsGroupLabel", "Sessions")}</div>
                    </>
                  )}
                  {sessionOptions.map((sessionOption) => {
                    const isActiveSession = !roomThreadActive && activeSession?.id === sessionOption.id;
                    const session = sessions.find((item) => item.id === sessionOption.id);
                    const showUnreadDot = !isActiveSession && isUnread("direct", sessionOption.id, session?.lastMessageAt ?? session?.updatedAt);
                    return (
                    <div
                      key={sessionOption.id}
                      className={`quick-chat-session-option-row${isActiveSession ? " quick-chat-session-option-row--active" : ""}`}
                      role="none"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-testid={`quick-chat-session-option-${sessionOption.id}`}
                        className={`quick-chat-session-option${isActiveSession ? " quick-chat-session-option--active" : ""}`}
                        onClick={() => handleSessionSwitch(sessionOption.id)}
                      >
                        <span>{sessionOption.label}</span>
                        {showUnreadDot ? (
                          <span
                            className="chat-unread-dot quick-chat-session-unread-dot"
                            data-testid={`quick-chat-unread-dot-${sessionOption.id}`}
                            aria-label={t("chat.unreadMessages", "Unread messages")}
                          />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="btn-icon quick-chat-session-rename"
                        data-testid={`quick-chat-session-rename-${sessionOption.id}`}
                        aria-label={t("chat.renameConversationAria", "Rename conversation {{title}}", { title: sessionOption.label })}
                        onClick={() => openRenameDialog(sessionOption.id)}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {renameDialog && (
            <div className="quick-chat-rename-dialog" data-testid="quick-chat-rename-dialog">
              <label className="quick-chat-rename-label" htmlFor="quick-chat-rename-input">
                {t("chat.renameConversationTitle", "Rename Conversation")}
              </label>
              <input
                id="quick-chat-rename-input"
                className="input quick-chat-rename-input"
                type="text"
                value={renameTitle}
                placeholder={t("chat.renamePlaceholder", "Untitled")}
                data-testid="quick-chat-rename-input"
                onChange={(event) => setRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleRenameSession();
                  }
                }}
                autoFocus
              />
              <div className="quick-chat-rename-actions">
                <button type="button" className="btn" onClick={() => setRenameDialog(null)}>
                  {t("chat.cancelButton", "Cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="quick-chat-rename-save"
                  onClick={() => void handleRenameSession()}
                >
                  {t("chat.save", "Save")}
                </button>
              </div>
            </div>
          )}

          {newSessionChooserOpen && (
            <div className="quick-chat-new-session-chooser" data-testid="quick-chat-new-session-chooser">
              <div className="quick-chat-inline-mode-toggle" data-testid="quick-chat-inline-mode-toggle">
                <button
                  type="button"
                  className={`quick-chat-mode-btn${newSessionMode === "model" ? " quick-chat-mode-btn--active" : ""}`}
                  data-testid="quick-chat-inline-mode-model"
                  onClick={() => setNewSessionMode("model")}
                >
                  {t("chat.modeModel", "Model")}
                </button>
                <button
                  type="button"
                  className={`quick-chat-mode-btn${newSessionMode === "agent" ? " quick-chat-mode-btn--active" : ""}`}
                  data-testid="quick-chat-inline-mode-agent"
                  onClick={() => setNewSessionMode("agent")}
                >
                  {t("chat.modeAgent", "Agent")}
                </button>
              </div>

              {newSessionMode === "agent" ? (
                <div className="quick-chat-panel-agent-select">
                  <label htmlFor="quick-chat-new-agent-select" className="visually-hidden">{t("chat.selectAgentForNewChat", "Select agent for new chat")}</label>
                  <select
                    id="quick-chat-new-agent-select"
                    value={newSessionAgentId}
                    onChange={(event) => setNewSessionAgentId(event.target.value)}
                    data-testid="quick-chat-new-agent-select"
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{getAgentLabel(agent)}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="quick-chat-panel-agent-select" data-testid="quick-chat-new-model-select">
                  <CustomModelDropdown
                    id="quick-chat-new-model-select"
                    models={models}
                    value={newSessionModel}
                    onChange={setNewSessionModel}
                    label={t("chat.selectModelOverrideLabel", "Select model override")}
                    placeholder={modelsLoading ? t("chat.loadingModels", "Loading models…") : t("chat.selectModelPlaceholder2", "Select a model")}
                    disabled={modelsLoading || models.length === 0}
                    favoriteProviders={favoriteProviders}
                    favoriteModels={favoriteModels}
                    onToggleFavorite={onToggleFavorite}
                    onToggleModelFavorite={onToggleModelFavorite}
                  />
                </div>
              )}

              <div className="quick-chat-new-session-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="quick-chat-new-session-cancel"
                  onClick={() => {
                    setNewSessionChooserOpen(false);
                    setNewSessionMode("model");
                  }}
                >
                  {t("chat.cancelButton", "Cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="quick-chat-new-session-submit"
                  onClick={() => void handleCreateFreshSession()}
                  disabled={sessionsLoading || (newSessionMode === "agent" ? !newSessionAgentId : !parseModelSelection(newSessionModel || selectedModel || configuredDefaultModelSelection))}
                >
                  {t("chat.createButton", "Create")}
                </button>
              </div>
            </div>
          )}

          <div className="quick-chat-panel-messages" ref={messagesRef} data-testid="quick-chat-messages" onScroll={updateScrollState}>
            {sessionsLoading ? (
              <div className="quick-chat-panel-empty">{t("chat.loadingConversation", "Loading conversation…")}</div>
            ) : !roomThreadActive && isStreaming ? (
              <>
                {displayedMessages.map((message: ChatMessageInfo, index) => (
                  <QuickChatMessageItem
                    key={message.id}
                    message={message}
                    forcePlain={message.role !== "user" && plainTextMessageIds.has(message.id)}
                    mentionAgentsByName={mentionAgentsByName}
                    roomContext={roomContext}
                    projectId={projectId}
                    onToggleRender={toggleMessageRenderMode}
                    isAwaitingQuestionAnswer={message.role === "assistant" && index === displayedMessages.length - 1 && !isStreaming}
                    submittedQuestionAnswer={findSubmittedQuestionAnswer(displayedMessages, index)}
                    onQuestionSubmit={handleQuestionSubmit}
                  />
                ))}
                {helpMessageVisible && (
                  <div className="quick-chat-panel-message quick-chat-panel-message--received" data-testid="quick-chat-help-message">
                    {renderAssistantMessageContent(t("chat.helpMessageContent", "Available commands:\n- `/new` or `/clear` — Clear conversation and start fresh\n- `/skill:{name}` — Use a specific skill\n- `/help` — Show this help"))}
                  </div>
                )}
                <div
                  className="quick-chat-panel-message quick-chat-panel-message--received quick-chat-panel-message--streaming"
                  data-testid="quick-chat-streaming-message"
                >
                  {streamingText ? (
                    <>
                      <div data-testid="quick-chat-streaming-text">
                        {renderAssistantMessageContent(streamingText, plainTextMessageIds.has("__streaming__"))}
                      </div>
                      <button
                        type="button"
                        className={`quick-chat-message-render-toggle${plainTextMessageIds.has("__streaming__") ? " quick-chat-message-render-toggle--plain" : ""}`}
                        data-testid="quick-chat-message-render-toggle"
                        aria-label={plainTextMessageIds.has("__streaming__") ? t("chat.showRenderedMarkdown", "Show rendered markdown") : t("chat.showPlainText", "Show plain text")}
                        onClick={() => toggleMessageRenderMode("__streaming__")}
                      >
                        {plainTextMessageIds.has("__streaming__") ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </>
                  ) : (
                    <p className="quick-chat-panel-waiting" data-testid="quick-chat-waiting">
                      {streamingThinking ? t("chat.thinkingStatus", "Thinking…") : t("chat.workingStatus", "Working…")}
                    </p>
                  )}
                  {renderToolCalls(streamingToolCalls, true, t, {
                    isAwaitingAnswer: true,
                    onQuestionSubmit: handleQuestionSubmit,
                  })}
                  {streamingThinking && (
                    <details className="chat-message-thinking" data-testid="quick-chat-streaming-thinking">
                      <summary>{t("chat.thinkingLabel", "Thinking")}</summary>
                      <pre className="chat-message-thinking-content">{linkifyFilePaths(streamingThinking)}</pre>
                    </details>
                  )}
                </div>
              </>
            ) : roomThreadActive ? roomsState.messagesLoading ? (
              <div className="quick-chat-panel-empty">{t("chat.loadingConversation", "Loading conversation…")}</div>
            ) : displayedMessages.length === 0 && !helpMessageVisible ? (
              <div className="quick-chat-panel-empty">{t("chat.noMessagesYet", "No messages yet. Start the conversation!")}</div>
            ) : (
              <>
                {displayedMessages.map((message: ChatMessageInfo, index) => (
                  <QuickChatMessageItem
                    key={message.id}
                    message={message}
                    forcePlain={message.role !== "user" && plainTextMessageIds.has(message.id)}
                    mentionAgentsByName={mentionAgentsByName}
                    roomContext={roomContext}
                    projectId={projectId}
                    onToggleRender={toggleMessageRenderMode}
                    isAwaitingQuestionAnswer={message.role === "assistant" && index === displayedMessages.length - 1 && !isStreaming}
                    submittedQuestionAnswer={findSubmittedQuestionAnswer(displayedMessages, index)}
                    onQuestionSubmit={handleQuestionSubmit}
                  />
                ))}
                {helpMessageVisible && (
                  <div className="quick-chat-panel-message quick-chat-panel-message--received" data-testid="quick-chat-help-message">
                    {renderAssistantMessageContent(t("chat.helpMessageContent", "Available commands:\n- `/new` or `/clear` — Clear conversation and start fresh\n- `/skill:{name}` — Use a specific skill\n- `/help` — Show this help"))}
                  </div>
                )}
              </>
            ) : messagesLoading ? (
              <div className="quick-chat-panel-empty">{t("chat.loadingConversation", "Loading conversation…")}</div>
            ) : displayedMessages.length === 0 && !streamingText && !streamingThinking && !isStreaming && !helpMessageVisible ? (
              <div className="quick-chat-panel-empty">{t("chat.noMessagesYet", "No messages yet. Start the conversation!")}</div>
            ) : (
              <>
                {displayedMessages.map((message: ChatMessageInfo, index) => (
                  <QuickChatMessageItem
                    key={message.id}
                    message={message}
                    forcePlain={message.role !== "user" && plainTextMessageIds.has(message.id)}
                    mentionAgentsByName={mentionAgentsByName}
                    roomContext={roomContext}
                    projectId={projectId}
                    onToggleRender={toggleMessageRenderMode}
                    isAwaitingQuestionAnswer={message.role === "assistant" && index === displayedMessages.length - 1 && !isStreaming}
                    submittedQuestionAnswer={findSubmittedQuestionAnswer(displayedMessages, index)}
                    onQuestionSubmit={handleQuestionSubmit}
                  />
                ))}
                {helpMessageVisible && (
                  <div className="quick-chat-panel-message quick-chat-panel-message--received" data-testid="quick-chat-help-message">
                    {renderAssistantMessageContent(t("chat.helpMessageContent", "Available commands:\n- `/new` or `/clear` — Clear conversation and start fresh\n- `/skill:{name}` — Use a specific skill\n- `/help` — Show this help"))}
                  </div>
                )}
              </>
            )}
          </div>

          {isUserScrolling && (
            <button
              type="button"
              className="btn btn-sm quick-chat-jump-to-latest"
              data-testid="quick-chat-jump-to-latest"
              onClick={scrollToBottom}
            >
              <ChevronDown size={14} />
              {t("chat.jumpToLatest", "Latest")}
            </button>
          )}

          {pendingAttachments.length > 0 && (
            <div className="quick-chat-attachment-previews" data-testid="quick-chat-attachment-previews">
              {pendingAttachments.map((attachment, index) => (
                <div
                  key={`${attachment.file.name}-${index}`}
                  className="quick-chat-attachment-preview"
                  data-testid={`quick-chat-attachment-preview-${index}`}
                >
                  {attachment.previewUrl
                    ? <img src={attachment.previewUrl} alt={attachment.file.name} />
                    : <span className="quick-chat-attachment-preview-name">{attachment.file.name}</span>}
                  <button
                    type="button"
                    className="quick-chat-attachment-remove"
                    data-testid={`quick-chat-attachment-remove-${index}`}
                    aria-label={t("chat.removeAttachment", "Remove {{name}}", { name: attachment.file.name })}
                    onClick={() => removeAttachment(index)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="quick-chat-panel-input">
            <div
              className={`quick-chat-input-wrapper${isAttachmentDragOver ? " quick-chat-input-wrapper--dragover" : ""}`}
              onDragEnter={handleAttachmentDragEnter}
              onDragOver={handleAttachmentDragOver}
              onDragLeave={handleAttachmentDragLeave}
              onDrop={handleAttachmentDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.txt,.json,.yaml,.yml,.log,.csv,.xml,.md"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                className="quick-chat-attachment-input"
                onChange={(event) => {
                  handleAttachmentFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <div className="quick-chat-input-row" data-testid="quick-chat-input-row">
                <button
                  type="button"
                  className="btn-icon quick-chat-attach-btn"
                  data-testid="quick-chat-attach-btn"
                  aria-label={t("chat.attachFiles", "Attach files")}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={16} />
                </button>
                <textarea
                  ref={inputRef}
                  rows={1}
                  className="quick-chat-textarea"
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
                    if (window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                    if (!isIOS()) return;
                    if (document.activeElement === event.currentTarget) return;
                    // FN-6301: do not preventDefault on the first unfocused iOS tap.
                    // Native focus is the reliable path that raises the soft keyboard;
                    // the visualViewport/input-focus effects own scroll compensation.
                  }}
                  placeholder={inputPlaceholder}
                  disabled={inputDisabled}
                  data-testid="quick-chat-input"
                />
                {isStreaming ? (
                  <button
                    type="button"
                    className="chat-input-stop quick-chat-send-btn"
                    onPointerDown={(event) => {
                      if (typeof window === "undefined" || window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                      event.preventDefault();
                      if (event.pointerType && event.pointerType !== "mouse") {
                        if (!beginTouchActionGesture()) return;
                        markHandledMobileAction();
                        stopStreaming();
                      }
                    }}
                    onTouchStart={(event) => {
                      if (typeof window === "undefined" || window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                      event.preventDefault();
                      if (!beginTouchActionGesture()) return;
                      markHandledMobileAction();
                      stopStreaming();
                    }}
                    onMouseDown={(event) => {
                      if (typeof window === "undefined" || window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                      event.preventDefault();
                    }}
                    onClick={() => {
                      if (consumeHandledMobileAction()) return;
                      stopStreaming();
                    }}
                    aria-label={t("chat.stopGeneration", "Stop generation")}
                    data-testid="quick-chat-stop"
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="quick-chat-send-btn"
                    onPointerDown={(event) => {
                      if (typeof window === "undefined" || window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                      event.preventDefault();
                      if (event.pointerType && event.pointerType !== "mouse") {
                        if (!beginTouchActionGesture()) return;
                        markHandledMobileAction();
                        markPreserveComposerFocus();
                        focusComposerInput();
                        void handleSendMessage();
                      }
                    }}
                    onTouchStart={(event) => {
                      if (typeof window === "undefined" || window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                      event.preventDefault();
                      if (!beginTouchActionGesture()) return;
                      markHandledMobileAction();
                      markPreserveComposerFocus();
                      focusComposerInput();
                      void handleSendMessage();
                    }}
                    onMouseDown={(event) => {
                      if (typeof window === "undefined" || window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT) return;
                      event.preventDefault();
                    }}
                    onClick={() => {
                      if (consumeHandledMobileAction()) return;
                      void handleSendMessage();
                    }}
                    disabled={sendDisabled}
                    data-testid="quick-chat-send"
                  >
                    <Send size={16} />
                  </button>
                )}
              </div>
              <AgentMentionPopup
                agents={agents}
                filter={mentionFilter}
                highlightedIndex={mentionHighlightIndex}
                visible={mentionPopupVisible}
                onSelect={handleMentionSelect}
                position="above"
                roomMemberIds={roomContext?.memberIds}
                roomName={roomContext?.roomName}
              />
              <FileMentionPopup
                visible={fileMention.mentionActive && !mentionPopupVisible}
                position={fileMentionPosition}
                tasks={fileMention.tasks}
                files={fileMention.files}
                selectedIndex={fileMention.selectedIndex}
                onSelectTask={(task) => {
                  insertHashMention(fileMention.selectTask(task, messageInput), `#${task.id}`);
                }}
                onSelectFile={(file) => {
                  insertHashMention(fileMention.selectFile(file, messageInput), `#${file.path}`);
                }}
                loading={fileMention.loading}
              />
              {showSkillMenu && (
                <div className="chat-skill-menu" data-testid="quick-chat-skill-menu" role="listbox" aria-label="Skill suggestions">
                  {skillsLoading ? (
                    <div className="chat-skill-menu-empty">{t("chat.loadingSkills", "Loading skills…")}</div>
                  ) : filteredSkills.length === 0 ? (
                    <div className="chat-skill-menu-empty">
                      {skillFilter ? t("chat.noSkillsFound", "No skills found") : t("chat.noSkillsAvailable", "No skills available")}
                    </div>
                  ) : (
                    filteredSkills.map((skill, index) => (
                      <button
                        key={skill.id}
                        type="button"
                        role="option"
                        aria-selected={index === highlightedSkillIndex}
                        className={`chat-skill-menu-item${index === highlightedSkillIndex ? " chat-skill-menu-item--highlighted" : ""}`}
                        onMouseDown={(event) => event.preventDefault()}
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
              {!roomThreadActive && pendingMessage && (
                <div className="chat-pending-message" data-testid="chat-pending-indicator">
                  <span>{t("chat.queuedMessage", "Queued: {{preview}}", { preview: pendingPreview })}</span>
                  <button
                    type="button"
                    className="chat-pending-message-dismiss"
                    aria-label={t("chat.dismissQueuedMessage", "Dismiss queued message")}
                    data-testid="chat-pending-dismiss"
                    onClick={clearPendingMessage}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
