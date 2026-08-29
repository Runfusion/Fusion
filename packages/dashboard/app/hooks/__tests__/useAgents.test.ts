import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgents } from "../useAgents";
import * as api from "../../api";
import type { Agent, AgentCapability, AgentState, AgentStats } from "../../api";
import { MockEventSource } from "../../../vitest.setup";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";

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
    window.localStorage.clear();
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

  it("hydrates cached agents and stats synchronously before revalidation", async () => {
    const cachedAgents = [createAgent({ id: "cached-agent", name: "Cached", state: "active" })];
    const cachedStats = { ...defaultStats, activeCount: 9 };
    window.localStorage.setItem(SWR_CACHE_KEYS.AGENTS, JSON.stringify(cachedAgents));
    window.localStorage.setItem(SWR_CACHE_KEYS.AGENT_STATS, JSON.stringify(cachedStats));

    let resolveAgents: ((agents: Agent[]) => void) | undefined;
    mockFetchAgents.mockImplementationOnce(
      () =>
        new Promise<Agent[]>((resolve) => {
          resolveAgents = resolve;
        }),
    );

    const { result } = renderHook(() => useAgents());

    expect(result.current.agents).toEqual(cachedAgents);
    expect(result.current.stats).toEqual(cachedStats);
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolveAgents?.([createAgent({ id: "live-agent", state: "active" })]);
      await Promise.resolve();
    });
  });

  it("fetches agents and stats on mount and populates state", async () => {    const agents = [
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

    expect(mockFetchAgents).toHaveBeenLastCalledWith({ state: "active", role: "executor", includeEphemeral: false }, undefined);
  });

  it("refreshAgents reloads both list and stats in one call", async () => {
    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalled();
      expect(mockFetchAgentStats).toHaveBeenCalled();
    });

    mockFetchAgents.mockClear();
    mockFetchAgentStats.mockClear();

    await act(async () => {
      await result.current.refreshAgents();
    });

    expect(mockFetchAgents).toHaveBeenCalledTimes(1);
    expect(mockFetchAgentStats).toHaveBeenCalledTimes(1);
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

  it("hydrates and clears agent state per project on a project switch", async () => {
    const agentsA = [createAgent({ id: "agent-a", state: "active" })];
    const agentsB = [createAgent({ id: "agent-b", state: "active" })];
    const statsB = { ...defaultStats, activeCount: 7 };
    window.localStorage.setItem(`${SWR_CACHE_KEYS.AGENTS}:project-b`, JSON.stringify(agentsB));
    window.localStorage.setItem(`${SWR_CACHE_KEYS.AGENT_STATS}:project-b`, JSON.stringify(statsB));
    mockFetchAgents.mockImplementation((_filter, projectId) => Promise.resolve(projectId === "project-b" ? agentsB : agentsA));
    mockFetchAgentStats.mockImplementation((projectId) => Promise.resolve(projectId === "project-b" ? statsB : defaultStats));

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useAgents(projectId),
      { initialProps: { projectId: "project-a" } },
    );
    await waitFor(() => expect(result.current.agents).toEqual(agentsA));

    rerender({ projectId: "project-b" });

    await waitFor(() => {
      expect(result.current.agents).toEqual(agentsB);
      expect(result.current.stats).toEqual(statsB);
    });
    expect(result.current.agents).not.toContainEqual(expect.objectContaining({ id: "agent-a" }));
  });

  it("creates SSE subscription with correct URL without projectId", async () => {
    renderHook(() => useAgents());

    await waitFor(() => {
      const urls = MockEventSource.instances.map((es) => es.url);
      expect(urls.length).toBeGreaterThan(0);
      expectEventsUrl(urls[urls.length - 1]!);
    });
  });

  it("writes through agents and stats cache after successful fetch", async () => {
    const agents = [createAgent({ id: "live-agent", state: "active" })];
    const stats = { ...defaultStats, activeCount: 4 };
    mockFetchAgents.mockResolvedValueOnce(agents);
    mockFetchAgentStats.mockResolvedValueOnce(stats);

    renderHook(() => useAgents());

    await waitFor(() => {
      const agentsEnvelope = JSON.parse(window.localStorage.getItem(SWR_CACHE_KEYS.AGENTS) ?? "null") as {
        savedAt?: number;
        data?: unknown;
      };
      const statsEnvelope = JSON.parse(window.localStorage.getItem(SWR_CACHE_KEYS.AGENT_STATS) ?? "null") as {
        savedAt?: number;
        data?: unknown;
      };
      expect(typeof agentsEnvelope.savedAt).toBe("number");
      expect(agentsEnvelope.data).toEqual(agents);
      expect(typeof statsEnvelope.savedAt).toBe("number");
      expect(statsEnvelope.data).toEqual(stats);
    });
  });

  it("refreshes agents and stats on supported SSE events (debounced — burst collapses to 1 refetch)", async () => {
    renderHook(() => useAgents());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    mockFetchAgents.mockClear();
    mockFetchAgentStats.mockClear();

    // Burst of 7 SSE events arriving within the debounce window. The
    // refresh handler coalesces them into a single fetchAgents/fetchAgentStats
    // round trip — previously this fired 7× per event, which became a
    // request storm during multi-agent activity bursts.
    for (const event of ["agent:created", "agent:updated", "agent:deleted", "agent:stateChanged", "approval:requested", "approval:updated", "approval:decided"]) {
      act(() => {
        es._emit(event);
      });
    }

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledTimes(1);
      expect(mockFetchAgentStats).toHaveBeenCalledTimes(1);
    });
  });

  it("reconciles SSE updates on top of cached hydration", async () => {
    const cachedAgents = [createAgent({ id: "cached-agent", state: "active" })];
    window.localStorage.setItem(SWR_CACHE_KEYS.AGENTS, JSON.stringify(cachedAgents));

    mockFetchAgents.mockResolvedValueOnce(cachedAgents);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    mockFetchAgents.mockResolvedValueOnce([
      ...cachedAgents,
      createAgent({ id: "from-sse", state: "running" }),
    ]);

    act(() => {
      es._emit("agent:updated");
    });

    await waitFor(() => {
      expect(result.current.agents.some((agent) => agent.id === "from-sse")).toBe(true);
    });
  });

  it("closes SSE subscription on unmount", async () => {    const { unmount } = renderHook(() => useAgents());

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
      expect(mockFetchAgents).toHaveBeenCalledWith({ includeEphemeral: false }, projectId);
      expect(mockFetchAgentStats).toHaveBeenCalledWith(projectId);
    });

    const urls = MockEventSource.instances.map((es) => es.url);
    expect(urls.length).toBeGreaterThan(0);
    expectEventsUrl(urls[urls.length - 1]!, projectId);
  });
});
