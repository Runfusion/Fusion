import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllProviderUsage,
  clearUsageCache,
  ProviderUsage,
  calculatePace,
} from "./usage.js";

// Mock the https module
const mockRequest = vi.fn();
vi.mock("node:https", () => ({
  request: (...args: any[]) => mockRequest(...args),
}));

// Mock fs
const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

describe("usage", () => {
  beforeEach(() => {
    clearUsageCache();
    mockRequest.mockClear();
    mockReadFileSync.mockClear();
    vi.stubEnv("HOME", "/home/testuser");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("fetchAllProviderUsage", () => {
    it("returns providers array even when all are not authenticated", async () => {
      // All credential files don't exist
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();

      expect(providers).toHaveLength(5);
      expect(providers.map((p) => p.name)).toContain("Claude");
      expect(providers.map((p) => p.name)).toContain("Codex");
      expect(providers.map((p) => p.name)).toContain("Gemini");
      expect(providers.map((p) => p.name)).toContain("Minimax");
      expect(providers.map((p) => p.name)).toContain("Zai");

      // All should be no-auth status
      for (const p of providers) {
        expect(p.status).toBe("no-auth");
        expect(p.error).toBeDefined();
      }
    });

    it("returns cached data within TTL", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const first = await fetchAllProviderUsage();
      const second = await fetchAllProviderUsage();

      // Should be the same array reference due to caching
      expect(second).toBe(first);
    });

    it("fetches fresh data after cache expires", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const first = await fetchAllProviderUsage();

      // Manually expire cache
      clearUsageCache();

      const second = await fetchAllProviderUsage();

      // Should be different array reference
      expect(second).not.toBe(first);
      expect(second).toHaveLength(5);
    });
  });

  describe("Claude provider", () => {
    it("detects no auth when credentials file doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude");

      expect(claude).toBeDefined();
      expect(claude!.status).toBe("no-auth");
      expect(claude!.error).toContain("No Claude CLI credentials");
    });

    it("detects missing scope error", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["other:scope"], // missing user:profile
          });
        }
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude");

      expect(claude!.status).toBe("no-auth");
      expect(claude!.error).toContain("user:profile scope");
    });

    it("parses usage data from API response", async () => {
      const mockResponse = {
        five_hour: {
          utilization: 45.5,
          resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
        },
        seven_day: {
          utilization: 23.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days
        },
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
            subscriptionType: "pro",
          });
        }
        throw new Error("File not found");
      });

      // Mock https request
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.plan).toBe("Pro");
      expect(claude.windows).toHaveLength(2);

      const sessionWindow = claude.windows.find((w) => w.label.includes("Session"));
      expect(sessionWindow).toBeDefined();
      expect(sessionWindow!.percentUsed).toBe(45.5);
      expect(sessionWindow!.percentLeft).toBe(54.5);
      expect(sessionWindow!.resetText).toContain("resets in");
    });

    it("handles 429 rate limit with retry - succeeds on second attempt", async () => {
      // Use fake timers for controlled retry delays
      vi.useFakeTimers();

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      const mockResponse = {
        five_hour: { utilization: 50, resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
      };

      let requestCount = 0;
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockRes = {
          statusCode: requestCount === 1 ? 429 : 200, // First request fails with 429
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(requestCount === 1 ? { error: "rate limited" } : mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providersPromise = fetchAllProviderUsage();
      
      // Advance timers to let retry delays complete (1s for first retry)
      await vi.advanceTimersByTimeAsync(1000);
      
      const providers = await providersPromise;
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(requestCount).toBe(2); // Initial + 1 retry
      expect(claude.status).toBe("ok");
      expect(claude.windows).toHaveLength(1);

      vi.useRealTimers();
    });

    it("fails after max retries exhausted on 429", async () => {
      vi.useFakeTimers();

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      let requestCount = 0;
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockRes = {
          statusCode: 429, // Always rate limited
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "rate limited"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providersPromise = fetchAllProviderUsage();
      
      // Advance through all retry delays: 1s + 2s + 4s = 7s
      await vi.advanceTimersByTimeAsync(7000);
      
      const providers = await providersPromise;
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(requestCount).toBe(3); // Max 3 attempts
      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Rate limited by Anthropic API");
      expect(claude.error).toContain("please try again in a few moments");

      vi.useRealTimers();
    });

    it("does not retry on 401 auth errors - fails immediately", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "expired-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      let requestCount = 0;
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "unauthorized"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(requestCount).toBe(1); // No retries
      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Auth expired");
    });

    it("does not retry on 403 auth errors - fails immediately", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "forbidden-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      let requestCount = 0;
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockRes = {
          statusCode: 403,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "forbidden"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(requestCount).toBe(1); // No retries
      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Auth expired");
    });

    it("does not retry on 5xx server errors - fails immediately", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      let requestCount = 0;
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockRes = {
          statusCode: 503, // Service unavailable
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "service unavailable"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(requestCount).toBe(1); // No retries
      expect(claude.status).toBe("error");
      expect(claude.error).toBe("HTTP 503");
    });

    it("retries with exponential backoff delays (1s, 2s, 4s)", async () => {
      vi.useFakeTimers();

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      let requestCount = 0;
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockRes = {
          statusCode: 429,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "rate limited"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providersPromise = fetchAllProviderUsage();

      // Advance through all retry delays: 1s + 2s + 4s = 7s
      await vi.advanceTimersByTimeAsync(7000);

      const providers = await providersPromise;
      const claude = providers.find((p) => p.name === "Claude")!;

      // Should make 3 attempts (initial + 2 retries) with exponential backoff
      expect(requestCount).toBe(3);
      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Rate limited by Anthropic API");

      vi.useRealTimers();
    });

    it("handles 401 auth error", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "expired-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "unauthorized"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Auth expired");
    });
  });

  describe("Codex provider", () => {
    it("detects no auth when auth.json doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const codex = providers.find((p) => p.name === "Codex");

      expect(codex).toBeDefined();
      expect(codex!.status).toBe("no-auth");
      expect(codex!.error).toContain("No Codex credentials");
    });

    it("parses usage data from API response", async () => {
      const mockResponse = {
        email: "test@example.com",
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 67.5,
            limit_window_seconds: 5 * 60 * 60, // 5 hours
            reset_after_seconds: 2 * 60 * 60, // 2 hours
          },
          secondary_window: {
            used_percent: 12.0,
            limit_window_seconds: 7 * 24 * 60 * 60, // 7 days
            reset_after_seconds: 5 * 24 * 60 * 60, // 5 days
          },
        },
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("codex")) {
          return JSON.stringify({
            tokens: {
              access_token: "test-token",
              id_token: "header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature",
            },
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const codex = providers.find((p) => p.name === "Codex")!;

      expect(codex.status).toBe("ok");
      expect(codex.email).toBe("test@example.com");
      expect(codex.plan).toBe("Pro");
      expect(codex.windows).toHaveLength(2);

      const sessionWindow = codex.windows.find((w) => w.label.includes("Session"));
      expect(sessionWindow).toBeDefined();
      expect(sessionWindow!.percentUsed).toBe(67.5);
      expect(sessionWindow!.percentLeft).toBe(32.5);
    });
  });

  describe("Gemini provider", () => {
    it("detects no auth when oauth_creds.json doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const gemini = providers.find((p) => p.name === "Gemini");

      expect(gemini).toBeDefined();
      expect(gemini!.status).toBe("no-auth");
      expect(gemini!.error).toContain("No Gemini credentials");
    });

    it("parses usage buckets from API response", async () => {
      const mockResponse = {
        buckets: [
          {
            modelId: "gemini-2.0-flash",
            remainingFraction: 0.85,
            resetTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          },
          {
            modelId: "gemini-2.0-pro",
            remainingFraction: 0.92,
            resetTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
          },
        ],
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("gemini")) {
          if (path.includes("oauth_creds")) {
            return JSON.stringify({
              access_token: "test-token",
              id_token: "header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature",
            });
          }
          // settings.json doesn't exist (oauth-personal is default)
          throw new Error("File not found");
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const gemini = providers.find((p) => p.name === "Gemini")!;

      expect(gemini.status).toBe("ok");
      expect(gemini.email).toBe("test@example.com");
      expect(gemini.windows).toHaveLength(2);

      const flashWindow = gemini.windows.find((w) => w.label.includes("Flash"));
      expect(flashWindow).toBeDefined();
      expect(flashWindow!.percentUsed).toBe(15); // 100 - 85
      expect(flashWindow!.percentLeft).toBe(85);
    });

    it("handles unsupported auth type (api-key)", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("gemini")) {
          if (path.includes("oauth_creds")) {
            return JSON.stringify({
              access_token: "test-token",
            });
          }
          if (path.includes("settings")) {
            return JSON.stringify({
              security: {
                auth: {
                  selectedType: "api-key",
                },
              },
            });
          }
        }
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const gemini = providers.find((p) => p.name === "Gemini")!;

      expect(gemini.status).toBe("error");
      expect(gemini.error).toContain("Unsupported auth type");
    });
  });

  describe("Minimax provider", () => {
    it("detects no auth when credentials file doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax");

      expect(minimax).toBeDefined();
      expect(minimax!.status).toBe("no-auth");
      expect(minimax!.error).toContain("No Minimax credentials");
    });

    it("detects no auth when access_token is missing", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("minimax")) {
          return JSON.stringify({
            // missing access_token
            refresh_token: "test-refresh",
          });
        }
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax");

      expect(minimax!.status).toBe("no-auth");
      expect(minimax!.error).toContain("No Minimax access token");
    });

    it("parses usage data from API response", async () => {
      const mockResponse = {
        quota: {
          total: 1000,
          used: 350,
          remaining: 650,
        },
        reset_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("minimax")) {
          return JSON.stringify({
            access_token: "test-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax")!;

      expect(minimax.status).toBe("ok");
      expect(minimax.windows).toHaveLength(1);

      const weeklyWindow = minimax.windows[0];
      expect(weeklyWindow.label).toBe("Weekly");
      expect(weeklyWindow.percentUsed).toBe(35); // 350/1000 * 100
      expect(weeklyWindow.percentLeft).toBe(65);
      expect(weeklyWindow.resetText).toContain("resets in");
      expect(weeklyWindow.resetMs).toBeDefined();
      expect(weeklyWindow.windowDurationMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("handles 401 auth error", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("minimax")) {
          return JSON.stringify({
            access_token: "expired-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "unauthorized"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax")!;

      expect(minimax.status).toBe("error");
      expect(minimax.error).toContain("Auth expired");
    });

    it("handles 403 auth error", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("minimax")) {
          return JSON.stringify({
            access_token: "forbidden-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 403,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "forbidden"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax")!;

      expect(minimax.status).toBe("error");
      expect(minimax.error).toContain("Auth expired");
    });
  });

  describe("Zai provider", () => {
    it("detects no auth when credentials file doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai");

      expect(zai).toBeDefined();
      expect(zai!.status).toBe("no-auth");
      expect(zai!.error).toContain("No Zai credentials");
    });

    it("detects no auth when access_token is missing", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("zai")) {
          return JSON.stringify({
            // missing access_token
            refresh_token: "test-refresh",
          });
        }
        throw new Error("File not found");
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai");

      expect(zai!.status).toBe("no-auth");
      expect(zai!.error).toContain("No Zai access token");
    });

    it("parses daily usage data from API response", async () => {
      const mockResponse = {
        data: {
          total_credits: 10000,
          used_credits: 2500,
          reset_date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // 8 hours (daily)
        },
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("zai")) {
          return JSON.stringify({
            access_token: "test-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("ok");
      expect(zai.windows).toHaveLength(1);

      const dailyWindow = zai.windows[0];
      expect(dailyWindow.label).toBe("Daily");
      expect(dailyWindow.percentUsed).toBe(25); // 2500/10000 * 100
      expect(dailyWindow.percentLeft).toBe(75);
      expect(dailyWindow.resetText).toContain("resets in");
      expect(dailyWindow.resetMs).toBeDefined();
      expect(dailyWindow.windowDurationMs).toBe(24 * 60 * 60 * 1000);
    });

    it("parses monthly usage data from API response", async () => {
      const mockResponse = {
        data: {
          total_credits: 10000,
          used_credits: 5000,
          reset_date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(), // 15 days (monthly)
        },
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("zai")) {
          return JSON.stringify({
            access_token: "test-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("ok");
      expect(zai.windows).toHaveLength(2);

      const monthlyWindow = zai.windows[1];
      expect(monthlyWindow.label).toBe("Monthly");
      expect(monthlyWindow.percentUsed).toBe(50); // 5000/10000 * 100
      expect(monthlyWindow.percentLeft).toBe(50);
      expect(monthlyWindow.resetText).toContain("resets in");
      expect(monthlyWindow.resetMs).toBeDefined();
      expect(monthlyWindow.windowDurationMs).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it("handles 401 auth error", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("zai")) {
          return JSON.stringify({
            access_token: "expired-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "unauthorized"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("error");
      expect(zai.error).toContain("Auth expired");
    });

    it("handles 403 auth error", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("zai")) {
          return JSON.stringify({
            access_token: "forbidden-token",
          });
        }
        throw new Error("File not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 403,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error": "forbidden"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("error");
      expect(zai.error).toContain("Auth expired");
    });
  });

  describe("calculatePace helper", () => {
    it("returns ahead status when usage exceeds elapsed time by >5%", () => {
      // 70% used, 50% elapsed = 20% ahead (3 days remaining out of 7 = 57% elapsed, 70 - 57 = 13 > 5)
      // Actually: 100 - (3/7 * 100) = 57.14% elapsed
      // 70 - 57.14 = 12.86% > 5% → ahead
      const pace = calculatePace(70, 3 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(pace).toBeDefined();
      expect(pace!.status).toBe("ahead");
      expect(pace!.percentElapsed).toBe(57);
      expect(pace!.message).toContain("over pace");
    });

    it("returns behind status when usage is under elapsed time by >5%", () => {
      // 20% used, 57% elapsed = 37% behind
      const pace = calculatePace(20, 3 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(pace).toBeDefined();
      expect(pace!.status).toBe("behind");
      expect(pace!.percentElapsed).toBe(57);
      expect(pace!.message).toContain("under pace");
    });

    it("returns on-track status when within 5% of elapsed time", () => {
      // 52% used, 57% elapsed = 5% difference (within threshold)
      const pace = calculatePace(52, 3.5 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(pace).toBeDefined();
      expect(pace!.status).toBe("on-track");
      expect(pace!.message).toBe("On pace with time elapsed");
    });

    it("returns undefined when resetMs is undefined", () => {
      const pace = calculatePace(50, undefined, 7 * 24 * 60 * 60 * 1000);
      expect(pace).toBeUndefined();
    });

    it("returns undefined when windowDurationMs is undefined", () => {
      const pace = calculatePace(50, 3 * 24 * 60 * 60 * 1000, undefined);
      expect(pace).toBeUndefined();
    });

    it("returns undefined when resetMs is 0 or negative", () => {
      expect(calculatePace(50, 0, 7 * 24 * 60 * 60 * 1000)).toBeUndefined();
      expect(calculatePace(50, -1000, 7 * 24 * 60 * 60 * 1000)).toBeUndefined();
    });

    it("returns undefined when windowDurationMs is 0 or negative", () => {
      expect(calculatePace(50, 3 * 24 * 60 * 60 * 1000, 0)).toBeUndefined();
      expect(calculatePace(50, 3 * 24 * 60 * 60 * 1000, -1000)).toBeUndefined();
    });

    it("clamps percentUsed to 0-100 range", () => {
      // Test with negative percentUsed
      let pace = calculatePace(-10, 3 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(pace).toBeDefined();
      expect(pace!.status).toBe("behind");

      // Test with percentUsed > 100
      pace = calculatePace(150, 3 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(pace).toBeDefined();
      expect(pace!.status).toBe("ahead");
    });
  });

  describe("error handling", () => {
    it("handles network errors gracefully", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      mockRequest.mockImplementation(() => {
        const mockReq = {
          on: vi.fn((event: string, handler: any) => {
            if (event === "error") {
              handler(new Error("Network error"));
            }
          }),
          write: vi.fn(),
          end: vi.fn(),
        };
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Network error");
    });

    it("handles timeout errors gracefully", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      mockRequest.mockImplementation(() => {
        const mockReq = {
          on: vi.fn((event: string, handler: any) => {
            if (event === "timeout") {
              handler();
            }
          }),
          write: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn(),
        };
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
    });
  });

  describe("formatDuration helper", () => {
    it("formats duration correctly via resetText", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("codex")) {
          return JSON.stringify({
            tokens: {
              access_token: "test-token",
            },
          });
        }
        throw new Error("File not found");
      });

      const mockResponse = {
        rate_limit: {
          primary_window: {
            used_percent: 50,
            reset_after_seconds: 3661, // 1h 1m 1s
          },
        },
      };

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from(JSON.stringify(mockResponse)));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const codex = providers.find((p) => p.name === "Codex")!;

      expect(codex.windows[0].resetText).toContain("1h 1m");
    });
  });

  describe("pace integration with provider windows", () => {
    it("attaches pace to Minimax weekly window with valid timing data", async () => {
      const mockResponse = {
        quota: {
          total: 1000,
          used: 350,
          remaining: 650,
        },
        reset_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("minimax")) {
          return JSON.stringify({ access_token: "test-token" });
        }
        throw new Error("File not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from(JSON.stringify(mockResponse)));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax")!;

      expect(minimax.status).toBe("ok");
      expect(minimax.windows).toHaveLength(1);

      const weeklyWindow = minimax.windows[0];
      expect(weeklyWindow.label).toBe("Weekly");
      expect(weeklyWindow.pace).toBeDefined();
      expect(weeklyWindow.pace!.status).toBe("behind");
      expect(weeklyWindow.pace!.percentElapsed).toBeGreaterThan(0);
      expect(weeklyWindow.pace!.message).toContain("under pace");
    });

    it("does not attach pace when resetMs is 0 (window already reset)", async () => {
      const mockResponse = {
        quota: { total: 1000, used: 0, remaining: 1000 },
        reset_at: new Date(Date.now() - 1000).toISOString(),
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("minimax")) {
          return JSON.stringify({ access_token: "test-token" });
        }
        throw new Error("File not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };

      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from(JSON.stringify(mockResponse)));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax")!;

      expect(minimax.status).toBe("ok");
      expect(minimax.windows[0].resetMs).toBe(0);
      expect(minimax.windows[0].pace).toBeUndefined();
    });
  });
});
