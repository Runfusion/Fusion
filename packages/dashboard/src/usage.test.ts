import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllProviderUsage,
  clearUsageCache,
  ProviderUsage,
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

      expect(providers).toHaveLength(3);
      expect(providers.map((p) => p.name)).toContain("Claude");
      expect(providers.map((p) => p.name)).toContain("Codex");
      expect(providers.map((p) => p.name)).toContain("Gemini");

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
      expect(second).toHaveLength(3);
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
});
