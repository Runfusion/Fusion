import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Header } from "../Header";

// Mock fetchScripts for overflow submenu
const mockFetchScripts = vi.fn();

vi.mock("../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

// Mock usePluginUiSlots hook
const mockUsePluginUiSlots = vi.fn(() => ({
  slots: [],
  getSlotsForId: vi.fn(() => []),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (...args: unknown[]) => mockUsePluginUiSlots(...args),
}));

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
    mockFetchScripts.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("renders a theme-driven logo element (inline SVG) with aria-label", () => {
    render(<Header />);
    // The logo is now an inline SVG with aria-label instead of img with alt
    const logo = screen.getByLabelText("Fusion logo");
    expect(logo).toBeDefined();
    expect(logo.tagName.toLowerCase()).toBe("svg");

    // The SVG should expose currentColor-driven geometry for theme-aware coloring
    const currentColorShapes = logo.querySelectorAll(
      '[fill="currentColor"], [stroke="currentColor"]'
    );
    expect(currentColorShapes.length).toBeGreaterThan(0);

    // The new logo keeps a single outer circle boundary
    const outerCircle = logo.querySelector("circle[stroke='currentColor']");
    expect(outerCircle).not.toBeNull();
  });

  it("renders the logo before the h1 element", () => {
    render(<Header />);
    const logo = screen.getByLabelText("Fusion logo");
    const h1 = screen.getByRole("heading", { level: 1 });
    // Logo should be a preceding sibling of the h1
    expect(logo.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders logo and wordmark inside a .header-brand container", () => {
    const { container } = render(<Header />);
    const brand = container.querySelector(".header-brand");
    expect(brand).not.toBeNull();
    // Brand container should contain the logo SVG
    const logo = brand!.querySelector("[aria-label='Fusion logo']");
    expect(logo).not.toBeNull();
    // Brand container should contain the heading
    const h1 = brand!.querySelector("h1.logo");
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe("Fusion");
    // Logo should appear before the heading within the brand container
    expect(logo!.compareDocumentPosition(h1!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    render(<Header view="board" onChangeView={onChangeView} showAgentsTab={true} />);
    const agentsBtn = screen.getByTitle("Agents view");
    expect(agentsBtn).toBeDefined();
  });

  it("calls onChangeView with 'agents' when agents view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} showAgentsTab={true} />);
    const agentsBtn = screen.getByTitle("Agents view");
    fireEvent.click(agentsBtn);
    expect(onChangeView).toHaveBeenCalledWith("agents");
  });

  it("marks agents view button as active when view is 'agents'", () => {
    const onChangeView = vi.fn();
    render(<Header view="agents" onChangeView={onChangeView} showAgentsTab={true} />);
    const agentsBtn = screen.getByTitle("Agents view");
    expect(agentsBtn.className).toContain("active");
    expect(agentsBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not mark agents view button as active when view is 'board'", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} showAgentsTab={true} />);
    const agentsBtn = screen.getByTitle("Agents view");
    expect(agentsBtn.className).not.toContain("active");
    expect(agentsBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not mark board view button as active when view is 'agents'", () => {
    const onChangeView = vi.fn();
    render(<Header view="agents" onChangeView={onChangeView} showAgentsTab={true} />);
    const boardBtn = screen.getByTitle("Board view");
    expect(boardBtn.className).not.toContain("active");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("hides agents view button when showAgentsTab is false", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} showAgentsTab={false} />);
    expect(screen.queryByTitle("Agents view")).toBeNull();
  });

  it("hides agents view button when showAgentsTab is not provided", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    expect(screen.queryByTitle("Agents view")).toBeNull();
  });

  it("shows agents view button when showAgentsTab is true", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} showAgentsTab={true} />);
    expect(screen.getByTitle("Agents view")).toBeDefined();
  });

  // ── Missions View Toggle ────────────────────────────────────────

  it("renders missions view button in view toggle when onChangeView is provided", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const missionsBtn = screen.getByTitle("Missions view");
    expect(missionsBtn).toBeDefined();
  });

  it("calls onChangeView with 'missions' when missions view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const missionsBtn = screen.getByTitle("Missions view");
    fireEvent.click(missionsBtn);
    expect(onChangeView).toHaveBeenCalledWith("missions");
  });

  it("marks missions view button as active when view is 'missions'", () => {
    const onChangeView = vi.fn();
    render(<Header view="missions" onChangeView={onChangeView} />);
    const missionsBtn = screen.getByTitle("Missions view");
    expect(missionsBtn.className).toContain("active");
    expect(missionsBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not mark missions view button as active when view is 'board'", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const missionsBtn = screen.getByTitle("Missions view");
    expect(missionsBtn.className).not.toContain("active");
    expect(missionsBtn.getAttribute("aria-pressed")).toBe("false");
  });

  // ── View Toggle Overflow ─────────────────────────────────────────

  describe("View Toggle Overflow", () => {
    it("renders overflow trigger button when onChangeView is provided", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} />);
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("does not render overflow trigger when onChangeView is not provided", () => {
      render(<Header view="board" />);
      expect(screen.queryByTestId("view-toggle-overflow-trigger")).toBeNull();
    });

    it("opens overflow menu when trigger is clicked", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab experimentalFeatures={{ insights: true, roadmap: true }} />);
      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      fireEvent.click(trigger);
      expect(screen.getByTestId("view-overflow-insights")).toBeDefined();
      expect(screen.getByTestId("view-overflow-roadmaps")).toBeDefined();
      expect(screen.getByTestId("view-overflow-skills")).toBeDefined();
    });

    it("closes overflow menu when trigger is clicked again", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab experimentalFeatures={{ insights: true, roadmap: true }} />);
      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      fireEvent.click(trigger);
      expect(screen.getByTestId("view-overflow-insights")).toBeDefined();
      fireEvent.click(trigger);
      expect(screen.queryByTestId("view-overflow-insights")).toBeNull();
    });

    it("calls onChangeView with 'insights' when Insights overflow item is clicked", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} experimentalFeatures={{ insights: true }} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-insights"));
      expect(onChangeView).toHaveBeenCalledWith("insights");
    });

    it("calls onChangeView with 'roadmaps' when Roadmaps overflow item is clicked", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} experimentalFeatures={{ roadmap: true }} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-roadmaps"));
      expect(onChangeView).toHaveBeenCalledWith("roadmaps");
    });

    it("calls onChangeView with 'skills' when Skills overflow item is clicked", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-skills"));
      expect(onChangeView).toHaveBeenCalledWith("skills");
    });

    it("shows overflow trigger as active when view is 'insights'", () => {
      const onChangeView = vi.fn();
      render(<Header view="insights" onChangeView={onChangeView} experimentalFeatures={{ insights: true }} />);
      expect(screen.getByTestId("view-toggle-overflow-trigger").className).toContain("active");
    });

    it("shows overflow trigger as active when view is 'roadmaps'", () => {
      const onChangeView = vi.fn();
      render(<Header view="roadmaps" onChangeView={onChangeView} experimentalFeatures={{ roadmap: true }} />);
      expect(screen.getByTestId("view-toggle-overflow-trigger").className).toContain("active");
    });

    it("shows overflow trigger as active when view is 'skills'", () => {
      const onChangeView = vi.fn();
      render(<Header view="skills" onChangeView={onChangeView} showSkillsTab />);
      expect(screen.getByTestId("view-toggle-overflow-trigger").className).toContain("active");
    });

    it("overflow trigger is not active when view is 'board'", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} />);
      expect(screen.getByTestId("view-toggle-overflow-trigger").className).not.toContain("active");
    });

    it("overflow trigger is not active when view is 'list'", () => {
      const onChangeView = vi.fn();
      render(<Header view="list" onChangeView={onChangeView} />);
      expect(screen.getByTestId("view-toggle-overflow-trigger").className).not.toContain("active");
    });

    it("closes overflow menu on Escape key", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab experimentalFeatures={{ insights: true }} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.getByTestId("view-overflow-insights")).toBeDefined();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("view-overflow-insights")).toBeNull();
    });

    it("closes overflow menu on outside click", async () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab experimentalFeatures={{ insights: true }} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.getByTestId("view-overflow-insights")).toBeDefined();
      // Simulate click outside
      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByTestId("view-overflow-insights")).toBeNull();
      });
    });

    it("does not render skills, roadmaps, insights as inline toggle buttons", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab experimentalFeatures={{ insights: true, roadmap: true }} />);
      expect(screen.queryByTitle("Skills view")).toBeNull();
      expect(screen.queryByTitle("Roadmaps view")).toBeNull();
      expect(screen.queryByTitle("Insights view")).toBeNull();
    });

    it("does not render Insights overflow item when experimentalFeatures.insights is false", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} experimentalFeatures={{ insights: false }} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-insights")).toBeNull();
    });

    it("does not render Roadmaps overflow item when experimentalFeatures.roadmap is false", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} experimentalFeatures={{ roadmap: false }} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-roadmaps")).toBeNull();
    });

    it("does not render Skills overflow item when showSkillsTab is false", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} showSkillsTab={false} />);
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-skills")).toBeNull();
    });
  });

  // ── Search Visibility by View ─────────────────────────────────────

  it("shows search toggle when view is 'board' on desktop", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    // Toggle button is visible, search input is hidden by default
    expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("shows search toggle when view is 'list' on desktop", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="list"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    // Toggle button is visible on list view
    expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
  });

  it("opens search input when toggle is clicked on board view", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
  });

  it("opens search input when toggle is clicked on list view", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="list"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
  });

  it("keeps search open when searchQuery is non-empty (board view)", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        searchQuery="test query"
        onSearchChange={onSearchChange}
      />
    );
    // Search visible, toggle hidden
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  it("keeps search open when searchQuery is non-empty (list view)", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="list"
        onChangeView={vi.fn()}
        searchQuery="test query"
        onSearchChange={onSearchChange}
      />
    );
    // Search visible, toggle hidden
    expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  it("closes search and clears query when close button is clicked", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        searchQuery="test query"
        onSearchChange={onSearchChange}
      />
    );
    fireEvent.click(screen.getByLabelText("Close search"));
    expect(onSearchChange).toHaveBeenCalledWith("");
    // Search should close (in real app, parent would update searchQuery prop)
    // In test without state update, search remains visible with cleared input
    // The toggle does not reappear until searchQuery prop becomes empty
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  it("hides search input and toggle when view is 'agents'", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="agents"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
        showAgentsTab={true}
      />
    );
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  it("hides search input and toggle when view is 'missions'", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="missions"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  it("hides search input and toggle when view is 'skills'", () => {
    const onSearchChange = vi.fn();
    render(
      <Header
        view="skills"
        onChangeView={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
      />
    );
    expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
  });

  // ── Mailbox Button ────────────────────────────────────────────

  it("renders mailbox button with correct title", () => {
    const onOpenMailbox = vi.fn();
    render(<Header onOpenMailbox={onOpenMailbox} />);
    const btn = screen.getByTestId("header-mailbox-btn");
    expect(btn).toBeDefined();
  });

  it("calls onOpenMailbox when mailbox button is clicked", () => {
    const onOpenMailbox = vi.fn();
    render(<Header onOpenMailbox={onOpenMailbox} />);
    const btn = screen.getByTestId("header-mailbox-btn");
    fireEvent.click(btn);
    expect(onOpenMailbox).toHaveBeenCalledOnce();
  });

  it("shows unread badge when mailboxUnreadCount > 0", () => {
    render(<Header mailboxUnreadCount={5} onOpenMailbox={vi.fn()} />);
    const badge = screen.getByTestId("header-mailbox-badge");
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe("5");
  });

  it("shows 9+ when unread count exceeds 9", () => {
    render(<Header mailboxUnreadCount={15} onOpenMailbox={vi.fn()} />);
    const badge = screen.getByTestId("header-mailbox-badge");
    expect(badge.textContent).toBe("9+");
  });

  it("does not show badge when unread count is 0", () => {
    render(<Header mailboxUnreadCount={0} onOpenMailbox={vi.fn()} />);
    const badge = screen.queryByTestId("header-mailbox-badge");
    expect(badge).toBeNull();
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

    it("focuses mobile search input when expanded", async () => {
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
      const input = screen.getByPlaceholderText("Search tasks...") as HTMLInputElement;

      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    });

    it("renders expanded mobile search container with expected class", () => {
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
      const expandedContainer = input.closest(".mobile-search-expanded");

      expect(expandedContainer).not.toBeNull();
      expect(expandedContainer?.className).toContain("mobile-search-expanded");
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

    it("renders overflow planning badge inside icon wrapper when sessions are active", () => {
      const onResumePlanning = vi.fn();
      render(
        <Header
          onOpenPlanning={vi.fn()}
          onResumePlanning={onResumePlanning}
          activePlanningSessionCount={3}
        />
      );

      fireEvent.click(screen.getByTitle("More header actions"));

      const planningButton = screen.getByTestId("overflow-planning-btn");
      const iconWrapper = planningButton.querySelector(".mobile-overflow-icon-wrapper");
      expect(iconWrapper).toBeTruthy();

      const badge = screen.getByTestId("overflow-planning-badge");
      expect(iconWrapper?.contains(badge)).toBe(true);
      expect(planningButton.textContent).toContain("Resume planning session (3)");

      fireEvent.click(planningButton);
      expect(onResumePlanning).toHaveBeenCalledOnce();
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

    it("hides desktop view toggle when mobileNavEnabled is true (mobile view toggle shown separately)", () => {
      // When mobileNavEnabled, the full desktop-style view toggle (with agents, missions, etc.)
      // should be hidden. Instead, a compact board/list-only toggle appears via mobile-view-toggle.
      render(<Header view="board" onChangeView={vi.fn()} mobileNavEnabled={true} showAgentsTab={true} />);
      // The full desktop toggle is hidden
      expect(screen.queryByTitle("Agents view")).toBeNull();
      expect(screen.queryByTitle("Missions view")).toBeNull();
      // But the mobile compact toggle is shown
      expect(screen.getByTestId("mobile-view-toggle")).toBeDefined();
    });

    it("renders mobile view toggle when mobileNavEnabled and view is board", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} mobileNavEnabled={true} />);
      expect(screen.getByTestId("mobile-view-toggle")).toBeDefined();
      expect(screen.getByTestId("mobile-view-toggle-board")).toBeDefined();
      expect(screen.getByTestId("mobile-view-toggle-list")).toBeDefined();
    });

    it("renders mobile view toggle when mobileNavEnabled and view is list", () => {
      render(<Header view="list" onChangeView={vi.fn()} mobileNavEnabled={true} />);
      expect(screen.getByTestId("mobile-view-toggle")).toBeDefined();
      expect(screen.getByTestId("mobile-view-toggle-board")).toBeDefined();
      expect(screen.getByTestId("mobile-view-toggle-list")).toBeDefined();
    });

    it("does not render mobile view toggle when mobileNavEnabled and view is agents", () => {
      render(<Header view="agents" onChangeView={vi.fn()} mobileNavEnabled={true} />);
      expect(screen.queryByTestId("mobile-view-toggle")).toBeNull();
    });

    it("does not render mobile view toggle when mobileNavEnabled and view is missions", () => {
      render(<Header view="missions" onChangeView={vi.fn()} mobileNavEnabled={true} />);
      expect(screen.queryByTestId("mobile-view-toggle")).toBeNull();
    });

    it("mobile view toggle board button calls onChangeView('board')", () => {
      const onChangeView = vi.fn();
      render(<Header view="list" onChangeView={onChangeView} mobileNavEnabled={true} />);
      fireEvent.click(screen.getByTestId("mobile-view-toggle-board"));
      expect(onChangeView).toHaveBeenCalledWith("board");
    });

    it("mobile view toggle list button calls onChangeView('list')", () => {
      const onChangeView = vi.fn();
      render(<Header view="board" onChangeView={onChangeView} mobileNavEnabled={true} />);
      fireEvent.click(screen.getByTestId("mobile-view-toggle-list"));
      expect(onChangeView).toHaveBeenCalledWith("list");
    });

    it("mobile view toggle board button is active when view is board", () => {
      render(<Header view="board" onChangeView={vi.fn()} mobileNavEnabled={true} />);
      const boardBtn = screen.getByTestId("mobile-view-toggle-board");
      const listBtn = screen.getByTestId("mobile-view-toggle-list");
      expect(boardBtn.className).toContain("active");
      expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
      expect(listBtn.className).not.toContain("active");
      expect(listBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("mobile view toggle list button is active when view is list", () => {
      render(<Header view="list" onChangeView={vi.fn()} mobileNavEnabled={true} />);
      const boardBtn = screen.getByTestId("mobile-view-toggle-board");
      const listBtn = screen.getByTestId("mobile-view-toggle-list");
      expect(listBtn.className).toContain("active");
      expect(listBtn.getAttribute("aria-pressed")).toBe("true");
      expect(boardBtn.className).not.toContain("active");
      expect(boardBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("hides overflow trigger when mobileNavEnabled is true", () => {
      render(<Header onOpenSettings={vi.fn()} mobileNavEnabled={true} />);
      expect(screen.queryByTitle("More header actions")).toBeNull();
    });

    it("keeps engine controls visible when mobileNavEnabled is true", () => {
      render(
        <Header
          mobileNavEnabled={true}
          onToggleEnginePause={vi.fn()}
          onToggleGlobalPause={vi.fn()}
        />
      );

      expect(screen.getByTitle("Pause scheduling")).toBeDefined();
      expect(screen.getByTitle("Stop AI engine")).toBeDefined();
    });

    it("keeps overflow trigger visible on tablet when mobileNavEnabled is true", () => {
      mockMatchMedia("tablet");
      render(<Header onOpenSettings={vi.fn()} mobileNavEnabled={true} />);
      expect(screen.getByTitle("More header actions")).toBeDefined();
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
      expect(screen.getByTestId("overflow-terminal-primary-btn")).toBeDefined();
      expect(screen.getByTestId("overflow-terminal-submenu-toggle")).toBeDefined();
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

    it("does not render split project button on mobile", () => {
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
      // On mobile/tablet, back button is hidden (shown in overflow menu instead)
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
      expect(btn.textContent).toContain("Projects");
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

    it("shows projects in overflow menu with single project", () => {
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
      expect(screen.queryByTestId("overflow-project-selector-btn")).not.toBeNull();
    });

    it("workflow steps overflow menu item calls onOpenWorkflowSteps when clicked", () => {
      const onOpenWorkflowSteps = vi.fn();
      render(<Header onOpenSettings={vi.fn()} onOpenWorkflowSteps={onOpenWorkflowSteps} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByText("Workflow Steps"));
      expect(onOpenWorkflowSteps).toHaveBeenCalledOnce();
    });

    it("scripts overflow menu item calls onOpenScripts when clicked", async () => {
      const onOpenScripts = vi.fn();
      render(<Header onOpenSettings={vi.fn()} onOpenScripts={onOpenScripts} onRunScript={vi.fn()} />);
      fireEvent.click(screen.getByTitle("More header actions"));
      // Open the terminal submenu first
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-scripts-manage")).toBeDefined();
      });
      fireEvent.click(screen.getByTestId("overflow-scripts-manage"));
      expect(onOpenScripts).toHaveBeenCalledOnce();
    });

    // ── Mobile Search with mobileNavEnabled ───────────────────────

    it("renders mobile search input when searchQuery is active with mobileNavEnabled", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery="test query"
          onSearchChange={onSearchChange}
          mobileNavEnabled={true}
        />
      );
      // Search should be visible even with mobileNavEnabled when query is active
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.getByDisplayValue("test query")).toBeDefined();
    });

    it("can open mobile search when mobileNavEnabled is true", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
          mobileNavEnabled={true}
        />
      );
      // Should show the trigger button
      expect(screen.getByTestId("mobile-header-search-btn")).toBeDefined();
      // Expanded search should not be visible initially
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("closes mobile search and clears query when close button clicked with mobileNavEnabled", () => {
      const onSearchChange = vi.fn();
      render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          searchQuery="test query"
          onSearchChange={onSearchChange}
          mobileNavEnabled={true}
        />
      );
      const closeBtn = screen.getByLabelText("Close search");
      fireEvent.click(closeBtn);
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    // ── Mobile Project Switch (logo-adjacent) ─────────────────────

    it("renders mobile project switch trigger when 2+ projects and onSelectProject provided", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
    });

    it("does not render mobile project switch trigger with single project", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    });

    it("does not render mobile project switch trigger when onSelectProject is not provided", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
        />
      );
      expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    });

    it("mobile project switch trigger opens dropdown when clicked", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      const trigger = screen.getByTestId("mobile-project-switch-trigger");
      fireEvent.click(trigger);
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();
    });

    it("mobile project switch dropdown shows all projects", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-item-proj_1")).toBeDefined();
      expect(screen.getByTestId("mobile-project-switch-item-proj_2")).toBeDefined();
    });

    it("mobile project switch calls onSelectProject when project is selected", () => {
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
        />
      );
      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      fireEvent.click(screen.getByTestId("mobile-project-switch-item-proj_2"));
      expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
    });

    it("mobile project switch dropdown closes after selection", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();
      fireEvent.click(screen.getByTestId("mobile-project-switch-item-proj_2"));
      expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
    });

    it("mobile project switch closes on outside click", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
    });

    it("mobile project switch closes on Escape key", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
    });

    it("mobile project switch shows current project as selected", () => {
      const projects = [
        { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
        { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      ];
      render(
        <Header
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      const currentItem = screen.getByTestId("mobile-project-switch-item-proj_1");
      expect(currentItem.getAttribute("aria-selected")).toBe("true");
      const otherItem = screen.getByTestId("mobile-project-switch-item-proj_2");
      expect(otherItem.getAttribute("aria-selected")).toBe("false");
    });
  });

  // ── Project Selector ────────────────────────────────────

  it("shows back to projects button when currentProject is set", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(<Header projects={projects} currentProject={projects[0]} onViewAllProjects={vi.fn()} />);
    expect(screen.getByTestId("back-to-projects-btn")).toBeDefined();
  });

  it("does not show back button when no currentProject", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(<Header projects={projects} currentProject={null} onViewAllProjects={vi.fn()} />);
    expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
  });

  it("renders project selector within header-left when projects exist", () => {
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
    // ProjectSelector should be inside header-left
    const headerLeft = container.querySelector(".header-left");
    expect(headerLeft).not.toBeNull();
    const projectSelector = headerLeft!.querySelector(".project-selector");
    expect(projectSelector).not.toBeNull();
    expect(projectSelector!.querySelector("[data-testid='back-to-projects-btn']")).not.toBeNull();
  });

  it("does not show project selector when no projects", () => {
    const { container } = render(<Header projects={[]} />);
    expect(container.querySelector(".project-selector")).toBeNull();
  });

  it("does not show project selector without onViewAllProjects", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const { container } = render(<Header projects={projects} />);
    expect(container.querySelector(".project-selector")).toBeNull();
  });

  it("shows project dropdown arrow only when 2+ projects", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(<Header projects={projects} currentProject={projects[0]} onViewAllProjects={vi.fn()} />);
    expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
  });

  it("does not show project dropdown arrow with single project", () => {
    const projects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    render(<Header projects={projects} currentProject={projects[0]} onViewAllProjects={vi.fn()} />);
    expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
  });

  it("back button calls onViewAllProjects when clicked", () => {
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

  it("calls onSelectProject when project selected from dropdown", () => {
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

    // Open dropdown
    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    // Click on a project in the dropdown
    fireEvent.click(screen.getByText("Project Two"));
    expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
  });

  it("shows 'Back to All Projects' text in back button", () => {
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

    // Back button should show "Back to All Projects"
    const backBtn = screen.getByTestId("back-to-projects-btn");
    expect(backBtn.textContent).toContain("Back to All Projects");
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

  describe("PluginSlot integration", () => {
    it("renders PluginSlot for header-action slot", () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [{ pluginId: "test-plugin", slot: { slotId: "header-action", label: "Test Action", componentPath: "./test.js" } }],
        getSlotsForId: (id: string) => id === "header-action" ? [{ pluginId: "test-plugin", slot: { slotId: "header-action", label: "Test Action", componentPath: "./test.js" } }] : [],
        loading: false,
        error: null,
      });
      const { container } = render(<Header />);
      const slot = container.querySelector('[data-slot-id="header-action"]');
      expect(slot).not.toBeNull();
      expect(slot).toHaveAttribute("data-plugin-id", "test-plugin");
    });

    it("renders nothing when no plugins register for header-action slot", () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [],
        getSlotsForId: vi.fn(() => []),
        loading: false,
        error: null,
      });
      const { container } = render(<Header />);
      const slot = container.querySelector('[data-slot-id="header-action"]');
      expect(slot).toBeNull();
    });
  });

  describe("Nodes button visibility", () => {
    describe("desktop viewport", () => {
      it("shows nodes button in desktop overflow by default when onOpenNodes is provided without showNodesButton", () => {
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={vi.fn()} />);
        expect(screen.getByTestId("desktop-overflow-trigger")).toBeDefined();
        fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
        expect(screen.getByTestId("desktop-overflow-nodes-btn")).toBeDefined();
      });

      it("shows nodes button in desktop overflow when showNodesButton is true and onOpenNodes is provided", () => {
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={vi.fn()} showNodesButton={true} />);
        expect(screen.getByTestId("desktop-overflow-trigger")).toBeDefined();
        fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
        expect(screen.getByTestId("desktop-overflow-nodes-btn")).toBeDefined();
      });

      it("hides nodes button from desktop overflow when showNodesButton is false", () => {
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={vi.fn()} showNodesButton={false} />);
        expect(screen.getByTestId("desktop-overflow-trigger")).toBeDefined();
        fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
        expect(screen.queryByTestId("desktop-overflow-nodes-btn")).toBeNull();
      });

      it("calls onOpenNodes when nodes button is clicked from desktop overflow", () => {
        const onOpenNodes = vi.fn();
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={onOpenNodes} />);
        fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
        fireEvent.click(screen.getByTestId("desktop-overflow-nodes-btn"));
        expect(onOpenNodes).toHaveBeenCalledOnce();
      });
    });

    describe("mobile viewport", () => {
      beforeEach(() => {
        mockMatchMedia("mobile");
      });

      it("hides mobile overflow nodes button when showNodesButton is false", () => {
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={vi.fn()} showNodesButton={false} />);
        // Open the overflow menu to check mobile overflow items
        fireEvent.click(screen.getByTitle("More header actions"));
        expect(screen.queryByTestId("overflow-nodes-btn")).toBeNull();
      });

      it("shows mobile overflow nodes button by default when onOpenNodes is provided", () => {
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={vi.fn()} />);
        // Open the overflow menu to check mobile overflow items
        fireEvent.click(screen.getByTitle("More header actions"));
        expect(screen.getByTestId("overflow-nodes-btn")).toBeDefined();
      });

      it("shows mobile overflow nodes button when showNodesButton is true", () => {
        render(<Header onOpenSettings={vi.fn()} onOpenNodes={vi.fn()} showNodesButton={true} />);
        // Open the overflow menu to check mobile overflow items
        fireEvent.click(screen.getByTitle("More header actions"));
        expect(screen.getByTestId("overflow-nodes-btn")).toBeDefined();
      });
    });
  });
});
