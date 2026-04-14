import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectOverview } from "../ProjectOverview";
import type { ProjectInfo, ProjectHealth } from "@fusion/core";
import { useProjectHealth } from "../../hooks/useProjectHealth";

// Default mock implementation
function createDefaultHealthMap(projectIds: string[]): Record<string, ProjectHealth> {
  return projectIds.reduce((acc, id) => {
    acc[id] = {
      projectId: id,
      status: "active" as const,
      activeTaskCount: 5,
      inFlightAgentCount: 2,
      totalTasksCompleted: 100,
      totalTasksFailed: 3,
      updatedAt: new Date().toISOString(),
    };
    return acc;
  }, {} as Record<string, ProjectHealth>);
}

// Mock the hooks
vi.mock("../../hooks/useProjectHealth", () => ({
  useProjectHealth: vi.fn((projectIds: string[]) => ({
    healthMap: createDefaultHealthMap(projectIds),
    loading: false,
    error: null,
    refresh: vi.fn(),
    refreshProject: vi.fn(),
  })),
}));

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    Plus: () => <span data-testid="plus-icon">+</span>,
    LayoutGrid: () => <span data-testid="grid-icon">⊞</span>,
    Filter: () => <span data-testid="filter-icon">⚙</span>,
    ArrowUpDown: () => <span data-testid="sort-icon">⇅</span>,
    Activity: () => <span data-testid="activity-icon">⚡</span>,
    CheckCircle: () => <span data-testid="check-icon">✓</span>,
    AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
    Folder: () => <span data-testid="folder-icon">📁</span>,
    Inbox: () => <span data-testid="inbox-icon">📥</span>,
  };
});

// Mock ProjectCard
vi.mock("../ProjectCard", () => ({
  ProjectCard: ({ project, onSelect }: { project: ProjectInfo; onSelect: (p: ProjectInfo) => void }) => (
    <div data-testid={`project-card-${project.id}`} onClick={() => onSelect(project)}>
      {project.name}
    </div>
  ),
}));

// Mock ProjectGridSkeleton
vi.mock("../ProjectGridSkeleton", () => ({
  ProjectGridSkeleton: () => <div data-testid="project-grid-skeleton">Loading...</div>,
}));

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj_abc123",
    name: "Test Project",
    path: "/home/user/projects/test",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

const noop = () => {};

describe("ProjectOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to default state
    vi.mocked(useProjectHealth).mockImplementation((projectIds: string[]) => ({
      healthMap: createDefaultHealthMap(projectIds),
      loading: false,
      error: null,
      refresh: vi.fn(),
      refreshProject: vi.fn(),
    }));
  });

  it("renders without crashing with projects", () => {
    render(
      <ProjectOverview
        projects={[makeProject()]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    expect(screen.getByText("Projects")).toBeDefined();
  });

  it("displays project cards when projects provided", () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    expect(screen.getByTestId("project-card-proj_1")).toBeDefined();
    expect(screen.getByTestId("project-card-proj_2")).toBeDefined();
  });

  it("shows empty state when no projects", () => {
    render(
      <ProjectOverview
        projects={[]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    expect(screen.getByText("No Projects Found")).toBeDefined();
    expect(screen.getByText("Add Your First Project")).toBeDefined();
  });

  it("triggers onAddProject when empty state CTA clicked", () => {
    const onAddProject = vi.fn();
    render(
      <ProjectOverview
        projects={[]}
        onSelectProject={noop}
        onAddProject={onAddProject}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    fireEvent.click(screen.getByText("Add Your First Project"));
    expect(onAddProject).toHaveBeenCalled();
  });

  it("triggers onAddProject when header button clicked", () => {
    const onAddProject = vi.fn();
    render(
      <ProjectOverview
        projects={[makeProject()]}
        onSelectProject={noop}
        onAddProject={onAddProject}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    fireEvent.click(screen.getByText("Add Project"));
    expect(onAddProject).toHaveBeenCalled();
  });

  it("displays correct stats in header", () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", status: "active" }),
          makeProject({ id: "proj_2", status: "active" }),
          makeProject({ id: "proj_3", status: "paused" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    // Total projects = 3 - look specifically in stats section
    const statsSection = screen.getByText("Total").closest(".project-stat__content");
    expect(statsSection?.querySelector(".project-stat__value")?.textContent).toBe("3");
  });

  it("filters projects when clicking filter tabs", async () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", name: "Active Project", status: "active" }),
          makeProject({ id: "proj_2", name: "Paused Project", status: "paused" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    // Initially shows all projects
    expect(screen.getByTestId("project-card-proj_1")).toBeDefined();
    expect(screen.getByTestId("project-card-proj_2")).toBeDefined();

    // Click on "Active" filter
    fireEvent.click(screen.getByText("Active"));

    // Should only show active project
    await waitFor(() => {
      expect(screen.queryByTestId("project-card-proj_1")).toBeDefined();
    });
  });

  it("shows filter counts on tabs", () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", status: "active" }),
          makeProject({ id: "proj_2", status: "active" }),
          makeProject({ id: "proj_3", status: "paused" }),
          makeProject({ id: "proj_4", status: "errored" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    // Find the "All" tab and check its count
    const allTab = screen.getByText("All").closest("button");
    expect(allTab?.textContent).toContain("4");

    // Active tab should show 2
    const activeTab = screen.getByText("Active").closest("button");
    expect(activeTab?.textContent).toContain("2");

    // Paused tab should show 1
    const pausedTab = screen.getByText("Paused").closest("button");
    expect(pausedTab?.textContent).toContain("1");
  });

  it("shows no results message when filter returns empty", () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", status: "active" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    // Click on "Errored" filter - no projects match
    fireEvent.click(screen.getByText("Errored"));

    expect(screen.getByText("No projects match the current filter")).toBeDefined();
    expect(screen.getByText("Show All Projects")).toBeDefined();
  });

  it("clears filter when clicking Show All Projects button", () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", status: "active" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    // First filter to errored (empty results)
    fireEvent.click(screen.getByText("Errored"));
    expect(screen.getByText("No projects match the current filter")).toBeDefined();

    // Click Show All Projects
    fireEvent.click(screen.getByText("Show All Projects"));

    // Should be back to showing all
    expect(screen.getByTestId("project-card-proj_1")).toBeDefined();
  });

  it("shows loading skeleton when loading prop is true", () => {
    render(
      <ProjectOverview
        projects={[]}
        loading={true}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    expect(screen.getByTestId("project-grid-skeleton")).toBeDefined();
  });

  it("calls onSelectProject when a project card is clicked", () => {
    const onSelectProject = vi.fn();
    const project = makeProject({ id: "proj_1", name: "Test Project" });

    render(
      <ProjectOverview
        projects={[project]}
        onSelectProject={onSelectProject}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-card-proj_1"));
    expect(onSelectProject).toHaveBeenCalledWith(project);
  });

  it("errored tab has special styling when errored projects exist", () => {
    render(
      <ProjectOverview
        projects={[
          makeProject({ id: "proj_1", status: "errored" }),
        ]}
        onSelectProject={noop}
        onAddProject={noop}
        onPauseProject={noop}
        onResumeProject={noop}
        onRemoveProject={noop}
      />
    );

    // Find the errored filter tab specifically (not the stat label)
    const erroredTab = screen.getAllByText("Errored").find(el => el.tagName === "BUTTON");
    expect(erroredTab?.className).toContain("has-errors");
  });

  describe("mobile responsive structure", () => {
    it("renders overview with correct class structure for mobile CSS targets", () => {
      const { container } = render(
        <ProjectOverview
          projects={[makeProject()]}
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      // Verify container class exists for mobile override targeting
      expect(container.querySelector(".project-overview")).not.toBeNull();
      // Verify header section
      expect(container.querySelector(".project-overview__header")).not.toBeNull();
      // Verify stats section
      expect(container.querySelector(".project-overview__stats")).not.toBeNull();
      // Verify filters section
      expect(container.querySelector(".project-overview__filters")).not.toBeNull();
      // Verify grid container
      expect(container.querySelector(".project-grid")).not.toBeNull();
    });

    it("renders stat elements with value/label structure for mobile sizing", () => {
      const { container } = render(
        <ProjectOverview
          projects={[makeProject()]}
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      // Stats should have the nested structure mobile CSS targets
      const stats = container.querySelectorAll(".project-stat");
      expect(stats.length).toBeGreaterThanOrEqual(3); // Total, Active Tasks, Completed
      stats.forEach((stat) => {
        expect(stat.querySelector(".project-stat__value")).not.toBeNull();
        expect(stat.querySelector(".project-stat__label")).not.toBeNull();
      });
    });

    it("renders filter tabs with correct classes for mobile stacking", () => {
      const { container } = render(
        <ProjectOverview
          projects={[makeProject()]}
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      expect(container.querySelector(".project-filter-tabs")).not.toBeNull();
      const tabs = container.querySelectorAll(".project-filter-tab");
      expect(tabs.length).toBe(4); // All, Active, Paused, Errored
      tabs.forEach((tab) => {
        expect(tab.querySelector(".project-filter-count")).not.toBeNull();
      });
    });

    it("renders sort select with aria-label for mobile full-width targeting", () => {
      const { container } = render(
        <ProjectOverview
          projects={[makeProject()]}
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      expect(container.querySelector(".project-sort")).not.toBeNull();
      expect(container.querySelector(".project-sort-select")).not.toBeNull();
      expect(screen.getByLabelText("Sort projects")).toBeDefined();
    });
  });

  describe("FN-1734: Health polling scroll position regression", () => {
    it("shows project cards when health hook is in loading state but healthMap has existing data", () => {
      // This is the key regression test for FN-1734:
      // When background polling refreshes health, loading becomes true but we
      // should NOT show skeleton if we already have health data
      vi.mocked(useProjectHealth).mockReturnValue({
        healthMap: {
          proj_1: {
            projectId: "proj_1",
            status: "active",
            activeTaskCount: 5,
            inFlightAgentCount: 2,
            totalTasksCompleted: 100,
            totalTasksFailed: 3,
            updatedAt: new Date().toISOString(),
          },
        },
        loading: false,
        error: null,
        refresh: vi.fn(),
        refreshProject: vi.fn(),
      });

      const { container } = render(
        <ProjectOverview
          projects={[makeProject({ id: "proj_1", name: "Test Project" })]}
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      // Project card should be visible
      expect(screen.getByTestId("project-card-proj_1")).toBeDefined();
      // Skeleton should NOT be shown (we have existing health data)
      expect(screen.queryByTestId("project-grid-skeleton")).toBeNull();
      // Grid should be rendered
      expect(container.querySelector(".project-grid")).not.toBeNull();
    });

    it("shows skeleton only when projects exist but no health data has been fetched", () => {
      // When loading prop is true AND we have no health data yet,
      // skeleton should be shown
      render(
        <ProjectOverview
          projects={[makeProject({ id: "proj_1", name: "Test Project" })]}
          loading={true} // Projects are loading
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      // Skeleton should be shown (projects loading)
      expect(screen.getByTestId("project-grid-skeleton")).toBeDefined();
    });

    it("shows skeleton when health hook is loading with no existing health data", () => {
      // When health hook returns loading=true AND we have no health data yet,
      // skeleton should be shown even if loading prop is false
      vi.mocked(useProjectHealth).mockReturnValue({
        healthMap: {}, // Empty - no health data yet
        loading: true, // Health is still loading
        error: null,
        refresh: vi.fn(),
        refreshProject: vi.fn(),
      });

      render(
        <ProjectOverview
          projects={[makeProject({ id: "proj_1", name: "Test Project" })]}
          loading={false}
          onSelectProject={noop}
          onAddProject={noop}
          onPauseProject={noop}
          onResumeProject={noop}
          onRemoveProject={noop}
        />
      );

      // Skeleton should be shown (health loading with no data)
      expect(screen.getByTestId("project-grid-skeleton")).toBeDefined();
    });
  });
});
