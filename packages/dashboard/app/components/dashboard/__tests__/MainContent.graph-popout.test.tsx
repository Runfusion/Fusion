import { lazy } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail } from "@fusion/core";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";
import { usePoppedOutTasks } from "../../../hooks/usePoppedOutTasks";
import type { PluginDashboardViewContext } from "../../../plugins/types";

const hostContexts: PluginDashboardViewContext[] = [];

vi.mock("../../../plugins/PluginDashboardViewHost", () => ({
  PluginDashboardViewHost: ({ taskView, context }: { taskView: string; context?: PluginDashboardViewContext }) => {
    if (context) hostContexts.push(context);
    const task = context?.tasks[0];
    return (
      <div data-testid="plugin-host" data-task-view={taskView}>
        <button type="button" onClick={() => task && context?.openTaskDetail(task, "logs")}>Open from plugin bridge</button>
        <div data-testid="rendered-task-card">{task && context?.renderTaskCard?.(task)}</div>
      </div>
    );
  },
}));

vi.mock("../../TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail, taskColumnFlags }: {
    task: Task | TaskDetail;
    onOpenDetail: (task: Task | TaskDetail) => void;
    taskColumnFlags?: Record<string, boolean | undefined>;
  }) => (
    <button
      type="button"
      /* The probe for the trait hand-off: absent means the card resolved nothing. */
      data-column-flags={taskColumnFlags ? JSON.stringify(taskColumnFlags) : "none"}
      onClick={() => onOpenDetail(task)}
    >
      Open rendered task card
    </button>
  ),
}));

vi.mock("../../GraphWorkflowSwitcherSlot", () => ({
  GraphWorkflowSwitcherSlot: () => <div data-testid="graph-workflow-switcher" />,
  filterTasksByGraphWorkflowSelection: (tasks: Task[]) => tasks,
}));

const graphTask = {
  id: "FN-GRAPH",
  title: "Graph task",
  description: "Graph task description",
  column: "todo",
  status: "todo",
  dependencies: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
} as unknown as Task;

const otherTask = {
  ...graphTask,
  id: "FN-OTHER",
  title: "Other graph task",
} as unknown as Task;

const LazyStub = lazy(async () => ({ default: () => null }));
const LazySettingsCloseStub = lazy(async () => ({
  default: ({ onClose }: { onClose: () => void }) => <button type="button" onClick={onClose}>Close settings view</button>,
}));
let embeddedSettingsProps: Record<string, unknown> | undefined;
const LazySettingsBridgeStub = lazy(async () => ({
  default: (props: Record<string, unknown>) => {
    embeddedSettingsProps = props;
    return <div>Embedded settings bridge</div>;
  },
}));

function mainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(),
    shellApi: null,
    taskView: "graph",
    modalManager: {
      closeSettings: vi.fn(),
      settingsInitialSection: undefined,
      openWorkflowEditor: vi.fn(),
    } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    themeMode: "system",
    setThemeMode: vi.fn(),
    colorTheme: "default",
    setColorTheme: vi.fn(),
    dashboardFontScalePct: 100,
    setDashboardFontScalePct: vi.fn(),
    shadcnCustomColors: {},
    setShadcnCustomColors: vi.fn(),
    resolvedThemeMode: "light",
    setQuickChatButtonModeImmediate: vi.fn(),
    setChatMessageLayoutImmediate: vi.fn(),
    setOpenTasksInRightSidebarImmediate: vi.fn(),
    setOpenMobileTasksInPopupImmediate: vi.fn(),
    setTaskPopupsBoardListOnlyImmediate: vi.fn(),
    setShowCostBadgeOnCardsImmediate: vi.fn(),
    setTaskDetailChatFirstImmediate: vi.fn(),
    reopenOnboardingWithNav: vi.fn(),
    viewMode: "project",
    projects: [],
    projectsLoading: false,
    handleSelectProject: vi.fn(),
    handleAddProject: vi.fn(),
    handlePauseProject: vi.fn(),
    handleResumeProject: vi.fn(),
    handleRemoveProject: vi.fn(),
    nodes: [],
    /*
    FNXC:TodoPluginEnablement 2026-08-15-22:20:
    FN-8762 (5b2b31d2c9) gated plugin task views on the project-scoped
    `pluginDashboardViews` roster (MainContent.isEnabledPluginTaskView), so this
    harness must enroll the plugin views it renders or MainContent treats them as
    disabled. The same commit removed the host `todosEnabled`/`TodoView` props.
    */
    pluginDashboardViews: [
      {
        pluginId: "fusion-plugin-dependency-graph",
        view: { viewId: "graph", label: "Graph", componentPath: "./dashboard-view", icon: "Workflow", placement: "primary", order: 1 },
      },
      {
        pluginId: "example",
        view: { viewId: "dashboard", label: "Example", componentPath: "./dashboard-view", icon: "Workflow", placement: "overflow", order: 2 },
      },
    ] as MainContentProps["pluginDashboardViews"],
    graphPluginTaskView: "plugin:fusion-plugin-dependency-graph:graph",
    graphWorkflowSelection: null,
    setGraphWorkflowSelection: vi.fn(),
    isRemote: false,
    remoteData: { tasks: [] } as unknown as MainContentProps["remoteData"],
    tasks: [graphTask],
    workflowSteps: [],
    subscribePluginEvents: vi.fn(() => vi.fn()),
    openDetailTask: vi.fn(),
    openFileInBrowser: vi.fn(),
    workflowStepNameLookup: new Map(),
    prAuthAvailable: false,
    autoMerge: true,
    mergeStrategy: "direct",
    settingsLoaded: true,
    openTasksInRightSidebar: false,
    openMobileTasksInPopup: false,
    taskPopupsBoardListOnly: true,
    showCostBadgeOnCards: false,
    taskDetailChatFirst: false,
    chatMessageLayout: "bubbles",
    skillsEnabled: true,
    experimentalFeatures: {},
    setQuickChatOpen: vi.fn(),
    setMailboxUnreadCount: vi.fn(),
    setMissionTargetId: vi.fn(),
    setMissionResumeSessionId: vi.fn(),
    setMilestoneSliceResumeSessionId: vi.fn(),
    missionResumeSessionId: undefined,
    missionTargetId: undefined,
    milestoneSliceResumeSessionId: undefined,
    setGoalAnchorId: vi.fn(),
    goalAnchorId: undefined,
    agentsEnabled: true,
    agentOnboardingEnabled: false,
    handleOpenTaskLogs: vi.fn(),
    popOutTaskDetail: vi.fn(),
    selectedPrId: undefined,
    insightsEnabled: true,
    handleInsightTaskCreate: vi.fn(),
    researchEnabled: true,
    openSettingsWithNav: vi.fn(),
    researchReadinessVersion: 0,
    evalsEnabled: true,
    memoryEnabled: true,
    goalsEnabled: true,
    handleOpenMission: vi.fn(),
    openPlanningWithInitialPlanWithNav: vi.fn(),
    ingestCreatedTasks: vi.fn(),
    nodesEnabled: true,
    openWorkflowEditorWithNav: vi.fn(),
    handlePlanningTaskCreated: vi.fn(),
    handlePlanningTasksCreated: vi.fn(),
    handleGitHubImport: vi.fn(),
    devServerEnabled: true,
    mainPanelDetailTask: null,
    filteredBoardTasks: [],
    maxConcurrent: 2,
    moveTask: vi.fn(),
    pauseTask: vi.fn(),
    openTaskDetailInMainPanel: vi.fn(),
    openGroupModalWithNav: vi.fn(),
    handleBoardQuickCreate: vi.fn(),
    openNewTaskWithNav: vi.fn(),
    subtaskBreakdownEnabled: true,
    toggleAutoMerge: vi.fn(),
    globalPaused: false,
    updateTask: vi.fn(),
    retryTask: vi.fn(),
    deleteTask: vi.fn(),
    searchQuery: "",
    availableModels: [],
    favoriteProviders: [],
    favoriteModels: [],
    handleOpenDetailWithTab: vi.fn(),
    handleToggleFavorite: vi.fn(),
    handleToggleModelFavorite: vi.fn(),
    staleHighFanoutBlockerAgeThresholdMs: 0,
    lastFetchTimeMs: undefined,
    openCreateWorkflowWithNav: vi.fn(),
    sidebarActive: false,
    isMobile: false,
    mainPanelDetailInitialTab: "chat",
    closeTaskDetailMainPanel: vi.fn(),
    setMainPanelDetailTask: vi.fn(),
    mergeTask: vi.fn(),
    resetTask: vi.fn(),
    duplicateTask: vi.fn(),
    unpauseTask: vi.fn(),
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as unknown as MainContentProps["capacityRiskSignal"],
    handleDismissCapacityRisk: vi.fn(),
    AgentsView: LazyStub as MainContentProps["AgentsView"],
    ChatView: LazyStub as MainContentProps["ChatView"],
    CommandCenter: LazyStub as MainContentProps["CommandCenter"],
    DevServerView: LazyStub as MainContentProps["DevServerView"],
    DocumentsView: LazyStub as MainContentProps["DocumentsView"],
    EvalsView: LazyStub as MainContentProps["EvalsView"],
    GoalsView: LazyStub as MainContentProps["GoalsView"],
    InsightsView: LazyStub as MainContentProps["InsightsView"],
    MemoryView: LazyStub as MainContentProps["MemoryView"],
    PullRequestView: LazyStub as MainContentProps["PullRequestView"],
    ResearchView: LazyStub as MainContentProps["ResearchView"],
    SecretsView: LazyStub as MainContentProps["SecretsView"],
    SkillsView: LazyStub as MainContentProps["SkillsView"],
    _AutomationsView: LazyStub as MainContentProps["_AutomationsView"],
    _ImportTasksView: LazyStub as MainContentProps["_ImportTasksView"],
    _SettingsView: LazyStub as MainContentProps["_SettingsView"],
    _WorkflowEditorView: LazyStub as MainContentProps["_WorkflowEditorView"],
    ...overrides,
  };
}

describe("MainContent graph task pop-out wiring", () => {
  it("refreshes app settings when the embedded Settings view closes", async () => {
    const closeSettings = vi.fn();
    const handleChangeTaskView = vi.fn();
    const refreshAppSettings = vi.fn(async () => undefined);

    render(
      <MainContent
        {...mainContentProps({
          taskView: "settings",
          modalManager: { closeSettings, settingsInitialSection: undefined, openWorkflowEditor: vi.fn() } as unknown as MainContentProps["modalManager"],
          handleChangeTaskView,
          refreshAppSettings,
          _SettingsView: LazySettingsCloseStub as MainContentProps["_SettingsView"],
        })}
      />,
    );

    await screen.findByText("Close settings view");
    screen.getByText("Close settings view").click();

    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(handleChangeTaskView).toHaveBeenCalledWith("board");
    expect(refreshAppSettings).toHaveBeenCalledTimes(1);
  });

  it("forwards every live Appearance value and callback to embedded Settings", async () => {
    embeddedSettingsProps = undefined;
    const setters = {
      setChatMessageLayoutImmediate: vi.fn(),
      setOpenTasksInRightSidebarImmediate: vi.fn(),
      setOpenMobileTasksInPopupImmediate: vi.fn(),
      setTaskPopupsBoardListOnlyImmediate: vi.fn(),
      setShowCostBadgeOnCardsImmediate: vi.fn(),
      setTaskDetailChatFirstImmediate: vi.fn(),
    };

    render(<MainContent {...mainContentProps({
      taskView: "settings",
      chatMessageLayout: "full-width",
      openTasksInRightSidebar: true,
      openMobileTasksInPopup: true,
      taskPopupsBoardListOnly: false,
      showCostBadgeOnCards: true,
      taskDetailChatFirst: true,
      ...setters,
      _SettingsView: LazySettingsBridgeStub as MainContentProps["_SettingsView"],
    })} />);

    await screen.findByText("Embedded settings bridge");
    expect(embeddedSettingsProps).toMatchObject({
      chatMessageLayout: "full-width",
      openTasksInRightSidebar: true,
      openMobileTasksInPopup: true,
      taskPopupsBoardListOnly: false,
      showCostBadgeOnCards: true,
      taskDetailChatFirst: true,
    });

    (embeddedSettingsProps?.onChatMessageLayoutChange as (value: "bubbles" | "full-width") => void)("bubbles");
    (embeddedSettingsProps?.onOpenTasksInRightSidebarChange as (value: boolean) => void)(false);
    (embeddedSettingsProps?.onOpenMobileTasksInPopupChange as (value: boolean) => void)(false);
    (embeddedSettingsProps?.onTaskPopupsBoardListOnlyChange as (value: boolean) => void)(true);
    (embeddedSettingsProps?.onShowCostBadgeOnCardsChange as (value: boolean) => void)(false);
    (embeddedSettingsProps?.onTaskDetailChatFirstChange as (value: boolean) => void)(false);

    expect(setters.setChatMessageLayoutImmediate).toHaveBeenCalledWith("bubbles");
    expect(setters.setOpenTasksInRightSidebarImmediate).toHaveBeenCalledWith(false);
    expect(setters.setOpenMobileTasksInPopupImmediate).toHaveBeenCalledWith(false);
    expect(setters.setTaskPopupsBoardListOnlyImmediate).toHaveBeenCalledWith(true);
    expect(setters.setShowCostBadgeOnCardsImmediate).toHaveBeenCalledWith(false);
    expect(setters.setTaskDetailChatFirstImmediate).toHaveBeenCalledWith(false);
  });

  it("routes dependency-graph bridge and rendered task-card opens to the shared pop-out", () => {
    hostContexts.length = 0;
    const openDetailTask = vi.fn();
    const popOutTaskDetail = vi.fn();

    render(<MainContent {...mainContentProps({ openDetailTask, popOutTaskDetail })} />);

    expect(screen.getByTestId("graph-workflow-switcher")).toBeInTheDocument();
    screen.getByText("Open from plugin bridge").click();
    expect(popOutTaskDetail).toHaveBeenCalledWith(graphTask);
    expect(openDetailTask).not.toHaveBeenCalled();

    screen.getByText("Open rendered task card").click();
    expect(popOutTaskDetail).toHaveBeenCalledTimes(2);
    expect(popOutTaskDetail).toHaveBeenLastCalledWith(graphTask);
    expect(openDetailTask).not.toHaveBeenCalled();
  });

  it("keeps non-graph plugin views on the fixed task-detail modal path", () => {
    hostContexts.length = 0;
    const openDetailTask = vi.fn();
    const popOutTaskDetail = vi.fn();

    render(
      <MainContent
        {...mainContentProps({
          taskView: "plugin:example:dashboard",
          graphPluginTaskView: null,
          openDetailTask,
          popOutTaskDetail,
        })}
      />,
    );

    screen.getByText("Open from plugin bridge").click();
    expect(openDetailTask).toHaveBeenCalledWith(graphTask, "logs");
    expect(popOutTaskDetail).not.toHaveBeenCalled();

    screen.getByText("Open rendered task card").click();
    expect(openDetailTask).toHaveBeenCalledTimes(2);
    expect(openDetailTask).toHaveBeenLastCalledWith(graphTask, undefined);
    expect(popOutTaskDetail).not.toHaveBeenCalled();
  });

  it("uses the same graph pop-out path when rendered for mobile", () => {
    const openDetailTask = vi.fn();
    const popOutTaskDetail = vi.fn();

    render(<MainContent {...mainContentProps({ isMobile: true, openDetailTask, popOutTaskDetail })} />);

    screen.getByText("Open from plugin bridge").click();
    expect(popOutTaskDetail).toHaveBeenCalledWith(graphTask);
    expect(openDetailTask).not.toHaveBeenCalled();
  });

  it("dedupes repeat pop-outs by task id while allowing distinct task windows", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => result.current.popOut(graphTask));
    act(() => result.current.popOut(graphTask));
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]?.id).toBe("FN-GRAPH");

    act(() => result.current.popOut(otherTask));
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-GRAPH", "FN-OTHER"]);
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-05:20:
  A PLUGIN-RENDERED CARD RESOLVED NO COLUMN TRAITS AT ALL.

  `renderTaskCard` is how a plugin view draws a real task card. It built a `TaskCard` without
  `taskColumnFlags`, so every role helper inside that card fell back to the legacy id — Revert
  affordances, progress, the elapsed-time indicator, and the planning badge — for every plugin
  view on every board. The map was already in this component's scope; the card was simply never
  given it.

  The same omission existed in `useRightDockController`'s `renderTaskCard`, which also had the map in
  scope. Both are fixed together: this is one affordance with two producers, which is the shape the
  Surface Enumeration rule exists for.

  REVERT CHECK: drop `taskColumnFlags` from either `renderTaskCard` and this reads "none".
  */
  it("hands a plugin-rendered card its own resolved column traits", () => {
    hostContexts.length = 0;
    render(
      <MainContent
        {...mainContentProps({
          taskView: "graph",
          columnFlagsByTaskId: new Map([[graphTask.id, { complete: true }]]),
        })}
      />,
    );

    const card = screen.getByTestId("rendered-task-card").querySelector("button");
    expect(card?.getAttribute("data-column-flags")).toBe(JSON.stringify({ complete: true }));
  });
});
