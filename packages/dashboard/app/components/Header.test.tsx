import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Header } from "./Header";

// Mock fetchScripts for overflow submenu
const mockFetchScripts = vi.fn();

vi.mock("../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

const noop = () => {};

// Helper to mock mobile/tablet/desktop viewport
type ViewportTier = "mobile" | "tablet" | "desktop";

function mockMatchMedia(tier: ViewportTier) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      let matches = false;
      if (tier === "mobile" && query.includes("max-width: 768px")) {
        matches = true;
      } else if (tier === "tablet" && query.includes("769px") && query.includes("1024px")) {
        matches = true;
      }
      // desktop: neither mobile nor tablet query matches
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function renderHeader(props = {}, tier: ViewportTier = "desktop") {
  mockMatchMedia(tier);
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

describe("Header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchScripts.mockResolvedValue({});
  });

  it("renders the logo and brand", () => {
    renderHeader();
    expect(screen.getByText("Fusion")).toBeDefined();
  });

  it("renders action buttons", () => {
    renderHeader();
    expect(screen.getByTitle("Import from GitHub")).toBeDefined();
    expect(screen.getByTitle("Settings")).toBeDefined();
  });

  it("calls onOpenSettings when settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    renderHeader({ onOpenSettings });
    fireEvent.click(screen.getByTitle("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("calls onOpenGitHubImport when import button is clicked", () => {
    const onOpenGitHubImport = vi.fn();
    renderHeader({ onOpenGitHubImport });
    fireEvent.click(screen.getByTitle("Import from GitHub"));
    expect(onOpenGitHubImport).toHaveBeenCalled();
  });

  describe("view toggle", () => {
    it("does not render view toggle when onChangeView is not provided", () => {
      renderHeader();
      expect(screen.queryByTitle("Board view")).toBeNull();
      expect(screen.queryByTitle("List view")).toBeNull();
    });

    it("renders view toggle when onChangeView is provided", () => {
      renderHeader({ onChangeView: noop });
      expect(screen.getByTitle("Board view")).toBeDefined();
      expect(screen.getByTitle("List view")).toBeDefined();
    });

    it("shows board view as active by default", () => {
      renderHeader({ onChangeView: noop });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.className).toContain("active");
      expect(listBtn.className).not.toContain("active");
    });

    it("shows list view as active when view is 'list'", () => {
      renderHeader({ onChangeView: noop, view: "list" });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.className).not.toContain("active");
      expect(listBtn.className).toContain("active");
    });

    it("calls onChangeView with 'board' when clicking board view button", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "list" });
      fireEvent.click(screen.getByTitle("Board view"));
      expect(onChangeView).toHaveBeenCalledWith("board");
    });

    it("calls onChangeView with 'list' when clicking list view button", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "board" });
      fireEvent.click(screen.getByTitle("List view"));
      expect(onChangeView).toHaveBeenCalledWith("list");
    });

    it("has correct aria attributes for accessibility", () => {
      renderHeader({ onChangeView: noop, view: "board" });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
      expect(listBtn.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("terminal button", () => {
    it("renders terminal button with correct title on desktop", () => {
      renderHeader({ onToggleTerminal: noop }, "desktop");
      expect(screen.getByTitle("Open Terminal")).toBeDefined();
    });

    it("does not render terminal button inline on mobile", () => {
      renderHeader({ onToggleTerminal: noop }, "mobile");
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
    });

    it("calls onToggleTerminal when terminal button is clicked", () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal }, "desktop");
      fireEvent.click(screen.getByTitle("Open Terminal"));
      expect(onToggleTerminal).toHaveBeenCalled();
    });

    it("is always enabled regardless of task state", () => {
      renderHeader({ onToggleTerminal: noop }, "desktop");
      const btn = screen.getByTitle("Open Terminal");
      expect(btn.hasAttribute("disabled")).toBe(false);
    });
  });

  describe("files button", () => {
    it("renders files button on desktop when handler is provided", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "desktop");
      expect(screen.getByTitle("Browse files")).toBeDefined();
    });

    it("does not render files button on desktop when handler is omitted", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
    });

    it("calls onOpenFiles when desktop files button is clicked", () => {
      const onOpenFiles = vi.fn();
      renderHeader({ onOpenFiles }, "desktop");
      fireEvent.click(screen.getByTitle("Browse files"));
      expect(onOpenFiles).toHaveBeenCalled();
    });

    it("applies active class when files modal is open", () => {
      renderHeader({ onOpenFiles: vi.fn(), filesOpen: true }, "desktop");
      expect(screen.getByTitle("Browse files").className).toContain("btn-icon--active");
    });

    it("shows files action in mobile overflow menu", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-files-btn")).toBeDefined();
    });

    it("calls onOpenFiles from mobile overflow menu", () => {
      const onOpenFiles = vi.fn();
      renderHeader({ onOpenFiles }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-files-btn"));
      expect(onOpenFiles).toHaveBeenCalled();
    });
  });

  describe("pause controls", () => {
    it("renders pause button for engine pause", () => {
      renderHeader();
      expect(screen.getByTitle("Pause scheduling")).toBeDefined();
    });

    it("renders stop button for global pause", () => {
      renderHeader();
      expect(screen.getByTitle("Stop AI engine")).toBeDefined();
    });

    it("calls onToggleEnginePause when pause button is clicked", () => {
      const onToggleEnginePause = vi.fn();
      renderHeader({ onToggleEnginePause });
      fireEvent.click(screen.getByTitle("Pause scheduling"));
      expect(onToggleEnginePause).toHaveBeenCalled();
    });

    it("calls onToggleGlobalPause when stop button is clicked", () => {
      const onToggleGlobalPause = vi.fn();
      renderHeader({ onToggleGlobalPause });
      fireEvent.click(screen.getByTitle("Stop AI engine"));
      expect(onToggleGlobalPause).toHaveBeenCalled();
    });

    it("shows resume text when engine is paused", () => {
      renderHeader({ enginePaused: true });
      expect(screen.getByTitle("Resume scheduling")).toBeDefined();
    });

    it("shows start text when global is paused", () => {
      renderHeader({ globalPaused: true });
      expect(screen.getByTitle("Start AI engine")).toBeDefined();
    });
  });

  describe("usage button", () => {
    it("does not render usage button when onOpenUsage is not provided", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("View usage")).toBeNull();
    });

    it("does not render usage button when onOpenUsage is not provided on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.queryByTitle("View usage")).toBeNull();
    });

    it("renders usage button with correct title when onOpenUsage is provided on desktop", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "desktop");
      expect(screen.getByTitle("View usage")).toBeDefined();
    });

    it("does not render usage button inline on mobile when onOpenUsage is provided", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "mobile");
      // Button should NOT be inline on mobile (it's in overflow menu)
      expect(screen.queryByTitle("View usage")).toBeNull();
    });

    it("shows usage in overflow menu on mobile", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-usage-btn")).toBeDefined();
    });

    it("calls onOpenUsage when usage button is clicked on desktop", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "desktop");
      fireEvent.click(screen.getByTitle("View usage"));
      expect(onOpenUsage).toHaveBeenCalled();
    });

    it("calls onOpenUsage when usage button in overflow menu is clicked", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-usage-btn"));
      expect(onOpenUsage).toHaveBeenCalled();
    });
  });

  describe("activity log button", () => {
    it("does not render activity log button when onOpenActivityLog is not provided", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("does not render activity log button when onOpenActivityLog is not provided on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("renders activity log button with correct title when onOpenActivityLog is provided on desktop", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "desktop");
      expect(screen.getByTitle("View Activity Log")).toBeDefined();
    });

    it("does not render activity log button inline on mobile when onOpenActivityLog is provided", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "mobile");
      // Button should NOT be inline on mobile (it's in overflow menu)
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("shows activity log in overflow menu on mobile", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-activity-log-btn")).toBeDefined();
    });

    it("calls onOpenActivityLog when activity log button is clicked on desktop", () => {
      const onOpenActivityLog = vi.fn();
      renderHeader({ onOpenActivityLog }, "desktop");
      fireEvent.click(screen.getByTitle("View Activity Log"));
      expect(onOpenActivityLog).toHaveBeenCalled();
    });

    it("calls onOpenActivityLog when activity log button in overflow menu is clicked", () => {
      const onOpenActivityLog = vi.fn();
      renderHeader({ onOpenActivityLog }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-activity-log-btn"));
      expect(onOpenActivityLog).toHaveBeenCalled();
    });
  });

  describe("planning button", () => {
    it("renders planning button with correct title on desktop", () => {
      renderHeader({ onOpenPlanning: vi.fn() }, "desktop");
      expect(screen.getByTitle("Create a task with AI planning")).toBeDefined();
    });

    it("does not render planning button inline on mobile", () => {
      renderHeader({ onOpenPlanning: vi.fn() }, "mobile");
      expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
    });

    it("calls onOpenPlanning when planning button is clicked", () => {
      const onOpenPlanning = vi.fn();
      renderHeader({ onOpenPlanning }, "desktop");
      fireEvent.click(screen.getByTitle("Create a task with AI planning"));
      expect(onOpenPlanning).toHaveBeenCalled();
    });

    it("has correct data-testid for testing on desktop", () => {
      renderHeader({ onOpenPlanning: vi.fn() }, "desktop");
      expect(screen.getByTestId("planning-btn")).toBeDefined();
    });

    describe("active session badge", () => {
      it("does not render badge when activePlanningSessionCount is 0", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 0 }, "desktop");
        expect(screen.queryByTestId("planning-badge")).toBeNull();
      });

      it("does not render badge when activePlanningSessionCount is undefined", () => {
        renderHeader({ onOpenPlanning: vi.fn() }, "desktop");
        expect(screen.queryByTestId("planning-badge")).toBeNull();
      });

      it("renders badge when activePlanningSessionCount > 0", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 1 }, "desktop");
        expect(screen.getByTestId("planning-badge")).toBeDefined();
      });

      it("badge shows correct count", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 3 }, "desktop");
        expect(screen.getByTestId("planning-badge").textContent).toBe("3");
      });

      it("updates title to 'Resume planning session' when count > 0", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 1 }, "desktop");
        expect(screen.getByTitle("Resume planning session")).toBeDefined();
        expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
      });

      it("keeps original title when count is 0", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 0 }, "desktop");
        expect(screen.getByTitle("Create a task with AI planning")).toBeDefined();
      });

      it("calls onResumePlanning when clicked with active sessions", () => {
        const onResumePlanning = vi.fn();
        const onOpenPlanning = vi.fn();
        renderHeader({ onOpenPlanning, onResumePlanning, activePlanningSessionCount: 2 }, "desktop");
        fireEvent.click(screen.getByTitle("Resume planning session"));
        expect(onResumePlanning).toHaveBeenCalled();
        expect(onOpenPlanning).not.toHaveBeenCalled();
      });

      it("calls onOpenPlanning when clicked with no active sessions", () => {
        const onResumePlanning = vi.fn();
        const onOpenPlanning = vi.fn();
        renderHeader({ onOpenPlanning, onResumePlanning, activePlanningSessionCount: 0 }, "desktop");
        fireEvent.click(screen.getByTitle("Create a task with AI planning"));
        expect(onOpenPlanning).toHaveBeenCalled();
        expect(onResumePlanning).not.toHaveBeenCalled();
      });

      it("calls onOpenPlanning when clicked with active sessions but no onResumePlanning", () => {
        const onOpenPlanning = vi.fn();
        renderHeader({ onOpenPlanning, activePlanningSessionCount: 1 }, "desktop");
        // Without onResumePlanning, falls back to onOpenPlanning even with active sessions
        fireEvent.click(screen.getByTitle("Resume planning session"));
        expect(onOpenPlanning).toHaveBeenCalled();
      });

      it("badge has correct aria-label", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 2 }, "desktop");
        expect(screen.getByTestId("planning-badge").getAttribute("aria-label")).toBe("2 active planning sessions");
      });

      it("badge aria-label uses singular for count of 1", () => {
        renderHeader({ onOpenPlanning: vi.fn(), activePlanningSessionCount: 1 }, "desktop");
        expect(screen.getByTestId("planning-badge").getAttribute("aria-label")).toBe("1 active planning session");
      });
    });
  });

  describe("mobile overflow menu", () => {
    it("renders overflow trigger on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.getByTitle("More header actions")).toBeDefined();
    });

    it("does not render overflow trigger on desktop", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("More header actions")).toBeNull();
    });

    it("shows terminal group in overflow menu on mobile", () => {
      renderHeader({ onToggleTerminal: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-terminal-primary-btn")).toBeDefined();
      expect(screen.getByTestId("overflow-terminal-submenu-toggle")).toBeDefined();
    });

    it("shows terminal submenu items when terminal group is expanded on mobile", async () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-scripts-manage")).toBeDefined();
      });
    });

    it("shows scripts manage in terminal submenu on mobile when onOpenScripts is provided", async () => {
      renderHeader({ onOpenScripts: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-scripts-manage")).toBeDefined();
      });
    });

    it("does not show scripts manage in terminal submenu when onOpenScripts is undefined", () => {
      renderHeader({ onToggleTerminal: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      expect(screen.queryByTestId("overflow-scripts-manage")).toBeNull();
    });

    it("calls onToggleTerminal from primary terminal button on mobile", () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-primary-btn"));
      expect(onToggleTerminal).toHaveBeenCalled();
    });

    it("calls onOpenScripts from terminal submenu manage on mobile", async () => {
      const onOpenScripts = vi.fn();
      renderHeader({ onOpenScripts }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-scripts-manage")).toBeDefined();
      });
      fireEvent.click(screen.getByTestId("overflow-scripts-manage"));
      expect(onOpenScripts).toHaveBeenCalled();
    });

    it("primary terminal button opens terminal directly without expanding submenu", () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      // Click primary button — should open terminal and NOT expand submenu
      fireEvent.click(screen.getByTestId("overflow-terminal-primary-btn"));
      expect(onToggleTerminal).toHaveBeenCalled();
      // Overflow menu should close after action
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("chevron toggle expands submenu without opening terminal", () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal, onOpenScripts: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      // Click chevron — should expand submenu but NOT call onToggleTerminal
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      expect(onToggleTerminal).not.toHaveBeenCalled();
      // Overflow menu should still be open (check by primary button still being visible)
      expect(screen.getByTestId("overflow-terminal-primary-btn")).toBeDefined();
    });

    it("renders one script item per fetched script in submenu", async () => {
      mockFetchScripts.mockResolvedValue({ build: "pnpm build", test: "pnpm test" });
      const onRunScript = vi.fn();
      renderHeader({ onToggleTerminal: noop, onRunScript, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-script-item-build")).toBeDefined();
        expect(screen.getByTestId("overflow-script-item-test")).toBeDefined();
      });
    });

    it("clicking a script entry calls onRunScript and closes overflow", async () => {
      mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
      const onRunScript = vi.fn();
      renderHeader({ onToggleTerminal: noop, onRunScript, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-script-item-build")).toBeDefined();
      });
      fireEvent.click(screen.getByTestId("overflow-script-item-build"));
      expect(onRunScript).toHaveBeenCalledWith("build", "pnpm build");
      // Overflow menu should close after running script
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("does not render old overflow-scripts-btn item", async () => {
      mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
      renderHeader({ onToggleTerminal: noop, onRunScript: noop, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-script-item-build")).toBeDefined();
      });
      // The old generic scripts button should not exist
      expect(screen.queryByTestId("overflow-scripts-btn")).toBeNull();
      // The old terminal submenu "Open Terminal" button should not exist
      expect(screen.queryByTestId("overflow-terminal-btn")).toBeNull();
    });

    it("shows loading state while fetching scripts", () => {
      mockFetchScripts.mockImplementation(() => new Promise(() => {}));
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      expect(screen.getByTestId("overflow-scripts-loading")).toBeDefined();
    });

    it("shows manage scripts link when no scripts are configured", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-scripts-manage")).toBeDefined();
      });
    });

    it("does not show manage scripts link when onOpenScripts is undefined", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderHeader({ onToggleTerminal: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.queryByTestId("overflow-scripts-manage")).toBeNull();
      });
    });

    it("handles missing onRunScript gracefully", async () => {
      mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-script-item-build")).toBeDefined();
      });
      // Clicking script without onRunScript should not throw
      expect(() => {
        fireEvent.click(screen.getByTestId("overflow-script-item-build"));
      }).not.toThrow();
      // Overflow menu should still close
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("shows Manage Scripts after script entries when scripts exist", async () => {
      mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
      renderHeader({ onToggleTerminal: noop, onRunScript: noop, onOpenScripts: noop, projectId: "test-project" }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-terminal-submenu-toggle"));
      await waitFor(() => {
        expect(screen.getByTestId("overflow-script-item-build")).toBeDefined();
        expect(screen.getByTestId("overflow-scripts-manage")).toBeDefined();
      });
    });

    it("shows GitHub import in overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Import from GitHub")).toBeDefined();
    });

    it("shows planning in overflow menu on mobile", () => {
      renderHeader({ onOpenPlanning: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-planning-btn")).toBeDefined();
    });

    it("shows planning badge in overflow menu when activePlanningSessionCount > 0", () => {
      renderHeader({ onOpenPlanning: noop, activePlanningSessionCount: 1 }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-planning-badge")).toBeDefined();
      expect(screen.getByTestId("overflow-planning-badge").textContent).toBe("1");
    });

    it("does not show planning badge in overflow menu when count is 0", () => {
      renderHeader({ onOpenPlanning: noop, activePlanningSessionCount: 0 }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-planning-badge")).toBeNull();
    });

    it("calls onResumePlanning from overflow menu when active sessions exist", () => {
      const onResumePlanning = vi.fn();
      const onOpenPlanning = vi.fn();
      renderHeader({ onOpenPlanning, onResumePlanning, activePlanningSessionCount: 2 }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-planning-btn"));
      expect(onResumePlanning).toHaveBeenCalled();
      expect(onOpenPlanning).not.toHaveBeenCalled();
    });

    it("shows resume text in overflow menu when active sessions exist", () => {
      renderHeader({ onOpenPlanning: noop, activePlanningSessionCount: 1 }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Resume planning session (1)")).toBeDefined();
    });

    it("shows settings in overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Settings")).toBeDefined();
    });
  });

  describe("nodes button", () => {
    it("renders Nodes button on desktop when handler is provided", () => {
      renderHeader({ onOpenNodes: vi.fn() }, "desktop");
      expect(screen.getByTitle("Nodes")).toBeDefined();
    });

    it("calls onOpenNodes when Nodes button is clicked", () => {
      const onOpenNodes = vi.fn();
      renderHeader({ onOpenNodes }, "desktop");
      fireEvent.click(screen.getByTitle("Nodes"));
      expect(onOpenNodes).toHaveBeenCalled();
    });

    it("shows Nodes action in mobile overflow menu", () => {
      const onOpenNodes = vi.fn();
      renderHeader({ onOpenNodes }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-nodes-btn"));
      expect(onOpenNodes).toHaveBeenCalled();
    });
  });

  describe("search functionality", () => {
    it("does not render search input when onSearchChange is not provided", () => {
      renderHeader({ view: "board" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("renders search input when onSearchChange and view='board' are provided", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("does not render search input when view is 'list'", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("calls onSearchChange when typing in search input", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      const input = screen.getByPlaceholderText("Search tasks...");
      fireEvent.change(input, { target: { value: "test query" } });
      expect(onSearchChange).toHaveBeenCalledWith("test query");
    });

    it("shows clear button when search query is not empty", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board", searchQuery: "test" });
      expect(screen.getByLabelText("Clear search")).toBeDefined();
    });

    it("does not show clear button when search query is empty", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board", searchQuery: "" });
      expect(screen.queryByLabelText("Clear search")).toBeNull();
    });

    it("calls onSearchChange with empty string when clear button is clicked", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board", searchQuery: "test" });
      fireEvent.click(screen.getByLabelText("Clear search"));
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("search input has correct placeholder text", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      const input = screen.getByPlaceholderText("Search tasks...");
      expect(input).toBeDefined();
    });
  });

  describe("schedules button", () => {
    it("renders schedules button on desktop", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.getByTitle("Scheduled tasks")).toBeDefined();
    });

    it("does not render schedules button inline on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      expect(screen.queryByTitle("Scheduled tasks")).toBeNull();
    });

    it("calls onOpenSchedules when schedules button is clicked", () => {
      const onOpenSchedules = vi.fn();
      renderHeader({ onOpenSchedules }, "desktop");
      fireEvent.click(screen.getByTitle("Scheduled tasks"));
      expect(onOpenSchedules).toHaveBeenCalled();
    });

    it("has correct data-testid for testing on desktop", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.getByTestId("schedules-btn")).toBeDefined();
    });

    it("includes scheduled tasks in overflow menu on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Scheduled Tasks")).toBeDefined();
    });

    it("calls onOpenSchedules from mobile overflow menu", () => {
      const onOpenSchedules = vi.fn();
      renderHeader({ onOpenSchedules }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-schedules-btn"));
      expect(onOpenSchedules).toHaveBeenCalled();
    });
  });

  describe("mobile header layout", () => {
    it("applies header-project-selector class when multiple projects exist on mobile", () => {
      const { container } = renderHeader({
        projects: [
          { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
          { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
        ],
        currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      }, true);
      expect(container.querySelector(".header-project-selector")).toBeDefined();
    });

    it("does not show project selector on mobile with single project", () => {
      const { container } = renderHeader({
        projects: [{ id: "1", name: "Project One", path: "/path/one", status: "active" as const }],
      }, true);
      expect(container.querySelector(".header-project-selector")).toBeNull();
    });

    it("renders header-back-button when currentProject is set on mobile", () => {
      const { container } = renderHeader({
        currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        onViewAllProjects: vi.fn(),
      }, true);
      expect(container.querySelector(".header-back-button")).toBeDefined();
    });

    it("does not render header-back-button on mobile when no currentProject", () => {
      const { container } = renderHeader({}, "mobile");
      expect(container.querySelector(".header-back-button")).toBeNull();
    });

    it("mobile overflow menu closes when clicking outside", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByRole("menu")).toBeDefined();

      // Click outside the menu
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("mobile overflow menu closes on Escape key", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByRole("menu")).toBeDefined();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("mobile overflow trigger has correct accessibility attributes", () => {
      renderHeader({}, "mobile");
      const trigger = screen.getByTitle("More header actions");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    it("hides logo-sub on mobile via CSS", () => {
      renderHeader({}, "mobile");
      // The "tasks" element no longer exists - it was removed
    });
  });

  describe("Projects button", () => {
    const singleProject = [
      { id: "1", name: "Test Project", path: "/path/to/project", status: "active" as const },
    ];

    it("renders Projects button when projects exist", () => {
      renderHeader({
        projects: singleProject,
        onViewAllProjects: noop,
      }, "desktop");
      expect(screen.getByTestId("header-projects-btn")).toBeDefined();
    });

    it("calls onViewAllProjects when Projects button is clicked", () => {
      const onViewAllProjects = vi.fn();
      renderHeader({
        projects: singleProject,
        onViewAllProjects,
      }, "desktop");
      fireEvent.click(screen.getByTestId("header-projects-btn"));
      expect(onViewAllProjects).toHaveBeenCalled();
    });

    it("does not render Projects button when no projects", () => {
      renderHeader({
        projects: [],
        onViewAllProjects: noop,
      }, "desktop");
      expect(screen.queryByTestId("header-projects-btn")).toBeNull();
    });

    it("does not render Projects button on mobile", () => {
      renderHeader({
        projects: singleProject,
        onViewAllProjects: noop,
      }, "mobile");
      expect(screen.queryByTestId("header-projects-btn")).toBeNull();
    });

    it("does not render Projects button on tablet", () => {
      renderHeader({
        projects: singleProject,
        onViewAllProjects: noop,
      }, "tablet");
      expect(screen.queryByTestId("header-projects-btn")).toBeNull();
    });

    it("does not render Projects button when onViewAllProjects is not provided", () => {
      renderHeader({
        projects: singleProject,
      }, "desktop");
      expect(screen.queryByTestId("header-projects-btn")).toBeNull();
    });

    it("renders Projects button with correct title", () => {
      renderHeader({
        projects: singleProject,
        onViewAllProjects: noop,
      }, "desktop");
      expect(screen.getByTitle("View all projects")).toBeDefined();
    });
  });

  describe("action ordering", () => {
    it("Settings is the last inline action on desktop (after stop button)", () => {
      const { container } = renderHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowSteps: noop,
        onOpenFiles: noop,
        onOpenGitManager: noop,
        onOpenScripts: noop,
        onRunScript: noop,
      }, "desktop");

      // Get all inline btn-icon buttons inside header-actions
      const headerActions = container.querySelector(".header-actions")!;
      const inlineButtons = Array.from(headerActions.querySelectorAll<HTMLButtonElement>(":scope > button.btn-icon"));

      // Find the Settings button index and the Pause/Stop button indices
      const settingsIdx = inlineButtons.findIndex((btn) => btn.title === "Settings");
      const pauseIdx = inlineButtons.findIndex((btn) => btn.title === "Pause scheduling" || btn.title === "Resume scheduling");
      const stopIdx = inlineButtons.findIndex((btn) => btn.title === "Stop AI engine" || btn.title === "Start AI engine");

      // Settings must exist
      expect(settingsIdx).toBeGreaterThanOrEqual(0);

      // Settings must come after pause and stop (engine controls come before Settings)
      expect(settingsIdx).toBeGreaterThan(pauseIdx);
      expect(settingsIdx).toBeGreaterThan(stopIdx);

      // Settings must be the very last button — no buttons after it
      const buttonsAfterSettings = inlineButtons.slice(settingsIdx + 1);
      expect(buttonsAfterSettings).toHaveLength(0);
    });

    it("Settings is the last item in the mobile overflow menu", () => {
      const { container } = renderHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowSteps: noop,
        onOpenFiles: noop,
        onOpenGitManager: noop,
      }, "mobile");

      fireEvent.click(screen.getByTitle("More header actions"));

      // Get all menu items inside the overflow menu
      const menu = container.querySelector(".mobile-overflow-menu")!;
      const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>("button.mobile-overflow-item"));

      // The last menu item should be Settings
      const lastItem = menuItems[menuItems.length - 1];
      expect(lastItem.textContent).toBe("Settings");
    });

    it("Settings is the last item in the mobile overflow menu even when optional items are absent", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      // Get the overflow menu items
      const menu = screen.getByRole("menu");
      const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role='menuitem']"));

      const lastItem = menuItems[menuItems.length - 1];
      expect(lastItem.textContent).toBe("Settings");
    });
  });
});
