// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, isDaemonAuthActive } from "../auth-middleware.js";

describe("createAuthMiddleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;

  beforeEach(() => {
    mockReq = {
      path: "/api/tasks",
      headers: {},
    };

    mockRes = {
      status: vi.fn().mockReturnThis() as unknown as Response["status"],
      json: vi.fn().mockReturnThis() as unknown as Response["json"],
    };

    nextFn = vi.fn();
  });

  it("returns 401 when Authorization header is missing", () => {
    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header uses wrong scheme", () => {
    mockReq.headers = { authorization: "Basic dXNlcjpwYXNz" };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when token is wrong", () => {
    mockReq.headers = { authorization: "Bearer wrong_token" };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("calls next() when token matches", () => {
    const token = "fn_abc123def456789";
    mockReq.headers = { authorization: `Bearer ${token}` };

    const middleware = createAuthMiddleware(token);
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("exempts /api/health path without token", () => {
    mockReq.path = "/api/health";

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("exempts paths starting with /api/health/", () => {
    mockReq.path = "/api/health/check";

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("handles tokens of different lengths without crashing", () => {
    // Test with shorter token
    mockReq.headers = { authorization: "Bearer short" };
    const shortToken = "fn_verylongtoken1234567890123456789012345678901234567890";

    const middleware = createAuthMiddleware(shortToken);
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("handles malformed bearer header (missing space)", () => {
    mockReq.headers = { authorization: "Bearertoken" };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("handles empty bearer token", () => {
    mockReq.headers = { authorization: "Bearer " };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("does not accept remote-login rt query tokens for non-remote API auth", () => {
    mockReq.url = "/api/tasks?rt=frt_persistent_token";

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });
});

describe("isDaemonAuthActive", () => {
  const originalEnv = process.env.FUSION_DAEMON_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FUSION_DAEMON_TOKEN;
    } else {
      process.env.FUSION_DAEMON_TOKEN = originalEnv;
    }
  });

  it("returns true when daemon option with token is provided", () => {
    const result = isDaemonAuthActive({ daemon: { token: "fn_abc123" } });
    expect(result).toBe(true);
  });

  it("returns true when FUSION_DAEMON_TOKEN env var is set", () => {
    process.env.FUSION_DAEMON_TOKEN = "fn_xyz789";
    const result = isDaemonAuthActive();
    expect(result).toBe(true);
  });

  it("returns false when no daemon option and env var not set", () => {
    delete process.env.FUSION_DAEMON_TOKEN;
    const result = isDaemonAuthActive();
    expect(result).toBe(false);
  });

  it("prefers daemon option over env var", () => {
    process.env.FUSION_DAEMON_TOKEN = "fn_env_token";
    const result = isDaemonAuthActive({ daemon: { token: "fn_option_token" } });
    expect(result).toBe(true);
  });
});
