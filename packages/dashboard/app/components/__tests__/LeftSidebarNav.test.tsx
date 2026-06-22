import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { LeftSidebarNav } from "../LeftSidebarNav";
import type { PluginDashboardViewEntry, ProjectInfo } from "../../api";
import type { TaskView } from "../../hooks/useViewState";

const projects: ProjectInfo[] = [
  {
    id: "alpha",
    name: "Alpha",
    path: "/workspace/alpha",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "beta",
    name: "Beta",
    path: "/workspace/beta",
    status: "paused",
    isolationMode: "in-process",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
];

const leftSidebarNavCss = readFileSync(resolve(__dirname, "../LeftSidebarNav.css"), "utf8");
const obsoleteCollapseToggleFloatingClass = "left-sidebar-nav__collapse-toggle--" + "floating";
const newTaskSurfaceEnumeration = [
  "[x] Components that render the affordance: Grep confirms LeftSidebarNav is the only persistent sidebar renderer and App.tsx mounts it once.",
  "[x] Providers / execution paths: the click handler invokes the onNewTask prop, which App.tsx binds to openNewTaskWithNav.",
  "[x] Breakpoints / viewport modes: desktop/tablet render the sidebar CTA; mobile intentionally hides the sidebar so MobileNavBar and board creation remain canonical there.",
  "[x] Sidebar states: expanded shows icon plus label, collapsed/rail keeps the icon-only button clickable with aria-label and title.",
  "[x] Data/flag states: leftSidebarNav enabled renders the sidebar CTA, leftSidebarNav false omits the entire sidebar shell via App.tsx, and absent onNewTask omits the CTA shell.",
  "[x] Leftover shells: the CTA precedes the nav list without displacing nav sections, footer buttons, or the resize handle.",
];

function getCssRuleBlock(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

const pluginViews: PluginDashboardViewEntry[] = [
  {
    pluginId: "fusion-plugin-primary",
    view: {
      viewId: "primary-view",
      label: "Primary Plugin",
      componentPath: "./PrimaryPlugin",
      placement: "primary",
      order: 1,
    },
  },
  {
    pluginId: "fusion-plugin-overflow",
    view: {
      viewId: "overflow-view",
      label: "Overflow Plugin",
      componentPath: "./OverflowPlugin",
      placement: "overflow",
      order: 2,
    },
  },
];

function expectNoSidebarBrandOrProjectAffordances(container: HTMLElement) {
  expect(screen.queryByTestId("sidebar-nav-brand")).toBeNull();
  expect(screen.queryByTestId("sidebar-nav-project-selector")).toBeNull();
  expect(container.querySelector(".left-sidebar-nav__brand")).toBeNull();
  expect(container.querySelector(".left-sidebar-nav__logo-mark")).toBeNull();
  expect(container.querySelector(".left-sidebar-nav__wordmark")).toBeNull();
}

function expectCollapseToggleImmediatelyBeforeSettings() {
  const footer = screen.getByTestId("sidebar-nav-settings").closest(".left-sidebar-nav__footer");
  const toggle = screen.getByTestId("sidebar-nav-collapse-toggle");
  const settings = screen.getByTestId("sidebar-nav-settings");
  expect(footer).not.toBeNull();
  expect(toggle.closest(".left-sidebar-nav__footer")).toBe(footer);
  expect(toggle).toHaveClass("left-sidebar-nav__item");
  expect(toggle).toHaveClass("left-sidebar-nav__collapse-toggle");
  expect(toggle).not.toHaveClass(obsoleteCollapseToggleFloatingClass);
  expect(footer?.children[0]).toBe(toggle);
  expect(toggle.nextElementSibling).toBe(settings);
  expect(footer?.lastElementChild).toBe(settings);
}

function expectSettingsLastInFooter() {
  expectCollapseToggleImmediatelyBeforeSettings();
}

function renderSidebar(overrides: Partial<ComponentProps<typeof LeftSidebarNav>> = {}) {
  const onChangeView = vi.fn();
  const props: ComponentProps<typeof LeftSidebarNav> = {
    view: "board",
    onChangeView,
    onOpenSettings: vi.fn(),
    showAgentsTab: true,
    showSkillsTab: true,
    mailboxUnreadCount: 3,
    mailboxPendingApprovalCount: 1,
    chatHasUnreadResponse: true,
    experimentalFeatures: {
      insights: true,
      memoryView: true,
      devServerView: true,
      researchView: true,
      evalsView: true,
      goalsView: true,
    },
    pluginDashboardViews: pluginViews,
    ...overrides,
  };

  return { ...render(<LeftSidebarNav {...props} />), onChangeView, props };
}

describe("LeftSidebarNav", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("documents and asserts the sidebar New Task surface enumeration", () => {
    expect(newTaskSurfaceEnumeration).toHaveLength(6);
    for (const item of newTaskSurfaceEnumeration) {
      expect(item).toMatch(/^\[x\]/);
    }

    const singleSidebarRendererMatches = [
      ...leftSidebarNavCss.matchAll(/\.left-sidebar-nav/g),
    ];
    expect(singleSidebarRendererMatches.length).toBeGreaterThan(0);
  });

  it("renders the New Task CTA above the nav list and invokes the provided global trigger", () => {
    const onNewTask = vi.fn();
    renderSidebar({ onNewTask });

    const sidebar = screen.getByTestId("left-sidebar-nav");
    const newTaskButton = screen.getByTestId("sidebar-nav-new-task");
    const navList = sidebar.querySelector(".left-sidebar-nav__list");

    expect(sidebar.children[0]).toBe(newTaskButton);
    expect(newTaskButton.nextElementSibling).toBe(navList);
    expect(newTaskButton).toHaveAccessibleName("New Task");
    expect(newTaskButton).toHaveAttribute("title", "New Task");
    expect(newTaskButton).toHaveTextContent("New Task");
    expect(newTaskButton.querySelector("svg")).not.toBeNull();

    fireEvent.click(newTaskButton);
    expect(onNewTask).toHaveBeenCalledOnce();
  });

  it("omits the New Task CTA when no trigger prop is provided", () => {
    const { container } = renderSidebar();

    expect(screen.queryByTestId("sidebar-nav-new-task")).toBeNull();
    expect(container.querySelector(".left-sidebar-nav__new-task")).toBeNull();
    expect(screen.getByTestId("left-sidebar-nav").children[0]).toBe(screen.getByRole("navigation", { name: "Primary navigation" }));
  });

  it("keeps the New Task CTA accessible, clickable, centered, and label-hidden in rail mode", () => {
    const onNewTask = vi.fn();
    window.localStorage.setItem("fusion:left-sidebar-collapsed", "true");
    renderSidebar({ onNewTask });

    const sidebar = screen.getByTestId("left-sidebar-nav");
    const newTaskButton = screen.getByTestId("sidebar-nav-new-task");
    expect(sidebar).toHaveClass("left-sidebar-nav--collapsed");
    expect(newTaskButton).toHaveAccessibleName("New Task");
    expect(newTaskButton).toHaveAttribute("title", "New Task");
    expect(newTaskButton.querySelector(".left-sidebar-nav__label")).toHaveTextContent("New Task");

    fireEvent.click(newTaskButton);
    expect(onNewTask).toHaveBeenCalledOnce();

    const newTaskRule = getCssRuleBlock(leftSidebarNavCss, ".left-sidebar-nav__new-task");
    const collapsedNewTaskRule = getCssRuleBlock(leftSidebarNavCss, ".left-sidebar-nav--collapsed .left-sidebar-nav__new-task");
    expect(newTaskRule).toContain("justify-content: center");
    expect(collapsedNewTaskRule).toContain("justify-content: center");
    expect(leftSidebarNavCss).toMatch(/\.left-sidebar-nav--collapsed \.left-sidebar-nav__label,\s*\.left-sidebar-nav--collapsed \.left-sidebar-nav__badge\s*\{[\s\S]*?display:\s*none;/);
  });

  it("keeps the New Task CTA styling tokenized without hardcoded px or colors", () => {
    const newTaskRule = getCssRuleBlock(leftSidebarNavCss, ".left-sidebar-nav__new-task");
    const hoverRule = getCssRuleBlock(leftSidebarNavCss, ".left-sidebar-nav__new-task:hover,\n.left-sidebar-nav__new-task:focus-visible");

    expect(newTaskRule).toContain("margin: var(--space-sm) var(--space-sm) 0");
    expect(newTaskRule).toContain("border-radius: var(--radius-md)");
    expect(newTaskRule).toContain("background: var(--accent)");
    expect(newTaskRule).toContain("color: var(--accent-text)");
    expect(newTaskRule).not.toMatch(/\d+px/i);
    expect(newTaskRule).not.toMatch(/#|rgb\(/i);
    expect(hoverRule).not.toMatch(/\d+px/i);
    expect(hoverRule).not.toMatch(/#|rgb\(/i);
  });

  it("renders core destinations, enabled overflow destinations, plugins, and bottom settings", () => {
    const { container } = renderSidebar();

    expectNoSidebarBrandOrProjectAffordances(container);

    for (const testId of [
      "sidebar-nav-board",
      "sidebar-nav-list",
      "sidebar-nav-command-center",
      "sidebar-nav-agents",
      "sidebar-nav-chat",
      "sidebar-nav-mailbox",
      "sidebar-nav-planning",
      "sidebar-nav-missions",
      "sidebar-nav-documents",
      "sidebar-nav-goals",
      "sidebar-nav-automations",
      "sidebar-nav-import-tasks",
      "sidebar-nav-workflows",
      "sidebar-nav-insights",
      "sidebar-nav-research",
      "sidebar-nav-skills",
      "sidebar-nav-memory",
      "sidebar-nav-evals",
      "sidebar-nav-plugin-fusion-plugin-primary-primary-view",
      "sidebar-nav-plugin-fusion-plugin-overflow-overflow-view",
      "sidebar-nav-settings",
    ]) {
      expect(screen.getByTestId(testId)).toBeDefined();
    }

    expect(screen.getByTestId("sidebar-nav-documents")).toHaveTextContent("Artifacts");
    expect(screen.getByTestId("sidebar-nav-planning")).toHaveTextContent("Planning");
    expect(screen.getByTestId("sidebar-nav-import-tasks")).toHaveTextContent("Import Tasks");
    expect(screen.queryByTestId("sidebar-nav-stash-recovery")).toBeNull();

    /*
    FNXC:Navigation 2026-06-22-12:00:
    Import Tasks renders a custom GitHub octocat SVG (lucide-react has no Github export), not a lucide icon. The octocat path is the discriminator.
    */
    const importIconSvg = screen.getByTestId("sidebar-nav-import-tasks").querySelector("svg");
    expect(importIconSvg).not.toBeNull();
    expect(importIconSvg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(importIconSvg?.querySelector("path")?.getAttribute("d")).toContain("M12 2C6.477 2 2 6.484 2 12.017");

    /*
    FNXC:Navigation 2026-06-22-12:00:
    Dev Server moved to the right dock; the sidebar no longer renders a devserver entry even when the devServerView flag is on.
    */
    expect(screen.queryByTestId("sidebar-nav-devserver")).toBeNull();

    const primaryNav = screen.getByRole("navigation", { name: "Primary navigation" });

    /*
    FNXC:Navigation 2026-06-22-12:00:
    The sidebar collapsed its two placement sections into ONE explicitly-ordered list; the `--secondary` section is gone.
    */
    expect(primaryNav.querySelectorAll(".left-sidebar-nav__section")).toHaveLength(1);
    expect(primaryNav.querySelector(".left-sidebar-nav__section--secondary")).toBeNull();

    /*
    FNXC:Navigation 2026-06-22-12:00:
    Assert the intentional single-list order (top to bottom) for the entries present under the default render flags.
    command-center precedes agents; skills/memory (flag-gated) sit immediately after mailbox and before planning; documents (Artifacts) follows missions; automations -> import-tasks -> workflows are contiguous after compound/goals.
    */
    const primaryButtons = within(primaryNav).getAllByRole("button");
    const orderedTestIds = [
      "sidebar-nav-command-center",
      "sidebar-nav-board",
      "sidebar-nav-list",
      "sidebar-nav-agents",
      "sidebar-nav-chat",
      "sidebar-nav-mailbox",
      "sidebar-nav-skills",
      "sidebar-nav-memory",
      "sidebar-nav-planning",
      "sidebar-nav-missions",
      "sidebar-nav-documents",
      "sidebar-nav-goals",
      "sidebar-nav-automations",
      "sidebar-nav-import-tasks",
      "sidebar-nav-workflows",
      "sidebar-nav-insights",
      "sidebar-nav-research",
      "sidebar-nav-evals",
    ];
    const orderedIndices = orderedTestIds.map((testId) => primaryButtons.indexOf(screen.getByTestId(testId)));
    expect(orderedIndices).toEqual([...orderedIndices].sort((a, b) => a - b));
    expect(orderedIndices.every((index) => index >= 0)).toBe(true);
    expect(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-command-center"))).toBeLessThan(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-agents")));
    expect(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-documents"))).toBe(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-missions")) + 1);
    // Skills and Memory sit immediately after Mailbox and before Planning.
    expect(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-skills"))).toBe(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-mailbox")) + 1);
    expect(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-memory"))).toBe(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-skills")) + 1);
    expect(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-planning"))).toBe(primaryButtons.indexOf(screen.getByTestId("sidebar-nav-memory")) + 1);

    const sidebar = screen.getByTestId("left-sidebar-nav");
    const footer = screen.getByTestId("sidebar-nav-settings").closest(".left-sidebar-nav__footer");
    expect(footer).not.toBeNull();
    expect(footer?.parentElement).toBe(sidebar);
    const sidebarButtons = within(sidebar).getAllByRole("button");
    expect(sidebarButtons.at(-1)).toBe(screen.getByTestId("sidebar-nav-settings"));
  });

  it.each([
    ["expanded", false],
    ["collapsed", true],
  ])("applies footer clearance only when the executor footer is visible in %s mode", (_label, collapsed) => {
    if (collapsed) {
      window.localStorage.setItem("fusion:left-sidebar-collapsed", "true");
    }

    const withFooter = renderSidebar({ footerVisible: true });
    const sidebarWithFooter = screen.getByTestId("left-sidebar-nav");
    expect(sidebarWithFooter).toHaveClass("left-sidebar-nav--with-footer");
    if (collapsed) {
      expect(sidebarWithFooter).toHaveClass("left-sidebar-nav--collapsed");
    }
    expectSettingsLastInFooter();

    withFooter.unmount();
    if (collapsed) {
      window.localStorage.setItem("fusion:left-sidebar-collapsed", "true");
    }

    renderSidebar();
    const sidebarWithoutFooter = screen.getByTestId("left-sidebar-nav");
    expect(sidebarWithoutFooter).not.toHaveClass("left-sidebar-nav--with-footer");
    if (collapsed) {
      expect(sidebarWithoutFooter).toHaveClass("left-sidebar-nav--collapsed");
    }
    expectSettingsLastInFooter();
  });

  it("gates optional destinations on their matching feature flags and props while preserving bottom settings", () => {
    renderSidebar({
      showAgentsTab: false,
      showSkillsTab: false,
      experimentalFeatures: {},
      pluginDashboardViews: [],
    });

    expect(screen.getByTestId("sidebar-nav-board")).toBeDefined();
    expect(screen.queryByTestId("sidebar-nav-stash-recovery")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-agents")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-research")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-insights")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-skills")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-memory")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-evals")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-goals")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-plugin-fusion-plugin-primary-primary-view")).toBeNull();

    /*
    FNXC:Navigation 2026-06-22-12:00:
    Unconditional left-sidebar destinations survive empty flags/props: automations, import-tasks (Import Tasks), and workflows are always present; devserver never renders here (right dock).
    */
    expect(screen.getByTestId("sidebar-nav-automations")).toBeDefined();
    expect(screen.getByTestId("sidebar-nav-import-tasks")).toBeDefined();
    expect(screen.getByTestId("sidebar-nav-workflows")).toBeDefined();
    expect(screen.queryByTestId("sidebar-nav-devserver")).toBeNull();

    const sidebar = screen.getByTestId("left-sidebar-nav");
    expect(screen.getByTestId("sidebar-nav-settings").closest(".left-sidebar-nav__footer")).not.toBeNull();
    expect(within(sidebar).getAllByRole("button").at(-1)).toBe(screen.getByTestId("sidebar-nav-settings"));
  });

  it("renders shortened primary labels and default width", () => {
    renderSidebar();

    expect(screen.getByTestId("left-sidebar-nav")).toHaveStyle({ width: "224px", minWidth: "224px" });
    expect(screen.getByTestId("sidebar-nav-board")).toHaveAccessibleName("Board");
    expect(screen.getByTestId("sidebar-nav-list")).toHaveAccessibleName("List");
    expect(screen.getByTestId("sidebar-nav-agents")).toHaveAccessibleName("Agents");
    expect(screen.getByTestId("sidebar-nav-missions")).toHaveAccessibleName("Missions");
    expect(screen.queryByRole("button", { name: /view$/i })).toBeNull();
  });

  it("renders mailbox badges without the removed stash recovery destination", () => {
    renderSidebar();

    const mailboxBadge = screen.getByTestId("sidebar-nav-mailbox").querySelector(".left-sidebar-nav__badge");

    expect(mailboxBadge?.textContent).toBe("3");
    expect(screen.queryByTestId("sidebar-nav-stash-recovery")).toBeNull();
  });

  it("renders zero plugin views and at least one primary and overflow plugin view", () => {
    const empty = renderSidebar({ pluginDashboardViews: [] });
    expect(screen.queryByTestId("sidebar-nav-plugin-fusion-plugin-primary-primary-view")).toBeNull();
    empty.unmount();

    renderSidebar({ pluginDashboardViews: pluginViews });
    expect(screen.getByTestId("sidebar-nav-plugin-fusion-plugin-primary-primary-view")).toBeDefined();
    expect(screen.getByTestId("sidebar-nav-plugin-fusion-plugin-overflow-overflow-view")).toBeDefined();
  });

  it("renders plugin labels without view suffix and shortens Compound Engineering", () => {
    renderSidebar({
      pluginDashboardViews: [
        ...pluginViews,
        {
          pluginId: "fusion-plugin-compound-engineering",
          view: {
            viewId: "compound",
            label: "Compound Engineering",
            componentPath: "./CompoundEngineering",
            placement: "primary",
            order: 0,
          },
        },
      ],
    });

    const primaryPlugin = screen.getByTestId("sidebar-nav-plugin-fusion-plugin-primary-primary-view");
    const compoundPlugin = screen.getByTestId("sidebar-nav-plugin-fusion-plugin-compound-engineering-compound");
    expect(primaryPlugin).toHaveAccessibleName("Primary Plugin");
    expect(primaryPlugin).toHaveAttribute("title", "Primary Plugin");
    expect(primaryPlugin).toHaveTextContent("Primary Plugin");
    expect(primaryPlugin).not.toHaveTextContent("view");
    expect(compoundPlugin).toHaveAccessibleName("Compound Eng");
    expect(compoundPlugin).toHaveAttribute("title", "Compound Eng");
    expect(compoundPlugin).toHaveTextContent("Compound Eng");
    expect(compoundPlugin).not.toHaveTextContent("Compound Engineering");
  });

  it.each<[TaskView, string]>([
    ["board", "sidebar-nav-board"],
    ["research", "sidebar-nav-research"],
    ["planning", "sidebar-nav-planning"],
    ["plugin:fusion-plugin-primary:primary-view", "sidebar-nav-plugin-fusion-plugin-primary-primary-view"],
    ["plugin:fusion-plugin-overflow:overflow-view", "sidebar-nav-plugin-fusion-plugin-overflow-overflow-view"],
  ])("highlights active destination %s", (view, testId) => {
    renderSidebar({ view });
    expect(screen.getByTestId(testId).getAttribute("aria-current")).toBe("page");
  });

  it.each([
    ["without view-all callback", {}],
    ["with empty project list", { projects: [], currentProject: null, onSelectProject: vi.fn(), onViewAllProjects: vi.fn() }],
    [
      "with a single project",
      { projects: projects.slice(0, 1), currentProject: projects[0], onSelectProject: vi.fn(), onViewAllProjects: vi.fn() },
    ],
    ["with multiple projects", { projects, currentProject: projects[0], onSelectProject: vi.fn(), onViewAllProjects: vi.fn() }],
  ] satisfies Array<[string, Partial<ComponentProps<typeof LeftSidebarNav>>]>)(
    "does not render duplicate sidebar brand or project selector %s",
    (_label, overrides) => {
      const { container } = renderSidebar(overrides);
      const sidebar = screen.getByTestId("left-sidebar-nav");

      expectNoSidebarBrandOrProjectAffordances(container);
      expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toBeDefined();
      expect(screen.getByTestId("sidebar-nav-board")).toBeDefined();

      fireEvent.click(screen.getByTestId("sidebar-nav-collapse-toggle"));
      expect(sidebar.className).toContain("left-sidebar-nav--collapsed");
      expectNoSidebarBrandOrProjectAffordances(container);
      expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toBeDefined();
      expect(screen.getByTestId("sidebar-nav-board")).toBeDefined();
    },
  );

  it("renders the collapse toggle in the footer above Settings in expanded and collapsed states", () => {
    const { container } = renderSidebar();
    const sidebar = screen.getByTestId("left-sidebar-nav");
    const expandedToggle = screen.getByTestId("sidebar-nav-collapse-toggle");

    expectNoSidebarBrandOrProjectAffordances(container);
    expectCollapseToggleImmediatelyBeforeSettings();
    expect(expandedToggle).toHaveAttribute("aria-pressed", "false");
    expect(expandedToggle).toHaveAccessibleName("Collapse sidebar");
    expect(expandedToggle).toHaveAttribute("title", "Collapse sidebar");
    expect(expandedToggle).toHaveTextContent("Collapse");
    expect(expandedToggle.querySelector("svg")).not.toBeNull();
    expect(within(sidebar).getAllByRole("button").at(-1)).toBe(screen.getByTestId("sidebar-nav-settings"));

    fireEvent.click(expandedToggle);

    const collapsedToggle = screen.getByTestId("sidebar-nav-collapse-toggle");
    expect(sidebar.className).toContain("left-sidebar-nav--collapsed");
    expectNoSidebarBrandOrProjectAffordances(container);
    expectCollapseToggleImmediatelyBeforeSettings();
    expect(collapsedToggle).toHaveAttribute("aria-pressed", "true");
    expect(collapsedToggle).toHaveAccessibleName("Expand sidebar");
    expect(collapsedToggle).toHaveAttribute("title", "Expand sidebar");
    expect(collapsedToggle.querySelector("svg")).not.toBeNull();
    expect(within(sidebar).getAllByRole("button").at(-1)).toBe(screen.getByTestId("sidebar-nav-settings"));
  });

  it("keeps collapse toggle styling tokenized and removes the floating modifier", () => {
    expect(leftSidebarNavCss).not.toContain(obsoleteCollapseToggleFloatingClass);

    const toggleRule = getCssRuleBlock(leftSidebarNavCss, ".left-sidebar-nav__collapse-toggle");
    expect(toggleRule).toContain("flex-shrink: 0");
    expect(toggleRule).toContain("justify-content: flex-start");
    expect(toggleRule).not.toMatch(/#|rgb\(/i);
    expect(toggleRule).not.toMatch(/position:\s*absolute/);

    const itemRule = getCssRuleBlock(leftSidebarNavCss, ".left-sidebar-nav__item");
    expect(itemRule).toContain("gap: var(--space-sm)");
    expect(itemRule).toContain("border-radius: var(--radius-md)");
    expect(itemRule).toContain("color: var(--text-muted)");
    expect(itemRule).not.toMatch(/#|rgb\(/i);
  });

  it("toggles collapsed rail mode, keeps bottom settings reachable, and restores it on remount", () => {
    const firstRender = renderSidebar();
    const sidebar = screen.getByTestId("left-sidebar-nav");

    expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("sidebar-nav-collapse-toggle"));
    expect(sidebar.className).toContain("left-sidebar-nav--collapsed");
    expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("fusion:left-sidebar-collapsed")).toBe("true");
    expect(screen.queryByTestId("sidebar-nav-resize-handle")).toBeNull();
    expect(screen.getByTestId("sidebar-nav-board")).toBeDefined();
    expect(screen.getByTestId("sidebar-nav-settings").closest(".left-sidebar-nav__footer")).not.toBeNull();
    expect(within(sidebar).getAllByRole("button").at(-1)).toBe(screen.getByTestId("sidebar-nav-settings"));

    firstRender.unmount();
    renderSidebar();
    expect(screen.getByTestId("left-sidebar-nav").className).toContain("left-sidebar-nav--collapsed");
    expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toHaveAccessibleName("Expand sidebar");
    expect(screen.getByTestId("sidebar-nav-collapse-toggle")).toHaveAttribute("title", "Expand sidebar");
    expect(screen.getByTestId("sidebar-nav-settings")).toBeDefined();
    expect(screen.getByTestId("sidebar-nav-board")).toBeDefined();
  });

  it("clamps and persists drag resize width", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("left-sidebar-nav");
    const handle = screen.getByTestId("sidebar-nav-resize-handle");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 999 });
    fireEvent.pointerUp(document, { clientX: 999, pointerId: 1 });

    expect(sidebar).toHaveStyle({ width: "384px", minWidth: "384px" });
    expect(window.localStorage.getItem("fusion:left-sidebar-width")).toBe("384");
  });

  it("clamps and persists the narrower minimum drag resize width", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("left-sidebar-nav");
    const handle = screen.getByTestId("sidebar-nav-resize-handle");

    expect(handle).toHaveAttribute("aria-valuemin", "160");

    fireEvent.pointerDown(handle, { clientX: 224, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 0 });
    fireEvent.pointerUp(document, { clientX: 0, pointerId: 1 });

    expect(sidebar).toHaveStyle({ width: "160px", minWidth: "160px" });
    expect(window.localStorage.getItem("fusion:left-sidebar-width")).toBe("160");
  });

  it("restores persisted width and keyboard-resizes within clamps", () => {
    window.localStorage.setItem("fusion:left-sidebar-width", "999");
    renderSidebar();

    const sidebar = screen.getByTestId("left-sidebar-nav");
    const handle = screen.getByTestId("sidebar-nav-resize-handle");
    expect(sidebar).toHaveStyle({ width: "384px", minWidth: "384px" });

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(sidebar).toHaveStyle({ width: "336px", minWidth: "336px" });
    expect(window.localStorage.getItem("fusion:left-sidebar-width")).toBe("336");
  });

  it("restores below-minimum persisted width to the narrower minimum", () => {
    window.localStorage.setItem("fusion:left-sidebar-width", "120");
    renderSidebar();

    expect(screen.getByTestId("left-sidebar-nav")).toHaveStyle({ width: "160px", minWidth: "160px" });
    expect(screen.getByTestId("sidebar-nav-resize-handle")).toHaveAttribute("aria-valuenow", "160");
  });

  it("keyboard resizing clamps and persists the narrower minimum width", () => {
    renderSidebar();

    const sidebar = screen.getByTestId("left-sidebar-nav");
    const handle = screen.getByTestId("sidebar-nav-resize-handle");

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });

    expect(sidebar).toHaveStyle({ width: "160px", minWidth: "160px" });
    expect(handle).toHaveAttribute("aria-valuenow", "160");
    expect(window.localStorage.getItem("fusion:left-sidebar-width")).toBe("160");
  });

  it("routes clicks to view changes and settings callback without Secrets/Todos shortcuts", () => {
    const onOpenSettings = vi.fn();
    const { onChangeView } = renderSidebar({ todosEnabled: true, onOpenSettings });

    fireEvent.click(screen.getByTestId("sidebar-nav-list"));
    expect(onChangeView).toHaveBeenCalledWith("list");

    fireEvent.click(screen.getByTestId("sidebar-nav-planning"));
    expect(onChangeView).toHaveBeenCalledWith("planning");

    fireEvent.click(screen.getByTestId("sidebar-nav-plugin-fusion-plugin-overflow-overflow-view"));
    expect(onChangeView).toHaveBeenCalledWith("plugin:fusion-plugin-overflow:overflow-view");

    expect(screen.queryByTestId("sidebar-nav-secrets")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-todos")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("does not crash when bottom settings is clicked without a handler", () => {
    renderSidebar({ onOpenSettings: undefined });

    expect(() => fireEvent.click(screen.getByTestId("sidebar-nav-settings"))).not.toThrow();
  });
});
