import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTaskDetail, updateTask, fetchAuthStatus, loginProvider, logoutProvider, fetchModels } from "./api";
import type { Task, TaskDetail } from "@hai/core";

const FAKE_DETAIL: TaskDetail = {
  id: "HAI-001",
  description: "Test",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# HAI-001",
};

function mockFetchResponse(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("fetchTaskDetail", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns data on first success", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_DETAIL));

    const result = await fetchTaskDetail("HAI-001");

    expect(result.id).toBe("HAI-001");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once on failure then succeeds", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(mockFetchResponse(false, { error: "Transient error" }))
      .mockReturnValueOnce(mockFetchResponse(true, FAKE_DETAIL));

    const result = await fetchTaskDetail("HAI-001");

    expect(result.id).toBe("HAI-001");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws after retry exhaustion", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchTaskDetail("HAI-001")).rejects.toThrow("Server error");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe("updateTask", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_TASK: Task = {
    id: "HAI-001",
    description: "Test",
    column: "in-progress",
    dependencies: ["HAI-002"],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends PATCH with dependencies and returns updated task", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    const result = await updateTask("HAI-001", { dependencies: ["HAI-002"] });

    expect(result.dependencies).toEqual(["HAI-002"]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/HAI-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ dependencies: ["HAI-002"] }),
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Not found" }));

    await expect(updateTask("HAI-001", { dependencies: [] })).rejects.toThrow("Not found");
  });
});

describe("fetchModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns available models", async () => {
    const models = [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    ];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, models));

    const result = await fetchModels();

    expect(result).toEqual(models);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/models", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchModels()).rejects.toThrow("Server error");
  });
});

describe("fetchAuthStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns providers with auth status", async () => {
    const response = { providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }] };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchAuthStatus();

    expect(result.providers).toEqual([{ id: "anthropic", name: "Anthropic", authenticated: true }]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/status", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchAuthStatus()).rejects.toThrow("Server error");
  });
});

describe("loginProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST and returns auth URL", async () => {
    const response = { url: "https://auth.example.com/login", instructions: "Open in browser" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await loginProvider("anthropic");

    expect(result.url).toBe("https://auth.example.com/login");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ provider: "anthropic" }),
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Unknown provider" }));

    await expect(loginProvider("bad")).rejects.toThrow("Unknown provider");
  });
});

describe("logoutProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to logout", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const result = await logoutProvider("anthropic");

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/logout", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ provider: "anthropic" }),
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "logout failed" }));

    await expect(logoutProvider("anthropic")).rejects.toThrow("logout failed");
  });
});
