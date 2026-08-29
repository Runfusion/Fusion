import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Header } from "../components/Header";

// Mock fetchScripts for overflow submenu
const mockFetchScripts = vi.fn();

vi.mock("../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

/**
 * Tablet header controls test suite.
 *
 * Verifies that the tablet viewport tier (769px–1024px) renders the
 * header without the retired engine controls while moving lower-priority
 * actions into the overflow menu.
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
      {...props}
    />
  );
}

describe("tablet header controls", () => {
  beforeEach(() => {
    mockFetchScripts.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Engine controls moved out of the header ──────────────────────

  it("does not render engine control split-button inline on tablet", () => {
    renderTabletHeader();
    expect(screen.queryByTestId("engine-control-main-btn")).toBeNull();
    expect(screen.queryByTestId("engine-control-chevron-btn")).toBeNull();
    expect(screen.queryByTestId("engine-control-pause-triage-btn")).toBeNull();
  });

  it("renders view toggle inline on tablet", () => {
    renderTabletHeader({ onChangeView: noop, showAgentsTab: true });
    expect(screen.getByTitle("Board view")).toBeDefined();
    expect(screen.getByTitle("List view")).toBeDefined();
    expect(screen.getByTitle("Agents view")).toBeDefined();
    expect(screen.getByTestId("view-toggle-command-center")).toBeDefined();
    expect(screen.queryByTitle("Artifacts view")).toBeNull();
    // Skills and Insights are NOT inline (they're in overflow)
    expect(screen.queryByTitle("Skills view")).toBeNull();
    expect(screen.queryByTitle("Roadmaps view")).toBeNull();
    expect(screen.queryByTitle("Insights view")).toBeNull();
  });

  it("places tablet Command Center inline immediately after Agents and Artifacts only in overflow", () => {
    renderTabletHeader({ onChangeView: noop, showAgentsTab: true });

    expect(screen.getByTestId("view-toggle-command-center").previousElementSibling).toBe(screen.getByTitle("Agents view"));
    expect(screen.queryByTitle("Artifacts view")).toBeNull();

    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    expect(screen.getByTestId("view-overflow-documents")).toHaveTextContent("Artifacts view");
    expect(screen.queryByTestId("view-overflow-command-center")).toBeNull();
  });

  it("keeps desktop Artifacts and Command Center inline without Command Center overflow", () => {
    renderDesktopHeader({ onChangeView: noop, showAgentsTab: true });

    expect(screen.getByTitle("Artifacts view")).toBeDefined();
    expect(screen.getByTestId("view-toggle-command-center")).toBeDefined();
    expect(screen.getByTestId("view-toggle-command-center").previousElementSibling).toBe(screen.getByTitle("Agents view"));

    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    expect(screen.queryByTestId("view-overflow-command-center")).toBeNull();
    expect(screen.queryByTestId("view-overflow-documents")).toBeNull();
  });

  it("renders view toggle overflow trigger on tablet when overflow items are available", () => {
    renderTabletHeader({ onChangeView: noop, experimentalFeatures: { insights: true } });
    expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
  });

  it("opens overflow menu with Insights and Skills on tablet when trigger is clicked", () => {
    renderTabletHeader({ onChangeView: noop, showSkillsTab: true, experimentalFeatures: { insights: true } });
    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    expect(screen.getByTestId("view-overflow-insights")).toBeDefined();
    expect(screen.getByTestId("view-overflow-skills")).toBeDefined();
  });

  it("calls onChangeView from overflow menu on tablet", () => {
    const onChangeView = vi.fn();
    renderTabletHeader({ onChangeView, experimentalFeatures: { insights: true } });
    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    fireEvent.click(screen.getByTestId("view-overflow-insights"));
    expect(onChangeView).toHaveBeenCalledWith("insights");
  });

  it("closes overflow menu on tablet after selecting an item", async () => {
    renderTabletHeader({ onChangeView: noop, showSkillsTab: true, experimentalFeatures: { insights: true } });
    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    expect(screen.getByTestId("view-overflow-insights")).toBeDefined();
    fireEvent.click(screen.getByTestId("view-overflow-skills"));
    await waitFor(() => {
      expect(screen.queryByTestId("view-overflow-insights")).toBeNull();
    });
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
    renderTabletHeader();
    expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
  });

  it("does not render terminal button inline on tablet", () => {
    renderTabletHeader({ onToggleTerminal: noop });
    expect(screen.queryByTitle("Open Terminal")).toBeNull();
  });

  it("does not render automation button inline on tablet", () => {
    renderTabletHeader({ onOpenSchedules: noop });
    expect(screen.queryByTitle("Automation")).toBeNull();
  });

  it("renders the header usage button to the left of the right-dock toggle on tablet", () => {
    const onOpenUsage = vi.fn();
    renderTabletHeader({ onOpenUsage, rightDockAvailable: true, onToggleRightDock: noop });

    const usageBtn = screen.getByTestId("header-usage-btn");
    expect(usageBtn.getAttribute("title")).toBe("View usage");
    // Sits immediately to the left of the right-dock toggle.
    expect(usageBtn.nextElementSibling).toBe(screen.getByTestId("header-right-dock-toggle"));

    const mockRect = { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    (usageBtn as HTMLButtonElement).getBoundingClientRect = vi.fn(() => mockRect);
    fireEvent.click(usageBtn);
    expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
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

  it("does not render workflows button inline on tablet", () => {
    renderTabletHeader({ onOpenWorkflowEditor: noop });
    expect(screen.queryByTitle("Workflows")).toBeNull();
  });

  // ── Right-sidebar toggle replaces the three-dots overflow on tablet ─────
  //
  // FNXC:Navigation 2026-06-22-01:44:
  // The tablet three-dots compact overflow menu was retired: the mobile-only
  // overflow trigger gate (isMobile && !hideFullNav) means tablet no longer
  // renders "More header actions" or any header overflow menu. Instead, the
  // non-mobile right-sidebar show/hide toggle (header-right-dock-toggle) owns
  // that header slot. Tablet tool actions live in the right dock, not the header.

  it("does not render the three-dots overflow trigger on tablet", () => {
    renderTabletHeader();
    expect(screen.queryByTitle("More header actions")).toBeNull();
    expect(document.querySelector(".compact-overflow-trigger")).toBeNull();
  });

  it("renders the right-sidebar toggle on tablet when the dock is available", () => {
    renderTabletHeader({ rightDockAvailable: true, onToggleRightDock: noop });
    expect(screen.getByTestId("header-right-dock-toggle")).toBeDefined();
    expect(screen.queryByTitle("More header actions")).toBeNull();
  });

  it("toggles the right sidebar from the tablet header toggle", () => {
    const onToggleRightDock = vi.fn();
    renderTabletHeader({ rightDockAvailable: true, onToggleRightDock });
    fireEvent.click(screen.getByTestId("header-right-dock-toggle"));
    expect(onToggleRightDock).toHaveBeenCalledTimes(1);
  });

  it("reflects the right-sidebar open state on the tablet toggle", () => {
    renderTabletHeader({ rightDockAvailable: true, rightDockOpen: true, onToggleRightDock: noop });
    const toggle = screen.getByTestId("header-right-dock-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("title")).toBe("Hide right sidebar");
  });

  it("does not render the right-sidebar toggle on tablet when the dock is unavailable", () => {
    renderTabletHeader({ onToggleRightDock: noop });
    expect(screen.queryByTestId("header-right-dock-toggle")).toBeNull();
  });

  it("does not render planning affordances in the tablet header", () => {
    renderTabletHeader();
    expect(screen.queryByTestId("overflow-planning-btn")).toBeNull();
    expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
  });

  it("does not render GitHub import inline or in any overflow on tablet", () => {
    renderTabletHeader();
    expect(screen.queryByText("Import from GitHub")).toBeNull();
  });

  it("does not render terminal launcher and scripts affordances on tablet", () => {
    renderTabletHeader({ onToggleTerminal: noop, onOpenScripts: noop });
    expect(screen.queryByTestId("overflow-terminal-primary-btn")).toBeNull();
    expect(screen.queryByTestId("overflow-terminal-submenu-toggle")).toBeNull();
    expect(screen.queryByTestId("overflow-scripts-manage")).toBeNull();
  });

  it("does not render automation, usage, activity log, files, git, or workflow header items on tablet", () => {
    renderTabletHeader({
      onOpenSchedules: noop,
      onOpenUsage: noop,
      onOpenActivityLog: noop,
      onOpenFiles: noop,
      onOpenGitManager: noop,
      onOpenWorkflowEditor: noop,
    });
    expect(screen.queryByText("Automation")).toBeNull();
    expect(screen.queryByTestId("overflow-usage-btn")).toBeNull();
    expect(screen.queryByTestId("overflow-activity-log-btn")).toBeNull();
    expect(screen.queryByTestId("overflow-files-btn")).toBeNull();
    expect(screen.queryByTestId("overflow-git-btn")).toBeNull();
    expect(screen.queryByTestId("overflow-workflow-steps-btn")).toBeNull();
  });

  // ── Search on tablet ───────────────────────────────────────────

  it("renders search toggle button on tablet board view (not mobile search trigger)", () => {
    renderTabletHeader({ onSearchChange: noop, view: "board" });
    // Tablet uses the desktop-style toggle, not the mobile trigger
    expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("renders search toggle button on tablet list view", () => {
    renderTabletHeader({ onSearchChange: noop, view: "list" });
    // List view now also supports search on tablet
    expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("opens search input when toggle is clicked on tablet board view", () => {
    renderTabletHeader({ onSearchChange: noop, view: "board" });
    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
  });

  it("opens search input when toggle is clicked on tablet list view", () => {
    renderTabletHeader({ onSearchChange: noop, view: "list" });
    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
  });

  it("closes search and clears query when close button is clicked on tablet", () => {
    const onSearchChange = vi.fn();
    renderTabletHeader({ onSearchChange, view: "board" });
    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Close search"));
    expect(onSearchChange).toHaveBeenCalledWith("");
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("keeps search open when searchQuery is non-empty on tablet", () => {
    renderTabletHeader({ onSearchChange: noop, view: "board", searchQuery: "test" });
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  it("does not render search toggle when view is agents on tablet", () => {
    renderTabletHeader({ onSearchChange: noop, view: "agents" });
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("does not render search toggle when view is missions on tablet", () => {
    renderTabletHeader({ onSearchChange: noop, view: "missions" });
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  // ── Tablet project-switch affordances ──────────────────────────

  it("renders project selector on tablet with multiple projects", () => {
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
    expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
  });

  it("does not render back to projects button on tablet", () => {
    renderTabletHeader({
      projects: [{ id: "1", name: "Project One", path: "/path/one", status: "active" as const }],
      currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      onViewAllProjects: noop,
    });
    expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
  });

  it("does not show a projects overflow entry on tablet (no header overflow exists)", () => {
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
    expect(screen.queryByTitle("More header actions")).toBeNull();
    expect(screen.queryByTestId("overflow-project-selector-btn")).toBeNull();
  });

  it("does not render mobile project switch trigger on tablet", () => {
    const projects = [
      { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
    ];
    renderTabletHeader({
      projects,
      currentProject: projects[0],
      onSelectProject: vi.fn(),
      onViewAllProjects: noop,
    });
    expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
  });

  // ── Desktop keeps primary controls inline while tool actions move to the right dock ──────────────────────

  describe("desktop regression (contrasted with tablet)", () => {
    it("renders settings inline on desktop", () => {
      renderDesktopHeader();
      expect(screen.getByTitle("Settings")).toBeDefined();
    });

    it("does not render import from GitHub inline on desktop", () => {
      renderDesktopHeader();
      expect(screen.queryByTitle("Import from GitHub")).toBeNull();
    });

    it("does not render terminal inline on desktop", () => {
      renderDesktopHeader({ onToggleTerminal: noop });
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
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

  // ── Terminal launcher relocation regression tests ─────────────

  describe("terminal launcher relocation on tablet", () => {
    it("keeps terminal launcher affordances out of the tablet header (no overflow exists)", () => {
      renderTabletHeader({ onToggleTerminal: noop, onOpenScripts: noop, projectId: "test-project" });
      expect(screen.queryByTitle("More header actions")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-primary-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-submenu-toggle")).toBeNull();
      expect(screen.queryByTestId("overflow-script-item-build")).toBeNull();
      expect(screen.queryByTestId("overflow-scripts-manage")).toBeNull();
    });
  });

  // ── No header overflow menu remains on tablet ──────────────────
  //
  // FNXC:Navigation 2026-06-22-01:44:
  // The Settings-last overflow ordering invariant no longer applies on tablet
  // because the three-dots overflow menu is mobile-only. Tablet renders no
  // .mobile-overflow-menu and no menu role; Settings lives in the right dock.

  describe("no overflow menu on tablet", () => {
    it("renders no header overflow menu on tablet even when all optional items are provided", () => {
      const { container } = renderTabletHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowEditor: noop,
        onOpenFiles: noop,
        onOpenGitManager: noop,
      });

      expect(container.querySelector(".mobile-overflow-menu")).toBeNull();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.queryByTitle("More header actions")).toBeNull();
    });

    it("renders no header overflow menu on tablet when optional items are absent", () => {
      const { container } = renderTabletHeader();
      expect(container.querySelector(".mobile-overflow-menu")).toBeNull();
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });
});
