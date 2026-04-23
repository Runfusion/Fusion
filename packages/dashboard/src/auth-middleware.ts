/**
 * Bearer token authentication middleware for daemon mode.
 *
 * Provides secure constant-time token validation to protect API endpoints
 * while allowing unauthenticated access to health checks.
 */

import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";

/**
 * Query-string fallback used when the client can't set an Authorization
 * header (EventSource, WebSocket handshake). The token flows as
 * `?fn_token=<token>` on those URLs.
 */
export const TOKEN_QUERY_PARAM = "fn_token";

/** Paths that are exempt from authentication (liveness probes). */
const EXEMPT_PATHS = ["/api/health"];

/**
 * Only /api/* paths are gated by this middleware. The SPA shell (index.html,
 * /assets/*, favicon, etc.) must load unauthenticated so the frontend JS can
 * run, read ?token= off the URL, and start injecting Bearer headers on API
 * calls. Without this exemption the browser gets 401 on the very first GET /
 * and never gets a chance to capture the token.
 */
function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Check if daemon auth should be active.
 * Auth is enabled when FUSION_DAEMON_TOKEN env var is set OR daemon options are provided.
 * Always returns false when options.noAuth is true (CLI --no-auth override).
 */
export function isDaemonAuthActive(options?: { daemon?: { token: string }; noAuth?: boolean }): boolean {
  if (options?.noAuth) {
    return false;
  }
  if (options?.daemon?.token) {
    return true;
  }
  if (process.env.FUSION_DAEMON_TOKEN) {
    return true;
  }
  return false;
}

/**
 * Get the daemon token from options or environment.
 * Returns undefined when options.noAuth is true, regardless of env.
 */
export function getDaemonToken(options?: { daemon?: { token: string }; noAuth?: boolean }): string | undefined {
  if (options?.noAuth) {
    return undefined;
  }
  if (options?.daemon?.token) {
    return options.daemon.token;
  }
  return process.env.FUSION_DAEMON_TOKEN;
}

/**
 * Check if a request path is exempt from authentication.
 */
function isExemptPath(path: string): boolean {
  return EXEMPT_PATHS.some((exempt) => path === exempt || path.startsWith(exempt + "/"));
}

/**
 * Constant-time string compare. Returns true only if both strings are the
 * same length and byte-for-byte equal.
 */
function constantTimeEqual(provided: string, expected: Buffer): boolean {
  if (provided.length !== expected.length) {
    return false;
  }
  try {
    const providedBuffer = Buffer.from(provided, "utf8");
    if (providedBuffer.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(providedBuffer, expected);
  } catch {
    return false;
  }
}

/**
 * Extract a bearer token from either the `Authorization: Bearer <token>`
 * header or the `fn_token=<token>` query-string fallback. The query-string
 * path is only needed for transports that can't set headers (EventSource,
 * WebSocket handshake).
 */
function extractTokenFromRequest(req: { headers: { authorization?: string }; url?: string }): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  if (req.url) {
    try {
      const parsed = new URL(req.url, "http://_placeholder_");
      const fromQuery = parsed.searchParams.get(TOKEN_QUERY_PARAM);
      if (fromQuery) return fromQuery;
    } catch {
      // Fall through — malformed URL, treat as no token.
    }
  }
  return undefined;
}

/**
 * Validate a raw HTTP upgrade request (WebSocket handshake) against the
 * configured daemon token. Returns true when the request carries a valid
 * bearer token, false otherwise. Accepts the token either via the
 * `Authorization` header or the `fn_token` query string — browsers cannot
 * set custom headers on a WebSocket constructor, so the query-string
 * fallback is required for same-origin browser clients.
 *
 * Uses constant-time comparison to resist timing attacks.
 */
export function authenticateUpgradeRequest(token: string, req: IncomingMessage): boolean {
  const expectedBuffer = Buffer.from(token, "utf8");
  const provided = extractTokenFromRequest(req as { headers: { authorization?: string }; url?: string });
  if (!provided) return false;
  return constantTimeEqual(provided, expectedBuffer);
}

/**
 * Create Express middleware that enforces bearer token authentication.
 *
 * Uses constant-time comparison to prevent timing attacks.
 * Exempts /api/health and paths starting with /api/health/ from auth.
 * Accepts the token either in the `Authorization: Bearer <token>` header
 * (preferred) or as a `fn_token=<token>` query parameter — the latter is
 * needed by EventSource and WebSocket clients which can't send headers.
 *
 * @param token - The valid bearer token
 * @returns Express middleware function
 */
export function createAuthMiddleware(token: string) {
  const expectedBuffer = Buffer.from(token, "utf8");
  const unauthorized = (res: Response): void => {
    res.status(401).json({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
  };

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // The SPA shell and static assets are public — only /api/* is gated.
    if (!isApiPath(req.path)) {
      next();
      return;
    }

    // Always allow exempt paths (liveness probes)
    if (isExemptPath(req.path)) {
      next();
      return;
    }

    const providedToken = extractTokenFromRequest(req);
    if (!providedToken) {
      unauthorized(res);
      return;
    }

    if (!constantTimeEqual(providedToken, expectedBuffer)) {
      unauthorized(res);
      return;
    }

    next();
  };
}
