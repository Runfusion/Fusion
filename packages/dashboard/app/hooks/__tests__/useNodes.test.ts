import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, fireEvent } from "@testing-library/react";
import { useNodes } from "../useNodes";
import { useManagedDockerNodes } from "../useManagedDockerNodes";
import { useMeshState } from "../useMeshState";
import * as api from "../../api";
import * as nodeApi from "../../api-node";
import type { ManagedDockerNodeInfo, NodeInfo, NodeOnboardingInput } from "../../api";
import type { NodeMeshState } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchNodes: vi.fn(),
  registerNode: vi.fn(),
  updateNode: vi.fn(),
  unregisterNode: vi.fn(),
  checkNodeHealth: vi.fn(),
  fetchMeshState: vi.fn(),
  fetchManagedDockerNodes: vi.fn(),
  fetchManagedDockerNodeContainerStatus: vi.fn(),
  fetchDockerNodeLogs: vi.fn(),
  createManagedDockerNode: vi.fn(),
}));

vi.mock("../../api-node", () => ({
  persistNodeProjectPathMappings: vi.fn(),
}));

const mockFetchNodes = vi.mocked(api.fetchNodes);
const mockRegisterNode = vi.mocked(api.registerNode);
const mockUpdateNode = vi.mocked(api.updateNode);
const mockUnregisterNode = vi.mocked(api.unregisterNode);
const mockCheckNodeHealth = vi.mocked(api.checkNodeHealth);
const mockFetchMeshState = vi.mocked(api.fetchMeshState);
const mockFetchManagedDockerNodes = vi.mocked(api.fetchManagedDockerNodes);
const mockPersistNodeProjectPathMappings = vi.mocked(nodeApi.persistNodeProjectPathMappings);

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node_local",
    name: "Local Node",
    type: "local",
    status: "online",
    capabilities: ["executor"],
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMeshNode(overrides: Partial<NodeMeshState> = {}): NodeMeshState {
  return {
    id: "node_local",
    name: "Local Node",
    type: "local",
    status: "online",
    capabilities: ["executor"],
    maxConcurrent: 2,
    activeTasks: 0,
    queuedTasks: 0,
    lastHeartbeat: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as NodeMeshState;
}

function makeDockerNode(overrides: Partial<ManagedDockerNodeInfo> = {}): ManagedDockerNodeInfo {
  return {
    id: "docker-1",
    name: "Docker Node",
    nodeId: "node-docker-1",
    status: "running",
    hostConfig: { type: "local" },
    volumeMounts: [],
    ...overrides,
  } as ManagedDockerNodeInfo;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

async function simulateHiddenToVisibleResume(): Promise<void> {
  setVisibilityState("hidden");
  act(() => {
    fireEvent(document, new Event("visibilitychange"));
    vi.advanceTimersByTime(1100);
  });

  setVisibilityState("visible");
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
    await flushPromises();
  });
}

describe("useNodes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibilityState("visible");
    mockFetchNodes.mockReset();
    mockRegisterNode.mockReset();
    mockUpdateNode.mockReset();
    mockUnregisterNode.mockReset();
    mockCheckNodeHealth.mockReset();
    mockFetchMeshState.mockReset();
    mockFetchManagedDockerNodes.mockReset();
    mockPersistNodeProjectPathMappings.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches nodes on mount", async () => {
    mockFetchNodes.mockResolvedValueOnce([makeNode()]);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0].name).toBe("Local Node");
  });

  it("handles fetch error gracefully", async () => {
    mockFetchNodes.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("boom");
  });

  it("register creates node and persists selected path mappings", async () => {
    mockFetchNodes.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const nodeInput: NodeOnboardingInput = {
      name: "Remote Node",
      type: "remote",
      url: "https://node.test",
      projectMappings: [{ projectId: "proj-1", path: "/mnt/proj-1" }],
    };
    const createdNode = makeNode({
      id: "node_remote",
      name: "Remote Node",
      type: "remote",
      url: "https://node.test",
      status: "connecting",
    });
    mockRegisterNode.mockResolvedValueOnce(createdNode);
    mockPersistNodeProjectPathMappings.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.register(nodeInput);
    });

    expect(mockRegisterNode).toHaveBeenCalledWith({
      name: "Remote Node",
      type: "remote",
      url: "https://node.test",
    });
    expect(mockPersistNodeProjectPathMappings).toHaveBeenCalledWith("node_remote", nodeInput.projectMappings);
    expect(mockFetchNodes).toHaveBeenCalledTimes(2);
  });

  it("register rolls back node when mapping write fails", async () => {
    mockFetchNodes.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const createdNode = makeNode({ id: "node_remote", type: "remote", status: "connecting" });
    mockRegisterNode.mockResolvedValueOnce(createdNode);
    mockPersistNodeProjectPathMappings.mockRejectedValueOnce(new Error("mapping failed"));
    mockUnregisterNode.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.register({
      name: "Remote Node",
      type: "remote",
      url: "https://node.test",
      projectMappings: [{ projectId: "proj-1", path: "/mnt/proj-1" }],
    })).rejects.toThrow("mapping failed");

    expect(mockUnregisterNode).toHaveBeenCalledWith("node_remote");
    expect(mockFetchNodes).toHaveBeenCalledTimes(2);
  });

  it("register appends cleanup failure message when rollback also fails", async () => {
    mockFetchNodes.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const createdNode = makeNode({ id: "node_remote", type: "remote", status: "connecting" });
    mockRegisterNode.mockResolvedValueOnce(createdNode);
    mockPersistNodeProjectPathMappings.mockRejectedValueOnce(new Error("mapping failed"));
    mockUnregisterNode.mockRejectedValueOnce(new Error("cleanup failed"));

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.register({
      name: "Remote Node",
      type: "remote",
      url: "https://node.test",
      projectMappings: [{ projectId: "proj-1", path: "/mnt/proj-1" }],
    })).rejects.toThrow("mapping failed. Cleanup also failed: cleanup failed");

    expect(mockUnregisterNode).toHaveBeenCalledWith("node_remote");
  });

  it("does not rollback when no mappings are selected even if post-success refresh fails", async () => {
    mockFetchNodes.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("refresh failed"));
    const createdNode = makeNode({ id: "node_remote", type: "remote", status: "connecting" });
    mockRegisterNode.mockResolvedValueOnce(createdNode);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await expect(result.current.register({
        name: "Remote Node",
        type: "remote",
        url: "https://node.test",
        projectMappings: [],
      })).resolves.toEqual(createdNode);
    });

    expect(mockPersistNodeProjectPathMappings).not.toHaveBeenCalled();
    expect(mockUnregisterNode).not.toHaveBeenCalled();
  });

  it("update modifies node optimistically", async () => {
    mockFetchNodes.mockResolvedValueOnce([makeNode()]);
    const updatedNode = makeNode({ name: "Renamed Node", maxConcurrent: 4 });
    mockUpdateNode.mockResolvedValueOnce(updatedNode);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.update("node_local", { name: "Renamed Node", maxConcurrent: 4 });
    });

    expect(mockUpdateNode).toHaveBeenCalledWith("node_local", { name: "Renamed Node", maxConcurrent: 4 });
    expect(result.current.nodes[0].name).toBe("Renamed Node");
  });

  it("unregister removes node optimistically", async () => {
    mockFetchNodes.mockResolvedValueOnce([makeNode()]);
    mockUnregisterNode.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.nodes).toHaveLength(1);

    await act(async () => {
      await result.current.unregister("node_local");
    });

    expect(mockUnregisterNode).toHaveBeenCalledWith("node_local");
    expect(result.current.nodes).toHaveLength(0);
  });

  it("healthCheck updates node status in local state", async () => {
    mockFetchNodes.mockResolvedValueOnce([makeNode({ status: "offline" })]);
    mockCheckNodeHealth.mockResolvedValueOnce({
      nodeId: "node_local",
      status: "online",
      checkedAt: "2026-01-03T00:00:00.000Z",
    });

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.nodes[0].status).toBe("offline");

    await act(async () => {
      await result.current.healthCheck("node_local");
    });

    expect(mockCheckNodeHealth).toHaveBeenCalledWith("node_local");
    expect(result.current.nodes[0].status).toBe("online");
    expect(result.current.nodes[0].updatedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("refresh manually refetches nodes", async () => {
    mockFetchNodes
      .mockResolvedValueOnce([makeNode({ name: "Before Refresh" })])
      .mockResolvedValueOnce([makeNode({ name: "After Refresh" })]);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.nodes[0].name).toBe("Before Refresh");

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.nodes[0].name).toBe("After Refresh");
  });

  it("suppresses visibility-resume suspension errors when nodes already exist", async () => {
    mockFetchNodes
      .mockResolvedValueOnce([makeNode({ name: "Initial" })])
      .mockRejectedValueOnce(new Error("Failed to fetch"));

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.nodes[0].name).toBe("Initial");
    expect(result.current.error).toBeNull();

    await simulateHiddenToVisibleResume();

    expect(result.current.nodes[0].name).toBe("Initial");
    expect(result.current.error).toBeNull();
  });

  it("refetches when visibility changes back to visible", async () => {
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    mockFetchNodes
      .mockResolvedValueOnce([makeNode({ name: "Initial" })])
      .mockResolvedValueOnce([makeNode({ name: "Visible Again" })]);

    const { result } = renderHook(() => useNodes());

    await act(async () => {
      await flushPromises();
    });

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    await act(async () => {
      vi.advanceTimersByTime(1100);
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(result.current.nodes[0].name).toBe("Visible Again");

    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    }
  });
});

describe("useMeshState", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibilityState("visible");
    mockFetchMeshState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses visibility-resume suspension errors when mesh state already exists", async () => {
    mockFetchMeshState
      .mockResolvedValueOnce({ nodes: [makeMeshNode({ name: "Initial Mesh" })] })
      .mockRejectedValueOnce(new Error("Failed to fetch"));

    const { result } = renderHook(() => useMeshState());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.meshState[0].name).toBe("Initial Mesh");
    expect(result.current.error).toBeNull();

    await simulateHiddenToVisibleResume();

    expect(result.current.meshState[0].name).toBe("Initial Mesh");
    expect(result.current.error).toBeNull();
  });
});

describe("useManagedDockerNodes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibilityState("visible");
    mockFetchManagedDockerNodes.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses visibility-resume suspension errors when docker nodes already exist", async () => {
    mockFetchManagedDockerNodes
      .mockResolvedValueOnce([makeDockerNode({ name: "Initial Docker" })])
      .mockRejectedValueOnce(new Error("Failed to fetch"));

    const { result } = renderHook(() => useManagedDockerNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.dockerNodes[0].name).toBe("Initial Docker");
    expect(result.current.error).toBeNull();

    await simulateHiddenToVisibleResume();

    expect(result.current.dockerNodes[0].name).toBe("Initial Docker");
    expect(result.current.error).toBeNull();
  });
});
