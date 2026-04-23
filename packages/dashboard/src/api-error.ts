import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js";

export interface ApiErrorResponse {
  error: string;
  details?: Record<string, unknown>;
}

export interface SendErrorOptions {
  details?: Record<string, unknown>;
  logger?: RuntimeLogger;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(statusCode: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
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
    logger.error("Request failed", {
      method: request?.method,
      path: request?.originalUrl ?? request?.path,
      statusCode,
      message,
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
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
        return;
      }

      if (error instanceof Error) {
        sendErrorResponse(res, 500, error.message);
        return;
      }

      sendErrorResponse(res, 500, "Internal server error");
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

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

export function rateLimited(message: string, retryAfter?: number): ApiError {
  return new ApiError(429, message, { retryAfter });
}

export function internalError(message: string): ApiError {
  return new ApiError(500, message);
}
