// @vitest-environment node

/*
FNXC:DaemonAuth 2026-08-09-03:04:
Guards the invariant that absence of a daemon token never implies open access.
Before this, auth mounted only `if (daemonToken)`, so a launch with no token served
every `/api/*` route — including the shell-capable terminal WebSocket — unauthenticated,
which is a distinct and silent second no-auth mode alongside the explicit `--no-auth` flag.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createUnconfiguredAuthRefusalMiddleware } from "../auth-middleware.js";

describe("createUnconfiguredAuthRefusalMiddleware", () => {
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;

  const run = (path: string) => {
    const middleware = createUnconfiguredAuthRefusalMiddleware();
    middleware({ path, headers: {} } as Request, mockRes as Response, nextFn);
  };

  beforeEach(() => {
    mockRes = {
      status: vi.fn().mockReturnThis() as unknown as Response["status"],
      json: vi.fn().mockReturnThis() as unknown as Response["json"],
    };
    nextFn = vi.fn();
  });

  it("refuses an /api/* route rather than serving it open", () => {
    run("/api/tasks");

    expect(mockRes.status).toHaveBeenCalledWith(503);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("names both remedies so an operator can act on the refusal", () => {
    run("/api/tasks");

    const payload = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      error: string;
      message: string;
    };
    expect(payload.error).toBe("AuthNotConfigured");
    // The operator hitting this is mid-launch; a bare status code strands them.
    expect(payload.message).toMatch(/token/i);
    expect(payload.message).toMatch(/--no-auth/);
  });

  it("refuses a sensitive route that would otherwise expose system control", () => {
    run("/api/system/restart");

    expect(mockRes.status).toHaveBeenCalledWith(503);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("keeps the liveness probe reachable so orchestrators can observe the misconfiguration", () => {
    run("/api/health");

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("keeps the SPA shell public so the browser can render an error instead of a blank page", () => {
    run("/");

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("keeps static assets public", () => {
    run("/assets/index-abc123.js");

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
