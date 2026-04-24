import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgents } from "../useAgents";
import * as api from "../../api";
import type { Agent, AgentCapability, AgentState, AgentStats } from "../../api";
import { MockEventSource } from "../../../vitest.setup";

vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  fetchAgentStats: vi.fn(),
}));

const mockFetchAgents = vi.mocked(api.fetchAgents);
const mockFetchAgentStats = vi.mocked(api.fetchAgentStats);

function expectEventsUrl(url: string, projectId?: string) {
  const parsed = new URL(url, "http://localhost");
  expect(parsed.pathname).toBe("/api/events");
  expect(parsed.searchParams.get("projectId")).toBe(projectId ?? null);
  expect(parsed.searchParams.get("clientId")).toBeTruthy();
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Agent One",
    role: "executor" as AgentCapability,
    state: "idle" as AgentState,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const defaultStats: AgentStats = {
  activeCount: 1,
  assignedTaskCount: 2,
  completedRuns: 10,
  failedRuns: 1,
  successRate: 0.9,
};

describe("useAgents", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    window.sessionStorage.clear();
    mockFetchAgents.mockReset().mockResolvedValue([]);
    mockFetchAgentStats.mockReset().mockResolvedValue(defaultStats);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const es of MockEventSource.instances) {
      es.close();
    }
    MockEventSource.instances = [];
  });

  it("returns empty agents and null stats initially; loading settles after fetch", async () => {
    const { result } = renderHook(() => useAgents());

    expect(result.current.agents).toEqual([]);
    expect(result.current.stats).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetchAgents).toHaveBeenCalled();
    expect(mockFetchAgentStats).toHaveBeenCalled();
  });

  it("fetches agents and stats on mount and populates state", async () => {
    const agents = [
      createAgent({ id: "a-1", name: "Alpha", state: "active" }),
      createAgent({ id: "a-2", name: "Beta", state: "idle" }),
    ];
    mockFetchAgents.mockResolvedValueOnce(agents);
    mockFetchAgentStats.mockResolvedValueOnce({ ...defaultStats, activeCount: 1 });

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.agents).toEqual(agents);
      expect(result.current.stats).toEqual({ ...defaultStats, activeCount: 1 });
    });
  });

  it("filters active agents from mixed states", async () => {
    const agents = [
      createAgent({ id: "a-idle", state: "idle" }),
      createAgent({ id: "a-active", state: "active" }),
      createAgent({ id: "a-running", state: "running" }),
      createAgent({ id: "a-error", state: "error" }),
    ];
    mockFetchAgents.mockResolvedValueOnce(agents);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.activeAgents.map((a) => a.id)).toEqual(["a-active", "a-running"]);
    });
  });

  it("loadAgents accepts optional filters and passes them to fetchAgents", async () => {
    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalled();
    });

    await act(async () => {
      await result.current.loadAgents({ state: "active", role: "executor" });
    });

    expect(mockFetchAgents).toHaveBeenLastCalledWith({ state: "active", role: "executor" }, undefined);
  });

  it("handles fetchAgents rejection gracefully", async () => {
    mockFetchAgents.mockRejectedValueOnce(new Error("agents failed"));

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.agents).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("Failed to load agents:", expect.any(Error));
  });

  it("handles fetchAgentStats rejection gracefully", async () => {
    mockFetchAgentStats.mockRejectedValueOnce(new Error("stats failed"));

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(mockFetchAgentStats).toHaveBeenCalled();
    });

    expect(result.current.stats).toBeNull();
    expect(console.error).toHaveBeenCalledWith("Failed to load agent stats:", expect.any(Error));
  });

  it("creates SSE subscription with correct URL without projectId", async () => {
    renderHook(() => useAgents());

    await waitFor(() => {
      const urls = MockEventSource.instances.map((es) => es.url);
      expect(urls.length).toBeGreaterThan(0);
      expectEventsUrl(urls[urls.length - 1]!);
    });
  });

  it("refreshes agents and stats on supported SSE events", async () => {
    renderHook(() => useAgents());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    mockFetchAgents.mockClear();
    mockFetchAgentStats.mockClear();

    for (const event of ["agent:created", "agent:updated", "agent:deleted", "agent:stateChanged"]) {
      act(() => {
        es._emit(event);
      });
    }

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledTimes(4);
      expect(mockFetchAgentStats).toHaveBeenCalledTimes(4);
    });
  });

  it("closes SSE subscription on unmount", async () => {
    const { unmount } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    unmount();

    expect(es.close).toHaveBeenCalled();
  });

  it("with projectId passes projectId to fetch calls and EventSource URL", async () => {
    const projectId = "proj-123";

    renderHook(() => useAgents(projectId));

    await waitFor(() => {
      // fetchAgents defaults to excluding ephemeral agents (handled by API)
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, projectId);
      expect(mockFetchAgentStats).toHaveBeenCalledWith(projectId);
    });

    const urls = MockEventSource.instances.map((es) => es.url);
    expect(urls.length).toBeGreaterThan(0);
    expectEventsUrl(urls[urls.length - 1]!, projectId);
  });
});
