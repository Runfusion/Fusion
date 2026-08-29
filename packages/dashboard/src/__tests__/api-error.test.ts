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
  rethrowAsApiError,
  sendErrorResponse,
  unauthorized,
} from "../api-error.js";
import { resetRuntimeLogSink, setRuntimeLogSink } from "../runtime-logger.js";

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

  it("factories accept an optional trailing cause without changing status/message/details", () => {
    const origin = new Error("origin");

    expect((badRequest("msg", { field: "x" }, origin) as { cause?: unknown }).cause).toBe(origin);
    expect((unauthorized("msg", origin) as { cause?: unknown }).cause).toBe(origin);
    expect((notFound("msg", origin) as { cause?: unknown }).cause).toBe(origin);
    expect((conflict("msg", { a: 1 }, origin) as { cause?: unknown }).cause).toBe(origin);
    expect((rateLimited("msg", 60, origin) as { cause?: unknown }).cause).toBe(origin);
    expect((internalError("msg", origin) as { cause?: unknown }).cause).toBe(origin);

    const withDetails = conflict("msg", { a: 1 }, origin);
    expect(withDetails.statusCode).toBe(409);
    expect(withDetails.message).toBe("msg");
    expect(withDetails.details).toEqual({ a: 1 });
  });
});

/*
FNXC:ApiErrorDiagnostics 2026-07-26-11:20:
Invariant under test: ANY 5xx that reaches the boundary through `rethrowAsApiError`
logs the ORIGIN throw site's stack, not the rethrow site's, and preserves the wrapper
chain — across the Error branch, the non-Error fallback branch, and multi-level wraps.
Asserting only the single reported repro (a plain Error) would have passed before the
fix, since an unwrapped Error's own stack was already the origin.
*/
describe("rethrowAsApiError diagnostics", () => {
  function findApiErrorLog(): Record<string, unknown> {
    const event = runtimeLogEvents.find((e) => e.scope === "api:error" && e.message === "Request failed");
    expect(event, "expected an api:error 'Request failed' log entry").toBeDefined();
    return (event?.context ?? {}) as Record<string, unknown>;
  }

  /** Named so the origin frame is identifiable in a captured stack. */
  function originThrowSiteMarker(): never {
    throw new Error("store read failed");
  }

  async function runThroughBoundary(throwing: () => unknown): Promise<MockResponse> {
    const handler = catchHandler(async () => {
      try {
        await throwing();
      } catch (error) {
        rethrowAsApiError(error);
      }
    });
    const mock = createMockResponse();
    await handler({} as Request, mock.res, vi.fn<NextFunction>());
    return mock;
  }

  it("logs the origin stack, not the rethrow site, for the Error branch", async () => {
    const { statusMock, jsonMock } = await runThroughBoundary(originThrowSiteMarker);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "store read failed" });

    const context = findApiErrorLog();
    expect(context.statusCode).toBe(500);
    expect(context.message).toBe("store read failed");
    expect(typeof context.stack).toBe("string");
    expect(context.stack).toContain("originThrowSiteMarker");
    expect(context.stack).not.toContain("rethrowAsApiError");
  });

  it("preserves a multi-level cause chain and still reports the deepest origin stack", async () => {
    const { jsonMock } = await runThroughBoundary(() => {
      try {
        originThrowSiteMarker();
      } catch (error) {
        throw new Error("task detail load failed", { cause: error });
      }
    });

    expect(jsonMock).toHaveBeenCalledWith({ error: "task detail load failed" });

    const context = findApiErrorLog();
    // Deepest link in the chain is the true origin.
    expect(context.stack).toContain("originThrowSiteMarker");
    // Every wrapper past the boundary error survives in `cause`.
    expect(context.cause).toContain("task detail load failed");
    expect(context.cause).toContain("store read failed");
  });

  it("keeps the raw thrown value reachable on the non-Error fallback branch", async () => {
    const { statusMock, jsonMock } = await runThroughBoundary(() => {
      throw "raw string failure";
    });

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Internal server error" });

    const context = findApiErrorLog();
    expect(context.message).toBe("Internal server error");
    expect(context.cause).toContain("raw string failure");
  });

  it("keeps the origin stack for an Error with an empty message (fallback branch)", async () => {
    const empty = new Error("");
    const { jsonMock } = await runThroughBoundary(() => {
      throw empty;
    });

    expect(jsonMock).toHaveBeenCalledWith({ error: "Internal server error" });

    const context = findApiErrorLog();
    expect(context.cause).toBe(empty.stack);
    expect(context.stack).toBe(empty.stack);
  });

  it("passes an ApiError through untouched, preserving status and details", async () => {
    const handler = catchHandler(async () => {
      try {
        throw notFound("Task FN-8610 not found");
      } catch (error) {
        rethrowAsApiError(error);
      }
    });
    const { res, statusMock, jsonMock } = createMockResponse();

    await handler({} as Request, res, vi.fn<NextFunction>());

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Task FN-8610 not found" });
    // 4xx must remain unlogged.
    expect(runtimeLogEvents).toHaveLength(0);
  });
});

describe("sendErrorResponse cause-chain logging", () => {
  it("reports an unwrapped error's own stack with no cause", () => {
    const { res } = createMockResponse();
    const error = new Error("plain");

    sendErrorResponse(res, 500, "plain", { error });

    const context = runtimeLogEvents[0]?.context as Record<string, unknown>;
    expect(context.stack).toBe(error.stack);
    expect(context.cause).toBeUndefined();
  });

  it("omits stack and cause when the thrown value is not an Error", () => {
    const { res } = createMockResponse();

    sendErrorResponse(res, 500, "weird", { error: { code: 500 } });

    const context = runtimeLogEvents[0]?.context as Record<string, unknown>;
    expect(context.stack).toBeUndefined();
    expect(context.cause).toBeUndefined();
  });

  it("terminates on a cyclic cause chain", () => {
    const { res } = createMockResponse();
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    sendErrorResponse(res, 500, "cycle", { error: b });

    const context = runtimeLogEvents[0]?.context as Record<string, unknown>;
    expect(context.cause).toContain("a");
    expect(String(context.cause).split("Caused by:").length).toBeLessThanOrEqual(8);
  });

  it("does not log or alter the body for non-5xx even when an error is supplied", () => {
    const { res, statusMock, jsonMock } = createMockResponse();

    sendErrorResponse(res, 409, "Conflict", { error: new Error("origin"), details: { a: 1 } });

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Conflict", details: { a: 1 } });
    expect(runtimeLogEvents).toHaveLength(0);
  });
});
