import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Header, resolveReportContextRefs } from "../Header";

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
  it("derives report context from task hash routes and legacy query parameters", () => {
    expect(resolveReportContextRefs({ hash: "#/tasks/FN-8277", search: "?agentId=agent-1" })).toEqual({ taskId: "FN-8277", agentId: "agent-1" });
    expect(resolveReportContextRefs({ hash: "", search: "?taskId=FN-8277" })).toEqual({ taskId: "FN-8277", agentId: undefined });
    expect(resolveReportContextRefs({ hash: "#/command-center", search: "" })).toBeUndefined();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchScripts.mockResolvedValue({});
  });

  it("renders the logo and brand", () => {
    renderHeader();
    expect(screen.getByText("Fusion")).toBeDefined();
  });

  it.each(["desktop", "tablet", "mobile"] as const)("does not render the relocated Report affordance in the %s header", (tier) => {
    renderHeader({}, tier);
    expect(screen.queryByRole("button", { name: "Report" })).toBeNull();
    expect(screen.queryByText("Report bug")).toBeNull();
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

  it("renders desktop non-tool action buttons without toolbar tools", () => {
    renderHeader();
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
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

  it("keeps GitHub import in compact overflow for mobile shell host", () => {
    renderHeader({ shellHost: { kind: "mobile-shell" } }, "mobile");
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByText("Import from GitHub")).toBeDefined();
  });

  it("calls onOpenSettings when settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    renderHeader({ onOpenSettings });
    fireEvent.click(screen.getByTitle("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("does not render the desktop files button", () => {
    renderHeader({ onOpenFiles: vi.fn() }, "desktop");
    expect(screen.queryByTestId("files-toggle-btn")).toBeNull();
  });

  it("does not render the desktop GitHub import button", () => {
    renderHeader({ onOpenGitHubImport: vi.fn() }, "desktop");
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
  });

  it("does not render the desktop Git Manager button", () => {
    renderHeader({ onOpenGitManager: noop, stashOrphanCount: 5 }, "desktop");
    expect(screen.queryByTestId("git-manager-btn")).toBeNull();
  });

  it("shows the stash orphan badge on the compact Git Manager overflow item", () => {
    renderHeader({ onOpenGitManager: noop, stashOrphanCount: 6 }, "mobile");
    fireEvent.click(screen.getByTitle("More header actions"));
    const item = screen.getByTestId("overflow-git-btn");
    expect(item).toHaveTextContent("Git Manager");
    expect(item.querySelector(".btn-badge")?.textContent).toBe("6");
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

    it("renders the workflow portal slot in the mobile top header when mobile nav owns view switching", () => {
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true, mobileNavEnabled: true }, "mobile");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      expect(workflowSlot).toBeInTheDocument();
      expect(workflowSlot).toHaveClass("header-workflow-slot--mobile");
      expect(workflowSlot.closest(".header-left")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-view-toggle-board")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-view-toggle-list")).toBeInTheDocument();
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

    it("does not render the retired Stash Recovery view overflow item", () => {
      renderHeader({ onChangeView: noop, todosEnabled: true, stashOrphanCount: 4 });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-stash-recovery")).toBeNull();
    });

    it.each(["desktop", "tablet"] as const)("keeps More views as a chevron dropdown instead of a right-dock toggle on %s", (tier) => {
      renderHeader({ onChangeView: noop, todosEnabled: true }, tier);

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(trigger.querySelector(".lucide-panel-right")).toBeNull();
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      expect(trigger).not.toHaveAttribute("aria-pressed");
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "More views" })).toBeInTheDocument();
    });

    it.each(["desktop", "tablet"] as const)("renders no duplicate Header right-dock toggle when left sidebar hides view nav on %s", (tier) => {
      renderHeader({
        onChangeView: noop,
        leftSidebarNavActive: true,
        todosEnabled: true,
      }, tier);

      expect(screen.queryByTestId("view-toggle-overflow-trigger")).toBeNull();
      expect(document.querySelector(".header-right-dock-toggle")).toBeNull();
    });

    it("keeps the legacy chevron dropdown on mobile", () => {
      renderHeader({
        onChangeView: noop,
        mobileNavEnabled: false,
      }, "mobile");

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(trigger.querySelector(".lucide-panel-right")).toBeNull();
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      fireEvent.click(trigger);
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

    it("renders hosted roadmaps primary item when roadmap plugin view is present", () => {
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

      expect(screen.getByTestId("view-toggle-plugin-fusion-plugin-roadmap-roadmaps")).toBeInTheDocument();
    });

    it("shows Compound Engineering in sidebar-off header navigation and removes it after disable and uninstall", () => {
      const compoundEngineeringView = [{
        pluginId: "fusion-plugin-compound-engineering",
        view: {
          viewId: "compound-engineering",
          label: "Compound Engineering",
          componentPath: "./CompoundEngineeringView",
          icon: "Boxes",
          placement: "primary" as const,
          order: 36,
        },
      }];
      const rendered = renderHeader({
        onChangeView: noop,
        leftSidebarNavActive: false,
        pluginDashboardViews: compoundEngineeringView,
      });
      const testId = "view-toggle-plugin-fusion-plugin-compound-engineering-compound-engineering";

      expect(screen.getByTestId(testId)).toBeInTheDocument();
      rendered.rerender(<Header onOpenSettings={noop} onOpenGitHubImport={noop} onChangeView={noop} leftSidebarNavActive={false} pluginDashboardViews={[]} />);
      expect(screen.queryByTestId(testId)).toBeNull();

      rendered.rerender(<Header onOpenSettings={noop} onOpenGitHubImport={noop} onChangeView={noop} leftSidebarNavActive={false} pluginDashboardViews={compoundEngineeringView} />);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      rendered.rerender(<Header onOpenSettings={noop} onOpenGitHubImport={noop} onChangeView={noop} leftSidebarNavActive={false} pluginDashboardViews={[]} />);
      expect(screen.queryByTestId(testId)).toBeNull();
    });

    it("renders view overflow trigger when an experimental overflow feature is enabled", () => {
      renderHeader({ onChangeView: noop, experimentalFeatures: { insights: true } });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("keeps desktop Artifacts and Command Center inline without Command Center overflow", () => {
      renderHeader({ onChangeView: noop, showAgentsTab: true }, "desktop");

      expect(screen.getByTitle("Artifacts view")).toBeInTheDocument();
      const agentsButton = screen.getByTitle("Agents view");
      const commandCenterButton = screen.getByTestId("view-toggle-command-center");
      expect(commandCenterButton.previousElementSibling).toBe(agentsButton);

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-command-center")).toBeNull();
      expect(screen.queryByTestId("view-overflow-documents")).toBeNull();
    });

    it("promotes Command Center after Agents and moves Artifacts to overflow on tablet", () => {
      renderHeader({ onChangeView: noop, showAgentsTab: true }, "tablet");

      const agentsButton = screen.getByTitle("Agents view");
      const commandCenterButton = screen.getByTestId("view-toggle-command-center");
      expect(commandCenterButton.previousElementSibling).toBe(agentsButton);
      expect(screen.queryByTitle("Artifacts view")).toBeNull();

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.getByTestId("view-overflow-documents")).toHaveTextContent("Artifacts view");
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

    it("gates Ideation in the desktop overflow and routes the enabled fallback", () => {
      const hidden = renderHeader({ onChangeView: noop, experimentalFeatures: { ideationView: false } });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-ideation")).toBeNull();
      hidden.unmount();

      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "ideation", experimentalFeatures: { ideationView: true } });
      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger).toHaveClass("active");
      fireEvent.click(trigger);
      fireEvent.click(screen.getByTestId("view-overflow-ideation"));
      expect(onChangeView).toHaveBeenCalledWith("ideation");
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

  describe("terminal launcher relocation", () => {
    it("does not render the terminal launcher or scripts chevron in the desktop header", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "desktop");
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
      expect(screen.queryByTestId("terminal-split-btn")).toBeNull();
    });

    it("does not render terminal launcher affordances in the mobile header overflow", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
      expect(screen.queryByTestId("terminal-split-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-primary-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-submenu-toggle")).toBeNull();
    });
  });

  describe("files button", () => {
    it("does not render files button on desktop when handler is provided", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
      expect(screen.queryByTestId("files-toggle-btn")).toBeNull();
    });

    it("does not render files button on desktop when handler is omitted", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
    });

    it("does not call onOpenFiles from the removed desktop files button", () => {
      const onOpenFiles = vi.fn();
      renderHeader({ onOpenFiles }, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
      expect(onOpenFiles).not.toHaveBeenCalled();
    });

    it("does not render an active files shell when files modal is open on desktop", () => {
      renderHeader({ onOpenFiles: vi.fn(), filesOpen: true }, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
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

    it("renders the header usage button to the left of the right-dock toggle on desktop when onOpenUsage is provided", () => {
      renderHeader({ onOpenUsage: vi.fn(), rightDockAvailable: true, onToggleRightDock: noop }, "desktop");
      const usageBtn = screen.getByTestId("header-usage-btn");
      expect(usageBtn.getAttribute("title")).toBe("View usage");
      // Retired legacy toolbar testid stays gone.
      expect(screen.queryByTestId("desktop-header-usage-btn")).toBeNull();
      // Sits immediately to the left of the right-dock toggle.
      expect(usageBtn.nextElementSibling).toBe(screen.getByTestId("header-right-dock-toggle"));
    });

    it("fires onOpenUsage with button bounds from the desktop header usage button", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "desktop");
      const usageBtn = screen.getByTestId("header-usage-btn") as HTMLButtonElement;
      const mockRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      usageBtn.getBoundingClientRect = vi.fn(() => mockRect);
      fireEvent.click(usageBtn);
      expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
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

    it("does not call onOpenUsage from the removed desktop toolbar button", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "desktop");
      expect(screen.queryByTestId("desktop-header-usage-btn")).toBeNull();
      expect(onOpenUsage).not.toHaveBeenCalled();
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

    it("does not render activity log button inline on desktop when onOpenActivityLog is provided", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "desktop");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
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

    it("does not call onOpenActivityLog from the removed desktop toolbar button", () => {
      const onOpenActivityLog = vi.fn();
      renderHeader({ onOpenActivityLog }, "desktop");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
      expect(onOpenActivityLog).not.toHaveBeenCalled();
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
    it("does not render legacy planning affordances in the header on desktop", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
      expect(screen.queryByTitle("Resume planning session")).toBeNull();
      expect(screen.queryByTestId("planning-btn")).toBeNull();
      expect(screen.queryByTestId("planning-badge")).toBeNull();
    });

    it("does not render legacy planning affordances in the header on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
      expect(screen.queryByTestId("overflow-planning-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-planning-badge")).toBeNull();
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

    it("does not render terminal or scripts affordances in mobile header overflow", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-terminal-primary-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-submenu-toggle")).toBeNull();
      expect(screen.queryByTestId("overflow-scripts-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-scripts-manage")).toBeNull();
    });

    it("shows GitHub import in overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Import from GitHub")).toBeDefined();
    });

    it("keeps Mailbox in the compact overflow with unread and approval badges", () => {
      const onOpenMailbox = vi.fn();
      renderHeader({ onOpenMailbox, mailboxUnreadCount: 3, mailboxPendingApprovalCount: 2 }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      const mailboxButton = screen.getByTestId("overflow-mailbox-btn");
      expect(mailboxButton).toHaveTextContent("Mailbox (3)");
      expect(screen.getByTestId("overflow-mailbox-approval-badge")).toHaveTextContent("2");

      fireEvent.click(mailboxButton);
      expect(onOpenMailbox).toHaveBeenCalledTimes(1);
    });

    it("keeps compact overflow tool ordering from before terminal moved to the footer launcher", () => {
      renderHeader({ onOpenGitManager: noop, onOpenSchedules: noop, onOpenActivityLog: noop, onOpenMailbox: noop, onOpenUsage: noop, onOpenWorkflowEditor: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      const menu = screen.getByRole("menu", { name: "Additional header actions" });
      const orderedItems = [
        "overflow-git-btn",
        "overflow-schedules-btn",
        "overflow-activity-log-btn",
        "overflow-mailbox-btn",
        "overflow-usage-btn",
        "overflow-workflow-steps-btn",
      ].map((testId) => screen.getByTestId(testId));

      expect(menu).toContainElement(orderedItems[0]);
      for (let index = 1; index < orderedItems.length; index += 1) {
        expect(orderedItems[index - 1].compareDocumentPosition(orderedItems[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it("omits planning from the header overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-planning-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-planning-badge")).toBeNull();
      expect(screen.queryByText("Create a task with AI planning")).toBeNull();
      expect(screen.queryByText("Resume planning session (1)")).toBeNull();
    });

    it("shows settings in overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Settings")).toBeDefined();
    });
  });

  describe("nodes button", () => {
    it("omits the empty desktop overflow trigger after Nodes and Automation moved elsewhere", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTestId("desktop-overflow-trigger")).toBeNull();
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
      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
    });

    it("clears search query when close button is clicked", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      fireEvent.click(screen.getByLabelText("Close search"));
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("restores the board search open button after closing a populated query and parent clear", () => {
      const onSearchChange = vi.fn();
      const { rerender } = renderHeader({ onSearchChange, view: "board", searchQuery: "blocked" });

      expect(screen.getByDisplayValue("blocked")).toBeInTheDocument();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();

      fireEvent.click(screen.getByLabelText("Close search"));
      expect(onSearchChange).toHaveBeenCalledWith("");
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();

      mockMatchMedia("desktop");
      rerender(
        <Header
          onOpenSettings={noop}
          onOpenGitHubImport={noop}
          onSearchChange={onSearchChange}
          view="board"
          searchQuery=""
        />
      );

      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      expect(screen.getAllByRole("button", { name: "Open search" })).toHaveLength(1);
      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
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

    it("hides the open toggle while search is open and restores it after close", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
      fireEvent.click(screen.getByLabelText("Close search"));
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
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
    it("does not render automation in a desktop overflow shell", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.queryByTestId("desktop-overflow-trigger")).toBeNull();
      expect(screen.queryByTestId("desktop-overflow-schedules-btn")).toBeNull();
    });

    it("does not render automation button inline on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      expect(screen.queryByTitle("Automation")).toBeNull();
    });

    it("does not call onOpenSchedules from the removed desktop overflow", () => {
      const onOpenSchedules = vi.fn();
      renderHeader({ onOpenSchedules }, "desktop");
      expect(screen.queryByTestId("desktop-overflow-schedules-btn")).toBeNull();
      expect(onOpenSchedules).not.toHaveBeenCalled();
    });

    it("removes the desktop automation data-testid with the empty overflow trigger", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.queryByTestId("desktop-overflow-schedules-btn")).toBeNull();
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
      renderHeader({ view: "board", searchQuery: "", onSearchChange: vi.fn(), onChangeView: noop, mobileNavEnabled: true }, "mobile");
      // Should show the trigger button
      const mobileSearchTrigger = screen.getByTestId("mobile-header-search-btn");
      expect(mobileSearchTrigger).toBeDefined();
      expect(screen.getByTestId("header-workflow-slot")).toBeInTheDocument();
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
    it("places only the Usage button after Settings on desktop after engine controls moved to the footer", () => {
      /*
      FNXC:Navigation 2026-06-22-12:00:
      Usage moved back to the top header (left of the right-dock toggle), so it now renders after Settings in the inline header actions. Settings is the last inline action ONLY among the primary controls; the trailing Usage button (and the right-dock toggle when available) intentionally follow it.
      */
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
      // Only the relocated Usage button trails Settings (no right-dock toggle without rightDockAvailable).
      expect(itemsAfterSettings.map((el) => el.getAttribute("data-testid"))).toEqual(["header-usage-btn"]);
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

  /*
  FNXC:DashboardHeader 2026-07-08-00:00:
  FN-7687 regression: the top header must stay structurally single-line at mobile widths
  regardless of which mobile-only children are mounted (project switch, workflow slot,
  view toggle, search/usage triggers) — the row must never rely on the CSS width media
  query alone to prevent wrapping, since a foldable's layout viewport can lag its
  visualViewport pane during a fold/unfold/refold resize. Assert the computed
  `flex-wrap: nowrap` + shrink/min-width-0 contract across populated and empty data states.
  */
  describe("single-line header layout (FN-7687)", () => {
    const projects = [
      { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
    ];

    function assertSingleLineContract(container: HTMLElement) {
      const header = container.querySelector(".header");
      const headerLeft = container.querySelector(".header-left");
      const headerActions = container.querySelector(".header-actions");
      expect(header).not.toBeNull();
      expect(headerLeft).not.toBeNull();
      expect(headerActions).not.toBeNull();

      const headerStyle = window.getComputedStyle(header!);
      expect(headerStyle.flexWrap).toBe("nowrap");
      expect(headerStyle.display).toBe("flex");

      const leftStyle = window.getComputedStyle(headerLeft!);
      expect(leftStyle.minWidth).toBe("0px");
      expect(leftStyle.flexShrink).toBe("1");

      const actionsStyle = window.getComputedStyle(headerActions!);
      expect(actionsStyle.minWidth).toBe("0px");
      expect(actionsStyle.flexGrow).toBe("0");
    }

    it("enforces the single-line contract on mobile with no project and no workflow slot", () => {
      const { container } = renderHeader({}, "mobile");
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on mobile with a selected project (mobile project switch present)", () => {
      const { container } = renderHeader(
        { projects, currentProject: projects[0], onSelectProject: vi.fn() },
        "mobile",
      );
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on mobile with the workflow slot populated", () => {
      const { container } = renderHeader(
        { onChangeView: noop, leftSidebarNavActive: true, mobileNavEnabled: true },
        "mobile",
      );
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      // Simulate the board/list workflow portal rendering content into the slot.
      workflowSlot.innerHTML = '<div class="board-workflow-toolbar"><button class="workflow-switcher-trigger">Coding</button></div>';
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on mobile with search open and mobile nav active", () => {
      const { container } = renderHeader(
        { onSearchChange: vi.fn(), onChangeView: noop, mobileNavEnabled: true },
        "mobile",
      );
      fireEvent.click(screen.getByTestId("mobile-header-search-btn"));
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on desktop and tablet (non-mobile) as well", () => {
      const desktop = renderHeader({}, "desktop");
      assertSingleLineContract(desktop.container);

      const tablet = renderHeader({}, "tablet");
      assertSingleLineContract(tablet.container);
    });
  });
});
