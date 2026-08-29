/**
 * terminal-attach — full-screen passthrough attach to a CLI agent session
 * from the Ink TUI (CLI Agent Executor, U14).
 *
 * Model: SUSPEND-AND-HANDOFF, not embedding. The caller pauses Ink rendering,
 * then `attachTerminalSession` takes over the real TTY:
 *   - enter the alternate screen (`\x1b[?1049h`) and put stdin in raw mode,
 *   - WS `scrollback`/`data` frames → neutralize (U10 filter) → write to stdout,
 *   - stdin bytes → WS `input` frames (base64),
 *   - SIGWINCH / stdout resize → WS `resize` frames,
 *   - ACK `bytes` consumed after every ~32KB written, for flow control,
 *   - detach chord Ctrl-] (0x1d) → leave alt-screen, restore raw mode, close WS,
 *   - WS close/error mid-attach → restore the terminal cleanly + surface via
 *     `onDetach(error)`.
 *
 * SECURITY (the riskiest leg): the byte stream is UNTRUSTED. The host terminal
 * honors more escape sequences than xterm.js, so every byte written to the host
 * TTY is passed through `neutralizeTerminalOutput` FIRST — the identical filter
 * the dashboard WS bridge uses (re-exported from `@fusion/dashboard`). OSC 52
 * clipboard writes, OSC 8 non-http(s) links, and device-status queries (whose
 * auto-responses forge input) are stripped before they ever reach the terminal.
 *
 * CJK / double-width: bytes pass through verbatim — no width math is needed in a
 * passthrough (the host terminal does the width handling).
 *
 * The WS transport is injectable (`wsFactory`) so tests drive the loop with an
 * in-memory WS-like object and NEVER open a real socket (and never touch port
 * 4040). The default factory uses the `ws` Node client.
 */

import { WebSocket } from "ws";
import { neutralizeTerminalOutput, flushTerminalOutput } from "@fusion/dashboard";

/** Detach chord: Ctrl-] (GS, 0x1d). Documented + shown in the status hint. */
export const DETACH_CHORD_BYTE = 0x1d;
/** Human-readable label for the detach chord (status hint). */
export const DETACH_CHORD_LABEL = "Ctrl-]";

/** Enter / leave the alternate screen buffer. */
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";

/** Emit an ACK after roughly this many bytes are written to stdout. */
export const DEFAULT_ACK_THRESHOLD_BYTES = 32 * 1024;

// ── Frame shapes (mirror packages/dashboard/src/cli-session-ws.ts) ──────────

/** Server → client frames. */
type ServerFrame =
  | { type: "scrollback"; data?: string }
  | { type: "data"; data?: string }
  | { type: "state"; [k: string]: unknown }
  | { type: "error"; message?: string; code?: string }
  | { type: "exit" };

/** Client → server frames. */
type ClientFrame =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; bytes: number };

/**
 * The minimal WebSocket surface the passthrough loop uses. The real `ws` client
 * satisfies this; tests provide an in-memory implementation.
 */
export interface TerminalWebSocket {
  /** Register an event handler. */
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  /** Send a (string) frame. */
  send(data: string): void;
  /** Close the socket. */
  close(code?: number, reason?: string): void;
  /** Current ready state; OPEN === 1 (matches the ws/WHATWG constant). */
  readyState: number;
}

/** Ready-state constant matching the `ws` client / WHATWG WebSocket. */
export const WS_OPEN = 1;

/** Factory that opens a WS connection to `url` with the given headers. */
export type TerminalWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => TerminalWebSocket;

/** Minimal readable stdin surface (a TTY ReadStream satisfies this). */
export interface AttachStdin {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
  setRawMode?: (mode: boolean) => void;
  isRaw?: boolean;
  isTTY?: boolean;
  resume?: () => void;
  pause?: () => void;
}

/** Minimal writable stdout surface (a TTY WriteStream satisfies this). */
export interface AttachStdout {
  write(chunk: string): void;
  columns?: number;
  rows?: number;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

export interface AttachTerminalSessionOptions {
  /** Dashboard base URL, e.g. `http://127.0.0.1:4040`. */
  baseUrl: string;
  /** Daemon token (Authorization: Bearer …). Optional when auth is disabled. */
  token?: string;
  /** Session id to attach to. */
  sessionId: string;
  /** Project id (scopes the attach-ticket mint), if known. */
  projectId?: string;
  stdin: AttachStdin;
  stdout: AttachStdout;
  /**
   * Called exactly once when the attach ends — cleanly (no arg) or with an error
   * (WS drop / failed ticket). The caller resumes Ink rendering here.
   */
  onDetach: (error?: Error) => void;
  /** Injectable WS factory (default: the `ws` Node client). */
  wsFactory?: TerminalWebSocketFactory;
  /** Injectable fetch (default: global fetch) for the attach-ticket POST. */
  fetchImpl?: typeof fetch;
  /** ACK threshold override (bytes). */
  ackThresholdBytes?: number;
  /** Print a one-line detach hint before entering the alt-screen. */
  printHint?: boolean;
}

/** Handle returned by `attachTerminalSession`; lets the caller force-detach. */
export interface AttachHandle {
  /** Resolves when the attach fully ends (after terminal restore + onDetach). */
  done: Promise<void>;
  /** Force a clean detach (e.g. the TUI is quitting). Idempotent. */
  detach(): void;
}

interface AttachTicketResponse {
  ticket: string;
  expiresAt?: string;
  readOnly?: boolean;
}

/**
 * Fetch a single-use attach ticket for the session. Throws on non-2xx so the
 * caller surfaces a clean error and never opens the WS.
 */
export async function fetchAttachTicket(opts: {
  baseUrl: string;
  token?: string;
  sessionId: string;
  projectId?: string;
  fetchImpl?: typeof fetch;
}): Promise<AttachTicketResponse> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/cli-sessions/${encodeURIComponent(
    opts.sessionId,
  )}/attach-ticket`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.projectId ? { projectId: opts.projectId } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to mint attach ticket (HTTP ${res.status} ${res.statusText})`,
    );
  }
  const body = (await res.json()) as AttachTicketResponse;
  if (!body || typeof body.ticket !== "string" || body.ticket.length === 0) {
    throw new Error("Attach-ticket response missing `ticket`");
  }
  return body;
}

/** Build the cli-session WS URL with sessionId + ticket query params. */
export function buildWsUrl(opts: {
  baseUrl: string;
  sessionId: string;
  ticket: string;
}): string {
  const u = new URL(`${opts.baseUrl.replace(/\/$/, "")}/api/cli-sessions/ws`);
  // ws(s):// scheme — derive from http(s).
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("sessionId", opts.sessionId);
  u.searchParams.set("ticket", opts.ticket);
  return u.toString();
}

function defaultWsFactory(): TerminalWebSocketFactory {
  return (url, headers) => {
    const ws = new WebSocket(url, { headers });
    return ws as unknown as TerminalWebSocket;
  };
}

/**
 * Decode a server `data`/`scrollback` frame's base64 payload to a UTF-8 string.
 */
function decodeFrameData(data: string | undefined): string {
  if (typeof data !== "string" || data.length === 0) return "";
  return Buffer.from(data, "base64").toString("utf8");
}

/**
 * Run the full-screen passthrough attach. Returns once the attach has fully
 * ended and the terminal has been restored (the same point `onDetach` fires).
 *
 * Lifecycle is single-shot: every termination path (detach chord, WS close, WS
 * error, ticket failure, force `detach()`) funnels through one idempotent
 * teardown that restores raw mode, leaves the alt-screen, closes the WS, and
 * fires `onDetach` exactly once.
 */
export function attachTerminalSession(
  opts: AttachTerminalSessionOptions,
): AttachHandle {
  const {
    stdin,
    stdout,
    onDetach,
    ackThresholdBytes = DEFAULT_ACK_THRESHOLD_BYTES,
  } = opts;
  const wsFactory = opts.wsFactory ?? defaultWsFactory();

  let settled = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // Terminal state we must restore on teardown.
  const priorRaw = stdin.isRaw ?? false;
  let enteredAltScreen = false;
  let rawModeSet = false;

  // Live wiring (set once the WS opens).
  let ws: TerminalWebSocket | null = null;
  let onStdinData: ((chunk: Buffer | string) => void) | null = null;
  let onResize: (() => void) | null = null;

  // Outbound neutralization carry (threaded across data frames so a sequence
  // split across two frames is still caught).
  let carry = "";
  // Flow control: bytes written since the last ACK.
  let bytesSinceAck = 0;

  const sendFrame = (frame: ClientFrame): void => {
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* socket closing */
    }
  };

  const ackConsumed = (n: number): void => {
    bytesSinceAck += n;
    if (bytesSinceAck >= ackThresholdBytes) {
      sendFrame({ type: "ack", bytes: bytesSinceAck });
      bytesSinceAck = 0;
    }
  };

  // Write a (possibly partial) untrusted chunk to the host TTY through the U10
  // neutralizer. `isSnapshot` flushes the carry (scrollback is a complete unit).
  const writeNeutralized = (text: string, isSnapshot: boolean): void => {
    const result = neutralizeTerminalOutput(text, carry);
    let out = result.output;
    if (isSnapshot) {
      out += flushTerminalOutput(result.carry);
      carry = "";
    } else {
      carry = result.carry;
    }
    if (out.length === 0) return;
    try {
      stdout.write(out);
    } catch {
      /* stdout closing */
    }
    ackConsumed(Buffer.byteLength(out, "utf8"));
  };

  const teardown = (error?: Error): void => {
    if (settled) return;
    settled = true;

    // Detach stdin/resize listeners first so no late bytes race the restore.
    if (onStdinData) {
      try {
        stdin.off("data", onStdinData);
      } catch {
        /* ignore */
      }
      onStdinData = null;
    }
    if (onResize) {
      try {
        stdout.off("resize", onResize);
      } catch {
        /* ignore */
      }
      onResize = null;
    }

    // Restore raw mode to its prior state (only if we changed it).
    if (rawModeSet && stdin.setRawMode) {
      try {
        stdin.setRawMode(priorRaw);
      } catch {
        /* ignore */
      }
    }

    // Leave the alt-screen so the caller's shell / Ink scrollback is restored.
    if (enteredAltScreen) {
      try {
        stdout.write(ALT_SCREEN_LEAVE);
      } catch {
        /* ignore */
      }
    }

    // Close the WS (never throws upward).
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    try {
      onDetach(error);
    } finally {
      resolveDone();
    }
  };

  const handleServerFrame = (frame: ServerFrame): void => {
    switch (frame.type) {
      case "scrollback":
        writeNeutralized(decodeFrameData(frame.data), true);
        break;
      case "data":
        writeNeutralized(decodeFrameData(frame.data), false);
        break;
      case "exit":
        teardown();
        break;
      case "error":
        // A server error frame (e.g. read-only) is informational; surface it on
        // stdout but don't tear down — the stream may continue.
        if (frame.message) {
          try {
            stdout.write(`\r\n[session] ${frame.message}\r\n`);
          } catch {
            /* ignore */
          }
        }
        break;
      case "state":
      default:
        break;
    }
  };

  // Enter the alt-screen + raw mode, then wire the loop. We do this BEFORE the
  // WS opens so the first scrollback frame lands on a clean alt-screen.
  const enterPassthrough = (): void => {
    if (opts.printHint !== false) {
      try {
        stdout.write(
          `Attached to session ${opts.sessionId}. Press ${DETACH_CHORD_LABEL} to detach.\r\n`,
        );
      } catch {
        /* ignore */
      }
    }
    try {
      stdout.write(ALT_SCREEN_ENTER);
      enteredAltScreen = true;
    } catch {
      /* ignore */
    }
    if (stdin.setRawMode) {
      try {
        stdin.setRawMode(true);
        rawModeSet = true;
      } catch {
        /* ignore */
      }
    }
    stdin.resume?.();

    // stdin → input frames; detach chord intercepted.
    onStdinData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      // Detach chord: if Ctrl-] appears, send any bytes before it, then detach.
      const idx = buf.indexOf(DETACH_CHORD_BYTE);
      if (idx !== -1) {
        if (idx > 0) {
          sendFrame({ type: "input", data: buf.subarray(0, idx).toString("base64") });
        }
        teardown();
        return;
      }
      sendFrame({ type: "input", data: buf.toString("base64") });
    };
    stdin.on("data", onStdinData);

    // stdout resize → resize frames.
    onResize = (): void => {
      const cols = stdout.columns;
      const rows = stdout.rows;
      if (typeof cols === "number" && typeof rows === "number") {
        sendFrame({ type: "resize", cols, rows });
      }
    };
    stdout.on("resize", onResize);

    // Send the initial size so the PTY matches the host TTY immediately.
    onResize();
  };

  // ── Kick off: mint ticket, open WS, run the loop ──
  (async () => {
    let ticket: AttachTicketResponse;
    try {
      ticket = await fetchAttachTicket({
        baseUrl: opts.baseUrl,
        token: opts.token,
        sessionId: opts.sessionId,
        projectId: opts.projectId,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      teardown(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const url = buildWsUrl({
      baseUrl: opts.baseUrl,
      sessionId: opts.sessionId,
      ticket: ticket.ticket,
    });
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    try {
      ws = wsFactory(url, headers);
    } catch (err) {
      teardown(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    ws.on("open", () => {
      enterPassthrough();
    });
    ws.on("message", (data: unknown) => {
      let text: string;
      if (typeof data === "string") text = data;
      else if (Buffer.isBuffer(data)) text = data.toString("utf8");
      else if (data instanceof Uint8Array) text = Buffer.from(data).toString("utf8");
      else text = String(data);
      let frame: ServerFrame;
      try {
        frame = JSON.parse(text) as ServerFrame;
      } catch {
        return; // ignore malformed
      }
      handleServerFrame(frame);
    });
    ws.on("close", () => {
      // A close before any deliberate detach is treated as a clean end if the
      // server sent `exit` (already torn down), otherwise as a mid-attach drop.
      if (!settled) {
        teardown(new Error("Connection closed"));
      }
    });
    ws.on("error", (err: Error) => {
      teardown(err instanceof Error ? err : new Error(String(err)));
    });
  })();

  return {
    done,
    detach: () => teardown(),
  };
}
