import { describe, it, expect, vi, beforeEach } from "vitest";
import { isUsageLimitError, UsageLimitPauser, checkSessionError } from "../usage-limit-detector.js";

// ── isUsageLimitError classification tests ───────────────────────────

describe("isUsageLimitError", () => {
  describe("should match usage-limit errors", () => {
    const usageLimitMessages = [
      // Anthropic overloaded
      "overloaded_error: Overloaded",
      "API is overloaded",
      // Rate limiting
      "rate_limit_error: Rate limit exceeded",
      "rate limit exceeded",
      "Rate Limit Reached",
      "Too many requests",
      "too many requests, please retry after 60s",
      // HTTP status codes
      "Request failed with status 429",
      "HTTP 429: Too Many Requests",
      "529 overloaded",
      "Status 529",
      // Quota / billing
      "quota exceeded for this billing period",
      "Quota limit reached",
      "billing account is inactive",
      "Billing issue detected",
      "insufficient credit balance",
      "Insufficient credits",
      "credit balance too low",
    ];

    for (const msg of usageLimitMessages) {
      it(`matches: "${msg}"`, () => {
        expect(isUsageLimitError(msg)).toBe(true);
      });
    }
  });

  describe("should NOT match transient server errors", () => {
    const transientMessages = [
      "Internal Server Error",
      "Request failed with status 500",
      "HTTP 502: Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "connection refused",
      "Connection reset by peer",
      "ECONNREFUSED",
      "timeout exceeded",
      "request timed out",
      "socket hang up",
      "network error",
      "ETIMEDOUT",
      "DNS lookup failed",
      "getaddrinfo ENOTFOUND",
    ];

    for (const msg of transientMessages) {
      it(`does not match: "${msg}"`, () => {
        expect(isUsageLimitError(msg)).toBe(false);
      });
    }
  });

  it("returns false for empty string", () => {
    expect(isUsageLimitError("")).toBe(false);
  });

  it("returns false for generic error messages", () => {
    expect(isUsageLimitError("Something went wrong")).toBe(false);
    expect(isUsageLimitError("Unexpected token in JSON")).toBe(false);
  });
});

// ── checkSessionError tests ──────────────────────────────────────────

describe("checkSessionError", () => {
  it("throws when session.state.error is set", () => {
    const session = { state: { error: "rate_limit_error: Rate limit exceeded" } };
    expect(() => checkSessionError(session)).toThrow("rate_limit_error: Rate limit exceeded");
  });

  it("does not throw when session.state.error is undefined", () => {
    const session = { state: { error: undefined } };
    expect(() => checkSessionError(session)).not.toThrow();
  });

  it("does not throw when session.state.error is empty string", () => {
    const session = { state: { error: "" } };
    expect(() => checkSessionError(session)).not.toThrow();
  });

  it("thrown error message matches session.state.error exactly", () => {
    const errorMessage = "overloaded_error: Overloaded";
    const session = { state: { error: errorMessage } };

    let thrownMessage: string | undefined;
    try {
      checkSessionError(session);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(thrownMessage).toBe(errorMessage);
    // Verify isUsageLimitError can classify it
    expect(isUsageLimitError(thrownMessage!)).toBe(true);
  });

  it("thrown error message for rate limit is classifiable by isUsageLimitError", () => {
    const session = { state: { error: "429 Too Many Requests" } };

    let thrownMessage: string | undefined;
    try {
      checkSessionError(session);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(isUsageLimitError(thrownMessage!)).toBe(true);
  });

  it("does not throw when state has no error property", () => {
    const session = { state: {} };
    expect(() => checkSessionError(session as any)).not.toThrow();
  });
});

// ── UsageLimitPauser tests ───────────────────────────────────────────

function createMockStore(tasks: any[] = []) {
  return {
    logEntry: vi.fn().mockResolvedValue(undefined),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn().mockImplementation(async (id: string) => tasks.find((task) => task.id === id) ?? {
      id,
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
    }),
    getSettings: vi.fn().mockResolvedValue({
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5",
    }),
  } as any;
}

describe("UsageLimitPauser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses only the affected task instead of activating global pause", async () => {
    const store = createMockStore([
      { id: "FN-001", column: "todo", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-002", column: "todo", modelProvider: "openai-codex", modelId: "gpt-5" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-001", "rate_limit_error: Rate limit exceeded", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, {
      pausedReason: "provider-rate-limit:anthropic",
    });
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-002", expect.anything(), expect.anything(), expect.anything());
    expect(store.updateSettings).toBeUndefined();
  });

  it("logs the triggering error on the task via store.logEntry", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("triage", "FN-002", "overloaded_error");

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      "Usage limit detected (triage): overloaded_error",
    );
  });

  it("parks active executor tasks on the unavailable provider while other lanes and providers continue", async () => {
    const store = createMockStore([
      { id: "FN-001", column: "in-progress", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-002", column: "in-progress", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-003", column: "in-progress", modelProvider: "openai-codex", modelId: "gpt-5" },
      { id: "FN-004", column: "triage", planningModelProvider: "anthropic", planningModelId: "claude-sonnet" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-001", "rate limit", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledTimes(2);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, { pausedReason: "provider-rate-limit:anthropic" });
    expect(store.pauseTask).toHaveBeenCalledWith("FN-002", true, undefined, { pausedReason: "provider-rate-limit:anthropic" });
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-003", expect.anything(), expect.anything(), expect.anything());
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-004", expect.anything(), expect.anything(), expect.anything());
  });

  it("parks only active triage tasks whose planning or validator lane uses the unavailable provider", async () => {
    const store = createMockStore([
      { id: "FN-010", column: "triage", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet" },
      { id: "FN-011", column: "triage", planningModelProvider: "openai-codex", planningModelId: "gpt-5", validatorModelProvider: "openai-codex", validatorModelId: "gpt-5" },
      { id: "FN-012", column: "in-progress", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("triage", "FN-010", "429", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledTimes(1);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-010", true, undefined, { pausedReason: "provider-rate-limit:anthropic" });
  });

  it("uses a generic structured reason when the caller cannot identify the provider", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-001", "rate limit");
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, {
      pausedReason: "provider-rate-limit",
    });
  });

  it("includes agent type in the log entry", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("merger", "FN-005", "quota exceeded", "Anthropic API");

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-005",
      expect.stringContaining("merger/anthropic-api"),
    );
  });

  it("resumes only exact provider-rate-limit parks after positive provider health", async () => {
    const store = createMockStore([
      { id: "FN-101", paused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-102", paused: true, pausedReason: "provider-rate-limit:openai-codex" },
      { id: "FN-103", paused: true, pausedReason: "manual" },
      { id: "FN-104", paused: true, userPaused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-105", paused: false, pausedReason: "provider-rate-limit:anthropic" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await expect(pauser.onProviderAvailable("Anthropic")).resolves.toBe(1);

    expect(store.pauseTask).toHaveBeenCalledTimes(1);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-101", false);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-101",
      "Provider anthropic is available again; resuming task",
    );
  });

  it("does nothing when provider health has no matching persisted parks", async () => {
    const store = createMockStore([
      { id: "FN-201", paused: true, pausedReason: "provider-rate-limit:openai-codex" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await expect(pauser.onProviderAvailable("anthropic")).resolves.toBe(0);
    expect(store.pauseTask).not.toHaveBeenCalled();
  });
});
