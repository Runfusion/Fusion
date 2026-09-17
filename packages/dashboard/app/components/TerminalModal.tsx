import "./TerminalModal.css";
import { createPortal } from "react-dom";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import {
  Trash2,
  Terminal as TerminalIcon,
  RefreshCw,
  Minus,
  Plus,
  Keyboard,
  Settings,
  ChevronDown,
  FolderGit2,
  FolderRoot,
  History,
} from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { useTerminalSessions } from "../hooks/useTerminalSessions";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { getViewportMode, isMobileViewport } from "../hooks/useViewportMode";
import { useDrawerDismissGesture } from "../hooks/useDrawerDismissGesture";
import { FloatingWindow, FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT } from "./FloatingWindow";
import type { FloatingWindowDragGestureEnd, FloatingWindowDragHandoff } from "./FloatingWindow";
import { FLOATING_WINDOW_DRAG_THRESHOLD_PX } from "./floatingWindowGeometry";
import { DashboardWindowSurfaceRoot } from "../context/DashboardWindowManagerContext";
import { ModalCloseButton } from "./ModalCloseButton";
import { ViewDrawerHandle, resolveDrawerPresentation } from "./ViewDrawer";
import { ViewLayoutContent, ViewLayoutFooter, ViewLayoutHeader } from "./ViewLayout";
import { currentFloatingZ, nextFloatingZ } from "./floatingWindowStack";
import { useConfirm } from "../hooks/useConfirm";
import { getPathBasename } from "../utils/pathDisplay";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  MAX_TERMINAL_CUSTOM_SHORTCUTS,
  MAX_TERMINAL_CUSTOM_SHORTCUT_LABEL_LENGTH,
  MAX_TERMINAL_CUSTOM_SHORTCUT_VALUE_LENGTH,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_FAMILY_PRESETS,
  clampTerminalFontSize,
  createTerminalCustomShortcutId,
  decodeTerminalShortcutSequence,
  forceTerminalFontRemeasure,
  normalizeTerminalCustomShortcuts,
  readTerminalPreferences,
  resolveTerminalFontFamily,
  resolveTerminalGlyphFontFamily,
  waitForTerminalFontMetrics,
  withDomBasedTerminalCharacterMeasurement,
  writeTerminalPreferences,
  type TerminalCustomShortcut,
  type TerminalPreferences,
  type TerminalRenderer,
} from "../utils/terminalPreferences";
import "@xterm/xterm/css/xterm.css";

import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/** Timeout for xterm.js dynamic imports + terminal.open() setup. */
const XTERM_INIT_TIMEOUT_MS = 10000;

const XTERM_IMPORT_RETRY_DELAYS_MS = [500, 1500, 3000] as const;

/*
FNXC:Terminal 2026-07-26-11:05:
Mobile browsers (iOS Safari tab, iOS installed PWA, Chrome Android) DISCARD a backgrounded tab when its resident set is large, and the user then pays a full white-splash reload on return. xterm's scrollback ring is retained verbatim in JS memory (line buffers, not just rendered rows), so this ring x a wide viewport is one of the larger single allocations the dashboard holds. That made 2000 lines look like a free win.

FNXC:Terminal 2026-07-26-14:05 (CORRECTION — do not restore the 2000-line value on the old reasoning):
The 2000-line cut above was justified with "the PTY's own server-side scrollback is replayed on reconnect anyway, so the reachable history is unchanged". THAT WAS FALSE. The server ring is `MAX_SCROLLBACK_SIZE = 50000` in `packages/dashboard/src/terminal-service.ts`, and the unit is CHARACTERS, not lines: the buffer is a plain string that is `slice(-50000)`d on every append, and `server.ts` replays exactly that truncated string on reconnect. 50000 characters is only ~600-800 typical terminal lines — the server holds STRICTLY LESS history than even the 2000-line client ring, so it can never back-stop it.
Consequence of the false claim: a build emitting ~4000 lines used to let the user scroll back to the first compile error; at 2000 lines that error was evicted from the client ring and unreachable from the server too. Restored to the pre-cut 5000.
This ring is therefore the AUTHORITATIVE user-reachable history for this surface, not a local cache of something the server also has. Any future reduction has to be argued against 50000 characters of server replay, not against an imagined larger server buffer.
Keep this value in step with SessionTerminal's TERMINAL_SCROLLBACK_LINES (duplicated rather than shared so neither terminal surface pulls the other's heavy module into its lazy chunk). Note the two surfaces have DIFFERENT server rings — the CLI-agent one is 512 KiB — so they are kept in step for maintenance, not because the backing store is the same.
The WebGL-context disposal in disposeXtermInstance is the part of the memory work that was sound; it stays.
*/
const TERMINAL_SCROLLBACK_LINES = 5000;

/*
FNXC:TerminalLayout 2026-09-15-07:57:
FN-409 reduces the non-mobile terminal to exactly two presentations: pinned (`below`, in flow above the
fixed bottom bar, the DEFAULT) and detached (`floating`). The legacy `docked` overlay presentation and its
pin/unpin toggle are removed; a stored `"docked"` value is normalized to `"below"` on read.
*/
export type TerminalDisplayMode = "floating" | "below";

export const TERMINAL_DISPLAY_MODE_STORAGE_PREFIX = "fusion:terminal-display-mode-";

/*
FNXC:TerminalLayout 2026-09-15-21:04:
FN-434 makes the pinned panel a FIXED height. Its top grip is now a DETACH gesture (see
`handlePinnedDetachPointerDown`), so there is no resize gesture left to invert: the retired
`startHeight + (moveEvent.clientY - startY)` formula grew the panel when the operator dragged a TOP-edge
grip DOWNWARD, which is the reported "resizing feels reversed" symptom. The fixed value is slightly taller
than the old 260px default because the panel can no longer be enlarged by hand.
*/
const TERMINAL_BELOW_FIXED_HEIGHT = 360;
const TERMINAL_BELOW_APP_MIN_HEIGHT = 320;

/*
FNXC:TerminalLayout 2026-09-15-21:04:
FN-434: the only remaining height computation is a VIEWPORT guard rail (never a user gesture) so a short
viewport still leaves the application usable above the pinned panel.
*/
function resolveTerminalBelowHeight(): number {
  if (typeof window === "undefined") return TERMINAL_BELOW_FIXED_HEIGHT;
  const maxHeight = Math.max(0, window.innerHeight - TERMINAL_BELOW_APP_MIN_HEIGHT);
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) return TERMINAL_BELOW_FIXED_HEIGHT;
  return Math.min(TERMINAL_BELOW_FIXED_HEIGHT, maxHeight);
}

/*
FNXC:TerminalLayout 2026-09-15-21:04:
FN-434: a drag on the pinned grip must travel past this threshold before it detaches, so a plain click on the
grip leaves the terminal pinned.

FNXC:TerminalLayout 2026-09-15-22:32:
FN-438: the pinned HEADER is now the primary detach handle (the 12px grip alone was almost unhittable, and the
operator reported that dragging the title bar upward did nothing). Pinned detach and floating drag are therefore
the SAME gesture on the SAME element — `.terminal-header`, which the floating presentation already names through
`dragHandleSelector` — so the threshold is the shared `FLOATING_WINDOW_DRAG_THRESHOLD_PX` rather than a second,
larger terminal-local value that made the two presentations feel inconsistent.
*/
const TERMINAL_DETACH_DRAG_THRESHOLD_PX = FLOATING_WINDOW_DRAG_THRESHOLD_PX;

/*
FNXC:TerminalLayout 2026-09-15-21:04:
FN-434 re-pin contact geometry: `TERMINAL_REPIN_CONTACT_PX` is the contact tolerance between the window's bottom
edge and the footer line.

FNXC:TerminalLayout 2026-09-15-22:32:
FN-438 retires `EXECUTOR_FOOTER_HEIGHT_PX` and `TERMINAL_REPIN_MOVE_MIN_PX` with the DOM-measuring re-pin
listener that owned them: the contact line and the "did it actually move" fact now both arrive from
`FloatingWindow`'s validated `onDragGestureEnd` payload.
*/
const TERMINAL_REPIN_CONTACT_PX = 24;

/*
FNXC:TerminalLayout 2026-09-15-22:32:
FN-438: a press on a real control inside the pinned header must activate that control, never start a detach.
This is deliberately the SAME selector `FloatingWindow.handleDragPointerDown` uses, so the pinned and floating
presentations suppress exactly the same targets.
*/
const TERMINAL_HEADER_INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [contenteditable=\"true\"], [role=\"button\"], [role=\"link\"]";
/*
FNXC:TerminalLayout 2026-09-15-07:57:
FN-409: the detached terminal opens at the same standard window size as a task pop-out and a detached chat.
The value is duplicated here rather than imported so this change never collides with the shared geometry module.
*/
/*
FNXC:TerminalLayout 2026-09-16-18:31:
FN-469: the pinned title bar spans the whole work area while the detached window is `TERMINAL_FLOAT_DEFAULT_WIDTH`
wide, so "leave the window exactly under my mouse" means keeping the pointer at the same PROPORTION of the bar, not
at the same pixel offset. The vertical offset is taken literally from the bar, since both bars have the same height.
An unmeasurable header (jsdom, or a panel not painted yet) returns `undefined` so `resolveHandoffRect` applies its
shared centred fallback instead of a fabricated point.
*/
function resolvePinnedGrabOffset(headerRect: DOMRect | undefined, pointerX: number, pointerY: number): { x: number; y: number } | undefined {
  if (!headerRect || !Number.isFinite(headerRect.width) || headerRect.width <= 0) return undefined;
  if (!Number.isFinite(headerRect.left) || !Number.isFinite(headerRect.top)) return undefined;
  const ratio = Math.min(Math.max((pointerX - headerRect.left) / headerRect.width, 0), 1);
  const height = Number.isFinite(headerRect.height) ? Math.max(0, headerRect.height) : 0;
  return {
    x: ratio * TERMINAL_FLOAT_DEFAULT_WIDTH,
    y: Math.min(Math.max(pointerY - headerRect.top, 0), height),
  };
}

const TERMINAL_FLOAT_DEFAULT_WIDTH = 800;
const TERMINAL_FLOAT_DEFAULT_HEIGHT = 680;
const TERMINAL_FLOAT_MIN_WIDTH = 480;
const TERMINAL_FLOAT_MIN_HEIGHT = 320;

interface TerminalWorkspaceMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function terminalDisplayModeStorageKey(projectId?: string): string {
  return `${TERMINAL_DISPLAY_MODE_STORAGE_PREFIX}${projectId ?? "default"}`;
}

/*
FNXC:TerminalLayout 2026-09-15-07:57:
FN-409: terminal display mode stays a project-scoped, reversible layout preference, but the pinned presentation
is now the default. Missing storage, the retired `"docked"` legacy value, and any invalid value all resolve to
`"below"` WITHOUT writing back at load time, so an operator who never touched the control gets the pinned terminal.
*/
export function readTerminalDisplayMode(projectId?: string): TerminalDisplayMode {
  if (typeof window === "undefined") return "below";
  const value = window.localStorage.getItem(terminalDisplayModeStorageKey(projectId));
  return value === "floating" ? "floating" : "below";
}

function writeTerminalDisplayMode(mode: TerminalDisplayMode, projectId?: string): TerminalDisplayMode {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(terminalDisplayModeStorageKey(projectId), mode);
  }
  return mode;
}

/*
FNXC:TerminalLayout 2026-09-15-21:04:
FN-434 removed the pinned-panel resize gesture, so the `fusion:terminal-docked-height-<projectId>` preference has
no writer and no reader left. A legacy stored value is simply ignored — never migrated, never deleted.
*/

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

/** Effective viewport width for terminal mobile decisions. */
function getTerminalViewportWidth(hasTouchScreen = false): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  const layoutWidth = window.innerWidth;
  const visualWidth = window.visualViewport?.width;
  if (hasTouchScreen && typeof visualWidth === "number" && visualWidth > 0) {
    return Math.min(layoutWidth, visualWidth);
  }
  return layoutWidth;
}

/** Whether the current device is likely mobile (touch-primary, small viewport). */
function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isNarrow = getTerminalViewportWidth(hasTouchScreen) <= 768;
  return hasTouchScreen && isNarrow;
}

function isTerminalMobileViewport(): boolean {
  /*
  FNXC:TerminalModalControls 2026-07-24-12:30:
  The global terminal must use the canonical viewport contract rather than a terminal-local
  visual-height shortcut. A software keyboard can shrink a tablet below the phone landscape
  height without changing its physical screen, so it must retain docked/floating move and resize
  controls. Canonical detection still makes true narrow phones, short phone landscapes, and folded
  touch panes full-screen while preserving stored tablet/desktop geometry through transitions.
  */
  return isMobileViewport();
}

interface TabsOverflowMeasurement {
  scrollWidth: number;
  clientWidth: number;
  currentlyOverflowing?: boolean;
}

const TERMINAL_TABS_OVERFLOW_HYSTERESIS = 1;

/*
FNXC:TerminalTabs 2026-07-11-20:28:
FN-7829 treats terminal tab collapse as a container-width decision, not a viewport breakpoint. Collapse only after content exceeds the available tab region by a small hysteresis gap, and expand as soon as the strip fits again so narrow floated/docked desktop panels can use the mobile-style dropdown without changing mobile behavior.
*/
export function evaluateTabsOverflow({ scrollWidth, clientWidth, currentlyOverflowing = false }: TabsOverflowMeasurement): boolean {
  if (clientWidth <= 0) return false;
  return currentlyOverflowing ? scrollWidth > clientWidth : scrollWidth > clientWidth + TERMINAL_TABS_OVERFLOW_HYSTERESIS;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform = navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac/i.test(userAgent);
}

function isKeyboardFocusableElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const nonTextTypes = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "hidden"]);
    return !nonTextTypes.has(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
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
function getScreenViewportBaselineCandidate(viewportWidth: number, viewportHeight: number): number | null {
  if (typeof window === "undefined" || !window.screen) return null;
  const screenWidth = window.screen.width;
  const screenHeight = window.screen.height;
  if (!Number.isFinite(screenWidth) || !Number.isFinite(screenHeight) || screenWidth <= 0 || screenHeight <= 0) {
    return null;
  }

  const portraitLike = viewportHeight >= viewportWidth;
  const candidate = portraitLike
    ? Math.max(screenWidth, screenHeight)
    : Math.min(screenWidth, screenHeight);
  const gap = candidate - viewportHeight;
  const minMeaningfulGap = portraitLike
    ? Math.max(220, candidate * 0.25)
    : Math.max(80, candidate * 0.25);

  return gap >= minMeaningfulGap ? candidate : null;
}

function getKeyboardOverlap(): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  const viewportWidth = vv.width > 0 ? vv.width : window.innerWidth;
  const layoutViewportHeight = Math.max(window.innerHeight, document.documentElement?.clientHeight || 0);
  const viewportHeight = Math.max(layoutViewportHeight, vv.height);
  const chromeOverlap = Math.max(0, layoutViewportHeight - vv.offsetTop - vv.height);
  if (chromeOverlap > 0) return chromeOverlap;

  /*
  FNXC:Terminal 2026-06-30-08:48:
  Folded phones can report an unfolded iOS fallback baseline first, then settle to a narrower closed-posture viewport before the keyboard opens. If that closed sample does not replace the old baseline, the terminal overestimates --keyboard-overlap, fits against a too-short/wrong-width box, and commands like `pnpm build` wrap into spaced glyphs. Re-baseline on settled width/posture changes before computing the iOS gap; do not touch xterm's symbols-free font stack.

  FNXC:Terminal 2026-06-30-09:38:
  A later folded-posture width sample can arrive while xterm's helper textarea is focused and the soft keyboard is already open. Never re-baseline from that focused keyboard-open sample, because it makes the keyboard height look like the closed viewport and clears --keyboard-overlap/--vv-height before the final fit.

  FNXC:Terminal 2026-06-30-10:36:
  The reported recurrence starts with the folded phone already focused and keyboard-open, so there is no prior closed visualViewport sample to seed the iOS fallback baseline. Prefer the current layout viewport height before falling back to visualViewport height; this preserves --keyboard-overlap/--vv-height and the post-layout xterm fit before any later unfold can repair stale geometry.

  FNXC:Terminal 2026-06-30-11:42:
  Touch-primary short landscape and folded closed postures can be <=480px tall. A keyboard-closed width/posture sample must replace an unfolded baseline even at that height, while focused keyboard-open samples remain excluded so xterm does not clear overlap before the first correct folded fit.

  FNXC:Terminal 2026-07-02-18:12:
  iOS Safari can deliver the very first terminal sample with the helper textarea focused, the soft keyboard already open, and both `innerHeight` and `documentElement.clientHeight` shrunk to the visual viewport. Seed that initial focused sample from the device screen only when the missing height is large enough to be a keyboard, so 10px/12px terminals publish --keyboard-overlap/--vv-height/--vv-width before any close/open, orientation, reconnect, or font reset side effect can repair spaced ASCII cells.
  */
  if (!isKeyboardFocusableElement(document.activeElement) && hasSettledViewportPostureChange(viewportWidth)) {
    setInitialViewportBaseline(viewportHeight, viewportWidth);
  }

  // On iOS Safari, window.innerHeight shrinks to match visualViewport.
  // Detect keyboard by checking if visual viewport is shorter than initial
  // height by more than 80px (with a 30px noise filter).
  const screenBaselineCandidate = isKeyboardFocusableElement(document.activeElement)
    ? getScreenViewportBaselineCandidate(viewportWidth, viewportHeight)
    : null;
  const initialHeight = Math.max(
    getInitialViewportHeight(viewportWidth, screenBaselineCandidate ?? viewportHeight),
    screenBaselineCandidate ?? 0,
  );
  const gap = initialHeight - vv.offsetTop - vv.height;
  // Minimum 30px gap required to filter noise (address bar, toolbar changes).
  // Threshold of 80px: only consider keyboard present when gap exceeds this.
  if (gap >= 30 && gap > 80) {
    return gap;
  }

  setInitialViewportBaseline(viewportHeight, viewportWidth);
  return 0;
}

/** Cached initial viewport height before any keyboard opened. */
let _initialViewportHeight: number | null = null;
let _initialViewportWidth: number | null = null;

function setInitialViewportBaseline(height: number, width: number): void {
  _initialViewportHeight = height;
  _initialViewportWidth = width;
}

function hasSettledViewportPostureChange(width: number): boolean {
  return (
    _initialViewportHeight !== null &&
    _initialViewportWidth !== null &&
    Math.abs(width - _initialViewportWidth) >= 1
  );
}

/**
 * Returns the viewport height at page load (before any keyboard opens).
 * Cached after first read.
 */
function getInitialViewportHeight(width: number, height: number): number {
  if (_initialViewportHeight === null) {
    setInitialViewportBaseline(height, width);
  }
  return _initialViewportHeight ?? height;
}

/** Reset the cached initial viewport height. Exported for tests only. */
export function _resetInitialViewportHeight(): void {
  _initialViewportHeight = null;
  _initialViewportWidth = null;
}

interface TerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCommand?: string;
  initialCommandGeneration?: number;
  projectId?: string;
  /** Render the terminal inline inside a parent-owned layout instead of a portaled modal. */
  embedded?: boolean;
  /** Worktree/project directory used by the initial scoped tab. */
  defaultCwd?: string;
  /** Optional terminal-session namespace, usually the owning task id. */
  scopeId?: string;
  /** Whether the fixed ExecutorStatusBar footer is currently rendered; reserves space for it in below-mode. */
  footerVisible?: boolean;
  /*
  FNXC:TerminalLayout 2026-09-15-07:57:
  FN-409: the terminal is the single source of truth for its own effective presentation, so the shell never reads
  `localStorage` to guess it. This reports whether the terminal is CURRENTLY rendered as the pinned in-flow panel
  (false for mobile, embedded, and detached), and is called with `false` on unmount so a closed terminal never
  leaves the shell believing it is still pinned.
  */
  onPinnedLayoutChange?: (pinned: boolean) => void;
  /** Monotonic signal: bump to raise the detached terminal window to the front without resetting its session. */
  focusNonce?: number;
  /*
  FNXC:TaskPopupViewGating 2026-07-23-10:25:
  Keep-alive suspension gate (FN remount-churn fix follow-up). Kept-alive hosts (the task-detail
  worktree Terminal tab inside a hidden popup or behind another tab) keep isOpen=true so the xterm
  instance and terminal WebSocket survive, but pass active=false to suspend auxiliary background
  work only: visual-viewport/keyboard/orientation listeners, window-resize listeners,
  ResizeObservers, refit rAF loops, tabs-overflow measurement, and the zoom/Escape keydown
  handlers. xterm init, WS bridging, disposal-on-close, and rendering stay keyed on isOpen alone.
  On the false -> true transition the gated refit effects re-run, so the reveal gets a corrective
  fit for free. Defaults to true so every standalone host is unaffected.
  */
  active?: boolean;
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
export function TerminalModal({ isOpen, onClose, initialCommand, initialCommandGeneration = 0, projectId, embedded = false, defaultCwd, scopeId, footerVisible = false, active = true, onPinnedLayoutChange, focusNonce }: TerminalModalProps) {
  const { t } = useTranslation("app");
  // FNXC:TaskPopupViewGating 2026-07-23-10:25: auxiliary-effect gate — see the `active` prop doc above. Never used for xterm init/cleanup or render.
  const auxEffectsActive = isOpen && active;
  const [error, setError] = useState<string | null>(null);
  // FNXC:Terminal 2026-07-23-20:10: In-flight guard for the manual "Start terminal" action (GitHub #2121/#2307 review): rapid clicks must not create duplicate PTY sessions, and the Windows bootstrap-failure cohort this button serves must SEE createTab failures instead of a silently dead button.
  const [isStartingTerminal, setIsStartingTerminal] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [xtermReady, setXtermReady] = useState(false);
  /*
  FNXC:Terminal 2026-09-15-21:04:
  FN-434 last-resort recreate signal: bumped when a live xterm instance cannot be re-attached to the container of the
  new presentation, so the init effect (guarded by `xtermRef.current`) is allowed to build a fresh instance there.
  */
  const [xtermReinitNonce, setXtermReinitNonce] = useState(0);
  /*
  FNXC:Terminal 2026-09-15-21:04:
  FN-434: `xtermPresentationRef` is the presentation the live instance belongs to. Only a genuine presentation
  CHANGE may move or rebuild it (a container remount from a session switch is the init effect's business);
  `xtermReattachFallbackRef` bounds the rebuild to one attempt per presentation so a terminal that never exposes an
  element cannot loop.
  */
  const xtermPresentationRef = useRef<string | null>(null);
  const xtermReattachFallbackRef = useRef<string | null>(null);
  const [xtermInitError, setXtermInitError] = useState<string | null>(null);
  const [openGeneration, setOpenGeneration] = useState(0);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(() =>
    readTerminalPreferences(),
  );
  const [customShortcutLabel, setCustomShortcutLabel] = useState("");
  const [customShortcutValue, setCustomShortcutValue] = useState("");
  const [editingCustomShortcutId, setEditingCustomShortcutId] = useState<string | null>(null);
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
  /*
  FNXC:TerminalLayout 2026-09-15-22:32:
  FN-438: the re-pin contact line arrives inside `onDragGestureEnd`'s validated payload, so the terminal no
  longer subscribes to window bounds for that decision.
  */
  const [isMobileTerminal, setIsMobileTerminal] = useState(() => isTerminalMobileViewport());
  const [isTabletTerminal, setIsTabletTerminal] = useState(() => getViewportMode() === "tablet");
  const [tabsOverflow, setTabsOverflow] = useState(false);
  /*
  FNXC:Terminal 2026-07-10-00:00:
  FN-7813 embedded mode is parent-layout owned: render in-flow, skip portal/overlay/display-mode chrome, and keep the shared xterm/session/resize observers so Task Detail gets the same terminal behavior without taking over the viewport.
  */
  const isFloatingMode = !embedded && !isMobileTerminal && displayMode === "floating";
  const isBelowMode = !embedded && !isMobileTerminal && displayMode === "below";
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  /*
  FNXC:StandardizedDrawers 2026-09-15-04:56:
  FN-406: this was the second byte-identical copy of the phone-drawer predicate. It now resolves through the shared
  `resolveDrawerPresentation` seam; the embedded guard stays local because an embedded terminal is parent-owned chrome.
  */
  const mobileDrawer = !embedded
    && resolveDrawerPresentation({ viewportMode: isMobileTerminal ? "mobile" : "desktop" });
  const dismissHandleProps = useDrawerDismissGesture({
    enabled: mobileDrawer,
    panelRef: modalRef,
    onDismiss: onClose,
  });
  const terminalTabRegionRef = useRef<HTMLDivElement>(null);
  const terminalTabsMeasureRef = useRef<HTMLDivElement>(null);
  const terminalWorkspacePickerRef = useRef<HTMLDivElement>(null);
  const terminalWorkspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const terminalWorkspaceMenuRef = useRef<HTMLDivElement>(null);
  const overlayMouseDownRef = useRef(false);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  /*
  FNXC:Terminal 2026-07-26-11:10:
  The WebGL renderer holds a real GL context plus its glyph atlas textures. A GL context that is dropped without an explicit dispose() is a well-known source of memory pressure on iOS (contexts are a scarce, process-wide resource and are not released promptly by GC), and memory pressure is what makes the OS discard the backgrounded tab. Hold the addon so every teardown path disposes it EXPLICITLY before terminal.dispose(), instead of relying on xterm's AddonManager or the onContextLoss handler to get there.
  */
  const webglAddonRef = useRef<ITerminalAddon | null>(null);
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
  // FNXC:Terminal 2026-07-23-20:10: Sticky marker set when navigator.clipboard.readText rejects (permission denied). Once set, Ctrl/Cmd+V routes through the browser's native paste into xterm's helper textarea instead of retrying a read that will keep rejecting — at most one paste is lost, at denial time.
  const clipboardReadBlockedRef = useRef(false);
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

  /**
   * Release the live xterm instance and everything whose lifetime is tied to it.
   *
   * FNXC:Terminal 2026-07-26-11:15:
   * Four call sites (session/project switch, modal close, session-invalid swap, manual reinit) plus the new unmount teardown all have to release the SAME set of resources: the WebGL addon's GL context, the terminal (scrollback ring + DOM/canvas layers), the fit addon, and the window resize listener bound to that instance. They had drifted into four hand-copied blocks, none of which disposed the WebGL addon. Any one of them missing a resource leaves a GL context or a multi-megabyte scrollback buffer resident, which is exactly the memory pressure that makes mobile browsers discard the backgrounded tab. Single helper so a new teardown path cannot forget one.
   * Refs only — callers still own their own React state resets, which differ per path.
   */
  const disposeXtermInstance = useCallback(() => {
    // WebGL first: dispose the renderer while its terminal is still alive so the
    // addon can detach cleanly, then drop the GL context reference.
    if (webglAddonRef.current) {
      try {
        webglAddonRef.current.dispose();
      } catch {
        /* already disposed (e.g. by onContextLoss) */
      }
      webglAddonRef.current = null;
    }
    if (xtermRef.current) {
      try {
        xtermRef.current.dispose();
      } catch {
        /* already disposed */
      }
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
    xtermInitializedRef.current = false;
    // FNXC:Terminal 2026-09-15-21:04: FN-434 — a disposed instance has no presentation, so the next one records fresh.
    xtermPresentationRef.current = null;
    if (windowResizeListenerRef.current) {
      window.removeEventListener("resize", windowResizeListenerRef.current);
      windowResizeListenerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setDisplayModeState(readTerminalDisplayMode(projectId));
  }, [projectId]);

  /*
  FNXC:TerminalLayout 2026-09-15-07:57:
  FN-409 publishes the effective pinned presentation to the shell so the bottom-bar height is reserved exactly once.
  The unmount cleanup reports `false` because App unmounts this component on close.
  */
  useEffect(() => {
    onPinnedLayoutChange?.(isBelowMode);
    return () => onPinnedLayoutChange?.(false);
  }, [isBelowMode, onPinnedLayoutChange]);

  useEffect(() => {
    if (!auxEffectsActive) return;
    /*
    FNXC:Terminal 2026-06-21-22:58:
    Viewport changes must force the terminal back onto the mobile fullscreen path at <=768px or touch-primary short landscape, then restore the stored desktop/tablet docked/floating mode when the viewport expands.
    */
    const updateViewportMode = () => {
      setIsMobileTerminal(isTerminalMobileViewport());
      setIsTabletTerminal(getViewportMode() === "tablet");
    };
    updateViewportMode();
    window.addEventListener("resize", updateViewportMode);
    window.visualViewport?.addEventListener("resize", updateViewportMode);
    return () => {
      window.removeEventListener("resize", updateViewportMode);
      window.visualViewport?.removeEventListener("resize", updateViewportMode);
    };
  }, [auxEffectsActive]);

  const checkTabsFit = useCallback(() => {
    const measuredTabs = terminalTabsMeasureRef.current;
    if (!measuredTabs) return;
    const { scrollWidth, clientWidth } = measuredTabs;
    setTabsOverflow((current) => evaluateTabsOverflow({ scrollWidth, clientWidth, currentlyOverflowing: current }));
  }, []);

  const setDisplayMode = useCallback((mode: TerminalDisplayMode) => {
    setDisplayModeState(writeTerminalDisplayMode(mode, projectId));
    window.dispatchEvent(new CustomEvent("fusion:terminal-display-mode-change", { detail: { projectId, mode } }));
  }, [projectId]);

  /*
  FNXC:TerminalLayout 2026-09-15-21:04:
  FN-434 turns the pinned panel's top grip into a DETACH gesture: the panel has a fixed height, so the only
  meaningful pointer intent left on that edge is "pull the terminal out into a window". The gesture follows the
  same capture/teardown pattern the retired resize handler used (pointer capture on the grip, pointerId filtering,
  restored `user-select`, `dragTeardownRef` for unmount/close mid-drag). Detaching requires travelling past
  TERMINAL_DETACH_DRAG_THRESHOLD_PX in EITHER vertical direction, so a plain click on the grip changes nothing.

  FNXC:TerminalLayout 2026-09-15-22:32:
  FN-438 arms this SAME handler from `.terminal-header` itself, by parity with the detached presentation's
  `dragHandleSelector=".terminal-header"`: the operator reported that dragging the pinned title bar upward did
  nothing, because only the 12px grip carried the gesture. The header is full of real controls, so a press is
  retained only when its target is neither an interactive element (same suppression selector as
  `FloatingWindow.handleDragPointerDown`) nor a tab surface; `preventDefault()` is called only after the press is
  retained, so a suppressed press keeps native activation and focus.
  */
  /*
  FNXC:TerminalLayout 2026-09-16-18:31:
  FN-469: the detach now HANDS THE LIVE GESTURE OVER instead of ending it. The operator reported that pulling the
  pinned terminal out "crée un élément centré" and loses the drag: the handler used to call `endGesture()` and then
  switch presentation, so the floating window mounted at the standard centred opening rectangle with nothing
  attached to the pointer.

  Two facts are published to `FloatingWindow.dragHandoff` before the presentation switch:
  - the live pointer, so the window opens under it;
  - a PROPORTIONAL grab offset: the pointer keeps the same relative position along the title bar it was holding,
    which is the requested "recrop" — the full-width pinned bar becomes an 800px window without the cursor jumping.
    An unmeasurable header (jsdom, unpainted panel) falls back to the shared centred undock anchor.
  The threshold is omnidirectional (`Math.hypot`, consistent with `shouldDetachSnappedWindow`) because a lateral or
  diagonal pull is just as clearly "pull it out" as a vertical one.
  */
  const [pinnedDetachHandoff, setPinnedDetachHandoff] = useState<FloatingWindowDragHandoff | undefined>(undefined);
  const pinnedDetachNonceRef = useRef(0);
  /* The descriptor belongs to ONE gesture: returning to the pinned presentation must not re-place a later opening. */
  useEffect(() => {
    if (displayMode !== "floating") setPinnedDetachHandoff(undefined);
  }, [displayMode]);

  const handlePinnedDetachPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isBelowMode || embedded || isMobileTerminal) return;
    const target = event.target as HTMLElement | null;
    /*
    FNXC:TerminalLayout 2026-09-15-22:32:
    FN-438: the grip itself carries `role="button"` for assistive labelling, so the interactive-suppression probe
    must never reject the element the gesture is armed on — only a real control NESTED inside it.
    */
    const interactive = target?.closest(TERMINAL_HEADER_INTERACTIVE_SELECTOR);
    if (interactive && interactive !== event.currentTarget) return;
    if (target?.closest(".terminal-tab, .terminal-mobile-tabs")) return;
    event.preventDefault();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const headerRect = captureTarget.getBoundingClientRect?.();
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    let detached = false;

    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };

    function endGesture() {
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId || detached) return;
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < TERMINAL_DETACH_DRAG_THRESHOLD_PX) return;
      detached = true;
      pinnedDetachNonceRef.current += 1;
      setPinnedDetachHandoff({
        pointerId,
        pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
        grabOffset: resolvePinnedGrabOffset(headerRect, moveEvent.clientX, moveEvent.clientY),
        nonce: pinnedDetachNonceRef.current,
      });
      endGesture();
      setDisplayMode("floating");
    }

    function handlePointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      endGesture();
    }

    // FNXC:Terminal 2026-06-22-19:50: Unmount/close-mid-drag teardown releases pointer capture and detaches the captured-element listeners without applying a partial gesture.
    dragTeardownRef.current = endGesture;

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [embedded, isBelowMode, isMobileTerminal, setDisplayMode]);

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
            xtermRef.current.refresh(0, Math.max(0, xtermRef.current.rows - 1));
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
      /*
      FNXC:Terminal 2026-07-23-21:05:
      Blank-first-terminal recurrence: on some systems the renderer stalls at init (WebGL activation on a
      zero-sized canvas, or context-loss fallback to the DOM renderer) while the shell prompt sits unpainted
      in xterm's buffer. Every automatic recovery path funnels through this fit — but when fit() computes an
      UNCHANGED cols/rows, xterm skips its internal resize event and never repaints, so the stall was
      permanent until the user typed (new output), changed font size (the only path that refreshed), or
      opened a new tab (fresh renderer). Always follow fit with an explicit full-viewport refresh so the
      FN-7620 container ResizeObserver's guaranteed initial notification — and every later geometry event —
      repairs a stalled renderer even when dimensions did not change. refresh() is cheap and idempotent.
      */
      currentXterm.refresh(0, Math.max(0, currentXterm.rows - 1));
    } catch {
      // Ignore fit errors during viewport transitions
    }
  }, []);

  /*
  FNXC:ModalTouchGeometry 2026-07-27-18:20:
  FloatingWindow now owns terminal pop-out geometry. Refit xterm after its shared geometry signal
  so columns and rows follow drag/resize without reintroducing terminal-local pointer handlers.
  */
  useEffect(() => {
    if (!isFloatingMode) return;
    const refitFloatingTerminal = (event: Event) => {
      const detail = (event as CustomEvent<{ windowKey?: string }>).detail;
      if (detail?.windowKey === `terminal-${projectId ?? "default"}`) fitAndResizeForSession();
    };
    window.addEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, refitFloatingTerminal);
    return () => window.removeEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, refitFloatingTerminal);
  }, [fitAndResizeForSession, isFloatingMode, projectId]);

  /*
  FNXC:TerminalLayout 2026-09-15-21:04:
  FN-434 re-pins the detached terminal when the operator DRAGS it back down onto the bottom bar.

  (a) The contact line is the window bounds' own `bottom`, which `resolveDashboardWindowBounds` already defines
  as `footerRect.top`; no separate DOM measurement of the footer is needed.

  FNXC:TerminalLayout 2026-09-15-22:32:
  FN-438 fixes the "it only re-pins sometimes" defect and names its root cause. The retired implementation
  listened for `pointerdown`/`pointerup` on `document` in the CAPTURE phase and measured
  `panel.getBoundingClientRect()` itself. Capture-phase listeners run BEFORE FloatingWindow's own handler, which
  begins by cancelling the pending `requestAnimationFrame` and only then commits the final position — so on a
  quick gesture the measured bottom edge was the second-to-last frame's, and a panel the operator had genuinely
  dragged onto the bottom bar was judged to be above it. The decision now consumes `onDragGestureEnd`, the
  validated end-of-gesture payload FloatingWindow publishes after committing, so it never measures the DOM.

  (b) The three FN-434 exclusions are preserved, each now a FIELD of that payload rather than a DOM probe:
  mount and programmatic re-clamp publish geometry with no gesture, so they never reach this callback at all (it
  is emitted only from a completed drag, never from `FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT`); a SNAPPED window
  fills the work area, so its bottom edge rests on the contact line permanently, hence `snapMode === "floating"`;
  and a click moves nothing, hence `moved === true`.
  */
  /*
  FNXC:TerminalLayout 2026-09-16-18:31:
  FN-469: `bottom` is now a valid re-pin outcome. The shared contract gained a bottom band, and a window dragged onto
  the footer line is EXACTLY the gesture that arms it — so without accepting it here the existing re-pin would have
  regressed into a generic bottom dock. The terminal keeps its own in-flow `below` presentation as the result: the
  band is only how the gesture is now reported. `left`, `right`, `maximized` and a click still re-pin nothing.
  */
  const handleFloatingDragGestureEnd = useCallback((info: FloatingWindowDragGestureEnd) => {
    if (embedded || isMobileTerminal || !auxEffectsActive) return;
    if (!info.moved || (info.snapMode !== "floating" && info.snapMode !== "bottom")) return;
    if (info.snapMode === "bottom") { setDisplayMode("below"); return; }
    const bottomEdge = info.rect.position.y + info.rect.size.height;
    if (!Number.isFinite(bottomEdge) || !Number.isFinite(info.bounds.bottom)) return;
    if (bottomEdge < info.bounds.bottom - TERMINAL_REPIN_CONTACT_PX) return;
    setDisplayMode("below");
  }, [auxEffectsActive, embedded, isMobileTerminal, setDisplayMode]);

  // Bump open generation whenever the modal opens so the initialCommand
  // effect re-evaluates after a close/reopen cycle (deps may be identical).
  useEffect(() => {
    if (isOpen) setOpenGeneration((g) => g + 1);
  }, [isOpen]);

  // Track virtual keyboard overlap on mobile so the terminal entry area
  // stays visible above the keyboard. On desktop this is a no-op.
  useEffect(() => {
    if (!auxEffectsActive || !isMobileDevice()) return;

    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const overlap = getKeyboardOverlap();
      setKeyboardOverlap(overlap);
      // Track the actual visual viewport height for modal sizing.
      // This is more reliable than 100dvh on iOS Safari where
      // the dynamic viewport height behavior varies by browser version.
      setViewportHeight(vv.height);
      /*
      FNXC:Terminal 2026-07-02-12:28:
      Android Chrome can open the keyboard with a visual viewport narrower than the layout viewport while the terminal footer already shows the persisted 10px preference. Publish the current visual viewport width alongside --vv-height so the fullscreen mobile shell and xterm's first fit measure the visible keyboard-open box before any later orientation, unfold, reconnect, or manual font reset can repair stale wide columns.
      */
      setViewportWidth(vv.width);
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
      setViewportWidth(null);
    };
  }, [fitAndResizeForSession, auxEffectsActive]);

  /*
  FNXC:Terminal 2026-06-21-22:07:
  Docked resize interactions change the terminal viewport without a window resize event, so refit xterm after display mode or docked height changes. FloatingWindow geometry is handled by its dedicated event listener.

  FNXC:TerminalLayout 2026-09-15-21:04:
  FN-434 removed the pinned-height state, so a presentation change (`displayMode`) is the only remaining local
  trigger for this refit.
  */
  useEffect(() => {
    if (!auxEffectsActive) return;
    const sessionId = typeof xtermInitializedRef.current === "string" ? xtermInitializedRef.current : undefined;
    const frame = requestAnimationFrame(() => fitAndResizeForSession(sessionId));
    return () => cancelAnimationFrame(frame);
  /* FNXC:TerminalKeepAlive 2026-07-30-23:55: `floatingSize` was in this array on the PR branch and no
     longer exists — main removed it. Dropped rather than reconstructed: the effect body reads only
     `auxEffectsActive` and `fitAndResizeForSession`, and the rest are layout re-run triggers. */
  }, [displayMode, fitAndResizeForSession, auxEffectsActive]);

  // Refit xterm whenever the user drags the modal's CSS resize grip.
  // The window/visualViewport listeners only fire on viewport changes; native
  // `resize: both` does NOT emit window resize, so we observe the modal node
  // directly and ask xterm to refit to the new pixel box.
  useEffect(() => {
    if (!auxEffectsActive) return;
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
  }, [fitAndResizeForSession, auxEffectsActive]);

  // Use the session management hook
  const {
    tabs,
    activeTab,
    isReady,
    autoCreateDisabled,
    bootstrapError,
    createTab, 
    closeTab, 
    detachedSessions,
    refreshDetachedSessions,
    reopenSession,
    setActiveTab, 
    updateTabTitle,
    restartActiveTab,
    retryBootstrap,
    replaceActiveTabSession,
  } = useTerminalSessions(projectId, {
    storageScope: scopeId ? `task:${scopeId}` : undefined,
    defaultCwd,
  });

  /*
  FNXC:TerminalSharing 2026-08-19-04:10:
  Closing a tab is ambiguous once sessions are shared, so it asks rather than guessing: "Close here"
  detaches this browser and leaves the PTY running (for other viewers, and for the footer's reopen
  control), while "End session" kills it for everyone. alwaysAsk is set because this GATES an
  informed choice — auto-resolving under skip-confirmations would silently pick one, and picking
  wrong either strands a session or destroys someone else's shell.
  */
  const { confirmWithChoice } = useConfirm();
  const requestCloseTab = useCallback(async (tabId: string): Promise<void> => {
    const choice = await confirmWithChoice({
      title: t("terminal.closeTabTitle", "Close this terminal?"),
      message: t(
        "terminal.closeTabMessage",
        "The session keeps running on the server unless you end it. Anyone else viewing it stays connected, and you can reopen it from the terminal footer.",
      ),
      alwaysAsk: true,
      confirmLabel: t("terminal.closeTabHere", "Close in this browser"),
      cancelLabel: t("actions.cancel", "Cancel"),
      tertiaryLabel: t("terminal.closeTabEndSession", "End session"),
      tertiaryDanger: true,
    });
    if (choice === "cancel") return;
    const killSession = choice === "tertiary";
    closeTab(tabId, { killSession });
    // A detached session becomes reopenable immediately; a killed one must disappear from the list.
    void refreshDetachedSessions();
  }, [closeTab, confirmWithChoice, refreshDetachedSessions, t]);

  /*
  FNXC:TerminalSharing 2026-08-19-04:10:
  The footer's reopen control surfaces sessions running on the server that this browser is not
  showing — closed here, or opened by someone else. Without it, "close in this browser" would be a
  one-way door and another person's terminal would be unreachable from this one.
  */
  const [reopenMenuOpen, setReopenMenuOpen] = useState(false);
  const reopenTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reopenMenuRef = useRef<HTMLDivElement | null>(null);
  const [reopenMenuPosition, setReopenMenuPosition] = useState<{ left: number; bottom: number; minWidth: number } | null>(null);
  const [reopenMenuZ, setReopenMenuZ] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!auxEffectsActive || !isReady) return;
    void refreshDetachedSessions();
  }, [auxEffectsActive, isReady, refreshDetachedSessions]);

  const openReopenMenu = useCallback(() => {
    const rect = reopenTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      setReopenMenuPosition({
        left: rect.left,
        bottom: Math.max(0, window.innerHeight - rect.top + 6),
        minWidth: Math.max(rect.width, 240),
      });
    }
    setReopenMenuZ(nextFloatingZ());
    void refreshDetachedSessions();
    setReopenMenuOpen(true);
  }, [refreshDetachedSessions]);

  // Dismiss on outside press or Escape, matching the workspace picker's behaviour.
  useEffect(() => {
    if (!reopenMenuOpen) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (reopenMenuRef.current?.contains(target) || reopenTriggerRef.current?.contains(target)) return;
      setReopenMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setReopenMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [reopenMenuOpen]);

  useEffect(() => {
    if (!auxEffectsActive) {
      setTabsOverflow(false);
      return;
    }
    checkTabsFit();
    window.addEventListener("resize", checkTabsFit);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => checkTabsFit());
    if (observer) {
      if (terminalTabRegionRef.current) observer.observe(terminalTabRegionRef.current);
      if (terminalTabsMeasureRef.current) observer.observe(terminalTabsMeasureRef.current);
    }
    return () => {
      window.removeEventListener("resize", checkTabsFit);
      observer?.disconnect();
    };
  }, [checkTabsFit, auxEffectsActive, tabs.length]);

  useEffect(() => {
    checkTabsFit();
  }, [checkTabsFit, tabs]);

  /*
  FNXC:Terminal 2026-07-06-09:15:
  FN-7620 root cause: the mobile terminal could render BLANK (not merely
  mis-spaced) because nothing ever watched the xterm CONTAINER's (`terminalRef`)
  own box. Real `FitAddon.proposeDimensions()` (@xterm/addon-fit@0.10.0) reads
  `getComputedStyle(terminal.element.parentElement)` height/width and, when that
  resolves to 0 (e.g. the mobile fullscreen/keyboard-overlap height cascade,
  dvh support, or web-font/layout settle has not finished by the time the first
  `fitAddon.fit()` call in `initTerminal` runs), floors to a degenerate
  `{cols: 2, rows: 1}` grid rather than bailing out — xterm silently resizes
  into a near-invisible box. Only `modalRef` (the whole modal) had a
  ResizeObserver; a modal that is already sized to 100dvh/the keyboard box does
  not re-fire that observer when only INNER content (the terminal container)
  later settles to its real size, so the degenerate grid could persist forever
  with no reconnect/orientation/keyboard-toggle/manual-refit path able to catch
  it. `SessionTerminal.tsx` already observes its own container this way (see
  its `resizeObserver.observe(containerRef.current)`); TerminalModal did not.
  Mirror that: observe the xterm container itself for the life of each xterm
  instance so ANY change in its OWN box (not just the outer modal's box) —
  including the very first zero-to-real transition — triggers a corrective
  fit via the existing `fitAndResizeForSession`. Re-established whenever the
  container remounts (tab switch uses `key={activeTab?.sessionId}` on the
  container div). See docs/solutions/ui-bugs/mobile-terminal-blank-render-zero-geometry-container.md.
  */
  useEffect(() => {
    if (!auxEffectsActive) return;
    const node = terminalRef.current;
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
  }, [fitAndResizeForSession, auxEffectsActive, activeTab?.sessionId]);

  const {
    projectName: terminalWorkspaceProjectName,
    workspaces: terminalWorkspaces,
    loading: terminalWorkspacesLoading,
    error: terminalWorkspacesError,
  } = useWorkspaces(projectId);
  const [terminalWorkspaceMenuOpen, setTerminalWorkspaceMenuOpen] = useState(false);
  const [terminalWorkspaceMenuPosition, setTerminalWorkspaceMenuPosition] = useState<TerminalWorkspaceMenuPosition | null>(null);
  const [selectedTerminalWorkspaceId, setSelectedTerminalWorkspaceId] = useState("project");
  const terminalWorkspaceSelectionTouchedRef = useRef(false);
  const defaultTerminalWorkspaceId = useMemo(() => {
    if (typeof defaultCwd !== "string" || defaultCwd.trim().length === 0) {
      return undefined;
    }
    return terminalWorkspaces.find((workspace) => workspace.worktree && workspace.worktree === defaultCwd)?.id;
  }, [defaultCwd, terminalWorkspaces]);

  const selectedTerminalWorkspace = useMemo(
    () => terminalWorkspaces.find((workspace) => workspace.id === selectedTerminalWorkspaceId) ?? null,
    [selectedTerminalWorkspaceId, terminalWorkspaces],
  );
  const shouldShowTerminalWorkspacePicker = terminalWorkspaces.length > 0 && !terminalWorkspacesError;
  const selectedTerminalWorkspaceCanOpen = selectedTerminalWorkspaceId === "project" || Boolean(selectedTerminalWorkspace?.worktree);
  const selectedTerminalWorkspaceLabel =
    selectedTerminalWorkspaceId === "project"
      ? t("terminal.projectRoot", "Project Root")
      : (selectedTerminalWorkspace?.label ?? selectedTerminalWorkspaceId);

  /*
  FNXC:TerminalWorkspaces 2026-06-29-00:00:
  Terminal worktree selection follows the file-browser workspace model: Project Root opens the default terminal cwd, and task entries use only registered WorkspaceInfo.worktree paths. Keep this header affordance compact and available in docked, floating, and mobile terminal modes without replacing the fast + new-terminal path.

  FNXC:TerminalWorkspaces 2026-06-29-00:00:
  The picker is a header menu, not terminal input: Escape and outside clicks close the listbox first so users do not accidentally close the whole terminal while navigating worktrees with keyboard or touch.

  FNXC:TerminalWorkspaces 2026-07-11-00:00:
  Embedded Task Detail terminals pass defaultCwd for the first shell, so default the picker to the registered workspace whose worktree exactly matches that path. Apply this only until the operator manually changes the picker; footer terminals omit defaultCwd and continue to show Project Root.
  */
  useEffect(() => {
    if (!defaultTerminalWorkspaceId || selectedTerminalWorkspaceId !== "project" || terminalWorkspaceSelectionTouchedRef.current) {
      return;
    }
    setSelectedTerminalWorkspaceId(defaultTerminalWorkspaceId);
  }, [defaultTerminalWorkspaceId, selectedTerminalWorkspaceId]);

  useEffect(() => {
    if (selectedTerminalWorkspaceId === "project") {
      return;
    }
    const stillAvailable = terminalWorkspaces.some((workspace) => workspace.id === selectedTerminalWorkspaceId);
    if (!stillAvailable) {
      setSelectedTerminalWorkspaceId("project");
      setTerminalWorkspaceMenuOpen(false);
    }
  }, [selectedTerminalWorkspaceId, terminalWorkspaces]);

  const getEffectiveViewport = useCallback(() => {
    const visualViewport = window.visualViewport;
    if (visualViewport && visualViewport.width > 0 && visualViewport.height > 0) {
      return {
        width: visualViewport.width,
        height: visualViewport.height,
        offsetTop: visualViewport.offsetTop,
        offsetLeft: visualViewport.offsetLeft,
      };
    }
    return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 };
  }, []);

  const updateTerminalWorkspaceMenuPosition = useCallback(() => {
    const trigger = terminalWorkspaceTriggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menu = terminalWorkspaceMenuRef.current;
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const rootStyle = getComputedStyle(document.documentElement);
    const horizontalGutter = Number.parseFloat(rootStyle.getPropertyValue("--space-md")) || 16;
    const verticalGutter = horizontalGutter;
    const gap = Number.parseFloat(rootStyle.getPropertyValue("--space-xs")) || 6;
    const minWidth = Number.parseFloat(rootStyle.getPropertyValue("--terminal-workspace-menu-min-width")) || 220;
    const preferredWidth = Number.parseFloat(rootStyle.getPropertyValue("--terminal-workspace-menu-width")) || 340;
    const preferredHeight = Number.parseFloat(rootStyle.getPropertyValue("--terminal-workspace-menu-height")) || 360;

    const measuredWidth = menu?.offsetWidth || Math.max(rect.width, preferredWidth);
    const maxWidth = Math.max(viewportWidth - horizontalGutter * 2, minWidth);
    const width = Math.min(Math.max(measuredWidth, minWidth), maxWidth);
    const measuredHeight = menu?.offsetHeight || preferredHeight;
    const maxHeight = Math.max(viewportHeight - verticalGutter * 2, minWidth);
    const constrainedHeight = Math.min(measuredHeight, maxHeight);
    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerRight = rect.right - offsetLeft;
    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const openUpward = spaceBelow < constrainedHeight && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(triggerRight - width, horizontalGutter),
      viewportWidth - horizontalGutter - width,
    ) + offsetLeft;
    const top = openUpward
      ? Math.max(verticalGutter + offsetTop, triggerTop - constrainedHeight - gap + offsetTop)
      : Math.min(triggerBottom + gap + offsetTop, viewportHeight + offsetTop - verticalGutter - constrainedHeight);

    setTerminalWorkspaceMenuPosition({ top, left, width, maxHeight: constrainedHeight });
  }, [getEffectiveViewport]);

  useLayoutEffect(() => {
    if (!terminalWorkspaceMenuOpen) {
      return;
    }
    updateTerminalWorkspaceMenuPosition();
  }, [terminalWorkspaceMenuOpen, terminalWorkspaces.length, updateTerminalWorkspaceMenuPosition]);

  useEffect(() => {
    if (!terminalWorkspaceMenuOpen) {
      setTerminalWorkspaceMenuPosition(null);
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (terminalWorkspacePickerRef.current?.contains(target) || terminalWorkspaceMenuRef.current?.contains(target))
      ) {
        return;
      }
      setTerminalWorkspaceMenuOpen(false);
    };

    const handleReposition = () => updateTerminalWorkspaceMenuPosition();
    const frame = requestAnimationFrame(handleReposition);
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", handleReposition);
    visualViewport?.addEventListener("scroll", handleReposition);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      visualViewport?.removeEventListener("resize", handleReposition);
      visualViewport?.removeEventListener("scroll", handleReposition);
    };
  }, [terminalWorkspaceMenuOpen, terminalWorkspaces.length, updateTerminalWorkspaceMenuPosition]);

  const handleOpenSelectedTerminalWorkspace = useCallback(() => {
    setTerminalWorkspaceMenuOpen(false);
    if (selectedTerminalWorkspaceId === "project") {
      void createTab();
      return;
    }

    if (!selectedTerminalWorkspace?.worktree) {
      return;
    }

    void createTab({
      cwd: selectedTerminalWorkspace.worktree,
      title: selectedTerminalWorkspace.label,
    });
  }, [createTab, selectedTerminalWorkspace, selectedTerminalWorkspaceId]);

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

  const resetCustomShortcutForm = useCallback(() => {
    setCustomShortcutLabel("");
    setCustomShortcutValue("");
    setEditingCustomShortcutId(null);
  }, []);

  const persistCustomShortcuts = useCallback(
    (shortcuts: TerminalCustomShortcut[]) => {
      updateTerminalPreferences({
        customShortcuts: normalizeTerminalCustomShortcuts(shortcuts),
      });
    },
    [updateTerminalPreferences],
  );

  const startEditingCustomShortcut = useCallback((shortcut: TerminalCustomShortcut) => {
    setCustomShortcutLabel(shortcut.label);
    setCustomShortcutValue(shortcut.value);
    setEditingCustomShortcutId(shortcut.id);
  }, []);

  const removeCustomShortcut = useCallback(
    (shortcutId: string) => {
      persistCustomShortcuts(
        terminalPreferences.customShortcuts.filter((shortcut) => shortcut.id !== shortcutId),
      );
      if (editingCustomShortcutId === shortcutId) {
        resetCustomShortcutForm();
      }
    },
    [editingCustomShortcutId, persistCustomShortcuts, resetCustomShortcutForm, terminalPreferences.customShortcuts],
  );

  const trimmedCustomShortcutLabel = customShortcutLabel.trim();
  const trimmedCustomShortcutValue = customShortcutValue.trim();
  const isEditingCustomShortcut = editingCustomShortcutId !== null;
  const customShortcutLimitReached =
    terminalPreferences.customShortcuts.length >= MAX_TERMINAL_CUSTOM_SHORTCUTS;
  const canSubmitCustomShortcut =
    trimmedCustomShortcutLabel !== "" &&
    trimmedCustomShortcutValue !== "" &&
    (isEditingCustomShortcut || !customShortcutLimitReached);

  const submitCustomShortcut = useCallback(() => {
    if (!canSubmitCustomShortcut) {
      return;
    }

    const nextShortcut: TerminalCustomShortcut = {
      id: editingCustomShortcutId ?? createTerminalCustomShortcutId(),
      label: trimmedCustomShortcutLabel,
      value: trimmedCustomShortcutValue,
    };
    const nextShortcuts = isEditingCustomShortcut
      ? terminalPreferences.customShortcuts.map((shortcut) =>
          shortcut.id === editingCustomShortcutId ? nextShortcut : shortcut,
        )
      : [...terminalPreferences.customShortcuts, nextShortcut];

    persistCustomShortcuts(nextShortcuts);
    resetCustomShortcutForm();
  }, [
    canSubmitCustomShortcut,
    editingCustomShortcutId,
    isEditingCustomShortcut,
    persistCustomShortcuts,
    resetCustomShortcutForm,
    terminalPreferences.customShortcuts,
    trimmedCustomShortcutLabel,
    trimmedCustomShortcutValue,
  ]);

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
    resetCustomShortcutForm();
  }, [resetCustomShortcutForm]);

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

        FNXC:Terminal 2026-07-04-09:35:
        FN-7561 recurrence #3: reassigning `fontFamily` to the SAME already-resolved value (the common case, since preferences are unchanged) is a no-op against real xterm's OptionsService — no `onOptionChange` fires, so CharSizeService/DomRenderer never remeasure the web font that only just finished loading. Force a genuine value transition via `forceTerminalFontRemeasure` so the character/cell metrics and `_setDefaultSpacing()` letter-spacing compensation are recomputed against the settled font on every settle, not just when the preference itself changed.

        FNXC:Terminal 2026-07-04-11:35:
        FN-7567 recurrence #4: forcing the remeasure above is necessary but not
        sufficient. Real xterm's `DomRenderer._setDefaultSpacing()` (the
        letter-spacing compensation baked onto `.xterm-rows`, computed as
        `dimensions.css.cell.width - widthCache.get('W')`) only recomputes from
        `handleCharSizeChanged()` (wired to `CharSizeService.onCharSizeChange`,
        i.e. exactly what `forceTerminalFontRemeasure` above triggers) and from
        `handleDevicePixelRatioChange()` — NEVER from `handleResize()`, which is
        what `fitAddon.fit()` -> `terminal.resize(cols, rows)` triggers. Calling
        `forceTerminalFontRemeasure` BEFORE `fitAddon.fit()` bakes spacing
        against the column count that predates the fit, so once fit() changes
        the column count (and therefore the true cell width) the baked spacing
        goes stale and stays wrong until an unrelated later event (DPR change,
        orientation) coincidentally forces another genuine option/DPR-change
        remeasure — exactly the reported "only repairs itself after an
        incidental refit" symptom. Force a SECOND genuine remeasure AFTER
        `fitAddon.fit()` settles the column count so the letter-spacing bake is
        recomputed against the FINAL geometry, not the pre-fit one. See
        `docs/solutions/ui-bugs/xterm-options-noop-remeasure-after-font-settle.md`.
        */
        forceTerminalFontRemeasure(terminal, resolvedFontFamilyRef.current);
        terminal.options.fontSize = fontSizeRef.current;
        fitAddon.fit();
        resizeRef.current?.(terminal.cols, terminal.rows);
        forceTerminalFontRemeasure(terminal, resolvedFontFamilyRef.current);
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      } catch {
        // Ignore fit/refresh errors during teardown or viewport transitions.
      }
    },
    [],
  );

  /*
  FNXC:Terminal 2026-09-15-21:04:
  FN-434 root cause of the "panel appears but the console is gone" report: switching presentation re-mounts the
  terminal subtree under a DIFFERENT host (`FloatingWindow`, `.terminal-below-host`, or the mobile portal), so
  `terminalRef` points at a brand-new node — while the xterm init effect is guarded by
  `if (!mounted || !terminalRef.current || xtermRef.current) return;` and therefore never re-runs. The live xterm
  element stayed attached to the discarded DOM node. Re-attach it to the current container on every presentation
  change (layout effect, before paint), then refit and repaint; if there is no element to move, or moving it throws,
  dispose and let the init effect rebuild the instance in the new container.
  */
  useLayoutEffect(() => {
    const container = terminalRef.current;
    const terminal = xtermRef.current;
    if (!container || !terminal) return;
    /*
    Scope: a PRESENTATION change only. The container node also remounts on a session/tab switch, which the init
    effect already owns — reacting to that here would dispose a healthy instance mid-restore.
    */
    const presentationKey = `${displayMode}|${embedded}|${isMobileTerminal}`;
    if (xtermPresentationRef.current === null) {
      // First pass over a live instance: record the presentation it belongs to, then only react to CHANGES.
      xtermPresentationRef.current = presentationKey;
      return;
    }
    if (xtermPresentationRef.current === presentationKey) return;

    const element = (terminal as unknown as { element?: HTMLElement | null }).element ?? null;
    if (element && element.parentElement === container) {
      xtermPresentationRef.current = presentationKey;
      return;
    }

    if (element) {
      try {
        container.appendChild(element);
        xtermPresentationRef.current = presentationKey;
        fitAndResizeForSession(activeTab?.sessionId);
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        return;
      } catch {
        // Fall through to the recreate path below.
      }
    }

    /*
    FNXC:Terminal 2026-09-15-21:04:
    FN-434 recreate fallback, attempted AT MOST ONCE per presentation: a rebuilt instance that still exposes no
    attachable element must not dispose-and-rebuild forever (that loop is an unbounded render storm, not a repair).
    */
    if (xtermReattachFallbackRef.current === presentationKey) return;
    xtermReattachFallbackRef.current = presentationKey;

    disposeXtermInstance();
    xtermInitializedRef.current = false;
    setXtermReady(false);
    setXtermReinitNonce((nonce) => nonce + 1);
  }, [
    activeTab?.sessionId,
    disposeXtermInstance,
    displayMode,
    embedded,
    fitAndResizeForSession,
    isMobileTerminal,
    xtermReady,
  ]);

  // Initialize xterm.js when a session is attachable.
  // Keying this effect by active session id (not full activeTab object) avoids
  // tearing down xterm lifecycle wiring during unrelated tab metadata updates
  // such as title changes.
  useEffect(() => {
    if (!isOpen) return;

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
      disposeXtermInstance();
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
          scrollback: TERMINAL_SCROLLBACK_LINES,
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
              if (webglAddonRef.current === webglAddon) webglAddonRef.current = null;
            });
            terminal.loadAddon(webglAddon);
            webglAddonRef.current = webglAddon;
          } catch {
            // WebGL not available, fallback to canvas
          }
        }

        // Open terminal in container
        /*
        FNXC:Terminal 2026-07-05-12:40:
        FN-7603 recurrence #5: force xterm's CharSizeService to self-select its
        DOM-based measurement strategy (instead of its default Canvas/
        OffscreenCanvas strategy) for the synchronous duration of open(), so the
        cell-width measurement that feeds FitAddon.fit() and
        DomRenderer._setDefaultSpacing()'s baked letter-spacing uses the SAME
        pipeline as WidthCache's DOM-based per-glyph measurement. See
        `withDomBasedTerminalCharacterMeasurement` and
        docs/solutions/ui-bugs/xterm-options-noop-remeasure-after-font-settle.md.
        */
        withDomBasedTerminalCharacterMeasurement(() => {
          terminal.open(terminalRef.current!);
        });

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
          // FNXC:Terminal 2026-07-23-21:05: Explicit refresh after the first fit — see fitAndResizeForSession. A renderer that stalled during open() (zero-sized canvas WebGL activation / context-loss fallback) must be repainted here even when fit() left cols/rows unchanged, or the already-buffered shell prompt stays invisible until user input.
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
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
                  terminal.refresh(0, Math.max(0, terminal.rows - 1));
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
            /*
            FNXC:Terminal 2026-07-04-10:24:
            GitHub #1902 showed that relying only on xterm's helper-textarea paste can swallow physical Ctrl/Cmd+V before clipboard text reaches the PTY. Own platform paste here when the async clipboard API is available.

            FNXC:Terminal 2026-07-23-20:10:
            Paste contract (GitHub #2121/#2307 review), verified against xterm 5.5.0 source:
            - returning false from attachCustomKeyEventHandler skips xterm's key handling but does NOT cancel the browser's default paste — that default fires xterm's helper-textarea `paste` listener (single delivery). Never return true for paste: on non-mac, xterm's own _keyDown turns Ctrl+V into a \x16 data event and cancels the browser paste.
            - When readText is available: call event.preventDefault() so the custom clipboard read is the SINGLE delivery path (without it the payload reached the PTY twice), and deliver via terminal.paste() so bracketed-paste wrapping and \n→\r normalization apply.
            - When readText is missing (non-HTTPS remote, older Firefox) or a prior read was denied: return false with NO preventDefault so the native helper-textarea paste delivers exactly once.
            */
            const readText = navigator.clipboard?.readText;
            if (!readText || clipboardReadBlockedRef.current) {
              return false;
            }
            event.preventDefault();
            readText.call(navigator.clipboard)
              .then((text) => {
                if (!text || xtermInitializedRef.current !== currentSessionId) {
                  return;
                }
                terminal.paste(text);
              })
              .catch(() => {
                // Permission denied (or transient failure): stop preventDefaulting future
                // Ctrl/Cmd+V so the native paste path stays functional.
                clipboardReadBlockedRef.current = true;
              });
            return false;
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

      /*
      FNXC:Terminal 2026-07-26-11:20:
      Deliberately NOT disposing here. This effect re-runs on every terminal-tab / session change, and the instance must survive a tab switch (the body above disposes+recreates only when the session actually changed). Release is owned by the close effect, the session-invalid swap, manual reinit, and the unmount teardown below — never by this cleanup.
      */
    };
  // FNXC:Terminal 2026-09-15-21:04: FN-434 adds `xtermReinitNonce` so a failed re-attach can rebuild the instance.
  }, [disposeXtermInstance, fitAndResizeForSession, isOpen, activeTab?.sessionId, projectId, remeasureAfterTerminalFontLoad, xtermReinitNonce]);

  // (Input forwarding + window resize listener are wired inside initTerminal
  // so they share the xterm instance's lifetime — see comment there.)

  // FNXC:Terminal 2026-06-22-09:00: Run any active drag teardown when the component unmounts mid-drag so document pointer listeners + the pending docked-resize rAF never outlive the modal.
  useEffect(() => () => dragTeardownRef.current?.(), []);

  /*
  FNXC:Terminal 2026-07-26-11:25:
  Unmount teardown. The close-cleanup effect below is keyed on `isOpen` and has no cleanup function, so an unmount (project switch, or App unmounting the modal now that it is mounted only while open) left the xterm, its scrollback ring, and the WebGL context reachable-but-orphaned until GC happened to run. Mobile browsers discard a backgrounded tab on memory pressure, and a GL context is not released promptly by GC — so "the collector will get to it" is not good enough here. Release synchronously on unmount.
  */
  useEffect(() => () => disposeXtermInstance(), [disposeXtermInstance]);

  // Cleanup xterm when modal closes
  useEffect(() => {
    if (isOpen) return;

    // A close mid-drag must also drop the active drag's document listeners + rAF.
    dragTeardownRef.current?.();

    // Modal is closed - cleanup xterm
    disposeXtermInstance();
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
  }, [disposeXtermInstance, isOpen]);

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

    /*
    FNXC:TerminalSharing 2026-08-19-02:45:
    A scrollback frame is either a RESUME (only the bytes this terminal missed — append them) or a
    full replay (reset first). Appending a full replay to a terminal that still shows that history is
    what duplicated the screen — visibly, the last prompt twice — every time a backgrounded tab
    reconnected.
    */
    const unsubScrollback = onScrollback((data, reset) => {
      if (reset && xtermInitializedRef.current === expectedSessionId) {
        xtermRef.current?.reset();
      }
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

    let cancelled = false;

    // Defer fit until the next frame so layout reflects the new font metrics
    // before FitAddon measures rows/cols. Reuse pendingFitRef so font changes and
    // visualViewport-triggered fits are coalesced into a single scheduled fit.
    /*
    FNXC:Terminal 2026-07-04-11:40:
    FN-7567 recurrence #4: `rebakeSpacingAfterFit` is set only by the settled
    (font-metrics-ready) call site below. Real xterm's `DomRenderer._setDefaultSpacing()`
    letter-spacing bake only recomputes from a genuine option-change remeasure,
    never from `handleResize()` (what `fitAddon.fit()` triggers), so a settle
    that calls `forceTerminalFontRemeasure()` and THEN fits must force one more
    genuine remeasure AFTER the fit to re-bake spacing against the FINAL
    (post-fit) column count — otherwise the bake stays computed against the
    stale pre-fit column count until an unrelated later event happens to force
    another remeasure. The unsettled immediate frame intentionally does not
    rebake: at that point the web font has not necessarily loaded yet, so
    forcing another remeasure there would just re-bake against the same
    (possibly still-fallback) metrics.
    */
    const scheduleRefit = (rebakeSpacingAfterFit = false) => {
      if (pendingFitRef.current !== null) {
        cancelAnimationFrame(pendingFitRef.current);
        pendingFitRef.current = null;
      }

      const frame = requestAnimationFrame(() => {
        pendingFitRef.current = null;
        if (cancelled) {
          return;
        }
        refitTerminal();
        xtermRef.current?.refresh?.(0, Math.max(0, xtermRef.current.rows - 1));
        if (rebakeSpacingAfterFit && xtermRef.current) {
          forceTerminalFontRemeasure(xtermRef.current, resolvedFontFamily);
        }
      });
      pendingFitRef.current = frame;
      return frame;
    };

    const immediateFrame = scheduleRefit();

    /*
    FNXC:Terminal 2026-06-30-13:18:
    The mobile screenshot recurrence happens at the visible 10px setting with the soft keyboard already open. A live font-size preference change must wait for the symbols-free measured stack to settle, then reapply xterm font options, refit, resize, and refresh; otherwise canvas/DOM metrics can keep the old wider cells until an unfold/orientation event forces a later measurement.

    FNXC:Terminal 2026-07-04-09:35:
    FN-7561 recurrence #3: the two equality checks below only guard against a STALE out-of-order settle (a newer preference change landed first); when the values already match the current snapshot (the common initial-load case: preferences did not actually change) a plain reassignment is a no-op against real xterm's OptionsService, so CharSizeService/DomRenderer never remeasure the font that just finished loading. Use `forceTerminalFontRemeasure` so a genuine value transition always occurs on settle, regardless of whether the resolved value already equals the terminal's current option value.
    */
    void waitForTerminalFontMetrics(terminalPreferences.fontSize, resolvedFontFamily).then(
      (fontMetricsSettled) => {
        if (
          cancelled ||
          !fontMetricsSettled ||
          !xtermRef.current ||
          xtermRef.current.options.fontSize !== terminalPreferences.fontSize ||
          xtermRef.current.options.fontFamily !== resolvedFontFamily
        ) {
          return;
        }
        forceTerminalFontRemeasure(xtermRef.current, resolvedFontFamily);
        xtermRef.current.options.fontSize = terminalPreferences.fontSize;
        scheduleRefit(true);
      },
      () => {
        // FontFaceSet failures are non-fatal; the immediate frame above still
        // applies the current preference and keeps terminal input usable.
      },
    );

    return () => {
      cancelled = true;
      if (immediateFrame !== undefined && pendingFitRef.current === immediateFrame) {
        cancelAnimationFrame(immediateFrame);
        pendingFitRef.current = null;
      }
    };
  }, [resolvedFontFamily, terminalPreferences, xtermReady, refitTerminal]);

  // Handle keyboard shortcuts (zoom)
  // FNXC:TaskPopupViewGating 2026-07-23-10:25: gated on auxEffectsActive so a kept-alive hidden terminal never intercepts global zoom keystrokes.
  useEffect(() => {
    if (!auxEffectsActive) return;

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
  }, [auxEffectsActive, setFontSize]);

  // Handle escape key to close the open worktree menu before closing the terminal.
  // FNXC:TaskPopupViewGating 2026-07-23-10:25: gated on auxEffectsActive so a kept-alive hidden terminal never swallows Escape or closes itself.
  useEffect(() => {
    if (!auxEffectsActive) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (terminalWorkspaceMenuOpen) {
          e.preventDefault();
          e.stopPropagation();
          setTerminalWorkspaceMenuOpen(false);
          return;
        }
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [auxEffectsActive, onClose, terminalWorkspaceMenuOpen]);

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
      disposeXtermInstance();
      setXtermReady(false);
      setXtermInitError(null);

      replaceActiveTabSession().catch((err) => {
        console.error("Failed to replace invalid terminal session:", err);
      });
    });
    return unsub;
  }, [disposeXtermInstance, onSessionInvalid, replaceActiveTabSession]);

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
    disposeXtermInstance();
    // Clear error state and reset readiness so the init effect re-runs
    setXtermInitError(null);
    setXtermReady(false);
  }, [disposeXtermInstance]);

  const handleRefreshPage = useCallback(() => {
    window.location.reload();
  }, []);

  const handleIncreaseFontSize = useCallback(() => {
    setFontSize((current) => clampTerminalFontSize(current + 1));
  }, [setFontSize]);

  const handleDecreaseFontSize = useCallback(() => {
    setFontSize((current) => clampTerminalFontSize(current - 1));
  }, [setFontSize]);

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

  /*
  FNXC:Terminal 2026-09-01-03:46:
  A terminal that already has a session id must restore immediately instead of re-running the start-up state. The start-up state remains deliberate when there is genuinely no session to attach to: on first open, and after validation prunes a dead persisted tab while auto-create is still replacing it.

  Do not satisfy restore by keeping TerminalModal mounted while closed: App's terminalOpen guard must continue unmounting it, as enforced by TerminalModal.closed-mount-cost.test.tsx and App.test.tsx's mount-lifecycle guard, so closed terminals release their browser socket, timer, xterm buffer, and renderer. Attaching xterm before validation is safe because useTerminal already opens the same session socket pre-validation; useTerminalSessions keeps its separate FNXC:Terminal 2026-07-23-21:00 rule against forcing isReady and still owns validation, dead-tab pruning, and Windows manual-start ordering.
  */
  const hasRestorableSession = Boolean(activeTab?.sessionId);
  const isLoading = !hasRestorableSession && !bootstrapError;
  /*
  FNXC:Terminal 2026-07-23-14:30:
  GitHub #2121/#2307: when the sessions hook will never auto-create the first
  tab (Windows browser clients), the bootstrap spinner has nothing to wait for.
  Render an explicit "Start terminal" action instead of an indefinite
  "Starting terminal..." state whose only escape was discovering the tab-strip
  "+" button.
  */
  const showManualStart = isReady && autoCreateDisabled && !activeTab && !bootstrapError;
  // FNXC:Terminal 2026-06-23-04:30: Always carry the base `terminal-modal-overlay` class so the no-dim/no-blur rule applies in EVERY mode (floating, pinned, AND the mobile sheet that is neither) — the terminal must never dim the page behind it.
  const overlayClassName = `modal-overlay open terminal-modal-overlay${isFloatingMode ? " terminal-modal-overlay--floating" : ""}`;
  /*
  FNXC:TerminalModalControls 2026-09-15-07:57:
  CSS still has a width-based phone media query for true-phone fallback. Mark a known tablet
  explicitly so its floating/pinned geometry wins at the 768px boundary rather than inheriting
  the phone full-screen shell. Embedded terminals remain parent-owned and never receive this chrome.
  */
  const modalClassName = `modal terminal-modal${isMobileTerminal && !embedded ? " terminal-modal--mobile" : ""}${isTabletTerminal && !isMobileTerminal && !embedded ? " terminal-modal--tablet" : ""}${isFloatingMode ? " terminal-modal--floating" : ""}${isBelowMode ? " terminal-modal--below" : ""}${embedded ? " terminal-modal--embedded" : ""}`;
  /*
  FNXC:TerminalWorkspaces 2026-07-13-00:00:
  The workspace picker menu is portaled to `document.body`, so floating terminal mode keeps it in the utility floating band above the terminal panel. FloatingWindow owns the panel stack claim; this fixed menu band preserves the menu's root-portal visibility.

  FNXC:TerminalWorkspaces 2026-07-13-00:00:
  The portaled listbox has CSS fallback coordinates for non-JS resilience, but it must never paint there during the open-frame measurement pass. Position in a layout effect and keep the menu invisible/non-interactive until the computed trigger-relative coordinates are applied.
  */
  const terminalWorkspaceMenuFloatingZ = isFloatingMode ? currentFloatingZ() + 1 : undefined;

  const modalStyle = {
    ...(keyboardOverlap > 0
      ? {
          "--keyboard-overlap": `${keyboardOverlap}px`,
          // On mobile with keyboard open, constrain to visualViewport height
          // so the modal (including status bar) fits entirely above the keyboard.
          // This is more reliable than 100dvh which behaves differently
          // across Chrome Android vs iOS Safari.
          "--vv-height": viewportHeight ? `${viewportHeight}px` : undefined,
          "--vv-width": viewportWidth ? `${viewportWidth}px` : undefined,
        }
      : {}),
    ...(isBelowMode ? { "--terminal-below-height": `${resolveTerminalBelowHeight()}px` } : {}),
  } as CSSProperties;

  /*
  FNXC:TerminalFooter 2026-07-11-20:20:
  FN-7829 keeps the single terminal action-control cluster (reconnect/restart, font-size, Clear, Shortcuts toggle, Preferences toggle, connection status, exit code, and help text) in the bottom `.terminal-status-bar` footer at every breakpoint.

  FNXC:TerminalFooter 2026-09-15-07:57:
  FN-409 removed the pin toggle, so the header presentation fragment now carries exactly one control (detach/re-attach)
  beside close; the header still never renders `.terminal-actions`, preventing handler drift across all presentations.
  */
  const reopenSessionControl = detachedSessions.length > 0 ? (
    <>
      <button
        type="button"
        ref={reopenTriggerRef}
        className="terminal-reopen-btn"
        onClick={() => (reopenMenuOpen ? setReopenMenuOpen(false) : openReopenMenu())}
        aria-haspopup="listbox"
        aria-expanded={reopenMenuOpen}
        title={t("terminal.reopenSessionTitle", "Reopen a session still running on the server")}
        data-testid="terminal-reopen-btn"
      >
        <History size={14} />
        <span className="terminal-action-label">
          {t("terminal.reopenSession", "Reopen")} ({detachedSessions.length})
        </span>
      </button>
      {reopenMenuOpen && createPortal(
        <div
          ref={reopenMenuRef}
          className="terminal-reopen-menu"
          role="listbox"
          aria-label={t("terminal.reopenSessionTitle", "Reopen a session still running on the server")}
          data-testid="terminal-reopen-menu"
          style={{
            ...(reopenMenuPosition
              ? { left: reopenMenuPosition.left, bottom: reopenMenuPosition.bottom, minWidth: reopenMenuPosition.minWidth }
              : { visibility: "hidden", pointerEvents: "none" }),
            ...(reopenMenuZ ? { zIndex: reopenMenuZ } : {}),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="terminal-reopen-menu-label">
            {t("terminal.reopenSessionHeading", "Running on the server")}
          </div>
          {detachedSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="terminal-reopen-menu-option"
              role="option"
              aria-selected={false}
              onClick={() => {
                reopenSession(session.id);
                setReopenMenuOpen(false);
              }}
            >
              <span className="terminal-reopen-menu-option-main">
                <TerminalIcon size={14} />
                <span>{session.cwd ? session.cwd.split(/[\\/]+/).filter(Boolean).pop() : session.shell}</span>
              </span>
              <span className="terminal-reopen-menu-option-meta">{session.cwd}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  ) : null;

  const terminalActionControls = (
    <>
      {reopenSessionControl}
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
      <span className="terminal-font-size-controls terminal-font-size-controls--header">
        <button type="button" className="terminal-font-size-btn" onClick={handleDecreaseFontSize} data-testid="terminal-font-size-decrease" aria-label={t("terminal.decreaseFontSize", "Decrease terminal font size")}>
          <Minus size={14} />
        </button>
        <span className="terminal-font-size-value" data-testid="terminal-font-size-value">{fontSize}{TERMINAL_KEY_LABELS.pxUnit}</span>
        <button type="button" className="terminal-font-size-btn" onClick={handleIncreaseFontSize} data-testid="terminal-font-size-increase" aria-label={t("terminal.increaseFontSize", "Increase terminal font size")}>
          <Plus size={14} />
        </button>
      </span>
      <button className="terminal-clear-btn" onClick={handleClear} data-testid="terminal-clear-btn" title={t("terminal.clearTerminal", "Clear terminal")}>
        <Trash2 size={14} />
        <span className="terminal-action-label">{t("terminal.clear", "Clear")}</span>
      </button>
      <button className="terminal-clear-btn terminal-clear-btn--shortcut" onClick={() => setShowShortcuts((current) => !current)} data-testid="terminal-shortcut-toggle" title={t("terminal.shortcuts", "Shortcuts")} aria-pressed={showShortcuts}>
        <Keyboard size={14} />
        <span className="terminal-action-label">{t("terminal.shortcuts", "Shortcuts")}</span>
      </button>
      <button className="terminal-clear-btn terminal-clear-btn--shortcut" onClick={() => setShowPreferences((current) => !current)} data-testid="terminal-preferences-toggle" title={t("terminal.preferences", "Preferences")} aria-pressed={showPreferences}>
        <Settings size={14} />
        <span className="terminal-action-label">{t("terminal.preferences", "Preferences")}</span>
      </button>
      {/*
      FNXC:Terminal 2026-07-12-00:00:
      The terminal footer should not repeat steady-state "Connected" text or persistent zoom/shortcuts/escape help copy because the footer is crowded.
      Keep only actionable non-connected status text here; the header status dot still conveys the connected state visually.
      */}
      <span className={`terminal-connection-status ${connectionStatus}`}>
        {connectionStatus === "connecting" && t("terminal.statusConnecting", "Connecting...")}
        {connectionStatus === "reconnecting" && t("terminal.statusReconnecting", "Reconnecting...")}
        {connectionStatus === "disconnected" && t("terminal.statusDisconnected", "Disconnected")}
      </span>
      {exitCode !== null && <span className="terminal-exit-code" data-testid="terminal-exit-code">{t("terminal.exitLabel", "Exit: {{code}}", { code: exitCode })}</span>}
    </>
  );

  /*
  FNXC:TerminalModalControls 2026-09-15-22:32:
  FN-438 REMOVES the last presentation control from the terminal toolbar. Switching between pinned and detached
  is now purely a pointer gesture — drag the pinned header out, drag the window's bottom edge back onto the
  bottom bar — exactly like moving, resizing, and docking every other dashboard window, which expose no button
  either. The operator asked for the button's removal explicitly; do not reintroduce a button, menu entry, or any
  other visible toggle affordance here. No empty container or orphaned spacing is left behind: the header renders
  tabs → workspace picker → status title → close.
  */

  /*
  FNXC:TerminalModalControls 2026-08-01-03:48:
  The floating terminal must be movable by dragging the empty strip space behind the tabs and
  anywhere else in the top toolbar, not only the reserved grip (operator request following
  FN-8633). Only a press that starts inside a real tab surface (`.terminal-tab`, which includes
  the close and new-tab buttons) stays a tab interaction; empty strip space bubbles to the
  FloatingWindow `.terminal-header` delegated drag handle. Tab presses keep stopPropagation so
  they can never leave a captured header drag behind, and an overflowing strip is replaced by
  the `.terminal-mobile-tabs` dropdown, so no visible strip ever needs horizontal panning.
  */
  const renderTerminalTabStrip = (measuring = false) => (
    <div
      ref={measuring || !tabsOverflow ? terminalTabsMeasureRef : undefined}
      className={`terminal-tabs${measuring ? " terminal-tabs--measuring" : ""}`}
      data-testid={measuring ? "terminal-tabs-measuring" : "terminal-tabs"}
      aria-hidden={measuring || undefined}
      onPointerDown={measuring ? undefined : (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".terminal-tab")) event.stopPropagation();
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`terminal-tab ${tab.isActive ? "terminal-tab--active" : ""}`}
          onClick={measuring ? undefined : () => setActiveTab(tab.id)}
          title={tab.title}
          role={measuring ? undefined : "tab"}
          aria-selected={measuring ? undefined : tab.isActive}
        >
          <span className="terminal-tab-label">{tab.title}</span>
          {tabs.length > 1 && (
            <button
              className="terminal-tab-close"
              disabled={measuring}
              tabIndex={measuring ? -1 : undefined}
              onClick={measuring ? undefined : (e: ReactMouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                void requestCloseTab(tab.id);
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
        disabled={measuring}
        tabIndex={measuring ? -1 : undefined}
        onClick={measuring ? undefined : () => void createTab()}
        title={t("terminal.newTerminal", "New terminal")}
        aria-label={t("terminal.newTerminal", "New terminal")}
        data-testid="terminal-new-tab"
      >
        +
      </button>
    </div>
  );

  const renderTerminalMobileTabs = () => (
    <div className="terminal-mobile-tabs" data-testid="terminal-mobile-tabs">
      <label className="terminal-mobile-tabs-label" htmlFor="terminal-mobile-tab-select">
        {t("terminal.selectTab", "Terminal tab")}
      </label>
      <select
        id="terminal-mobile-tab-select"
        className="input terminal-mobile-tab-select"
        data-testid="terminal-mobile-tab-select"
        value={activeTab?.id ?? ""}
        onChange={(event) => {
          if (event.currentTarget.value) setActiveTab(event.currentTarget.value);
        }}
        disabled={tabs.length === 0}
        aria-label={t("terminal.selectTab", "Terminal tab")}
      >
        {tabs.length === 0 && (
          <option value="">{t("terminal.noTabs", "No terminal tabs")}</option>
        )}
        {tabs.map((tab) => (
          <option key={tab.id} value={tab.id}>{tab.title}</option>
        ))}
      </select>
      <button
        type="button"
        className="terminal-mobile-tab-action terminal-mobile-tab-action--new"
        onClick={() => void createTab()}
        aria-label={t("terminal.newTerminal", "New terminal")}
        data-testid="terminal-mobile-new-tab"
      >
        <Plus size={14} />
      </button>
      {tabs.length > 1 && activeTab && (
        <button
          type="button"
          className="terminal-mobile-tab-action terminal-mobile-tab-action--close"
          onClick={() => void requestCloseTab(activeTab.id)}
          title={t("terminal.closeCurrentTab", "Close current tab")}
          aria-label={t("terminal.closeCurrentTab", "Close current tab")}
          data-testid="terminal-mobile-close-tab"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );

  const terminalContent = (
    <div
      ref={modalRef}
      className={modalClassName}
      data-testid="terminal-modal"
      style={modalStyle}
      role={isBelowMode ? "region" : undefined}
      aria-label={isBelowMode ? t("terminal.belowRegion", "Pinned terminal") : undefined}
      {...(mobileDrawer ? dismissHandleProps : {})}
    >
        {mobileDrawer && (
          <ViewDrawerHandle className="terminal-drawer-handle-target" barClassName="terminal-drawer-handle" data-testid="terminal-drawer-handle" />
        )}
        {/*
        FNXC:TerminalLayout 2026-09-15-21:04:
        FN-434: this grip is a DETACH affordance, not a separator between two resizable regions, so it is a plain
        labelled target rather than `role="separator"`/`aria-orientation`.
        */}
        {!embedded && isBelowMode && (
          <div
            className="terminal-below-drag-handle"
            data-testid="terminal-pinned-drag-handle"
            role="button"
            tabIndex={-1}
            aria-label={t("terminal.detachHandle", "Detach terminal into a window")}
            onPointerDown={handlePinnedDetachPointerDown}
          />
        )}
        {/* Header — on mobile (≤768px) use compact selector/actions;
            .terminal-title is hidden; action button labels are hidden (icons only) */}
        {/*
        FNXC:TerminalLayout 2026-09-15-22:32:
        FN-438: in the pinned presentation the header IS the detach handle, mirroring the detached presentation's
        `dragHandleSelector=".terminal-header"`. Mobile and embedded terminals arm nothing, because neither owns
        its own presentation.
        */}
        <ViewLayoutHeader
          className="terminal-header"
          onPointerDown={!embedded && !isMobileTerminal && isBelowMode ? handlePinnedDetachPointerDown : undefined}
        >
          {/*
          FNXC:TerminalModalControls 2026-07-31-22:19:
          Tablet floating terminals need a reserved, real pointer target because the flexing tab
          strip otherwise consumes the entire delegated header handle. This plain element—not a
          pseudo-element—is the testable drag target and remains outside the interactive-element
          suppression filter in FloatingWindow.
          */}
          {isTabletTerminal && !isMobileTerminal && !embedded && isFloatingMode && (
            <div className="terminal-header__drag-grip" data-testid="terminal-drag-grip" aria-hidden="true" />
          )}
          {/* Tab Bar */}
          {isMobileTerminal ? renderTerminalMobileTabs() : (
            <div className="terminal-tab-region" ref={terminalTabRegionRef}>
              {tabsOverflow ? (
                <>
                  {renderTerminalMobileTabs()}
                  {renderTerminalTabStrip(true)}
                </>
              ) : renderTerminalTabStrip()}
            </div>
          )}

          {/*
          FNXC:TerminalTabs 2026-07-11-20:28:
          FN-7829 keeps mobile on the existing native tab dropdown and also reuses that same `.terminal-mobile-tabs` affordance when a non-mobile terminal tab region is too narrow for the horizontal `.terminal-tabs` strip. The overflow decision comes from the tab container's ResizeObserver, not `isMobileTerminal`/viewport width, so narrow floated/docked desktop panels can collapse independently and expand back when room returns.
          */}

          {shouldShowTerminalWorkspacePicker && (
            <div
              ref={terminalWorkspacePickerRef}
              className="terminal-workspace-picker"
              data-testid="terminal-workspace-picker"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                ref={terminalWorkspaceTriggerRef}
                className="terminal-workspace-picker-trigger"
                onClick={() => setTerminalWorkspaceMenuOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={terminalWorkspaceMenuOpen}
                aria-controls={terminalWorkspaceMenuOpen ? "terminal-workspace-picker-menu" : undefined}
                aria-label={t("terminal.selectWorkspaceWithCurrent", "Select terminal workspace: {{workspace}}", { workspace: selectedTerminalWorkspaceLabel })}
                title={t("terminal.selectWorkspace", "Select terminal workspace")}
              >
                {selectedTerminalWorkspaceId === "project" ? <FolderRoot size={14} /> : <FolderGit2 size={14} />}
                <span className="terminal-workspace-picker-label">{selectedTerminalWorkspaceLabel}</span>
                <ChevronDown size={14} className={`terminal-workspace-picker-chevron${terminalWorkspaceMenuOpen ? " open" : ""}`} />
              </button>
              <button
                type="button"
                className="terminal-workspace-picker-open"
                onClick={handleOpenSelectedTerminalWorkspace}
                disabled={!selectedTerminalWorkspaceCanOpen}
                title={
                  selectedTerminalWorkspaceCanOpen
                    ? t("terminal.openWorkspaceTerminal", "Open terminal in selected workspace")
                    : t("terminal.workspaceMissingWorktree", "This task has no worktree path yet")
                }
                aria-label={t("terminal.openWorkspaceTerminal", "Open terminal in selected workspace")}
              >
                <Plus size={14} />
              </button>
              {terminalWorkspaceMenuOpen && createPortal(
                <div
                  ref={terminalWorkspaceMenuRef}
                  id="terminal-workspace-picker-menu"
                  className="terminal-workspace-picker-menu"
                  role="listbox"
                  aria-label={t("terminal.selectWorkspace", "Select terminal workspace")}
                  style={{
                    ...(terminalWorkspaceMenuPosition
                      ? {
                          top: terminalWorkspaceMenuPosition.top,
                          left: terminalWorkspaceMenuPosition.left,
                          width: terminalWorkspaceMenuPosition.width,
                          maxHeight: terminalWorkspaceMenuPosition.maxHeight,
                        }
                      : {}),
                    ...(terminalWorkspaceMenuFloatingZ ? { zIndex: terminalWorkspaceMenuFloatingZ } : {}),
                    ...(!terminalWorkspaceMenuPosition ? { visibility: "hidden", pointerEvents: "none" } : {}),
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className={`terminal-workspace-picker-option${selectedTerminalWorkspaceId === "project" ? " active" : ""}`}
                    onClick={() => {
                      terminalWorkspaceSelectionTouchedRef.current = true;
                      setSelectedTerminalWorkspaceId("project");
                      setTerminalWorkspaceMenuOpen(false);
                    }}
                    role="option"
                    aria-selected={selectedTerminalWorkspaceId === "project"}
                  >
                    <div className="terminal-workspace-picker-option-main">
                      <FolderRoot size={14} />
                      <span>{t("terminal.projectRoot", "Project Root")}</span>
                    </div>
                    <span className="terminal-workspace-picker-option-meta">{terminalWorkspaceProjectName}</span>
                  </button>
                  <div className="terminal-workspace-picker-group-label">
                    {terminalWorkspacesLoading
                      ? t("terminal.loadingWorkspaces", "Task worktrees (refreshing…)")
                      : t("terminal.taskWorktrees", "Task Worktrees")}
                  </div>
                  {terminalWorkspaces.map((workspace) => {
                    const disabled = !workspace.worktree;
                    return (
                      <button
                        key={workspace.id}
                        type="button"
                        className={`terminal-workspace-picker-option${selectedTerminalWorkspaceId === workspace.id ? " active" : ""}${disabled ? " disabled" : ""}`}
                        onClick={() => {
                          if (disabled) return;
                          terminalWorkspaceSelectionTouchedRef.current = true;
                          setSelectedTerminalWorkspaceId(workspace.id);
                          setTerminalWorkspaceMenuOpen(false);
                        }}
                        disabled={disabled}
                        role="option"
                        aria-selected={selectedTerminalWorkspaceId === workspace.id}
                        aria-disabled={disabled}
                        title={disabled ? t("terminal.workspaceMissingWorktree", "This task has no worktree path yet") : workspace.title}
                      >
                        <div className="terminal-workspace-picker-option-main">
                          <FolderGit2 size={14} />
                          <span>{workspace.label}</span>
                        </div>
                        <span className="terminal-workspace-picker-option-meta">
                          {disabled
                            ? t("terminal.noWorktree", "No worktree")
                            : (workspace.title ?? workspace.worktree)}
                        </span>
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}
            </div>
          )}
          
          {/* Status indicator */}
          {(!isMobileTerminal || embedded) && (
            <div className="terminal-title" data-testid="terminal-title">
              <TerminalIcon size={16} />
              {getStatusIndicator()}
            </div>
          )}

          {/*
          FNXC:TerminalModalControls 2026-09-15-07:57:
          Every non-embedded terminal has exactly one modal-close control, rendered after the
          tab region (including its new-terminal affordance), optional workspace picker, status
          title, and — since FN-438 removed the detach/re-attach button — nothing else. Keeping one shared final
          render site makes the close-after-plus, far-right contract structural for desktop, tablet,
          ResizeObserver overflow, and mobile.
          Mobile keeps the corner class so its explicit flex order remains last; embedded terminals
          intentionally render no modal-close control because their parent owns dismissal.
          */}
          {!embedded && !mobileDrawer && (
            <ModalCloseButton
              className={`terminal-close${isMobileTerminal ? " terminal-close--corner" : ""}`}
              onClick={onClose}
              data-testid="terminal-close-btn"
              title={t("terminal.closeTerminal", "Close terminal")}
              aria-label={t("terminal.closeTerminal", "Close terminal")}
            />
          )}
        </ViewLayoutHeader>

        {/* Error message */}
        {error && (
          <div className="terminal-error" data-testid="terminal-error">
            {error}
          </div>
        )}

        {/* Terminal container */}
        <ViewLayoutContent className="terminal-container" data-testid="terminal-container">
          {isLoading && !bootstrapError && !showManualStart && (
            <div className="terminal-loading" data-testid="terminal-loading">
              <div className="terminal-spinner" />
              <span>{t("terminal.startingTerminal", "Starting terminal...")}</span>
            </div>
          )}
          {showManualStart && (
            <div className="terminal-loading" data-testid="terminal-manual-start">
              <div className="terminal-error-content">
                <span>{t("terminal.manualStartHint", "The terminal is ready — start a session to begin.")}</span>
                <div className="terminal-error-actions">
                  <button
                    className="terminal-retry-btn"
                    onClick={() => {
                      if (isStartingTerminal) return;
                      setIsStartingTerminal(true);
                      setError(null);
                      createTab()
                        .catch((err) => {
                          const message = getErrorMessage(err);
                          setError(t("terminal.manualStartError", "Failed to start terminal: {{message}}", { message }));
                        })
                        .finally(() => {
                          setIsStartingTerminal(false);
                        });
                    }}
                    disabled={isStartingTerminal}
                    data-testid="terminal-manual-start-btn"
                  >
                    <Plus size={14} />
                    {t("terminal.startTerminal", "Start terminal")}
                  </button>
                </div>
              </div>
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
        </ViewLayoutContent>

        {showShortcuts && (
          <ViewLayoutFooter className="terminal-shortcut-panel" data-testid="terminal-shortcut-panel">
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
            {/**
             * FNXC:Terminal 2026-07-12-00:00:
             * FN-7872 user-defined shortcuts must inject their decoded value through the same sendLiteralShortcut path as built-in literal shortcuts. Keep the pointer/mouse/touch focus guards so the FN-6697/FN-6737 xterm-refocus invariant holds for custom buttons on desktop and touch surfaces.
             */}
            {terminalPreferences.customShortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                className="terminal-shortcut-btn terminal-shortcut-btn--custom"
                data-testid={`terminal-custom-shortcut-${shortcut.id}`}
                title={shortcut.label}
                aria-label={shortcut.label}
                onPointerDown={preserveShortcutFocus}
                onMouseDown={preserveShortcutFocus}
                onTouchStart={preserveShortcutFocus}
                onClick={() => sendLiteralShortcut(decodeTerminalShortcutSequence(shortcut.value))}
              >
                {shortcut.label}
              </button>
            ))}
          </ViewLayoutFooter>
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
            <section className="terminal-custom-shortcuts" data-testid="terminal-custom-shortcuts">
              <div className="terminal-custom-shortcuts__header">
                <div>
                  <h3>{t("terminal.customShortcutsTitle", "Custom shortcuts")}</h3>
                  <p className="terminal-preference-note">
                    {t(
                      "terminal.customShortcutsHelp",
                      "Use \\n for Enter, \\t for Tab, \\e or \\x1b for Esc, \\r for Return, and \\\\ for a literal backslash.",
                    )}
                  </p>
                </div>
                <span className="terminal-custom-shortcuts__count">
                  {terminalPreferences.customShortcuts.length}/{MAX_TERMINAL_CUSTOM_SHORTCUTS}
                </span>
              </div>
              {terminalPreferences.customShortcuts.length === 0 ? (
                <p className="terminal-custom-shortcuts__empty" data-testid="terminal-custom-shortcuts-empty">
                  {t("terminal.customShortcutsEmpty", "No custom shortcuts yet.")}
                </p>
              ) : (
                <ul className="terminal-custom-shortcuts__list" aria-label={t("terminal.customShortcutsList", "Custom terminal shortcuts")}>
                  {terminalPreferences.customShortcuts.map((shortcut) => (
                    <li key={shortcut.id} className="terminal-custom-shortcuts__row">
                      <span className="terminal-custom-shortcuts__summary">
                        <strong>{shortcut.label}</strong>
                        <code>{shortcut.value}</code>
                      </span>
                      <span className="terminal-custom-shortcuts__actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          data-testid={`terminal-custom-shortcut-edit-${shortcut.id}`}
                          onClick={() => startEditingCustomShortcut(shortcut)}
                        >
                          {t("common.edit", "Edit")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          data-testid={`terminal-custom-shortcut-remove-${shortcut.id}`}
                          onClick={() => removeCustomShortcut(shortcut.id)}
                        >
                          {t("common.remove", "Remove")}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="terminal-custom-shortcuts__form">
                <label className="terminal-preference-field">
                  <span>{t("terminal.customShortcutLabel", "Button label")}</span>
                  <input
                    className="input terminal-preference-control"
                    data-testid="terminal-custom-shortcut-label-input"
                    type="text"
                    maxLength={MAX_TERMINAL_CUSTOM_SHORTCUT_LABEL_LENGTH}
                    value={customShortcutLabel}
                    onChange={(event) => setCustomShortcutLabel(event.target.value)}
                  />
                </label>
                <label className="terminal-preference-field">
                  <span>{t("terminal.customShortcutValue", "Injected value")}</span>
                  <input
                    className="input terminal-preference-control"
                    data-testid="terminal-custom-shortcut-value-input"
                    type="text"
                    maxLength={MAX_TERMINAL_CUSTOM_SHORTCUT_VALUE_LENGTH}
                    value={customShortcutValue}
                    onChange={(event) => setCustomShortcutValue(event.target.value)}
                  />
                </label>
                <div className="terminal-custom-shortcuts__form-actions">
                  {isEditingCustomShortcut && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      data-testid="terminal-custom-shortcut-cancel"
                      onClick={resetCustomShortcutForm}
                    >
                      {t("common.cancel", "Cancel")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn terminal-custom-shortcuts__submit"
                    data-testid="terminal-custom-shortcut-add"
                    disabled={!canSubmitCustomShortcut}
                    onClick={submitCustomShortcut}
                  >
                    {isEditingCustomShortcut
                      ? t("terminal.customShortcutSave", "Save shortcut")
                      : t("terminal.customShortcutAdd", "Add shortcut")}
                  </button>
                </div>
              </div>
            </section>
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
        FNXC:TerminalFooter 2026-07-11-20:20:
        FN-7829 renders the shared `terminalActionControls` fragment in this bottom footer at every breakpoint, including true desktop and embedded terminals, so font-size/Clear/Shortcuts/Preferences/connection-status/exit-code stay reachable. Pin/pop-out render once in the non-mobile header beside close; this remains the only footer render site for the action cluster.
        */}
        <div className="terminal-status-bar" data-testid="terminal-footer-actions">
          {terminalActionControls}
        </div>

    </div>
  );

  /*
  FNXC:ModalTouchGeometry 2026-09-15-07:57:
  Only the detached terminal uses the shared floating host. Pinned, mobile, and embedded presentations retain
  their existing layout and lifecycle because they are not floating windows.

  FNXC:TerminalLayout 2026-09-15-07:57:
  FN-409 gives the detached terminal the SAME window contract as a task pop-out and a detached chat: the
  `task-detail` stacking band, the shared `window` surface group, a raise-to-front signal, and the standard
  task-window opening size. Edge snapping and click-to-front then behave identically across those windows.
  */
  const terminalPanel = isFloatingMode ? (
    <FloatingWindow
      title={t("terminal.title", "Terminal")}
      onClose={onClose}
      windowKey={`terminal-${projectId ?? "default"}`}
      defaultSize={{ width: TERMINAL_FLOAT_DEFAULT_WIDTH, height: TERMINAL_FLOAT_DEFAULT_HEIGHT }}
      minSize={{ width: TERMINAL_FLOAT_MIN_WIDTH, height: TERMINAL_FLOAT_MIN_HEIGHT }}
      layer="task-detail"
      surfaceGroup="window"
      raiseToFrontSignal={focusNonce}
      hideHeader
      dragHandleSelector=".terminal-header"
      onDragGestureEnd={handleFloatingDragGestureEnd}
      /* FNXC:TerminalLayout 2026-09-16-18:31: FN-469 — a detach in progress opens this window under the pointer and resumes the same drag. */
      dragHandoff={pinnedDetachHandoff}
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      ariaLabel={t("terminal.title", "Terminal")}
      className={modalClassName}
      testId="terminal-modal-overlay"
    >
      {terminalContent}
    </FloatingWindow>
  ) : terminalContent;

  if (embedded) {
    return (
      <div className="terminal-embedded-host" data-testid="terminal-embedded-host">
        {terminalPanel}
      </div>
    );
  }

  if (isBelowMode) {
    /*
    FNXC:TerminalLayout 2026-07-12-18:50:
    FN-7897 fixed the pinned terminal rendering underneath the fixed ExecutorStatusBar footer.
    .terminal-below-host is a sibling of .dashboard-project-shell inside .dashboard-project-stack
    (not a descendant), so it cannot rely on --executor-footer-height inherited from the shell — it
    must reserve the footer's height itself via the --with-footer modifier, following the same
    footerVisible-prop convention used by .project-content--with-footer/.left-sidebar-nav--with-footer/.right-dock--with-footer.
    */
    return (
      <div
        className={`terminal-below-host${footerVisible ? " terminal-below-host--with-footer" : ""}`}
        data-testid="terminal-below-host"
      >
        {terminalPanel}
      </div>
    );
  }

  if (isFloatingMode) return terminalPanel;

  // FNXC:TerminalLayout 2026-09-15-07:57: FN-409 leaves this portal host to the mobile sheet alone; the retired docked overlay was its only other user.
  return createPortal(
    <DashboardWindowSurfaceRoot
      logicalId={`terminal-${projectId ?? "default"}-mobile`}
      group="drawer"
      className={overlayClassName}
      onMouseDown={handleOverlayMouseDown}
      onMouseUp={handleOverlayMouseUp}
      role="dialog"
      aria-modal="true"
      data-testid="terminal-modal-overlay"
      style={{
        ...(keyboardOverlap > 0 ? { "--overlay-padding-top": "0px" } : {}),
      } as CSSProperties}
    >
      {terminalPanel}
    </DashboardWindowSurfaceRoot>,
    document.body,
  );
}
