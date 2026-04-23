import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ProjectInfo } from "@fusion/core";
import { Header } from "../Header";
import { scopedKey } from "../../utils/projectStorage";

// Mock fetchScripts for overflow submenu
vi.mock("../../api", () => ({
  fetchScripts: vi.fn().mockResolvedValue({}),
}));

const noop = () => {};

// Helper to mock desktop viewport
function mockDesktopMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Simple smoke tests for multi-project flow
describe("MultiProjectFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates project info structure", () => {
    const mockProject: ProjectInfo = {
      id: "proj_1",
      name: "Test Project",
      path: "/path/to/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    };
    
    expect(mockProject.id).toBe("proj_1");
    expect(mockProject.name).toBe("Test Project");
    expect(mockProject.status).toBe("active");
  });

  it("can track project selection flow", () => {
    const projects: ProjectInfo[] = [
      { 
        id: "proj_1", 
        name: "Project One", 
        path: "/path/1", 
        status: "active", 
        isolationMode: "in-process", 
        createdAt: "", 
        updatedAt: "" 
      },
      { 
        id: "proj_2", 
        name: "Project Two", 
        path: "/path/2", 
        status: "paused", 
        isolationMode: "child-process", 
        createdAt: "", 
        updatedAt: "" 
      },
    ];
    
    let currentProject: ProjectInfo | null = null;
    
    // Simulate selecting project
    const selectProject = (project: ProjectInfo) => {
      currentProject = project;
    };
    
    selectProject(projects[0]);
    expect(currentProject?.id).toBe("proj_1");
    
    selectProject(projects[1]);
    expect(currentProject?.status).toBe("paused");
  });

  it("can track view mode transitions", () => {
    type ViewMode = "overview" | "project";
    let viewMode: ViewMode = "overview";
    
    const setViewMode = (mode: ViewMode) => {
      viewMode = mode;
    };
    
    expect(viewMode).toBe("overview");
    
    setViewMode("project");
    expect(viewMode).toBe("project");
  });

  it("validates global view mode and project-scoped task view preferences", () => {
    const storage: Record<string, string> = {};
    const projectId = "proj_1";
    const taskViewKey = scopedKey("kb-dashboard-task-view", projectId);

    storage["kb-dashboard-view-mode"] = "project";
    storage[taskViewKey] = "board";

    expect(storage["kb-dashboard-view-mode"]).toBe("project");
    expect(storage[taskViewKey]).toBe("board");
  });

  describe("Manage Projects dropdown navigation", () => {
    const singleProject: ProjectInfo = {
      id: "proj_1",
      name: "Solo Project",
      path: "/path/to/solo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("navigates to overview from Manage Projects action", () => {
      mockDesktopMatchMedia();

      let viewMode: "overview" | "project" = "project";
      const handleViewAllProjects = vi.fn(() => {
        viewMode = "overview";
      });

      render(
        <Header
          onOpenSettings={noop}
          onOpenGitHubImport={noop}
          globalPaused={false}
          enginePaused={false}
          onToggleGlobalPause={noop}
          onToggleEnginePause={noop}
          projects={[singleProject]}
          currentProject={singleProject}
          onViewAllProjects={handleViewAllProjects}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const manageProjectsAction = screen.getByTestId("manage-projects-action");
      expect(manageProjectsAction.textContent).toContain("Manage Projects");

      fireEvent.click(manageProjectsAction);
      expect(handleViewAllProjects).toHaveBeenCalled();
      expect(viewMode).toBe("overview");
      expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    });

    it("does not render a separate back to projects header button", () => {
      mockDesktopMatchMedia();

      render(
        <Header
          onOpenSettings={noop}
          onOpenGitHubImport={noop}
          globalPaused={false}
          enginePaused={false}
          onToggleGlobalPause={noop}
          onToggleEnginePause={noop}
          projects={[singleProject]}
          currentProject={singleProject}
          onViewAllProjects={noop}
        />
      );

      expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
    });
  });
});
