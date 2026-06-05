/**
 * cli-sessions routes — authenticated REST surface for CLI agent sessions
 * (CLI Agent Executor, U10).
 *
 * Daemon-token gated like every other /api route (the caller mounts this router
 * behind the auth middleware). Routes:
 * - GET  /api/cli-sessions                      list (by project/task/chat)
 * - GET  /api/cli-sessions/:id                  one session record
 * - POST /api/cli-sessions/:id/attach-ticket    mint a short-lived single-use
 *                                               session-scoped attach ticket
 * - POST /api/cli-sessions/:id/inject           inject text onto the session FIFO
 * - POST /api/cli-sessions/:id/confirm-advance  generic-tier R20 affordance
 *
 * Attach tickets (KTD — attach auth): the long-lived daemon token never
 * authorizes PTY write access by itself. A surface mints a ticket here (gated by
 * the daemon token), then presents it on the WS upgrade (which re-checks the
 * token AND an Origin allowlist). Tickets are single-use, ~60s TTL, and bound to
 * their session id.
 */

import { Router, type Request, type Response } from "express";
import { badRequest, notFound, ApiError, catchHandler } from "../api-error.js";
import {
  type AttachTicketStore,
  type CliInputAttributionLog,
  type CliConfirmAdvanceRegistry,
  type CliSessionTransportDeps,
  isReadOnlySession,
} from "../cli-session-transport.js";

export interface CliSessionRoutesOptions extends CliSessionTransportDeps {
  ticketStore: AttachTicketStore;
  attributionLog: CliInputAttributionLog;
  confirmAdvance: CliConfirmAdvanceRegistry;
  /** Max inject body length (chars). Bounds a hostile body. */
  maxInjectChars?: number;
}

const DEFAULT_MAX_INJECT_CHARS = 64 * 1024;

/** Coerce a route param (may be string | string[]) to a single string. */
function paramId(value: unknown): string {
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/** Optional project scoping: when a `projectId` is provided it must match. */
function assertProjectScope(sessionProjectId: string, requested: unknown): void {
  if (requested === undefined || requested === null || requested === "") return;
  if (typeof requested !== "string" || requested !== sessionProjectId) {
    // Cross-project access is a hard rejection (the session id is not enough).
    throw new ApiError(403, "Session does not belong to this project");
  }
}

export function createCliSessionsRouter(options: CliSessionRoutesOptions): Router {
  const { manager, store, ticketStore, attributionLog, confirmAdvance } = options;
  const maxInjectChars = options.maxInjectChars ?? DEFAULT_MAX_INJECT_CHARS;
  const router = Router();

  // ── List ────────────────────────────────────────────────────────────────
  router.get(
    "/",
    catchHandler(async (req: Request, res: Response) => {
      const { projectId, taskId, chatSessionId } = req.query;
      const sessions = store.listSessions({
        projectId: typeof projectId === "string" ? projectId : undefined,
        taskId: typeof taskId === "string" ? taskId : undefined,
        chatSessionId: typeof chatSessionId === "string" ? chatSessionId : undefined,
      });
      res.json({ sessions });
    }),
  );

  // ── One ─────────────────────────────────────────────────────────────────
  router.get(
    "/:id",
    catchHandler(async (req: Request, res: Response) => {
      const session = store.getSession(paramId(req.params.id));
      if (!session) throw notFound("Session not found");
      assertProjectScope(session.projectId, req.query.projectId);
      res.json({ session });
    }),
  );

  // ── Attach ticket ─────────────────────────────────────────────────────────
  router.post(
    "/:id/attach-ticket",
    catchHandler(async (req: Request, res: Response) => {
      const session = store.getSession(paramId(req.params.id));
      if (!session) throw notFound("Session not found");
      assertProjectScope(session.projectId, req.body?.projectId ?? req.query.projectId);
      const readOnly = isReadOnlySession(session);
      const { ticket, expiresAt } = ticketStore.mint({
        sessionId: session.id,
        projectId: session.projectId,
        readOnly,
      });
      res.json({
        ticket,
        expiresAt: new Date(expiresAt).toISOString(),
        readOnly,
      });
    }),
  );

  // ── Inject ────────────────────────────────────────────────────────────────
  router.post(
    "/:id/inject",
    catchHandler(async (req: Request, res: Response) => {
      const session = store.getSession(paramId(req.params.id));
      if (!session) throw notFound("Session not found");
      assertProjectScope(session.projectId, req.body?.projectId ?? req.query.projectId);

      const text = req.body?.text;
      if (typeof text !== "string" || text.length === 0) {
        throw badRequest("Missing or empty `text`");
      }
      if (text.length > maxInjectChars) {
        throw badRequest(`\`text\` exceeds max length (${maxInjectChars})`);
      }
      // Server-side read-only enforcement (not just client).
      if (isReadOnlySession(session)) {
        throw new ApiError(403, "Session is read-only — input is not permitted");
      }
      if (!manager.isLive(session.id)) {
        throw new ApiError(409, "Session is not live");
      }

      await manager.inject(session.id, text);

      // Attribution: record the input source on the session's input log. The
      // REST inject path has no attach ticket; attribute it to the daemon token.
      attributionLog.record(session.id, {
        ticketId: "rest:inject",
        source: "inject",
        byteLength: Buffer.byteLength(text, "utf8"),
        at: new Date().toISOString(),
      });

      res.json({ ok: true });
    }),
  );

  // ── Confirm-advance (generic-tier R20 affordance) ──────────────────────────
  router.post(
    "/:id/confirm-advance",
    catchHandler(async (req: Request, res: Response) => {
      const session = store.getSession(paramId(req.params.id));
      if (!session) throw notFound("Session not found");
      assertProjectScope(session.projectId, req.body?.projectId ?? req.query.projectId);

      const decisionRaw = req.body?.decision ?? "advance";
      if (decisionRaw !== "advance" && decisionRaw !== "not-yet") {
        throw badRequest("`decision` must be 'advance' or 'not-yet'");
      }
      confirmAdvance.record(session.id, session.projectId, decisionRaw);
      res.json({ ok: true, decision: decisionRaw });
    }),
  );

  return router;
}
