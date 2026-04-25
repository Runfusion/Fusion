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
    projectsError: null,
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

  it("does NOT call openSetupWizard when projects exist even if no current project selected", async () => {
    vi.useFakeTimers();
    const openSetupWizard = vi.fn();

    renderHook(() =>
      useViewState(
        createOptions({
          projectsLength: 3, // Projects exist
          currentProject: null, // But none selected yet
          openSetupWizard,
        }),
      ),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // Should NOT open setup wizard when projects already exist
    // The dashboard should show overview mode to let user pick a project
    expect(openSetupWizard).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT call openSetupWizard when the initial projects fetch failed", async () => {
    vi.useFakeTimers();
    const openSetupWizard = vi.fn();

    renderHook(() =>
      useViewState(
        createOptions({
          projectsLength: 0,
          currentProject: null,
          projectsError: "Failed to fetch projects",
          openSetupWizard,
        }),
      ),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(openSetupWizard).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // ── Insights view persistence ─────────────────────────────────────

  it("reads saved insights taskView from scoped localStorage on init", async () => {
    // Set up scoped storage for project
    localStorage.setItem("kb:proj_123:kb-dashboard-task-view", "insights");

    const { result } = renderHook(() =>
      useViewState(
        createOptions({
          currentProject: PROJECT,
        }),
      ),
    );

    await waitFor(() => {
      expect(result.current.taskView).toBe("insights");
    });
  });

  it("persists insights taskView changes to scoped localStorage", async () => {
    const { result } = renderHook(() =>
      useViewState(
        createOptions({
          currentProject: PROJECT,
        }),
      ),
    );

    await act(async () => {
      result.current.setTaskView("insights");
    });

    expect(localStorage.getItem("kb:proj_123:kb-dashboard-task-view")).toBe("insights");
  });

  it("restores dev-server task view and normalizes legacy devserver values", async () => {
    localStorage.setItem("kb:proj_123:kb-dashboard-task-view", "dev-server");

    const { result, rerender } = renderHook(
      ({ project }) => useViewState(createOptions({ currentProject: project })),
      { initialProps: { project: PROJECT } },
    );

    await waitFor(() => {
      expect(result.current.taskView).toBe("dev-server");
    });

    await act(async () => {
      result.current.setTaskView("dev-server");
    });

    expect(localStorage.getItem("kb:proj_123:kb-dashboard-task-view")).toBe("dev-server");

    localStorage.setItem("kb:proj_123:kb-dashboard-task-view", "devserver");
    rerender({ project: { ...PROJECT, id: "proj_legacy", name: "Legacy" } });
    rerender({ project: PROJECT });

    await waitFor(() => {
      expect(result.current.taskView).toBe("dev-server");
    });
  });

  it("restores legacy views (board/list/agents/missions/chat) from scoped storage", async () => {
    const legacyViews = ["board", "list", "agents", "missions", "chat"] as const;

    for (const view of legacyViews) {
      localStorage.clear();
      localStorage.setItem(`kb:proj_123:kb-dashboard-task-view`, view);

      const { result } = renderHook(() =>
        useViewState(
          createOptions({
            currentProject: PROJECT,
          }),
        ),
      );

      await waitFor(() => {
        expect(result.current.taskView).toBe(view);
      });
    }
  });

  // ── Project-switch scoped rehydration ─────────────────────────────

  it("project A reads its own scoped task-view and project B reads its own", async () => {
    const projectA: ProjectInfo = { ...PROJECT, id: "proj_a", name: "Project A" };
    const projectB: ProjectInfo = { ...PROJECT, id: "proj_b", name: "Project B" };

    // Set different views for each project
    localStorage.setItem("kb:proj_a:kb-dashboard-task-view", "insights");
    localStorage.setItem("kb:proj_b:kb-dashboard-task-view", "agents");

    // Start with project A
    const { result, rerender } = renderHook(
      ({ project }) => useViewState(createOptions({ currentProject: project })),
      { initialProps: { project: projectA } },
    );

    await waitFor(() => {
      expect(result.current.taskView).toBe("insights");
    });

    // Switch to project B
    rerender({ project: projectB });

    await waitFor(() => {
      expect(result.current.taskView).toBe("agents");
    });

    // Switch back to project A - should restore A's view
    rerender({ project: projectA });

    await waitFor(() => {
      expect(result.current.taskView).toBe("insights");
    });
  });

  it("no cross-project bleed when switching projects", async () => {
    const projectA: ProjectInfo = { ...PROJECT, id: "proj_a", name: "Project A" };
    const projectB: ProjectInfo = { ...PROJECT, id: "proj_b", name: "Project B" };

    // Only set view for project A, project B has no saved view
    localStorage.setItem("kb:proj_a:kb-dashboard-task-view", "insights");
    // Ensure project B has no scoped storage
    localStorage.removeItem("kb:proj_b:kb-dashboard-task-view");

    // Load project A
    const { result: resultA } = renderHook(() =>
      useViewState(
        createOptions({
          currentProject: projectA,
        }),
      ),
    );

    await waitFor(() => {
      expect(resultA.current.taskView).toBe("insights");
    });

    // Load project B (no saved view - should default to board)
    const { result: resultB } = renderHook(() =>
      useViewState(
        createOptions({
          currentProject: projectB,
        }),
      ),
    );

    await waitFor(() => {
      expect(resultB.current.taskView).toBe("board");
    });

    // Project A's view should still be insights (not affected by project B load)
    expect(resultA.current.taskView).toBe("insights");
  });
});
