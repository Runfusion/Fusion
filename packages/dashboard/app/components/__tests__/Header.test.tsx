import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "../Header";

// Mock matchMedia for mobile/tablet/desktop viewport tests
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

describe("Header", () => {
  beforeEach(() => {
    // Default to desktop viewport
    mockMatchMedia("desktop");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("renders a logo image with correct src and alt", () => {
    render(<Header />);
    const logo = screen.getByAltText("Fusion logo");
    expect(logo).toBeDefined();
    expect(logo.tagName).toBe("IMG");
    expect((logo as HTMLImageElement).src).toContain("/logo.svg");
  });

  it("renders the logo before the h1 element", () => {
    render(<Header />);
    const logo = screen.getByAltText("Fusion logo");
    const h1 = screen.getByRole("heading", { level: 1 });
    // Logo should be a preceding sibling of the h1
    expect(logo.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the settings button", () => {
    const onOpen = vi.fn();
    render(<Header onOpenSettings={onOpen} />);
    const btn = screen.getByTitle("Settings");
    expect(btn).toBeDefined();
  });

  it("renders the import button", () => {
    const onOpen = vi.fn();
    render(<Header onOpenGitHubImport={onOpen} />);
    const btn = screen.getByTitle("Import from GitHub");
    expect(btn).toBeDefined();
  });

  it("renders the missions button when mission management is available", () => {
    const onOpen = vi.fn();
    render(<Header onOpenMissions={onOpen} />);
    expect(screen.getByTestId("missions-btn")).toBeDefined();
  });

  it("does not render the missions button when mission management is unavailable", () => {
    render(<Header />);
    expect(screen.queryByTestId("missions-btn")).toBeNull();
  });

  it("calls onOpenGitHubImport when import button is clicked", () => {
    const onOpen = vi.fn();
    render(<Header onOpenGitHubImport={onOpen} />);
    const btn = screen.getByTitle("Import from GitHub");
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  // ── Pause button (soft pause) ────────────────────────────────────

  it("renders pause button with 'Pause scheduling' title when not paused", () => {
    render(<Header enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect(btn).toBeDefined();
  });

  it("renders play button with 'Resume scheduling' title when engine is paused", () => {
    render(<Header enginePaused={true} />);
    const btn = screen.getByTitle("Resume scheduling");
    expect(btn).toBeDefined();
  });

  it("calls onToggleEnginePause when pause button is clicked", () => {
    const onToggle = vi.fn();
    render(<Header enginePaused={false} onToggleEnginePause={onToggle} />);
    const btn = screen.getByTitle("Pause scheduling");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("applies btn-icon--paused class when engine is paused", () => {
    render(<Header enginePaused={true} />);
    const btn = screen.getByTitle("Resume scheduling");
    expect(btn.className).toContain("btn-icon--paused");
  });

  it("does not apply btn-icon--paused class when engine is not paused", () => {
    render(<Header enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect(btn.className).not.toContain("btn-icon--paused");
  });

  it("pause button is disabled when globalPaused is true", () => {
    render(<Header globalPaused={true} enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("pause button is enabled when globalPaused is false", () => {
    render(<Header globalPaused={false} enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  // ── Stop button (hard stop) ──────────────────────────────────────

  it("renders stop button with 'Stop AI engine' title when not stopped", () => {
    render(<Header globalPaused={false} />);
    const btn = screen.getByTitle("Stop AI engine");
    expect(btn).toBeDefined();
  });

  it("renders play button with 'Start AI engine' title when stopped", () => {
    render(<Header globalPaused={true} />);
    const btn = screen.getByTitle("Start AI engine");
    expect(btn).toBeDefined();
  });

  it("calls onToggleGlobalPause when stop button is clicked", () => {
    const onToggle = vi.fn();
    render(<Header globalPaused={false} onToggleGlobalPause={onToggle} />);
    const btn = screen.getByTitle("Stop AI engine");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("applies btn-icon--stopped class when globally paused", () => {
    render(<Header globalPaused={true} />);
    const btn = screen.getByTitle("Start AI engine");
    expect(btn.className).toContain("btn-icon--stopped");
  });

  it("does not apply btn-icon--stopped class when not globally paused", () => {
    render(<Header globalPaused={false} />);
    const btn = screen.getByTitle("Stop AI engine");
    expect(btn.className).not.toContain("btn-icon--stopped");
  });

  it("stop button shows Play icon when globalPaused is true", () => {
    render(<Header globalPaused={true} />);
    const btn = screen.getByTitle("Start AI engine");
    // The Play icon from lucide-react renders an SVG
    const svg = btn.querySelector("svg");
    expect(svg).toBeDefined();
  });

  // ── View Toggle ────────────────────────────────────────────────────

  it("renders view toggle when onChangeView is provided", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    const listBtn = screen.getByTitle("List view");
    expect(boardBtn).toBeDefined();
    expect(listBtn).toBeDefined();
  });

  it("does not render view toggle when onChangeView is not provided", () => {
    render(<Header />);
    const boardBtn = screen.queryByTitle("Board view");
    const listBtn = screen.queryByTitle("List view");
    expect(boardBtn).toBeNull();
    expect(listBtn).toBeNull();
  });

  it("calls onChangeView with 'board' when board view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="list" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    fireEvent.click(boardBtn);
    expect(onChangeView).toHaveBeenCalledWith("board");
  });

  it("calls onChangeView with 'list' when list view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const listBtn = screen.getByTitle("List view");
    fireEvent.click(listBtn);
    expect(onChangeView).toHaveBeenCalledWith("list");
  });

  it("marks board view button as active when view is 'board'", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    expect(boardBtn.className).toContain("active");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks list view button as active when view is 'list'", () => {
    const onChangeView = vi.fn();
    render(<Header view="list" onChangeView={onChangeView} />);
    const listBtn = screen.getByTitle("List view");
    expect(listBtn.className).toContain("active");
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not mark board view button as active when view is 'list'", () => {
    const onChangeView = vi.fn();
    render(<Header view="list" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    expect(boardBtn.className).not.toContain("active");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("false");
  });

  // ── Agents View Toggle ──────────────────────────────────────────

  it("renders agents view button in view toggle when onChangeView is provided", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const agentsBtn = screen.getByTitle("Agents view");
    expect(agentsBtn).toBeDefined();
  });

  it("calls onChangeView with 'agents' when agents view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const agentsBtn = screen.getByTitle("Agents view");
    fireEvent.click(agentsBtn);
    expect(onChangeView).toHaveBeenCalledWith("agents");
  });

  it("marks agents view button as active when view is 'agents'", () => {
    const onChangeView = vi.fn();
    render(<Header view="agents" onChangeView={onChangeView} />);
    const agentsBtn = screen.getByTitle("Agents view");
    expect(agentsBtn.className).toContain("active");
    expect(agentsBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not mark agents view button as active when view is 'board'", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const agentsBtn = screen.getByTitle("Agents view");
    expect(agentsBtn.className).not.toContain("active");
    expect(agentsBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not mark board view button as active when view is 'agents'", () => {
    const onChangeView = vi.fn();
    render(<Header view="agents" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    expect(boardBtn.className).not.toContain("active");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("false");
  });

  // ── Search Visibility by View ─────────────────────────────────────

  it("shows search input when view is 'board'", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
  });

  it("hides search input when view is 'list'", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="list"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("hides search input when view is 'agents'", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="agents"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  // ── Terminal Button ─────────────────────────────────────────────

  it("renders terminal button with correct title", () => {
    const onToggle = vi.fn();
    render(<Header onToggleTerminal={onToggle} />);
    const btn = screen.getByTitle("Open Terminal");
    expect(btn).toBeDefined();
  });

  it("calls onToggleTerminal when terminal button is clicked", () => {
    const onToggle = vi.fn();
    render(<Header onToggleTerminal={onToggle} />);
    const btn = screen.getByTitle("Open Terminal");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("is enabled", () => {
    render(<Header onToggleTerminal={vi.fn()} />);
    const btn = screen.getByTitle("Open Terminal");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  // ── Mobile Viewport Behavior ─────────────────────────────────────

  describe("mobile viewport", () => {
    beforeEach(() => {
      mockMatchMedia("mobile"); // Mobile viewport
    });

    it("renders mobile search trigger instead of inline search on mobile", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
        />
      );
      // Should show the trigger button, not the inline search
      expect(screen.getByTitle("Open search")).toBeDefined();
      // The expanded search should not be visible initially
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("mobile search trigger has stable accessible name", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
        />
      );
      const trigger = screen.getByLabelText("Open search");
      expect(trigger).toBeDefined();
    });

    it("mobile search trigger exposes aria-expanded state", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
        />
      );
      const trigger = screen.getByLabelText("Open search");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("expands mobile search when trigger is clicked", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
        />
      );
      const trigger = screen.getByTitle("Open search");
      fireEvent.click(trigger);
      // Search input should now be visible
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("mobile search stays expanded when searchQuery is non-empty", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery="active query"
          onSearchChange={onSearchChange}
        />
      );
      // Even without clicking, search should be visible due to active query
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.getByDisplayValue("active query")).toBeDefined();
    });

    it("closes mobile search and clears query when close button clicked", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery="test query"
          onSearchChange={onSearchChange}
        />
      );
      // Close the search
      const closeBtn = screen.getByLabelText("Close search");
      fireEvent.click(closeBtn);
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("renders mobile overflow menu trigger on mobile", () => {
      render(<Header onOpenSettings={vi.fn()} />);
      const overflowBtn = screen.getByTitle("More header actions");
      expect(overflowBtn).toBeDefined();
    });

    it("overflow trigger has correct ARIA attributes", () => {
      render(<Header onOpenSettings={vi.fn()} />);
      const overflowBtn = screen.getByLabelText("More header actions");
      expect(overflowBtn.getAttribute("aria-haspopup")).toBe("menu");
      expect(overflowBtn.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens overflow menu when trigger is clicked", () => {
      render(<Header onOpenSettings={vi.fn()} onOpenPlanning={vi.fn()} />);
      const overflowBtn = screen.getByTitle("More header actions");
      fireEvent.click(overflowBtn);
      // Menu items should be visible
      expect(screen.getByRole("menu")).toBeDefined();
      expect(screen.getByText("Settings")).toBeDefined();
      expect(screen.getByText("Create a task with AI planning")).toBeDefined();
    });

    it("overflow menu items dispatch correct callbacks", () => {
      const onOpenSettings = vi.fn();
      const onOpenPlanning = vi.fn();
      const onOpenGitHubImport = vi.fn();
      render(
        <Header
          onOpenSettings={onOpenSettings}
          onOpenPlanning={onOpenPlanning}
          onOpenGitHubImport={onOpenGitHubImport}
        />
      );
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Settings"));
      expect(onOpenSettings).toHaveBeenCalled();

      // Re-open menu and test planning button
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Create a task with AI planning"));
      expect(onOpenPlanning).toHaveBeenCalled();
    });

    it("closes overflow menu after selecting an action", () => {
      const onOpenSettings = vi.fn();
      render(<Header onOpenSettings={onOpenSettings} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Settings"));
      // Menu should be closed
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("closes overflow menu on outside click", () => {
      render(<Header onOpenSettings={vi.fn()} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByRole("menu")).toBeDefined();
      // Click outside (on header)
      fireEvent.mouseDown(document.body);
      // Menu should be closed
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("closes overflow menu on Escape key", () => {
      render(<Header onOpenSettings={vi.fn()} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByRole("menu")).toBeDefined();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("hides desktop-only actions on mobile", () => {
      render(
        <Header
          onOpenSettings={vi.fn()}
          onOpenGitHubImport={vi.fn()}
          onOpenPlanning={vi.fn()}
        />
      );
      // These buttons should not be directly visible (they're in overflow menu)
      expect(screen.queryByTitle("Import from GitHub")).toBeNull();
      expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
      expect(screen.queryByTitle("Settings")).toBeNull();
    });

    it("shows view toggle inline on mobile", () => {
      render(<Header view="board" onChangeView={vi.fn()} />);
      // View toggle should still be visible inline
      expect(screen.getByTitle("Board view")).toBeDefined();
      expect(screen.getByTitle("List view")).toBeDefined();
    });

    it("shows terminal group in overflow menu and pause controls inline on mobile", () => {
      render(
        <Header
          onToggleTerminal={vi.fn()}
          onToggleEnginePause={vi.fn()}
          onToggleGlobalPause={vi.fn()}
        />
      );
      // Terminal is in overflow menu on mobile, not inline
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-terminal-group-trigger")).toBeDefined();
      // Expand submenu to see Open Terminal
      fireEvent.click(screen.getByTestId("overflow-terminal-group-trigger"));
      expect(screen.getByTestId("overflow-terminal-btn")).toBeDefined();
      // Pause/stop are always inline
      expect(screen.getByTitle("Pause scheduling")).toBeDefined();
      expect(screen.getByTitle("Stop AI engine")).toBeDefined();
    });

    it("shows usage button in overflow menu when onOpenUsage provided", () => {
      render(<Header onOpenSettings={vi.fn()} onOpenUsage={vi.fn()} />);
      // Usage button is in overflow menu on mobile, not inline
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-usage-btn")).toBeDefined();
    });

    it("mobile search input dispatches onSearchChange when typing", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
        />
      );
      fireEvent.click(screen.getByTitle("Open search"));
      const input = screen.getByPlaceholderText("Search tasks...");
      fireEvent.change(input, { target: { value: "test" } });
      expect(onSearchChange).toHaveBeenCalledWith("test");
    });

    it("does not render project selector trigger on mobile", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
          onViewAllProjects={vi.fn()}
        />
      );
      expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
    });

    it("does not render back-to-projects button on mobile", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onViewAllProjects={vi.fn()}
        />
      );
      expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
    });

    it("shows switch project item in overflow menu on mobile when multiple projects", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
          onViewAllProjects={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTitle("More header actions"));
      const btn = screen.getByTestId("overflow-project-selector-btn");
      expect(btn).toBeDefined();
      // Should show the current project name
      expect(btn.textContent).toContain("Project One");
    });

    it("overflow project selector calls onViewAllProjects when clicked", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      const onViewAllProjects = vi.fn();
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
          onViewAllProjects={onViewAllProjects}
          onOpenSettings={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-project-selector-btn"));
      expect(onViewAllProjects).toHaveBeenCalledOnce();
    });

    it("uses distinct icons for project switch and browse files in overflow menu", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
          onViewAllProjects={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenFiles={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTitle("More header actions"));
      const projectBtn = screen.getByTestId("overflow-project-selector-btn");
      const filesBtn = screen.getByTestId("overflow-files-btn");
      // The project-switch button should use Building2, not Folder
      // Building2 SVG contains a <path> with "M3 21V3h9l1 1h8v17H3Z" or similar building shape
      // Folder SVG contains a <path> with "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" (folder shape)
      // Both render SVGs; verify they use different SVG content (different icons)
      const projectSvg = projectBtn.querySelector("svg");
      const filesSvg = filesBtn.querySelector("svg");
      expect(projectSvg).not.toBeNull();
      expect(filesSvg).not.toBeNull();
      // The two icons should render different SVG paths (not the same icon)
      expect(projectSvg!.innerHTML).not.toBe(filesSvg!.innerHTML);
    });

    it("does not show switch project in overflow menu with single project", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onViewAllProjects={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-project-selector-btn")).toBeNull();
    });

    it("missions overflow menu item calls onOpenMissions when clicked", () => {
      const onOpenMissions = vi.fn();
      render(<Header onOpenSettings={vi.fn()} onOpenMissions={onOpenMissions} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Missions"));
      expect(onOpenMissions).toHaveBeenCalledOnce();
    });

    it("workflow steps overflow menu item calls onOpenWorkflowSteps when clicked", () => {
      const onOpenWorkflowSteps = vi.fn();
      render(<Header onOpenSettings={vi.fn()} onOpenWorkflowSteps={onOpenWorkflowSteps} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Workflow Steps"));
      expect(onOpenWorkflowSteps).toHaveBeenCalledOnce();
    });

    it("scripts overflow menu item calls onOpenScripts when clicked", () => {
      const onOpenScripts = vi.fn();
      render(<Header onOpenSettings={vi.fn()} onOpenScripts={onOpenScripts} onRunScript={vi.fn()} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      // Open the terminal submenu first
      fireEvent.click(screen.getByTestId("overflow-terminal-group-trigger"));
      fireEvent.click(screen.getByTestId("overflow-scripts-btn"));
      expect(onOpenScripts).toHaveBeenCalledOnce();
    });
  });

  // ── Multi-Project Selector ────────────────────────────────────

  it("shows ProjectSelector when 2+ projects provided", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(<Header projects={projects} />);
    expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
  });

  it("renders ProjectSelector within header-left when multiple projects exist", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const { container } = render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={vi.fn()}
        onViewAllProjects={vi.fn()}
      />
    );
    // ProjectSelector should be inside header-left, not a sibling
    const headerLeft = container.querySelector(".header-left");
    expect(headerLeft).not.toBeNull();
    const selectorInLeft = headerLeft!.querySelector(".header-project-selector");
    expect(selectorInLeft).not.toBeNull();
    expect(selectorInLeft!.querySelector("[data-testid='project-selector-trigger']")).not.toBeNull();
  });

  it("does not show ProjectSelector with single project", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const { container } = render(<Header projects={projects} />);
    expect(container.querySelector(".project-selector")).toBeNull();
  });

  it("does not show ProjectSelector when no projects", () => {
    const { container } = render(<Header projects={[]} />);
    expect(container.querySelector(".project-selector")).toBeNull();
  });

  it("shows 'Back to All Projects' button when currentProject is set", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onViewAllProjects={vi.fn()}
      />
    );
    expect(screen.getByTestId("back-to-projects-btn")).toBeDefined();
  });

  it("calls onViewAllProjects when 'Back to All Projects' clicked", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const onViewAllProjects = vi.fn();
    render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onViewAllProjects={onViewAllProjects}
      />
    );
    fireEvent.click(screen.getByTestId("back-to-projects-btn"));
    expect(onViewAllProjects).toHaveBeenCalled();
  });

  it("does not show 'Back to All Projects' when no currentProject", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(<Header projects={projects} currentProject={null} />);
    expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
  });

  it("calls onSelectProject when project selected from selector", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const onSelectProject = vi.fn();
    render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={onSelectProject}
        onViewAllProjects={vi.fn()}
      />
    );

    // Open selector
    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    // Click on a project in the dropdown
    fireEvent.click(screen.getByText("Project Two"));
    expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
  });

  it("shows current project name in selector trigger", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={vi.fn()}
        onViewAllProjects={vi.fn()}
      />
    );

    expect(screen.getByText("Project One")).toBeDefined();
  });

  // ── Modal Overlay Visibility ──────────────────────────────────

  it("MissionManager renders with 'open' class on modal overlay when isOpen is true", async () => {
    // Mock fetch for MissionManager's API calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    try {
      const { MissionManager } = await import("../MissionManager");
      const { container } = render(
        <MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />
      );
      const overlay = container.querySelector(".mission-manager-overlay");
      expect(overlay).not.toBeNull();
      expect(overlay!.className).toContain("open");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
