import type { Request, Response, NextFunction } from "express";
import { sendErrorResponse } from "./api-error.js";

export interface RateLimitOptions {
  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;
  /** Max requests per window (default: 100) */
  max?: number;
  /** Message returned when rate limited */
  message?: string;
}

interface ClientRecord {
  count: number;
  resetTime: number;
}

/**
 * In-memory sliding-window rate limiter middleware.
 * Tracks requests per IP and returns 429 when the limit is exceeded.
 * Adds standard rate-limit headers to every response.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const {
    windowMs = 60_000,
    max = 100,
    message = "Too many requests, please try again later.",
  } = options;

  const clients = new Map<string, ClientRecord>();

  // Periodically clean up expired entries to prevent memory leaks
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of clients) {
      if (now >= record.resetTime) {
        clients.delete(key);
      }
    }
  }, windowMs);

  // Allow the timer to not keep the process alive
  if (cleanup.unref) {
    cleanup.unref();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();

    let record = clients.get(key);

    if (!record || now >= record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
      clients.set(key, record);
    }

    record.count++;

    const remaining = Math.max(0, max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    // Set rate limit headers on every response
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (record.count > max) {
      res.setHeader("Retry-After", String(resetSeconds));
      sendErrorResponse(res, 429, message);
      return;
    }

    next();
  };
}

/** Default rate limit configs for different endpoint patterns */
export const RATE_LIMITS = {
  /** General API: 100 req/min */
  api: { windowMs: 60_000, max: 100 },
  /** Mutation endpoints (POST/PUT/PATCH/DELETE): 30 req/min */
  mutation: { windowMs: 60_000, max: 30 },
  /** SSE connections: 10 per minute */
  sse: { windowMs: 60_000, max: 10 },
} as const;
