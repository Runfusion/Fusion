// @vitest-environment node

import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  badRequest,
  catchHandler,
  conflict,
  internalError,
  notFound,
  rateLimited,
  sendErrorResponse,
  unauthorized,
} from "./api-error.js";
import { resetRuntimeLogSink, setRuntimeLogSink } from "./runtime-logger.js";

const runtimeLogEvents: Array<{
  level: string;
  scope: string;
  message: string;
  context?: Record<string, unknown>;
}> = [];

interface MockResponse {
  res: Response;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
}

function createMockResponse(overrides?: Partial<Response>, requestOverrides?: Partial<Request>): MockResponse {
  const statusMock = vi.fn();
  const jsonMock = vi.fn();
  statusMock.mockReturnValue({ json: jsonMock });

  const req = {
    method: "GET",
    path: "/api/test",
    originalUrl: "/api/test?x=1",
    ...requestOverrides,
  } as Request;

  const res = {
    req,
    headersSent: false,
    status: statusMock,
    json: jsonMock,
    ...overrides,
  } as unknown as Response;

  return {
    res,
    statusMock,
    jsonMock,
  };
}

beforeEach(() => {
  runtimeLogEvents.length = 0;
  setRuntimeLogSink((level, scope, message, context) => {
    runtimeLogEvents.push({ level, scope, message, context });
  });
});

afterEach(() => {
  resetRuntimeLogSink();
});

describe("ApiError", () => {
  it("sets statusCode, message, and details", () => {
    const details = { foo: "bar" };
    const error = new ApiError(418, "teapot", details);

    expect(error.statusCode).toBe(418);
    expect(error.message).toBe("teapot");
    expect(error.details).toEqual(details);
    expect(error.name).toBe("ApiError");
  });

  it("defaults isOperational to true", () => {
    const error = new ApiError(400, "bad request");
    expect(error.isOperational).toBe(true);
  });
});

describe("sendErrorResponse", () => {

  it("sends standard { error: string } payload", () => {
    const { res, statusMock, jsonMock } = createMockResponse();

    sendErrorResponse(res, 400, "Bad request");

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Bad request" });
  });

  it("includes details when provided", () => {
    const { res, jsonMock } = createMockResponse();
    const details = { projectCount: 2, globalCount: 10 };

    sendErrorResponse(res, 500, "Import failed", { details });

    expect(jsonMock).toHaveBeenCalledWith({ error: "Import failed", details });
  });

  it("omits details when not provided", () => {
    const { res, jsonMock } = createMockResponse();

    sendErrorResponse(res, 500, "Server exploded");

    expect(jsonMock).toHaveBeenCalledWith({ error: "Server exploded" });
  });

  it("logs 5xx errors with structured metadata", () => {
    const { res } = createMockResponse();

    sendErrorResponse(res, 500, "Internal issue");

    expect(runtimeLogEvents).toContainEqual({
      level: "error",
      scope: "api:error",
      message: "Request failed",
      context: {
        method: "GET",
        path: "/api/test?x=1",
        statusCode: 500,
        message: "Internal issue",
      },
    });
  });

  it("does not log 4xx errors", () => {
    const { res } = createMockResponse();

    sendErrorResponse(res, 404, "Not found");

    expect(runtimeLogEvents).toHaveLength(0);
  });
});

describe("catchHandler", () => {

  it("catches ApiError and sends status/message/details", async () => {
    const details = { field: "name" };
    const handler = catchHandler(async () => {
      throw badRequest("Invalid input", details);
    });
    const { res, statusMock, jsonMock } = createMockResponse();
    const next = vi.fn<NextFunction>();

    await handler({} as Request, res, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Invalid input", details });
    expect(next).not.toHaveBeenCalled();
    expect(runtimeLogEvents).toHaveLength(0);
  });

  it("catches generic Error and sends 500 with error message", async () => {
    const handler = catchHandler(async () => {
      throw new Error("boom");
    });
    const { res, statusMock, jsonMock } = createMockResponse();
    const next = vi.fn<NextFunction>();

    await handler({} as Request, res, next);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "boom" });
    expect(runtimeLogEvents).toContainEqual(
      expect.objectContaining({
        level: "error",
        scope: "api:error",
        message: "Request failed",
        context: expect.objectContaining({
          statusCode: 500,
          message: "boom",
        }),
      }),
    );
  });

  it("calls next(err) when headers are already sent", async () => {
    const thrown = new Error("already sent");
    const handler = catchHandler(async () => {
      throw thrown;
    });
    const { res, statusMock, jsonMock } = createMockResponse({ headersSent: true });
    const next = vi.fn<NextFunction>();

    await handler({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(thrown);
    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it("allows successful handlers to continue without interception", async () => {
    const handler = catchHandler(async (_req, _res, next) => {
      next();
    });
    const { res, statusMock, jsonMock } = createMockResponse();
    const next = vi.fn<NextFunction>();

    await handler({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
  });
});

describe("error factories", () => {
  it("badRequest creates ApiError(400)", () => {
    const error = badRequest("msg");
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("msg");
    expect(error.details).toBeUndefined();
  });

  it("badRequest supports details", () => {
    const error = badRequest("msg", { field: "x" });
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ field: "x" });
  });

  it("unauthorized creates ApiError(401)", () => {
    const error = unauthorized("msg");
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe("msg");
  });

  it("notFound creates ApiError(404)", () => {
    const error = notFound("msg");
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("msg");
  });

  it("conflict creates ApiError(409)", () => {
    const error = conflict("msg");
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("msg");
  });

  it("rateLimited creates ApiError(429) with undefined retryAfter by default", () => {
    const error = rateLimited("msg");
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe("msg");
    expect(error.details).toEqual({ retryAfter: undefined });
  });

  it("rateLimited creates ApiError(429) with retryAfter details when provided", () => {
    const error = rateLimited("msg", 60);
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe("msg");
    expect(error.details).toEqual({ retryAfter: 60 });
  });

  it("internalError creates ApiError(500)", () => {
    const error = internalError("msg");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("msg");
  });
});
