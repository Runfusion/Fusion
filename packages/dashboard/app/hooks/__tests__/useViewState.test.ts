import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useViewState } from "../useViewState";
import type { ProjectInfo } from "../../api";
import type { ThemeMode } from "@fusion/core";

const PROJECT: ProjectInfo = {
  id: "proj_123",
  name: "Demo Project",
  path: "/demo",
  status: "active",
  isolationMode: "in-process",
  createdAt: "",
  updatedAt: "",
};

function createOptions(overrides: Partial<Parameters<typeof useViewState>[0]> = {}): Parameters<typeof useViewState>[0] {
  return {
    projectsLoading: false,
    currentProjectLoading: false,
    currentProject: null,
    projectsLength: 1,
    setupWizardOpen: false,
    openSetupWizard: vi.fn(),
    themeMode: "dark",
    setThemeMode: vi.fn(),
    ...overrides,
  };
}

describe("useViewState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("returns default viewMode and taskView when no localStorage exists", async () => {
    const { result } = renderHook(() => useViewState(createOptions()));

    await waitFor(() => {
      expect(result.current.viewMode).toBe("overview");
      expect(result.current.taskView).toBe("board");
    });
  });

  it("reads saved viewMode from localStorage on init", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");

    const { result } = renderHook(() => useViewState(createOptions()));

    await waitFor(() => {
      expect(result.current.viewMode).toBe("project");
    });
  });

  it("reads saved taskView from localStorage on init", async () => {
    localStorage.setItem("kb-dashboard-task-view", "list");

    const { result } = renderHook(() => useViewState(createOptions()));

    await waitFor(() => {
      expect(result.current.taskView).toBe("list");
    });
  });

  it("persists viewMode changes to localStorage", async () => {
    const { result } = renderHook(() => useViewState(createOptions()));

    await act(async () => {
      result.current.setViewMode("project");
    });

    expect(localStorage.getItem("kb-dashboard-view-mode")).toBe("project");
  });

  it("persists taskView changes to localStorage", async () => {
    const { result } = renderHook(() => useViewState(createOptions()));

    await act(async () => {
      result.current.setTaskView("list");
    });

    expect(localStorage.getItem("kb-dashboard-task-view")).toBe("list");
  });

  it("handleChangeTaskView updates taskView state", async () => {
    const { result } = renderHook(() => useViewState(createOptions()));

    await act(async () => {
      result.current.handleChangeTaskView("agents");
    });

    expect(result.current.taskView).toBe("agents");
  });

  it("handleToggleTheme cycles dark → light → system → dark", async () => {
    let themeMode: ThemeMode = "dark";
    const setThemeMode = vi.fn((mode: ThemeMode) => {
      themeMode = mode;
    });

    const { result, rerender } = renderHook(() =>
      useViewState(
        createOptions({
          themeMode,
          setThemeMode,
        }),
      ),
    );

    await act(async () => {
      result.current.handleToggleTheme();
    });
    expect(setThemeMode).toHaveBeenLastCalledWith("light");

    rerender();
    await act(async () => {
      result.current.handleToggleTheme();
    });
    expect(setThemeMode).toHaveBeenLastCalledWith("system");

    rerender();
    await act(async () => {
      result.current.handleToggleTheme();
    });
    expect(setThemeMode).toHaveBeenLastCalledWith("dark");
  });

  it("syncs viewMode to project when currentProject is restored after loading", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "overview");

    const { result } = renderHook(() =>
      useViewState(
        createOptions({
          currentProject: PROJECT,
          projectsLength: 1,
        }),
      ),
    );

    await waitFor(() => {
      expect(result.current.viewMode).toBe("project");
    });
  });

  it("calls openSetupWizard when no projects and no current project after loading", async () => {
    vi.useFakeTimers();
    const openSetupWizard = vi.fn();

    renderHook(() =>
      useViewState(
        createOptions({
          projectsLength: 0,
          currentProject: null,
          openSetupWizard,
        }),
      ),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(openSetupWizard).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
