/**
 * CLI-agent hook ingestion route (CLI Agent Executor, U17).
 *
 * A localhost POST endpoint that authenticates per-session hook POSTs from a
 * spawned CLI agent (Claude Code, Codex, Droid, …) and forwards the validated,
 * parsed payload IN-PROCESS to the engine-held telemetry hub. The engine has no
 * HTTP server — only the dashboard serves HTTP (the Orca pattern, adapted).
 *
 * Security posture (KTD — hook-endpoint security; localhost is NOT a trust
 * boundary: any local process or browser page can reach 127.0.0.1):
 *
 * 1. Per-session token, constant-time. The request must carry the high-entropy
 *    per-session hook token AND the session id; the route validates that the
 *    token was issued for exactly that session against the engine-held registry
 *    (`hub.validateToken`). A session id alone is NEVER sufficient, and a valid
 *    token for session B never validates for session A. Comparison is
 *    constant-time inside the hub registry lookup; the header presence check here
 *    avoids leaking timing on the cheap path only.
 *
 * 2. Origin / Host CSRF defense. A browser page on any origin can POST to
 *    127.0.0.1, so a forged `Stop`/completion could otherwise advance incomplete
 *    work or suppress the stall detector. We REJECT any request carrying a
 *    browser `Origin` header, and any request whose `Host` is not a loopback
 *    host. Hook scripts are plain `curl` (no Origin); browsers always attach one
 *    on cross-origin fetch — so this cleanly separates the two.
 *
 * 3. Payload cap. Oversized bodies are rejected (413) — both at parse time (a
 *    route-scoped `express.json` limit) and defensively via `Content-Length`.
 *
 * 4. No daemon bearer token. Hook scripts only hold the per-session token, so
 *    this path is EXEMPT from the daemon-token middleware (see auth-middleware
 *    `EXEMPT_PATHS`). It is not unauthenticated — it authenticates with the
 *    per-session token instead.
 *
 * 5. Never crash. An unknown / non-live session key is a 200 no-op (the hub's
 *    `ingest` is itself a no-op for unknown sessions); malformed JSON is a 400;
 *    nothing here throws into the agent's hook chain.
 */

import { Router, type Request, type Response } from "express";
import express from "express";
import type { ApiRouteRegistrar } from "./types.js";

/** Max accepted hook payload size. Hook payloads are small JSON envelopes. */
export const HOOK_PAYLOAD_LIMIT_BYTES = 256 * 1024;

/** Header carrying the per-session hook token (matches the engine hook scripts). */
const TOKEN_HEADER = "x-fusion-cli-session-token";
/** Header carrying the session id the token must validate for. */
const SESSION_HEADER = "x-fusion-cli-session-id";

/** The minimal hub surface the route depends on (validate + ingest). */
export interface CliAgentHookHub {
  validateToken(sessionId: string, token: string | null | undefined): boolean;
  ingest(sessionId: string, event: unknown): unknown;
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

/**
 * Map a host CLI hook event name (from the `?event=` query param the scripts add)
 * onto a normalized telemetry event kind. Unknown / absent events fall back to a
 * generic activity signal, so an unrecognized hook never advances state on its own
 * (positive completion gating lives in the state machine, not here).
 */
function normalizeHookEvent(eventName: string | undefined, body: Record<string, unknown>) {
  const name = (eventName ?? "").toLowerCase();
  // Carry the native session id whenever the payload reports one (Claude:
  // `session_id` in every payload) so the hub can persist it.
  const nativeSessionId =
    typeof body.session_id === "string"
      ? body.session_id
      : typeof body.sessionId === "string"
        ? body.sessionId
        : undefined;

  const basePayload: Record<string, unknown> = {};
  if (nativeSessionId) basePayload.nativeSessionId = nativeSessionId;

  switch (name) {
    case "sessionstart":
      return { kind: "sessionStart" as const, payload: basePayload };
    case "stop":
    case "subagentstop":
      return { kind: "done" as const, payload: basePayload };
    case "notification":
    case "permissionrequest":
    case "notify":
      return {
        kind: "waitingOnInput" as const,
        payload: { ...basePayload, notification: body },
      };
    case "pretooluse":
    case "posttooluse":
      return { kind: "toolActivity" as const, payload: basePayload };
    case "userpromptsubmit":
      return { kind: "busy" as const, payload: basePayload };
    default:
      // Unknown / absent event → activity only (re-arms watchdog, never advances).
      return { kind: "outputProgress" as const, payload: basePayload };
  }
}

export const registerCliAgentHooksRoute: ApiRouteRegistrar = (ctx) => {
  const { router } = ctx;
  const logger = ctx.runtimeLogger.child("cli-agent-hooks");

  // Route-scoped JSON parser with a hard size cap. An oversized body is rejected
  // at parse time (express throws a 413 PayloadTooLargeError, surfaced by the
  // error handler) before any handler logic runs.
  const parseHookBody = express.json({ limit: HOOK_PAYLOAD_LIMIT_BYTES });

  const handler = (req: Request, res: Response): void => {
    // ── 1. CSRF defense: reject browser-context requests ──────────────────────
    // Any request carrying an Origin header came from a browser fetch — a hook
    // script never sets one. Reject outright (localhost is not a trust boundary).
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
    if (Number.isFinite(contentLength) && contentLength > HOOK_PAYLOAD_LIMIT_BYTES) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }

    // ── 3. Identify session + token ───────────────────────────────────────────
    const sessionId = headerValue(req, SESSION_HEADER);
    const token = headerValue(req, TOKEN_HEADER);
    if (!sessionId || !token) {
      // Missing credentials — never a no-op (a no-op is reserved for a *valid*
      // request against an unknown session). No token == not authenticated.
      res.status(401).json({ error: "Missing session token" });
      return;
    }

    // ── 4. Resolve the engine-held hub for this session ───────────────────────
    const projectId = ctx.getProjectIdFromRequest(req);
    const resolver = ctx.options?.cliAgentHubResolver;
    const hub = resolver?.(projectId, sessionId) as CliAgentHookHub | undefined;

    // No hub at all (e.g. engine not wired / no live sessions). A forged token
    // cannot validate; treat as unauthorized rather than no-op so a wrong token
    // is never silently accepted.
    if (!hub) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    // ── 5. Validate the per-session token (token-belongs-to-session) ──────────
    // The hub validates that this exact token was issued for THIS session —
    // session id alone is never sufficient, and a valid token for another session
    // is rejected. Missing/wrong/expired/invalidated tokens all fail here.
    if (!hub.validateToken(sessionId, token)) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    // ── 6. Forward the validated payload in-process to the hub ────────────────
    const body = (req.body ?? {}) as Record<string, unknown>;
    const eventName = typeof req.query.event === "string" ? req.query.event : undefined;
    const event = normalizeHookEvent(eventName, body);

    try {
      // ingest is itself a no-op for unknown/non-live sessions — never crashes.
      hub.ingest(sessionId, event);
    } catch (error) {
      // Telemetry ingestion is best-effort. Log and still return 200 so the
      // agent's hook chain is never disturbed by an engine-side hiccup.
      logger.warn("hook ingest failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    res.status(200).json({ ok: true });
  };

  // POST only. The route does its own auth (per-session token) and is exempt
  // from the daemon bearer-token middleware (see auth-middleware EXEMPT_PATHS).
  router.post("/cli-agent/hooks", parseHookBody, handler);
};

/**
 * Build a standalone Express router carrying just the hook route — used by the
 * route test to mount the handler without the full server. Mirrors the
 * production registration (`registerCliAgentHooksRoute`).
 */
export function createCliAgentHooksRouterForTest(
  resolver: (projectId: string | undefined, sessionId: string) => CliAgentHookHub | undefined,
  logger: { warn: (msg: string, ctx?: unknown) => void } = { warn: () => {} },
): Router {
  const router = Router();
  registerCliAgentHooksRoute({
    router,
    options: { cliAgentHubResolver: resolver as never },
    getProjectIdFromRequest: (req: Request) =>
      typeof req.query.projectId === "string" ? req.query.projectId : undefined,
    runtimeLogger: { child: () => logger } as never,
  } as never);
  return router;
}
