import "./SessionTerminal.css";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as TerminalIcon, ShieldAlert, Settings, Eye } from "lucide-react";
import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import { appendTokenQuery } from "../auth";
import { api } from "../api";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { isMobileViewport, MOBILE_MEDIA_QUERY } from "../hooks/useViewportMode";
import {
  TERMINAL_PREFERENCES_KEY,
  readTerminalPreferences,
  resolveTerminalFontFamily,
  resolveTerminalGlyphFontFamily,
  waitForTerminalFontMetrics,
} from "../utils/terminalPreferences";

/**
 * SessionTerminal (CLI Agent Executor, U11) — shared xterm terminal for a CLI
 * agent session. Lazy-loads xterm + fit/webgl/unicode11 addons (kept out of the
 * main bundle), bridges to the U10 WebSocket attach channel with ACK flow
 * control, and renders the posture chip / read-only badge / confirm-advance
 * strip / replay states described in the U11 visibility matrix.
 *
 * The WS bridge:
 *  1. POST /api/cli-sessions/:id/attach-ticket  → { ticket }
 *  2. open WS /api/cli-sessions/ws?sessionId=&ticket=  (fn_token carried on URL)
 *  3. base64 scrollback/data → term.write; term.onData → input frames
 *  4. fit + debounced ResizeObserver → resize frames
 *  5. ACK {type:"ack",bytes} via term.write callbacks (~32KB cadence)
 */

/** ACK cadence — ACK roughly every 32KB of consumed output. */
const ACK_THRESHOLD_BYTES = 32 * 1024;
const RESIZE_DEBOUNCE_MS = 100;

/**
 * Control sequences emitted by the accessory key bar (U13). These are
 * deliberate user keystrokes routed straight to the session input path —
 * exempt from U2's injected-text neutralization (which governs composed /
 * injected strings, not real keystrokes).
 */
const SEQ_ESC = "\x1b"; // 0x1B
const SEQ_TAB = "\x09"; // 0x09
const SEQ_CTRL_C = "\x03"; // 0x03
const SEQ_ARROW_UP = "\x1b[A"; // CSI A
const SEQ_ARROW_DOWN = "\x1b[B"; // CSI B
const SEQ_ARROW_RIGHT = "\x1b[C"; // CSI C
const SEQ_ARROW_LEFT = "\x1b[D"; // CSI D

/**
 * Resolve the control byte for a sticky-Ctrl + key combination. Ctrl maps a
 * letter to its control code (A→0x01 … Z→0x1A): code = (toUpper(ch) & 0x1f).
 * Returns null for keys that have no meaningful Ctrl combination.
 */
function ctrlCombo(key: string): string | null {
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) {
    // @ A-Z [ \ ] ^ _  → 0x00-0x1F
    return String.fromCharCode(code & 0x1f);
  }
  return null;
}

/** Reactive mobile-viewport detection via the repo breakpoint convention. */
function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => isMobileViewport());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => setIsMobile(isMobileViewport());
    onChange();
    // Safari < 14 only has addListener/removeListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return isMobile;
}

/** The posture surfaced on the session record (denormalized at launch, U15). */
export interface SessionTerminalPosture {
  /** Adapter display name (single Terminal icon for all adapters). */
  adapterName: string;
  /** Resolved autonomy mode label (e.g. "auto-approve", "default"). */
  mode?: string;
  /**
   * Whether the resolved argv+env elevates above the adapter baseline. When
   * true the chip renders in warning color with a shield naming the flag.
   */
  elevated?: boolean;
  /** The elevated flag(s), named on the chip / tooltip when elevated. */
  elevatedFlags?: string[];
  /** Resolved posture lines shown in the click tooltip. */
  resolved?: string[];
}

/** Replay/live mode for the terminal viewport. */
export type SessionTerminalMode = "live" | "idle" | "ended";

export interface SessionTerminalProps {
  sessionId: string;
  /** When true, term.onData is dropped (one-shot / replay sessions). */
  readOnly?: boolean;
  posture?: SessionTerminalPosture;
  /** Drives the replay header: live | "session idle" | "session ended". */
  mode?: SessionTerminalMode;
  projectId?: string;
  /** Generic-tier idle confirm-advance strip — POST confirm-advance on Advance. */
  onConfirmAdvance?: (decision: "advance" | "not-yet") => void | Promise<void>;
  /** Whether the confirm-advance strip is offered (generic-tier idle). */
  showConfirmAdvance?: boolean;
  /** Settings deep link for the posture chip tooltip. */
  onOpenAdapterSettings?: () => void;
}

interface AttachTicketResponse {
  ticket: string;
  expiresAt: string;
  readOnly: boolean;
}

/** Build the WS URL for the cli-sessions attach channel (mirrors useTerminal). */
function buildCliWsUrl(sessionId: string, ticket: string): string {
  if (typeof window === "undefined") return "";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base =
    `${protocol}//${window.location.host}/api/cli-sessions/ws` +
    `?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;
  return appendTokenQuery(base);
}

function decodeBase64ToString(b64: string): string {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    // atob → binary string → UTF-8 decode.
    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

export function SessionTerminal({
  sessionId,
  readOnly = false,
  posture,
  mode = "live",
  projectId,
  onConfirmAdvance,
  showConfirmAdvance = false,
  onOpenAdapterSettings,
}: SessionTerminalProps) {
  const { t } = useTranslation("app");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [postureTooltipOpen, setPostureTooltipOpen] = useState(false);
  const [advanceDismissed, setAdvanceDismissed] = useState(false);
  const [advancePending, setAdvancePending] = useState(false);

  // ── Mobile input model (U13) ───────────────────────────────────────────────
  const isMobile = useIsMobileViewport();
  // Only arm keyboard tracking on mobile (the hook no-ops off-mobile anyway).
  const { keyboardOpen, keyboardOverlap } = useMobileKeyboard({ enabled: isMobile });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mobileInput, setMobileInput] = useState("");
  // Sticky Ctrl: tap Ctrl, then the next tapped key combines into a control
  // sequence (Ctrl-C → 0x03, Ctrl-D → 0x04, Ctrl-Z → 0x1A).
  const [ctrlSticky, setCtrlSticky] = useState(false);

  /** Write raw bytes to the session input path (mobile bar + submit). */
  const sendInput = useCallback((data: string) => {
    if (!data) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  /**
   * Emit one accessory-bar key. If sticky Ctrl is active and the key has a
   * Ctrl combination, send the combined control byte and clear the modifier;
   * otherwise send the literal sequence. Keeps the input focused (the caller's
   * pointerdown preventDefault stops the blur).
   */
  const emitBarKey = useCallback(
    (seq: string) => {
      if (ctrlSticky) {
        const combined = ctrlCombo(seq);
        setCtrlSticky(false);
        if (combined) {
          sendInput(combined);
          return;
        }
      }
      sendInput(seq);
    },
    [ctrlSticky, sendInput],
  );

  /** iOS composer pattern: keep focus on the visible input when tapping a key. */
  const keepFocus = useCallback((e: { preventDefault: () => void }) => {
    e.preventDefault();
  }, []);

  const handleMobileSubmit = useCallback(
    (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.();
      // User-typed text + Enter — deliberate input, no neutralization.
      if (mobileInput) sendInput(mobileInput);
      sendInput("\r");
      setMobileInput("");
    },
    [mobileInput, sendInput],
  );

  /**
   * Input onChange. When sticky Ctrl is armed, the next typed character is
   * captured as a Ctrl combination (Ctrl-D `0x04`, Ctrl-Z `0x1A`, …) instead of
   * landing in the field — this is how Ctrl-letter chords beyond the bar's
   * dedicated Ctrl-C are reached on mobile. Otherwise the value updates
   * normally for free-text + Enter submit.
   */
  const handleMobileInputChange = useCallback(
    (next: string) => {
      if (ctrlSticky && next.length > mobileInput.length) {
        // The newly-typed character is the last one appended.
        const ch = next.slice(mobileInput.length, mobileInput.length + 1);
        const combined = ctrlCombo(ch);
        setCtrlSticky(false);
        if (combined) {
          sendInput(combined);
          return; // swallow — do not echo the raw key into the field
        }
      }
      setMobileInput(next);
    },
    [ctrlSticky, mobileInput, sendInput],
  );

  // Re-arm the strip whenever a fresh idle window is offered.
  useEffect(() => {
    if (showConfirmAdvance) setAdvanceDismissed(false);
  }, [showConfirmAdvance, sessionId]);

  const applyLiveTerminalPreferences = useCallback(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    const terminalPreferences = readTerminalPreferences();
    terminal.options.fontFamily = resolveTerminalFontFamily(terminalPreferences.fontFamily);
    containerRef.current?.style.setProperty(
      "--terminal-glyph-font-family",
      resolveTerminalGlyphFontFamily(terminalPreferences.fontFamily),
    );
    terminal.options.fontSize = terminalPreferences.fontSize;
    terminal.options.cursorStyle = terminalPreferences.cursorStyle;
    terminal.options.cursorBlink = terminalPreferences.cursorBlink && !readOnly && mode === "live";

    try {
      (fitAddonRef.current as { fit?: () => void } | null)?.fit?.();
    } catch {
      /* ignore transient measure failures */
    }
  }, [mode, readOnly]);

  /*
  FNXC:Terminal 2026-06-17-01:05:
  Font and cursor preferences live-apply through the shared storage key so SessionTerminal follows changes made in another terminal surface without remounting. Renderer remains excluded from this handler because renderer addon teardown/re-attach only happens safely during the next session init.
  */
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== TERMINAL_PREFERENCES_KEY) {
        return;
      }
      applyLiveTerminalPreferences();
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyLiveTerminalPreferences]);

  // ── xterm lifecycle + WS bridge ──────────────────────────────────────────
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let unackedBytes = 0;

    const sendResize = (cols: number, rows: number) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };

    const ackBytes = (n: number) => {
      unackedBytes += n;
      if (unackedBytes < ACK_THRESHOLD_BYTES) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ack", bytes: unackedBytes }));
      }
      unackedBytes = 0;
    };

    const init = async () => {
      // 1. Mint a single-use attach ticket via the app API helper.
      let ticketRes: AttachTicketResponse;
      try {
        ticketRes = await api<AttachTicketResponse>(
          `/cli-sessions/${encodeURIComponent(sessionId)}/attach-ticket`,
          { method: "POST", body: JSON.stringify(projectId ? { projectId } : {}) },
        );
      } catch {
        return; // surfaced via the "disconnected" state header below
      }
      if (disposed) return;

      // 2. Lazy-load xterm + addons (out of the main bundle).
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
      ]);
      if (disposed || !containerRef.current) return;

      const terminalPreferences = readTerminalPreferences();
      const resolvedFontFamily = resolveTerminalFontFamily(terminalPreferences.fontFamily);
      containerRef.current.style.setProperty(
        "--terminal-glyph-font-family",
        resolveTerminalGlyphFontFamily(terminalPreferences.fontFamily),
      );

      /*
      FNXC:Terminal 2026-06-18-15:42:
      SessionTerminal shares TerminalModal's recurrence #5 root cause: FN-6638's 66.76px diagnostic compared only symbols-inclusive stacks, so real iOS Safari still let the loaded symbols @font-face pollute xterm's ASCII measurement. Pass only the symbols-free resolved family to xterm on this attach surface too; DOM glyph fallback is scoped to the viewport CSS variable and never to the xterm font option used by DOM/canvas measurement or desktop WebGL.

      FNXC:Terminal 2026-06-17-00:50:
      SessionTerminal consumes the shared localStorage terminal preferences for parity with TerminalModal, but replay safety still owns input posture: cursor blink is the user preference AND-gated by !readOnly && mode === "live" so read-only, idle, and ended sessions never blink.
      */
      const term = new Terminal({
        convertEol: false,
        cursorBlink: terminalPreferences.cursorBlink && !readOnly && mode === "live",
        cursorStyle: terminalPreferences.cursorStyle,
        disableStdin: readOnly,
        scrollback: 10000,
        // Defensive: do NOT register an OSC 52 (clipboard-write) handler. The
        // server-side neutralizer (U10) strips it; we add no client handling.
        fontFamily: resolvedFontFamily,
        fontSize: terminalPreferences.fontSize,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";

      term.open(containerRef.current);
      xtermRef.current = term;
      fitAddonRef.current = fitAddon as unknown as ITerminalAddon;

      /*
      FNXC:Terminal 2026-06-17-00:55:
      The embedded session terminal follows the shared renderer preference, but mobile viewports are a hard WebGL skip floor to avoid glyph artifacts in WebKit. Renderer changes are init-only because swapping xterm render addons mid-session is unsafe; users get the new renderer on the next mount/session.
      */
      const shouldLoadWebgl = terminalPreferences.renderer === "auto" && !isMobileViewport();
      if (shouldLoadWebgl) {
        // WebGL renderer with context-loss fallback to the DOM renderer.
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          if (!disposed) {
            const webgl = new WebglAddon();
            webgl.onContextLoss(() => {
              try {
                webgl.dispose();
              } catch {
                /* fall back to DOM renderer */
              }
            });
            term.loadAddon(webgl);
          }
        } catch {
          /* WebGL unavailable — DOM renderer is the default fallback */
        }
      }

      try {
        (fitAddon as unknown as { fit: () => void }).fit();
      } catch {
        /* container not measurable yet */
      }

      void (async () => {
        const fontMetricsSettled = await waitForTerminalFontMetrics(
          terminalPreferences.fontSize,
          resolvedFontFamily,
        );
        if (
          !fontMetricsSettled ||
          disposed ||
          xtermRef.current !== term ||
          fitAddonRef.current !== fitAddon
        ) {
          return;
        }
        try {
          /*
          FNXC:Terminal 2026-06-18-07:15:
          SessionTerminal shares TerminalModal's real-iOS DOM/canvas measurement path and the same user-selectable font presets. FN-6638 ruled out stack ordering with the 66.76px-identical diagnostic, so this attach surface must also reapply font options and refit after best-effort FontFaceSet settlement even when iOS rejects the multi-family shorthand; WebGL desktop remains safe because the same invalidation path refreshes renderer metrics without changing renderer selection.
          */
          term.options.fontFamily = resolvedFontFamily;
          term.options.fontSize = terminalPreferences.fontSize;
          (fitAddon as unknown as { fit: () => void }).fit();
          sendResize(term.cols, term.rows);
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          /* ignore teardown or transient measure failures */
        }
      })();

      // term.onData → input frames (skip entirely when read-only).
      if (!readOnly) {
        term.onData((data: string) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
        });
      }

      // Debounced ResizeObserver → resize frames.
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            (fitAddon as unknown as { fit: () => void }).fit();
            sendResize(term.cols, term.rows);
          } catch {
            /* ignore transient measure failures */
          }
        }, RESIZE_DEBOUNCE_MS);
      });
      resizeObserver.observe(containerRef.current);

      // 3. Open the WS attach channel.
      const ws = new WebSocket(buildCliWsUrl(sessionId, ticketRes.ticket));
      wsRef.current = ws;

      ws.onopen = () => {
        sendResize(term.cols, term.rows);
      };

      ws.onmessage = (event) => {
        let msg: { type?: string; data?: string };
        try {
          msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          return;
        }
        switch (msg.type) {
          case "scrollback":
          case "data": {
            if (typeof msg.data !== "string") return;
            const text = decodeBase64ToString(msg.data);
            const byteLen = text.length;
            // ACK once xterm has flushed the chunk to the screen.
            term.write(text, () => ackBytes(byteLen));
            break;
          }
          // state / error / exit frames are advisory; the SSE channel and the
          // mode prop drive header copy. We intentionally do not mutate the
          // viewport on them.
          default:
            break;
        }
      };
    };

    void init();

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (resizeObserver) resizeObserver.disconnect();
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        wsRef.current = null;
      }
      const term = xtermRef.current;
      if (term) {
        try {
          term.dispose();
        } catch {
          /* ignore */
        }
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
    };
  }, [sessionId, readOnly, mode, projectId]);

  const replayLabel = useMemo(() => {
    if (mode === "idle") return t("cliTerminal.replayIdle", "Session idle");
    if (mode === "ended") return t("cliTerminal.replayEnded", "Session ended");
    return null;
  }, [mode, t]);

  const handleAdvance = useCallback(async () => {
    if (!onConfirmAdvance) return;
    setAdvancePending(true);
    try {
      await onConfirmAdvance("advance");
      setAdvanceDismissed(true);
    } finally {
      setAdvancePending(false);
    }
  }, [onConfirmAdvance]);

  const handleNotYet = useCallback(async () => {
    if (onConfirmAdvance) await onConfirmAdvance("not-yet");
    // "Not yet" stays in execute and re-arms the idle timer (server-side); the
    // strip hides until the next idle window re-offers it.
    setAdvanceDismissed(true);
  }, [onConfirmAdvance]);

  const elevated = Boolean(posture?.elevated);
  const flagSummary = posture?.elevatedFlags?.join(", ");
  const terminalGlyphStyle = {
    "--terminal-glyph-font-family": resolveTerminalGlyphFontFamily(
      readTerminalPreferences().fontFamily,
    ),
  } as CSSProperties;

  return (
    <div
      className={`cli-session-terminal${isMobile ? " cli-session-terminal--mobile" : ""}${
        isMobile && keyboardOpen ? " cli-session-terminal--keyboard-open" : ""
      }`}
      data-mode={mode}
      data-read-only={readOnly}
      data-mobile={isMobile}
      data-keyboard-open={isMobile && keyboardOpen}
    >
      <header className="cli-session-terminal__header">
        {posture && (
          <div className="cli-session-terminal__posture-wrap">
            <button
              type="button"
              className={`cli-posture-chip${elevated ? " cli-posture-chip--elevated" : ""}`}
              data-elevated={elevated}
              aria-expanded={postureTooltipOpen}
              onClick={() => setPostureTooltipOpen((v) => !v)}
            >
              {elevated ? (
                <ShieldAlert size={13} aria-hidden="true" />
              ) : (
                <TerminalIcon size={13} aria-hidden="true" />
              )}
              <span className="cli-posture-chip__name">{posture.adapterName}</span>
              {posture.mode && (
                <span className="cli-posture-chip__mode">{posture.mode}</span>
              )}
              {elevated && flagSummary && (
                <span className="cli-posture-chip__flag">{flagSummary}</span>
              )}
            </button>
            {postureTooltipOpen && (
              <div className="cli-posture-tooltip" role="tooltip">
                <p className="cli-posture-tooltip__title">
                  {t("cliTerminal.postureResolved", "Resolved posture")}
                </p>
                <ul className="cli-posture-tooltip__list">
                  {(posture.resolved ?? []).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                  {(posture.resolved ?? []).length === 0 && (
                    <li>{posture.mode ?? t("cliTerminal.postureBaseline", "Baseline")}</li>
                  )}
                </ul>
                {onOpenAdapterSettings && (
                  <button
                    type="button"
                    className="cli-posture-tooltip__settings"
                    onClick={() => {
                      setPostureTooltipOpen(false);
                      onOpenAdapterSettings();
                    }}
                  >
                    <Settings size={12} aria-hidden="true" />
                    {t("cliTerminal.adapterSettings", "Adapter settings")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {readOnly && (
          <span className="cli-session-terminal__readonly-badge">
            <Eye size={12} aria-hidden="true" />
            {t("cliTerminal.readOnly", "Read-only")}
          </span>
        )}
        {replayLabel && (
          <span className="cli-session-terminal__replay-badge" data-replay-mode={mode}>
            {replayLabel}
          </span>
        )}
      </header>

      <div
        className="cli-session-terminal__viewport"
        ref={containerRef}
        data-testid="cli-terminal-viewport"
        style={terminalGlyphStyle}
      />

      {showConfirmAdvance && !advanceDismissed && (
        <div className="cli-session-terminal__advance-strip" role="region">
          <span className="cli-session-terminal__advance-copy">
            {t(
              "cliTerminal.advancePrompt",
              "This session looks idle — advance to review?",
            )}
          </span>
          <div className="cli-session-terminal__advance-actions">
            <button
              type="button"
              className="cli-session-terminal__advance-btn"
              disabled={advancePending}
              onClick={handleAdvance}
            >
              {t("cliTerminal.advance", "Advance")}
            </button>
            <button
              type="button"
              className="cli-session-terminal__advance-btn cli-session-terminal__advance-btn--secondary"
              disabled={advancePending}
              onClick={handleNotYet}
            >
              {t("cliTerminal.notYet", "Not yet")}
            </button>
          </div>
        </div>
      )}

      {isMobile && !readOnly && (
        <div
          className={`cli-session-terminal__mobile-bar${
            keyboardOpen ? " cli-session-terminal__mobile-bar--keyboard-open" : ""
          }`}
          data-testid="cli-terminal-mobile-bar"
          style={
            // Lift the fixed footer above the virtual keyboard when it's open.
            keyboardOpen ? { bottom: `${keyboardOverlap}px` } : undefined
          }
        >
          <div
            className="cli-session-terminal__key-row"
            data-testid="cli-terminal-key-bar"
          >
            <button
              type="button"
              className={`cli-terminal-key cli-terminal-key--ctrl${
                ctrlSticky ? " cli-terminal-key--active" : ""
              }`}
              data-testid="cli-key-ctrl"
              aria-label={t("cliTerminal.mobileKeyCtrl", "Sticky Ctrl modifier")}
              aria-pressed={ctrlSticky}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => setCtrlSticky((v) => !v)}
            >
              Ctrl
            </button>
            <button
              type="button"
              className="cli-terminal-key"
              data-testid="cli-key-esc"
              aria-label={t("cliTerminal.mobileKeyEsc", "Send Escape")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => emitBarKey(SEQ_ESC)}
            >
              Esc
            </button>
            <button
              type="button"
              className="cli-terminal-key"
              data-testid="cli-key-tab"
              aria-label={t("cliTerminal.mobileKeyTab", "Send Tab")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => emitBarKey(SEQ_TAB)}
            >
              Tab
            </button>
            <button
              type="button"
              className="cli-terminal-key cli-terminal-key--ctrlc"
              data-testid="cli-key-ctrl-c"
              aria-label={t("cliTerminal.mobileKeyCtrlC", "Send Ctrl-C")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => {
                // Dedicated shortcut: always Ctrl-C, regardless of sticky state.
                setCtrlSticky(false);
                sendInput(SEQ_CTRL_C);
              }}
            >
              ^C
            </button>
            <button
              type="button"
              className="cli-terminal-key"
              data-testid="cli-key-arrow-up"
              aria-label={t("cliTerminal.mobileKeyArrowUp", "Cursor up")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => emitBarKey(SEQ_ARROW_UP)}
            >
              ↑
            </button>
            <button
              type="button"
              className="cli-terminal-key"
              data-testid="cli-key-arrow-down"
              aria-label={t("cliTerminal.mobileKeyArrowDown", "Cursor down")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => emitBarKey(SEQ_ARROW_DOWN)}
            >
              ↓
            </button>
            <button
              type="button"
              className="cli-terminal-key"
              data-testid="cli-key-arrow-left"
              aria-label={t("cliTerminal.mobileKeyArrowLeft", "Cursor left")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => emitBarKey(SEQ_ARROW_LEFT)}
            >
              ←
            </button>
            <button
              type="button"
              className="cli-terminal-key"
              data-testid="cli-key-arrow-right"
              aria-label={t("cliTerminal.mobileKeyArrowRight", "Cursor right")}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => emitBarKey(SEQ_ARROW_RIGHT)}
            >
              →
            </button>
          </div>
          <form
            className="cli-session-terminal__input-row"
            onSubmit={handleMobileSubmit}
          >
            <input
              ref={inputRef}
              type="text"
              className="cli-session-terminal__mobile-input"
              data-testid="cli-terminal-mobile-input"
              value={mobileInput}
              placeholder={t(
                "cliTerminal.mobileInputPlaceholder",
                "Type to send to the session…",
              )}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => handleMobileInputChange(e.target.value)}
            />
            <button
              type="submit"
              className="cli-session-terminal__mobile-send"
              data-testid="cli-terminal-mobile-send"
              aria-label={t("cliTerminal.mobileSend", "Send")}
              // iOS pattern: act on click, preventDefault on pointer/mouse down
              // so the input doesn't blur (which dismisses the keyboard).
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => handleMobileSubmit()}
            >
              {t("cliTerminal.mobileSend", "Send")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
