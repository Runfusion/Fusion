import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectActions } from "../useProjectActions";
import * as api from "../../api";
import type { ProjectInfo } from "../../api";

vi.mock("../../api", () => ({
  pauseProject: vi.fn(),
  resumeProject: vi.fn(),
  updateProject: vi.fn(),
  unregisterProject: vi.fn(),
}));

const mockPauseProject = vi.mocked(api.pauseProject);
const mockResumeProject = vi.mocked(api.resumeProject);
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
  /*
  FNXC:DashboardTests 2026-07-14-19:55:
  handleViewAllProjects now resets the main task surface to command-center via setTaskView so leaving a project cannot leave operators on a project-scoped view (board/list/etc.). The fixture must provide setTaskView so the overview transition stays unit-testable.
  */
  return {
    setCurrentProject: vi.fn(),
    clearCurrentProject: vi.fn(),
    setViewMode: vi.fn(),
    setTaskView: vi.fn(),
    currentProject: PROJECT,
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    toggleFavoriteProvider: vi.fn().mockResolvedValue(undefined),
    toggleFavoriteModel: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    openSettings: vi.fn(),
    openSetupWizard: vi.fn(),
    closeSetupWizard: vi.fn(),
    closeModelOnboarding: vi.fn(),
    closeProjectScopedModals: vi.fn(),
    ...overrides,
  };
}

describe("useProjectActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({ preserved: true }, "", "/");
    mockPauseProject.mockResolvedValue(PROJECT);
    mockResumeProject.mockResolvedValue(PROJECT);
    mockUpdateProject.mockResolvedValue(PROJECT);
    mockUnregisterProject.mockResolvedValue(undefined);
  });

  it("handleSelectProject sets current project, view mode, and URL project state", () => {
    window.history.replaceState({ preserved: "state" }, "", "/?task=FN-1&view=mailbox#message-1");
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSelectProject(PROJECT);
    });

    expect(options.setCurrentProject).toHaveBeenCalledWith(PROJECT);
    expect(options.setViewMode).toHaveBeenCalledWith("project");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?task=FN-1&view=mailbox&project=proj_123");
    expect(window.location.hash).toBe("#message-1");
    expect(window.history.state).toEqual({ preserved: "state" });
  });

  it("handleSelectProject URL-encodes project ids", () => {
    const encodedProject: ProjectInfo = { ...PROJECT, id: "blendance/system id" };
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSelectProject(encodedProject);
    });

    expect(window.location.search).toBe("?project=blendance%2Fsystem+id");
    expect(new URLSearchParams(window.location.search).get("project")).toBe("blendance/system id");
  });

  it("handleSelectProject writes project ids rather than duplicate display names", () => {
    const duplicateNameProject: ProjectInfo = { ...PROJECT, id: "proj_unique_b", name: "Duplicate" };
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSelectProject(duplicateNameProject);
    });

    expect(new URLSearchParams(window.location.search).get("project")).toBe("proj_unique_b");
    expect(window.location.search).not.toContain("Duplicate");
  });

  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Project swap must dismiss the previous project's modals (task detail, planning payloads,
  git manager, …) via closeProjectScopedModals, but re-selecting the current project is a
  no-op navigation and must not close anything the user has open.
  */
  it("handleSelectProject dismisses project-scoped modals when switching to a different project", () => {
    const otherProject: ProjectInfo = { ...PROJECT, id: "proj_other", name: "Other" };
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSelectProject(otherProject);
    });

    expect(options.closeProjectScopedModals).toHaveBeenCalledTimes(1);
  });

  it("handleSelectProject leaves modals alone when re-selecting the current project", () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSelectProject(PROJECT);
    });

    expect(options.closeProjectScopedModals).not.toHaveBeenCalled();
  });

  it("handleViewAllProjects dismisses project-scoped modals", () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleViewAllProjects();
    });

    expect(options.closeProjectScopedModals).toHaveBeenCalledTimes(1);
  });

  it("handleSetupComplete dismisses project-scoped modals when landing on a different project", () => {
    const newProject: ProjectInfo = { ...PROJECT, id: "proj_new", name: "New" };
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleSetupComplete(newProject);
    });

    expect(options.closeProjectScopedModals).toHaveBeenCalledTimes(1);
  });

  it("handleViewAllProjects clears current project, sets overview, and removes only URL project state", () => {
    window.history.replaceState({ preserved: "state" }, "", "/?project=proj_123&task=FN-1&room=room-1#thread");
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    act(() => {
      result.current.handleViewAllProjects();
    });

    expect(options.clearCurrentProject).toHaveBeenCalledTimes(1);
    expect(options.setViewMode).toHaveBeenCalledWith("overview");
    expect(options.setTaskView).toHaveBeenCalledWith("command-center");
    expect(window.location.search).toBe("?task=FN-1&room=room-1");
    expect(window.location.hash).toBe("#thread");
    expect(window.history.state).toEqual({ preserved: "state" });
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

  it("handlePauseProject calls pauseProject and shows success toast", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handlePauseProject(PROJECT);
    });

    expect(mockPauseProject).toHaveBeenCalledWith(PROJECT.id);
    expect(options.addToast).toHaveBeenCalledWith("Project Demo paused", "success");
    expect(options.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("handleResumeProject calls resumeProject and shows success toast", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useProjectActions(options));

    await act(async () => {
      await result.current.handleResumeProject(PROJECT);
    });

    expect(mockResumeProject).toHaveBeenCalledWith(PROJECT.id);
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
