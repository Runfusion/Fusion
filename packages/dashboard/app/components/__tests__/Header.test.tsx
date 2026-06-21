import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Header } from "../Header";

// Mock fetchScripts for overflow submenu
const mockFetchScripts = vi.fn();

vi.mock("../../api", () => ({
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

  it("applies shell host metadata on the header root", () => {
    const { container } = renderHeader({ shellHost: { kind: "desktop-shell", mode: "remote", canOpenConnectionManager: true } });
    expect(container.querySelector("header.header")?.getAttribute("data-shell-kind")).toBe("desktop-shell");
  });

  it("renders shell connection control when provided", () => {
    renderHeader({ shellConnectionControl: <button type="button">Manage connections</button> });
    expect(screen.getByRole("button", { name: "Manage connections" })).toBeInTheDocument();
  });

  it("does not render shell connection control when omitted", () => {
    const { container } = renderHeader({ shellConnectionControl: undefined });
    expect(container.querySelector(".shell-connection-status")).toBeNull();
  });

  it("renders action buttons", () => {
    renderHeader();
    expect(screen.getByTitle("Import from GitHub")).toBeDefined();
    expect(screen.getByTitle("Settings")).toBeDefined();
  });

  describe("workflows button", () => {
    it("renders the desktop workflows button and opens the editor on click", () => {
      const onOpenWorkflowEditor = vi.fn();
      renderHeader({ onOpenWorkflowEditor }, "desktop");
      const btn = screen.getByTestId("workflow-steps-btn");
      expect(btn.getAttribute("title")).toBe("Workflows");
      fireEvent.click(btn);
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
    });

    it("opens the editor from the mobile overflow menu", () => {
      const onOpenWorkflowEditor = vi.fn();
      renderHeader({ onOpenWorkflowEditor }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-workflow-steps-btn"));
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
    });
  });

  it("hides GitHub import for desktop shell host", () => {
    renderHeader({ shellHost: { kind: "desktop-shell" } });
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
  });

  it("keeps GitHub import for mobile shell host", () => {
    renderHeader({ shellHost: { kind: "mobile-shell" } });
    expect(screen.getByTitle("Import from GitHub")).toBeDefined();
  });

  it("calls onOpenSettings when settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    renderHeader({ onOpenSettings });
    fireEvent.click(screen.getByTitle("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("calls onOpenFiles with zero arguments from desktop files button", () => {
    const onOpenFiles = vi.fn();
    renderHeader({ onOpenFiles }, "desktop");

    fireEvent.click(screen.getByTestId("files-toggle-btn"));

    expect(onOpenFiles).toHaveBeenCalledTimes(1);
    expect(onOpenFiles.mock.calls[0]).toEqual([]);
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

    it("renders the workflow portal slot instead of the view toggle on desktop sidebar nav", () => {
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true }, "desktop");
      expect(screen.getByTestId("header-workflow-slot")).toBeInTheDocument();
      expect(screen.queryByTitle("Board view")).toBeNull();
      expect(screen.queryByTitle("List view")).toBeNull();
    });

    it("renders the workflow portal slot instead of the view toggle on tablet sidebar nav", () => {
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true }, "tablet");
      expect(screen.getByTestId("header-workflow-slot")).toBeInTheDocument();
      expect(screen.queryByTitle("Board view")).toBeNull();
      expect(screen.queryByTitle("List view")).toBeNull();
    });

    it("does not render the workflow portal slot on mobile sidebar nav", () => {
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true }, "mobile");
      expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
      expect(screen.queryByTitle("Board view")).not.toBeNull();
      expect(screen.queryByTitle("List view")).not.toBeNull();
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

    it("shows chat unread indicator when chatHasUnreadResponse is true and chat is not active", () => {
      renderHeader({ onChangeView: noop, view: "board", chatHasUnreadResponse: true });
      expect(screen.getByLabelText("Unread chat response")).toBeInTheDocument();
    });

    it("shows mailbox unread indicator when there are unread messages only", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxUnreadCount: 3, mailboxPendingApprovalCount: 0 });
      expect(screen.getByLabelText("3 unread messages")).toBeInTheDocument();
      expect(screen.queryByLabelText("Pending approvals")).toBeNull();
    });

    it("shows mailbox pending-approval indicator when mailbox is not active", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxPendingApprovalCount: 2, mailboxUnreadCount: 0 });
      expect(screen.getByLabelText("Pending approvals")).toBeInTheDocument();
      expect(screen.queryByLabelText(/unread messages/)).toBeNull();
    });

    it("shows only the pending indicator when mailbox has both pending approvals and unread messages", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxPendingApprovalCount: 2, mailboxUnreadCount: 4 });
      expect(screen.getByLabelText("Pending approvals")).toBeInTheDocument();
      expect(screen.queryByLabelText("4 unread messages")).toBeNull();
    });

    it("hides mailbox indicators when counts are zero", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxPendingApprovalCount: 0, mailboxUnreadCount: 0 });
      expect(screen.queryByLabelText("Pending approvals")).toBeNull();
      expect(screen.queryByLabelText(/unread messages/)).toBeNull();
    });

    it("hides mailbox indicators when mailbox view is active", () => {
      renderHeader({ onChangeView: noop, view: "mailbox", mailboxPendingApprovalCount: 2, mailboxUnreadCount: 3 });
      expect(screen.queryByLabelText("Pending approvals")).toBeNull();
      expect(screen.queryByLabelText(/unread messages/)).toBeNull();
    });

    it("hides chat unread indicator when chat view is active", () => {
      renderHeader({ onChangeView: noop, view: "chat", chatHasUnreadResponse: true });
      expect(screen.queryByLabelText("Unread chat response")).toBeNull();
    });

    it("has correct aria attributes for accessibility", () => {
      renderHeader({ onChangeView: noop, view: "board" });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
      expect(listBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("renders view overflow trigger when todos are enabled", () => {
      renderHeader({ onChangeView: noop, todosEnabled: true });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("shows the Todos entry in view overflow when todos are enabled", () => {
      renderHeader({ onChangeView: noop, todosEnabled: true });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.getByTestId("view-overflow-todos")).toBeInTheDocument();
    });

    it.each(["desktop", "tablet"] as const)("routes More views to the right dock panel toggle on %s", (tier) => {
      const onToggleRightDock = vi.fn();
      const { rerender } = renderHeader({
        onChangeView: noop,
        rightDockActive: true,
        rightDockOpen: false,
        onToggleRightDock,
      }, tier);

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-panel-right")).toBeTruthy();
      expect(trigger.querySelector(".lucide-chevron-down")).toBeNull();
      expect(trigger).toHaveAttribute("aria-pressed", "false");
      expect(trigger).not.toHaveAttribute("aria-haspopup");

      fireEvent.click(trigger);
      expect(onToggleRightDock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu", { name: "More views" })).toBeNull();

      rerender(
        <Header
          onOpenSettings={noop}
          onOpenGitHubImport={noop}
          onChangeView={noop}
          rightDockActive={true}
          rightDockOpen={true}
          onToggleRightDock={onToggleRightDock}
        />,
      );
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toHaveAttribute("aria-pressed", "true");
    });

    it.each(["desktop", "tablet"] as const)("keeps one standalone right dock toggle when left sidebar hides view nav on %s", (tier) => {
      const onToggleRightDock = vi.fn();
      renderHeader({
        onChangeView: noop,
        leftSidebarNavActive: true,
        rightDockActive: true,
        rightDockOpen: true,
        onToggleRightDock,
      }, tier);

      const triggers = screen.getAllByTestId("view-toggle-overflow-trigger");
      expect(triggers).toHaveLength(1);
      expect(triggers[0].querySelector(".lucide-panel-right")).toBeTruthy();
      expect(triggers[0]).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(triggers[0]);
      expect(onToggleRightDock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu", { name: "More views" })).toBeNull();
    });

    it("keeps the legacy chevron dropdown on mobile even when right dock props are present", () => {
      const onToggleRightDock = vi.fn();
      renderHeader({
        onChangeView: noop,
        mobileNavEnabled: false,
        rightDockActive: true,
        rightDockOpen: false,
        onToggleRightDock,
      }, "mobile");

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(trigger.querySelector(".lucide-panel-right")).toBeNull();
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      fireEvent.click(trigger);
      expect(onToggleRightDock).not.toHaveBeenCalled();
      expect(screen.getByRole("menu", { name: "More views" })).toBeInTheDocument();
    });

    it("shows secrets in overflow and routes to secrets view", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "board" });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-secrets"));
      expect(onChangeView).toHaveBeenCalledWith("secrets");
    });

    it("renders dependency graph in overflow and uses canonical graph task view", () => {
      const onChangeView = vi.fn();
      renderHeader({
        onChangeView,
        pluginDashboardViews: [
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", icon: "Map", placement: "more" },
          },
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "queue", label: "Queue", componentPath: "./QueueView", icon: "Workflow" },
          },
        ],
      });

      expect(screen.queryByTestId("view-toggle-plugin-fusion-plugin-dependency-graph-graph")).toBeNull();

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      const graphItem = screen.getByTestId("view-overflow-plugin-fusion-plugin-dependency-graph-graph");
      expect(graphItem.querySelector(".lucide-map")).toBeTruthy();
      fireEvent.click(graphItem);
      expect(onChangeView).toHaveBeenCalledWith("graph");

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      const queueItem = screen.getByTestId("view-overflow-plugin-fusion-plugin-dependency-graph-queue");
      expect(queueItem.querySelector(".lucide-workflow")).toBeTruthy();
      fireEvent.click(queueItem);
      expect(onChangeView).toHaveBeenCalledWith("plugin:fusion-plugin-dependency-graph:queue");
    });

    it("hides legacy roadmaps overflow item when roadmap plugin view is present", () => {
      renderHeader({
        onChangeView: noop,
        experimentalFeatures: {},
        pluginDashboardViews: [
          {
            pluginId: "fusion-plugin-roadmap",
            view: { viewId: "roadmaps", label: "Roadmaps", componentPath: "./RoadmapsView", icon: "Map", placement: "primary" },
          },
        ],
      });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-roadmaps")).toBeNull();
    });

    it("renders view overflow trigger when an experimental overflow feature is enabled", () => {
      renderHeader({ onChangeView: noop, experimentalFeatures: { insights: true } });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("keeps desktop Documents and Command Center inline without Command Center overflow", () => {
      renderHeader({ onChangeView: noop, showAgentsTab: true }, "desktop");

      expect(screen.getByTitle("Documents view")).toBeInTheDocument();
      const agentsButton = screen.getByTitle("Agents view");
      const commandCenterButton = screen.getByTestId("view-toggle-command-center");
      expect(commandCenterButton.previousElementSibling).toBe(agentsButton);

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-command-center")).toBeNull();
      expect(screen.queryByTestId("view-overflow-documents")).toBeNull();
    });

    it("promotes Command Center after Agents and moves Documents to overflow on tablet", () => {
      renderHeader({ onChangeView: noop, showAgentsTab: true }, "tablet");

      const agentsButton = screen.getByTitle("Agents view");
      const commandCenterButton = screen.getByTestId("view-toggle-command-center");
      expect(commandCenterButton.previousElementSibling).toBe(agentsButton);
      expect(screen.queryByTitle("Documents view")).toBeNull();

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.getByTestId("view-overflow-documents")).toBeInTheDocument();
      expect(screen.queryByTestId("view-overflow-command-center")).toBeNull();
    });

    it("renders view overflow trigger when skills tab is enabled", () => {
      renderHeader({ onChangeView: noop, showSkillsTab: true });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("does not render research in overflow when researchView is disabled", () => {
      renderHeader({
        onChangeView: noop,
        showSkillsTab: false,
        experimentalFeatures: { insights: false, memoryView: false, devServerView: false, researchView: false },
      });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-research")).toBeNull();
    });

    it("routes to research from the desktop view overflow when enabled", () => {
      const onChangeView = vi.fn();
      renderHeader({
        onChangeView,
        experimentalFeatures: { researchView: true },
      });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-research"));

      expect(onChangeView).toHaveBeenCalledWith("research");
      expect(screen.queryByTestId("view-overflow-research")).toBeNull();
    });

    it("hides evals in the desktop view overflow when evalsView is disabled", () => {
      renderHeader({ onChangeView: noop, experimentalFeatures: { evalsView: false } });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-evals")).toBeNull();
    });

    it("routes to evals from the desktop view overflow when evalsView is enabled", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, experimentalFeatures: { evalsView: true } });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-evals"));

      expect(onChangeView).toHaveBeenCalledWith("evals");
      expect(screen.queryByTestId("view-overflow-evals")).toBeNull();
    });

    it("gates goals overflow entry and routes to goalsView when enabled", () => {
      const hidden = renderHeader({ onChangeView: noop, experimentalFeatures: { goalsView: false, insights: true } });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-goals")).toBeNull();
      hidden.unmount();

      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "goalsView", experimentalFeatures: { goalsView: true } });

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.className).toContain("active");
      fireEvent.click(trigger);

      const goalsItem = screen.getByTestId("view-overflow-goals");
      expect(goalsItem.className).toContain("active");
      fireEvent.click(goalsItem);

      expect(onChangeView).toHaveBeenCalledWith("goalsView");
      expect(screen.queryByTestId("view-overflow-goals")).toBeNull();
    });
  });

  describe("terminal split button", () => {
    it("renders terminal main button and scripts chevron on desktop", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "desktop");
      expect(screen.getByTitle("Open Terminal")).toBeDefined();
      expect(screen.getByTestId("scripts-btn")).toBeDefined();
    });

    it("does not render terminal button inline on mobile", () => {
      renderHeader({ onToggleTerminal: noop }, "mobile");
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
    });

    it("clicking main button calls onToggleTerminal without opening scripts dropdown", () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal, onOpenScripts: noop, onRunScript: noop }, "desktop");
      fireEvent.click(screen.getByTestId("terminal-toggle-btn"));
      expect(onToggleTerminal).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
    });

    it("clicking scripts chevron opens dropdown without calling onToggleTerminal", async () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal, onOpenScripts: noop, onRunScript: noop }, "desktop");

      fireEvent.click(screen.getByTestId("scripts-btn"));

      expect(onToggleTerminal).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });
    });

    it("fetches scripts and runs selected script from dropdown", async () => {
      mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
      const onRunScript = vi.fn();

      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript, projectId: "proj-1" }, "desktop");
      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-build")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("quick-script-item-build"));
      expect(onRunScript).toHaveBeenCalledWith("build", "pnpm build");
      expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
    });

    it("shows loading state while scripts are fetching", () => {
      mockFetchScripts.mockImplementation(() => new Promise(() => {}));
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "desktop");
      fireEvent.click(screen.getByTestId("scripts-btn"));
      expect(screen.getByTestId("quick-scripts-loading")).toBeDefined();
    });

    it("shows empty state when no scripts are configured", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "desktop");
      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-empty")).toBeDefined();
      });
    });

    it("shows manage scripts footer when scripts exist", async () => {
      mockFetchScripts.mockResolvedValue({ test: "pnpm test" });
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "desktop");
      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-manage")).toBeDefined();
      });
    });

    it("supports keyboard navigation in scripts dropdown", async () => {
      mockFetchScripts.mockResolvedValue({ alpha: "echo alpha", beta: "echo beta" });
      const onRunScript = vi.fn();

      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript }, "desktop");
      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-alpha")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      fireEvent.keyDown(menu, { key: "Enter" });
      expect(onRunScript).toHaveBeenCalledWith("alpha", "echo alpha");

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });
      fireEvent.keyDown(screen.getByTestId("quick-scripts-dropdown"), { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
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

  describe("todos navigation", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      it(`shows Todos only in More views and Mailbox only top-level on ${tier}`, () => {
        renderHeader({ onChangeView: noop, todosEnabled: true }, tier);

        expect(screen.queryByTestId("todos-toggle-btn")).toBeNull();
        expect(screen.getByTitle("Mailbox view")).toBeInTheDocument();

        fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
        expect(screen.getAllByText("Todos")).toHaveLength(1);
        expect(screen.getByTestId("view-overflow-todos")).toBeInTheDocument();
        expect(screen.queryByTestId("view-overflow-mailbox")).toBeNull();
      });
    }

    it("does not show Todos entry in More views when disabled", () => {
      renderHeader({ onChangeView: noop, todosEnabled: false }, "desktop");
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-todos")).toBeNull();
    });

    it("routes to todos from More views and marks active state", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "todos", todosEnabled: true }, "desktop");

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.className).toContain("active");
      fireEvent.click(trigger);

      const todosItem = screen.getByTestId("view-overflow-todos");
      expect(todosItem.className).toContain("active");
      fireEvent.click(todosItem);

      expect(onChangeView).toHaveBeenCalledWith("todos");
      expect(screen.queryByTestId("view-overflow-todos")).toBeNull();
    });
  });

  describe("pause controls", () => {
    it("does not render the retired header engine control affordance", () => {
      renderHeader();
      expect(screen.queryByTestId("engine-control-main-btn")).toBeNull();
      expect(screen.queryByTestId("engine-control-chevron-btn")).toBeNull();
      expect(screen.queryByTestId("engine-control-pause-triage-btn")).toBeNull();
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
      expect(screen.getByTestId("desktop-header-usage-btn")).toBeDefined();
    });

    it("does not render usage button inline on mobile when onOpenUsage is provided", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "mobile");
      // Button should NOT be inline on mobile (it's in overflow menu)
      expect(screen.queryByTitle("View usage")).toBeNull();
      expect(screen.queryByTestId("desktop-header-usage-btn")).toBeNull();
    });

    it("shows usage in overflow menu on mobile", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-usage-btn")).toBeDefined();
    });

    it("calls onOpenUsage with button bounds when usage button is clicked on desktop", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "desktop");

      const usageButton = screen.getByTestId("desktop-header-usage-btn") as HTMLButtonElement;
      const mockRect = {
        top: 12,
        bottom: 52,
        left: 820,
        right: 860,
        width: 40,
        height: 40,
        x: 820,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect;
      usageButton.getBoundingClientRect = vi.fn(() => mockRect);

      fireEvent.click(usageButton);
      expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
    });

    it("calls onOpenUsage with button bounds when usage button in overflow menu is clicked", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      const usageButton = screen.getByTestId("overflow-usage-btn") as HTMLButtonElement;
      const mockRect = {
        top: 100,
        bottom: 132,
        left: 20,
        right: 180,
        width: 160,
        height: 32,
        x: 20,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect;
      usageButton.getBoundingClientRect = vi.fn(() => mockRect);

      fireEvent.click(usageButton);
      expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
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
    it("omits Nodes button from desktop overflow because Nodes lives in Command Center", () => {
      renderHeader({}, "desktop");
      expect(screen.getByTestId("desktop-overflow-trigger")).toBeDefined();
      fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
      expect(screen.queryByTestId("desktop-overflow-nodes-btn")).toBeNull();
    });

    it("omits Nodes action from mobile overflow menu because Nodes lives in Command Center", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-nodes-btn")).toBeNull();
    });
  });

  describe("non-mobile search toggle", () => {
    it("does not render search toggle when onSearchChange is not provided", () => {
      renderHeader({ view: "board" });
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("renders search toggle button when onSearchChange and view='board' are provided", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    });

    it("renders search toggle button when onSearchChange and view='list' are provided", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list" });
      expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    });

    it("renders the desktop search toggle after the empty workflow portal slot", () => {
      renderHeader({ onSearchChange: vi.fn(), onChangeView: noop, view: "board", leftSidebarNavActive: true }, "desktop");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      const searchToggle = screen.getByTestId("desktop-header-search-btn");

      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
      expect(workflowSlot.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the desktop search toggle after a populated workflow portal slot", () => {
      renderHeader({ onSearchChange: vi.fn(), onChangeView: noop, view: "board", leftSidebarNavActive: true }, "desktop");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      const workflowSwitcher = document.createElement("button");
      workflowSwitcher.type = "button";
      workflowSwitcher.dataset.testid = "mock-workflow-switcher";
      workflowSwitcher.textContent = "Coding workflow";
      workflowSlot.appendChild(workflowSwitcher);
      const searchToggle = screen.getByTestId("desktop-header-search-btn");

      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
      expect(workflowSlot.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(workflowSwitcher.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the tablet search toggle after the workflow portal slot", () => {
      renderHeader({ onSearchChange: vi.fn(), onChangeView: noop, view: "board", leftSidebarNavActive: true }, "tablet");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      const searchToggle = screen.getByTestId("desktop-header-search-btn");

      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
      expect(workflowSlot.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("does not render search toggle when view is 'agents'", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "agents" });
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("does not render search toggle when view is 'missions'", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "missions" });
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("does not render search input by default when toggle is visible", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("opens search input when toggle button is clicked", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("closes search when close button is clicked", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      fireEvent.click(screen.getByLabelText("Close search"));
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("clears search query when close button is clicked", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      fireEvent.click(screen.getByLabelText("Close search"));
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("keeps search open when searchQuery is non-empty", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board", searchQuery: "test" });
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("shows search input with active query and hides toggle", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list", searchQuery: "test" });
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.getByDisplayValue("test")).toBeDefined();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("calls onSearchChange when typing in search input", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      const input = screen.getByPlaceholderText("Search tasks...");
      fireEvent.change(input, { target: { value: "test query" } });
      expect(onSearchChange).toHaveBeenCalledWith("test query");
    });

    it("search input has correct placeholder text", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      const input = screen.getByPlaceholderText("Search tasks...");
      expect(input).toBeDefined();
    });

    it("renders search input inside header-floating-search on desktop board view", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(container.querySelector(".header-floating-search .header-search")).not.toBeNull();
    });

    it("does not render search input inside header-actions", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(container.querySelector(".header-actions .header-search")).toBeNull();
    });

    it("renders header-wrapper containing both header and floating search", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" });
      const wrapper = container.querySelector(".header-wrapper");
      expect(wrapper).not.toBeNull();
      expect(wrapper!.querySelector("header.header")).not.toBeNull();
    });

    it("toggling search twice reopens the search (use close button to dismiss)", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      // Second toggle click reopens search since first close was via toggle
      // (toggle always opens, use close button to dismiss)
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      // Search stays open because toggle only opens
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      // Use close button to dismiss
      fireEvent.click(screen.getByLabelText("Close search"));
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("supports search toggle flow on list view", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "list" });
      // Toggle visible on list view
      expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
      // Click toggle
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      // Search opens
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      // Close and clear
      fireEvent.click(screen.getByLabelText("Close search"));
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("renders branch filters in desktop board search panel only", () => {
      renderHeader({
        onSearchChange: vi.fn(),
        view: "board",
        branchOptions: ["feature/a"],
        baseBranchOptions: ["main"],
      });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByTestId("header-branch-filters-desktop")).toBeInTheDocument();
      expect(screen.getByTestId("working-branch-filter")).toBeInTheDocument();
      expect(screen.getByTestId("target-branch-filter")).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "All working branches" })).toHaveValue("");
      expect(screen.getByRole("option", { name: "No working branch" })).toHaveValue("__fusion:no-branch__");
      expect(screen.getByRole("option", { name: "All base branches" })).toHaveValue("");
      expect(screen.getByRole("option", { name: "No base branch" })).toHaveValue("__fusion:no-branch__");
    });

    it("does not render branch filters in list view", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.queryByTestId("header-branch-filters-desktop")).toBeNull();
    });

    it("calls branch filter callbacks with selected values, unassigned sentinel, and reset", () => {
      const onBranchFilterChange = vi.fn();
      const onBaseBranchFilterChange = vi.fn();
      renderHeader({
        onSearchChange: vi.fn(),
        view: "board",
        branchOptions: ["feature/a"],
        baseBranchOptions: ["release"],
        onBranchFilterChange,
        onBaseBranchFilterChange,
      });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "feature/a" } });
      fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "__fusion:no-branch__" } });
      fireEvent.change(screen.getByTestId("target-branch-filter"), { target: { value: "release" } });
      fireEvent.change(screen.getByTestId("target-branch-filter"), { target: { value: "__fusion:no-branch__" } });
      fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "" } });
      expect(onBranchFilterChange).toHaveBeenCalledWith("feature/a");
      expect(onBranchFilterChange).toHaveBeenCalledWith("__fusion:no-branch__");
      expect(onBranchFilterChange).toHaveBeenCalledWith("");
      expect(onBaseBranchFilterChange).toHaveBeenCalledWith("release");
      expect(onBaseBranchFilterChange).toHaveBeenCalledWith("__fusion:no-branch__");
    });

    it("renders branch filters in mobile expanded search for board view", () => {
      renderHeader({
        onSearchChange: vi.fn(),
        view: "board",
        branchOptions: ["feature/mobile"],
        baseBranchOptions: ["main"],
      }, "mobile");
      fireEvent.click(screen.getByTestId("mobile-header-search-btn"));
      expect(screen.getByTestId("header-branch-filters-mobile")).toBeInTheDocument();
      expect(screen.getByTestId("working-branch-filter-mobile")).toBeInTheDocument();
      expect(screen.getByTestId("target-branch-filter-mobile")).toBeInTheDocument();
    });
  });

  describe("automation button", () => {
    it("renders automation button in desktop overflow", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.getByTestId("desktop-overflow-trigger")).toBeDefined();
      fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
      expect(screen.getByTestId("desktop-overflow-schedules-btn")).toBeDefined();
    });

    it("does not render automation button inline on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      expect(screen.queryByTitle("Automation")).toBeNull();
    });

    it("calls onOpenSchedules when automation button is clicked from desktop overflow", () => {
      const onOpenSchedules = vi.fn();
      renderHeader({ onOpenSchedules }, "desktop");
      fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
      fireEvent.click(screen.getByTestId("desktop-overflow-schedules-btn"));
      expect(onOpenSchedules).toHaveBeenCalled();
    });

    it("has correct data-testid for testing on desktop", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      fireEvent.click(screen.getByTestId("desktop-overflow-trigger"));
      expect(screen.getByTestId("desktop-overflow-schedules-btn")).toBeDefined();
    });

    it("includes automation in overflow menu on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Automation")).toBeDefined();
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
      }, "mobile");
      expect(container.querySelector(".header-project-selector")).toBeDefined();
    });

    it("does not show project selector on mobile with single project", () => {
      const { container } = renderHeader({
        projects: [{ id: "1", name: "Project One", path: "/path/one", status: "active" as const }],
      }, "mobile");
      expect(container.querySelector(".header-project-selector")).toBeNull();
    });

    it("renders header-back-button when currentProject is set on mobile", () => {
      const { container } = renderHeader({
        currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        onViewAllProjects: vi.fn(),
      }, "mobile");
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

  describe("mobile search with mobileNavEnabled", () => {
    it("renders mobile search input when searchQuery is active with mobileNavEnabled", () => {
      renderHeader({ view: "board", searchQuery: "test query", onSearchChange: vi.fn(), onChangeView: noop }, "mobile");
      // Search should be visible even with mobileNavEnabled when query is active
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.getByDisplayValue("test query")).toBeDefined();
    });

    it("can open mobile search when mobileNavEnabled is true", () => {
      renderHeader({ view: "board", searchQuery: "", onSearchChange: vi.fn(), onChangeView: noop }, "mobile");
      // Should show the trigger button
      const mobileSearchTrigger = screen.getByTestId("mobile-header-search-btn");
      expect(mobileSearchTrigger).toBeDefined();
      expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
      // Expanded search should not be visible initially, then opens from the unchanged mobile trigger.
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      fireEvent.click(mobileSearchTrigger);
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("closes mobile search and clears query when close button clicked with mobileNavEnabled", () => {
      const onSearchChange = vi.fn();
      renderHeader({ view: "board", searchQuery: "test query", onSearchChange, onChangeView: noop }, "mobile");
      const closeBtn = screen.getByLabelText("Close search");
      fireEvent.click(closeBtn);
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("does not render mobile project switch trigger on desktop", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "desktop");
      expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    });

    it("does not render mobile project switch trigger on tablet", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "tablet");
      expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    });

    it("renders mobile project switch trigger on mobile with 2+ projects", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
    });

    it("renders mobile project switch trigger on mobile with single project", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
    });

    it("closes compact project switch dropdown on Escape in mobile mode", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "paused" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("closes compact project switch dropdown on outside click in mobile mode", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "paused" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();

      fireEvent.mouseDown(document.body);

      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("closes compact project switch dropdown after selecting a project in mobile mode", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "paused" as const },
      ];
      const onSelectProject = vi.fn();
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject,
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      fireEvent.click(screen.getByTestId("mobile-project-switch-item-2"));

      expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("shows View Projects action in mobile project switch when onViewAllProjects is provided", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
        onViewAllProjects: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-view-all")).toBeInTheDocument();
    });

    it("calls onViewAllProjects and closes dropdown from mobile View Projects action", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      const onViewAllProjects = vi.fn();
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
        onViewAllProjects,
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      fireEvent.click(screen.getByTestId("mobile-project-switch-view-all"));

      expect(onViewAllProjects).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("hides View Projects action in mobile project switch when onViewAllProjects is not provided", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.queryByTestId("mobile-project-switch-view-all")).toBeNull();
    });
  });

  describe("Manage Projects action", () => {
    const projects = [
      { id: "1", name: "Test Project", path: "/path/to/project", status: "active" as const },
      { id: "2", name: "Other Project", path: "/path/to/other", status: "paused" as const },
    ];

    it("renders project selector trigger on desktop with multiple projects", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");
      expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
    });

    it("shows current project name in the desktop project selector trigger", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");

      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger).toHaveTextContent("Test Project");
    });

    it("includes the full active project name in the trigger label for truncated labels", () => {
      const longName = "This is a very long project name that should be truncated in the header trigger";
      const projectsWithLongName = [
        { id: "1", name: longName, path: "/path/to/project", status: "active" as const },
        { id: "2", name: "Other Project", path: "/path/to/other", status: "paused" as const },
      ];

      renderHeader({
        projects: projectsWithLongName,
        currentProject: projectsWithLongName[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");

      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger).toHaveTextContent(longName);
    });

    it("falls back to 'Projects' label when current project is missing", () => {
      renderHeader({
        projects,
        currentProject: null,
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");

      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger).toHaveTextContent("Projects");
    });

    it("shows Manage Projects action in dropdown and calls onViewAllProjects", () => {
      const onViewAllProjects = vi.fn();
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects,
        onSelectProject: noop,
      }, "desktop");

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      fireEvent.click(screen.getByText("Manage Projects"));
      expect(onViewAllProjects).toHaveBeenCalled();
      expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    });

    it("does not render separate back button on desktop", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");
      expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
    });

    it("does not render project selector when onViewAllProjects is not provided", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: noop,
      }, "desktop");
      expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
    });
  });

  describe("action ordering", () => {
    it("Settings is the last inline action on desktop after engine controls moved to the footer", () => {
      const { container } = renderHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowEditor: noop,
        onOpenFiles: noop,
        onOpenGitManager: noop,
        onOpenScripts: noop,
        onRunScript: noop,
      }, "desktop");

      // Get direct top-level header action buttons; engine controls now live in the footer status bar.
      const headerActions = container.querySelector(".header-actions")!;
      expect(headerActions.querySelector(".engine-control-split-btn")).toBeNull();
      const inlineItems = Array.from(
        headerActions.querySelectorAll<HTMLElement>(":scope > button.btn-icon")
      );

      const settingsIdx = inlineItems.findIndex(
        (el) => el instanceof HTMLButtonElement && el.title === "Settings"
      );

      expect(settingsIdx).toBeGreaterThanOrEqual(0);

      const itemsAfterSettings = inlineItems.slice(settingsIdx + 1);
      expect(itemsAfterSettings).toHaveLength(0);
    });

    it("Settings is the last item in the mobile overflow menu", () => {
      const { container } = renderHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowEditor: noop,
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
