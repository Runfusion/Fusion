import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNodeProxy } from "../useNodeProxy";
import * as apiModule from "../../api";
import * as NodeContextModule from "../../context/NodeContext";
import type { NodeConfig } from "@fusion/core";

vi.mock("../../api", () => ({
  proxyApi: vi.fn(),
}));

vi.mock("../../context/NodeContext", () => ({
  useNodeContext: vi.fn(),
}));

const mockProxyApi = vi.mocked(apiModule.proxyApi);
const mockUseNodeContext = vi.mocked(NodeContextModule.useNodeContext);

describe("useNodeProxy", () => {
  beforeEach(() => {
    mockProxyApi.mockReset();
    mockUseNodeContext.mockReset();
  });

  it("calls proxyApi with nodeId when remote node is set", async () => {
    const mockNode: NodeConfig = {
      id: "node_abc123",
      name: "Remote Node",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    mockUseNodeContext.mockReturnValue({
      currentNode: mockNode,
      currentNodeId: "node_abc123",
      isRemote: true,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    mockProxyApi.mockResolvedValueOnce({ tasks: [] });

    const { result } = renderHook(() => useNodeProxy());

    const response = await result.current.proxyFetch<{ tasks: unknown[] }>("/tasks");

    expect(mockProxyApi).toHaveBeenCalledTimes(1);
    expect(mockProxyApi).toHaveBeenCalledWith("/tasks", {
      nodeId: "node_abc123",
    });
    expect(response).toEqual({ tasks: [] });
  });

  it("calls proxyApi without nodeId when no node is set (local view)", async () => {
    mockUseNodeContext.mockReturnValue({
      currentNode: null,
      currentNodeId: null,
      isRemote: false,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    mockProxyApi.mockResolvedValueOnce({ tasks: [] });

    const { result } = renderHook(() => useNodeProxy());

    const response = await result.current.proxyFetch<{ tasks: unknown[] }>("/tasks");

    expect(mockProxyApi).toHaveBeenCalledTimes(1);
    expect(mockProxyApi).toHaveBeenCalledWith("/tasks", {
      nodeId: undefined,
    });
    expect(response).toEqual({ tasks: [] });
  });

  it("calls proxyApi without nodeId when node is local type", async () => {
    const mockLocalNode: NodeConfig = {
      id: "node_local",
      name: "Local Node",
      type: "local",
      status: "online",
      maxConcurrent: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    mockUseNodeContext.mockReturnValue({
      currentNode: mockLocalNode,
      currentNodeId: "node_local",
      isRemote: false,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    mockProxyApi.mockResolvedValueOnce({ tasks: [] });

    const { result } = renderHook(() => useNodeProxy());

    const response = await result.current.proxyFetch<{ tasks: unknown[] }>("/tasks");

    expect(mockProxyApi).toHaveBeenCalledTimes(1);
    expect(mockProxyApi).toHaveBeenCalledWith("/tasks", {
      nodeId: undefined,
    });
    expect(response).toEqual({ tasks: [] });
  });

  it("returns currentNodeId from context", async () => {
    const mockNode: NodeConfig = {
      id: "node_xyz",
      name: "Remote Node",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    mockUseNodeContext.mockReturnValue({
      currentNode: mockNode,
      currentNodeId: "node_xyz",
      isRemote: true,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    const { result } = renderHook(() => useNodeProxy());

    expect(result.current.currentNodeId).toBe("node_xyz");
    expect(result.current.isRemote).toBe(true);
  });

  it("returns isRemote false when no node is set", async () => {
    mockUseNodeContext.mockReturnValue({
      currentNode: null,
      currentNodeId: null,
      isRemote: false,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    const { result } = renderHook(() => useNodeProxy());

    expect(result.current.currentNodeId).toBe(null);
    expect(result.current.isRemote).toBe(false);
  });

  it("passes through RequestInit options", async () => {
    mockUseNodeContext.mockReturnValue({
      currentNode: null,
      currentNodeId: null,
      isRemote: false,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    mockProxyApi.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useNodeProxy());

    await result.current.proxyFetch("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "New Task" }),
    });

    expect(mockProxyApi).toHaveBeenCalledWith("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "New Task" }),
      nodeId: undefined,
    });
  });

  it("propagates errors from proxyApi", async () => {
    mockUseNodeContext.mockReturnValue({
      currentNode: null,
      currentNodeId: null,
      isRemote: false,
      setCurrentNode: vi.fn(),
      clearCurrentNode: vi.fn(),
    });

    mockProxyApi.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useNodeProxy());

    await expect(result.current.proxyFetch("/tasks")).rejects.toThrow("Network error");
  });
});
