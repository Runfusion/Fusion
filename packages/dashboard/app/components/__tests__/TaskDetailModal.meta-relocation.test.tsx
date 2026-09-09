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
  openTaskDetailActionsMenu,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
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
    expect(reconciliation.compareDocumentPosition(tabs!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("keeps metadata responsive and constrains the long footer menu at its base rule", () => {
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
});
