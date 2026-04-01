import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "../Header";

// Mock matchMedia for mobile/desktop viewport tests
const mockMatchMedia = (matches: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

describe("Header", () => {
  beforeEach(() => {
    // Default to desktop viewport
    mockMatchMedia(false);
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
      mockMatchMedia(true); // Mobile viewport
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

    it("shows terminal in overflow menu and pause controls inline on mobile", () => {
      render(
        <Header
          onToggleTerminal={vi.fn()}
          onToggleEnginePause={vi.fn()}
          onToggleGlobalPause={vi.fn()}
        />
      );
      // Terminal is in overflow menu on mobile, not inline
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Open Terminal")).toBeDefined();
      // Pause/stop are always inline
      expect(screen.getByTitle("Pause scheduling")).toBeDefined();
      expect(screen.getByTitle("Stop AI engine")).toBeDefined();
    });

    it("shows usage button inline when onOpenUsage provided", () => {
      render(<Header onOpenSettings={vi.fn()} onOpenUsage={vi.fn()} />);
      // Usage button is inline on all screens, not in overflow menu
      expect(screen.getByTitle("View usage")).toBeDefined();
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

    it("shows agents button in overflow menu on mobile when onOpenAgents provided", () => {
      render(<Header onOpenSettings={vi.fn()} onOpenAgents={vi.fn()} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Manage Agents")).toBeDefined();
    });

    it("agents overflow menu item calls onOpenAgents when clicked", () => {
      const onOpenAgents = vi.fn();
      render(<Header onOpenSettings={vi.fn()} onOpenAgents={onOpenAgents} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Manage Agents"));
      expect(onOpenAgents).toHaveBeenCalledOnce();
    });
  });

  // ── Agents Button ────────────────────────────────────────────────

  it("renders agents button with correct title on desktop", () => {
    const onOpenAgents = vi.fn();
    render(<Header onOpenAgents={onOpenAgents} />);
    const btn = screen.getByTitle("Manage Agents");
    expect(btn).toBeDefined();
  });

  it("calls onOpenAgents when agents button is clicked", () => {
    const onOpenAgents = vi.fn();
    render(<Header onOpenAgents={onOpenAgents} />);
    const btn = screen.getByTitle("Manage Agents");
    fireEvent.click(btn);
    expect(onOpenAgents).toHaveBeenCalledOnce();
  });

  it("does not render agents button when onOpenAgents is not provided", () => {
    render(<Header />);
    const btn = screen.queryByTitle("Manage Agents");
    expect(btn).toBeNull();
  });

  it("agents button has correct data-testid", () => {
    const onOpenAgents = vi.fn();
    render(<Header onOpenAgents={onOpenAgents} />);
    const btn = screen.getByTestId("agents-btn");
    expect(btn).toBeDefined();
  });
});
