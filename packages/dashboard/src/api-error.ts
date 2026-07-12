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
  */
  error?: unknown;
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
    const originalError = options?.error;
    const cause = originalError instanceof Error ? (originalError as { cause?: unknown }).cause : undefined;
    logger.error("Request failed", {
      method: request?.method,
      path: request?.originalUrl ?? request?.path,
      statusCode,
      message,
      stack: originalError instanceof Error ? originalError.stack : undefined,
      cause: cause instanceof Error ? (cause.stack ?? cause.message) : cause !== undefined ? String(cause) : undefined,
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

export function badRequest(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(400, message, details);
}

export function unauthorized(message: string): ApiError {
  return new ApiError(401, message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(409, message, details);
}

export function rateLimited(message: string, retryAfter?: number): ApiError {
  return new ApiError(429, message, { retryAfter });
}

export function internalError(message: string): ApiError {
  return new ApiError(500, message);
}

export function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error && error.message) {
    throw internalError(error.message);
  }

  throw internalError(fallbackMessage);
}
