import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRemoteNodeData } from "../useRemoteNodeData";
import * as apiNodeModule from "../../api-node";

vi.mock("../../api-node", () => ({
  fetchRemoteNodeHealth: vi.fn(),
  fetchRemoteNodeProjects: vi.fn(),
  fetchRemoteNodeTasks: vi.fn(),
  fetchRemoteNodeProjectHealth: vi.fn(),
}));

const mockFetchRemoteNodeHealth = vi.mocked(apiNodeModule.fetchRemoteNodeHealth);
const mockFetchRemoteNodeProjects = vi.mocked(apiNodeModule.fetchRemoteNodeProjects);
const mockFetchRemoteNodeTasks = vi.mocked(apiNodeModule.fetchRemoteNodeTasks);
const mockFetchRemoteNodeProjectHealth = vi.mocked(apiNodeModule.fetchRemoteNodeProjectHealth);

describe("useRemoteNodeData search query propagation", () => {
  beforeEach(() => {
    mockFetchRemoteNodeHealth.mockReset();
    mockFetchRemoteNodeProjects.mockReset();
    mockFetchRemoteNodeTasks.mockReset();
    mockFetchRemoteNodeProjectHealth.mockReset();
    
    // Default mock setup for successful fetch
    mockFetchRemoteNodeHealth.mockResolvedValueOnce({
      status: "online",
      version: "1.0.0",
      nodeId: "node_abc",
    });
    mockFetchRemoteNodeProjects.mockResolvedValueOnce([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards searchQuery to fetchRemoteNodeTasks when provided", async () => {
    const mockTasks = [
      {
        id: "FN-001",
        title: "Test Task",
        description: "Test description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
    ];
    mockFetchRemoteNodeTasks.mockResolvedValueOnce(mockTasks);

    const { result } = renderHook(() =>
      useRemoteNodeData("node_abc", { projectId: "proj_001", searchQuery: "test" }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(1);
    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledWith("node_abc", "proj_001", "test");
    expect(result.current.tasks).toEqual(mockTasks);
  });

  it("does not forward searchQuery when undefined", async () => {
    mockFetchRemoteNodeTasks.mockResolvedValueOnce([]);

    const { result } = renderHook(() =>
      useRemoteNodeData("node_abc", { projectId: "proj_001" }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(1);
    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledWith("node_abc", "proj_001", undefined);
  });

  it("refetches tasks when searchQuery changes", async () => {
    const initialTasks = [
      {
        id: "FN-001",
        title: "Initial Task",
        description: "Initial description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
    ];
    const filteredTasks = [
      {
        id: "FN-002",
        title: "Filtered Task",
        description: "Filtered description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
    ];

    mockFetchRemoteNodeTasks
      .mockResolvedValueOnce(initialTasks)
      .mockResolvedValueOnce(filteredTasks);

    const { result, rerender } = renderHook(
      ({ searchQuery }: { searchQuery?: string }) =>
        useRemoteNodeData("node_abc", { projectId: "proj_001", searchQuery }),
      { initialProps: { searchQuery: undefined as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(1);
    expect(mockFetchRemoteNodeTasks).toHaveBeenLastCalledWith("node_abc", "proj_001", undefined);
    expect(result.current.tasks).toEqual(initialTasks);

    // Update searchQuery
    rerender({ searchQuery: "filtered" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(2);
    expect(mockFetchRemoteNodeTasks).toHaveBeenLastCalledWith("node_abc", "proj_001", "filtered");
    expect(result.current.tasks).toEqual(filteredTasks);
  });

  it("refetches tasks when searchQuery is cleared", async () => {
    const filteredTasks = [
      {
        id: "FN-001",
        title: "Filtered Task",
        description: "Filtered description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
    ];
    const allTasks = [
      {
        id: "FN-001",
        title: "Filtered Task",
        description: "Filtered description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
      {
        id: "FN-002",
        title: "Other Task",
        description: "Other description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
    ];

    mockFetchRemoteNodeTasks
      .mockResolvedValueOnce(filteredTasks)
      .mockResolvedValueOnce(allTasks);

    const { result, rerender } = renderHook(
      ({ searchQuery }: { searchQuery?: string }) =>
        useRemoteNodeData("node_abc", { projectId: "proj_001", searchQuery }),
      { initialProps: { searchQuery: "filtered" } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(1);
    expect(mockFetchRemoteNodeTasks).toHaveBeenLastCalledWith("node_abc", "proj_001", "filtered");
    expect(result.current.tasks).toEqual(filteredTasks);

    // Clear searchQuery
    rerender({ searchQuery: "" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(2);
    expect(mockFetchRemoteNodeTasks).toHaveBeenLastCalledWith("node_abc", "proj_001", "");
    expect(result.current.tasks).toEqual(allTasks);
  });

  it("refresh function re-fetches with current searchQuery", async () => {
    const mockTasks = [
      {
        id: "FN-001",
        title: "Test Task",
        description: "Test description",
        column: "todo" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        size: "M" as const,
        reviewLevel: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        log: [],
      },
    ];

    mockFetchRemoteNodeTasks
      .mockResolvedValueOnce(mockTasks)
      .mockResolvedValueOnce(mockTasks);

    const { result } = renderHook(() =>
      useRemoteNodeData("node_abc", { projectId: "proj_001", searchQuery: "test" }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(1);
    expect(mockFetchRemoteNodeTasks).toHaveBeenLastCalledWith("node_abc", "proj_001", "test");

    // Call refresh
    result.current.refresh();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(2);
    expect(mockFetchRemoteNodeTasks).toHaveBeenLastCalledWith("node_abc", "proj_001", "test");
  });
});

describe("useRemoteNodeData", () => {
  beforeEach(() => {
    mockFetchRemoteNodeHealth.mockReset();
    mockFetchRemoteNodeProjects.mockReset();
    mockFetchRemoteNodeTasks.mockReset();
    mockFetchRemoteNodeProjectHealth.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("when nodeId is null", () => {
    it("returns empty state without fetching", () => {
      const { result } = renderHook(() => useRemoteNodeData(null));

      expect(result.current.projects).toEqual([]);
      expect(result.current.tasks).toEqual([]);
      expect(result.current.health).toBe(null);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(null);

      // No API calls should have been made
      expect(mockFetchRemoteNodeHealth).not.toHaveBeenCalled();
      expect(mockFetchRemoteNodeProjects).not.toHaveBeenCalled();
    });

    it("returns empty state with projectId option but no nodeId", () => {
      const { result } = renderHook(() => useRemoteNodeData(null, { projectId: "proj_001" }));

      expect(result.current.projects).toEqual([]);
      expect(result.current.tasks).toEqual([]);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(null);

      // No API calls should have been made
      expect(mockFetchRemoteNodeHealth).not.toHaveBeenCalled();
      expect(mockFetchRemoteNodeTasks).not.toHaveBeenCalled();
    });
  });

  describe("when nodeId is provided", () => {
    it("fetches health and projects on mount", async () => {
      const mockHealth = { status: "online", version: "1.0.0", nodeId: "node_abc" };
      const mockProjects = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active" as const,
          isolationMode: "in-process" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];

      mockFetchRemoteNodeHealth.mockResolvedValueOnce(mockHealth);
      mockFetchRemoteNodeProjects.mockResolvedValueOnce(mockProjects);

      const { result } = renderHook(() => useRemoteNodeData("node_abc"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetchRemoteNodeHealth).toHaveBeenCalledTimes(1);
      expect(mockFetchRemoteNodeHealth).toHaveBeenCalledWith("node_abc");
      expect(mockFetchRemoteNodeProjects).toHaveBeenCalledTimes(1);
      expect(mockFetchRemoteNodeProjects).toHaveBeenCalledWith("node_abc");
      expect(result.current.health).toEqual(mockHealth);
      expect(result.current.projects).toEqual(mockProjects);
    });

    it("fetches tasks and project health when projectId option is provided", async () => {
      const mockHealth = { status: "online", version: "1.0.0", nodeId: "node_abc" };
      const mockProjects = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active" as const,
          isolationMode: "in-process" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const mockTasks = [
        {
          id: "FN-001",
          title: "Test Task",
          description: "Test description",
          column: "todo" as const,
          dependencies: [],
          steps: [],
          currentStep: 0,
          size: "M" as const,
          reviewLevel: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          columnMovedAt: "2026-01-01T00:00:00.000Z",
          log: [],
        },
      ];
      const mockProjectHealth = {
        projectId: "proj_001",
        activeTaskCount: 5,
        inFlightAgentCount: 2,
        status: "active" as const,
        totalTasksCompleted: 0,
        totalTasksFailed: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      mockFetchRemoteNodeHealth.mockResolvedValueOnce(mockHealth);
      mockFetchRemoteNodeProjects.mockResolvedValueOnce(mockProjects);
      mockFetchRemoteNodeTasks.mockResolvedValueOnce(mockTasks);
      mockFetchRemoteNodeProjectHealth.mockResolvedValueOnce(mockProjectHealth);

      const { result } = renderHook(() =>
        useRemoteNodeData("node_abc", { projectId: "proj_001" }),
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetchRemoteNodeTasks).toHaveBeenCalledTimes(1);
      expect(mockFetchRemoteNodeTasks).toHaveBeenCalledWith("node_abc", "proj_001", undefined);
      expect(mockFetchRemoteNodeProjectHealth).toHaveBeenCalledTimes(1);
      expect(mockFetchRemoteNodeProjectHealth).toHaveBeenCalledWith("node_abc", "proj_001");
      expect(result.current.tasks).toEqual(mockTasks);
    });

    it("handles errors gracefully", async () => {
      mockFetchRemoteNodeHealth.mockResolvedValueOnce({
        status: "online",
        version: "1.0.0",
        nodeId: "node_abc",
      });
      mockFetchRemoteNodeProjects.mockRejectedValueOnce(new Error("Failed to fetch projects"));

      const { result } = renderHook(() => useRemoteNodeData("node_abc"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toContain("Failed to fetch projects");
    });

    it("handles health fetch errors", async () => {
      mockFetchRemoteNodeHealth.mockRejectedValueOnce(new Error("Health check failed"));

      const { result } = renderHook(() => useRemoteNodeData("node_abc"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toContain("Health check failed");
    });

    it("refresh function re-fetches data", async () => {
      const initialHealth = { status: "online", version: "1.0.0", nodeId: "node_abc" };
      const initialProjects = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active" as const,
          isolationMode: "in-process" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];

      mockFetchRemoteNodeHealth.mockResolvedValueOnce(initialHealth);
      mockFetchRemoteNodeProjects.mockResolvedValueOnce(initialProjects);

      const { result } = renderHook(() => useRemoteNodeData("node_abc"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.health).toEqual(initialHealth);

      // Set up new responses for refresh
      const refreshedHealth = { status: "online", version: "1.1.0", nodeId: "node_abc" };
      const refreshedProjects = [
        {
          id: "proj_002",
          name: "New Project",
          path: "/new/path",
          status: "active" as const,
          isolationMode: "in-process" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockFetchRemoteNodeHealth.mockResolvedValueOnce(refreshedHealth);
      mockFetchRemoteNodeProjects.mockResolvedValueOnce(refreshedProjects);

      // Call refresh
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.health).toEqual(refreshedHealth);
      });

      expect(result.current.projects).toEqual(refreshedProjects);
    });

    it("refetches when nodeId changes", async () => {
      const mockHealth = { status: "online", version: "1.0.0", nodeId: "node_abc" };
      const mockProjects = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active" as const,
          isolationMode: "in-process" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];

      mockFetchRemoteNodeHealth.mockResolvedValue(mockHealth);
      mockFetchRemoteNodeProjects.mockResolvedValue(mockProjects);

      const { result, rerender } = renderHook(
        ({ nodeId }: { nodeId: string | null }) => useRemoteNodeData(nodeId),
        { initialProps: { nodeId: "node_abc" } },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetchRemoteNodeHealth).toHaveBeenCalledTimes(1);

      // Change nodeId
      rerender({ nodeId: "node_xyz" });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Should have fetched for the new nodeId
      expect(mockFetchRemoteNodeHealth).toHaveBeenCalledTimes(2);
      expect(mockFetchRemoteNodeHealth).toHaveBeenLastCalledWith("node_xyz");
    });
  });
});
