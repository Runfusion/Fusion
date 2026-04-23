import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useCurrentProject } from "./useCurrentProject";
import type { ProjectInfo } from "../api";

// Mock the API functions
vi.mock("../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

import { fetchGlobalSettings, updateGlobalSettings } from "../api";

describe("useCurrentProject", () => {
  const mockProjects: ProjectInfo[] = [
    {
      id: "proj_1",
      name: "Project One",
      path: "/path/one",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "proj_2",
      name: "Project Two",
      path: "/path/two",
      status: "paused",
      isolationMode: "child-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

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

  it("initializes with null when no saved project and no available projects", async () => {
    const { result } = renderHook(() => useCurrentProject([]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.currentProject).toBeNull();
  });

  it("defaults to first active project when projects available but no selection", async () => {
    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should default to first active project
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("loads saved project from global settings", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // After hydration, it should have the saved project
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("loads saved project for specific node ID", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { "node-123": "proj_2" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects, { nodeId: "node-123" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should load proj_2 for node-123
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_2");
    });
  });

  it("defaults to first active project when no selection", async () => {
    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should default to first active project
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("clears selection when project no longer exists and defaults to first active", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_old" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should clear and default to first active
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    // Should persist the new selection
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      }),
    );
  });

  it("setCurrentProject updates selection and persists to global settings", async () => {
    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    expect(result.current.currentProject?.id).toBe("proj_2");
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { local: "proj_2" },
      }),
    );
  });

  it("setCurrentProject uses node ID as key when provided", async () => {
    const { result } = renderHook(() => useCurrentProject(mockProjects, { nodeId: "node-456" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { "node-456": "proj_2" },
      }),
    );
  });

  it("clearCurrentProject removes selection and does not auto-select", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // After loading, we should have proj_1
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    act(() => {
      result.current.clearCurrentProject();
    });

    // After explicit clear, should stay null (no auto-select) so user can view overview
    await waitFor(() => {
      expect(result.current.currentProject).toBeNull();
    });

    // Should persist the clear (remove the key)
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: {},
      }),
    );
  });

  it("handles global settings fetch failure gracefully", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should fall back to default behavior (first active project)
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("handles global settings update failure gracefully", async () => {
    (updateGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    // Should still update state even if persistence fails
    expect(result.current.currentProject?.id).toBe("proj_2");
  });

  it("migrates legacy localStorage to global settings", async () => {
    // Set up legacy localStorage
    localStorage.setItem("kb-dashboard-current-project", JSON.stringify(mockProjects[0]));
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should load from legacy localStorage
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    // Should migrate to global settings
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      }),
    );
  });
});
