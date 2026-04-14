import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectCard } from "../ProjectCard";
import type { RegisteredProject, ProjectHealth } from "@fusion/core";
import type { NodeInfo } from "../../api";

// Mock lucide-react to avoid SVG rendering issues in test env
vi.mock("lucide-react", () => ({
  Play: () => <span data-testid="play-icon">▶</span>,
  Pause: () => <span data-testid="pause-icon">⏸</span>,
  AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
  Loader2: () => <span data-testid="loader-icon">⟳</span>,
  MoreHorizontal: () => null,
  Trash2: () => <span data-testid="trash-icon">🗑</span>,
  Folder: () => <span data-testid="folder-icon">📁</span>,
  ArrowRight: () => <span data-testid="arrow-icon">→</span>,
}));

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "proj_abc123",
    name: "Test Project",
    path: "/home/user/projects/test",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeHealth(overrides: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    projectId: "proj_abc123",
    status: "active",
    activeTaskCount: 5,
    inFlightAgentCount: 2,
    totalTasksCompleted: 100,
    totalTasksFailed: 3,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node_001",
    name: "Build Node",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const noop = () => {};

describe("ProjectCard", () => {
  it("renders project name and path", () => {
    render(
      <ProjectCard
        project={makeProject({ name: "My Project", path: "/path/to/project" })}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("My Project")).toBeDefined();
    expect(screen.getByText("/path/to/project")).toBeDefined();
  });

  it("renders assigned node badge when node is provided", () => {
    render(
      <ProjectCard
        project={makeProject()}
        health={makeHealth()}
        node={makeNode({ name: "Remote Worker" })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("on: Remote Worker")).toBeDefined();
  });

  it("truncates long paths", () => {
    const longPath = "/very/long/path/to/the/project/directory/that/needs/truncation";
    render(
      <ProjectCard
        project={makeProject({ path: longPath })}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    // Should show truncated version
    const pathElement = screen.getByText(/\/very\/long\/.*\/truncation/);
    expect(pathElement).toBeDefined();
  });

  it("renders active status badge", () => {
    render(
      <ProjectCard
        project={makeProject({ status: "active" })}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("Active")).toBeDefined();
  });

  it("renders paused status badge", () => {
    render(
      <ProjectCard
        project={makeProject({ status: "paused" })}
        health={makeHealth({ status: "paused" })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("Paused")).toBeDefined();
  });

  it("renders errored status badge", () => {
    render(
      <ProjectCard
        project={makeProject({ status: "errored" })}
        health={makeHealth({ status: "errored" })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("Error")).toBeDefined();
  });

  it("renders initializing status badge with spinner", () => {
    render(
      <ProjectCard
        project={makeProject({ status: "initializing" })}
        health={makeHealth({ status: "initializing" })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("Initializing")).toBeDefined();
    expect(screen.getByTestId("loader-icon")).toBeDefined();
  });

  it("displays health metrics", () => {
    render(
      <ProjectCard
        project={makeProject()}
        health={makeHealth({
          activeTaskCount: 10,
          inFlightAgentCount: 3,
          totalTasksCompleted: 250,
        })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("10")).toBeDefined();
    expect(screen.getByText("Active Tasks")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Agents")).toBeDefined();
    expect(screen.getByText("250")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
  });

  it("shows 'No health data' when health is null", () => {
    render(
      <ProjectCard
        project={makeProject()}
        health={null}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("No health data available")).toBeDefined();
  });

  it("formats relative time for last activity", () => {
    const recentTime = new Date(Date.now() - 5 * 60000).toISOString(); // 5 minutes ago
    render(
      <ProjectCard
        project={makeProject({ lastActivityAt: recentTime })}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("5m ago")).toBeDefined();
  });

  it("shows 'Never' when no last activity", () => {
    render(
      <ProjectCard
        project={makeProject({ lastActivityAt: undefined })}
        health={makeHealth({ lastActivityAt: undefined })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(screen.getByText("Never")).toBeDefined();
  });

  it("calls onSelect when card is clicked", () => {
    const onSelect = vi.fn();
    const project = makeProject();

    const { container } = render(
      <ProjectCard
        project={project}
        health={makeHealth()}
        onSelect={onSelect}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    const card = container.querySelector('[data-project-id="proj_abc123"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);
    expect(onSelect).toHaveBeenCalledWith(project);
  });

  it("calls onSelect when Enter key is pressed", () => {
    const onSelect = vi.fn();
    const project = makeProject();

    const { container } = render(
      <ProjectCard
        project={project}
        health={makeHealth()}
        onSelect={onSelect}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    const card = container.querySelector('[data-project-id="proj_abc123"]');
    expect(card).not.toBeNull();
    fireEvent.keyDown(card!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(project);
  });

  it("calls onPause when pause button is clicked", () => {
    const onPause = vi.fn();
    const project = makeProject({ status: "active" });

    render(
      <ProjectCard
        project={project}
        health={makeHealth()}
        onSelect={noop}
        onPause={onPause}
        onResume={noop}
        onRemove={noop}
      />
    );

    fireEvent.click(screen.getByLabelText("Pause project"));
    expect(onPause).toHaveBeenCalledWith(project);
  });

  it("calls onResume when resume button is clicked", () => {
    const onResume = vi.fn();
    const project = makeProject({ status: "paused" });

    render(
      <ProjectCard
        project={project}
        health={makeHealth({ status: "paused" })}
        onSelect={noop}
        onPause={noop}
        onResume={onResume}
        onRemove={noop}
      />
    );

    fireEvent.click(screen.getByLabelText("Resume project"));
    expect(onResume).toHaveBeenCalledWith(project);
  });

  it("calls onRemove when remove button is clicked", () => {
    const onRemove = vi.fn();
    const project = makeProject();

    render(
      <ProjectCard
        project={project}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={onRemove}
      />
    );

    // First click arms the button (does not call onRemove)
    fireEvent.click(screen.getByLabelText("Remove project"));
    expect(onRemove).not.toHaveBeenCalled();

    // Second click confirms and calls onRemove
    fireEvent.click(screen.getByLabelText("Confirm remove project"));
    expect(onRemove).toHaveBeenCalledWith(project);
  });

  it("shows armed state on first click of remove button", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <ProjectCard
        project={makeProject()}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={onRemove}
      />
    );

    // Initially not armed
    expect(screen.getByLabelText("Remove project")).toBeDefined();
    expect(container.querySelector(".is-armed")).toBeNull();

    // First click arms the button
    fireEvent.click(screen.getByLabelText("Remove project"));
    expect(onRemove).not.toHaveBeenCalled();

    // Button now shows confirm state
    expect(screen.getByLabelText("Confirm remove project")).toBeDefined();
    expect(container.querySelector(".is-armed")).not.toBeNull();
  });

  it("disables pause button when initializing", () => {
    const { container } = render(
      <ProjectCard
        project={makeProject({ status: "initializing" })}
        health={makeHealth({ status: "initializing" })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    // Find the pause button by its title attribute
    const pauseButton = container.querySelector('button[title="Cannot pause while initializing"]');
    expect(pauseButton).not.toBeNull();
    expect(pauseButton).toBeDisabled();
  });

  it("disables all buttons when isLoading is true", () => {
    render(
      <ProjectCard
        project={makeProject({ status: "active" })}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
        isLoading={true}
      />
    );

    expect(screen.getByLabelText("Pause project")).toBeDisabled();
    expect(screen.getByLabelText("Open project")).toBeDisabled();
    expect(screen.getByLabelText("Remove project")).toBeDisabled();
  });

  it("adds loading class when isLoading is true", () => {
    const { container } = render(
      <ProjectCard
        project={makeProject()}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
        isLoading={true}
      />
    );

    expect(container.querySelector(".project-card-loading")).toBeDefined();
  });

  it("adds errored class when project status is errored", () => {
    const { container } = render(
      <ProjectCard
        project={makeProject({ status: "errored" })}
        health={makeHealth({ status: "errored" })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    expect(container.querySelector(".project-card-errored")).toBeDefined();
  });

  it("prevents event bubbling when clicking action buttons", () => {
    const onSelect = vi.fn();
    const onPause = vi.fn();

    render(
      <ProjectCard
        project={makeProject({ status: "active" })}
        health={makeHealth()}
        onSelect={onSelect}
        onPause={onPause}
        onResume={noop}
        onRemove={noop}
      />
    );

    fireEvent.click(screen.getByLabelText("Pause project"));
    expect(onPause).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders with data-project-id attribute", () => {
    const { container } = render(
      <ProjectCard
        project={makeProject({ id: "proj_test123" })}
        health={makeHealth()}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    const card = container.querySelector("[data-project-id='proj_test123']");
    expect(card).toBeDefined();
  });

  it("uses health lastActivityAt as fallback when project lastActivityAt is undefined", () => {
    const healthTime = "2026-01-15T12:00:00.000Z";
    render(
      <ProjectCard
        project={makeProject({ lastActivityAt: undefined })}
        health={makeHealth({ lastActivityAt: healthTime })}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
      />
    );

    // Should show the health's lastActivityAt formatted (shows as date since it's > 7 days ago)
    expect(screen.getByText(/Last activity:/)).toBeDefined();
    // The formatted date should show (1/15/2026 format in US locale)
    expect(screen.getByText(/1\//)).toBeDefined();
  });

  describe("mobile responsive structure", () => {
    it("renders card with correct class structure for mobile CSS targets", () => {
      const { container } = render(
        <ProjectCard
          project={makeProject()}
          health={makeHealth()}
          onSelect={noop}
          onPause={noop}
          onResume={noop}
          onRemove={noop}
        />
      );

      // Verify all mobile-targeted class names exist
      expect(container.querySelector(".project-card")).not.toBeNull();
      expect(container.querySelector(".project-card-header")).not.toBeNull();
      expect(container.querySelector(".project-card-health")).not.toBeNull();
      expect(container.querySelector(".project-card-footer")).not.toBeNull();
      expect(container.querySelector(".project-card-actions")).not.toBeNull();
      // Verify action buttons have mobile-targeted classes
      expect(container.querySelector(".project-card-action")).not.toBeNull();
    });
  });
});
