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

// Mock child_process
const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

describe("usage", () => {
  beforeEach(() => {
    clearUsageCache();
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
     * - mockExecFileSync needs to handle BOTH keychain reads ("security") AND
     *   CLI usage calls ("claude") since they share the same mock.
     * - mockReadFileSync handles credential file reads.
     */
    function setupClaudeMocks(options: {
      /** Credential file content (null = file not found) */
      credFileContent?: any;
      /** Keychain credential content (null = keychain error) */
      keychainContent?: any;
      /** CLI usage output (string JSON) or Error to throw */
      cliOutput?: string | Error;
    }) {
      const { credFileContent = null, keychainContent = null, cliOutput } = options;

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude") && credFileContent !== null) {
          return JSON.stringify(credFileContent);
        }
        throw new Error("File not found");
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        // Keychain read via `security` command
        if (cmd === "security") {
          if (keychainContent !== null) {
            return JSON.stringify(keychainContent);
          }
          throw new Error("Keychain item not found");
        }
        // Claude CLI usage call
        if (cmd === "claude") {
          if (cliOutput instanceof Error) throw cliOutput;
          if (cliOutput !== undefined) return cliOutput;
          throw new Error("Command failed");
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });
    }

    it("detects no auth when credentials file doesn't exist", async () => {
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
      const cliResponse = JSON.stringify({
        five_hour: {
          utilization: 30.0,
          resets_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 15.0,
          resets_at: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      setupClaudeMocks({
        keychainContent: {
          claudeAiOauth: {
            accessToken: "keychain-token",
            scopes: ["user:profile"],
            subscriptionType: "pro",
          },
        },
        cliOutput: cliResponse,
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

      // Verify CLI was called
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "claude",
        ["usage", "--json"],
        { encoding: "utf-8", timeout: 15000 }
      );
    });

    it("falls back to no-auth when both file and keychain fail", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Keychain item not found");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("no-auth");
      expect(claude.error).toContain("No Claude CLI credentials");
    });

    it("parses keychain credentials with rateLimitTier for plan detection", async () => {
      const cliResponse = JSON.stringify({
        five_hour: {
          utilization: 25.0,
          resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
      });

      setupClaudeMocks({
        keychainContent: {
          claudeAiOauth: {
            accessToken: "keychain-token",
            scopes: ["user:profile"],
            rateLimitTier: "default_claude_max_20x",
          },
        },
        cliOutput: cliResponse,
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("ok");
      expect(claude.plan).toBe("Max"); // Should detect "max" from rateLimitTier
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

    it("parses usage data from CLI JSON output", async () => {
      const cliResponse = JSON.stringify({
        five_hour: {
          utilization: 45.5,
          resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 23.0,
          resets_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "pro",
        },
        cliOutput: cliResponse,
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

    it("parses all four usage windows from CLI output", async () => {
      const cliResponse = JSON.stringify({
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

      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "max",
        },
        cliOutput: cliResponse,
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

    it("handles CLI not found (ENOENT)", async () => {
      const enoentError = new Error("spawn claude ENOENT") as any;
      enoentError.code = "ENOENT";

      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
        },
        cliOutput: enoentError,
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Claude CLI not found");
    });

    it("handles CLI timeout (killed process)", async () => {
      const timeoutError = new Error("Process timed out") as any;
      timeoutError.killed = true;

      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
        },
        cliOutput: timeoutError,
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("timed out");
    });

    it("handles CLI non-zero exit code", async () => {
      const exitError = new Error("Command failed with exit code 1") as any;
      exitError.status = 1;

      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
        },
        cliOutput: exitError,
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("Command failed");
    });

    it("handles malformed JSON output from CLI", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
        },
        cliOutput: "not valid json {{{",
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toBeDefined();
    });

    it("handles empty JSON object from CLI gracefully", async () => {
      setupClaudeMocks({
        credFileContent: {
          accessToken: "test-token",
          scopes: ["user:profile"],
          subscriptionType: "pro",
        },
        cliOutput: "{}",
      });

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
        cliOutput: JSON.stringify({ five_hour: { utilization: 10 } }),
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.plan).toBe("Team");
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
        cliOutput: JSON.stringify({ five_hour: { utilization: 10 } }),
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.plan).toBe("Pro");
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
    it("handles Claude CLI errors gracefully", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "security") throw new Error("Keychain item not found");
        if (cmd === "claude") throw new Error("CLI error: something went wrong");
        throw new Error("Unknown command");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("something went wrong");
    });

    it("handles Claude CLI ETIMEDOUT error", async () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("claude")) {
          return JSON.stringify({
            accessToken: "test-token",
            scopes: ["user:profile"],
          });
        }
        throw new Error("File not found");
      });

      const timeoutError = new Error("connect ETIMEDOUT") as any;
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "security") throw new Error("Keychain item not found");
        if (cmd === "claude") throw timeoutError;
        throw new Error("Unknown command");
      });

      const providers = await fetchAllProviderUsage();
      const claude = providers.find((p) => p.name === "Claude")!;

      expect(claude.status).toBe("error");
      expect(claude.error).toContain("timed out");
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
