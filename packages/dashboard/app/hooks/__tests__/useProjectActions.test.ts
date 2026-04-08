import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectActions } from "../useProjectActions";
import * as api from "../../api";
import type { ProjectInfo } from "../../api";

vi.mock("../../api", () => ({
  updateProject: vi.fn(),
  unregisterProject: vi.fn(),
}));

const mockUpdateProject = vi.mocked(api.updateProject);
const mockUnregisterProject = vi.mocked(api.unregisterProject);

const PROJECT: ProjectInfo = {
  id: "proj_123",
  name: "Demo",
  path: "/demo",
  status: "active",
  isolationMode: "in-process",
  createdAt: "",
  updatedAt: "",
};

function createOptions(overrides: Partial<Parameters<typeof useProjectActions>[0]> = {}): Parameters<typeof useProjectActions>[0] {
  return {
    setCurrentProject: vi.fn(),
    clearCurrentProject: vi.fn(),
    setViewMode: vi.fn(),
    currentProject: PROJECT,
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    toggleFavoriteProvider: vi.fn().mockResolvedValue(undefined),
    toggleFavoriteModel: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    openSettings: vi.fn(),
    openSetupWizard: vi.fn(),
    closeSetupWizard: vi.fn(),
    closeModelOnboarding: vi.fn(),
    ...overrides,
  };
}

describe("useProjectActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateProject.mockResolvedValue(PROJECT);
    mockUnregisterProject.mockResolvedValue(undefined);
  });

  it("handleSelectProject sets current project and view mode", () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSelectProject(PROJECT);
    });

    expect(options.setCurrentProject).toHaveBeenCalledWith(PROJECT);
    expect(options.setViewMode).toHaveBeenCalledWith("project");
  });

  it("handleViewAllProjects clears current project and sets overview", () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleViewAllProjects();
    });

    expect(options.clearCurrentProject).toHaveBeenCalledTimes(1);
    expect(options.setViewMode).toHaveBeenCalledWith("overview");
  });

  it("handleSetupComplete closes wizard, sets project, toasts, and refreshes", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSetupComplete(PROJECT);
    });

    expect(options.closeSetupWizard).toHaveBeenCalledTimes(1);
    expect(options.setCurrentProject).toHaveBeenCalledWith(PROJECT);
    expect(options.setViewMode).toHaveBeenCalledWith("project");
    expect(options.addToast).toHaveBeenCalledWith("Project Demo registered successfully", "success");
    expect(options.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("handlePauseProject calls updateProject and shows success toast", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handlePauseProject(PROJECT);
    });

    expect(mockUpdateProject).toHaveBeenCalledWith(PROJECT.id, { status: "paused" });
    expect(options.addToast).toHaveBeenCalledWith("Project Demo paused", "success");
    expect(options.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("handleResumeProject calls updateProject and shows success toast", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handleResumeProject(PROJECT);
    });

    expect(mockUpdateProject).toHaveBeenCalledWith(PROJECT.id, { status: "active" });
    expect(options.addToast).toHaveBeenCalledWith("Project Demo resumed", "success");
    expect(options.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("handleRemoveProject unregisters, clears current selection, toasts, and refreshes", async () => {
    const options = createOptions({ currentProject: PROJECT });
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handleRemoveProject(PROJECT);
    });

    expect(mockUnregisterProject).toHaveBeenCalledWith(PROJECT.id);
    expect(options.addToast).toHaveBeenCalledWith("Project Demo removed", "success");
    expect(options.clearCurrentProject).toHaveBeenCalledTimes(1);
    expect(options.setViewMode).toHaveBeenCalledWith("overview");
    expect(options.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("handleRemoveProject shows error toast on API failure", async () => {
    mockUnregisterProject.mockRejectedValueOnce(new Error("boom"));
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handleRemoveProject(PROJECT);
    });

    expect(options.addToast).toHaveBeenCalledWith("Failed to remove project Demo", "error");
  });

  it("handleToggleFavorite delegates and shows error toast on failure", async () => {
    const options = createOptions({
      toggleFavoriteProvider: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handleToggleFavorite("anthropic");
    });

    expect(options.toggleFavoriteProvider).toHaveBeenCalledWith("anthropic");
    expect(options.addToast).toHaveBeenCalledWith("Failed to update favorites", "error");
  });

  it("handleToggleModelFavorite delegates and shows error toast on failure", async () => {
    const options = createOptions({
      toggleFavoriteModel: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handleToggleModelFavorite("claude-sonnet-4-5");
    });

    expect(options.toggleFavoriteModel).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(options.addToast).toHaveBeenCalledWith("Failed to update model favorites", "error");
  });
});
