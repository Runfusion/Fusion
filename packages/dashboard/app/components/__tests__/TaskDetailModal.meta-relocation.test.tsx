import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  findTaskDetailActionByTestId,
  makeTask,
  makeUpdatedTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  getCssRuleBlock,
  openTaskDetailActionsMenu,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import { readAppFile } from "../../test/cssFixture";
import * as dashboardApi from "../../api";
import type { TaskDetail } from "@fusion/core";

setupTaskDetailModalHooks();

const handlers = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function resolveCodingWorkflow(): void {
  vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [{ id: "builtin:coding", name: "Coding (Auto)", columns: [], fields: [] }],
    taskWorkflowIds: {},
  });
}

function renderHost(task: TaskDetail, options: { embedded?: boolean; initialTab?: "chat" | "details" } = {}) {
  vi.mocked(dashboardApi.fetchTaskDetail).mockResolvedValue(task);
  if (options.embedded) {
    return render(
      <TaskDetailContent
        embedded
        active
        task={task}
        initialTab={options.initialTab}
        {...handlers}
      />,
    );
  }
  return render(
    <TaskDetailModal
      task={task}
      initialTab={options.initialTab}
      onClose={noop}
      {...handlers}
    />,
  );
}

describe("Task Detail metadata relocation", () => {
  it("removes permanent metadata chrome above the tabs", () => {
    renderHost(makeTask({ sourceType: "dashboard_ui" }));

    expect(document.querySelector(".detail-meta")).toBeNull();
    expect(document.querySelector(".detail-tabs")).toBeInTheDocument();
    expect(document.querySelector(".detail-provenance")).toBeNull();
    expect(document.querySelector(".detail-timestamps")).toBeNull();
  });

  it.each([
    ["modal", false],
    ["embedded", true],
  ] as const)("renders metadata at the top of Details in the %s host", async (_host, embedded) => {
    resolveCodingWorkflow();
    renderHost(makeTask({ sourceType: "dashboard_ui" }), { embedded, initialTab: "details" });

    const section = document.querySelector<HTMLElement>(".detail-section--task-metadata");
    expect(section).not.toBeNull();
    expect(await within(section!).findByText("Created via Dashboard")).toBeInTheDocument();
    expect(section?.querySelector(".detail-timestamps")).toBeInTheDocument();
    expect(within(section!).getByTestId("task-detail-workflow-badge")).toHaveTextContent("Coding (Auto)");
    expect(section?.nextElementSibling).toHaveClass("detail-section--original-prompt");
  });

  it("omits unresolved workflow identity without an empty badge shell", async () => {
    vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: false,
      defaultWorkflowId: "",
      workflows: [],
      taskWorkflowIds: {},
    });
    renderHost(makeTask({ sourceType: "dashboard_ui" }), { initialTab: "details" });

    const section = document.querySelector<HTMLElement>(".detail-section--task-metadata");
    expect(await within(section!).findByText("Created via Dashboard")).toBeInTheDocument();
    expect(within(section!).queryByTestId("task-detail-workflow-badge")).toBeNull();
    expect(section?.querySelector(".detail-workflow-badge")).toBeNull();
  });

  it("keeps PR context in the Details metadata section", () => {
    renderHost(makeTask({
      sourceType: "dashboard_ui",
      prInfo: { number: 42, url: "https://github.com/runfusion/fusion/pull/42" },
    }), { initialTab: "details" });

    const section = document.querySelector<HTMLElement>(".detail-section--task-metadata");
    expect(section?.querySelector(".detail-pr-link-row")).toHaveTextContent("PR #42");
  });

  it.each(["chat", "details"] as const)("keeps the hidden attachment input mounted on %s", (initialTab) => {
    renderHost(makeTask(), { initialTab });
    expect(document.querySelector(".detail-hidden-file-input")).toBeInTheDocument();
  });

  it("keeps AI merge reconciliation in permanent content outside the tabs", () => {
    renderHost(makeTask({
      aiMergeReviewReconciliation: {
        sourceSha: "source",
        integrationTipSha: "tip",
        candidateSha: "candidate",
        findings: [],
        consecutiveCleanApprovals: 0,
        correctivePasses: 0,
      },
    }));

    const reconciliation = screen.getByRole("region", { name: "AI merge review reconciliation" });
    const tabs = document.querySelector<HTMLElement>(".detail-tabs");
    expect(tabs?.contains(reconciliation)).toBe(false);
    expect(tabs!.compareDocumentPosition(reconciliation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("preserves the distinct agent metadata row in Details", async () => {
    renderHost(makeTask(), { initialTab: "details" });

    await waitFor(() => expect(document.querySelector(".detail-meta-row")).toBeInTheDocument());
  });
});

describe("Task Detail footer quick actions", () => {
  it("lists the five labeled affordance groups in Quick Add order", async () => {
    renderHost(makeTask({ sourceType: "dashboard_ui" }));
    const menu = await openTaskDetailActionsMenu();

    const attach = within(menu).getByTestId("detail-inline-attach");
    const github = within(menu).getByTestId("detail-inline-github-toggle");
    const oversight = within(menu).getByTestId("detail-actions-oversight-heading");
    const priority = within(menu).getByTestId("detail-actions-priority-heading");
    const fast = within(menu).getByRole("menuitem", { name: "Execution mode: standard" });
    expect(attach).toHaveAccessibleName("Attach file");
    expect(github).toHaveAccessibleName("Toggle GitHub tracking");
    expect(oversight).toHaveTextContent("Oversight: on");
    expect(priority).toHaveTextContent("Priority");
    expect(fast).toHaveAccessibleName("Execution mode: standard");
    for (const [first, second] of [[attach, github], [github, oversight], [oversight, priority], [priority, fast]]) {
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("opens the retained attachment input and focuses Attach file first", async () => {
    renderHost(makeTask());
    const input = document.querySelector<HTMLInputElement>(".detail-hidden-file-input")!;
    const inputClick = vi.spyOn(input, "click");
    const menu = await openTaskDetailActionsMenu();
    const attach = within(menu).getByTestId("detail-inline-attach");

    await waitFor(() => expect(attach).toHaveFocus());
    fireEvent.click(attach);
    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".detail-actions-menu")).toBeNull();
  });

  it("uses the retained GitHub persistence handler", async () => {
    const task = makeTask({ githubTracking: { enabled: false } });
    vi.mocked(dashboardApi.updateTask).mockResolvedValue(makeUpdatedTask(task, { githubTracking: { enabled: true } }));
    renderHost(task);

    fireEvent.click(await findTaskDetailActionByTestId("detail-inline-github-toggle"));
    await waitFor(() => expect(dashboardApi.updateTask).toHaveBeenCalledWith(
      task.id,
      { githubTracking: { enabled: true } },
      undefined,
    ));
  });

  it("persists priority through the existing handler and closes the menu", async () => {
    const task = makeTask({ priority: "normal" });
    vi.mocked(dashboardApi.updateTask).mockResolvedValue(makeUpdatedTask(task, { priority: "high" }));
    renderHost(task);

    fireEvent.click(await findTaskDetailActionByTestId("detail-priority-option-high"));
    expect(document.querySelector(".detail-actions-menu")).toBeNull();
    await waitFor(() => expect(dashboardApi.updateTask).toHaveBeenCalledWith(task.id, { priority: "high" }, undefined));
  });

  it("persists Fast mode through the existing handler", async () => {
    const task = makeTask({ executionMode: "standard" });
    vi.mocked(dashboardApi.updateTask).mockResolvedValue(makeUpdatedTask(task, { executionMode: "fast" }));
    renderHost(task);

    fireEvent.click(within(await openTaskDetailActionsMenu()).getByRole("menuitem", { name: "Execution mode: standard" }));
    await waitFor(() => expect(dashboardApi.updateTask).toHaveBeenCalledWith(task.id, { executionMode: "fast" }, undefined));
  });

  it("omits the Oversight group until its applicability resolves", async () => {
    vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "wf-pending-fn300",
      workflows: [{ id: "wf-pending-fn300", name: "Pending oversight", columns: [], fields: [] }],
      taskWorkflowIds: {},
    });
    vi.mocked(dashboardApi.fetchWorkflowSettingValues).mockImplementation(() => new Promise(() => {}));
    renderHost(makeTask({ plannerOversightLevel: undefined, sessionAdvisorEnabled: undefined }));

    await waitFor(() => expect(dashboardApi.fetchWorkflowSettingValues).toHaveBeenCalled());

    const menu = await openTaskDetailActionsMenu();
    expect(within(menu).queryByTestId("detail-actions-oversight-heading")).toBeNull();
    expect(within(menu).queryByTestId("detail-session-advisor-toggle")).toBeNull();
  });

  it.each([
    ["a GitLab-tracked task", makeTask({ gitlabTracking: { item: { provider: "gitlab", kind: "issue", projectId: "1", iid: 2, url: "https://gitlab.example/issue/2", title: "Tracked" } } as TaskDetail["gitlabTracking"] })],
    ["a non-editable completed task", makeTask({ column: "done", status: "done" })],
  ])("omits GitHub tracking for %s while the menu is open", async (_label, task) => {
    renderHost(task);
    const menu = await openTaskDetailActionsMenu();
    expect(within(menu).queryByTestId("detail-inline-github-toggle")).toBeNull();
  });

  it("projects pressed state for every toggle and selected value", async () => {
    renderHost(makeTask({
      githubTracking: { enabled: true },
      plannerOversightLevel: "steer",
      sessionAdvisorEnabled: true,
      priority: "high",
      executionMode: "fast",
    }));
    const menu = await openTaskDetailActionsMenu();

    expect(within(menu).getByTestId("detail-inline-github-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(within(menu).getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(within(menu).getByTestId("detail-priority-option-high")).toHaveAttribute("aria-pressed", "true");
    expect(within(menu).getByRole("menuitem", { name: "Execution mode: fast" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps non-interactive group headings from dismissing the menu", async () => {
    renderHost(makeTask());
    const menu = await openTaskDetailActionsMenu();

    fireEvent.click(within(menu).getByTestId("detail-actions-priority-heading"));
    expect(document.querySelector(".detail-actions-menu")).toBe(menu);
    expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute("aria-expanded", "true");
  });
});

/*
FNXC:TaskDetailActionsMenu 2026-09-15-09:30:
FN-415: mobile rules for this family live in a co-located `@media (max-width: 768px)` block inside the aggregated
stylesheet source, so the mobile rule is located by scanning every 768px block for the `.detail-actions-menu` rule
that carries the viewport-bound `max-width` rather than by a lazy match that can bind to the base rule.
*/
function readMobileActionsMenuRule(css: string): string {
  for (const block of css.split(/@media[^{]*\(max-width:\s*768px\)[^{]*\{/).slice(1)) {
    for (const match of block.matchAll(/\.detail-actions-menu\s*\{([^}]*)\}/g)) {
      if (match[1].includes("max-width: calc(100vw")) return match[1];
    }
  }
  return "";
}

describe("Task Detail metadata and footer CSS", () => {
  it("removes only retired selectors and preserves the Details metadata family", () => {
    const css = readDashboardStylesSource();
    const retiredSelectors = [
      ".detail-meta",
      ".detail-meta-inline-controls",
      ".detail-priority-picker",
      ".detail-oversight-menu-dropdown",
      ".detail-oversight-menu",
      ".detail-inline-attach",
      ".detail-inline-github-toggle",
      ".detail-priority-trigger",
      ".detail-oversight-menu-trigger",
      ".detail-execution-mode-toggle",
    ];
    for (const selector of retiredSelectors) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(css).not.toMatch(new RegExp(`${escaped}\\s*\\{`));
    }
    for (const selector of [".detail-provenance", ".detail-timestamps", ".detail-meta-row", ".detail-meta-label-icon"]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(css).toMatch(new RegExp(`${escaped}\\s*\\{`));
    }
  });

  it("keeps metadata responsive and constrains the long header overflow at its base rule", () => {
    const css = readDashboardStylesSource();
    const metadata = css.match(/\.detail-section--task-metadata\s*\{([^}]*)\}/)?.[1] ?? "";
    const actions = css.match(/^\.detail-actions-menu\s*\{([^}]*)\}/m)?.[1] ?? "";

    expect(metadata).toContain("flex-wrap: wrap");
    expect(metadata).toContain("gap: var(--space-sm) var(--space-md)");
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.detail-section--task-metadata\s*\{[^}]*gap: var\(--space-sm\)/);
    expect(actions).toContain("left: 0");
    expect(actions).toContain("max-height:");
    expect(actions).toContain("overflow-x: hidden");
    expect(actions).toContain("overflow-y: auto");
  });

  /*
  FNXC:TaskDetailActionsMenu 2026-09-15-09:30:
  FN-415: the header overflow menu must be wide enough that every option occupies exactly one line. These cases pin
  the width convention, the nowrap/ellipsis contract on every item family, the mobile viewport bound, and the DOM
  proof that no rendered entry escapes the nowrap rule.
  */
  it("sizes the header actions menu on its content instead of the retired 76px minimum", () => {
    const css = readDashboardStylesSource();
    const actions = css.match(/^\.detail-actions-menu\s*\{([^}]*)\}/m)?.[1] ?? "";

    expect(actions).not.toContain("calc(var(--space-2xl) + var(--space-2xl) + var(--space-md))");
    expect(actions).toContain("width: max-content");
    expect(actions).toContain("min-width: var(--detail-actions-menu-min-width)");
    expect(actions).toContain("max-width: var(--detail-actions-menu-max-width)");
    expect(actions).toContain("left: 0");
    expect(actions).toContain("max-height:");
    expect(actions).toContain("overflow-x: hidden");
    expect(actions).toContain("overflow-y: auto");
  });

  it.each([".detail-actions-menu-item", ".detail-actions-menu-note"])(
    "keeps %s on a single line with ellipsis truncation",
    (selector) => {
      const rule = getCssRuleBlock(readDashboardStylesSource(), selector);

      expect(rule).toContain("white-space: nowrap");
      expect(rule).toContain("text-overflow: ellipsis");
    },
  );

  it("keeps the mobile viewport bound without re-enabling wrapping", () => {
    const css = readDashboardStylesSource();
    const mobileRule = readMobileActionsMenuRule(css);

    expect(mobileRule).toContain("max-width: calc(100vw - calc(var(--space-lg) + var(--space-md)))");
    expect(mobileRule).toContain("max-height");
    expect(mobileRule).toContain("overflow-y: auto");
    expect(mobileRule).not.toContain("white-space: normal");
    expect(mobileRule).not.toContain("min-width");
  });
});

describe("Task Detail header actions menu single-line coverage", () => {
  it("renders every populated entry with a class covered by the nowrap rule", async () => {
    renderHost(makeTask({
      githubTracking: { enabled: true },
      plannerOversightLevel: "steer",
      sessionAdvisorEnabled: true,
      priority: "high",
      executionMode: "fast",
    }));
    const menu = await openTaskDetailActionsMenu();

    expect(within(menu).getByRole("menuitem", { name: "Execution mode: fast" })).toBeInTheDocument();
    expect(within(menu).getByTestId("detail-actions-priority-heading")).toBeInTheDocument();

    const entries = Array.from(menu.querySelectorAll<HTMLElement>("button, span[role='note']"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.classList.contains("detail-actions-menu-item")
        || entry.classList.contains("detail-actions-menu-note")).toBe(true);
    }
  });

  it("renders no menu at all when no secondary header action is available", async () => {
    renderHost(makeTask({ column: "done", status: "done" }));
    await screen.findByRole("button", { name: "Actions" });

    expect(document.querySelector(".detail-actions-menu")).toBeNull();
  });
});

function stubHostHeight(height: number): HTMLElement {
  const host = document.querySelector<HTMLElement>(".task-detail-content")!;
  Object.defineProperty(host, "clientHeight", { value: height, configurable: true });
  return host;
}

function readPublishedMenuMaxHeight(): string {
  const anchor = document.querySelector<HTMLElement>(".detail-actions-dropdown--header");
  return anchor?.style.getPropertyValue("--detail-actions-menu-max-height") ?? "";
}

const menuHeightTask = makeTask({
  githubTracking: { enabled: true },
  plannerOversightLevel: "steer",
  sessionAdvisorEnabled: true,
  priority: "high",
  executionMode: "fast",
});

/*
FNXC:TaskDetailActionsMenu 2026-09-15-13:50:
FN-420: this suite locks the header overflow menu to the height of the Task Detail shell that contains it rather than
the browser viewport. It pins the CSS contract (both the base rule and the mobile block consume the measured variable
with a viewport fallback and keep scrolling), the DOM proof in both hosts, the withheld-variable fallback when no
height is measurable, re-measurement on reopen, and the surface census showing no other family publishes the variable.
*/
describe("Task Detail header actions menu height containment", () => {
  it("bounds the base rule by the measured shell variable instead of an unconditional viewport cap", () => {
    const css = readDashboardStylesSource();
    const actions = css.match(/^\.detail-actions-menu\s*\{([^}]*)\}/m)?.[1] ?? "";

    expect(actions).toContain("max-height: var(--detail-actions-menu-max-height,");
    expect(actions).toContain("overflow-y: auto");
    expect(actions).not.toMatch(/max-height:\s*calc\(100dvh/);
  });

  it("bounds the mobile rule by the same variable without the hardcoded pixel cap", () => {
    const mobileRule = readMobileActionsMenuRule(readDashboardStylesSource());

    expect(mobileRule).toContain("max-height: var(--detail-actions-menu-max-height,");
    expect(mobileRule).toContain("overflow-y: auto");
    expect(mobileRule).toContain("max-width: calc(100vw - calc(var(--space-lg) + var(--space-md)))");
    expect(mobileRule).not.toContain("120px");
  });

  it.each([
    ["modal", false, 640, "512px"],
    ["embedded", true, 300, "240px"],
  ] as const)("caps the menu at 80%% of the %s host shell height", async (_host, embedded, height, expected) => {
    renderHost(menuHeightTask, { embedded });
    stubHostHeight(height);
    await openTaskDetailActionsMenu();

    await waitFor(() => expect(readPublishedMenuMaxHeight()).toBe(expected));
  });

  it("withholds the variable when the host shell has no measurable height", async () => {
    renderHost(menuHeightTask);
    await openTaskDetailActionsMenu();

    expect(document.querySelector<HTMLElement>(".task-detail-content")!.clientHeight).toBe(0);
    expect(readPublishedMenuMaxHeight()).toBe("");
  });

  it("re-measures the host shell when the menu is reopened at a different height", async () => {
    renderHost(menuHeightTask);
    stubHostHeight(640);
    await openTaskDetailActionsMenu();
    await waitFor(() => expect(readPublishedMenuMaxHeight()).toBe("512px"));

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    await waitFor(() => expect(document.querySelector(".detail-actions-menu")).toBeNull());

    stubHostHeight(300);
    await openTaskDetailActionsMenu();
    await waitFor(() => expect(readPublishedMenuMaxHeight()).toBe("240px"));
  });

  it("publishes nothing and raises nothing when no overflow menu is rendered", async () => {
    renderHost(makeTask({ column: "done", status: "done" }));
    await screen.findByRole("button", { name: "Actions" });
    stubHostHeight(640);

    expect(document.querySelector(".detail-actions-menu")).toBeNull();
    expect(readPublishedMenuMaxHeight()).toBe("");
  });

  it("keeps the anchoring rules free of height and overflow declarations", () => {
    const css = readDashboardStylesSource();
    const headerAnchor = getCssRuleBlock(css, ".detail-actions-menu--header");
    const embeddedAnchor = getCssRuleBlock(css, ".task-detail-content--embedded .detail-actions-menu--header");

    for (const rule of [headerAnchor, embeddedAnchor]) {
      expect(rule).not.toBe("");
      expect(rule).not.toContain("max-height");
      expect(rule).not.toContain("overflow");
    }
  });

  it("publishes the measured variable only on the header anchor and never on the shared context menu", () => {
    const css = readDashboardStylesSource().replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/\.task-context-menu[^{}]*\{([^}]*)\}/g)) {
      expect(match[1]).not.toContain("--detail-actions-menu-max-height");
    }

    const source = readAppFile("components/TaskDetailModal.tsx");
    const publishSites = source.split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes("\"--detail-actions-menu-max-height\""));
    expect(publishSites).toHaveLength(1);
    const anchorContext = source.split("\n").slice(publishSites[0].index - 8, publishSites[0].index + 1).join("\n");
    expect(anchorContext).toContain("detail-actions-dropdown--header");
  });
});
