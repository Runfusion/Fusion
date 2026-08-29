import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js";

export interface ApiErrorResponse {
  error: string;
  details?: Record<string, unknown>;
}

export interface SendErrorOptions {
  details?: Record<string, unknown>;
  logger?: RuntimeLogger;
  /*
  FNXC:ApiErrorDiagnostics 2026-07-10-14:00:
  The original thrown error behind a 5xx. When present, its stack (and any `cause`
  chain) is logged so server-side 500s are root-causable. Previously only the error
  *message* was logged and `rethrowAsApiError` discarded the stack, leaving the
  full-TaskDetail 500s on /api/tasks/:id (GET/DELETE/PATCH/retry/archive/reset)
  untraceable across releases.

  FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
  That contract was silently defeated on the most common path: `rethrowAsApiError`
  built a fresh `ApiError(500, error.message)` and dropped the caught error, so the
  boundary logged the rethrow site's stack (or, for a non-Error throw, no stack at
  all — observed on GET /api/tasks/FN-8610/runtime-fallback, whose 500 log carried
  only method/path/statusCode/message). The caught value is now threaded into
  `ApiError.cause` end-to-end, and the boundary walks the chain so `stack` is the
  ORIGIN error's stack and `cause` renders the wrappers between origin and boundary.
  */
  error?: unknown;
}

/*
FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
Chain-walk bounds. Depth caps a pathological/self-referential wrap; the visited set
stops a cycle (`a.cause = b; b.cause = a`) from spinning the request thread.
*/
const MAX_CAUSE_DEPTH = 8;

/**
 * FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
 * Flatten an error and its `cause` chain, nearest-wrapper first. Values are returned
 * as-is (not stringified) so callers decide the log rendering; only Errors and raw
 * thrown values enter the chain — never arbitrary object payloads.
 */
function collectCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current !== undefined && chain.length < MAX_CAUSE_DEPTH) {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }

  return chain;
}

/**
 * FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
 * Render one chain link for the log: an Error contributes its stack (message fallback
 * when a runtime omits `stack`), any other thrown value its `String(...)` form. Keeps
 * the log context ids/paths/stack-only.
 */
function renderChainLink(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value);
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(statusCode: number, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    // FNXC:ApiErrorDiagnostics 2026-07-10-14:00: preserve the wrapped error's
    // stack/chain via Error `cause` so the boundary can log where the 500 came
    // from (assigned directly rather than via super(message,{cause}) to stay
    // independent of the compiled lib target).
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export function sendErrorResponse(
  res: Response,
  statusCode: number,
  message: string,
  options?: SendErrorOptions,
): Response<ApiErrorResponse> {
  if (statusCode >= 500) {
    const request = res.req;
    const logger = options?.logger ?? createRuntimeLogger("api:error");
    // FNXC:ApiErrorDiagnostics 2026-07-10-14:00: log the underlying stack and
    // cause (not just the message) so a 500 can be traced to its origin.
    /*
    FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
    Walk the whole `cause` chain rather than one level. `stack` reports the DEEPEST
    Error in the chain — the origin throw site — because the boundary is handed the
    wrapping `ApiError` whose own stack only names `rethrowAsApiError`. `cause`
    reports every link past the boundary error so intermediate wrappers survive. An
    unwrapped Error still logs its own stack and no cause, unchanged from before.
    */
    const originalError = options?.error;
    const chain = collectCauseChain(originalError);
    const errorLinks = chain.filter((link): link is Error => link instanceof Error);
    const originError = errorLinks.length > 0 ? errorLinks[errorLinks.length - 1] : undefined;
    const causeLinks = chain.slice(1);
    logger.error("Request failed", {
      method: request?.method,
      path: request?.originalUrl ?? request?.path,
      statusCode,
      message,
      stack: originError?.stack,
      cause: causeLinks.length > 0 ? causeLinks.map(renderChainLink).join("\nCaused by: ") : undefined,
    });
  }

  const payload: ApiErrorResponse = { error: message };
  if (options?.details !== undefined) {
    payload.details = options.details;
  }

  return res.status(statusCode).json(payload);
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

export function catchHandler(fn: AsyncHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      if (res.headersSent) {
        next(error);
        return;
      }

      if (error instanceof ApiError) {
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details, error });
        return;
      }

      if (error instanceof Error) {
        sendErrorResponse(res, 500, error.message, { error });
        return;
      }

      sendErrorResponse(res, 500, "Internal server error", { error });
    }
  };
}

/*
FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
Every factory takes an optional TRAILING `cause` so the hundreds of existing
single/double-argument call sites across the route registrars stay source-compatible;
callers that already hold the caught error can pass it and get an origin stack in the
5xx log for free.
*/

export function badRequest(message: string, details?: Record<string, unknown>, cause?: unknown): ApiError {
  return new ApiError(400, message, details, cause);
}

export function unauthorized(message: string, cause?: unknown): ApiError {
  return new ApiError(401, message, undefined, cause);
}

export function notFound(message: string, cause?: unknown): ApiError {
  return new ApiError(404, message, undefined, cause);
}

export function conflict(message: string, details?: Record<string, unknown>, cause?: unknown): ApiError {
  return new ApiError(409, message, details, cause);
}

export function rateLimited(message: string, retryAfter?: number, cause?: unknown): ApiError {
  return new ApiError(429, message, { retryAfter }, cause);
}

export function internalError(message: string, cause?: unknown): ApiError {
  return new ApiError(500, message, undefined, cause);
}

/**
 * FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
 * Thread the caught value into the wrapping `ApiError` on BOTH branches. Before this
 * the caught error was read for its message and then discarded, so the 5xx boundary
 * logged the stack of the `ApiError` constructed here (or nothing at all for a
 * non-Error throw). Message, status, and response body are unchanged — this only
 * adds `cause`.
 */
export function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error && error.message) {
    throw internalError(error.message, error);
  }

  throw internalError(fallbackMessage, error);
}
