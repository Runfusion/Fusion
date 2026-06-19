import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

import { fetchScripts } from "../../api";

function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === MOBILE_MEDIA_QUERY || query.includes("max-width: 768px");
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

const createDefaultProps = () => ({
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  modalOpen: false,
  onOpenSettings: vi.fn(),
  onOpenActivityLog: vi.fn(),
  onOpenMailbox: vi.fn(),
  onOpenNodes: vi.fn(),
  mailboxUnreadCount: 0,
  mailboxPendingApprovalCount: 0,
  onOpenGitManager: vi.fn(),
  onOpenWorkflowEditor: vi.fn(),
  onOpenSchedules: vi.fn(),
  onOpenScripts: vi.fn(),
  onToggleTerminal: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenGitHubImport: vi.fn(),
  onOpenPlanning: vi.fn(),
  onResumePlanning: vi.fn(),
  activePlanningSessionCount: 0,
  onOpenUsage: vi.fn(),
  onViewAllProjects: vi.fn(),
  onRunScript: vi.fn(),
  projectId: "proj_1",
});

describe("MobileNavBar", () => {
  beforeEach(() => {
    mockViewport("mobile");
  });

  it("renders eight tab buttons (tasks + agents + missions + chat + mailbox + command center + skills + more) when showSkillsTab is true", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={true} />);

    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-agents")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-missions")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-chat")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-command-center")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-skills")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more")).toBeDefined();
  });

  it("does not render legacy roadmaps tab", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();
  });

  it("keeps skills available without rendering legacy roadmaps destinations", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={true} experimentalFeatures={{}} />);

    expect(screen.getByTestId("mobile-nav-tab-skills")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
  });

  it("keeps skills top-level regardless of legacy roadmaps view value", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" showSkillsTab={true} experimentalFeatures={{}} />);

    expect(screen.getByTestId("mobile-nav-tab-skills")).toBeDefined();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-skills")).toBeNull();
  });

  it("does not render skills tab when showSkillsTab is false", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={false} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
  });

  it("does not render skills tab when showSkillsTab is omitted", () => {
    render(<MobileNavBar {...createDefaultProps()} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
  });

  it("keeps Todos in the mobile More sheet when todoView is enabled", () => {
    const onOpenTodos = vi.fn();
    render(
      <MobileNavBar
        {...createDefaultProps()}
        onOpenTodos={onOpenTodos}
        experimentalFeatures={{ todoView: true }}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-todos"));

    expect(onOpenTodos).toHaveBeenCalled();
  });

  it("shows secrets in More and routes to secrets view", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-secrets"));

    expect(props.onChangeView).toHaveBeenCalledWith("secrets");
  });

  it("shows mailbox pending-approval indicator when mailbox tab is inactive", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxPendingApprovalCount={2} />);
    expect(screen.getByLabelText("Pending approvals")).toBeInTheDocument();
  });

  it("hides mailbox pending-approval indicator when mailbox tab is active", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxPendingApprovalCount={2} view="mailbox" />);
    expect(screen.queryByLabelText("Pending approvals")).toBeNull();
  });

  it("keeps dependency graph in More and routes to canonical graph task view", () => {
    const props = createDefaultProps();
    render(
      <MobileNavBar
        {...props}
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", icon: "Map", placement: "more" },
          },
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "queue", label: "Queue", componentPath: "./QueueView", icon: "Workflow" },
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-dependency-graph-graph")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    const graphItem = screen.getByTestId("mobile-more-item-plugin-fusion-plugin-dependency-graph-graph");
    fireEvent.click(graphItem);
    expect(props.onChangeView).toHaveBeenCalledWith("graph");

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    const overflowItem = screen.getByTestId("mobile-more-item-plugin-fusion-plugin-dependency-graph-queue");
    expect(overflowItem.querySelector(".lucide-workflow")).toBeTruthy();
    fireEvent.click(overflowItem);
    expect(props.onChangeView).toHaveBeenCalledWith("plugin:fusion-plugin-dependency-graph:queue");
  });

  it("demotes primary plugin tabs on mobile and renders them in More", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", icon: "Map", placement: "primary", order: 1 },
          },
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "queue", label: "Queue", componentPath: "./QueueView", icon: "Workflow", placement: "primary", order: 2 },
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-dependency-graph-graph")).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-dependency-graph-queue")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-plugin-fusion-plugin-dependency-graph-graph")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-plugin-fusion-plugin-dependency-graph-queue")).toBeDefined();
  });

  it("marks More active when current view is graph", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        view="graph"
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", icon: "Map", placement: "more" },
          },
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "queue", label: "Queue", componentPath: "./QueueView", icon: "Workflow" },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("mobile-nav-tab-more").className).toContain("mobile-nav-tab--active");
  });

  it("marks More active when current plugin view is overflow-only", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        view="plugin:fusion-plugin-dependency-graph:queue"
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", icon: "Map", placement: "more" },
          },
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "queue", label: "Queue", componentPath: "./QueueView", icon: "Workflow" },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("mobile-nav-tab-more").className).toContain("mobile-nav-tab--active");
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-dependency-graph-graph")).toBeNull();
  });

  it("active tab is highlighted for mailbox", () => {
    render(<MobileNavBar {...createDefaultProps()} view="mailbox" />);
    expect(screen.getByTestId("mobile-nav-tab-mailbox").className).toContain("mobile-nav-tab--active");
  });

  it("mailbox tab calls onChangeView with 'mailbox'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-mailbox"));
    expect(props.onChangeView).toHaveBeenCalledWith("mailbox");
  });

  it("places Command Center immediately after Mailbox and routes from the top-level tab", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" mailboxUnreadCount={3} mailboxPendingApprovalCount={1} />);

    const mailboxTab = screen.getByTestId("mobile-nav-tab-mailbox");
    const commandCenterTab = screen.getByTestId("mobile-nav-tab-command-center");
    expect(mailboxTab.compareDocumentPosition(commandCenterTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commandCenterTab.previousElementSibling).toBe(mailboxTab);

    fireEvent.click(commandCenterTab);
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-command-center")).toBeNull();
  });

  it("agents tab calls onChangeView with 'agents'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-agents"));
    expect(props.onChangeView).toHaveBeenCalledWith("agents");
  });

  it("agents tab is active when view is 'agents'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="agents" />);
    expect(screen.getByTestId("mobile-nav-tab-agents").className).toContain("mobile-nav-tab--active");
  });

  it("shows mailbox unread badge when mailboxUnreadCount > 0", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={5} />);
    const badge = screen.getByTestId("mobile-nav-tab-mailbox").querySelector(".mobile-nav-tab-badge");
    expect(badge).toBeDefined();
    expect(badge?.textContent).toBe("5");
  });

  it("shows matching mailbox unread badge in the More sheet", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={7} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    const moreItemBadge = screen.getByTestId("mobile-more-item-mailbox").querySelector(".mobile-more-item-badge");
    expect(moreItemBadge).toBeDefined();
    expect(moreItemBadge?.className).toContain("mobile-more-item-badge--unread");
    expect(moreItemBadge?.textContent).toBe("7");
  });

  it("tasks tab calls onChangeView with 'board' when coming from a non-tasks view", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="missions" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("board");
  });

  it("tasks tab calls onChangeView with 'board' when already on board", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("board");
  });

  it("tasks tab calls onChangeView with 'list' when already on list", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="list" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("list");
  });

  it("tasks tab is active when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" />);
    expect(screen.getByTestId("mobile-nav-tab-tasks").className).toContain("mobile-nav-tab--active");
  });

  it("tasks tab is active when view is 'list'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="list" />);
    expect(screen.getByTestId("mobile-nav-tab-tasks").className).toContain("mobile-nav-tab--active");
  });

  it("missions tab calls onChangeView with 'missions'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-missions"));
    expect(props.onChangeView).toHaveBeenCalledWith("missions");
  });

  it("missions tab is active when view is 'missions'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="missions" />);
    expect(screen.getByTestId("mobile-nav-tab-missions").className).toContain("mobile-nav-tab--active");
  });

  it("missions tab is not active when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" />);
    expect(screen.getByTestId("mobile-nav-tab-missions").className).not.toContain("mobile-nav-tab--active");
  });

  it("shows chat unread indicator when chatHasUnreadResponse is true and chat tab is inactive", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" chatHasUnreadResponse={true} />);
    expect(screen.getByLabelText("Unread chat response")).toBeInTheDocument();
  });

  it("hides chat unread indicator when chat tab is active", () => {
    render(<MobileNavBar {...createDefaultProps()} view="chat" chatHasUnreadResponse={true} />);
    expect(screen.queryByLabelText("Unread chat response")).toBeNull();
  });

  it("skills tab calls onChangeView with 'skills'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" showSkillsTab={true} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-skills"));
    expect(props.onChangeView).toHaveBeenCalledWith("skills");
  });

  it("skills tab is active when view is 'skills'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="skills" showSkillsTab={true} />);
    expect(screen.getByTestId("mobile-nav-tab-skills").className).toContain("mobile-nav-tab--active");
  });

  it("skills tab is not active when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" showSkillsTab={true} />);
    expect(screen.getByTestId("mobile-nav-tab-skills").className).not.toContain("mobile-nav-tab--active");
  });

  it("opens and toggles the more sheet", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("renders shell connection control in More sheet when provided", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        shellConnectionControl={<button type="button">Manage connections</button>}
      />,
    );
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    expect(screen.getByTestId("mobile-more-shell-connection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage connections" })).toBeInTheDocument();
  });

  it("sheet contains expected navigation items including activity log", () => {
    render(<MobileNavBar {...createDefaultProps()} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    expect(screen.getByTestId("mobile-more-item-mailbox")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-activity")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-git")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-terminal")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-files")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-planning")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-workflow")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-schedules")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-github")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-usage")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-projects")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-command-center")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-chat")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-insights")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-settings")).toBeDefined();
  });

  it("does not show legacy roadmaps in more sheet", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
  });

  it("renders Compound Engineering primary plugin only in the More sheet while Command Center follows Mailbox", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-compound-engineering",
            view: { viewId: "compound-engineering", label: "Compound Engineering", componentPath: "./CompoundEngineeringView", icon: "Sparkles", placement: "primary", order: 36 },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("mobile-nav-tab-command-center").previousElementSibling).toBe(screen.getByTestId("mobile-nav-tab-mailbox"));
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-compound-engineering-compound-engineering")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-plugin-fusion-plugin-compound-engineering-compound-engineering")).toBeDefined();
    expect(screen.queryAllByTestId("mobile-more-item-plugin-fusion-plugin-compound-engineering-compound-engineering")).toHaveLength(1);
    expect(screen.queryByTestId("mobile-more-item-command-center")).toBeNull();
  });

  it("suppresses legacy roadmaps entries when roadmap plugin view is registered", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        experimentalFeatures={{}}
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-roadmap",
            view: { viewId: "roadmaps", label: "Roadmaps", componentPath: "./RoadmapsView", icon: "Map", placement: "primary" },
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
  });

  it("shows insights in more sheet when experimentalFeatures.insights is true", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ insights: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-insights")).toBeDefined();
  });

  it("shows research in more sheet when experimentalFeatures.researchView is true", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ researchView: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-research")).toBeDefined();
  });

  it("does not show research in more sheet when experimentalFeatures.researchView is false", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ researchView: false }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-research")).toBeNull();
  });

  it("shows nodes in more sheet only when nodesView is enabled", () => {
    const disabledProps = createDefaultProps();
    const { unmount } = render(<MobileNavBar {...disabledProps} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-nodes")).toBeNull();
    unmount();

    const enabledProps = createDefaultProps();
    render(<MobileNavBar {...enabledProps} experimentalFeatures={{ nodesView: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-nodes")).toBeDefined();
  });

  it("invokes onOpenNodes when nodes item is tapped", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} experimentalFeatures={{ nodesView: true }} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-nodes"));

    expect(props.onOpenNodes).toHaveBeenCalledOnce();
  });

  it("does not show memory in more sheet when memoryView is not enabled", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-memory")).toBeNull();
  });

  it("shows memory in more sheet when memoryView is enabled", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ memoryView: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-memory")).toBeDefined();
  });

  it("insights item in more sheet calls onChangeView with 'insights'", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} experimentalFeatures={{ insights: true }} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-insights"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onChangeView).toHaveBeenCalledWith("insights");
  });

  it("research item in more sheet calls onChangeView with 'research'", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} experimentalFeatures={{ researchView: true }} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-research"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onChangeView).toHaveBeenCalledWith("research");
  });

  it("hides evals item in more sheet when evalsView is not enabled", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-evals")).toBeNull();
  });

  it("evals item in more sheet calls onChangeView with 'evals' when evalsView is enabled", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} experimentalFeatures={{ evalsView: true }} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-evals"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onChangeView).toHaveBeenCalledWith("evals");
  });

  it("gates goals item in more sheet, routes to goalsView, and marks More active on goals view", () => {
    const hidden = render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-goals")).toBeNull();
    hidden.unmount();

    const props = createDefaultProps();
    const { container } = render(
      <MobileNavBar
        {...props}
        view="goalsView"
        experimentalFeatures={{ goalsView: true }}
      />,
    );

    const moreTab = screen.getByTestId("mobile-nav-tab-more");
    expect(moreTab.className).toContain("mobile-nav-tab--active");

    fireEvent.click(moreTab);
    fireEvent.click(screen.getByTestId("mobile-more-item-goals"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onChangeView).toHaveBeenCalledWith("goalsView");
  });

  it("activity log item in more sheet calls onOpenActivityLog", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-activity"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onOpenActivityLog).toHaveBeenCalledOnce();
  });

  it("closes sheet and calls handler when item is clicked", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-settings"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("calls onViewAllProjects from the Projects more-sheet item", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-projects"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onViewAllProjects).toHaveBeenCalledOnce();
  });

  it("chat remains accessible via the primary mobile tab and is absent from More", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} view="board" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-chat"));
    expect(props.onChangeView).toHaveBeenCalledWith("chat");

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();
    expect(screen.queryByTestId("mobile-more-item-chat")).toBeNull();
  });

  it("closes sheet on backdrop click", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    const backdrop = container.querySelector(".mobile-more-sheet-backdrop");
    expect(backdrop).not.toBeNull();

    fireEvent.click(backdrop!);
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("closes sheet on Escape", async () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });
  });

  it("returns null when modalOpen is true", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} modalOpen={true} />);
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  it("renders nav bar with keyboard-open class when keyboardOpen is true on mobile", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} keyboardOpen={true} />);
    expect(container.querySelector(".mobile-nav-bar")).not.toBeNull();
    expect(container.querySelector(".mobile-nav-bar--keyboard-open")).not.toBeNull();
  });

  it("renders nav bar without keyboard-open class when keyboardOpen is false on mobile", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} keyboardOpen={false} />);
    expect(container.querySelector(".mobile-nav-bar")).not.toBeNull();
    expect(container.querySelector(".mobile-nav-bar--keyboard-open")).toBeNull();
  });

  it("applies footer-visible class when footer is shown", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} footerVisible={true} />);
    expect(container.querySelector(".mobile-nav-bar--with-footer")).not.toBeNull();
  });

  it("returns null on desktop viewport", () => {
    mockViewport("desktop");
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  describe("scripts submenu", () => {
    beforeEach(() => {
      vi.mocked(fetchScripts).mockReset();
    });

    it("terminal item has a split toggle that opens scripts submenu", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({});
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      const toggle = screen.getByTestId("mobile-more-terminal-split-toggle");
      expect(toggle).toBeDefined();

      fireEvent.click(toggle);
      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-scripts-manage")).toBeDefined();
      });
    });

    it("scripts are fetched when submenu opens", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({
        build: "pnpm build",
        test: "pnpm test",
      });
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-script-item-build")).toBeDefined();
        expect(screen.getByTestId("mobile-more-script-item-test")).toBeDefined();
      });
    });

    it("clicking a script item calls onRunScript and closes sheet", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({
        build: "pnpm build",
      });
      const props = createDefaultProps();
      const { container } = render(<MobileNavBar {...props} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-script-item-build")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("mobile-more-script-item-build"));
      expect(props.onRunScript).toHaveBeenCalledWith("build", "pnpm build");
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("manage scripts button calls onOpenScripts and closes sheet", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({
        build: "pnpm build",
      });
      const props = createDefaultProps();
      const { container } = render(<MobileNavBar {...props} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-scripts-manage")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("mobile-more-scripts-manage"));
      expect(props.onOpenScripts).toHaveBeenCalledOnce();
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("empty scripts state shows 'No scripts' item", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({});
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        const manageBtn = screen.getByTestId("mobile-more-scripts-manage");
        expect(manageBtn).toBeDefined();
        expect(manageBtn.textContent).toContain("No scripts — add one…");
      });
    });

    it("loading state shows spinner while fetching", async () => {
      let resolveFetch!: (value: Record<string, string>) => void;
      vi.mocked(fetchScripts).mockImplementation(
        () => new Promise((resolve) => { resolveFetch = resolve; }),
      );
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      expect(screen.getByTestId("mobile-more-scripts-loading")).toBeDefined();

      // Resolve to clean up
      resolveFetch({});
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-more-scripts-loading")).toBeNull();
      });
    });
  });
});
