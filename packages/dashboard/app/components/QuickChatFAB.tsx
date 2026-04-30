import "./QuickChatFAB.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Eye, EyeOff, MessageSquare, Paperclip, Plus, Send, Square, Wrench, X } from "lucide-react";
import { fetchModels, type Agent, type ModelInfo } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { AgentMentionPopup } from "./AgentMentionPopup";
import { FN_AGENT_ID, useQuickChat, type ChatMessageInfo, type ToolCallInfo } from "../hooks/useQuickChat";
import { useAgents } from "../hooks/useAgents";
import { FileMentionPopup } from "./FileMentionPopup";
import { useFileMention } from "../hooks/useFileMention";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";

interface PendingAttachment {
  file: File;
  /** Object URL for image previews; empty string for non-image attachments. */
  previewUrl: string;
}

interface QuickChatFABProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
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

function renderToolCalls(toolCalls?: ToolCallInfo[], compact = false): ReactNode {
  if (!toolCalls || toolCalls.length === 0) return null;

  const renderToolCallItem = (toolCall: ToolCallInfo, index: number) => {
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
      <details className={`chat-tool-calls-group${compact ? " chat-tool-calls-group--compact" : ""}`} data-testid="chat-tool-calls-group" open={hasRunning}>
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

const quickChatMarkdownComponents: Components = {
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
function useDraggable(projectId?: string, externalDidDragRef?: React.MutableRefObject<boolean>) {
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
  // Use external ref if provided, otherwise create internal one
  const didDragRef = externalDidDragRef ?? useRef(false);

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

  // Handle pointer down (start drag)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only handle primary button (left click) or touch
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // Check if this is a click on an interactive element inside the FAB (not the FAB itself)
    const target = e.target as HTMLElement;
    const fabButton = target.closest(".quick-chat-fab") as HTMLElement | null;
    if (!fabButton) return;

    e.preventDefault();
    // setPointerCapture may not exist in jsdom/tests
    if (typeof fabButton.setPointerCapture === "function") {
      fabButton.setPointerCapture(e.pointerId);
    }

    dragStartRef.current = {
      x: position.x,
      y: position.y,
      pointerX: e.clientX,
      pointerY: e.clientY,
    };
    didDragRef.current = false;
    setIsDragging(true);

    // Prevent text selection during drag
    document.body.style.userSelect = "none";
  }, [position]);

  // Handle pointer move (during drag)
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStartRef.current || !isDragging) return;

    const deltaX = e.clientX - dragStartRef.current.pointerX;
    const deltaY = e.clientY - dragStartRef.current.pointerY;

    // Check if we've moved enough to be considered a drag (>= 5px)
    if (Math.abs(deltaX) >= 5 || Math.abs(deltaY) >= 5) {
      didDragRef.current = true;
    }

    if (didDragRef.current) {
      // Move in the opposite direction (dragging right moves FAB right, which means reducing right offset)
      const newX = dragStartRef.current.x - deltaX;
      const newY = dragStartRef.current.y - deltaY;

      const clamped = clampPosition({ x: newX, y: newY });
      setPosition(clamped);
    }
  }, [isDragging, clampPosition]);

  // Handle pointer up (end drag)
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragStartRef.current) return;

    const fabButton = (e.target as HTMLElement).closest(".quick-chat-fab") as HTMLElement | null;
    if (fabButton && typeof fabButton.releasePointerCapture === "function") {
      fabButton.releasePointerCapture(e.pointerId);
    }

    setIsDragging(false);

    // Restore text selection
    document.body.style.userSelect = "";

    // If we didn't drag (movement < 5px), this was a click - caller handles toggle
    if (!didDragRef.current) {
      dragStartRef.current = null;
      return;
    }

    // Save position to localStorage
    savePosition(position);

    dragStartRef.current = null;
    didDragRef.current = false;
  }, [position, savePosition]);

  return {
    position,
    isDragging,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}

function usePanelResize(projectId: string | undefined, fabRight: number, fabBottom: number) {
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
    if (typeof window === "undefined" || window.innerWidth <= QUICK_CHAT_DESKTOP_BREAKPOINT) {
      return QUICK_CHAT_DEFAULT_PANEL_SIZE;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return QUICK_CHAT_DEFAULT_PANEL_SIZE;
      const parsed = JSON.parse(raw) as Partial<PanelSize>;
      if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
        return QUICK_CHAT_DEFAULT_PANEL_SIZE;
      }
      return { width: parsed.width, height: parsed.height };
    } catch {
      return QUICK_CHAT_DEFAULT_PANEL_SIZE;
    }
  }, [storageKey]);

  const [panelSize, setPanelSize] = useState<PanelSize>(loadPersistedSize);

  /**
   * Anchor offset relative to the FAB position.
   * When the user drags the south or east handle, we shift the anchor so the
   * panel top/left edge moves while the opposite edge stays fixed.
   */
  const [anchorOffset, setAnchorOffset] = useState<PanelAnchorOffset>({ right: 0, bottom: 0 });

  useEffect(() => {
    if (!isDesktopViewport()) return;
    const effective = { right: fabRight + anchorOffset.right, bottom: fabBottom + anchorOffset.bottom };
    setPanelSize((current) => clampPanelSize(current, effective.right, effective.bottom));
  }, [clampPanelSize, isDesktopViewport, fabRight, fabBottom, anchorOffset]);

  useEffect(() => {
    if (!isDesktopViewport()) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(panelSize));
    } catch {
      // Ignore storage errors (private mode / quota)
    }
  }, [isDesktopViewport, panelSize, storageKey]);

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
          localStorage.setItem(storageKey, JSON.stringify({ width: panelSize.width, height: panelSize.height }));
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
      panelSize.height,
      panelSize.width,
      storageKey,
    ],
  );

  return {
    panelSize,
    anchorOffset,
    handleResizeStart,
  };
}

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
}: QuickChatFABProps) {
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

  const { keyboardOverlap, viewportHeight } = useMobileKeyboard({ enabled: isOpen });

  const keyboardPanelStyle: CSSProperties =
    keyboardOverlap > 0
      ? ({
          "--keyboard-overlap": `${keyboardOverlap}px`,
          ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
        } as CSSProperties)
      : {};

  const [chatMode, setChatMode] = useState<"agent" | "model">("agent");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [configuredDefaultModelSelection, setConfiguredDefaultModelSelection] = useState<string>("");
  const [messageInput, setMessageInput] = useState("");
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPopupVisible, setMentionPopupVisible] = useState(false);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const [plainTextMessageIds, setPlainTextMessageIds] = useState<Set<string>>(() => new Set());
  /** Pending attachments staged in the composer before being sent. */
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);

  // File mention state and hook
  const [, setFileMentionPopupVisible] = useState(false);
  const [fileMentionPosition, setFileMentionPosition] = useState({ top: 0, left: 0 });
  const fileMention = useFileMention({ projectId });

  // Calculate popup position based on caret position in input
  const updateFileMentionPosition = useCallback((input: HTMLInputElement | null) => {
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
  const prevSessionTargetRef = useRef("");
  const mentionCursorPosRef = useRef(0);
  const hideMentionPopupTimeoutRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  // Draggable hook for FAB positioning
  const {
    position,
    isDragging,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  } = useDraggable(projectId, didDragRef);

  // Panel stays 60px above FAB (FAB is 48px tall + 12px gap)
  const panelY = position.y + 60;
  const { panelSize, anchorOffset, handleResizeStart } = usePanelResize(projectId, position.x, panelY);
  const shouldApplyDesktopPanelSize = typeof window !== "undefined" && window.innerWidth > QUICK_CHAT_DESKTOP_BREAKPOINT;

  // Chat session hook
  const {
    activeSession,
    messages,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    sessionsLoading,
    messagesLoading,
    sendMessage,
    stopStreaming,
    pendingMessage,
    clearPendingMessage,
    switchSession,
    startModelChat,
    startFreshSession,
  } = useQuickChat(projectId, addToast);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const shouldAutoFocusComposerRef = useRef(false);

  const resolvedModelSelection = selectedModel || configuredDefaultModelSelection;

  const parsedModelSelection = useMemo(() => parseModelSelection(resolvedModelSelection), [resolvedModelSelection]);
  const selectedModelInfo = useMemo(
    () => models.find((model) => `${model.provider}/${model.id}` === resolvedModelSelection) ?? null,
    [models, resolvedModelSelection],
  );
  const selectedModelTag = useMemo(
    () => formatModelTagName(selectedModelInfo, parsedModelSelection),
    [selectedModelInfo, parsedModelSelection],
  );

  const sessionTargetKey = useMemo(() => {
    if (chatMode === "model") {
      if (parsedModelSelection) {
        return `${FN_AGENT_ID}::${parsedModelSelection.modelProvider}/${parsedModelSelection.modelId}`;
      }
      return "";
    }
    // chatMode === "agent"
    if (selectedAgentId) {
      return `${selectedAgentId}::`;
    }
    return "";
  }, [chatMode, parsedModelSelection, selectedAgentId]);

  const hasChatTarget = chatMode === "agent" ? Boolean(selectedAgentId) : Boolean(parsedModelSelection);
  const inputDisabled = !hasChatTarget || !activeSession;

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId("");
      setChatMode("model");
      return;
    }

    const selectedStillExists = agents.some((agent) => agent.id === selectedAgentId);
    if (!selectedStillExists) {
      setSelectedAgentId(agents[0]?.id ?? "");
    }
  }, [agents, selectedAgentId]);

  // Lazy-load models on first panel open.
  useEffect(() => {
    if (!isOpen || modelsRequestedRef.current) {
      return;
    }

    modelsRequestedRef.current = true;
    setModelsLoading(true);

    fetchModels()
      .then((response) => {
        const loadedModels = response.models ?? [];
        setModels(loadedModels);

        if (selectedModel || loadedModels.length === 0) {
          return;
        }

        const defaultProvider = response.defaultProvider;
        const defaultModelId = response.defaultModelId;
        if (defaultProvider && defaultModelId) {
          const defaultSelection = `${defaultProvider}/${defaultModelId}`;
          const hasDefaultModel = loadedModels.some(
            (model) => `${model.provider}/${model.id}` === defaultSelection,
          );
          if (hasDefaultModel) {
            setConfiguredDefaultModelSelection(defaultSelection);
            setSelectedModel(defaultSelection);
            // Switch to model mode regardless of whether agents are present —
            // a configured default model is an explicit user preference and
            // should drive the panel to its corresponding mode immediately,
            // otherwise the tag/dropdown auto-selection would be invisible
            // until the user manually toggles modes.
            setChatMode("model");
            return;
          }
        }

        setConfiguredDefaultModelSelection("");

        // Always pre-select the first model so users can start chatting in model mode
        // without having to manually pick from the dropdown.
        const firstModel = loadedModels[0];
        if (firstModel) {
          setSelectedModel(`${firstModel.provider}/${firstModel.id}`);
        }
      })
      .catch((error: unknown) => {
        console.error("[QuickChatFAB] Failed to load models:", error);
        setModels([]);
        setConfiguredDefaultModelSelection("");
      })
      .finally(() => {
        setModelsLoading(false);
      });
  }, [isOpen, agents.length, selectedModel]);

  // Initialize/switch quick chat session whenever the selected target changes.
  useEffect(() => {
    if (!isOpen) {
      prevSessionTargetRef.current = "";
      return;
    }

    if (!sessionTargetKey) {
      prevSessionTargetRef.current = "";
      return;
    }

    const shouldRetrySessionInit = sessionTargetKey === prevSessionTargetRef.current
      && !activeSession
      && !sessionsLoading;

    if (sessionTargetKey === prevSessionTargetRef.current && !shouldRetrySessionInit) {
      return;
    }

    prevSessionTargetRef.current = sessionTargetKey;

    if (chatMode === "model" && parsedModelSelection) {
      void startModelChat(parsedModelSelection.modelProvider, parsedModelSelection.modelId);
      return;
    }

    if (chatMode === "agent" && selectedAgentId) {
      void switchSession(selectedAgentId);
    }
  }, [
    isOpen,
    chatMode,
    parsedModelSelection,
    selectedAgentId,
    sessionTargetKey,
    activeSession,
    sessionsLoading,
    startModelChat,
    switchSession,
  ]);

  useEffect(() => {
    if (isOpen) {
      return;
    }

    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
    pendingAttachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    });
    setPendingAttachments([]);
  }, [isOpen]);

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

    shouldAutoFocusComposerRef.current = window.innerWidth <= QUICK_CHAT_DESKTOP_BREAKPOINT;
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

    if (!panelContainsFocus && !isBodyFocused) {
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

  const handleAgentChange = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, []);

  const handleModelChange = useCallback((value: string) => {
    setSelectedModel(value);
  }, []);

  const handleStartFreshChat = useCallback(() => {
    if (!hasChatTarget || sessionsLoading) {
      return;
    }
    void startFreshSession();
  }, [hasChatTarget, sessionsLoading, startFreshSession]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const filteredMentionAgents = useMemo(() => {
    const normalizedFilter = mentionFilter.trim().toLowerCase();
    if (!normalizedFilter) {
      return agents;
    }

    return agents.filter((agent) => agent.name.toLowerCase().includes(normalizedFilter));
  }, [agents, mentionFilter]);

  const mentionAgentsByName = useMemo(() => {
    const byName = new Map<string, Agent>();
    for (const agent of agents) {
      byName.set(agent.name.toLowerCase(), agent);
    }
    return byName;
  }, [agents]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionFilter, mentionPopupVisible]);

  useEffect(() => {
    return () => {
      if (hideMentionPopupTimeoutRef.current !== null) {
        window.clearTimeout(hideMentionPopupTimeoutRef.current);
        hideMentionPopupTimeoutRef.current = null;
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

  // Auto-scroll messages
  useEffect(() => {
    if (!isOpen) return;
    const messagesEl = messagesRef.current;
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, [messages, streamingText, streamingThinking, isOpen]);

  const inputPlaceholder = useMemo(() => {
    if (chatMode === "agent") {
      if (selectedAgent) {
        return `Message ${selectedAgent.name || selectedAgent.id}`;
      }
      return "Select an agent to start chatting";
    }
    // model mode
    if (selectedModelTag) {
      return `Message ${selectedModelTag}`;
    }
    return "Select a model to start chatting";
  }, [chatMode, selectedAgent, selectedModelTag]);

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

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    handleAttachmentFiles(event.clipboardData?.files);
  }, [handleAttachmentFiles]);

  const handleSendMessage = useCallback(async () => {
    const trimmed = messageInput.trim();
    const attachmentsToSend = pendingAttachmentsRef.current;
    if (!trimmed && attachmentsToSend.length === 0) return;
    if (inputDisabled) return;

    setMessageInput("");
    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);

    try {
      await sendMessage(trimmed, attachmentsToSend.map((attachment) => attachment.file));
      attachmentsToSend.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      setPendingAttachments((previous) => previous.filter((attachment) => !attachmentsToSend.includes(attachment)));
    } catch {
      // Keep pending attachments on failure so user can retry.
    }
  }, [sendMessage, inputDisabled, messageInput]);

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
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [mentionStartPos, messageInput],
  );

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;
      const cursorPos = event.target.selectionStart ?? nextValue.length;
      mentionCursorPosRef.current = cursorPos;
      setMessageInput(nextValue);
      updateMentionState(nextValue, cursorPos);

      // Detect file mentions
      fileMention.detectMention(nextValue, cursorPos);
      setFileMentionPopupVisible(fileMention.mentionActive);
      if (fileMention.mentionActive) {
        updateFileMentionPosition(event.target);
      }
    },
    [updateMentionState, fileMention, updateFileMentionPosition],
  );

  const handleInputBlur = useCallback(() => {
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
  }, [fileMention]);

  const handleInputFocus = useCallback(() => {
    if (hideMentionPopupTimeoutRef.current !== null) {
      window.clearTimeout(hideMentionPopupTimeoutRef.current);
      hideMentionPopupTimeoutRef.current = null;
    }
  }, []);

  const handleInputSelectionChange = useCallback(
    (event: React.SyntheticEvent<HTMLInputElement>) => {
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
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        return;
      }
      handleInputSelectionChange(event);
    },
    [handleInputSelectionChange],
  );

  const renderMessageContent = useCallback(
    (content: string) => {
      const mentionRegex = /@([\w-]+)/g;
      const parts: ReactNode[] = [];
      let lastIndex = 0;
      let match = mentionRegex.exec(content);

      while (match) {
        const [fullMatch, rawName = ""] = match;
        const start = match.index;
        if (start > lastIndex) {
          parts.push(content.slice(lastIndex, start));
        }

        const normalizedName = rawName.replace(/_/g, " ").toLowerCase();
        const mentionedAgent = mentionAgentsByName.get(normalizedName);
        if (mentionedAgent) {
          parts.push(
            <span key={`${mentionedAgent.id}-${start}`} className="chat-mention-chip">
              @{mentionedAgent.name.replace(/\s+/g, "_")}
            </span>,
          );
        } else {
          parts.push(fullMatch);
        }

        lastIndex = start + fullMatch.length;
        match = mentionRegex.exec(content);
      }

      if (lastIndex < content.length) {
        parts.push(content.slice(lastIndex));
      }

      if (parts.length === 0) {
        return content;
      }

      return parts;
    },
    [mentionAgentsByName],
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
        return <div className="quick-chat-message-content quick-chat-message-content--plain">{content}</div>;
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
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      mentionCursorPosRef.current = event.currentTarget.selectionStart ?? mentionCursorPosRef.current;

      // Handle file mention popup keyboard navigation first
      if (fileMention.mentionActive && fileMention.files.length > 0) {
        fileMention.handleKeyDown(event, messageInput);
        if (event.key === "Enter" || event.key === "Tab") {
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
      messageInput,
    ],
  );

  // Handle FAB click - only toggle if this was a click (not a drag)
  // Reset didDragRef after checking to prevent double-toggle
  const handleFABClick = useCallback(() => {
    if (didDragRef.current) {
      // Was a drag, don't toggle
      didDragRef.current = false;
      return;
    }
    setIsOpen((prev) => !prev);
  }, [setIsOpen]);

  return (
    <>
      {showFAB && (
        <button
          ref={fabRef}
          type="button"
          className="quick-chat-fab"
          aria-label="Open quick chat"
          data-testid="quick-chat-fab"
          data-dragging={isDragging ? "true" : "false"}
          style={{ right: position.x, bottom: position.y }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handleFABClick}
        >
          <MessageSquare size={24} />
        </button>
      )}

      {isOpen && (
        <div
          className="quick-chat-panel"
          ref={panelRef}
          data-testid="quick-chat-panel"
          style={{
            right: position.x + anchorOffset.right,
            bottom: panelY + anchorOffset.bottom,
            ...(shouldApplyDesktopPanelSize ? { width: panelSize.width, height: panelSize.height } : {}),
            ...keyboardPanelStyle,
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
                aria-label="Resize panel from top"
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="s"
                data-testid="quick-chat-resize-s"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize panel from bottom"
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="e"
                data-testid="quick-chat-resize-e"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel from right"
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="w"
                data-testid="quick-chat-resize-w"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel from left"
              />
              {/* Corner handles */}
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="nw"
                data-testid="quick-chat-resize-nw"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label="Resize panel from top-left corner"
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="ne"
                data-testid="quick-chat-resize-ne"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label="Resize panel from top-right corner"
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="sw"
                data-testid="quick-chat-resize-sw"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label="Resize panel from bottom-left corner"
              />
              <div
                className="quick-chat-resize-handle"
                data-resize-direction="se"
                data-testid="quick-chat-resize-se"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-label="Resize panel from bottom-right corner"
              />
            </>
          )}

          <div className="quick-chat-panel-header">
            <div className="quick-chat-panel-title-wrap">
              <h3>Quick Chat</h3>
              {chatMode === "model" && selectedModelTag && (
                <span className="quick-chat-model-tag" data-testid="quick-chat-model-tag" title={selectedModelTag}>
                  {selectedModelTag}
                </span>
              )}
            </div>
            <div className="quick-chat-panel-header-actions">
              {agents.length > 0 && (
                <div className="quick-chat-header-mode-toggle" data-testid="quick-chat-mode-toggle">
                  <button
                    type="button"
                    className={`quick-chat-mode-btn${chatMode === "agent" ? " quick-chat-mode-btn--active" : ""}`}
                    data-testid="quick-chat-mode-agent"
                    onClick={() => {
                      setChatMode("agent");
                      setSelectedModel("");
                    }}
                    aria-label="Switch to agent mode"
                    title="Agent mode"
                  >
                    Agent
                  </button>
                  <button
                    type="button"
                    className={`quick-chat-mode-btn${chatMode === "model" ? " quick-chat-mode-btn--active" : ""}`}
                    data-testid="quick-chat-mode-model"
                    onClick={() => {
                      setChatMode("model");
                      setSelectedAgentId("");
                    }}
                    aria-label="Switch to model mode"
                    title="Model mode"
                  >
                    Model
                  </button>
                </div>
              )}
              <button
                type="button"
                className="btn-icon quick-chat-new-chat-btn"
                data-testid="quick-chat-new-thread"
                aria-label="Start a new chat"
                onClick={handleStartFreshChat}
                disabled={!hasChatTarget || sessionsLoading}
              >
                <Plus size={16} />
              </button>
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
          </div>

          {chatMode === "agent" && agents.length > 0 && (
            <div className="quick-chat-panel-agent-select">
              <label htmlFor="quick-chat-agent-select" className="visually-hidden">Select agent</label>
              <select
                id="quick-chat-agent-select"
                value={selectedAgentId}
                onChange={(event) => handleAgentChange(event.target.value)}
                data-testid="quick-chat-agent-select"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {getAgentLabel(agent)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {chatMode === "model" && (
            <div className="quick-chat-panel-agent-select" data-testid="quick-chat-model-select">
              <label htmlFor="quick-chat-model-override" className="visually-hidden">Select model override</label>
              <CustomModelDropdown
                id="quick-chat-model-override"
                models={models}
                value={selectedModel}
                onChange={handleModelChange}
                label="Select model override"
                placeholder={modelsLoading ? "Loading models…" : "Select a model"}
                disabled={modelsLoading || models.length === 0}
                favoriteProviders={favoriteProviders}
                favoriteModels={favoriteModels}
                onToggleFavorite={onToggleFavorite}
                onToggleModelFavorite={onToggleModelFavorite}
              />
            </div>
          )}

          <div className="quick-chat-panel-messages" ref={messagesRef} data-testid="quick-chat-messages">
            {sessionsLoading || messagesLoading ? (
              <div className="quick-chat-panel-empty">Loading conversation…</div>
            ) : messages.length === 0 && !streamingText && !streamingThinking && !isStreaming ? (
              <div className="quick-chat-panel-empty">No messages yet. Start the conversation!</div>
            ) : (
              <>
                {messages.map((message: ChatMessageInfo) => {
                  const isSent = message.role === "user";
                  const forcePlain = !isSent && plainTextMessageIds.has(message.id);
                  return (
                    <div
                      key={message.id}
                      className={`quick-chat-panel-message ${isSent ? "quick-chat-panel-message--sent" : "quick-chat-panel-message--received"}`}
                      data-testid={`quick-chat-message-${message.id}`}
                    >
                      {isSent
                        ? <p>{renderMessageContent(message.content)}</p>
                        : (
                          <>
                            {renderAssistantMessageContent(message.content, forcePlain)}
                            <button
                              type="button"
                              className={`quick-chat-message-render-toggle${forcePlain ? " quick-chat-message-render-toggle--plain" : ""}`}
                              data-testid="quick-chat-message-render-toggle"
                              aria-label={forcePlain ? "Show rendered markdown" : "Show plain text"}
                              onClick={() => toggleMessageRenderMode(message.id)}
                            >
                              {forcePlain ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </>
                        )}
                      {renderToolCalls(message.toolCalls, true)}
                    </div>
                  );
                })}
                {/* Streaming message bubble */}
                {isStreaming && (
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
                          aria-label={plainTextMessageIds.has("__streaming__") ? "Show rendered markdown" : "Show plain text"}
                          onClick={() => toggleMessageRenderMode("__streaming__")}
                        >
                          {plainTextMessageIds.has("__streaming__") ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </>
                    ) : (
                      <p className="quick-chat-panel-waiting" data-testid="quick-chat-waiting">
                        Thinking…
                      </p>
                    )}
                    {renderToolCalls(streamingToolCalls, true)}
                    {streamingThinking && (
                      <details className="chat-message-thinking" data-testid="quick-chat-streaming-thinking">
                        <summary>Thinking</summary>
                        <pre className="chat-message-thinking-content">{streamingThinking}</pre>
                      </details>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

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
                    aria-label={`Remove ${attachment.file.name}`}
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
                  aria-label="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={16} />
                </button>
                <input
                  ref={inputRef}
                  type="text"
                  value={messageInput}
                  onChange={handleInputChange}
                  onKeyDown={handleInputKeyDown}
                  onKeyUp={handleInputKeyUp}
                  onClick={handleInputSelectionChange}
                  onBlur={handleInputBlur}
                  onFocus={handleInputFocus}
                  onPaste={handlePaste}
                  placeholder={inputPlaceholder}
                  disabled={inputDisabled}
                  data-testid="quick-chat-input"
                />
                {isStreaming ? (
                  <button
                    type="button"
                    className="chat-input-stop quick-chat-send-btn"
                    onClick={stopStreaming}
                    aria-label="Stop generation"
                    data-testid="quick-chat-stop"
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="quick-chat-send-btn"
                    onClick={() => {
                      void handleSendMessage();
                    }}
                    disabled={inputDisabled || (messageInput.trim().length === 0 && pendingAttachments.length === 0)}
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
          </div>
        </div>
      )}
    </>
  );
}
