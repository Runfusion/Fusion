import "./TerminalModal.css";
import { createPortal } from "react-dom";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import {
  X,
  Trash2,
  Terminal as TerminalIcon,
  RefreshCw,
  Minus,
  Plus,
  Keyboard,
  Settings,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { useTerminalSessions } from "../hooks/useTerminalSessions";
import { nextFloatingZ, currentFloatingZ } from "./floatingWindowStack";
import { getPathBasename } from "../utils/pathDisplay";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_FAMILY_PRESETS,
  clampTerminalFontSize,
  readTerminalPreferences,
  resolveTerminalFontFamily,
  resolveTerminalGlyphFontFamily,
  waitForTerminalFontMetrics,
  writeTerminalPreferences,
  type TerminalPreferences,
  type TerminalRenderer,
} from "../utils/terminalPreferences";
import "@xterm/xterm/css/xterm.css";

import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/** Timeout for xterm.js dynamic imports + terminal.open() setup. */
const XTERM_INIT_TIMEOUT_MS = 10000;

const XTERM_IMPORT_RETRY_DELAYS_MS = [500, 1500, 3000] as const;

type TerminalDisplayMode = "docked" | "floating";

const TERMINAL_DOCKED_DEFAULT_HEIGHT = 360;
const TERMINAL_DOCKED_MIN_HEIGHT = 240;
const TERMINAL_DOCKED_VIEWPORT_MARGIN = 96;
const TERMINAL_FLOAT_DEFAULT_WIDTH = 960;
const TERMINAL_FLOAT_DEFAULT_HEIGHT = 560;
const TERMINAL_FLOAT_MIN_WIDTH = 480;
const TERMINAL_FLOAT_MIN_HEIGHT = 320;
const TERMINAL_FLOAT_VIEWPORT_PADDING = 16;

type TerminalResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const TERMINAL_RESIZE_DIRECTIONS: TerminalResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

interface TerminalFloatSize {
  width: number;
  height: number;
}

interface TerminalFloatPosition {
  x: number;
  y: number;
}

function readTerminalDisplayMode(projectId?: string): TerminalDisplayMode {
  if (typeof window === "undefined") return "docked";
  const value = window.localStorage.getItem(`fusion:terminal-display-mode-${projectId ?? "default"}`);
  return value === "floating" ? "floating" : "docked";
}

function writeTerminalDisplayMode(mode: TerminalDisplayMode, projectId?: string): TerminalDisplayMode {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(`fusion:terminal-display-mode-${projectId ?? "default"}`, mode);
  }
  return mode;
}

function readTerminalDockedHeight(projectId?: string): number {
  if (typeof window === "undefined") return TERMINAL_DOCKED_DEFAULT_HEIGHT;
  const parsed = Number.parseInt(window.localStorage.getItem(`fusion:terminal-docked-height-${projectId ?? "default"}`) ?? "", 10);
  return Number.isFinite(parsed) ? parsed : TERMINAL_DOCKED_DEFAULT_HEIGHT;
}

function clampTerminalDockedHeight(height: number): number {
  if (typeof window === "undefined") return Math.max(TERMINAL_DOCKED_MIN_HEIGHT, height);
  const maxHeight = Math.max(TERMINAL_DOCKED_MIN_HEIGHT, window.innerHeight - TERMINAL_DOCKED_VIEWPORT_MARGIN);
  return Math.min(Math.max(height, TERMINAL_DOCKED_MIN_HEIGHT), maxHeight);
}

function writeTerminalDockedHeight(height: number, projectId?: string): number {
  const clamped = clampTerminalDockedHeight(height);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(`fusion:terminal-docked-height-${projectId ?? "default"}`, String(Math.round(clamped)));
  }
  return clamped;
}

function clampTerminalFloatSize(size: TerminalFloatSize): TerminalFloatSize {
  if (typeof window === "undefined") return size;
  return {
    width: Math.min(Math.max(size.width, TERMINAL_FLOAT_MIN_WIDTH), Math.max(TERMINAL_FLOAT_MIN_WIDTH, window.innerWidth - TERMINAL_FLOAT_VIEWPORT_PADDING * 2)),
    height: Math.min(Math.max(size.height, TERMINAL_FLOAT_MIN_HEIGHT), Math.max(TERMINAL_FLOAT_MIN_HEIGHT, window.innerHeight - TERMINAL_FLOAT_VIEWPORT_PADDING * 2)),
  };
}

function clampTerminalFloatPosition(position: TerminalFloatPosition, size: TerminalFloatSize): TerminalFloatPosition {
  if (typeof window === "undefined") return position;
  return {
    x: Math.min(Math.max(position.x, TERMINAL_FLOAT_VIEWPORT_PADDING), Math.max(TERMINAL_FLOAT_VIEWPORT_PADDING, window.innerWidth - size.width - TERMINAL_FLOAT_VIEWPORT_PADDING)),
    y: Math.min(Math.max(position.y, TERMINAL_FLOAT_VIEWPORT_PADDING), Math.max(TERMINAL_FLOAT_VIEWPORT_PADDING, window.innerHeight - size.height - TERMINAL_FLOAT_VIEWPORT_PADDING)),
  };
}

function readTerminalFloatSize(projectId?: string): TerminalFloatSize {
  if (typeof window === "undefined") return { width: TERMINAL_FLOAT_DEFAULT_WIDTH, height: TERMINAL_FLOAT_DEFAULT_HEIGHT };
  try {
    const raw = window.localStorage.getItem(`fusion:terminal-modal-size-${projectId ?? "default"}`) ?? window.localStorage.getItem("fusion:terminal-modal-size");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalFloatSize>;
      if (typeof parsed.width === "number" && typeof parsed.height === "number") return clampTerminalFloatSize({ width: parsed.width, height: parsed.height });
    }
  } catch {
    // ignore corrupted size
  }
  return clampTerminalFloatSize({ width: TERMINAL_FLOAT_DEFAULT_WIDTH, height: TERMINAL_FLOAT_DEFAULT_HEIGHT });
}

function writeTerminalFloatSize(size: TerminalFloatSize, projectId?: string): TerminalFloatSize {
  const clamped = clampTerminalFloatSize(size);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(`fusion:terminal-modal-size-${projectId ?? "default"}`, JSON.stringify(clamped));
  }
  return clamped;
}

function readTerminalFloatPosition(size: TerminalFloatSize, projectId?: string): TerminalFloatPosition {
  if (typeof window === "undefined") return { x: TERMINAL_FLOAT_VIEWPORT_PADDING, y: TERMINAL_FLOAT_VIEWPORT_PADDING };
  try {
    const raw = window.localStorage.getItem(`fusion:terminal-float-pos-${projectId ?? "default"}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalFloatPosition>;
      if (typeof parsed.x === "number" && typeof parsed.y === "number") return clampTerminalFloatPosition({ x: parsed.x, y: parsed.y }, size);
    }
  } catch {
    // ignore corrupted position
  }
  return clampTerminalFloatPosition({ x: window.innerWidth - size.width - TERMINAL_FLOAT_VIEWPORT_PADDING, y: TERMINAL_FLOAT_VIEWPORT_PADDING }, size);
}

function writeTerminalFloatPosition(position: TerminalFloatPosition, size: TerminalFloatSize, projectId?: string): TerminalFloatPosition {
  const clamped = clampTerminalFloatPosition(position, size);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(`fusion:terminal-float-pos-${projectId ?? "default"}`, JSON.stringify(clamped));
  }
  return clamped;
}

const TERMINAL_KEY_LABELS = {
  ctrl: "Ctrl",
  alt: "Alt",
  escape: "ESC",
  tab: "Tab",
  pxUnit: "px",
} as const;

export function ctrlChar(key: string): string {
  if (!key) {
    return "";
  }

  const normalized = key.slice(0, 1).toUpperCase();

  if (normalized === "[") {
    return "\x1b";
  }

  if (normalized >= "A" && normalized <= "Z") {
    return String.fromCharCode(normalized.charCodeAt(0) - 64);
  }

  return key;
}

export function altChar(key: string): string {
  return `\x1b${key}`;
}

interface ShortcutKey {
  label: string;
  key: string;
  description?: string;
}

export const SHORTCUT_KEYS: ShortcutKey[] = [
  { label: "C", key: "c", description: "SigInt" },
  { label: "D", key: "d", description: "EOF" },
  { label: "Z", key: "z", description: "Suspend" },
  { label: "L", key: "l", description: "Clear" },
  { label: "R", key: "r", description: "Reverse search" },
  { label: "A", key: "a", description: "Home" },
  { label: "E", key: "e", description: "End" },
  { label: "U", key: "u", description: "Kill line" },
  { label: "K", key: "k", description: "Kill to EOL" },
  { label: "W", key: "w", description: "Del word" },
  { label: ".", key: ".", description: "Last argument" },
];

const ARROW_SHORTCUT_KEYS = [
  { label: "↑", sequence: "\x1b[A", testId: "terminal-arrow-up", ariaLabel: "Send arrow up" },
  { label: "↓", sequence: "\x1b[B", testId: "terminal-arrow-down", ariaLabel: "Send arrow down" },
  { label: "←", sequence: "\x1b[D", testId: "terminal-arrow-left", ariaLabel: "Send arrow left" },
  { label: "→", sequence: "\x1b[C", testId: "terminal-arrow-right", ariaLabel: "Send arrow right" },
] as const;

function isRetryableDynamicImportError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  return (
    message.includes("MIME type") ||
    message.includes("Failed to fetch dynamically imported module")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryDynamicImport<T>(
  importFactory: () => Promise<T>,
  retryDelaysMs: readonly number[] = XTERM_IMPORT_RETRY_DELAYS_MS,
): Promise<T> {
  let originalError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await importFactory();
    } catch (error) {
      if (!isRetryableDynamicImportError(error)) {
        throw error;
      }

      if (originalError === undefined) {
        originalError = error;
      }

      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined) {
        throw originalError ?? error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[TerminalModal] Dynamic xterm import failed (attempt ${attempt + 1}/${retryDelaysMs.length + 1}). Retrying in ${delayMs}ms...`,
        message,
      );

      await sleep(delayMs);
    }
  }

  throw originalError ?? new Error("Dynamic import failed");
}

/** Whether the current device is likely mobile (touch-primary, small viewport). */
function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isNarrow = window.innerWidth <= 768;
  return hasTouchScreen && isNarrow;
}

function isTerminalMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return window.innerWidth <= 768 || (hasTouchScreen && window.innerHeight <= 480);
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform = navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac/i.test(userAgent);
}

/**
 * Compute how many CSS pixels the virtual keyboard covers from the bottom
 * of the layout viewport. Returns 0 on desktop or when visualViewport is
 * unavailable.
 *
 * Strategy:
 * - Primary: window.innerHeight - vv.offsetTop - vv.height
 *   Works on Chrome Android where window.innerHeight stays at full height.
 * - Fallback: initial viewport height - vv.height - vv.offsetTop
 *   Works on iOS Safari where window.innerHeight shrinks with the keyboard.
 */
function getKeyboardOverlap(): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  const chromeOverlap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
  if (chromeOverlap > 0) return chromeOverlap;
  // On iOS Safari, window.innerHeight shrinks to match visualViewport.
  // Detect keyboard by checking if visual viewport is shorter than initial
  // height by more than 80px (with a 30px noise filter).
  const initialHeight = getInitialViewportHeight();
  const gap = initialHeight - vv.offsetTop - vv.height;
  // Minimum 30px gap required to filter noise (address bar, toolbar changes).
  // Threshold of 80px: only consider keyboard present when gap exceeds this.
  return gap >= 30 && gap > 80 ? gap : 0;
}

/** Cached initial viewport height before any keyboard opened. */
let _initialViewportHeight: number | null = null;

/**
 * Returns the viewport height at page load (before any keyboard opens).
 * Cached after first read.
 */
function getInitialViewportHeight(): number {
  if (_initialViewportHeight === null) {
    _initialViewportHeight = window.innerHeight;
  }
  return _initialViewportHeight;
}

/** Reset the cached initial viewport height. Exported for tests only. */
export function _resetInitialViewportHeight(): void {
  _initialViewportHeight = null;
}

interface TerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCommand?: string;
  initialCommandGeneration?: number;
  projectId?: string;
}

/**
 * Interactive terminal modal component using xterm.js and node-pty.
 * 
 * Provides a fully functional PTY terminal where users can execute commands
 * in the project's working directory. Features include:
 * - Real-time bidirectional communication via WebSocket
 * - Multiple terminal tabs with session persistence
 * - xterm.js for proper terminal emulation
 * - Copy/paste support
 * - Terminal zoom (Ctrl++/Ctrl+-/Ctrl+0)
 * - Auto-resizing to container
 * - Reconnection support
 * 
 * The terminal spawns a real shell (bash/zsh/powershell based on platform).
 */
export function TerminalModal({ isOpen, onClose, initialCommand, initialCommandGeneration = 0, projectId }: TerminalModalProps) {
  const { t } = useTranslation("app");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [xtermReady, setXtermReady] = useState(false);
  const [xtermInitError, setXtermInitError] = useState<string | null>(null);
  const [openGeneration, setOpenGeneration] = useState(0);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(() =>
    readTerminalPreferences(),
  );
  const fontSize = terminalPreferences.fontSize;
  const resolvedFontFamily = resolveTerminalFontFamily(terminalPreferences.fontFamily);
  /*
  FNXC:Terminal 2026-06-18-15:40:
  TerminalModal must pass a symbols-free family to xterm so iOS WebKit measures ASCII cells against real monospace metrics. Keep the symbols fallback only in a scoped DOM glyph CSS variable; this preserves powerline glyph availability for DOM rows without reintroducing the loaded symbols @font-face into xterm's measurement, fit, or WebGL/canvas option path.
  */
  const terminalGlyphStyle = {
    "--terminal-glyph-font-family": resolveTerminalGlyphFontFamily(
      terminalPreferences.fontFamily,
    ),
  } as CSSProperties;
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [stickyModifier, setStickyModifier] = useState<null | "ctrl" | "alt">(null);
  const [pendingInitialCommandGeneration, setPendingInitialCommandGeneration] = useState(0);
  const [displayMode, setDisplayModeState] = useState<TerminalDisplayMode>(() => readTerminalDisplayMode(projectId));
  const [dockedHeight, setDockedHeight] = useState(() => readTerminalDockedHeight(projectId));
  const [floatingSize, setFloatingSize] = useState<TerminalFloatSize>(() => readTerminalFloatSize(projectId));
  const [floatingPosition, setFloatingPosition] = useState<TerminalFloatPosition>(() => readTerminalFloatPosition(readTerminalFloatSize(projectId), projectId));
  const [isMobileTerminal, setIsMobileTerminal] = useState(() => isTerminalMobileViewport());
  const isDockedMode = !isMobileTerminal && displayMode === "docked";
  const isFloatingMode = !isMobileTerminal && displayMode === "floating";
  // FNXC:FloatingWindow 2026-06-22-21:30: The FLOATING terminal shares the SINGLE cross-type floating z-index stack (floatingWindowStack) so tapping it raises it above every other floating modal regardless of type. A fresh z is claimed each time the modal opens (see effect below); tapping the panel (pointerdown/focus capture) re-raises it. Docked/mobile modes ignore this z-index (full-width bottom panel / full-screen sheet).
  const [floatingZ, setFloatingZ] = useState<number>(() => nextFloatingZ());
  const bringFloatingToFront = useCallback(() => {
    if (!isFloatingMode) return;
    setFloatingZ((current) => (current >= currentFloatingZ() ? current : nextFloatingZ()));
  }, [isFloatingMode]);
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayMouseDownRef = useRef(false);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  const hasInitialCommandRun = useRef<string | false>(false);
  const pendingInitialCommandRef = useRef<{ command: string; commandKey: string; sessionId: string } | null>(null);
  const creatingInitialCommandTabRef = useRef(false);
  const xtermInitializedRef = useRef<string | false>(false);
  const resizeRef = useRef<((cols: number, rows: number) => void) | null>(null);
  // Latest sendInput, kept in a ref so the xterm.onData listener bound at
  // init time always calls the current function without needing to re-bind
  // (which under StrictMode/Vite Fast Refresh could leak a stale listener
  // on the same xterm instance and cause per-character input doubling).
  const sendInputRef = useRef<(data: string) => void>(() => {});
  // Window resize listener tied to the live xterm instance — tracked here so
  // it can be removed in step with xterm disposal (modal close, tab switch).
  const windowResizeListenerRef = useRef<(() => void) | null>(null);
  const keyboardOverlapRef = useRef(0);
  const fontSizeRef = useRef(fontSize);
  const terminalPreferencesRef = useRef(terminalPreferences);
  const resolvedFontFamilyRef = useRef(resolvedFontFamily);
  const initializedRendererRef = useRef<TerminalRenderer>(terminalPreferences.renderer);
  /** Tracks a pending requestAnimationFrame for deferred xterm re-fit. */
  const pendingFitRef = useRef<number | null>(null);
  /*
  FNXC:Terminal 2026-06-22-09:00:
  Docked-resize, floating-drag, and floating-resize each attach pointer listeners and schedule a rAF for the duration of a drag. If the modal closes or the component unmounts mid-drag, those listeners + the pending frame would leak. Track the active drag teardown here and run it from the close/unmount effect.

  FNXC:Terminal 2026-06-22-19:50:
  All three families now capture the pointer and attach listeners to the CAPTURED handle element (not `document`), so the teardown also releasePointerCapture()s; the close/unmount effect still drives it through this single ref.
  */
  const dragTeardownRef = useRef<(() => void) | null>(null);
  /** Tracks the previous projectId to detect project switches and invalidate xterm. */
  const previousProjectIdRef = useRef<string | undefined>(projectId);

  // Keep the latest keyboard overlap in a ref so async xterm setup can read
  // current mobile keyboard state without forcing the init effect to re-run.
  keyboardOverlapRef.current = keyboardOverlap;
  fontSizeRef.current = fontSize;
  terminalPreferencesRef.current = terminalPreferences;
  resolvedFontFamilyRef.current = resolvedFontFamily;

  useEffect(() => {
    setDisplayModeState(readTerminalDisplayMode(projectId));
    setDockedHeight(readTerminalDockedHeight(projectId));
    const nextSize = readTerminalFloatSize(projectId);
    setFloatingSize(nextSize);
    setFloatingPosition(readTerminalFloatPosition(nextSize, projectId));
  }, [projectId]);

  useEffect(() => {
    if (!isOpen) return;
    /*
    FNXC:Terminal 2026-06-21-22:58:
    Viewport changes must force the terminal back onto the mobile fullscreen path at <=768px or touch-primary short landscape, then restore the stored desktop/tablet docked/floating mode when the viewport expands.
    */
    const updateViewportMode = () => setIsMobileTerminal(isTerminalMobileViewport());
    updateViewportMode();
    window.addEventListener("resize", updateViewportMode);
    window.visualViewport?.addEventListener("resize", updateViewportMode);
    return () => {
      window.removeEventListener("resize", updateViewportMode);
      window.visualViewport?.removeEventListener("resize", updateViewportMode);
    };
  }, [isOpen]);

  const setDisplayMode = useCallback((mode: TerminalDisplayMode) => {
    setDisplayModeState(writeTerminalDisplayMode(mode, projectId));
  }, [projectId]);

  const persistFloatingSize = useCallback((size: TerminalFloatSize) => {
    setFloatingSize(writeTerminalFloatSize(size, projectId));
  }, [projectId]);

  const persistFloatingPosition = useCallback((position: TerminalFloatPosition, size = floatingSize) => {
    setFloatingPosition(writeTerminalFloatPosition(position, size, projectId));
  }, [floatingSize, projectId]);

  /*
  FNXC:Terminal 2026-06-21-22:26:
  FN-6887 requires desktop/tablet terminal opens to default to a project-scoped docked bottom panel. Persist `fusion:terminal-display-mode-${projectId}` and `fusion:terminal-docked-height-${projectId}` so each project restores its preferred panel mode and height without affecting mobile fullscreen behavior.

  FNXC:Terminal 2026-06-21-22:45:
  The pop-out terminal mode uses project-scoped `fusion:terminal-modal-size-${projectId}` and `fusion:terminal-float-pos-${projectId}` keys so floating windows restore independently per project while avoiding the old bottom-right native resize grip conflict.
  */
  /*
  FNXC:Terminal 2026-06-22-19:50:
  Docked top-edge resize, smooth on touch + desktop (same technique as the right-dock pop-out RightDockExpandModal). On pointerdown we setPointerCapture on the handle and attach pointermove/up/cancel to the CAPTURED element (`captureTarget` = event.currentTarget), NOT `document` — capture redirects the full pointer stream for this pointerId to that element so element-scoped listeners receive every move even when the finger drifts off the handle, and they pair cleanly with the handle's `touch-action: none` (CSS) without a non-passive document listener. Moves are filtered by pointerId and coalesced into one rAF, so we set height at most once per frame and never thrash layout on a flood of touch-move events. localStorage is written only on pointerup (existing behavior). Teardown (pointerup/cancel + unmount via dragTeardownRef) cancels the pending rAF, releases pointer capture, and detaches listeners.
  */
  const handleDockedResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDockedMode) return;
    event.preventDefault();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startY = event.clientY;
    const startHeight = dockedHeight;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latestHeight = startHeight;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latestHeight = clampTerminalDockedHeight(startHeight + (startY - moveEvent.clientY));
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setDockedHeight(latestHeight);
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      setDockedHeight(writeTerminalDockedHeight(latestHeight, projectId));
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    // FNXC:Terminal 2026-06-22-19:50: Unmount/close-mid-drag teardown cancels the pending rAF, releases pointer capture, and detaches the captured-element listeners without persisting a partial drag.
    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [dockedHeight, isDockedMode, projectId]);

  /*
  FNXC:Terminal 2026-06-22-19:50:
  Floating-window move (drag the header grip), smooth on touch + desktop. Pointer capture + captured-element (`captureTarget`) listeners filtered by pointerId, identical to the right-dock pop-out drag. Raw pointer coords are stored in `latest` and applied via one rAF per frame, so a flood of touch-move events coalesces into a single state set and never thrashes layout. State-only updates during the drag; localStorage is persisted once on pointerup (the old per-move persistFloatingPosition wrote localStorage on every move, which janked touch drags). Teardown cancels the rAF, releases capture, and detaches listeners on pointerup/cancel and on unmount.
  */
  const handleFloatingDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isFloatingMode || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = floatingPosition;
    const currentSize = floatingSize;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latest = startPosition;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latest = { x: startPosition.x + moveEvent.clientX - startX, y: startPosition.y + moveEvent.clientY - startY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setFloatingPosition(clampTerminalFloatPosition(latest, currentSize));
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      persistFloatingPosition(latest, currentSize);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    // FNXC:Terminal 2026-06-22-19:50: Unmount/close-mid-drag teardown cancels the rAF, releases capture, and detaches the captured-element listeners without persisting a partial move.
    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [floatingPosition, floatingSize, isFloatingMode, persistFloatingPosition]);

  /*
  FNXC:Terminal 2026-06-22-19:50:
  Floating-window edge/corner resize, smooth on touch + desktop. Pointer capture + captured-element listeners filtered by pointerId, rAF-batched size/position updates (west/north handles also shift the origin so the opposite edge stays pinned), persisted once on pointerup — same discipline as the right-dock pop-out resize. The old per-move persistFloatingSize/persistFloatingPosition wrote localStorage on every move; now we set state per frame and persist only on release. Teardown cancels the rAF, releases capture, and detaches listeners on pointerup/cancel and on unmount.
  */
  const handleFloatingResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, direction: TerminalResizeDirection) => {
    if (!isFloatingMode) return;
    event.preventDefault();
    event.stopPropagation();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = floatingSize;
    const startPosition = floatingPosition;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latestSize = startSize;
    let latestPosition = startPosition;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const nextSize = clampTerminalFloatSize({
        width: startSize.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0),
        height: startSize.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0),
      });
      const nextPosition = {
        x: startPosition.x + (direction.includes("w") ? startSize.width - nextSize.width : 0),
        y: startPosition.y + (direction.includes("n") ? startSize.height - nextSize.height : 0),
      };
      latestSize = nextSize;
      latestPosition = nextPosition;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setFloatingSize(latestSize);
        setFloatingPosition(clampTerminalFloatPosition(latestPosition, latestSize));
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      persistFloatingSize(latestSize);
      persistFloatingPosition(latestPosition, latestSize);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    // FNXC:Terminal 2026-06-22-19:50: Unmount/close-mid-drag teardown cancels the rAF, releases capture, and detaches the captured-element listeners without persisting a partial resize.
    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [floatingPosition, floatingSize, isFloatingMode, persistFloatingPosition, persistFloatingSize]);

  /**
   * Fit xterm and publish cols/rows for a specific terminal session.
   *
   * FN-1234 root cause: mobile visualViewport rAF callbacks can fire while
   * tab switching is still re-initializing xterm asynchronously. Without a
   * session guard, stale deferred work can mutate whichever xterm instance is
   * currently in refs, causing the newly active tab to display stale output.
   */
  const fitAndResizeForSession = useCallback((expectedSessionId?: string) => {
    if (expectedSessionId && xtermInitializedRef.current !== expectedSessionId) {
      return;
    }

    const currentFitAddon = fitAddonRef.current;
    const currentXterm = xtermRef.current;
    const currentResize = resizeRef.current;

    if (!currentFitAddon || !currentXterm) {
      return;
    }

    if (expectedSessionId && xtermInitializedRef.current !== expectedSessionId) {
      return;
    }

    /*
    FNXC:Terminal 2026-06-22-22:00:
    On a very narrow folded phone the fold/orientation transition can fire a resize while the xterm container momentarily reports a transient sub-pixel width. We still call fit() (FitAddon no-ops at 0 width, so it can never collapse columns there), but when the container reports a real nonzero width we ALSO schedule one deferred re-fit so the column count re-settles after the fold geometry stabilizes to its final integer box — that deferred pass is what reflows the narrow terminal back to contiguous text instead of the wide-cell "C o p i e d" spaced render. The width probe is read-only and only adds the extra rAF, so jsdom (clientWidth 0) keeps its single synchronous fit and existing tests are unaffected.
    */
    const containerWidth = terminalRef.current?.clientWidth ?? 0;
    if (containerWidth > 0) {
      if (pendingFitRef.current !== null) {
        cancelAnimationFrame(pendingFitRef.current);
      }
      pendingFitRef.current = requestAnimationFrame(() => {
        pendingFitRef.current = null;
        if (
          (!expectedSessionId || xtermInitializedRef.current === expectedSessionId) &&
          fitAddonRef.current &&
          xtermRef.current &&
          (terminalRef.current?.clientWidth ?? 0) > 0
        ) {
          try {
            (fitAddonRef.current as InstanceType<typeof import("@xterm/addon-fit").FitAddon>).fit();
            resizeRef.current?.(xtermRef.current.cols, xtermRef.current.rows);
          } catch {
            // Ignore fit errors during viewport transitions
          }
        }
      });
    }

    try {
      const fitAddon = currentFitAddon as InstanceType<typeof import("@xterm/addon-fit").FitAddon>;
      fitAddon.fit();
      if (currentResize) {
        currentResize(currentXterm.cols, currentXterm.rows);
      }
    } catch {
      // Ignore fit errors during viewport transitions
    }
  }, []);

  // Bump open generation whenever the modal opens so the initialCommand
  // effect re-evaluates after a close/reopen cycle (deps may be identical).
  // FNXC:FloatingWindow 2026-06-22-21:30: Each open also claims the front of the shared floating-window stack so a freshly-opened floating terminal sits above other floating modals.
  useEffect(() => {
    if (isOpen) {
      setOpenGeneration((g) => g + 1);
      setFloatingZ(nextFloatingZ());
    }
  }, [isOpen]);

  // Track virtual keyboard overlap on mobile so the terminal entry area
  // stays visible above the keyboard. On desktop this is a no-op.
  useEffect(() => {
    if (!isOpen || !isMobileDevice()) return;

    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const overlap = getKeyboardOverlap();
      setKeyboardOverlap(overlap);
      // Track the actual visual viewport height for modal sizing.
      // This is more reliable than 100dvh on iOS Safari where
      // the dynamic viewport height behavior varies by browser version.
      setViewportHeight(vv.height);
      // Scroll the modal so the status bar (bottom edge) stays visible
      // when the virtual keyboard pushes the viewport up.
      if (overlap > 0 && modalRef.current?.scrollIntoView) {
        modalRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
      }
      // Re-fit xterm when viewport changes affect available height.
      // The keyboard opening/closing changes the modal's max-height via
      // CSS --keyboard-overlap, so xterm needs to recalculate rows/cols.
      //
      // IMPORTANT: We must defer fitAddon.fit() until AFTER React has
      // committed the state changes above (setKeyboardOverlap, setViewportHeight)
      // and the browser has repainted the new modal dimensions. Without this
      // deferral, fit() measures the OLD (pre-keyboard) container dimensions
      // because React state updates are asynchronous — the inline style with
      // the new --keyboard-overlap / --vv-height values hasn't been applied yet.
      //
      // requestAnimationFrame ensures we run after the next paint, at which
      // point the DOM reflects the updated CSS variables and the modal has
      // its correct constrained height.
      //
      // Coalesce rapid events (keyboard animating open) by cancelling any
      // previously scheduled rAF before scheduling a new one.
      if (pendingFitRef.current !== null) {
        cancelAnimationFrame(pendingFitRef.current);
        pendingFitRef.current = null;
      }
      const scheduledSessionId =
        typeof xtermInitializedRef.current === "string"
          ? xtermInitializedRef.current
          : undefined;
      pendingFitRef.current = requestAnimationFrame(() => {
        pendingFitRef.current = null;
        fitAndResizeForSession(scheduledSessionId);
      });
    };

    update(); // initial measurement
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    /*
    FNXC:Terminal 2026-06-22-22:00:
    Folding/unfolding a foldable phone (and rotating) changes the terminal's available width without always emitting a visualViewport resize at the settled width. Listen to orientationchange too so xterm re-fits to the new narrow/wide column count after the fold completes; the deferred-fit guard in fitAndResizeForSession ensures the fit only lands once the container has a real width.
    */
    window.addEventListener("orientationchange", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
      // Cancel any pending deferred fit
      if (pendingFitRef.current !== null) {
        cancelAnimationFrame(pendingFitRef.current);
        pendingFitRef.current = null;
      }
      setKeyboardOverlap(0);
      setViewportHeight(null);
    };
  }, [fitAndResizeForSession, isOpen]);

  /*
  FNXC:Terminal 2026-06-21-22:07:
  Docked and floating terminal resize interactions change the terminal viewport without a window resize event, so refit xterm after display mode, docked height, or floating size changes to keep rows/cols synchronized.
  */
  useEffect(() => {
    if (!isOpen) return;
    const sessionId = typeof xtermInitializedRef.current === "string" ? xtermInitializedRef.current : undefined;
    const frame = requestAnimationFrame(() => fitAndResizeForSession(sessionId));
    return () => cancelAnimationFrame(frame);
  }, [displayMode, dockedHeight, fitAndResizeForSession, floatingSize, isOpen]);

  // Refit xterm whenever the user drags the modal's CSS resize grip.
  // The window/visualViewport listeners only fire on viewport changes; native
  // `resize: both` does NOT emit window resize, so we observe the modal node
  // directly and ask xterm to refit to the new pixel box.
  useEffect(() => {
    if (!isOpen) return;
    const node = modalRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    let pendingFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        const sessionId =
          typeof xtermInitializedRef.current === "string"
            ? xtermInitializedRef.current
            : undefined;
        fitAndResizeForSession(sessionId);
      });
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    };
  }, [fitAndResizeForSession, isOpen]);

  // Use the session management hook
  const { 
    tabs, 
    activeTab, 
    isReady,
    bootstrapError,
    createTab, 
    closeTab, 
    setActiveTab, 
    updateTabTitle,
    restartActiveTab,
    retryBootstrap,
    replaceActiveTabSession,
  } = useTerminalSessions(projectId);

  // Get the WebSocket connection for the active session
  const { connectionStatus, sendInput, resize, onData, onConnect, onExit, onScrollback, reconnect, onSessionInvalid } = 
    useTerminal(activeTab?.sessionId ?? null, projectId);

  // Keep a ref to resize so the viewport-change effect can call it
  // without needing resize as a dependency (avoids ordering issues).
  resizeRef.current = resize;
  sendInputRef.current = sendInput;

  const updateTerminalPreferences = useCallback((patch: Partial<TerminalPreferences>) => {
    setTerminalPreferences((current) => writeTerminalPreferences({ ...current, ...patch }));
  }, []);

  const setFontSize = useCallback(
    (value: number | ((current: number) => number)) => {
      setTerminalPreferences((current) => {
        const nextFontSize =
          typeof value === "function" ? value(current.fontSize) : value;
        return writeTerminalPreferences({
          ...current,
          fontSize: clampTerminalFontSize(nextFontSize),
        });
      });
    },
    [],
  );

  const resetTerminalPreferences = useCallback(() => {
    setTerminalPreferences(writeTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES));
  }, []);

  const refitTerminal = useCallback(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    try {
      (fitAddonRef.current as InstanceType<typeof FitAddon> | null)?.fit();
      resize(terminal.cols, terminal.rows);
    } catch {
      // Ignore fit errors during viewport transitions.
    }
  }, [resize]);

  const remeasureAfterTerminalFontLoad = useCallback(
    async (
      expectedSessionId: string,
      terminal: XTerm,
      fitAddon: InstanceType<typeof import("@xterm/addon-fit").FitAddon>,
    ) => {
      const fontMetricsSettled = await waitForTerminalFontMetrics(
        fontSizeRef.current,
        resolvedFontFamilyRef.current,
      );

      if (!fontMetricsSettled) {
        return;
      }

      if (
        xtermInitializedRef.current !== expectedSessionId ||
        xtermRef.current !== terminal ||
        fitAddonRef.current !== fitAddon
      ) {
        return;
      }

      try {
        /*
        FNXC:Terminal 2026-06-18-07:23:
        FN-6638 recurrence #4 showed the previous symbols-last stack-order fix was inert: the supplied diagnostic measured AGENTS.md at the same 66.76px for symbols-first, symbols-last, and system-mono stacks while real iOS Safari still widened ASCII cells. xterm measures cell geometry at open() time, so after best-effort FontFaceSet settlement we must always reapply the active preset's font options, fit, resize, and refresh; that invalidates stale DOM/canvas metrics on real iOS when the full shorthand is rejected and keeps desktop WebGL using the same renderer-neutral metric refresh.
        */
        terminal.options.fontFamily = resolvedFontFamilyRef.current;
        terminal.options.fontSize = fontSizeRef.current;
        fitAddon.fit();
        resizeRef.current?.(terminal.cols, terminal.rows);
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      } catch {
        // Ignore fit/refresh errors during teardown or viewport transitions.
      }
    },
    [],
  );

  // Initialize xterm.js when session is ready.
  // Keying this effect by active session id (not full activeTab object) avoids
  // tearing down xterm lifecycle wiring during unrelated tab metadata updates
  // such as title changes.
  useEffect(() => {
    if (!isOpen || !isReady) return;

    const currentSessionId = activeTab?.sessionId;
    if (!currentSessionId) return;

    // Detect project switch: if projectId changed, invalidate xterm even if sessionId is the same.
    // This ensures xterm content from the previous project is not displayed in the new project.
    const projectChanged = previousProjectIdRef.current !== projectId;
    if (projectChanged) {
      previousProjectIdRef.current = projectId;
    }

    // If already initialized for this session AND project hasn't changed, skip
    if (xtermInitializedRef.current === currentSessionId && xtermRef.current && !projectChanged) {
      return;
    }

    // Clean up existing xterm if switching sessions/projects or if DOM was cleared
    if (xtermRef.current && (xtermInitializedRef.current !== currentSessionId || projectChanged)) {
      xtermRef.current.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      xtermInitializedRef.current = false;
      if (windowResizeListenerRef.current) {
        window.removeEventListener("resize", windowResizeListenerRef.current);
        windowResizeListenerRef.current = null;
      }
      setXtermReady(false);
      setXtermInitError(null);
    }

    let mounted = true;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

    const initTerminal = async () => {
      // Dynamically import xterm modules with watchdog timeout
      const importsPromise = retryDynamicImport(() =>
        Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]),
      );

      // Watchdog: reject if imports + setup take too long
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        watchdogTimer = setTimeout(() => {
          reject(new Error("xterm initialization timed out"));
        }, XTERM_INIT_TIMEOUT_MS);
      });

      let terminal: InstanceType<typeof import("@xterm/xterm").Terminal>;
      let fitAddon: InstanceType<typeof import("@xterm/addon-fit").FitAddon>;

      try {
        const [{ Terminal: TerminalCtor }, { FitAddon: FitAddonCtor }, { WebLinksAddon }] =
          await Promise.race([importsPromise, timeoutPromise]);

        if (!mounted || !terminalRef.current || xtermRef.current) return;

        const preferencesAtInit = terminalPreferencesRef.current;
        const fontFamilyAtInit = resolvedFontFamilyRef.current;

        // Create terminal instance
        terminal = new TerminalCtor({
          cursorBlink: preferencesAtInit.cursorBlink,
          cursorStyle: preferencesAtInit.cursorStyle,
          fontSize: preferencesAtInit.fontSize,
          fontFamily: fontFamilyAtInit,
          theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
            cursor: "#d4d4d4",
            selectionBackground: "#264f78",
            black: "#1e1e1e",
            red: "#f48771",
            green: "#4ec9b0",
            yellow: "#dcdcaa",
            blue: "#569cd6",
            magenta: "#c586c0",
            cyan: "#9cdcfe",
            white: "#d4d4d4",
          },
          allowProposedApi: true,
          scrollback: 5000,
        });

        // Load addons
        fitAddon = new FitAddonCtor();
        terminal.loadAddon(fitAddon);

        const webLinksAddon = new WebLinksAddon();
        terminal.loadAddon(webLinksAddon);

        initializedRendererRef.current = preferencesAtInit.renderer;
        // Try to load WebGL addon for better performance.
        //
        // FNXC:Terminal 2026-06-16-23:45:
        // Renderer preference may force canvas by skipping WebGL, but mobile remains a hard WebGL-off floor because WebKit glyph artifacts make terminal prompts unreadable on touch devices.
        if (preferencesAtInit.renderer === "auto" && !isMobileDevice()) {
          try {
            const { WebglAddon } = await import("@xterm/addon-webgl");
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
              webglAddon.dispose();
            });
            terminal.loadAddon(webglAddon);
          } catch {
            // WebGL not available, fallback to canvas
          }
        }

        // Open terminal in container
        terminal.open(terminalRef.current);

        // Clear watchdog — imports and open() succeeded within deadline
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
        }

        // Ensure xterm's textarea receives focus for keyboard input.
        // xterm.js creates a hidden textarea that captures keyboard events.
        // We focus the textarea directly and dispatch a synthetic click on
        // the container to trigger xterm's internal focus tracking.
        const helperTextarea = terminalRef.current?.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | undefined;
        if (helperTextarea) {
          helperTextarea.focus();
        }
        // Dispatch a click event on the xterm container to ensure xterm's
        // internal focus tracking is properly initialized. This is necessary
        // because xterm relies on canvas click events for full focus setup.
        if (terminalRef.current) {
          try {
            terminalRef.current.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
            }));
          } catch {
            // Ignore event dispatch errors in non-browser environments
          }
        }

        // Initial fit
        setTimeout(() => {
          fitAddon.fit();
          // FNXC:Terminal 2026-06-22-22:00: After the first synchronous fit, schedule one deferred re-fit so a terminal opened mid-fold (narrow foldable, where the container width has not settled to its final integer box yet) re-measures columns once layout stabilizes — preventing the collapsed-column spaced-glyph render. Guarded by container width and live session so jsdom/tab-teardown paths stay no-ops.
          if ((terminalRef.current?.clientWidth ?? 0) > 0) {
            requestAnimationFrame(() => {
              if (
                xtermInitializedRef.current === currentSessionId &&
                fitAddonRef.current === fitAddon &&
                (terminalRef.current?.clientWidth ?? 0) > 0
              ) {
                try {
                  fitAddon.fit();
                  resizeRef.current?.(terminal.cols, terminal.rows);
                } catch {
                  // Ignore fit errors during viewport transitions
                }
              }
            });
          }
          // Re-focus after fit in case the DOM changed
          const textarea = terminalRef.current?.querySelector(
            ".xterm-helper-textarea",
          ) as HTMLTextAreaElement | undefined;
          if (textarea) {
            textarea.focus();
          }
        }, 50);

        xtermRef.current = terminal;
        fitAddonRef.current = fitAddon;
        xtermInitializedRef.current = currentSessionId;
        void remeasureAfterTerminalFontLoad(currentSessionId, terminal, fitAddon);

        // If the virtual keyboard opened while xterm was still in async
        // initialization for this tab, force a post-init fit so this new
        // session uses the already-constrained mobile modal height.
        if (keyboardOverlapRef.current > 0) {
          if (pendingFitRef.current !== null) {
            cancelAnimationFrame(pendingFitRef.current);
            pendingFitRef.current = null;
          }
          pendingFitRef.current = requestAnimationFrame(() => {
            pendingFitRef.current = null;
            fitAndResizeForSession(currentSessionId);
          });
        }

        // Wire user input forwarding (xterm → server) once, here, while we
        // still hold a live reference to the freshly-created xterm. Doing
        // this in a separate effect is fragile under StrictMode/Vite Fast
        // Refresh: the effect can re-run and attach a second listener to the
        // same xterm instance, which produces per-character input doubling
        // (every keystroke calls sendInput twice → server pty.write twice →
        // shell echoes the doubled byte → "aabbcc" on screen). Binding here
        // ties the listener's lifetime to the xterm; xterm.dispose() removes
        // it. The handler reads sendInput via a ref so updates to that
        // function don't require re-binding.
        terminal.onData((data) => {
          if (xtermInitializedRef.current !== currentSessionId) return;
          sendInputRef.current(data);
        });

        terminal.attachCustomKeyEventHandler((event) => {
          if (event.type !== "keydown") {
            return true;
          }

          const isModifierPressed = isMacPlatform() ? event.metaKey : event.ctrlKey;
          if (!isModifierPressed || event.altKey || event.shiftKey) {
            return true;
          }

          const key = event.key.toLowerCase();

          if (key === "c") {
            const selection = terminal.hasSelection() ? terminal.getSelection() : "";
            if (!selection) {
              return true;
            }

            navigator.clipboard?.writeText(selection).catch(() => {
              // Ignore clipboard permission/errors so terminal input stays responsive.
            });
            return false;
          }

          if (key === "v") {
            // Let xterm's helper textarea handle paste natively. Reading the
            // clipboard here and also allowing the browser paste path causes
            // duplicate PTY input on Cmd/Ctrl+V.
            return true;
          }

          return true;
        });

        // Window resize listener bound to this xterm. Tracked in a ref so it
        // can be removed when xterm is disposed (modal close, tab switch).
        const resizeHandler = () => {
          if (xtermInitializedRef.current !== currentSessionId) return;
          if (fitAddonRef.current && xtermRef.current) {
            try {
              (fitAddonRef.current as InstanceType<typeof FitAddon>).fit();
              const { cols, rows } = xtermRef.current;
              resizeRef.current?.(cols, rows);
            } catch {
              // Ignore fit errors during viewport transitions.
            }
          }
        };
        window.addEventListener("resize", resizeHandler);
        // Replace any stale listener (defensive: e.g. a previous xterm whose
        // disposal path didn't clear this ref). Removes before re-registering.
        if (windowResizeListenerRef.current) {
          window.removeEventListener("resize", windowResizeListenerRef.current);
        }
        windowResizeListenerRef.current = resizeHandler;

        // Signal that xterm is ready so lifecycle effects can subscribe.
        setXtermReady(true);
        // Clear any prior xterm init error
        setXtermInitError(null);
      } catch (err) {
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
        }
        if (!mounted) return;
        const message = err instanceof Error ? err.message : "xterm initialization failed";
        setXtermInitError(message);
      }
    };

    void initTerminal();

    return () => {
      mounted = false;
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
      }

      // Don't dispose xterm here - it should persist across tab switches
      // Only dispose when the modal is fully closed
    };
  }, [fitAndResizeForSession, isOpen, isReady, activeTab?.sessionId, projectId, remeasureAfterTerminalFontLoad]);

  // (Input forwarding + window resize listener are wired inside initTerminal
  // so they share the xterm instance's lifetime — see comment there.)

  // FNXC:Terminal 2026-06-22-09:00: Run any active drag teardown when the component unmounts mid-drag so document pointer listeners + the pending docked-resize rAF never outlive the modal.
  useEffect(() => () => dragTeardownRef.current?.(), []);

  // Cleanup xterm when modal closes
  useEffect(() => {
    if (isOpen) return;

    // A close mid-drag must also drop the active drag's document listeners + rAF.
    dragTeardownRef.current?.();

    // Modal is closed - cleanup xterm
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
    xtermInitializedRef.current = false;
    if (windowResizeListenerRef.current) {
      window.removeEventListener("resize", windowResizeListenerRef.current);
      windowResizeListenerRef.current = null;
    }
    setXtermReady(false);
    setXtermInitError(null);
    hasInitialCommandRun.current = false;
    pendingInitialCommandRef.current = null;
    creatingInitialCommandTabRef.current = false;
    setError(null);
    setExitCode(null);
    setShowShortcuts(false);
    setShowPreferences(false);
    setStickyModifier(null);
  }, [isOpen]);

  // Subscribe to terminal data.
  // Depends on `xtermReady` so subscriptions are established after the
  // async xterm initialization completes and xtermRef.current is set.
  // Depends on `activeTab?.sessionId` (not just `activeTab?.id`) so that
  // creating a new tab triggers rebinding to the new session's WebSocket
  // callbacks. Without sessionId, the effect would miss session switches
  // that happen within the same modal session.
  useEffect(() => {
    if (!xtermReady || !xtermRef.current || !activeTab) return;

    const expectedSessionId = activeTab.sessionId;
    const writeToExpectedSession = (data: string) => {
      if (xtermInitializedRef.current !== expectedSessionId) {
        return;
      }
      xtermRef.current?.write(data);
    };

    const unsubData = onData((data) => {
      writeToExpectedSession(data);
    });

    const unsubScrollback = onScrollback((data) => {
      writeToExpectedSession(data);
    });

    const unsubConnect = onConnect((info) => {
      // Update tab title with shell name
      updateTabTitle(activeTab.id, getPathBasename(info.shell) || info.shell);
    });

    const unsubExit = onExit((code) => {
      if (xtermInitializedRef.current !== expectedSessionId) {
        return;
      }
      setExitCode(code);
      xtermRef.current?.write(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
    });

    return () => {
      unsubData();
      unsubScrollback();
      unsubConnect();
      unsubExit();
    };
  }, [xtermReady, activeTab?.sessionId, activeTab?.id, activeTab, connectionStatus, onData, onScrollback, onConnect, onExit, updateTabTitle]);

  // Run initial command when connected.
  // Tracks the last command dispatch key so new quick-script invocations can
  // execute immediately without requiring a modal close/reopen.
  //
  // FNXC:Terminal 2026-06-17-00:00:
  // Quick scripts must always spawn a dedicated terminal tab backed by a fresh PTY session, including first-open, already-open, and same-command rerun paths. Never inject a script into the auto-created or currently active shell because that destructively reuses user context.
  //
  // Depends on openGeneration so the command re-fires after close/reopen.
  useEffect(() => {
    if (connectionStatus !== "connected" || !initialCommand || !activeTab) {
      return;
    }

    const commandKey = `${initialCommandGeneration}:${initialCommand}`;

    if (hasInitialCommandRun.current === commandKey) {
      return;
    }

    const pendingCommand = pendingInitialCommandRef.current;
    if (pendingCommand?.commandKey === commandKey || creatingInitialCommandTabRef.current) {
      return;
    }

    hasInitialCommandRun.current = commandKey;

    creatingInitialCommandTabRef.current = true;
    void createTab()
      .then((newTab) => {
        pendingInitialCommandRef.current = {
          command: initialCommand,
          commandKey,
          sessionId: newTab.sessionId,
        };
        setPendingInitialCommandGeneration((generation) => generation + 1);
      })
      .catch((err) => {
        const message = getErrorMessage(err);
        setError(t("terminal.createScriptTabError", "Failed to create terminal tab for script: {{message}}", { message }));
        if (hasInitialCommandRun.current === commandKey) {
          hasInitialCommandRun.current = false;
        }
      })
      .finally(() => {
        creatingInitialCommandTabRef.current = false;
      });
  }, [connectionStatus, initialCommand, initialCommandGeneration, activeTab, createTab, openGeneration, t]);

  useEffect(() => {
    const pendingCommand = pendingInitialCommandRef.current;
    if (
      connectionStatus !== "connected" ||
      !activeTab ||
      !pendingCommand ||
      pendingCommand.sessionId !== activeTab.sessionId
    ) {
      return;
    }

    /*
    FNXC:Terminal 2026-06-18-14:58:
    Quick-script injection must survive the transient connected -> connecting -> connected sequence that happens while the freshly created script tab replaces the previous active PTY session. Keep the pending command until the delay callback actually writes it so effect cleanup can cancel an obsolete timer without dropping the still-valid command.
    */
    const timeout = setTimeout(() => {
      const latestPendingCommand = pendingInitialCommandRef.current;
      if (
        latestPendingCommand?.commandKey !== pendingCommand.commandKey ||
        latestPendingCommand.sessionId !== pendingCommand.sessionId
      ) {
        return;
      }
      pendingInitialCommandRef.current = null;
      sendInputRef.current(pendingCommand.command + "\n");
    }, 500);

    return () => clearTimeout(timeout);
  }, [connectionStatus, activeTab?.sessionId, pendingInitialCommandGeneration]);

  useEffect(() => {
    if (!xtermReady || !xtermRef.current) {
      return;
    }

    /*
    FNXC:Terminal 2026-06-16-23:47:
    Font and cursor preferences apply live to the active xterm so the preferences panel and status-bar zoom controls share one persisted source of truth. Renderer changes are intentionally deferred to the next terminal open because the WebGL addon is attached during xterm initialization.
    */
    xtermRef.current.options.fontFamily = resolvedFontFamily;
    xtermRef.current.options.fontSize = terminalPreferences.fontSize;
    xtermRef.current.options.cursorStyle = terminalPreferences.cursorStyle;
    xtermRef.current.options.cursorBlink = terminalPreferences.cursorBlink;

    // Defer fit until the next frame so layout reflects the new font metrics
    // before FitAddon measures rows/cols. Reuse pendingFitRef so font changes and
    // visualViewport-triggered fits are coalesced into a single scheduled fit.
    if (pendingFitRef.current !== null) {
      cancelAnimationFrame(pendingFitRef.current);
      pendingFitRef.current = null;
    }

    const frame = requestAnimationFrame(() => {
      pendingFitRef.current = null;
      refitTerminal();
    });
    pendingFitRef.current = frame;

    return () => {
      if (pendingFitRef.current === frame) {
        cancelAnimationFrame(frame);
        pendingFitRef.current = null;
      }
    };
  }, [resolvedFontFamily, terminalPreferences, xtermReady, refitTerminal]);

  // Handle keyboard shortcuts (zoom)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;

      // Zoom in: Ctrl/Cmd + Plus
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        setFontSize((current) => clampTerminalFontSize(current + 1));
        return;
      }

      // Zoom out: Ctrl/Cmd + Minus
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        setFontSize((current) => clampTerminalFontSize(current - 1));
        return;
      }

      // Reset zoom: Ctrl/Cmd + 0
      if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        setFontSize(DEFAULT_TERMINAL_PREFERENCES.fontSize);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, setFontSize]);

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Focus terminal when connected
  useEffect(() => {
    if (connectionStatus === "connected" && xtermRef.current) {
      setTimeout(() => {
        if (!xtermRef.current || !terminalRef.current) return;
        // Focus the xterm textarea directly for keyboard input
        const helperTextarea = terminalRef.current.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | undefined;
        if (helperTextarea) {
          helperTextarea.focus();
        }
        // Also dispatch a click to trigger xterm's internal focus tracking
        try {
          terminalRef.current.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          }));
        } catch {
          // Ignore event dispatch errors in non-browser environments
        }
      }, 100);
    }
  }, [connectionStatus]);

  /**
   * On mobile browsers, opening the soft keyboard requires focus to happen
   * within a real user gesture. Programmatic focus in async effects is often
   * ignored even though xterm stays connected and receives output.
   *
   * On touch-primary devices, the CSS sizes `.xterm-helper-textarea` to cover
   * the whole terminal surface (see styles.css @media (hover: none) and
   * (pointer: coarse)), so iOS focuses it natively on tap. Re-focusing and
   * calling setSelectionRange inside the touchstart/pointerdown handler
   * disrupts iOS's input-event attribution (same class of bug the prior
   * capture-phase handlers caused — see commit c7266b7f), and subsequent
   * keystrokes are silently dropped. Early-return on touch-primary so iOS
   * handles focus with no JS interference.
   */
  const handleTerminalGestureFocus = useCallback(() => {
    if (!terminalRef.current) return;

    const isTouchPrimary =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none) and (pointer: coarse)")?.matches === true;
    if (isTouchPrimary) return;

    // Ensure xterm updates its own focus state first.
    xtermRef.current?.focus();

    const helperTextarea = terminalRef.current.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLTextAreaElement | undefined;

    if (!helperTextarea) return;

    // Mobile Safari/Chrome soft keyboard heuristics are stricter than desktop:
    // keep attributes explicit and focus from a direct user gesture.
    helperTextarea.autocapitalize = "off";
    helperTextarea.autocomplete = "off";
    (helperTextarea as unknown as { autocorrect: string }).autocorrect = "off";
    helperTextarea.spellcheck = false;
    helperTextarea.setAttribute("inputmode", "text");

    try {
      helperTextarea.focus({ preventScroll: true });
    } catch {
      helperTextarea.focus();
    }

    // Keep caret at end so subsequent key presses append naturally.
    const caretPos = helperTextarea.value.length;
    helperTextarea.setSelectionRange(caretPos, caretPos);
  }, []);

  /**
   * Auto-recover when the server reports the session is invalid (code 4004).
   *
   * Without this handler the user sees "Disconnected" with a reconnect button
   * that retries the same stale session forever — the only fix was a full page
   * reload. Now we silently create a fresh session on the active tab and let
   * the normal connect effect (useTerminal's sessionId dep) open a new
   * WebSocket to the replacement session.
   */
  useEffect(() => {
    const unsub = onSessionInvalid(() => {
      // Clear terminal display for the fresh session
      xtermRef.current?.clear();
      setExitCode(null);
      hasInitialCommandRun.current = false;

      // Dispose current xterm so the init effect re-runs with the new session
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
      xtermInitializedRef.current = false;
      if (windowResizeListenerRef.current) {
        window.removeEventListener("resize", windowResizeListenerRef.current);
        windowResizeListenerRef.current = null;
      }
      setXtermReady(false);
      setXtermInitError(null);

      replaceActiveTabSession().catch((err) => {
        console.error("Failed to replace invalid terminal session:", err);
      });
    });
    return unsub;
  }, [onSessionInvalid, replaceActiveTabSession]);

  // Overlay dismiss — track mousedown source so a click that starts on the
  // modal but releases on the overlay (e.g. when dragging the resize grip
  // beyond the modal's edge) does NOT dismiss. Native CSS `resize: both`
  // would otherwise let a resize-drag end on the overlay and synthesise a
  // click event whose target is the overlay.
  const handleOverlayMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) overlayMouseDownRef.current = true;
    },
    []
  );
  const handleOverlayMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (overlayMouseDownRef.current && e.target === e.currentTarget) {
        onClose();
      }
      overlayMouseDownRef.current = false;
    },
    [onClose]
  );

  // Handle clear button
  const handleClear = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  // Handle restart - create new session in the current tab
  const handleRestart = useCallback(async () => {
    // Clear terminal display
    xtermRef.current?.clear();
    setExitCode(null);
    hasInitialCommandRun.current = false;
    
    // Restart the active tab's session
    try {
      await restartActiveTab();
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to restart terminal session");
    }
  }, [restartActiveTab]);

  // Reinitialize xterm UI without recreating the session.
  // Used when xterm initialization fails/stalls but the backend session is fine.
  const handleReinitialize = useCallback(() => {
    // Dispose any partially-initialized xterm
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
    xtermInitializedRef.current = false;
    if (windowResizeListenerRef.current) {
      window.removeEventListener("resize", windowResizeListenerRef.current);
      windowResizeListenerRef.current = null;
    }
    // Clear error state and reset readiness so the init effect re-runs
    setXtermInitError(null);
    setXtermReady(false);
  }, []);

  const handleRefreshPage = useCallback(() => {
    window.location.reload();
  }, []);

  const handleIncreaseFontSize = useCallback(() => {
    setFontSize((current) => clampTerminalFontSize(current + 1));
  }, [setFontSize]);

  const handleDecreaseFontSize = useCallback(() => {
    setFontSize((current) => clampTerminalFontSize(current - 1));
  }, [setFontSize]);

  const handleToggleDisplayMode = useCallback(() => {
    setDisplayMode(displayMode === "floating" ? "docked" : "floating");
  }, [displayMode, setDisplayMode]);

  const handlePreferenceFontSizeChange = useCallback(
    (value: string) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }
      setFontSize(parsed);
    },
    [setFontSize],
  );

  /*
  FNXC:Terminal 2026-06-19-05:05:
  FN-6697 root cause: shortcut-bar buttons took browser focus on hardware-keyboard surfaces before their click handlers injected bytes, leaving xterm's helper textarea blurred even though the active session's sendInput path was correct. Preserve focus on mousedown and refocus xterm after every shortcut action so sticky modifiers, literal keys, arrows, and Ctrl-letter shortcuts deliver input without stranding subsequent hardware-keyboard typing across desktop and touch surfaces.

  FNXC:Terminal 2026-06-19-10:38:
  FN-6737 root cause: touch-primary Ctrl shortcuts still allowed the browser's touchstart default action on shortcut buttons, so a tap on sticky Ctrl could move focus away from xterm's helper textarea before the composed Ctrl-letter byte reached the active PTY. Prevent the focus-taking default for mouse and touch activation, then keep the existing xterm refocus path so Ctrl control codes work from the sticky shortcut panel and physical Ctrl key paths on desktop, touch, and touch-with-hardware-keyboard surfaces.
  */
  const preserveShortcutFocus = useCallback(
    (
      event:
        | ReactMouseEvent<HTMLButtonElement>
        | ReactPointerEvent<HTMLButtonElement>
        | ReactTouchEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
    },
    [],
  );

  const refocusTerminalAfterShortcut = useCallback(() => {
    xtermRef.current?.focus();
    handleTerminalGestureFocus();
  }, [handleTerminalGestureFocus]);

  const runShortcutAction = useCallback(
    (action: () => void) => {
      action();
      refocusTerminalAfterShortcut();
    },
    [refocusTerminalAfterShortcut],
  );

  const toggleModifier = useCallback(
    (modifier: "ctrl" | "alt") => {
      runShortcutAction(() => {
        setStickyModifier((current) => (current === modifier ? null : modifier));
      });
    },
    [runShortcutAction],
  );

  const sendShortcutKey = useCallback(
    (key: string) => {
      runShortcutAction(() => {
        if (stickyModifier === "ctrl") {
          sendInput(ctrlChar(key));
          setStickyModifier(null);
          return;
        }

        if (stickyModifier === "alt") {
          sendInput(altChar(key));
          setStickyModifier(null);
          return;
        }

        sendInput(key);
      });
    },
    [runShortcutAction, sendInput, stickyModifier],
  );

  const sendLiteralShortcut = useCallback(
    (value: string) => {
      runShortcutAction(() => {
        sendInput(value);
        setStickyModifier(null);
      });
    },
    [runShortcutAction, sendInput],
  );

  if (!isOpen) return null;

  const getStatusIndicator = () => {
    switch (connectionStatus) {
      case "connected":
        return <span className="terminal-status connected" title={t("terminal.statusConnected", "Connected")} />;
      case "connecting":
      case "reconnecting":
        return <span className="terminal-status connecting" title={t("terminal.statusConnecting", "Connecting...")} />;
      case "disconnected":
        return <span className="terminal-status disconnected" title={t("terminal.statusDisconnected", "Disconnected")} />;
      default:
        return null;
    }
  };

  // Determine loading state for session bootstrap only.
  // Once a tab exists we keep the xterm container visible while UI init runs,
  // avoiding a retry-loop spinner flash after bootstrap recovery.
  const isLoading = !isReady || (!activeTab && !bootstrapError);
  // FNXC:Terminal 2026-06-23-04:30: Always carry the base `terminal-modal-overlay` class so the no-dim/no-blur rule applies in EVERY mode (docked, floating, AND the mobile/default sheet that is neither) — the terminal must never dim the page behind it.
  const overlayClassName = `modal-overlay open terminal-modal-overlay${isDockedMode ? " terminal-modal-overlay--docked" : ""}${isFloatingMode ? " terminal-modal-overlay--floating" : ""}`;
  const modalClassName = `modal terminal-modal${isDockedMode ? " terminal-modal--docked" : ""}${isFloatingMode ? " terminal-modal--floating" : ""}`;
  const modalStyle = {
    ...(keyboardOverlap > 0
      ? {
          "--keyboard-overlap": `${keyboardOverlap}px`,
          // On mobile with keyboard open, constrain to visualViewport height
          // so the modal (including status bar) fits entirely above the keyboard.
          // This is more reliable than 100dvh which behaves differently
          // across Chrome Android vs iOS Safari.
          "--vv-height": viewportHeight ? `${viewportHeight}px` : undefined,
        }
      : {}),
    ...(isDockedMode ? { "--terminal-docked-height": `${dockedHeight}px` } : {}),
    ...(isFloatingMode
      ? {
          "--terminal-float-x": `${floatingPosition.x}px`,
          "--terminal-float-y": `${floatingPosition.y}px`,
          "--terminal-float-width": `${floatingSize.width}px`,
          "--terminal-float-height": `${floatingSize.height}px`,
          // FNXC:FloatingWindow 2026-06-22-21:30: Inline z from the shared cross-type stack; only the floating panel participates.
          zIndex: floatingZ,
        }
      : {}),
  } as CSSProperties;

  // FNXC:FloatingWindow 2026-06-22-22:30: Portaled to document.body so the terminal shares the ONE root stacking context with the other floating modals; the shared cross-type z stack only orders correctly when all panels live at the document root. Docked/floating/mobile are all position:fixed, so portaling does not change their placement.
  return createPortal(
    <div
      className={overlayClassName}
      onMouseDown={handleOverlayMouseDown}
      onMouseUp={handleOverlayMouseUp}
      role="dialog"
      aria-modal="true"
      data-testid="terminal-modal-overlay"
      style={{
        // FNXC:FloatingWindow 2026-06-22-23:00: In floating mode the z-index lives on the fixed overlay (it owns the stacking context); a panel z is trapped inside it and loses to page stacking contexts like the right dock (position:absolute z-index:20). Docked/mobile keep their CSS z.
        ...(isFloatingMode ? { zIndex: floatingZ } : {}),
        ...(keyboardOverlap > 0 ? { "--overlay-padding-top": "0px" } : {}),
      } as CSSProperties}
    >
      <div
        ref={modalRef}
        className={modalClassName}
        data-testid="terminal-modal"
        style={modalStyle}
        onPointerDownCapture={isFloatingMode ? bringFloatingToFront : undefined}
        onFocusCapture={isFloatingMode ? bringFloatingToFront : undefined}
      >
        {isDockedMode && (
          <div
            className="terminal-docked-resize-handle"
            data-testid="terminal-docked-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("terminal.resizeDockedPanel", "Resize terminal panel")}
            onPointerDown={handleDockedResizePointerDown}
          />
        )}
        {isFloatingMode && TERMINAL_RESIZE_DIRECTIONS.map((direction) => (
          <div
            key={direction}
            className={`terminal-floating-resize-handle terminal-floating-resize-handle--${direction}`}
            data-testid={`terminal-floating-resize-${direction}`}
            role="separator"
            aria-label={t("terminal.resizeFloatingPanel", "Resize terminal window")}
            onPointerDown={(event) => handleFloatingResizePointerDown(event, direction)}
          />
        ))}
        {/* Header — on mobile (≤768px) keep tabs and actions on one row;
            .terminal-title is hidden; action button labels are hidden (icons only) */}
        <div className={`terminal-header${isFloatingMode ? " terminal-header--draggable" : ""}`} onPointerDown={handleFloatingDragPointerDown}>
          {/* Tab Bar */}
          <div className="terminal-tabs" data-testid="terminal-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`terminal-tab ${tab.isActive ? "terminal-tab--active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.title}
                role="tab"
                aria-selected={tab.isActive}
              >
                <span className="terminal-tab-label">{tab.title}</span>
                {tabs.length > 1 && (
                  <button
                    className="terminal-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    title={t("terminal.closeTab", "Close tab")}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              className="terminal-tab terminal-tab--new"
              onClick={createTab}
              title={t("terminal.newTerminal", "New terminal")}
            >
              +
            </button>
          </div>
          
          {/* Status indicator */}
          <div className="terminal-title" data-testid="terminal-title">
            <TerminalIcon size={16} />
            {getStatusIndicator()}
          </div>
          
          {/* Actions — labels hidden on mobile via .terminal-action-label */}
          <div className="terminal-actions" data-testid="terminal-actions">
            {connectionStatus === "disconnected" && activeTab && (
              <button
                className="terminal-reconnect-btn"
                onClick={reconnect}
                title={t("terminal.reconnect", "Reconnect")}
                data-testid="terminal-reconnect-btn"
              >
                <RefreshCw size={14} />
                <span className="terminal-action-label">{t("terminal.reconnect", "Reconnect")}</span>
              </button>
            )}
            {exitCode !== null && (
              <button
                className="terminal-restart-btn"
                onClick={handleRestart}
                title={t("terminal.newSession", "New Session")}
                data-testid="terminal-restart-btn"
              >
                <RefreshCw size={14} />
                <span className="terminal-action-label">{t("terminal.newSession", "New Session")}</span>
              </button>
            )}
            {/*
            FNXC:Terminal 2026-06-23-00:15:
            Clear / Shortcuts / Preferences moved OUT of the header actions and DOWN into the bottom status bar (footer) next to the text-size control, so the header keeps only contextual reconnect/restart, the icon-only pop-out toggle, and close.
            The pop-out/dock toggle is now ICON-ONLY (no visible "Pop out"/"Dock" text); the icon flips and the title/aria-label still announce the toggle target for accessibility.
            */}
            {!isMobileTerminal && (
              <button
                className="terminal-clear-btn terminal-clear-btn--shortcut terminal-clear-btn--icon"
                onClick={handleToggleDisplayMode}
                data-testid="terminal-popout-toggle"
                title={displayMode === "floating" ? t("terminal.dockTerminal", "Dock terminal") : t("terminal.popOutTerminal", "Pop out terminal")}
                aria-label={displayMode === "floating" ? t("terminal.dockTerminal", "Dock terminal") : t("terminal.popOutTerminal", "Pop out terminal")}
                aria-pressed={displayMode === "floating"}
              >
                {displayMode === "floating" ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
            <button
              className="terminal-close"
              onClick={onClose}
              data-testid="terminal-close-btn"
              title={t("terminal.closeTerminal", "Close terminal")}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="terminal-error" data-testid="terminal-error">
            {error}
          </div>
        )}

        {/* Terminal container */}
        <div className="terminal-container" data-testid="terminal-container">
          {isLoading && !bootstrapError && (
            <div className="terminal-loading" data-testid="terminal-loading">
              <div className="terminal-spinner" />
              <span>{t("terminal.startingTerminal", "Starting terminal...")}</span>
            </div>
          )}
          {bootstrapError && !activeTab && (
            <div className="terminal-loading" data-testid="terminal-bootstrap-error">
              <div className="terminal-error-content">
                <span>{t("terminal.failedToStartTerminal", "Failed to start terminal: {{error}}", { error: bootstrapError })}</span>
                <div className="terminal-error-actions">
                  <button
                    className="terminal-retry-btn"
                    onClick={retryBootstrap}
                    data-testid="terminal-retry-btn"
                  >
                    <RefreshCw size={14} />
                    {t("actions.retry", "Retry")}
                  </button>
                  <button
                    className="terminal-retry-btn"
                    onClick={handleRefreshPage}
                    data-testid="terminal-bootstrap-refresh-btn"
                  >
                    <RefreshCw size={14} />
                    {t("terminal.refreshPage", "Refresh page")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {xtermInitError && activeTab && (
            <div className="terminal-loading" data-testid="terminal-xterm-init-error">
              <div className="terminal-error-content">
                <span>{t("terminal.initializeError", "Terminal UI failed to initialize: {{error}}", { error: xtermInitError })}</span>
                <div className="terminal-error-actions">
                  <button
                    className="terminal-retry-btn"
                    onClick={handleReinitialize}
                    data-testid="terminal-reinit-btn"
                  >
                    <RefreshCw size={14} />
                    {t("terminal.reinitialize", "Reinitialize")}
                  </button>
                  <button
                    className="terminal-retry-btn"
                    onClick={handleRefreshPage}
                    data-testid="terminal-xterm-refresh-btn"
                  >
                    <RefreshCw size={14} />
                    {t("terminal.refreshPage", "Refresh page")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/*
            Always render the xterm container (no display:none) so that
            terminal.open() can measure its dimensions even during a tab switch.
            The loading overlay (position: absolute) visually covers it until
            xterm is ready. Use key={sessionId} to force a clean DOM remount
            when switching tabs — this prevents stale xterm state from the
            previous session.
          */}
          <div
            key={activeTab?.sessionId}
            ref={terminalRef}
            className="terminal-xterm"
            data-testid="terminal-xterm"
            style={terminalGlyphStyle}
            onPointerDown={handleTerminalGestureFocus}
            onTouchStart={handleTerminalGestureFocus}
          />
        </div>

        {showShortcuts && (
          <div className="terminal-shortcut-panel" data-testid="terminal-shortcut-panel">
            <div className="terminal-shortcut-modifier-row">
              <button
                type="button"
                className={`terminal-shortcut-btn terminal-shortcut-btn--modifier ${
                  stickyModifier === "ctrl" ? "is-active" : ""
                }`}
                data-testid="terminal-modifier-ctrl"
                onPointerDown={preserveShortcutFocus}
                onMouseDown={preserveShortcutFocus}
                onTouchStart={preserveShortcutFocus}
                onClick={() => toggleModifier("ctrl")}
                aria-pressed={stickyModifier === "ctrl"}
              >
                {TERMINAL_KEY_LABELS.ctrl}
              </button>
              <button
                type="button"
                className={`terminal-shortcut-btn terminal-shortcut-btn--modifier ${
                  stickyModifier === "alt" ? "is-active" : ""
                }`}
                data-testid="terminal-modifier-alt"
                onPointerDown={preserveShortcutFocus}
                onMouseDown={preserveShortcutFocus}
                onTouchStart={preserveShortcutFocus}
                onClick={() => toggleModifier("alt")}
                aria-pressed={stickyModifier === "alt"}
              >
                {TERMINAL_KEY_LABELS.alt}
              </button>
              <button
                type="button"
                className="terminal-shortcut-btn"
                onPointerDown={preserveShortcutFocus}
                onMouseDown={preserveShortcutFocus}
                onTouchStart={preserveShortcutFocus}
                onClick={() => sendLiteralShortcut("\x1b")}
              >
                {TERMINAL_KEY_LABELS.escape}
              </button>
              <button
                type="button"
                className="terminal-shortcut-btn"
                onPointerDown={preserveShortcutFocus}
                onMouseDown={preserveShortcutFocus}
                onTouchStart={preserveShortcutFocus}
                onClick={() => sendLiteralShortcut("\t")}
              >
                {TERMINAL_KEY_LABELS.tab}
              </button>
            </div>
            {/*
            FNXC:Terminal 2026-06-16-23:38:
            Touch users need literal ANSI arrow sequences for shell history and cursor movement. These shortcuts bypass sticky Ctrl/Alt modifiers so mobile navigation matches physical keyboard arrow keys exactly.
            */}
            <div className="terminal-shortcut-arrow-row" aria-label={t("terminal.arrowKeysLabel", "Terminal arrow keys")}>
              {ARROW_SHORTCUT_KEYS.map((arrow) => (
                <button
                  key={arrow.testId}
                  type="button"
                  className="terminal-shortcut-btn"
                  data-testid={arrow.testId}
                  aria-label={arrow.ariaLabel}
                  onPointerDown={preserveShortcutFocus}
                  onMouseDown={preserveShortcutFocus}
                  onTouchStart={preserveShortcutFocus}
                  onClick={() => sendLiteralShortcut(arrow.sequence)}
                >
                  {arrow.label}
                </button>
              ))}
            </div>
            {SHORTCUT_KEYS.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                className="terminal-shortcut-btn"
                onPointerDown={preserveShortcutFocus}
                onMouseDown={preserveShortcutFocus}
                onTouchStart={preserveShortcutFocus}
                onClick={() => sendShortcutKey(shortcut.key)}
                title={shortcut.description}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        )}

        {showPreferences && (
          <div className="terminal-preferences-panel" data-testid="terminal-preferences-panel">
            <label className="terminal-preference-field">
              <span>{t("terminal.preferenceFontFamily", "Font family")}</span>
              <select
                className="input terminal-preference-control"
                data-testid="terminal-preference-font-family"
                value={terminalPreferences.fontFamily}
                onChange={(event) =>
                  updateTerminalPreferences({
                    fontFamily: event.target.value as TerminalPreferences["fontFamily"],
                  })
                }
              >
                {TERMINAL_FONT_FAMILY_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="terminal-preference-field">
              <span>{t("terminal.preferenceFontSize", "Font size")}</span>
              <input
                className="input terminal-preference-control"
                data-testid="terminal-preference-font-size"
                type="number"
                min={MIN_TERMINAL_FONT_SIZE}
                max={MAX_TERMINAL_FONT_SIZE}
                value={terminalPreferences.fontSize}
                onChange={(event) => handlePreferenceFontSizeChange(event.target.value)}
              />
            </label>
            <label className="terminal-preference-field">
              <span>{t("terminal.preferenceCursorStyle", "Cursor style")}</span>
              <select
                className="input terminal-preference-control"
                data-testid="terminal-preference-cursor-style"
                value={terminalPreferences.cursorStyle}
                onChange={(event) =>
                  updateTerminalPreferences({
                    cursorStyle: event.target.value as TerminalPreferences["cursorStyle"],
                  })
                }
              >
                <option value="block">{t("terminal.cursorBlock", "Block")}</option>
                <option value="underline">{t("terminal.cursorUnderline", "Underline")}</option>
                <option value="bar">{t("terminal.cursorBar", "Bar")}</option>
              </select>
            </label>
            <label className="terminal-preference-field terminal-preference-field--checkbox">
              <input
                data-testid="terminal-preference-cursor-blink"
                type="checkbox"
                checked={terminalPreferences.cursorBlink}
                onChange={(event) =>
                  updateTerminalPreferences({ cursorBlink: event.target.checked })
                }
              />
              <span>{t("terminal.preferenceCursorBlink", "Blink cursor")}</span>
            </label>
            <label className="terminal-preference-field">
              <span>{t("terminal.preferenceRenderer", "Renderer")}</span>
              <select
                className="input terminal-preference-control"
                data-testid="terminal-preference-renderer"
                value={terminalPreferences.renderer}
                onChange={(event) =>
                  updateTerminalPreferences({
                    renderer: event.target.value as TerminalPreferences["renderer"],
                  })
                }
              >
                <option value="auto">{t("terminal.rendererAuto", "Auto (WebGL on desktop)")}</option>
                <option value="canvas">{t("terminal.rendererCanvas", "Canvas/DOM")}</option>
              </select>
              {xtermReady && terminalPreferences.renderer !== initializedRendererRef.current && (
                <span className="terminal-preference-note" data-testid="terminal-renderer-reopen-note">
                  {t("terminal.rendererReopenNote", "Reopen the terminal to apply renderer changes.")}
                </span>
              )}
            </label>
            <button
              type="button"
              className="btn terminal-preferences-reset"
              data-testid="terminal-preferences-reset"
              onClick={resetTerminalPreferences}
            >
              {t("terminal.resetPreferences", "Reset to defaults")}
            </button>
          </div>
        )}

        {/*
        FNXC:Terminal 2026-06-23-00:15:
        Footer is laid out left-to-right as a flex row: the text-size control sits at the LEFT, followed by the relocated Clear / Shortcuts / Preferences action buttons (a grouped cluster). The connection-status text and zoom-hint copy stay on the right and collapse first on narrow widths. The whole control cluster wraps/scrolls when the footer is too narrow so docked/floating/mobile layouts never clip the buttons.
        */}
        <div className="terminal-status-bar" data-testid="terminal-status-bar">
          <span className="terminal-font-size-controls">
            <button
              type="button"
              className="terminal-font-size-btn"
              onClick={handleDecreaseFontSize}
              data-testid="terminal-font-size-decrease"
              aria-label={t("terminal.decreaseFontSize", "Decrease terminal font size")}
            >
              <Minus size={14} />
            </button>
            <span className="terminal-font-size-value" data-testid="terminal-font-size-value">
              {fontSize}{TERMINAL_KEY_LABELS.pxUnit}
            </span>
            <button
              type="button"
              className="terminal-font-size-btn"
              onClick={handleIncreaseFontSize}
              data-testid="terminal-font-size-increase"
              aria-label={t("terminal.increaseFontSize", "Increase terminal font size")}
            >
              <Plus size={14} />
            </button>
          </span>
          {/* FNXC:Terminal 2026-06-23-00:15: Clear / Shortcuts / Preferences relocated here from the header actions; same handlers, testids, and labels preserved. */}
          <span className="terminal-footer-actions" data-testid="terminal-footer-actions">
            <button
              className="terminal-clear-btn"
              onClick={handleClear}
              data-testid="terminal-clear-btn"
              title={t("terminal.clearTerminal", "Clear terminal")}
            >
              <Trash2 size={14} />
              <span className="terminal-action-label">{t("terminal.clear", "Clear")}</span>
            </button>
            <button
              className="terminal-clear-btn terminal-clear-btn--shortcut"
              onClick={() => setShowShortcuts((current) => !current)}
              data-testid="terminal-shortcut-toggle"
              title={t("terminal.shortcuts", "Shortcuts")}
              aria-pressed={showShortcuts}
            >
              <Keyboard size={14} />
              <span className="terminal-action-label">{t("terminal.shortcuts", "Shortcuts")}</span>
            </button>
            <button
              className="terminal-clear-btn terminal-clear-btn--shortcut"
              onClick={() => setShowPreferences((current) => !current)}
              data-testid="terminal-preferences-toggle"
              title={t("terminal.preferences", "Preferences")}
              aria-pressed={showPreferences}
            >
              <Settings size={14} />
              <span className="terminal-action-label">{t("terminal.preferences", "Preferences")}</span>
            </button>
          </span>
          <span className={`terminal-connection-status ${connectionStatus}`}>
            {connectionStatus === "connected" && t("terminal.statusConnected", "Connected")}
            {connectionStatus === "connecting" && t("terminal.statusConnecting", "Connecting...")}
            {connectionStatus === "reconnecting" && t("terminal.statusReconnecting", "Reconnecting...")}
            {connectionStatus === "disconnected" && t("terminal.statusDisconnected", "Disconnected")}
          </span>
          {exitCode !== null && (
            <span className="terminal-exit-code" data-testid="terminal-exit-code">
              {t("terminal.exitLabel", "Exit: {{code}}", { code: exitCode })}
            </span>
          )}
          <span className="terminal-shortcuts">
            {t("terminal.helpText", "Ctrl++/- zoom • ⌨ Shortcuts panel • Esc close")}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
