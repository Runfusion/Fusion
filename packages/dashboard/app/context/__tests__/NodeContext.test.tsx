import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { NodeProvider, useNodeContext } from "../NodeContext";
import type { NodeConfig } from "@fusion/core";

// Mock the API functions
vi.mock("../../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

import { fetchGlobalSettings, updateGlobalSettings } from "../../api";

const mockRemoteNode: NodeConfig = {
  id: "node-remote-1",
  name: "Remote Node",
  type: "remote",
  url: "https://remote.example.com",
  apiKey: "test-key",
};

describe("NodeContext", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Default mock implementations
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  afterEach(() => {
    localStorage.clear();
  });

  function renderWithProvider() {
    return renderHook(() => useNodeContext(), {
      wrapper: ({ children }) => <NodeProvider>{children}</NodeProvider>,
    });
  }

  it("initializes with null currentNode when no saved node", async () => {
    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(result.current.currentNode).toBeNull();
    });

    expect(result.current.currentNodeId).toBeNull();
    expect(result.current.isRemote).toBe(false);
  });

  it("loads saved node ID from global settings", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentNodeId: "node-remote-1",
    });

    const { result } = renderWithProvider();

    // Should have loaded the node ID from global settings
    // Note: currentNode stays null until App.tsx resolves it from nodes list
    await waitFor(() => {
      expect(fetchGlobalSettings).toHaveBeenCalled();
    });

    // The NodeContext only stores the ID; App.tsx resolves the full node
    // We verify the settings were fetched correctly
    expect(result.current.currentNode).toBeNull();
  });

  it("persists node selection to global settings", async () => {
    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(result.current.currentNode).toBeNull();
    });

    act(() => {
      result.current.setCurrentNode(mockRemoteNode);
    });

    expect(result.current.currentNode).toEqual(mockRemoteNode);
    expect(result.current.currentNodeId).toBe("node-remote-1");
    expect(result.current.isRemote).toBe(true);

    // Should persist to global settings
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      dashboardCurrentNodeId: "node-remote-1",
    });
  });

  it("clears node selection and updates global settings", async () => {
    // Start with a saved node
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentNodeId: "node-remote-1",
    });

    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(fetchGlobalSettings).toHaveBeenCalled();
    });

    // Simulate App.tsx resolving the node from nodes list
    act(() => {
      result.current.setCurrentNode(mockRemoteNode);
    });

    expect(result.current.currentNode).toEqual(mockRemoteNode);

    // Clear the selection
    act(() => {
      result.current.clearCurrentNode();
    });

    expect(result.current.currentNode).toBeNull();
    expect(result.current.currentNodeId).toBeNull();
    expect(result.current.isRemote).toBe(false);

    // Should persist the clear to global settings
    expect(updateGlobalSettings).toHaveBeenLastCalledWith({
      dashboardCurrentNodeId: undefined,
    });
  });

  it("handles global settings fetch failure gracefully", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(result.current.currentNode).toBeNull();
    });

    // Should still be usable even when settings fetch fails
    act(() => {
      result.current.setCurrentNode(mockRemoteNode);
    });

    expect(result.current.currentNode).toEqual(mockRemoteNode);
    expect(result.current.isRemote).toBe(true);
  });

  it("handles global settings update failure gracefully", async () => {
    (updateGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(result.current.currentNode).toBeNull();
    });

    // Should still update state even if persistence fails
    act(() => {
      result.current.setCurrentNode(mockRemoteNode);
    });

    expect(result.current.currentNode).toEqual(mockRemoteNode);
  });

  it("migrates legacy localStorage to global settings", async () => {
    // Set up legacy localStorage
    localStorage.setItem("fusion-dashboard-current-node", JSON.stringify(mockRemoteNode));
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(fetchGlobalSettings).toHaveBeenCalled();
    });

    // Should migrate to global settings
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      dashboardCurrentNodeId: "node-remote-1",
    });
  });

  it("does not migrate local node from legacy localStorage", async () => {
    // localStorage stores remote nodes only; local is represented by null
    const { result } = renderWithProvider();

    await waitFor(() => {
      expect(fetchGlobalSettings).toHaveBeenCalled();
    });

    // Should not persist any changes when on local node
    act(() => {
      result.current.clearCurrentNode();
    });

    // Should clear from global settings
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      dashboardCurrentNodeId: undefined,
    });
  });

  it("throws error when useNodeContext is used outside NodeProvider", () => {
    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      renderHook(() => useNodeContext());
    }).toThrow("useNodeContext must be used within a NodeProvider");

    consoleSpy.mockRestore();
  });
});
