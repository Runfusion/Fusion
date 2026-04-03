import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "../components/Header";

/**
 * Tablet header controls test suite.
 *
 * Verifies that the tablet viewport tier (769px–1024px) renders the
 * header with engine controls inline while moving lower-priority actions
 * into the overflow menu.
 */

type ViewportTier = "mobile" | "tablet" | "desktop";

const mockMatchMedia = (tier: ViewportTier) => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      let matches = false;
      if (tier === "mobile" && query.includes("max-width: 768px")) {
        matches = true;
      } else if (tier === "tablet" && query.includes("769px") && query.includes("1024px")) {
        matches = true;
      }
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
};

const noop = () => {};

function renderTabletHeader(props = {}) {
  mockMatchMedia("tablet");
  return render(
    <Header
      onOpenSettings={noop}
      onOpenGitHubImport={noop}
      globalPaused={false}
      enginePaused={false}
      onToggleGlobalPause={noop}
      onToggleEnginePause={noop}
      {...props}
    />
  );
}

function renderDesktopHeader(props = {}) {
  mockMatchMedia("desktop");
  return render(
    <Header
      onOpenSettings={noop}
      onOpenGitHubImport={noop}
      globalPaused={false}
      enginePaused={false}
      onToggleGlobalPause={noop}
      onToggleEnginePause={noop}
      {...props}
    />
  );
}

describe("tablet header controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Engine controls stay inline on tablet ──────────────────────

  it("renders pause scheduling button inline on tablet", () => {
    renderTabletHeader();
    expect(screen.getByTitle("Pause scheduling")).toBeDefined();
  });

  it("renders stop AI engine button inline on tablet", () => {
    renderTabletHeader();
    expect(screen.getByTitle("Stop AI engine")).toBeDefined();
  });

  it("renders view toggle inline on tablet", () => {
    renderTabletHeader({ onChangeView: noop });
    expect(screen.getByTitle("Board view")).toBeDefined();
    expect(screen.getByTitle("List view")).toBeDefined();
    expect(screen.getByTitle("Agents view")).toBeDefined();
  });

  // ── Lower-priority actions move to overflow on tablet ──────────

  it("does not render settings inline on tablet", () => {
    renderTabletHeader();
    // Settings should be in overflow, not inline
    expect(screen.queryByTitle("Settings")).toBeNull();
  });

  it("does not render import from GitHub inline on tablet", () => {
    renderTabletHeader();
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
  });

  it("does not render planning button inline on tablet", () => {
    renderTabletHeader({ onOpenPlanning: noop });
    expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
  });

  it("does not render terminal button inline on tablet", () => {
    renderTabletHeader({ onToggleTerminal: noop });
    expect(screen.queryByTitle("Open Terminal")).toBeNull();
  });

  it("does not render schedules button inline on tablet", () => {
    renderTabletHeader({ onOpenSchedules: noop });
    expect(screen.queryByTitle("Scheduled tasks")).toBeNull();
  });

  it("does not render usage button inline on tablet", () => {
    renderTabletHeader({ onOpenUsage: noop });
    expect(screen.queryByTitle("View usage")).toBeNull();
  });

  it("does not render activity log button inline on tablet", () => {
    renderTabletHeader({ onOpenActivityLog: noop });
    expect(screen.queryByTitle("View Activity Log")).toBeNull();
  });

  it("does not render files button inline on tablet", () => {
    renderTabletHeader({ onOpenFiles: noop });
    expect(screen.queryByTitle("Browse files")).toBeNull();
  });

  it("does not render git manager button inline on tablet", () => {
    renderTabletHeader({ onOpenGitManager: noop });
    expect(screen.queryByTitle("Git Manager")).toBeNull();
  });

  it("does not render workflow steps button inline on tablet", () => {
    renderTabletHeader({ onOpenWorkflowSteps: noop });
    expect(screen.queryByTitle("Workflow Steps")).toBeNull();
  });

  it("does not render missions button inline on tablet", () => {
    renderTabletHeader({ onOpenMissions: noop });
    expect(screen.queryByTitle("Mission Manager")).toBeNull();
  });

  // ── Overflow menu on tablet ────────────────────────────────────

  it("renders overflow menu trigger on tablet", () => {
    renderTabletHeader();
    expect(screen.getByTitle("More header actions")).toBeDefined();
  });

  it("overflow menu contains settings on tablet", () => {
    renderTabletHeader();
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByText("Settings")).toBeDefined();
  });

  it("overflow menu contains planning on tablet", () => {
    renderTabletHeader({ onOpenPlanning: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-planning-btn")).toBeDefined();
  });

  it("overflow menu contains GitHub import on tablet", () => {
    renderTabletHeader();
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByText("Import from GitHub")).toBeDefined();
  });

  it("overflow menu contains terminal on tablet", () => {
    renderTabletHeader({ onToggleTerminal: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-terminal-btn")).toBeDefined();
  });

  it("overflow menu contains scheduled tasks on tablet", () => {
    renderTabletHeader({ onOpenSchedules: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByText("Scheduled Tasks")).toBeDefined();
  });

  it("overflow menu contains usage on tablet when provided", () => {
    renderTabletHeader({ onOpenUsage: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-usage-btn")).toBeDefined();
  });

  it("overflow menu contains activity log on tablet when provided", () => {
    renderTabletHeader({ onOpenActivityLog: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-activity-log-btn")).toBeDefined();
  });

  it("overflow menu contains files on tablet when provided", () => {
    renderTabletHeader({ onOpenFiles: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-files-btn")).toBeDefined();
  });

  it("overflow menu contains git manager on tablet when provided", () => {
    renderTabletHeader({ onOpenGitManager: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-git-btn")).toBeDefined();
  });

  it("overflow menu contains workflow steps on tablet when provided", () => {
    renderTabletHeader({ onOpenWorkflowSteps: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-workflow-steps-btn")).toBeDefined();
  });

  it("overflow menu contains missions on tablet when provided", () => {
    renderTabletHeader({ onOpenMissions: noop });
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByTestId("overflow-missions-btn")).toBeDefined();
  });

  // ── Overflow menu callbacks work on tablet ─────────────────────

  it("calls onOpenSettings from overflow menu on tablet", () => {
    const onOpenSettings = vi.fn();
    renderTabletHeader({ onOpenSettings });
    fireEvent.click(screen.getByTitle("More header actions"));
    fireEvent.click(screen.getByText("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("calls onToggleTerminal from overflow menu on tablet", () => {
    const onToggleTerminal = vi.fn();
    renderTabletHeader({ onToggleTerminal });
    fireEvent.click(screen.getByTitle("More header actions"));
    fireEvent.click(screen.getByTestId("overflow-terminal-btn"));
    expect(onToggleTerminal).toHaveBeenCalled();
  });

  it("calls onOpenPlanning from overflow menu on tablet", () => {
    const onOpenPlanning = vi.fn();
    renderTabletHeader({ onOpenPlanning });
    fireEvent.click(screen.getByTitle("More header actions"));
    fireEvent.click(screen.getByTestId("overflow-planning-btn"));
    expect(onOpenPlanning).toHaveBeenCalled();
  });

  it("calls onOpenUsage from overflow menu on tablet", () => {
    const onOpenUsage = vi.fn();
    renderTabletHeader({ onOpenUsage });
    fireEvent.click(screen.getByTitle("More header actions"));
    fireEvent.click(screen.getByTestId("overflow-usage-btn"));
    expect(onOpenUsage).toHaveBeenCalled();
  });

  it("closes overflow menu after selecting an action on tablet", () => {
    renderTabletHeader();
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.click(screen.getByText("Settings"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes overflow menu on outside click on tablet", () => {
    renderTabletHeader();
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes overflow menu on Escape key on tablet", () => {
    renderTabletHeader();
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // ── Search on tablet ───────────────────────────────────────────

  it("renders desktop-style search input on tablet (not mobile search trigger)", () => {
    renderTabletHeader({ onSearchChange: noop, view: "board" });
    // Tablet uses the desktop-style inline search, not the mobile trigger
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    expect(screen.queryByTitle("Open search")).toBeNull();
  });

  it("does not render search when view is not board on tablet", () => {
    renderTabletHeader({ onSearchChange: noop, view: "list" });
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  // ── Project selector hidden on tablet ──────────────────────────

  it("does not render project selector on tablet", () => {
    const projects = [
      { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
    ];
    renderTabletHeader({
      projects,
      currentProject: projects[0],
      onSelectProject: noop,
      onViewAllProjects: noop,
    });
    expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
  });

  it("does not render back-to-projects button on tablet", () => {
    renderTabletHeader({
      currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      onViewAllProjects: noop,
    });
    expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
  });

  it("shows switch project in overflow menu when multiple projects on tablet", () => {
    const projects = [
      { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
    ];
    const onViewAllProjects = vi.fn();
    renderTabletHeader({
      projects,
      currentProject: projects[0],
      onViewAllProjects,
    });
    fireEvent.click(screen.getByTitle("More header actions"));
    const btn = screen.getByTestId("overflow-project-selector-btn");
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain("Project One");
  });

  // ── Desktop still shows everything inline ──────────────────────

  describe("desktop regression (contrasted with tablet)", () => {
    it("renders settings inline on desktop", () => {
      renderDesktopHeader();
      expect(screen.getByTitle("Settings")).toBeDefined();
    });

    it("renders import from GitHub inline on desktop", () => {
      renderDesktopHeader();
      expect(screen.getByTitle("Import from GitHub")).toBeDefined();
    });

    it("renders terminal inline on desktop", () => {
      renderDesktopHeader({ onToggleTerminal: noop });
      expect(screen.getByTitle("Open Terminal")).toBeDefined();
    });

    it("does not render overflow menu trigger on desktop", () => {
      renderDesktopHeader();
      expect(screen.queryByTitle("More header actions")).toBeNull();
    });

    it("renders project selector on desktop with multiple projects", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderDesktopHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: noop,
        onViewAllProjects: noop,
      });
      expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
    });
  });
});
