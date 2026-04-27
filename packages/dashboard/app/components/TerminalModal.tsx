import "./TerminalModal.css";
import { useState, useEffect, useRef, useCallback } from "react";
import { getErrorMessage } from "@fusion/core";
import {
  X,
  Trash2,
  Terminal as TerminalIcon,
  RefreshCw,
  Minus,
  Plus,
  Keyboard,
} from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { useTerminalSessions } from "../hooks/useTerminalSessions";
import "@xterm/xterm/css/xterm.css";

import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/** Timeout for xterm.js dynamic imports + terminal.open() setup. */
const XTERM_INIT_TIMEOUT_MS = 10000;

const XTERM_IMPORT_RETRY_DELAYS_MS = [500, 1500, 3000] as const;
const TERMINAL_FONT_SIZE_KEY = "kb-terminal-font-size";
const DEFAULT_FONT_SIZE = 14;
const MIN_TERMINAL_FONT_SIZE = 8;
const MAX_TERMINAL_FONT_SIZE = 32;

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

function clampTerminalFontSize(value: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, value));
}

function readInitialTerminalFontSize(): number {
  if (typeof window === "undefined") {
    return DEFAULT_FONT_SIZE;
  }

  try {
    const savedFontSize = window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY);
    if (!savedFontSize) {
      return DEFAULT_FONT_SIZE;
    }

    const parsed = Number.parseInt(savedFontSize, 10);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_FONT_SIZE;
    }

    return clampTerminalFontSize(parsed);
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

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
export function TerminalModal({ isOpen, onClose, initialCommand, projectId }: TerminalModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [xtermReady, setXtermReady] = useState(false);
  const [xtermInitError, setXtermInitError] = useState<string | null>(null);
  const [openGeneration, setOpenGeneration] = useState(0);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState<number>(() => readInitialTerminalFontSize());
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [stickyModifier, setStickyModifier] = useState<null | "ctrl" | "alt">(null);
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  const hasInitialCommandRun = useRef<string | false>(false);
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
  /** Tracks a pending requestAnimationFrame for deferred xterm re-fit. */
  const pendingFitRef = useRef<number | null>(null);
  /** Tracks the previous projectId to detect project switches and invalidate xterm. */
  const previousProjectIdRef = useRef<string | undefined>(projectId);

  // Keep the latest keyboard overlap in a ref so async xterm setup can read
  // current mobile keyboard state without forcing the init effect to re-run.
  keyboardOverlapRef.current = keyboardOverlap;
  fontSizeRef.current = fontSize;

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
  useEffect(() => {
    if (isOpen) {
      setOpenGeneration((g) => g + 1);
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

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      // Cancel any pending deferred fit
      if (pendingFitRef.current !== null) {
        cancelAnimationFrame(pendingFitRef.current);
        pendingFitRef.current = null;
      }
      setKeyboardOverlap(0);
      setViewportHeight(null);
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(fontSize));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [fontSize]);

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

        // Create terminal instance
        terminal = new TerminalCtor({
          cursorBlink: true,
          cursorStyle: "block",
          fontSize: fontSizeRef.current,
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
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

        // Try to load WebGL addon for better performance
        // Skip WebGL on mobile devices to avoid rendering artifacts (e.g., garbled
        // Unicode characters in powerline prompt symbols on iOS Safari/WebKit).
        if (!isMobileDevice()) {
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
  }, [fitAndResizeForSession, isOpen, isReady, activeTab?.sessionId, projectId]);

  // (Input forwarding + window resize listener are wired inside initTerminal
  // so they share the xterm instance's lifetime — see comment there.)

  // Cleanup xterm when modal closes
  useEffect(() => {
    if (isOpen) return;

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
    setError(null);
    setExitCode(null);
    setShowShortcuts(false);
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
      updateTabTitle(activeTab.id, info.shell.split("/").pop() || info.shell);
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
  // Tracks the last command that was sent so that a new command provided
  // while the terminal is already open (e.g., running a different script)
  // will be executed immediately without requiring a modal close/reopen.
  // Depends on openGeneration so the command re-fires after close/reopen.
  useEffect(() => {
    if (connectionStatus === "connected" && initialCommand && hasInitialCommandRun.current !== initialCommand && activeTab) {
      hasInitialCommandRun.current = initialCommand;
      // Small delay to let shell initialize
      setTimeout(() => {
        sendInput(initialCommand + "\n");
      }, 500);
    }
  }, [connectionStatus, initialCommand, sendInput, activeTab, openGeneration]);

  useEffect(() => {
    if (!xtermReady || !xtermRef.current) {
      return;
    }

    xtermRef.current.options.fontSize = fontSize;

    // Defer fit until the next frame so layout reflects the new font metrics
    // before FitAddon measures rows/cols. Reuse pendingFitRef so font-size and
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
  }, [fontSize, xtermReady, refitTerminal]);

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
        setFontSize(DEFAULT_FONT_SIZE);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, refitTerminal]);

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

  // Handle overlay click to close
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
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
  }, []);

  const handleDecreaseFontSize = useCallback(() => {
    setFontSize((current) => clampTerminalFontSize(current - 1));
  }, []);

  const toggleModifier = useCallback((modifier: "ctrl" | "alt") => {
    setStickyModifier((current) => (current === modifier ? null : modifier));
  }, []);

  const sendShortcutKey = useCallback(
    (key: string) => {
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
    },
    [sendInput, stickyModifier],
  );

  const sendLiteralShortcut = useCallback(
    (value: string) => {
      sendInput(value);
      setStickyModifier(null);
    },
    [sendInput],
  );

  if (!isOpen) return null;

  const getStatusIndicator = () => {
    switch (connectionStatus) {
      case "connected":
        return <span className="terminal-status connected" title="Connected" />;
      case "connecting":
      case "reconnecting":
        return <span className="terminal-status connecting" title="Connecting..." />;
      case "disconnected":
        return <span className="terminal-status disconnected" title="Disconnected" />;
      default:
        return null;
    }
  };

  // Determine loading state — when bootstrapError or xtermInitError is set, we are NOT loading
  // (we have a definitive error to show instead of an indefinite spinner).
  const isLoading = !isReady || (!activeTab && !bootstrapError) || (!xtermReady && !xtermInitError);

  return (
    <div
      className="modal-overlay open"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      data-testid="terminal-modal-overlay"
      style={
        keyboardOverlap > 0
          ? {
              "--overlay-padding-top": "0px",
            } as React.CSSProperties
          : undefined
      }
    >
      <div
        ref={modalRef}
        className="modal terminal-modal"
        data-testid="terminal-modal"
        style={
          keyboardOverlap > 0
            ? {
                "--keyboard-overlap": `${keyboardOverlap}px`,
                // On mobile with keyboard open, constrain to visualViewport height
                // so the modal (including status bar) fits entirely above the keyboard.
                // This is more reliable than 100dvh which behaves differently
                // across Chrome Android vs iOS Safari.
                "--vv-height": viewportHeight ? `${viewportHeight}px` : undefined,
              } as React.CSSProperties
            : undefined
        }
      >
        {/* Header — on mobile (≤768px) flex-wrap stacks tabs and actions on separate rows;
            .terminal-title is hidden; action button labels are hidden (icons only) */}
        <div className="terminal-header">
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
                    title="Close tab"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              className="terminal-tab terminal-tab--new"
              onClick={createTab}
              title="New terminal"
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
                title="Reconnect"
                data-testid="terminal-reconnect-btn"
              >
                <RefreshCw size={14} />
                <span className="terminal-action-label">Reconnect</span>
              </button>
            )}
            {exitCode !== null && (
              <button
                className="terminal-restart-btn"
                onClick={handleRestart}
                title="New Session"
                data-testid="terminal-restart-btn"
              >
                <RefreshCw size={14} />
                <span className="terminal-action-label">New Session</span>
              </button>
            )}
            <button
              className="terminal-clear-btn"
              onClick={handleClear}
              data-testid="terminal-clear-btn"
              title="Clear terminal"
            >
              <Trash2 size={14} />
              <span className="terminal-action-label">Clear</span>
            </button>
            <button
              className="terminal-clear-btn"
              onClick={() => setShowShortcuts((current) => !current)}
              data-testid="terminal-shortcut-toggle"
              title="Shortcuts"
              aria-pressed={showShortcuts}
            >
              <Keyboard size={14} />
              <span className="terminal-action-label">Shortcuts</span>
            </button>
            <button
              className="terminal-close"
              onClick={onClose}
              data-testid="terminal-close-btn"
              title="Close terminal"
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
              <span>Starting terminal...</span>
            </div>
          )}
          {bootstrapError && !activeTab && (
            <div className="terminal-loading" data-testid="terminal-bootstrap-error">
              <div className="terminal-error-content">
                <span>Failed to start terminal: {bootstrapError}</span>
                <div className="terminal-error-actions">
                  <button
                    className="terminal-retry-btn"
                    onClick={retryBootstrap}
                    data-testid="terminal-retry-btn"
                  >
                    <RefreshCw size={14} />
                    Retry
                  </button>
                  <button
                    className="terminal-retry-btn"
                    onClick={handleRefreshPage}
                    data-testid="terminal-bootstrap-refresh-btn"
                  >
                    <RefreshCw size={14} />
                    Refresh page
                  </button>
                </div>
              </div>
            </div>
          )}
          {xtermInitError && activeTab && (
            <div className="terminal-loading" data-testid="terminal-xterm-init-error">
              <div className="terminal-error-content">
                <span>Terminal UI failed to initialize: {xtermInitError}</span>
                <div className="terminal-error-actions">
                  <button
                    className="terminal-retry-btn"
                    onClick={handleReinitialize}
                    data-testid="terminal-reinit-btn"
                  >
                    <RefreshCw size={14} />
                    Reinitialize
                  </button>
                  <button
                    className="terminal-retry-btn"
                    onClick={handleRefreshPage}
                    data-testid="terminal-xterm-refresh-btn"
                  >
                    <RefreshCw size={14} />
                    Refresh page
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
                onClick={() => toggleModifier("ctrl")}
                aria-pressed={stickyModifier === "ctrl"}
              >
                Ctrl
              </button>
              <button
                type="button"
                className={`terminal-shortcut-btn terminal-shortcut-btn--modifier ${
                  stickyModifier === "alt" ? "is-active" : ""
                }`}
                data-testid="terminal-modifier-alt"
                onClick={() => toggleModifier("alt")}
                aria-pressed={stickyModifier === "alt"}
              >
                Alt
              </button>
              <button
                type="button"
                className="terminal-shortcut-btn"
                onClick={() => sendLiteralShortcut("\x1b")}
              >
                ESC
              </button>
              <button
                type="button"
                className="terminal-shortcut-btn"
                onClick={() => sendLiteralShortcut("\t")}
              >
                Tab
              </button>
            </div>
            {SHORTCUT_KEYS.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                className="terminal-shortcut-btn"
                onClick={() => sendShortcutKey(shortcut.key)}
                title={shortcut.description}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        )}

        {/* Connection status bar */}
        <div className="terminal-status-bar" data-testid="terminal-status-bar">
          <span className={`terminal-connection-status ${connectionStatus}`}>
            {connectionStatus === "connected" && "Connected"}
            {connectionStatus === "connecting" && "Connecting..."}
            {connectionStatus === "reconnecting" && "Reconnecting..."}
            {connectionStatus === "disconnected" && "Disconnected"}
          </span>
          {exitCode !== null && (
            <span className="terminal-exit-code" data-testid="terminal-exit-code">
              Exit: {exitCode}
            </span>
          )}
          <span className="terminal-font-size-controls">
            <button
              type="button"
              className="terminal-font-size-btn"
              onClick={handleDecreaseFontSize}
              data-testid="terminal-font-size-decrease"
              aria-label="Decrease terminal font size"
            >
              <Minus size={14} />
            </button>
            <span className="terminal-font-size-value" data-testid="terminal-font-size-value">
              {fontSize}px
            </span>
            <button
              type="button"
              className="terminal-font-size-btn"
              onClick={handleIncreaseFontSize}
              data-testid="terminal-font-size-increase"
              aria-label="Increase terminal font size"
            >
              <Plus size={14} />
            </button>
          </span>
          <span className="terminal-shortcuts">
            Ctrl++/- zoom • ⌨ Shortcuts panel • Esc close
          </span>
        </div>
      </div>
    </div>
  );
}
