import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MobileNavBar } from "../MobileNavBar";
import { MOBILE_NAV_SELECTABLE_ITEMS } from "../../../../core/src/mobile-nav-primary-items";
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

const mobileNavCss = readFileSync(resolve(process.cwd(), "app/components/MobileNavBar.css"), "utf8");

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function getRenderedMobileTabs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".mobile-nav-bar > .mobile-nav-tab"));
}

function expectUniformMobileNavColumns(container: HTMLElement, expectedTabCount: number) {
  const tabs = getRenderedMobileTabs(container);
  expect(tabs).toHaveLength(expectedTabCount);

  const navRule = extractRuleBlock(mobileNavCss, ".mobile-nav-bar");
  expect(navRule).toContain("left: 0");
  expect(navRule).toContain("right: var(--icb-right-offset, 0px)");
  expect(navRule).toContain("padding-inline: var(--space-sm)");
  expect(navRule).toMatch(/padding-inline:\s*var\(--space-[^)]+\)/);
  expect(navRule).not.toMatch(/padding-left:\s*(?!0[;\s])/);
  expect(navRule).not.toMatch(/padding-right:\s*(?!0[;\s])/);

  const tabRule = extractRuleBlock(mobileNavCss, ".mobile-nav-tab");
  expect(tabRule).toContain("--mobile-nav-icon-size: calc(var(--space-lg) + var(--space-sm) - (var(--space-xs) / 2))");
  expect(tabRule).toContain("flex: 1 1 0");
  expect(tabRule).toContain("min-width: 0");
  expect(tabRule).toContain("align-items: center");
  expect(tabRule).toMatch(/padding:\s*[^;]+\s+0;/);
  expect(tabRule).not.toMatch(/margin-left|margin-right/);

  const iconRule = extractRuleBlock(mobileNavCss, ".mobile-nav-tab svg");
  expect(iconRule).toContain("width: var(--mobile-nav-icon-size)");
  expect(iconRule).toContain("height: var(--mobile-nav-icon-size)");

  const iconWrapperRule = extractRuleBlock(mobileNavCss, ".mobile-nav-tab-icon-wrapper");
  expect(iconWrapperRule).toContain("position: relative");
  expect(iconWrapperRule).toContain("display: flex");
  expect(iconWrapperRule).toContain("flex: 0 0 var(--mobile-nav-icon-size)");
  expect(iconWrapperRule).toContain("align-items: center");
  expect(iconWrapperRule).toContain("justify-content: center");
  expect(iconWrapperRule).toContain("width: var(--mobile-nav-icon-size)");
  expect(iconWrapperRule).toContain("height: var(--mobile-nav-icon-size)");

  const labelRule = extractRuleBlock(mobileNavCss, ".mobile-nav-tab-label");
  expect(labelRule).toContain("width: 100%");
  expect(labelRule).toContain("min-width: 0");
  expect(labelRule).toContain("text-align: center");

  for (const tab of tabs) {
    expect(tab.className).toContain("mobile-nav-tab");
    expect(tab.querySelector(".mobile-nav-tab-label")).toBeInTheDocument();
    const iconSlots = tab.querySelectorAll(":scope > .mobile-nav-tab-icon-wrapper");
    expect(iconSlots).toHaveLength(1);
    expect(tab.querySelector(":scope > svg")).toBeNull();
    expect(iconSlots[0].querySelector("svg")).toBeInTheDocument();
  }

  if (container.querySelector(".mobile-nav-tab-badge")) {
    expect(extractRuleBlock(mobileNavCss, ".mobile-nav-tab-badge")).toContain("position: absolute");
  }

  if (container.querySelector(".mobile-nav-chat-unread-dot")) {
    const dotRule = extractRuleBlock(mobileNavCss, ".mobile-nav-chat-unread-dot");
    expect(dotRule).toContain("position: absolute");
    expect(dotRule).toContain("top: 0");
    expect(dotRule).toContain("right: 0");
    expect(dotRule).not.toContain("*-1");
  }
}

const createDefaultProps = () => ({
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  modalOpen: false,
  onOpenSettings: vi.fn(),
  onOpenActivityLog: vi.fn(),
  onOpenMailbox: vi.fn(),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders seven top-level tab buttons (command center + tasks + agents + missions + chat + mailbox + more) and keeps skills in More when showSkillsTab is true", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={true} />);

    expect(screen.getByTestId("mobile-nav-tab-command-center")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-agents")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-missions")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-chat")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more")).toBeDefined();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-skills")).toBeDefined();
  });

  it("promotes Planning and routes demoted Missions to More without an empty tab", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} mobileNavPrimaryItems={["command-center", "tasks", "agents", "planning", "chat", "mailbox"]} />);
    expect(screen.getByTestId("mobile-nav-tab-planning")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-nav-tab-missions")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-missions")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="mobile-nav-tab-missions"]')).toBeNull();
  });

  it("promotes eligible settings and always keeps More", () => {
    render(<MobileNavBar {...createDefaultProps()} mobileNavPrimaryItems={["settings", "planning"]} />);
    expect(screen.getByTestId("mobile-nav-tab-settings")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-nav-tab-planning")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-nav-tab-more")).toBeInTheDocument();
  });

  it("renders every available selectable destination exactly once across tab and More", () => {
    const gated = new Set(["skills", "insights", "memory", "research", "evals", "ideation", "goals", "todos", "dev-server"]);
    const moreTestIds: Record<string, string> = { automation: "schedules", "github-import": "github", workflows: "workflow" };
    for (const item of MOBILE_NAV_SELECTABLE_ITEMS) {
      const { unmount } = render(<MobileNavBar {...createDefaultProps()} mobileNavPrimaryItems={[item]} showSkillsTab experimentalFeatures={{ insights: true, memoryView: true, researchView: true, evalsView: true, ideationView: true, goalsView: true, todoView: true, devServerView: true }} />);
      if (item === "ideation") {
        expect(screen.queryByTestId("mobile-nav-tab-ideation")).toBeNull();
        fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
        expect(screen.getAllByTestId("mobile-more-item-ideation")).toHaveLength(1);
      } else {
        expect(screen.getAllByTestId(`mobile-nav-tab-${item}`)).toHaveLength(1);
        fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
        expect(screen.queryByTestId(`mobile-more-item-${moreTestIds[item] ?? item}`)).toBeNull();
      }
      unmount();
    }
    expect(gated.size).toBe(9);
  });

  it("keeps enabled Ideation in More when persisted customization lists it", () => {
    render(<MobileNavBar {...createDefaultProps()} mobileNavPrimaryItems={["ideation"]} experimentalFeatures={{ ideationView: true }} />);

    expect(screen.queryByTestId("mobile-nav-tab-ideation")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getAllByTestId("mobile-more-item-ideation")).toHaveLength(1);
  });

  it("does not render legacy roadmaps tab", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();
  });

  it("keeps skills available in More without rendering legacy roadmaps destinations", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={true} experimentalFeatures={{}} />);

    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-skills")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
  });

  it("keeps skills in the More sheet regardless of legacy roadmaps view value", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" showSkillsTab={true} experimentalFeatures={{}} />);

    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-skills")).toBeDefined();
  });

  it("does not render skills tab when showSkillsTab is false", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={false} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
  });

  it("does not render skills tab when showSkillsTab is omitted", () => {
    render(<MobileNavBar {...createDefaultProps()} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
  });

  it("keeps every mobile tab in an equal-width column across tab, active, badge, and status-dot variants", () => {
    const sevenTabRender = render(
      <MobileNavBar
        {...createDefaultProps()}
        showSkillsTab={false}
        view="command-center"
        chatHasUnreadResponse={true}
        mailboxUnreadCount={7}
        mailboxPendingApprovalCount={2}
      />,
    );
    expectUniformMobileNavColumns(sevenTabRender.container, 7);
    expect(screen.getByTestId("mobile-nav-tab-command-center").className).toContain("mobile-nav-tab--active");
    expect(screen.getByLabelText("Unread chat response")).toBeInTheDocument();
    expect(screen.getByLabelText("Pending approvals")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-nav-tab-mailbox").querySelector(".mobile-nav-tab-badge")?.textContent).toBe("7");
    sevenTabRender.unmount();

    // Skills is never a top-level tab, so enabling it keeps the top-level column count at seven
    // and the skills destination, plus its active view, lives in the More sheet.
    const skillsEnabledRender = render(
      <MobileNavBar
        {...createDefaultProps()}
        showSkillsTab={true}
        view="skills"
        chatHasUnreadResponse={true}
        mailboxUnreadCount={101}
        mailboxPendingApprovalCount={1}
      />,
    );
    expectUniformMobileNavColumns(skillsEnabledRender.container, 7);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more").className).toContain("mobile-nav-tab--active");
    expect(screen.getByTestId("mobile-nav-tab-mailbox").querySelector(".mobile-nav-tab-badge")?.textContent).toBe("99+");
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-skills")).toBeDefined();
    skillsEnabledRender.unmount();

    const pluginVariantRender = render(
      <MobileNavBar
        {...createDefaultProps()}
        showSkillsTab={true}
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-spacing-check",
            view: { viewId: "wide", label: "Very Long Plugin Destination", componentPath: "./WidePluginView", icon: "Workflow", placement: "primary", order: 1 },
          },
        ]}
      />,
    );
    expectUniformMobileNavColumns(pluginVariantRender.container, 7);
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-spacing-check-wide")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-plugin-fusion-plugin-spacing-check-wide")).toBeDefined();
  });

  it("keeps Todos in the mobile More sheet and routes to the todos view", () => {
    const props = createDefaultProps();
    render(
      <MobileNavBar
        {...props}
        experimentalFeatures={{ todoView: true }}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-todos"));

    expect(props.onChangeView).toHaveBeenCalledWith("todos");
  });

  it("Mailbox is a primary tab and is not duplicated in the More sheet", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={3} mailboxPendingApprovalCount={1} />);

    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-mailbox")).toBeNull();
  });

  it("Todos lives only in the More sheet, never a primary tab", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        experimentalFeatures={{ todoView: true }}
      />,
    );

    expect(screen.queryByTestId("mobile-nav-tab-todos")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-todos")).toBeInTheDocument();
  });

  it("marks the mobile More tab active for the todos view", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        view="todos"
        experimentalFeatures={{ todoView: true }}
      />,
    );

    expect(screen.getByTestId("mobile-nav-tab-more")).toHaveClass("mobile-nav-tab--active");
  });

  it("shows Artifacts in More and routes to the stable documents view", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-documents")).toHaveTextContent("Artifacts");
    fireEvent.click(screen.getByTestId("mobile-more-item-documents"));

    expect(props.onChangeView).toHaveBeenCalledWith("documents");
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

  it("places Command Center as the first mobile tab while primary plugins stay More-only", () => {
    const props = createDefaultProps();
    const { container } = render(
      <MobileNavBar
        {...props}
        view="board"
        mailboxUnreadCount={3}
        mailboxPendingApprovalCount={1}
        pluginDashboardViews={[
          {
            pluginId: "fusion-plugin-compound-engineering",
            view: { viewId: "compound-engineering", label: "Compound Engineering", componentPath: "./CompoundEngineeringView", icon: "Workflow", placement: "primary", order: 1 },
          },
        ]}
      />,
    );

    const mailboxTab = screen.getByTestId("mobile-nav-tab-mailbox");
    const commandCenterTab = screen.getByTestId("mobile-nav-tab-command-center");
    // Command Center is now the first top-level tab, before Tasks.
    expect(commandCenterTab).toBe(container.querySelector(".mobile-nav-bar > .mobile-nav-tab"));
    expect(commandCenterTab.previousElementSibling).toBeNull();
    expect(mailboxTab.querySelector(".mobile-nav-tab-badge")?.textContent).toBe("3");
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-compound-engineering-compound-engineering")).toBeNull();

    fireEvent.click(commandCenterTab);
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-command-center")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-plugin-fusion-plugin-compound-engineering-compound-engineering")).toBeDefined();
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

  it("keeps mailbox unread badge on the primary tab only", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={7} />);

    const tabBadge = screen.getByTestId("mobile-nav-tab-mailbox").querySelector(".mobile-nav-tab-badge");
    expect(tabBadge).toBeDefined();
    expect(tabBadge?.textContent).toBe("7");

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-mailbox")).toBeNull();
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

  /*
  FNXC:Navigation 2026-07-05-00:00:
  FN-7614: planning-awaiting-input moved from a top-of-board banner (broken Resume redirect) to a yellow
  needs-input dot on the Planning More-sheet item and the More tab icon, mirroring the chat unread dot pattern.
  The existing activePlanningSessionCount count badge must remain unaffected.
  */
  describe("planningNeedsInput dot (FN-7614)", () => {
    it("shows a needs-input dot on the More tab icon when planningNeedsInput is true and the sheet is closed", () => {
      render(<MobileNavBar {...createDefaultProps()} view="board" planningNeedsInput={true} />);
      expect(screen.getByLabelText("Planning needs your input")).toBeInTheDocument();
    });

    it("hides the More tab dot when planningNeedsInput is false", () => {
      render(<MobileNavBar {...createDefaultProps()} view="board" planningNeedsInput={false} />);
      expect(screen.queryByLabelText("Planning needs your input")).toBeNull();
    });

    it("hides the More tab dot while already on the planning view", () => {
      render(<MobileNavBar {...createDefaultProps()} view="planning" planningNeedsInput={true} />);
      expect(screen.queryByLabelText("Planning needs your input")).toBeNull();
    });

    it("shows a needs-input dot on the Planning More-sheet item and keeps the count badge unaffected", () => {
      render(<MobileNavBar {...createDefaultProps()} view="board" planningNeedsInput={true} activePlanningSessionCount={2} />);
      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

      const planningItem = screen.getByTestId("mobile-more-item-planning");
      expect(planningItem.querySelector(".status-dot.status-dot--pending")).toBeTruthy();
      expect(planningItem).toHaveTextContent("2");
    });

    it("hides the Planning More-sheet dot when planningNeedsInput is false while the count badge still renders", () => {
      render(<MobileNavBar {...createDefaultProps()} view="board" planningNeedsInput={false} activePlanningSessionCount={3} />);
      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

      const planningItem = screen.getByTestId("mobile-more-item-planning");
      expect(planningItem.querySelector(".status-dot.status-dot--pending")).toBeNull();
      expect(planningItem).toHaveTextContent("3");
    });
  });

  it("skills More-sheet item calls onChangeView with 'skills'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" showSkillsTab={true} />);

    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-skills"));
    expect(props.onChangeView).toHaveBeenCalledWith("skills");
  });

  it("marks the More tab active when view is 'skills' since skills lives only in More", () => {
    render(<MobileNavBar {...createDefaultProps()} view="skills" showSkillsTab={true} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more").className).toContain("mobile-nav-tab--active");
  });

  it("does not mark the More tab active for skills when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" showSkillsTab={true} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more").className).not.toContain("mobile-nav-tab--active");
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

    expect(screen.queryByTestId("mobile-more-item-mailbox")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-activity")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-git")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-stash-recovery")).toBeNull();
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

  it("pins omitted Settings below the More divider as the final selectable item", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    const sheet = container.querySelector(".mobile-more-sheet");
    const separator = sheet?.querySelector(".mobile-more-separator");
    const settings = screen.getByTestId("mobile-more-item-settings");

    expect(sheet).toBeInTheDocument();
    expect(separator).toBeInTheDocument();
    expect(separator!.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Array.from(sheet!.querySelectorAll(".mobile-more-item")).at(-1)).toBe(settings);
  });

  it("does not duplicate Settings in More when Settings is a primary tab", () => {
    render(<MobileNavBar {...createDefaultProps()} mobileNavPrimaryItems={["settings"]} />);

    expect(screen.getByTestId("mobile-nav-tab-settings")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-settings")).toBeNull();
  });

  it("shows the stash orphan badge on the Git Manager item instead of a Stash Recovery item", () => {
    render(<MobileNavBar {...createDefaultProps()} stashOrphanCount={8} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    const gitItem = screen.getByTestId("mobile-more-item-git");
    expect(gitItem.querySelector(".mobile-more-item-badge")?.textContent).toBe("8");
    expect(screen.queryByTestId("mobile-more-item-stash-recovery")).toBeNull();
  });

  it("does not show legacy roadmaps in more sheet", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
  });

  it("renders Compound Engineering primary plugin only in More with the pinned Boxes icon", () => {
    const { container } = render(
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

    // Command Center is the first top-level tab, before Tasks.
    expect(screen.getByTestId("mobile-nav-tab-command-center")).toBe(container.querySelector(".mobile-nav-bar > .mobile-nav-tab"));
    expect(screen.getByTestId("mobile-nav-tab-command-center").previousElementSibling).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-compound-engineering-compound-engineering")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    const compoundItem = screen.getByTestId("mobile-more-item-plugin-fusion-plugin-compound-engineering-compound-engineering");
    expect(compoundItem).toBeDefined();
    expect(compoundItem.querySelector(".lucide-boxes")).not.toBeNull();
    expect(compoundItem.querySelector(".lucide-sparkles")).toBeNull();
    expect(compoundItem.querySelector(".lucide-grid-3x3")).toBeNull();
    expect(screen.queryAllByTestId("mobile-more-item-plugin-fusion-plugin-compound-engineering-compound-engineering")).toHaveLength(1);
    expect(screen.queryByTestId("mobile-more-item-command-center")).toBeNull();
  });

  it("removes Compound Engineering from More after disable and uninstall without creating a primary tab", () => {
    const props = createDefaultProps();
    const compoundEngineeringView = [{
      pluginId: "fusion-plugin-compound-engineering",
      view: { viewId: "compound-engineering", label: "Compound Engineering", componentPath: "./CompoundEngineeringView", icon: "Boxes", placement: "primary" as const, order: 36 },
    }];
    const testId = "mobile-more-item-plugin-fusion-plugin-compound-engineering-compound-engineering";
    const rendered = render(<MobileNavBar {...props} pluginDashboardViews={compoundEngineeringView} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-nav-tab-plugin-fusion-plugin-compound-engineering-compound-engineering")).toBeNull();

    rendered.rerender(<MobileNavBar {...props} pluginDashboardViews={[]} />);
    expect(screen.queryByTestId(testId)).toBeNull();
    rendered.rerender(<MobileNavBar {...props} pluginDashboardViews={compoundEngineeringView} />);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    rendered.rerender(<MobileNavBar {...props} pluginDashboardViews={[]} />);
    expect(screen.queryByTestId(testId)).toBeNull();
  });

  it("renders the hosted roadmaps plugin entry when roadmap plugin view is registered", () => {
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
    expect(screen.getByTestId("mobile-more-item-plugin-fusion-plugin-roadmap-roadmaps")).toBeInTheDocument();
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

  it("shows Ideation in More only when ideationView is enabled and routes to it", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} experimentalFeatures={{ ideationView: true }} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-ideation"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onChangeView).toHaveBeenCalledWith("ideation");
  });

  it("does not show Ideation in more sheet when ideationView is disabled", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ ideationView: false }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-ideation")).toBeNull();
  });

  it("does not show research in more sheet when experimentalFeatures.researchView is false", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ researchView: false }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-research")).toBeNull();
  });

  it("does not show nodes in more sheet because Nodes lives in Command Center", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-nodes")).toBeNull();
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

  describe("More-sheet drag dismissal", () => {
    const openSheet = (container: HTMLElement) => {
      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      const sheet = container.querySelector<HTMLDivElement>(".mobile-more-sheet");
      if (!sheet) throw new Error("Expected the More sheet to open");
      Object.defineProperty(sheet, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ height: 400 }),
      });
      return sheet;
    };

    const startDrag = (target: Element, startY = 100) => {
      fireEvent.touchStart(target, { touches: [{ clientY: startY }] });
    };

    const moveDrag = (sheet: Element, currentY: number) =>
      fireEvent.touchMove(sheet, { touches: [{ clientY: currentY }] });

    const endDrag = (sheet: Element, endY: number) => {
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientY: endY }] });
    };

    it("dismisses a top-anchored downward drag past the distance threshold", () => {
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);

      startDrag(sheet);
      expect(moveDrag(sheet, 300)).toBe(false);
      endDrag(sheet, 300);

      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("preserves interior scrolling and does not prevent its downward touchmove", () => {
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);
      sheet.scrollTop = 20;

      startDrag(sheet);
      expect(moveDrag(sheet, 300)).toBe(true);
      endDrag(sheet, 300);

      expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();
    });

    it("snaps back after a slow below-threshold drag", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);

      startDrag(sheet);
      moveDrag(sheet, 150);
      vi.advanceTimersByTime(500);
      endDrag(sheet, 150);

      expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();
      expect(sheet.style.transform).toBe("translateY(0px)");
    });

    it("dismisses when a handle-anchored drag starts while the sheet is scrolled", () => {
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);
      sheet.scrollTop = 20;
      const handle = sheet.querySelector(".mobile-more-sheet-handle");
      expect(handle).not.toBeNull();

      startDrag(handle!);
      expect(moveDrag(sheet, 300)).toBe(false);
      endDrag(sheet, 300);

      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("dismisses with the scripts submenu open without swallowing its normal toggle tap", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({});
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);

      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
      await waitFor(() => expect(screen.getByTestId("mobile-more-scripts-manage")).toBeInTheDocument());

      startDrag(sheet);
      moveDrag(sheet, 300);
      endDrag(sheet, 300);
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("never dismisses for an upward drag", () => {
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);

      startDrag(sheet, 300);
      expect(moveDrag(sheet, 100)).toBe(true);
      endDrag(sheet, 100);

      expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();
    });

    it("dismisses on a fast downward flick below the distance threshold", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);

      startDrag(sheet);
      moveDrag(sheet, 160);
      vi.advanceTimersByTime(50);
      endDrag(sheet, 160);

      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("resets a cancelled drag to the open position", () => {
      const { container } = render(<MobileNavBar {...createDefaultProps()} />);
      const sheet = openSheet(container);

      startDrag(sheet);
      moveDrag(sheet, 300);
      expect(sheet.className).toContain("mobile-more-sheet--dragging");
      expect(sheet.style.transform).toBe("translateY(200px)");

      fireEvent.touchCancel(sheet);
      expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();
      expect(sheet.className).not.toContain("mobile-more-sheet--dragging");
      expect(sheet.style.transform).toBe("translateY(0px)");
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
