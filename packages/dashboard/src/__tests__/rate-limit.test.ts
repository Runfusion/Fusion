import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import type { Request, Response, NextFunction } from "express";

function mockReq(ip = "127.0.0.1"): Partial<Request> {
  return { ip, socket: { remoteAddress: ip } as any };
}

function mockRes(): Partial<Response> & { _status: number; _json: any; _headers: Record<string, string> } {
  const res: any = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._json = body;
      return res;
    },
  };
  return res;
}

describe("RATE_LIMITS constants", () => {
  it("has correct values for api limit", () => {
    expect(RATE_LIMITS.api).toEqual({ windowMs: 60_000, max: 1000 });
  });

  it("has correct values for mutation limit", () => {
    expect(RATE_LIMITS.mutation).toEqual({ windowMs: 60_000, max: 600 });
  });

  it("has correct values for sse limit", () => {
    expect(RATE_LIMITS.sse).toEqual({ windowMs: 60_000, max: 60 });
  });
});

describe("rateLimit", () => {
  let middleware: ReturnType<typeof rateLimit>;

  beforeEach(() => {
    middleware = rateLimit({ windowMs: 60_000, max: 3 });
  });

  it("allows requests under the limit", () => {
    const req = mockReq();
    const res = mockRes();
    let called = false;
    const next: NextFunction = () => { called = true; };

    middleware(req as Request, res as unknown as Response, next);

    expect(called).toBe(true);
    expect(res._headers["RateLimit-Limit"]).toBe("3");
    expect(res._headers["RateLimit-Remaining"]).toBe("2");
    expect(res._headers["RateLimit-Reset"]).toBeDefined();
  });

  it("blocks requests over the limit with 429", () => {
    const req = mockReq();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    // Exhaust the limit (3 allowed)
    for (let i = 0; i < 3; i++) {
      middleware(req as Request, mockRes() as unknown as Response, next);
    }
    expect(nextCalls).toBe(3);

    // 4th request should be blocked
    const res = mockRes();
    middleware(req as Request, res as unknown as Response, next);

    expect(nextCalls).toBe(3); // next not called
    expect(res._status).toBe(429);
    expect(res._json).toEqual({ error: "Too many requests, please try again later." });
    expect(res._headers["Retry-After"]).toBeDefined();
    expect(res._headers["RateLimit-Remaining"]).toBe("0");
  });

  it("tracks different IPs independently", () => {
    const next: NextFunction = () => {};

    // Exhaust limit for IP A
    for (let i = 0; i < 4; i++) {
      middleware(mockReq("1.1.1.1") as Request, mockRes() as unknown as Response, next);
    }

    // IP B should still be allowed
    const res = mockRes();
    let called = false;
    middleware(mockReq("2.2.2.2") as Request, res as unknown as Response, () => { called = true; });
    expect(called).toBe(true);
    expect(res._headers["RateLimit-Remaining"]).toBe("2");
  });

  it("resets after window expires", async () => {
    // Use a very short window
    const shortMiddleware = rateLimit({ windowMs: 50, max: 1 });
    const req = mockReq();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    shortMiddleware(req as Request, mockRes() as unknown as Response, next);
    expect(nextCalls).toBe(1);

    // Should be blocked
    shortMiddleware(req as Request, mockRes() as unknown as Response, next);
    expect(nextCalls).toBe(1);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should be allowed again
    shortMiddleware(req as Request, mockRes() as unknown as Response, next);
    expect(nextCalls).toBe(2);
  });

  it("uses custom message", () => {
    const mw = rateLimit({ max: 0, message: "Slow down!" });
    const res = mockRes();
    mw(mockReq() as Request, res as unknown as Response, () => {});
    expect(res._json).toEqual({ error: "Slow down!" });
  });

  it("uses default options (100 req/min, 60s window)", () => {
    const defaultMiddleware = rateLimit();
    const req = mockReq();
    const res = mockRes();
    let called = false;

    // First request should be allowed
    defaultMiddleware(req as Request, res as unknown as Response, () => { called = true; });
    expect(called).toBe(true);
    expect(res._headers["RateLimit-Limit"]).toBe("100");
  });

  it("respects custom options", () => {
    const customMiddleware = rateLimit({ windowMs: 30_000, max: 5, message: "Custom" });
    const req = mockReq();
    const res = mockRes();

    customMiddleware(req as Request, res as unknown as Response, () => {});
    expect(res._headers["RateLimit-Limit"]).toBe("5");
  });

  it("uses remoteAddress when ip is undefined", () => {
    const req = { socket: { remoteAddress: "192.168.1.1" } } as Partial<Request>;
    const res = mockRes();
    let called = false;

    middleware(req as Request, res as unknown as Response, () => { called = true; });
    expect(called).toBe(true);
  });

  describe("cleanup interval", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("removes expired entries after window expires", () => {
      const shortWindowMs = 1000;
      const cleanupMiddleware = rateLimit({ windowMs: shortWindowMs, max: 1 });
      const req = mockReq("1.2.3.4");

      // Make first request
      cleanupMiddleware(req as Request, mockRes() as unknown as Response, () => {});

      // Advance time past the window
      vi.advanceTimersByTime(shortWindowMs + 100);

      // New request should be allowed since old entry expired
      const res = mockRes();
      let called = false;
      cleanupMiddleware(req as Request, res as unknown as Response, () => { called = true; });

      expect(called).toBe(true);
      expect(res._headers["RateLimit-Remaining"]).toBe("0");
    });
  });
});

describe("rateLimit with RATE_LIMITS presets", () => {
  it("works with RATE_LIMITS.api preset", () => {
    const apiMiddleware = rateLimit(RATE_LIMITS.api);
    const req = mockReq();
    const res = mockRes();
    let called = false;

    apiMiddleware(req as Request, res as unknown as Response, () => { called = true; });

    expect(called).toBe(true);
    expect(res._headers["RateLimit-Limit"]).toBe(String(RATE_LIMITS.api.max));
  });

  it("works with RATE_LIMITS.mutation preset", () => {
    const mutationMiddleware = rateLimit(RATE_LIMITS.mutation);
    const req = mockReq();

    // Exhaust limit
    for (let i = 0; i < RATE_LIMITS.mutation.max; i++) {
      mutationMiddleware(req as Request, mockRes() as unknown as Response, () => {});
    }

    // Next request should be blocked
    const res = mockRes();
    mutationMiddleware(req as Request, res as unknown as Response, () => {});
    expect(res._status).toBe(429);
  });

  it("works with RATE_LIMITS.sse preset", () => {
    const sseMiddleware = rateLimit(RATE_LIMITS.sse);
    const req = mockReq();

    // Exhaust limit
    for (let i = 0; i < RATE_LIMITS.sse.max; i++) {
      sseMiddleware(req as Request, mockRes() as unknown as Response, () => {});
    }

    // Next request should be blocked
    const blockedRes = mockRes();
    sseMiddleware(req as Request, blockedRes as unknown as Response, () => {});
    expect(blockedRes._status).toBe(429);
  });
});
