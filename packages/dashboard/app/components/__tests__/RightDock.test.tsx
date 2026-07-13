import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  RightDock,
  RIGHT_DOCK_OPEN_STORAGE_KEY,
  RIGHT_DOCK_PINNED_STORAGE_KEY,
  RIGHT_DOCK_VIEW_STORAGE_KEY,
  RIGHT_DOCK_WIDTH_STORAGE_KEY,
  readStoredRightDockOpen,
  type RightDockProps,
} from "../RightDock";
import { RightDockExpandModal } from "../RightDockExpandModal";
import { useRightDockController, type RightDockControllerInput } from "../useRightDockController";
import { DOCK_FILES_CURRENT_KEY } from "../DockFilesView";
import { setScopedItem } from "../../utils/projectStorage";

vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: ({ task }: { task: { id: string; title?: string } }) => (
    <div data-testid="dock-task-detail">{task.title ?? task.id}</div>
  ),
}));

vi.mock("../TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail, onDeleteTask }: { task: { id: string; title?: string }; onOpenDetail: (task: { id: string; title?: string }) => void; onDeleteTask?: (id: string) => Promise<unknown> }) => (
    <button type="button" data-testid={`mock-task-card-${task.id}`} data-has-delete={String(Boolean(onDeleteTask))} onClick={() => onOpenDetail(task)}>
      {task.title ?? task.id}
    </button>
  ),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchWorkspaceFileList: vi.fn().mockResolvedValue({ entries: [], currentPath: "." }),
  };
});

const renderProps = {
  addToast: vi.fn(),
  projectId: "project-1",
};

const rightDockCss = readFileSync(resolve(__dirname, "../RightDock.css"), "utf8");

function TestRightDock(props: Omit<RightDockProps, "pinned" | "onTogglePin"> & Partial<Pick<RightDockProps, "pinned" | "onTogglePin">>) {
  return <RightDock pinned={false} onTogglePin={vi.fn()} {...props} />;
}

/*
FNXC:Navigation 2026-06-22-16:00:
The right dock is now an all-inline tools rail sourced from STATIC_OVERFLOW_VIEW_ENTRIES in overflowViewRegistry. The roster, in registry order, is tasks, files, chat, activity-log, git-manager, devserver (gated on devServerView), secrets, todos (gated on todosEnabled), pull-requests. The earlier usage/github-import/automation launcher actions were removed, so every visible tab is an inline view that switches the dock body and can expand into the modal.
*/
const toolTabIds = [
  "right-dock-tab-tasks",
  "right-dock-tab-files",
  "right-dock-tab-chat",
  "right-dock-tab-activity-log",
  "right-dock-tab-git-manager",
  "right-dock-tab-devserver",
  "right-dock-tab-secrets",
  "right-dock-tab-todos",
  "right-dock-tab-pull-requests",
];

const removedViewTabIds = [
  "right-dock-tab-usage",
  "right-dock-tab-github-import",
  "right-dock-tab-automation",
  "right-dock-tab-documents",
  "right-dock-tab-research",
  "right-dock-tab-insights",
  "right-dock-tab-skills",
  "right-dock-tab-memory",
  "right-dock-tab-evals",
  "right-dock-tab-goals",
  "right-dock-tab-stash-recovery",
];

describe("RightDock", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    // FNXC:Navigation 2026-07-03-09:40: the dock now defaults to HIDDEN, so controller-driven Harness
    // tests below (which exercise open-dock behavior) represent an opted-in operator and must seed the
    // stored "open" preference. Tests that render <RightDock open={...}/> directly are unaffected.
    window.localStorage.setItem(RIGHT_DOCK_OPEN_STORAGE_KEY, "true");
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults the dock to hidden with no stored preference and honours explicit choices", () => {
    // FNXC:Navigation 2026-07-03-09:40: first-run/onboarding must land on an uncluttered board, so the
    // right dock is hidden until the operator opts in via the Header toggle (persists "true").
    window.localStorage.removeItem(RIGHT_DOCK_OPEN_STORAGE_KEY);
    expect(readStoredRightDockOpen()).toBe(false);

    window.localStorage.setItem(RIGHT_DOCK_OPEN_STORAGE_KEY, "true");
    expect(readStoredRightDockOpen()).toBe(true);

    window.localStorage.setItem(RIGHT_DOCK_OPEN_STORAGE_KEY, "false");
    expect(readStoredRightDockOpen()).toBe(false);
  });

  it("keeps right-dock divider chrome tokenized and invisible by default", () => {
    /*
    FNXC:RightDockChrome 2026-06-23-19:10:
    Right-dock shell/header/view dividers are hidden by default via transparent theme tokens, not removed outright, so a theme can opt them back in.
    */
    expect(rightDockCss).toContain("border-left: var(--chrome-divider-width, 1px) solid var(--right-dock-shell-divider-color, transparent);");
    expect(rightDockCss).toContain("border-bottom: var(--chrome-divider-width, 1px) solid var(--right-dock-toolbar-divider-color, transparent);");
    expect(rightDockCss).toContain("border-bottom: var(--chrome-divider-width, 1px) solid var(--right-dock-view-header-divider-color, transparent);");
    expect(rightDockCss).toContain("border-bottom-color: var(--right-dock-expand-header-divider-color, transparent);");
    expect(rightDockCss).not.toContain("border-left: thin solid var(--border);");
    expect(rightDockCss).not.toContain("border-bottom: thin solid var(--border);");
  });

  it("keeps the right-dock pop-out touch-draggable with theme-controlled shadow", () => {
    const panelRule = rightDockCss.match(/\.right-dock-expand-modal--floating\s*\{([^}]*)\}/)?.[1] ?? "";
    const headerRule = rightDockCss.match(/\.right-dock-expand-modal__header--draggable\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(panelRule).toContain("box-shadow: var(--floating-window-shadow, var(--shadow-lg));");
    expect(headerRule).toContain("touch-action: none;");
    expect(headerRule).toContain("min-height: 44px;");
    expect(rightDockCss).not.toContain("var(--shadow-xl)");
  });

  it("renders Files by default and restores the persisted inline view on remount", () => {
    const { unmount } = render(<TestRightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();

    /*
    FNXC:Navigation 2026-06-22-16:00:
    Every right-dock tab is now an inline view, so selecting one (git-manager) persists it and the dock restores that selection on remount instead of snapping back to Files.
    */
    fireEvent.click(screen.getByTestId("right-dock-tab-git-manager"));
    expect(screen.getByTestId("right-dock-tab-git-manager")).toHaveAttribute("aria-selected", "true");
    expect(window.localStorage.getItem(RIGHT_DOCK_VIEW_STORAGE_KEY)).toBe("git-manager");
    unmount();

    render(<TestRightDock open={true} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock-tab-git-manager")).toHaveAttribute("aria-selected", "true");
  });

  /*
  FNXC:RightDockFiles 2026-06-23-00:50:
  Deterministic dock two-pane decision: the dock threads its measured width to the Files registry render as `dockWidth`, and the Files entry forces DockFilesView layout="two-pane" once that width crosses 640px (no @container gate). A narrow dock (default 360px) stays layout="auto" (stacked single-panel). Assert both via the data-layout attribute the view exposes.
  */
  it("forces the Files two-pane layout when the dock is dragged wide, and stays stacked when narrow", () => {
    // Narrow default width (360px) -> stacked single-panel.
    const { unmount } = render(<TestRightDock open={true} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock-files-view")).toHaveAttribute("data-layout", "auto");
    unmount();

    // Wide persisted width (>= 640px) -> deterministic LEFT|RIGHT two-pane.
    window.localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "900");
    render(<TestRightDock open={true} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock-files-view")).toHaveAttribute("data-layout", "two-pane");
  });

  it("threads delete into the compact Tasks tab cards", () => {
    const tasks = [
      { id: "FN-DELETE", title: "Right dock delete", column: "triage" },
    ];
    const onDeleteTask = vi.fn();

    render(<TestRightDock open={true} renderProps={{ ...renderProps, tasks, onDeleteTask }} />);
    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));

    expect(screen.getByTestId("mock-task-card-FN-DELETE")).toHaveAttribute("data-has-delete", "true");
  });

  it("renders the filtered Tasks tab list at both narrow and wide dock widths", () => {
    const tasks = [
      { id: "FN-ACTIVE", title: "Active dock task", column: "todo" },
      { id: "FN-DONE", title: "Done dock task", column: "done" },
      { id: "FN-ARCHIVED", title: "Archived dock task", column: "archived" },
    ];
    const { unmount } = render(<TestRightDock open={true} renderProps={{ ...renderProps, tasks }} />);
    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-ACTIVE")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-DONE")).toBeNull();
    expect(screen.queryByTestId("dock-task-list-row-FN-ARCHIVED")).toBeNull();
    unmount();

    window.localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "900");
    render(<TestRightDock open={true} renderProps={{ ...renderProps, tasks }} />);
    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-ACTIVE")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-ARCHIVED")).toBeNull();
  });

  it("falls back to Files when storage points at a removed right-dock view", () => {
    window.localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "documents");
    render(<TestRightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-tab-documents")).toBeNull();
  });

  it("exposes localized right-dock affordance labels without an in-dock collapse shell", () => {
    render(<TestRightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock")).toHaveAttribute("aria-label", "Right dock");
    expect(screen.getByTestId("right-dock-resize-handle")).toHaveAttribute("aria-label", "Resize right dock");
    expect(screen.getByRole("tablist", { name: "Right dock views" })).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-label", "Pin sidebar (push content)");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("title", "Pin sidebar (push content)");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("right-dock-expand")).toHaveAttribute("aria-label", "Expand Files");
    expect(screen.getByTestId("right-dock-expand")).toHaveAttribute("title", "Expand Files");
    expect(screen.queryByTestId("right-dock-collapse-toggle")).toBeNull();
  });

  /*
  FNXC:RightDockTasks 2026-06-28-18:48:
  Dock task detail exposes two visible return affordances. The header back button and toolbar return button must share the same close callback and leave only the Tasks list mounted after the controller clears the dock snapshot.
  */
  it.each([
    ["right-dock-close-task"],
    ["right-dock-header-back-task"],
  ])("anchors dock task detail to Tasks and returns to the task list from %s", (buttonTestId) => {
    const onCloseDockTask = vi.fn();
    const { rerender } = render(
      <TestRightDock
        open={true}
        renderProps={{ ...renderProps, tasks: [] }}
        dockTask={{ id: "FN-7169", title: "Sidebar task" } as never}
        dockTaskContent={<div data-testid="dock-task-detail">Sidebar task</div>}
        onCloseDockTask={onCloseDockTask}
      />,
    );

    expect(screen.getByTestId("right-dock-tab-tasks")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-body")).toHaveTextContent("Sidebar task");
    expect(screen.queryByTestId("right-dock-files-view")).toBeNull();
    expect(screen.getAllByTestId("right-dock-header-back-task")).toHaveLength(1);
    expect(screen.getByTestId("right-dock-header-back-task")).toHaveAttribute("aria-label", screen.getByTestId("right-dock-close-task").getAttribute("aria-label"));
    expect(screen.getByText("Task detail")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(buttonTestId));
    expect(onCloseDockTask).toHaveBeenCalledTimes(1);

    rerender(<TestRightDock open={true} renderProps={{ ...renderProps, tasks: [] }} dockTask={null} dockTaskContent={null} onCloseDockTask={onCloseDockTask} />);
    expect(screen.getByTestId("right-dock-tab-tasks")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.queryByTestId("right-dock-header-back-task")).toBeNull();
    expect(screen.queryByTestId("right-dock-close-task")).toBeNull();
    expect(screen.queryByText("Task detail")).toBeNull();
    expect(screen.queryByTestId("right-dock-files-view")).toBeNull();
  });

  it("preserves dock task detail across normal right-dock tab switches", () => {
    const onCloseDockTask = vi.fn();
    render(
      <TestRightDock
        open={true}
        renderProps={{ ...renderProps, tasks: [] }}
        dockTask={{ id: "FN-7169", title: "Sidebar task" } as never}
        dockTaskContent={<div data-testid="dock-task-detail">Sidebar task</div>}
        onCloseDockTask={onCloseDockTask}
      />,
    );

    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("Sidebar task");
    fireEvent.click(screen.getByTestId("right-dock-tab-git-manager"));

    expect(onCloseDockTask).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.getByText("Git Manager")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("Sidebar task");
  });

  it("routes right-dock Tasks list clicks to popups when task popups are enabled", () => {
    const firstTask = { id: "FN-1", title: "First task", column: "todo" };
    const openDetailTask = vi.fn();
    const openTaskPopup = vi.fn();
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [firstTask],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask,
      openTaskPopup,
      openMobileTasksInPopup: true,
      openFileInBrowser: vi.fn(),
      onMoveTask: vi.fn(),
      onDeleteTask: vi.fn(),
      onMergeTask: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      taskDetailChatFirst: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return (
        <>
          {controller.dock}
          {controller.modal}
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mock-task-card-FN-1"));

    expect(openTaskPopup).toHaveBeenCalledTimes(1);
    expect(openTaskPopup).toHaveBeenCalledWith(firstTask);
    expect(openDetailTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.queryByTestId("right-dock-close-task")).toBeNull();
    expect(screen.queryByTestId("right-dock-header-back-task")).toBeNull();

    fireEvent.click(screen.getByTestId("right-dock-expand"));
    expect(screen.getByTestId("right-dock-expand-modal")).toHaveAttribute("aria-label", "Tasks expanded");
    fireEvent.click(screen.getByTestId("mock-task-card-FN-1"));
    expect(openTaskPopup).toHaveBeenCalledTimes(2);
    expect(openTaskPopup).toHaveBeenLastCalledWith(firstTask);
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
  });

  it("keeps right-dock Tasks list clicks embedded when task popups are disabled", () => {
    const firstTask = { id: "FN-1", title: "First task", column: "todo" };
    const openDetailTask = vi.fn();
    const openTaskPopup = vi.fn();
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [firstTask],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask,
      openTaskPopup,
      openMobileTasksInPopup: false,
      openFileInBrowser: vi.fn(),
      onMoveTask: vi.fn(),
      onDeleteTask: vi.fn(),
      onMergeTask: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      taskDetailChatFirst: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return <>{controller.dock}</>;
    }

    const { rerender } = render(<Harness />);

    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    fireEvent.click(screen.getByTestId("mock-task-card-FN-1"));

    expect(openTaskPopup).not.toHaveBeenCalled();
    expect(openDetailTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("First task");
    expect(screen.getByTestId("right-dock-close-task")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-header-back-task")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("right-dock-tab-files"));
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("First task");

    fireEvent.click(screen.getByTestId("right-dock-header-back-task"));
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mock-task-card-FN-1"));
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("First task");
    fireEvent.click(screen.getByTestId("right-dock-close-task"));
    rerender(<Harness />);
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
  });

  it("controller dock task opens, replaces, persists across tabs, and clears on close or inactive teardown", () => {
    const firstTask = { id: "FN-1", title: "First task", column: "todo" };
    const secondTask = { id: "FN-2", title: "Second task", column: "todo" };
    const openDetailTask = vi.fn();
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [firstTask, secondTask],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask,
      openFileInBrowser: vi.fn(),
      onMoveTask: vi.fn(),
      onDeleteTask: vi.fn(),
      onMergeTask: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness({ active, tasks = [firstTask, secondTask] }: { active: boolean; tasks?: Array<typeof firstTask> }) {
      const controller = useRightDockController({ ...controllerInput, active, tasks });
      return (
        <>
          <button type="button" data-testid="open-first" onClick={() => controller.openTaskInDock(firstTask as never)}>open first</button>
          <button type="button" data-testid="open-second" onClick={() => controller.openTaskInDock(secondTask as never)}>open second</button>
          <button type="button" data-testid="close-dock-task" onClick={controller.closeDockTask}>close task</button>
          {controller.dock}
        </>
      );
    }

    const { rerender } = render(<Harness active={true} />);
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mock-task-card-FN-1"));
    expect(openDetailTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("First task");

    fireEvent.click(screen.getByTestId("right-dock-tab-files"));
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("First task");

    fireEvent.click(screen.getByTestId("open-second"));
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("Second task");
    expect(screen.queryByText("First task")).toBeNull();

    rerender(<Harness active={true} tasks={[]} />);
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("Second task");

    fireEvent.click(screen.getByTestId("close-dock-task"));
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-first"));
    expect(screen.getByTestId("dock-task-detail")).toHaveTextContent("First task");
    rerender(<Harness active={false} />);
    expect(screen.queryByTestId("right-dock")).toBeNull();
    rerender(<Harness active={true} />);
    expect(screen.queryByTestId("dock-task-detail")).toBeNull();
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
  });

  it("renders the pin affordance for both states and delegates the toggle", () => {
    const onTogglePin = vi.fn();
    const { rerender } = render(<TestRightDock open={true} renderProps={renderProps} pinned={false} onTogglePin={onTogglePin} />);

    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-label", "Pin sidebar (push content)");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("right-dock")).not.toHaveClass("right-dock--pinned");

    fireEvent.click(screen.getByTestId("right-dock-pin"));
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    rerender(<TestRightDock open={true} renderProps={renderProps} pinned={true} onTogglePin={onTogglePin} />);
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-label", "Unpin sidebar (overlay content)");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("title", "Unpin sidebar (overlay content)");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("right-dock")).toHaveClass("right-dock--pinned");
  });

  it("persists and restores pinned state through the right-dock controller", () => {
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask: vi.fn(),
      openFileInBrowser: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return (
        <>
          <output data-testid="controller-pinned">{String(controller.pinned)}</output>
          {controller.dock}
          {controller.modal}
        </>
      );
    }

    const { unmount } = render(<Harness />);
    expect(screen.getByTestId("controller-pinned")).toHaveTextContent("false");
    expect(screen.getByTestId("right-dock")).not.toHaveClass("right-dock--pinned");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("right-dock-pin"));
    expect(window.localStorage.getItem(RIGHT_DOCK_PINNED_STORAGE_KEY)).toBe("true");
    expect(screen.getByTestId("controller-pinned")).toHaveTextContent("true");
    expect(screen.getByTestId("right-dock")).toHaveClass("right-dock--pinned");
    expect(screen.getByTestId("right-dock-pin")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("right-dock-pin"));
    expect(window.localStorage.getItem(RIGHT_DOCK_PINNED_STORAGE_KEY)).toBe("false");
    expect(screen.getByTestId("right-dock")).not.toHaveClass("right-dock--pinned");
    unmount();

    window.localStorage.setItem(RIGHT_DOCK_PINNED_STORAGE_KEY, "true");
    render(<Harness />);
    expect(screen.getByTestId("controller-pinned")).toHaveTextContent("true");
    expect(screen.getByTestId("right-dock")).toHaveClass("right-dock--pinned");
  });

  it("defaults missing, false, and invalid pinned storage to unpinned", () => {
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask: vi.fn(),
      openFileInBrowser: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return <>{controller.dock}</>;
    }

    const { unmount } = render(<Harness />);
    expect(screen.getByTestId("right-dock")).not.toHaveClass("right-dock--pinned");
    unmount();

    window.localStorage.setItem(RIGHT_DOCK_PINNED_STORAGE_KEY, "false");
    const falseMount = render(<Harness />);
    expect(screen.getByTestId("right-dock")).not.toHaveClass("right-dock--pinned");
    falseMount.unmount();

    window.localStorage.setItem(RIGHT_DOCK_PINNED_STORAGE_KEY, "not-json");
    render(<Harness />);
    expect(screen.getByTestId("right-dock")).not.toHaveClass("right-dock--pinned");
  });

  it("keeps pinned layout as an explicit CSS switch from overlay to in-flow push", () => {
    const baseRule = rightDockCss.match(/\.right-dock\s*\{([^}]*)\}/)?.[1] ?? "";
    const pinnedRule = rightDockCss.match(/\.right-dock--pinned\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(baseRule).toContain("position: absolute;");
    expect(pinnedRule).toContain("position: relative;");
    expect(pinnedRule).toContain("box-shadow: none;");
    expect(rightDockCss).toContain("@media (max-width: 768px)");
    expect(rightDockCss).toContain(".right-dock {\n    display: none;");
  });

  it("renders exactly the current right-dock tool entries and no removed content-view tabs", () => {
    render(
      <TestRightDock
        open={true}

        renderProps={renderProps}
        visibilityOptions={{
          experimentalFeatures: {
            insights: true,
            memoryView: true,
            devServerView: true,
            researchView: true,
            evalsView: true,
            goalsView: true,
          },
          showSkillsTab: true,
          todosEnabled: true,
        }}
      />,
    );

    /*
    FNXC:Navigation 2026-06-22-16:00:
    With devServerView and todosEnabled both on, the full nine-entry roster renders in registry order. Tasks, Files, Chat, Activity Log, Git Manager, Dev Server, Secrets, Todos, and Pull Requests are all inline views.
    */
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual(toolTabIds);
    expect(screen.getByTestId("right-dock-tab-tasks")).toHaveAttribute("aria-label", "Tasks");
    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-label", "Files");
    expect(screen.getByTestId("right-dock-tab-chat")).toHaveAttribute("aria-label", "Chat");
    expect(screen.getByTestId("right-dock-tab-activity-log")).toHaveAttribute("aria-label", "Activity Log");
    expect(screen.getByTestId("right-dock-tab-git-manager")).toHaveAttribute("aria-label", "Git Manager");
    expect(screen.getByTestId("right-dock-tab-devserver")).toHaveAttribute("aria-label", "Dev Server");
    expect(screen.getByTestId("right-dock-tab-secrets")).toHaveAttribute("aria-label", "Secrets");
    expect(screen.getByTestId("right-dock-tab-todos")).toHaveAttribute("aria-label", "Todos");
    expect(screen.getByTestId("right-dock-tab-pull-requests")).toHaveAttribute("aria-label", "Pull Requests");
    for (const removedId of removedViewTabIds) {
      expect(screen.queryByTestId(removedId)).toBeNull();
    }
  });

  it("gates devserver and todos tabs behind their visibility flags", () => {
    /*
    FNXC:Navigation 2026-06-22-16:00:
    devserver is gated on experimentalFeatures.devServerView and todos on todosEnabled. With both unset (default renderProps), the dock renders only the seven always-on inline tools.
    */
    render(<TestRightDock open={true} renderProps={renderProps} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "right-dock-tab-tasks",
      "right-dock-tab-files",
      "right-dock-tab-chat",
      "right-dock-tab-activity-log",
      "right-dock-tab-git-manager",
      "right-dock-tab-secrets",
      "right-dock-tab-pull-requests",
    ]);
    expect(screen.queryByTestId("right-dock-tab-devserver")).toBeNull();
    expect(screen.queryByTestId("right-dock-tab-todos")).toBeNull();
  });

  it("clicking an inline tool tab switches the dock body and selection, and Files returns home", () => {
    /*
    FNXC:Navigation 2026-06-22-16:00:
    The right dock no longer hosts launcher-action tabs that fire Header handlers; every tab is an inline view. Clicking a non-Files tab selects it (aria-selected flips, Files deselects) and replaces the body, and the Files tab restores the inline Files view.
    */
    render(<TestRightDock open={true} renderProps={{ ...renderProps, tasks: [] }} />);

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("right-dock-tab-tasks"));
    expect(screen.getByTestId("right-dock-tab-tasks")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();

    for (const tabId of ["right-dock-tab-activity-log", "right-dock-tab-git-manager", "right-dock-tab-secrets"]) {
      fireEvent.click(screen.getByTestId(tabId));
      expect(screen.getByTestId(tabId)).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "false");
      expect(screen.queryByTestId("right-dock-files-view")).toBeNull();
    }

    fireEvent.click(screen.getByTestId("right-dock-tab-files"));
    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();
  });

  /*
  FNXC:RightDock 2026-06-23-00:50:
  The resize clamp + persisted-width read both funnel through RIGHT_DOCK_MAX_WIDTH, raised to 1280 so the dock drags MUCH wider. Drag far past the cap (startWidth 360 + 2000 px of leftward travel) and assert it clamps to the new 1280 max, then a keyboard step down lands one shift-step (48px) below the cap. This proves the new cap governs both the pointer drag and the keyboard path.
  */
  it("clamps then persists resize width while open", () => {
    render(<TestRightDock open={true} renderProps={renderProps} />);

    const handle = screen.getByTestId("right-dock-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 2000 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 0 });
    expect(window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY)).toBe("1280");

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY)).toBe("1232");
  });

  it("restores persisted width on mount", () => {
    window.localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "400");
    render(<TestRightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock")).toHaveStyle({ width: "400px" });
    expect(screen.getByTestId("right-dock-resize-handle")).toHaveAttribute("aria-valuenow", "400");
  });

  // FNXC:Navigation 2026-06-22-09:00: Show/hide is owned by the canonical Header right-sidebar toggle. The dock no longer renders an in-dock collapse toggle or a collapsed rail; when open=false it renders nothing so the main content reclaims the space.
  it("renders nothing when closed and renders the dock content when open", () => {
    const { rerender } = render(<TestRightDock open={true} renderProps={renderProps} />);

    // Show/hide invariant only — the exact tab set is owned by overflowViewRegistry, not asserted here.
    expect(screen.getByTestId("right-dock")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-body")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-resize-handle")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("right-dock-collapse-toggle")).toBeNull();

    rerender(<TestRightDock open={false} renderProps={renderProps} />);
    expect(screen.queryByTestId("right-dock")).toBeNull();
    expect(screen.queryByTestId("right-dock-body")).toBeNull();
    expect(screen.queryByTestId("right-dock-resize-handle")).toBeNull();
    expect(screen.queryByTestId("right-dock-pin")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    rerender(<TestRightDock open={true} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-body")).toBeInTheDocument();
  });

  it("renders the expanded modal through the same registry and restores focus on close", async () => {
    const onClose = vi.fn();
    const focusButton = document.createElement("button");
    document.body.appendChild(focusButton);
    const focusSpy = vi.spyOn(focusButton, "focus");

    render(
      <RightDockExpandModal
        viewKey="files"
        renderProps={renderProps}
        onClose={onClose}
        returnFocusRef={{ current: focusButton }}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-expand-modal")).toHaveAttribute("aria-label", "Files expanded");
    expect(screen.getByTestId("right-dock-expand-body")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-pin")).toBeNull();
    /*
    FNXC:RightDock 2026-06-22-17:40:
    The pop-out is a floating, non-blocking window: the overlay carries the non-blocking class (transparent + pointer-events:none in CSS so behind-clicks pass through), a drag handle (header) exists, and the panel is the floating variant. There is no overlay click-to-dismiss; the explicit close button is the only dismissal.
    */
    expect(screen.getByTestId("right-dock-expand-modal")).toHaveClass("right-dock-expand-modal-overlay");
    expect(screen.getByTestId("right-dock-expand-modal")).toHaveAttribute("aria-modal", "false");
    expect(screen.getByTestId("right-dock-expand-drag-handle")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-expand-modal").querySelector(".right-dock-expand-modal--floating")).not.toBeNull();
    expect(screen.getByTestId("right-dock-expand-resize-se")).toHaveAttribute("aria-label", "Resize expanded right dock window");
    expect(screen.getByTestId("right-dock-expand-close")).toHaveAttribute("aria-label", "Close expanded right dock view");
    fireEvent.click(screen.getByTestId("right-dock-expand-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(focusSpy).toHaveBeenCalled();
    focusButton.remove();
  });

  /*
  FNXC:RightDockTasks 2026-06-28-18:54:
  The expanded Tasks modal is a registry-rendered DockTaskList surface, not a separate task renderer, so it inherits active-by-default filtering and the archived-never-shown contract while preserving dock row routing.
  */
  it("renders the filtered Tasks list in the expanded modal and routes row clicks back to the dock", () => {
    const onOpenTaskInDock = vi.fn();
    const task = { id: "FN-EXPAND", title: "Expanded task", column: "todo" };
    const doneTask = { id: "FN-EXPAND-DONE", title: "Expanded done task", column: "done" };
    const archivedTask = { id: "FN-EXPAND-ARCHIVED", title: "Expanded archived task", column: "archived" };
    render(
      <RightDockExpandModal
        viewKey="tasks"
        renderProps={{ ...renderProps, tasks: [task, doneTask, archivedTask], onOpenTaskInDock }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal")).toHaveAttribute("aria-label", "Tasks expanded");
    expect(screen.getByTestId("dock-task-list")).toBeInTheDocument();
    expect(screen.getByTestId("dock-task-list-row-FN-EXPAND")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-EXPAND-DONE")).toBeNull();
    expect(screen.queryByTestId("dock-task-list-row-FN-EXPAND-ARCHIVED")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show Done" }));
    expect(screen.getByTestId("dock-task-list-row-FN-EXPAND-DONE")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-task-list-row-FN-EXPAND-ARCHIVED")).toBeNull();

    fireEvent.click(screen.getByTestId("mock-task-card-FN-EXPAND"));
    expect(onOpenTaskInDock).toHaveBeenCalledWith(task);
  });

  it("does not render the expanded modal for action entries", () => {
    render(
      <RightDockExpandModal
        viewKey="automation"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
  });

  it("restores the expanded modal's persisted size", () => {
    window.localStorage.setItem("fusion:right-dock-expand-modal-size", JSON.stringify({ width: 640, height: 480 }));
    render(
      <RightDockExpandModal
        viewKey="files"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal").querySelector(".right-dock-expand-modal")).toHaveStyle({
      width: "640px",
      height: "480px",
    });
  });

  it("drags the floating pop-out by its header and clamps + persists the new position", () => {
    /*
    FNXC:RightDock 2026-06-22-17:40:
    Pointerdown on the header drag handle then pointermove moves the panel via state-driven fixed left/top, and pointerup persists the clamped position. Assert the panel moved and that a position was persisted (clamped on-screen).

    FNXC:RightDock 2026-06-22-18:50:
    Move/up are now dispatched on the captured handle element (not document) because the handler attaches its pointermove/up/cancel listeners to the captured target — setPointerCapture redirects the touch stream there, which is what makes touch dragging smooth.
    */
    render(
      <RightDockExpandModal
        viewKey="files"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("right-dock-expand-drag-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 140 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: 140 });

    const persisted = window.localStorage.getItem("fusion:right-dock-expand-modal-position");
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted as string) as { x: number; y: number };
    expect(parsed.x).toBeGreaterThanOrEqual(0);
    expect(parsed.y).toBeGreaterThanOrEqual(0);
  });

  it("fires expand for the currently selected inline entry", () => {
    /*
    FNXC:Navigation 2026-06-22-16:00:
    Every tab is inline, so the expand button fires onExpand with whichever inline entry is selected (here git-manager after switching away from the default Files).
    */
    const onExpand = vi.fn();
    render(<TestRightDock open={true} renderProps={renderProps} onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("right-dock-tab-git-manager"));
    fireEvent.click(screen.getByTestId("right-dock-expand"));
    expect(onExpand).toHaveBeenCalledWith("git-manager");
  });

  /*
  FNXC:RightDock 2026-06-22-18:50:
  The popped-out expand modal is independent of the dock's open state. This drives the real controller, pops out a view, then toggles the dock closed and asserts the floating modal is STILL mounted and interactive — only its own close button dismisses it. Guards against the regression where toggling the dock cleared expandedView (and where the modal was a child of the dock that early-returns null when closed).
  */
  it("keeps the popped-out expand modal mounted when the dock is toggled closed", () => {
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask: vi.fn(),
      openFileInBrowser: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return (
        <>
          <button type="button" data-testid="harness-toggle-dock" onClick={controller.toggle}>
            toggle dock
          </button>
          {controller.dock}
          {controller.modal}
        </>
      );
    }

    render(<Harness />);

    // Pop out the currently selected (Files) view: the floating modal appears AND
    // popping out closes the dock (pop-out dismisses the dock so the full-width app
    // sits behind the movable modal). The dock unmounts; the floating modal survives.
    fireEvent.click(screen.getByTestId("right-dock-expand"));
    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock")).toBeNull();
    expect(screen.getByTestId("right-dock-expand-body")).toBeInTheDocument();

    // Re-opening the dock does not disturb the independent floating modal.
    fireEvent.click(screen.getByTestId("harness-toggle-dock"));
    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();

    // Its own close button still dismisses it.
    fireEvent.click(screen.getByTestId("right-dock-expand-close"));
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
  });

  it("routes Files expand to the file browser modal when an individual file is selected", () => {
    const openFileInBrowser = vi.fn();
    setScopedItem(DOCK_FILES_CURRENT_KEY, "readme.md", "project-1");
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask: vi.fn(),
      openFileInBrowser,
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      prAuthAvailable: false,
      autoMerge: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return (
        <>
          {controller.dock}
          {controller.modal}
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByTestId("right-dock-expand"));

    expect(openFileInBrowser).toHaveBeenCalledWith("readme.md", { workspace: "project" });
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
  });
});
