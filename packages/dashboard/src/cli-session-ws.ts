/**
 * cli-session-ws — distinct WebSocket attach handler for CLI agent sessions
 * (CLI Agent Executor, U10).
 *
 * This is a SEPARATE connection handler from the existing terminal WS
 * (`/api/terminal/ws`): it shares only the upgrade gate shape (daemon-token
 * auth) and the JSON frame protocol style. The connection body resolves the
 * session from the engine's `CliSessionManager` (the explicit async attach
 * interface), never the dashboard-local terminal service.
 *
 * Path: /api/cli-sessions/ws?sessionId=<id>&ticket=<ticket>[&fn_token=<token>]
 *
 * Upgrade gate (stronger than the terminal WS — this channel injects keystrokes
 * into privileged agent PTYs):
 *  1. daemon-token auth (authenticateUpgradeRequest), AND
 *  2. an Origin allowlist check (reject foreign/absent browser Origin), AND
 *  3. a valid, unconsumed, single-use ticket bound to this exact session.
 *
 * Frame protocol (JSON, mirrors the terminal WS shape):
 *  server→client: {type:"scrollback", data}  (base64 bytes) — once, on connect
 *                 {type:"data", data}         (base64 bytes) — live, neutralized
 *                 {type:"state", ...}         (optional state hints)
 *                 {type:"error", message}     (e.g. read-only input rejected)
 *  client→server: {type:"input", data}        (utf8 keystrokes → PTY write)
 *                 {type:"resize", cols, rows}  (latest-active-client resize)
 *                 {type:"ack", bytes}          (ACK-credit flow control)
 *
 * Flow control: the client ACKs bytes it has consumed; the server tracks
 * outstanding unacked bytes and, above the high watermark, calls
 * `manager.requestPause`; back below the low watermark, `manager.requestResume`.
 * The server never buffers PTY bytes — the engine owns the ring + pause/resume.
 *
 * Output hardening: every live `data` frame is passed through
 * `neutralizeTerminalOutput` (carry threaded across chunks) BEFORE send.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { authenticateUpgradeRequest } from "./auth-middleware.js";
import { neutralizeTerminalOutput, flushTerminalOutput } from "./cli-session-output-filter.js";
import {
  isOriginAllowed,
  isReadOnlySession,
  type AttachTicketStore,
  type CliInputAttributionLog,
  type CliSessionTransportDeps,
} from "./cli-session-transport.js";

/** Default high/low watermark (bytes) for ACK-credit backpressure. */
export const DEFAULT_HIGH_WATERMARK_BYTES = 128 * 1024;
export const DEFAULT_LOW_WATERMARK_BYTES = 16 * 1024;

export const CLI_SESSION_WS_PATH = "/api/cli-sessions/ws";

export interface CliSessionWebSocketOptions extends CliSessionTransportDeps {
  ticketStore: AttachTicketStore;
  attributionLog: CliInputAttributionLog;
  /** Daemon token; when set (and not noAuth) the upgrade requires it. */
  daemonToken?: string;
  noAuth?: boolean;
  /** Extra allowed WS Origins (scheme+host[:port]). */
  extraAllowedOrigins?: string[];
  highWatermarkBytes?: number;
  lowWatermarkBytes?: number;
}

/**
 * Attach the CLI-session WebSocket handler to an HTTP server. Adds its OWN
 * `upgrade` listener filtered to the cli-sessions path, so it coexists with the
 * terminal/badge WS upgrade listeners (each ignores non-matching paths).
 */
export function setupCliSessionWebSocket(
  server: HttpServer,
  options: CliSessionWebSocketOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const highWatermark = options.highWatermarkBytes ?? DEFAULT_HIGH_WATERMARK_BYTES;
  const lowWatermark = options.lowWatermarkBytes ?? DEFAULT_LOW_WATERMARK_BYTES;

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== CLI_SESSION_WS_PATH) return;

    const reject = (code: number, reason: string) => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    // 1. Daemon-token auth at the upgrade.
    if (options.daemonToken && !options.noAuth) {
      if (!authenticateUpgradeRequest(options.daemonToken, req)) {
        reject(401, "Unauthorized");
        return;
      }
    }

    // 2. Origin allowlist.
    const originOk = isOriginAllowed({
      origin: headerStr(req, "origin"),
      host: headerStr(req, "host"),
      secFetchSite: headerStr(req, "sec-fetch-site"),
      extraAllowedOrigins: options.extraAllowedOrigins,
    });
    if (!originOk) {
      reject(403, "Forbidden");
      return;
    }

    wss.handleUpgrade(req, socket, head, (upgraded) => {
      wss.emit("connection", upgraded, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");
    const ticket = url.searchParams.get("ticket");

    if (!sessionId) {
      ws.close(4000, "Missing sessionId");
      return;
    }

    const session = options.store.getSession(sessionId);
    if (!session) {
      ws.close(4004, "Session not found");
      return;
    }

    // 3. Single-use, session-scoped ticket. Consume here (after upgrade) so a
    // replayed/consumed ticket, or a ticket for a different session, is rejected.
    const consumed = options.ticketStore.consume(ticket, sessionId);
    if (!consumed) {
      ws.close(4401, "Invalid or expired attach ticket");
      return;
    }
    if (consumed.projectId !== session.projectId) {
      ws.close(4503, "Ticket does not match session project");
      return;
    }

    if (!options.manager.isLive(sessionId)) {
      ws.close(4409, "Session is not live");
      return;
    }

    const readOnly = isReadOnlySession(session) || consumed.readOnly;
    const ticketId = consumed.ticket;

    // Attach to the engine manager.
    let attachment;
    try {
      attachment = options.manager.attach(sessionId);
    } catch {
      ws.close(4500, "Failed to attach");
      return;
    }

    // ── Flow control state ──
    let unacked = 0;
    let paused = false;
    const onSentBytes = (n: number) => {
      unacked += n;
      if (!paused && unacked >= highWatermark) {
        paused = true;
        try {
          options.manager.requestPause(sessionId);
        } catch {
          /* ignore */
        }
      }
    };
    const onAck = (n: number) => {
      if (!Number.isFinite(n) || n <= 0) return;
      unacked = Math.max(0, unacked - n);
      if (paused && unacked <= lowWatermark) {
        paused = false;
        try {
          options.manager.requestResume(sessionId);
        } catch {
          /* ignore */
        }
      }
    };

    // ── Outbound: scrollback (neutralized) then live stream (neutralized) ──
    let carry = "";
    const sendData = (bytes: Uint8Array) => {
      if (ws.readyState !== ws.OPEN) return;
      const text = Buffer.from(bytes).toString("utf8");
      const result = neutralizeTerminalOutput(text, carry);
      carry = result.carry;
      if (result.output.length === 0) return;
      const payload = Buffer.from(result.output, "utf8");
      try {
        ws.send(
          JSON.stringify({ type: "data", data: payload.toString("base64") }),
        );
        onSentBytes(payload.byteLength);
      } catch {
        /* socket closing */
      }
    };

    // Scrollback replay (run through the same neutralizer so a hostile sequence
    // recorded in scrollback is also stripped). Sent as its own frame so the
    // client can clear before replay.
    {
      const scrollText = Buffer.from(attachment.scrollback).toString("utf8");
      const result = neutralizeTerminalOutput(scrollText, "");
      // Thread the carry across the scrollback→live seam. Do NOT flush the
      // scrollback carry verbatim: if a dangerous sequence (e.g. OSC 52) is
      // split so its introducer lands at the tail of scrollback and its
      // terminator arrives in the first live chunk, flushing the held prefix
      // here would let it recombine at the client and reconstruct the hazard.
      // Instead we hand the unterminated tail to the live `sendData` carry so
      // the neutralizer sees the full sequence and strips it. Only the safe,
      // fully-neutralized prefix is sent in the scrollback frame.
      carry = result.carry;
      try {
        ws.send(
          JSON.stringify({
            type: "scrollback",
            data: Buffer.from(result.output, "utf8").toString("base64"),
          }),
        );
      } catch {
        /* ignore */
      }
    }

    ws.send(JSON.stringify({ type: "state", state: session.agentState, readOnly }));

    // Pump the live byte stream.
    let streamClosed = false;
    (async () => {
      try {
        for await (const chunk of attachment.stream) {
          if (streamClosed || ws.readyState !== ws.OPEN) break;
          sendData(chunk);
        }
      } catch {
        /* stream error — close below */
      }
      // Flush any residual carry at true stream end. The held bytes are an
      // unterminated tail; no further chunk can arrive to recombine with them,
      // so emitting them as literal is safe and avoids losing trailing output.
      if (!streamClosed && ws.readyState === ws.OPEN && carry.length > 0) {
        const tail = flushTerminalOutput(carry);
        carry = "";
        if (tail.length > 0) {
          try {
            ws.send(
              JSON.stringify({
                type: "data",
                data: Buffer.from(tail, "utf8").toString("base64"),
              }),
            );
          } catch {
            /* ignore */
          }
        }
      }
      if (!streamClosed && ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "exit" }));
        } catch {
          /* ignore */
        }
      }
    })();

    // ── Inbound frames ──
    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed
      }
      switch (msg.type) {
        case "input": {
          if (typeof msg.data !== "string") return;
          if (readOnly) {
            try {
              ws.send(
                JSON.stringify({
                  type: "error",
                  code: "READ_ONLY",
                  message: "Session is read-only — input is not permitted",
                }),
              );
            } catch {
              /* ignore */
            }
            return;
          }
          attachment.write(msg.data);
          options.attributionLog.record(sessionId, {
            ticketId,
            source: "ws",
            byteLength: Buffer.byteLength(msg.data, "utf8"),
            at: new Date().toISOString(),
          });
          break;
        }
        case "resize": {
          if (typeof msg.cols === "number" && typeof msg.rows === "number") {
            // Latest-active-client policy is enforced by the manager (latest wins).
            attachment.resize(msg.cols, msg.rows);
          }
          break;
        }
        case "ack": {
          if (typeof msg.bytes === "number") onAck(msg.bytes);
          break;
        }
      }
    });

    const teardown = () => {
      if (streamClosed) return;
      streamClosed = true;
      try {
        attachment.detach(); // NEVER kills the session (other clients keep it).
      } catch {
        /* ignore */
      }
      // Release backpressure so a remaining client isn't stuck paused.
      if (paused) {
        try {
          options.manager.requestResume(sessionId);
        } catch {
          /* ignore */
        }
      }
    };

    ws.on("close", teardown);
    ws.on("error", teardown);
  });

  return wss;
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}
