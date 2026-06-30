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
  TaskCard: ({ task, onOpenDetail }: { task: Task | TaskDetail; onOpenDetail: (task: Task | TaskDetail) => void }) => (
    <button type="button" onClick={() => onOpenDetail(task)}>Open rendered task card</button>
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
    todosEnabled: true,
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
    openSubtaskBreakdownWithNav: vi.fn(),
    toggleAutoMerge: vi.fn(),
    globalPaused: false,
    updateTask: vi.fn(),
    retryTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    deleteTask: vi.fn(),
    archiveAllDone: vi.fn(),
    loadArchivedTasks: vi.fn(),
    searchQuery: "",
    availableModels: [],
    favoriteProviders: [],
    favoriteModels: [],
    handleOpenDetailWithTab: vi.fn(),
    handleToggleFavorite: vi.fn(),
    handleToggleModelFavorite: vi.fn(),
    taskStuckTimeoutMs: undefined,
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
    TodoView: LazyStub as MainContentProps["TodoView"],
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
});
