import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllProviderUsage,
  clearUsageCache,
  ProviderUsage,
  calculatePace,
  _setSleepFn,
  _resetSleepFn,
  _stripClaudeAnsi,
  _parseClaudePercentLine,
  _parseClaudeResetLine,
  _parseClaudeResetText,
  withTimeout,
  CLAUDE_FETCH_TIMEOUT_MS,
  _clearRefreshedToken,
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

// Mock child_process
const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

// Mock node-pty for CLI fallback — default: not available (simulates test env)
vi.mock("node-pty", () => {
  throw new Error("node-pty not available in test environment");
});

describe("usage", () => {
  beforeEach(() => {
    clearUsageCache();
    _clearRefreshedToken();
    mockRequest.mockClear();
    mockReadFileSync.mockClear();
    mockExecFileSync.mockClear();
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
    /**
     * Helper to set up mocks for Claude tests.
     * Claude now reads credentials from files/keychain and calls the API directly.
     */
    function setupClaudeMocks(options: {
      /** Credential file content (null = file not found) */
      credFileContent?: any;
      /** Keychain credential content (null = keychain error) */
      keychainContent?: any;
    }) {
      const { credFileContent = null, keychainContent = null } = options;

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude") && credFileContent !== null) {
          return JSON.stringify(credFileContent);
        }
        throw new Error("File not found");
      });

      mockExecFileSync.mockImplementation((cmd: string, _args: string[]) => {
        // Keychain read via `security` command
        if (cmd === "security") {
          if (keychainContent !== null) {
            return JSON.stringify(keychainContent);
          }
          throw new Error("Keychain item not found");
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });
    }

    /**
     * Helper to set up mock HTTPS request for Claude usage API.
     */
    function setupClaudeApiResponse(mockResponse: any, statusCode = 200) {
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode,
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
    }

    it("detects no auth when credentials file doesn't exist and keychain fails", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude");

      expect(claude).toBeDefined();
      expect(claude!.status).toBe("no-auth");
      expect(claude!.error).toContain("No Claude CLI credentials");
    });

    it("reads credentials from macOS keychain when file paths fail", async () => {
      setupClaudeMocks({
        keychainContent: {
          claudeAiOauth: {
            accessToken: "keychain-token",
            scopes: ["user:profile"],
            subscriptionType: "pro",
          },
        },
      });

      setupClaudeApiResponse({
        five_hour: {
          utilization: 30.0,
          resets_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 15.0,
          resets_at: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.plan).toBe("Pro");
      expect(claude.windows).toHaveLength(2);

      // Verify keychain command was called with correct arguments
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf-8", timeout: 5000 }
      );
    });

    it("parses keychain credentials with rateLimitTier for plan detection", async () => {
      setupClaudeMocks({
        keychainContent: {
          claudeAiOauth: {
            accessToken: "keychain-token",
            scopes: ["user:profile"],
            rateLimitTier: "default_claude_max_20x",
          },
        },
      });

      setupClaudeApiResponse({
        five_hour: {
          utilization: 25.0,
          resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.plan).toBe("Max");
    });

    it("detects missing scope error", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["other:scope"], // missing user:profile
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude");

      expect(claude!.status).toBe("no-auth");
      expect(claude!.error).toContain("user:profile scope");
    });

    it("parses usage data from API response", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "pro",
        },
      });

      setupClaudeApiResponse({
        five_hour: {
          utilization: 45.5,
          resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 23.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
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

    it("parses all four usage windows from API response", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "max",
        },
      });

      setupClaudeApiResponse({
        five_hour: {
          utilization: 40.0,
          resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 20.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
        seven_day_sonnet: {
          utilization: 15.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
        seven_day_opus: {
          utilization: 5.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.windows).toHaveLength(4);
      expect(claude.windows.map((w) => w.label)).toEqual([
        "Session (5h)",
        "Weekly",
        "Weekly (Sonnet)",
        "Weekly (Opus)",
      ]);
    });

    it("falls back to CLI parsing on 429 rate limit", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
        },
      });

      // No-op sleep so retries don't actually wait
      _setSleepFn(async () => {});

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 429,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error":"rate_limited"}'));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      // After 429 retries exhausted, falls back to CLI which will fail in test
      // (node-pty not available) — so we get the CLI fallback error
      expect(claude.status).toBe("error");
      // Should have retried 3 times (CLAUDE_MAX_RETRIES)
      expect(mockRequest).toHaveBeenCalledTimes(3);

      _resetSleepFn();
    });

    it("handles 401 auth error", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "expired-token",
          scopes: ["user:profile"],
        },
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "unauthorized"}'));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      // Auth failure falls back to CLI (which fails in test env due to mocked node-pty)
      expect(claude.status).toBe("error");
    });

    it("handles 403 auth error", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "forbidden-token",
          scopes: ["user:profile"],
        },
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 403,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "forbidden"}'));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      // Auth failure falls back to CLI (which fails in test env due to mocked node-pty)
      expect(claude.status).toBe("error");
    });

    it("does not send anthropic-beta header in requests", async () => {
      const mockResponse = {
        five_hour: { utilization: 10.0 },
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      let capturedHeaders: Record<string, string> = {};
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        capturedHeaders = options.headers || {};
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

      await fetchAllProviderUsage();

      // Verify no anthropic-beta header is sent
      expect(capturedHeaders).not.toHaveProperty("anthropic-beta");
    });

    it("retries on 429 and succeeds after transient rate limit", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      _setSleepFn(noopSleep);

      const mockResponse = {
        five_hour: {
          utilization: 20.0,
          resets_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        },
      };

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      let callCount = 0;
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((options: any, callback: any) => {
        callCount++;
        const is429 = callCount <= 2; // First 2 calls return 429, third succeeds
        const mockRes = {
          statusCode: is429 ? 429 : 200,
          headers: is429 ? { "retry-after": "1" } : {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              const body = is429
                ? '{"error":"rate_limited"}'
                : JSON.stringify(mockResponse);
              handler(Buffer.from(body));
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
      expect(claude.windows).toHaveLength(1);
      expect(claude.windows[0].percentUsed).toBe(20);

      // Verify sleep was called for retries (2 retry sleeps)
      expect(noopSleep).toHaveBeenCalledTimes(2);

      _resetSleepFn();
    });

    it("handles malformed JSON response", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
        },
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from("not valid json {{{"));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toBeDefined();
    });

    it("reports rate limited after all retries exhausted on 429", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      _setSleepFn(noopSleep);

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      // Always return 429
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 429,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error":"rate_limited"}'));
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

      // After 429 retries exhausted, falls back to CLI which fails in test
      // (node-pty not available) — so we get the CLI fallback error
      expect(claude.status).toBe("error");

      // Verify retries happened (2 sleeps for 3 attempts)
      expect(noopSleep).toHaveBeenCalledTimes(2);

      _resetSleepFn();
    });

    it("uses exponential backoff delays when retry-after header is absent", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      _setSleepFn(noopSleep);

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      // Always return 429 without retry-after
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 429,
          headers: {}, // No retry-after header
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error":"rate_limited"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      await fetchAllProviderUsage();

      // Exponential backoff: 1000ms * 2^0 = 1000, 1000ms * 2^1 = 2000
      expect(noopSleep).toHaveBeenCalledTimes(2);
      expect(noopSleep).toHaveBeenNthCalledWith(1, 1000);
      expect(noopSleep).toHaveBeenNthCalledWith(2, 2000);

      _resetSleepFn();
    });

    it("respects retry-after header value for delay", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      _setSleepFn(noopSleep);

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      // 429 with retry-after: 5 seconds
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockRes = {
          statusCode: 429,
          headers: { "retry-after": "5" },
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") {
              handler(Buffer.from('{"error":"rate_limited"}'));
            }
            if (event === "end") {
              handler();
            }
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      await fetchAllProviderUsage();

      // Should use retry-after value (5s = 5000ms) for both retries
      expect(noopSleep).toHaveBeenCalledTimes(2);
      expect(noopSleep).toHaveBeenNthCalledWith(1, 5000);
      expect(noopSleep).toHaveBeenNthCalledWith(2, 5000);

      _resetSleepFn();
    });

    it("populates resetAt timestamp for session window from API response", async () => {
      const resetTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "pro",
        },
      });

      setupClaudeApiResponse({
        five_hour: {
          utilization: 45.5,
          resets_at: resetTime.toISOString(),
        },
        seven_day: {
          utilization: 23.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.windows).toHaveLength(2);

      const sessionWindow = claude.windows.find((w) => w.label.includes("Session"))!;
      expect(sessionWindow.resetAt).toBe(resetTime.toISOString());
      expect(sessionWindow.resetText).toContain("resets in");

      const weeklyWindow = claude.windows.find((w) => w.label === "Weekly")!;
      expect(weeklyWindow.resetAt).toBeDefined();
    });

    it("omits resetAt when API response has no resets_at field", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "pro",
        },
      });

      setupClaudeApiResponse({
        five_hour: {
          utilization: 30.0,
          // no resets_at field
        },
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      const sessionWindow = claude.windows.find((w) => w.label.includes("Session"))!;
      expect(sessionWindow.resetAt).toBeUndefined();
      expect(sessionWindow.resetText).toBeNull();
    });

    it("handles empty JSON object from API gracefully", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "pro",
        },
      });

      setupClaudeApiResponse({});

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.plan).toBe("Pro");
      expect(claude.windows).toHaveLength(0);
    });

    it("preserves plan detection from subscriptionType in credentials", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "team",
        },
      });

      setupClaudeApiResponse({ five_hour: { utilization: 10 } });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.plan).toBe("Team");
    });

    it("does not retry on 401 auth errors", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      _setSleepFn(noopSleep);

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "expired-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
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

      // Auth failure falls back to CLI (which fails in test env due to mocked node-pty)
      expect(claude.status).toBe("error");
      // No retries should happen for auth errors
      expect(noopSleep).not.toHaveBeenCalled();

      _resetSleepFn();
    });

    it("preserves plan detection from rateLimitTier for Pro", async () => {
      setupClaudeMocks({
        keychainContent: {
          claudeAiOauth: {
            accessToken: "test-token",
            scopes: ["user:profile"],
            rateLimitTier: "default_claude_pro_5x",
          },
        },
      });

      setupClaudeApiResponse({ five_hour: { utilization: 10 } });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.plan).toBe("Pro");
    });

    it("does not retry on 403 auth errors", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      _setSleepFn(noopSleep);

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes("claude")) {
          return JSON.stringify({
            accessToken: "forbidden-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
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
      const claude = providers.find((p) => p.name === "Claude")!;

      // Auth failure falls back to CLI (which fails in test env due to mocked node-pty)
      expect(claude.status).toBe("error");
      // No retries should happen for auth errors
      expect(noopSleep).not.toHaveBeenCalled();

      _resetSleepFn();
    });

    describe("token refresh", () => {
      it("refreshes expired token before calling usage API", async () => {
        const expiredAt = Date.now() - 60_000; // expired 1 minute ago
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "expired-token",
              expiresAt: expiredAt,
              refreshToken: "refresh-token-123",
              scopes: ["user:profile"],
              subscriptionType: "max",
            },
          },
        });

        // Track which requests are made
        const requestUrls: string[] = [];
        const capturedOptions: any[] = [];
        const capturedBodies: string[] = [];
        const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
        mockRequest.mockImplementation((options: any, callback: any) => {
          const url = `https://${options.hostname}${options.path}`;
          requestUrls.push(url);
          capturedOptions.push(options);

          if (url.includes("oauth/token")) {
            // Token refresh succeeds
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({ access_token: "new-fresh-token" })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          } else {
            // Usage API succeeds
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({
                  five_hour: { utilization: 50.0, resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
                })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          }
          return mockReq;
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        expect(claude.status).toBe("ok");
        expect(claude.windows).toHaveLength(1);
        expect(claude.windows[0].percentUsed).toBe(50);
        // Should have called token refresh first, then usage API
        expect(requestUrls).toHaveLength(2);
        expect(requestUrls[0]).toContain("oauth/token");
        expect(requestUrls[1]).toContain("oauth/usage");
      });

      it("sends refresh request to platform.claude.com with correct content-type and client_id", async () => {
        const expiredAt = Date.now() - 60_000;
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "expired-token",
              expiresAt: expiredAt,
              refreshToken: "refresh-token-456",
              scopes: ["user:profile"],
              subscriptionType: "max",
            },
          },
        });

        const capturedOptions: any[] = [];
        const capturedBodies: string[] = [];
        const mockReq = {
          on: vi.fn(),
          write: vi.fn((data: string) => capturedBodies.push(data)),
          end: vi.fn(),
        };
        mockRequest.mockImplementation((options: any, callback: any) => {
          capturedOptions.push({ ...options });
          const url = `https://${options.hostname}${options.path}`;

          if (url.includes("oauth/token")) {
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({ access_token: "refreshed-token" })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          } else {
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({
                  five_hour: { utilization: 10.0, resets_at: new Date(Date.now() + 3600000).toISOString() },
                })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          }
          return mockReq;
        });

        await fetchAllProviderUsage();

        // Verify the refresh request (first call)
        const refreshOpts = capturedOptions[0];
        expect(refreshOpts.hostname).toBe("platform.claude.com");
        expect(refreshOpts.path).toBe("/v1/oauth/token");
        expect(refreshOpts.headers["content-type"]).toBe("application/x-www-form-urlencoded");

        // Verify body contains required parameters
        expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
        const body = capturedBodies[0];
        const params = new URLSearchParams(body);
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("refresh_token")).toBe("refresh-token-456");
        expect(params.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      });

      it("falls back to CLI when refresh fails for expired token", async () => {
        const expiredAt = Date.now() - 60_000;
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "expired-token",
              expiresAt: expiredAt,
              refreshToken: "bad-refresh-token",
              scopes: ["user:profile"],
            },
          },
        });

        const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
        mockRequest.mockImplementation((_options: any, callback: any) => {
          const mockRes = {
            statusCode: 400,
            headers: {},
            on: vi.fn((event: string, handler: any) => {
              if (event === "data") handler(Buffer.from('{"error":"invalid_grant"}'));
              if (event === "end") handler();
            }),
          };
          callback(mockRes);
          return mockReq;
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        // Auth failure falls back to CLI (which fails in test env due to mocked node-pty)
        expect(claude.status).toBe("error");
        // Should NOT show "Claude token expired" — CLI fallback was attempted
        expect(claude.error).not.toContain("Claude token expired");
      });

      it("falls back to CLI when no refresh token and token is expired", async () => {
        const expiredAt = Date.now() - 60_000;
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "expired-token",
              expiresAt: expiredAt,
              // No refreshToken
              scopes: ["user:profile"],
            },
          },
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        // Auth failure falls back to CLI (which fails in test env due to mocked node-pty)
        expect(claude.status).toBe("error");
        // Should NOT show "Claude token expired" — CLI fallback was attempted
        expect(claude.error).not.toContain("Claude token expired");
      });

      it("does not refresh when token is not expired", async () => {
        const expiresAt = Date.now() + 3600_000; // expires in 1 hour
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "valid-token",
              expiresAt,
              refreshToken: "refresh-token",
              scopes: ["user:profile"],
            },
          },
        });

        setupClaudeApiResponse({
          five_hour: { utilization: 10.0 },
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        expect(claude.status).toBe("ok");
        // Only the usage API call should have been made, no refresh
        expect(mockRequest).toHaveBeenCalledTimes(1);
      });

      it("attempts refresh on 401 response as recovery", async () => {
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "stale-token",
              // No expiresAt — so won't pre-refresh
              refreshToken: "refresh-token-456",
              scopes: ["user:profile"],
            },
          },
        });

        let callCount = 0;
        const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
        mockRequest.mockImplementation((options: any, callback: any) => {
          callCount++;
          const url = `https://${options.hostname}${options.path}`;

          if (url.includes("oauth/token")) {
            // Refresh succeeds
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({ access_token: "refreshed-token" })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          } else if (callCount === 1) {
            // First usage call returns 401
            const mockRes = {
              statusCode: 401,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from('{"error":"unauthorized"}'));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          } else {
            // Second usage call with refreshed token succeeds
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({
                  five_hour: { utilization: 30.0 },
                })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          }
          return mockReq;
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        expect(claude.status).toBe("ok");
        expect(claude.windows).toHaveLength(1);
        expect(claude.windows[0].percentUsed).toBe(30);
      });

      it("treats token as expired when within 60s buffer of expiresAt", async () => {
        const expiresAt = Date.now() + 30_000; // expires in 30s (within buffer)
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "almost-expired-token",
              expiresAt,
              refreshToken: "refresh-token",
              scopes: ["user:profile"],
            },
          },
        });

        const requestUrls: string[] = [];
        const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
        mockRequest.mockImplementation((options: any, callback: any) => {
          const url = `https://${options.hostname}${options.path}`;
          requestUrls.push(url);

          if (url.includes("oauth/token")) {
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({ access_token: "fresh-token" })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          } else {
            const mockRes = {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from(JSON.stringify({ five_hour: { utilization: 5.0 } })));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          }
          return mockReq;
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        expect(claude.status).toBe("ok");
        // Token should have been refreshed (within 60s buffer)
        expect(requestUrls[0]).toContain("oauth/token");
      });
    });

    describe("CLI fallback on auth failures", () => {
      it("falls back to CLI when expired token refresh fails", async () => {
        const expiredAt = Date.now() - 60_000;
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "expired-token",
              expiresAt: expiredAt,
              refreshToken: "bad-refresh-token",
              scopes: ["user:profile"],
            },
          },
        });

        // Mock refresh endpoint to return failure
        const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
        mockRequest.mockImplementation((_options: any, callback: any) => {
          const mockRes = {
            statusCode: 400,
            headers: {},
            on: vi.fn((event: string, handler: any) => {
              if (event === "data") handler(Buffer.from('{"error":"invalid_grant"}'));
              if (event === "end") handler();
            }),
          };
          callback(mockRes);
          return mockReq;
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        // Should fall back to CLI instead of showing "Claude token expired"
        expect(claude.status).toBe("error");
        expect(claude.error).not.toContain("Claude token expired");
      });

      it("falls back to CLI when no refresh token is available", async () => {
        const expiredAt = Date.now() - 60_000;
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "expired-token",
              expiresAt: expiredAt,
              // No refreshToken
              scopes: ["user:profile"],
            },
          },
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        // Should fall back to CLI instead of showing "Claude token expired"
        expect(claude.status).toBe("error");
        expect(claude.error).not.toContain("Claude token expired");
      });

      it("falls back to CLI when API returns 401 and refresh fails", async () => {
        setupClaudeMocks({
          credFileContent: {
            claudeAiOauth: {
              accessToken: "stale-token",
              // No expiresAt — so won't pre-refresh
              refreshToken: "bad-refresh-token",
              scopes: ["user:profile"],
            },
          },
        });

        let callCount = 0;
        const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
        mockRequest.mockImplementation((options: any, callback: any) => {
          callCount++;
          const url = `https://${options.hostname}${options.path}`;

          if (url.includes("oauth/token")) {
            // Refresh fails
            const mockRes = {
              statusCode: 400,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from('{"error":"invalid_grant"}'));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          } else {
            // Usage API returns 401
            const mockRes = {
              statusCode: 401,
              headers: {},
              on: vi.fn((event: string, handler: any) => {
                if (event === "data") handler(Buffer.from('{"error":"unauthorized"}'));
                if (event === "end") handler();
              }),
            };
            callback(mockRes);
          }
          return mockReq;
        });

        const providers = await fetchAllProviderUsage();
        const claude = providers.find((p) => p.name === "Claude")!;

        // Should fall back to CLI instead of showing "Claude token expired"
        expect(claude.status).toBe("error");
        expect(claude.error).not.toContain("Claude token expired");
      });
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
    it("detects no auth when pi auth.json doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax");

      expect(minimax).toBeDefined();
      expect(minimax!.status).toBe("no-auth");
      expect(minimax!.error).toContain("No Minimax credentials");
    });

    it("detects no auth when minimax entry has no key", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            minimax: { type: "api_key" /* missing key */ },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax");

      expect(minimax!.status).toBe("no-auth");
      expect(minimax!.error).toContain("No Minimax credentials");
    });

    it("detects no auth when minimax entry is missing entirely", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({ /* no minimax key */ });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const minimax = providers.find((p) => p.name === "Minimax");

      expect(minimax!.status).toBe("no-auth");
      expect(minimax!.error).toContain("No Minimax credentials");
    });

    it("parses usage data from coding_plan/remains API response", async () => {
      const now = Date.now();
      const mockResponse = {
        model_remains: [
          {
            model_name: "MiniMax-M*",
            current_interval_total_count: 4500,
            // Note: current_interval_usage_count is actually REMAINING, not used
            current_interval_usage_count: 4000,
            remains_time: now + 3 * 60 * 60 * 1000 - now, // ms remaining
            start_time: now - 2 * 60 * 60 * 1000,
            end_time: now + 3 * 60 * 60 * 1000,
          },
          {
            model_name: "speech-hd",
            current_interval_total_count: 9000,
            current_interval_usage_count: 8000,
            remains_time: 76919205,
            start_time: now,
            end_time: now + 24 * 60 * 60 * 1000,
          },
        ],
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            minimax: { type: "api_key", key: "test-api-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      mockRequest.mockImplementation((_options: any, callback: any) => {
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
      expect(minimax.windows).toHaveLength(2);

      const textWindow = minimax.windows.find((w) => w.label === "MiniMax-M*")!;
      expect(textWindow).toBeDefined();
      // total=4500, remaining=4000, used=500 → 500/4500*100 ≈ 11.1%
      expect(textWindow.percentUsed).toBeCloseTo(11.1, 0);
      expect(textWindow.percentLeft).toBeGreaterThan(80);
      expect(textWindow.resetText).toContain("resets in");

      const speechWindow = minimax.windows.find((w) => w.label === "speech-hd")!;
      expect(speechWindow).toBeDefined();
    });

    it("skips models with zero quota", async () => {
      const mockResponse = {
        model_remains: [
          {
            model_name: "MiniMax-M*",
            current_interval_total_count: 4500,
            current_interval_usage_count: 4500,
            remains_time: 5000000,
            start_time: Date.now() - 1000,
            end_time: Date.now() + 5 * 60 * 60 * 1000,
          },
          {
            model_name: "unused-model",
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            remains_time: 0,
          },
        ],
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            minimax: { type: "api_key", key: "test-api-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
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
      // Only MiniMax-M* should appear, unused-model has total=0 so skipped
      expect(minimax.windows).toHaveLength(1);
      expect(minimax.windows[0].label).toBe("MiniMax-M*");
    });

    it("handles 401 auth error", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            minimax: { type: "api_key", key: "expired-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "unauthorized"}'));
            if (event === "end") handler();
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
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            minimax: { type: "api_key", key: "forbidden-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 403,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "forbidden"}'));
            if (event === "end") handler();
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
    it("detects no auth when pi auth.json doesn't exist", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai");

      expect(zai).toBeDefined();
      expect(zai!.status).toBe("no-auth");
      expect(zai!.error).toContain("No Zai credentials");
    });

    it("detects no auth when zai entry has no key", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            zai: { type: "api_key" /* missing key */ },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const zai = providers.find((p) => p.name === "Zai");

      expect(zai!.status).toBe("no-auth");
      expect(zai!.error).toContain("No Zai credentials");
    });

    it("parses usage data from Z.ai quota API response", async () => {
      const mockResponse = {
        code: 200,
        msg: "Operation successful",
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 25,
              nextResetTime: Date.now() + 3 * 60 * 60 * 1000,
            },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              usage: 4000,
              currentValue: 100,
              remaining: 3900,
              percentage: 2.5,
              nextResetTime: Date.now() + 25 * 24 * 60 * 60 * 1000,
            },
          ],
          level: "max",
        },
        success: true,
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            zai: { type: "api_key", key: "test-api-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
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
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("ok");
      expect(zai.plan).toBe("Max");
      expect(zai.windows).toHaveLength(2);

      const sessionWindow = zai.windows.find((w) => w.label === "Session (5h)")!;
      expect(sessionWindow).toBeDefined();
      expect(sessionWindow.percentUsed).toBe(25);
      expect(sessionWindow.percentLeft).toBe(75);
      expect(sessionWindow.resetText).toContain("resets in");
      expect(sessionWindow.windowDurationMs).toBe(5 * 60 * 60 * 1000);

      const mcpWindow = zai.windows.find((w) => w.label === "MCP Monthly")!;
      expect(mcpWindow).toBeDefined();
      expect(mcpWindow.percentUsed).toBe(2.5);
    });

    it("parses only TOKENS_LIMIT when no TIME_LIMIT present", async () => {
      const mockResponse = {
        code: 200,
        msg: "Operation successful",
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              percentage: 10,
              nextResetTime: Date.now() + 4 * 60 * 60 * 1000,
            },
          ],
          level: "pro",
        },
        success: true,
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            zai: { type: "api_key", key: "test-api-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
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
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("ok");
      expect(zai.plan).toBe("Pro");
      expect(zai.windows).toHaveLength(1);
      expect(zai.windows[0].label).toBe("Session (5h)");
    });

    it("handles API error response (success=false)", async () => {
      const mockResponse = {
        code: 500,
        msg: "Internal error",
        success: false,
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            zai: { type: "api_key", key: "test-api-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
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
      const zai = providers.find((p) => p.name === "Zai")!;

      expect(zai.status).toBe("error");
      expect(zai.error).toContain("Internal error");
    });

    it("handles 401 auth error", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            zai: { type: "api_key", key: "expired-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 401,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "unauthorized"}'));
            if (event === "end") handler();
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
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({
            zai: { type: "api_key", key: "forbidden-key" },
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 403,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "forbidden"}'));
            if (event === "end") handler();
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
    it("handles Claude API errors gracefully", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 500,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "internal server error"}'));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("HTTP 500");
    });

    it("handles Claude network error", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      mockRequest.mockImplementation((_options: any, _callback: any) => {
        const mockReq = {
          on: vi.fn((event: string, handler: any) => {
            if (event === "error") {
              // Simulate network error
              setTimeout(() => handler(new Error("network error")), 0);
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
      expect(claude.error).toContain("network error");
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
    it("attaches pace to Minimax model window with valid timing data", async () => {
      const now = Date.now();
      const fiveHours = 5 * 60 * 60 * 1000;
      const twoHoursFromNow = 2 * 60 * 60 * 1000;
      const mockResponse = {
        model_remains: [
          {
            model_name: "MiniMax-M*",
            current_interval_total_count: 4500,
            current_interval_usage_count: 4000,
            remains_time: twoHoursFromNow,
            start_time: now - 3 * 60 * 60 * 1000,
            end_time: now + twoHoursFromNow,
          },
        ],
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({ minimax: { type: "api_key", key: "test-key" } });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
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

      const modelWindow = minimax.windows[0];
      expect(modelWindow.label).toBe("MiniMax-M*");
      expect(modelWindow.pace).toBeDefined();
      expect(modelWindow.pace!.percentElapsed).toBeGreaterThan(0);
    });

    it("does not attach pace when resetMs is 0 (window already reset)", async () => {
      const now = Date.now();
      const mockResponse = {
        model_remains: [
          {
            model_name: "MiniMax-M*",
            current_interval_total_count: 4500,
            current_interval_usage_count: 4500,
            remains_time: 0,
            start_time: now - 5 * 60 * 60 * 1000,
            end_time: now,
          },
        ],
      };

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes(".pi/agent/auth.json")) {
          return JSON.stringify({ minimax: { type: "api_key", key: "test-key" } });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
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
      // remains_time is 0, so resetMs is undefined (no active reset timer)
      expect(minimax.windows[0].resetMs).toBeUndefined();
      expect(minimax.windows[0].pace).toBeUndefined();
    });
  });

  describe("Claude CLI fallback parsing", () => {
    describe("_stripClaudeAnsi", () => {
      it("strips basic ANSI color codes", () => {
        const input = "\x1B[32m████████\x1B[0m 27% used";
        expect(_stripClaudeAnsi(input)).toBe("████████ 27% used");
      });

      it("converts cursor forward to spaces", () => {
        const input = "Current\x1B[1Csession";
        expect(_stripClaudeAnsi(input)).toBe("Current session");
      });

      it("handles multi-character cursor forward", () => {
        const input = "Hello\x1B[3Cworld";
        expect(_stripClaudeAnsi(input)).toBe("Hello   world");
      });

      it("strips DEC private mode sequences", () => {
        const input = "\x1B[?2026lClaude Code\x1B[?2026h more text";
        expect(_stripClaudeAnsi(input)).toBe("Claude Code more text");
      });

      it("strips OSC title sequences", () => {
        const input = "\x1B]0;Claude Code\x07Usage data";
        expect(_stripClaudeAnsi(input)).toBe("Usage data");
      });

      it("handles real Claude TUI output with cursor movement", () => {
        const input =
          "Current\x1B[1Cweek\x1B[1C(all\x1B[1Cmodels)\n" +
          "\x1B[32m█████████████████████████▌\x1B[0m\x1B[1C51%\x1B[1Cused\n" +
          "Resets\x1B[1CFeb\x1B[1C19\x1B[1Cat\x1B[1C3pm\x1B[1C(America/Los_Angeles)";
        const result = _stripClaudeAnsi(input);
        expect(result).toContain("Current week (all models)");
        expect(result).toContain("51% used");
        expect(result).toContain("Resets Feb 19 at 3pm (America/Los_Angeles)");
      });

      it("handles backspace characters", () => {
        const input = "abc\x08d";
        expect(_stripClaudeAnsi(input)).toBe("abd");
      });

      it("preserves newlines and tabs", () => {
        const input = "Line 1\nLine 2\tTabbed";
        expect(_stripClaudeAnsi(input)).toBe("Line 1\nLine 2\tTabbed");
      });
    });

    describe("_parseClaudePercentLine", () => {
      it("parses 'X% used'", () => {
        expect(_parseClaudePercentLine("████████ 27% used")).toBe(27);
      });

      it("parses 'X% left' and converts to used", () => {
        expect(_parseClaudePercentLine("████████ 65% left")).toBe(35);
      });

      it("parses 'X% remaining' and converts to used", () => {
        expect(_parseClaudePercentLine("████ 80% remaining")).toBe(20);
      });

      it("parses 100% used", () => {
        expect(_parseClaudePercentLine("████████████████████ 100% used")).toBe(100);
      });

      it("parses 0% left as 100% used", () => {
        expect(_parseClaudePercentLine("0% left")).toBe(100);
      });

      it("returns null for non-matching lines", () => {
        expect(_parseClaudePercentLine("Current session")).toBeNull();
        expect(_parseClaudePercentLine("Resets in 2h")).toBeNull();
      });
    });

    describe("_parseClaudeResetLine", () => {
      it("extracts 'Resets in 2h 15m'", () => {
        expect(_parseClaudeResetLine("Resets in 2h 15m")).toBe("Resets in 2h 15m");
      });

      it("extracts 'Resets 11am'", () => {
        expect(_parseClaudeResetLine("Resets 11am")).toBe("Resets 11am");
      });

      it("extracts from line with prefix garbage", () => {
        expect(_parseClaudeResetLine("some garbage Resets 3pm")).toBe("Resets 3pm");
      });

      it("strips timezone suffix", () => {
        expect(_parseClaudeResetLine("Resets Feb 19 at 3pm (America/Los_Angeles)")).toBe(
          "Resets Feb 19 at 3pm"
        );
      });

      it("strips percentage info if on same line", () => {
        expect(_parseClaudeResetLine("46%used Resets 5:59pm")).toBe("Resets 5:59pm");
      });

      it("returns null for non-reset lines", () => {
        expect(_parseClaudeResetLine("Current session")).toBeNull();
        expect(_parseClaudeResetLine("27% used")).toBeNull();
      });
    });

    describe("_parseClaudeResetText", () => {
      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("parses duration format with hours and minutes", () => {
        const result = _parseClaudeResetText("Resets in 2h 15m");
        expect(result).toBe(new Date("2025-01-15T12:15:00Z").toISOString());
      });

      it("parses duration format with only minutes", () => {
        const result = _parseClaudeResetText("Resets in 30m");
        expect(result).toBe(new Date("2025-01-15T10:30:00Z").toISOString());
      });

      it("parses simple AM time", () => {
        const result = _parseClaudeResetText("Resets 11am");
        expect(result).toBeTruthy();
        expect(new Date(result!).getHours()).toBe(11);
      });

      it("parses simple PM time", () => {
        const result = _parseClaudeResetText("Resets 3pm");
        expect(result).toBeTruthy();
        expect(new Date(result!).getHours()).toBe(15);
      });

      it("parses date format with month day at time", () => {
        const result = _parseClaudeResetText("Resets Feb 19 at 3pm");
        expect(result).toBeTruthy();
        const d = new Date(result!);
        expect(d.getMonth()).toBe(1); // Feb
        expect(d.getDate()).toBe(19);
        expect(d.getHours()).toBe(15);
      });

      it("parses date format with comma", () => {
        const result = _parseClaudeResetText("Resets Jan 15, 3:30pm");
        expect(result).toBeTruthy();
        const d = new Date(result!);
        expect(d.getMonth()).toBe(0);
        expect(d.getDate()).toBe(15);
        expect(d.getHours()).toBe(15);
        expect(d.getMinutes()).toBe(30);
      });

      it("handles 12am correctly", () => {
        const result = _parseClaudeResetText("Resets 12am");
        expect(result).toBeTruthy();
        expect(new Date(result!).getHours()).toBe(0);
      });

      it("handles 12pm correctly", () => {
        const result = _parseClaudeResetText("Resets 12pm");
        expect(result).toBeTruthy();
        expect(new Date(result!).getHours()).toBe(12);
      });

      it("returns null for unparseable text", () => {
        expect(_parseClaudeResetText("unknown format")).toBeNull();
      });
    });
  });

  describe("withTimeout", () => {
    it("resolves with provider result when fetch completes within timeout", async () => {
      const provider: ProviderUsage = {
        name: "TestProvider",
        icon: "🧪",
        status: "ok",
        windows: [],
      };
      const result = await withTimeout(Promise.resolve(provider), "TestProvider", 5000);
      expect(result).toEqual(provider);
      expect(result.status).toBe("ok");
    });

    it("returns error provider when fetch exceeds timeout", async () => {
      const slowPromise = new Promise<ProviderUsage>((resolve) => {
        setTimeout(() => resolve({ name: "Slow", icon: "🐌", status: "ok", windows: [] }), 10000);
      });
      const result = await withTimeout(slowPromise, "Slow", 50); // 50ms timeout
      expect(result.status).toBe("error");
      expect(result.error).toBe("Timed out after 0s");
      expect(result.name).toBe("Slow");
    });

    it("includes timeout duration in error message for different durations", async () => {
      // 100ms => "0s"
      const result100 = await withTimeout(
        new Promise<ProviderUsage>(() => {}),
        "Test",
        100,
      );
      expect(result100.error).toBe("Timed out after 0s");

      // 10_000ms is too long to actually wait, but we can verify the format
      // by using a 1050ms timeout (rounds to 1s)
      const result1s = await withTimeout(
        new Promise<ProviderUsage>(() => {}),
        "Test",
        1050,
      );
      expect(result1s.error).toBe("Timed out after 1s");
    });

    it("catches rejected promises and returns error provider", async () => {
      const failingPromise = Promise.reject(new Error("Network failure"));
      const result = await withTimeout(failingPromise, "Failing", 5000);
      expect(result.status).toBe("error");
      expect(result.error).toBe("Network failure");
    });
  });

  describe("Claude timeout constant", () => {
    it("CLAUDE_FETCH_TIMEOUT_MS is 75 seconds", () => {
      expect(CLAUDE_FETCH_TIMEOUT_MS).toBe(75_000);
    });

    it("CLAUDE_FETCH_TIMEOUT_MS is larger than default provider timeout", () => {
      // The default PROVIDER_FETCH_TIMEOUT_MS is 10_000. CLAUDE_FETCH_TIMEOUT_MS should be much larger.
      expect(CLAUDE_FETCH_TIMEOUT_MS).toBeGreaterThan(10_000);
    });
  });

  describe("Claude API error diagnostics", () => {
    it("includes response body snippet in HTTP 500 error", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockRequest.mockImplementation((_options: any, callback: any) => {
        const mockRes = {
          statusCode: 500,
          headers: {},
          on: vi.fn((event: string, handler: any) => {
            if (event === "data") handler(Buffer.from('{"error": "internal server error", "details": "something went wrong"}'));
            if (event === "end") handler();
          }),
        };
        callback(mockRes);
        return mockReq;
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("HTTP 500");
      expect(claude.error).toContain("internal server error");
    });
  });
});
