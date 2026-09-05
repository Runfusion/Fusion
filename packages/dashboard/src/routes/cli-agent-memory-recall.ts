/**
 * CLI-agent per-turn memory-recall route (RUFU-128, CLI Agent Executor).
 *
 * A localhost POST endpoint that serves per-turn memory recall cues to a
 * spawned CLI AGENT's own native extension channel: a Claude Code
 * UserPromptSubmit hook script (plain curl) or a pi before-agent-start
 * extension (global fetch). The cue travels ONLY through these native
 * channels — it is NEVER injected into the PTY/composer by the engine.
 *
 * The route itself performs NO recall: it authenticates the request exactly
 * like the hook route and delegates to the engine-held recall handle (the
 * runtime bundle's memory-recall service, which wraps the core per-turn recall
 * with session key `cli:<sessionId>`). Task sessions, the dashboard chat path,
 * and executor step sessions are untouched — this route is keyed to live
 * per-session tokens.
 *
 * Security posture — MIRRORS `/api/cli-agent/hooks` (KTD — hook-endpoint
 * security; localhost is NOT a trust boundary: any local process or browser
 * page can reach 127.0.0.1):
 *
 * 1. Per-session token, constant-time. The request must carry the high-entropy
 *    per-session token AND the session id; the route validates the token was
 *    issued for exactly that session (`handle.validateToken` → the hub's
 *    registry). A session id alone is NEVER sufficient; a valid token for
 *    session B never validates for session A; a token for a killed session
 *    fails because teardown invalidates it.
 *
 * 2. Origin / Host CSRF defense. A browser page on any origin can POST to
 *    127.0.0.1, so a forged recall could otherwise exfiltrate project memory
 *    context to an attacker-controlled hook. We REJECT any request carrying a
 *    browser `Origin` header, and any request whose `Host` is not a loopback
 *    host. Hook scripts/extensions are curl/fetch from the agent process (no
 *    Origin); browsers always attach one on cross-origin fetch.
 *
 * 3. Payload cap. Oversized bodies are rejected (413) — both at parse time
 *    (a route-scoped `express.json` limit) and defensively via
 *    `Content-Length`.
 *
 * 4. No daemon bearer token. The agent only holds the per-session token, so
 *    this path is EXEMPT from the daemon-token middleware (see
 *    auth-middleware `EXEMPT_PATHS`). It is not unauthenticated — it
 *    authenticates with the per-session token instead.
 *
 * 5. Silent-skip contract. A valid request whose recall produced no cue
 *    (settings off, no keywords, backend unavailable, no surviving results)
 *    returns 202 with an EMPTY cue — recall is best-effort context, and the
 *    agent's turn must never be disturbed by a memory hiccup. The route
 *    NEVER returns 5xx on a recall failure: any service-side throw is caught
 *    and downgraded to the empty cue. Authentication failures (401) and
 *    malformed requests (400/403/413) are NOT recall failures — they surface
 *    as errors so a forged or broken caller is never silently accepted.
 *
 * Response shape: the 202 body is the raw cue as `text/plain` (the empty
 * string on silent skip). The cue is opaque context text and the sh hook
 * consumer must not JSON-parse it — a plain-text body keeps the generated
 * script dependency-free (no JSON escaping round-trip for the consumer).
 */

import { Router, type Request, type Response } from "express";
import express from "express";
import type { ApiRouteRegistrar } from "./types.js";

/** Max accepted recall request size. Prompts are small; caps a forged flood. */
export const MEMORY_RECALL_PAYLOAD_LIMIT_BYTES = 256 * 1024;

/** Header carrying the per-session token (matches the engine hook scripts). */
const TOKEN_HEADER = "x-fusion-cli-session-token";
/** Header carrying the session id the token must validate for. */
const SESSION_HEADER = "x-fusion-cli-session-id";

/**
 * The minimal recall-handle surface the route depends on. The runtime bundle's
 * `memoryRecall` slice implements this structurally (token validation delegates
 * to the hub, session existence to the store, recall to the service).
 */
export interface CliAgentMemoryRecallHandle {
  /** True iff the per-session token validates for exactly this session. */
  validateToken(sessionId: string, token: string | null | undefined): boolean;
  /** True iff the session record still exists in the store. */
  hasSession(sessionId: string): boolean;
  /**
   * Run one per-turn recall for the prompt topic. Resolves to the cue string,
   * or "" on silent skip (settings off / no keywords / backend unavailable /
   * no surviving results). Must not throw — but the route still guards it.
   */
  recallForChatTurn(input: { topic: string; sessionId: string }): Promise<string>;
}

/** Loopback hosts the route accepts. Anything else is treated as cross-site. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a :port suffix (but keep IPv6 brackets intact for the comparison).
  const bare = host.replace(/:\d+$/, "").toLowerCase();
  return (
    bare === "127.0.0.1" ||
    bare === "localhost" ||
    bare === "[::1]" ||
    bare === "::1" ||
    bare === "0.0.0.0"
  );
}

/** First value of a (possibly array) header, trimmed. */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const registerCliAgentMemoryRecallRoute: ApiRouteRegistrar = (ctx) => {
  const { router } = ctx;
  const logger = ctx.runtimeLogger.child("cli-agent-memory-recall");

  // Route-scoped JSON parser with a hard size cap. An oversized body is
  // rejected at parse time (express throws a 413 PayloadTooLargeError,
  // surfaced by the error handler) before any handler logic runs.
  const parseRecallBody = express.json({ limit: MEMORY_RECALL_PAYLOAD_LIMIT_BYTES });

  const handler = (req: Request, res: Response): void => {
    // ── 1. CSRF defense: reject browser-context requests ──────────────────────
    // Any request carrying an Origin header came from a browser fetch — a hook
    // script / pi extension never sets one. Reject outright (localhost is not a
    // trust boundary).
    if (headerValue(req, "origin") !== undefined) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    // Host must be a loopback host. A cross-site Host (DNS-rebinding style) is
    // rejected even absent an Origin header.
    if (!isLoopbackHost(headerValue(req, "host"))) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }

    // ── 2. Defensive payload cap on Content-Length ────────────────────────────
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MEMORY_RECALL_PAYLOAD_LIMIT_BYTES) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }

    // ── 3. Identify session + token ───────────────────────────────────────────
    const sessionId = headerValue(req, SESSION_HEADER);
    const token = headerValue(req, TOKEN_HEADER);
    if (!sessionId || !token) {
      // Missing credentials — never a no-op. No token == not authenticated.
      res.status(401).json({ error: "Missing session token" });
      return;
    }

    // ── 4. Resolve the engine-held recall handle for this session ─────────────
    const projectId = ctx.getProjectIdFromRequest(req);
    const resolver = ctx.options?.cliAgentMemoryRecallResolver;
    const handle = resolver?.(projectId, sessionId);

    // No recall wiring at all (cli-agent executor off / engine not wired). A
    // forged token cannot validate; treat as unauthorized rather than no-op so
    // a wrong token is never silently accepted.
    if (!handle) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    // The session must still exist in the store (deleted sessions lose recall).
    if (!handle.hasSession(sessionId)) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    // ── 5. Validate the per-session token (token-belongs-to-session) ──────────
    // The handle validates that this exact token was issued for THIS session —
    // session id alone is never sufficient, and a valid token for another
    // session is rejected. Missing/wrong/expired/invalidated tokens (including
    // a killed session's invalidated token) all fail here.
    if (!handle.validateToken(sessionId, token)) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    // ── 6. Require the prompt topic ───────────────────────────────────────────
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length === 0) {
      res.status(400).json({ error: "Missing prompt" });
      return;
    }

    // ── 7. Recall — silent-skip contract ──────────────────────────────────────
    void (async () => {
      let cue = "";
      try {
        cue = await handle.recallForChatTurn({ topic: prompt, sessionId });
      } catch (error) {
        // Recall is best-effort context. Log and return the empty cue — the
        // agent's turn is never disturbed by an engine-side hiccup (the route
        // must NEVER 5xx on a recall failure).
        logger.warn("memory recall failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Plain text: the cue is opaque context the sh hook consumer must not
      // JSON-parse (see file header). The empty string IS the silent skip.
      res.status(202).type("text/plain").send(typeof cue === "string" ? cue : "");
    })();
  };

  // POST only. The route does its own auth (per-session token) and is exempt
  // from the daemon bearer-token middleware (see auth-middleware EXEMPT_PATHS).
  router.post("/cli-agent/memory-recall", parseRecallBody, handler);
};

/**
 * Build a standalone Express router carrying just the memory-recall route —
 * used by the route test to mount the handler without the full server.
 * Mirrors the production registration
 * (`registerCliAgentMemoryRecallRoute`).
 */
export function createCliAgentMemoryRecallRouterForTest(
  resolver: (projectId: string | undefined, sessionId: string) => CliAgentMemoryRecallHandle | undefined,
  logger: { warn: (msg: string, ctx?: unknown) => void } = { warn: () => {} },
): Router {
  const router = Router();
  registerCliAgentMemoryRecallRoute({
    router,
    options: { cliAgentMemoryRecallResolver: resolver as never },
    // FNXC:CLIChatMemoryRecall 2026-08-20-05:52:
    // Express 5 does not populate req.query on a bare Router() without the
    // express.query() middleware, so a real HTTP request to this for-test
    // router 500'd on the unguarded req.query.projectId read (discovered by
    // the RUFU-128 pi e2e: the generated recall extension's POST returned
    // 500 "Cannot read properties of undefined (reading 'projectId')"). The
    // committed route unit tests use hand-built fake req objects that carry a
    // query property, so they never exercised a real express request. Guard
    // like the production resolver in routes/context.ts.
    getProjectIdFromRequest: (req: Request) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return typeof q.projectId === "string" ? q.projectId : undefined;
    },
    runtimeLogger: { child: () => logger } as never,
  } as never);
  return router;
}
