import type { ReactElement, ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, type RenderOptions } from "@testing-library/react";
import { AppModals } from "../AppModals";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import type { ModalManager } from "../../hooks/useModalManager";
import type { Toast } from "../../hooks/useToast";

// Mock the modals to avoid rendering all of them
const mockTaskDetailModalProps = vi.fn();
vi.mock("../TaskDetailModal", () => ({
  TaskDetailModal: (props: any) => {
    mockTaskDetailModalProps(props);
    return (
      <button data-testid="task-detail-open-detail" onClick={() => props.onOpenDetail?.({ id: "FN-2", title: "Nested" })}>
        open detail
      </button>
    );
  },
}));

const mockSettingsModalProps = vi.fn();
vi.mock("../SettingsModal", () => ({
  SettingsModal: (props: any) => {
    mockSettingsModalProps(props);
    return <div data-testid="settings-modal">Settings Modal</div>;
  },
}));

vi.mock("../GitHubImportModal", () => ({
  GitHubImportModal: () => null,
}));

vi.mock("../PlanningModeModal", () => ({
  PlanningModeModal: () => null,
}));

vi.mock("../SubtaskBreakdownModal", () => ({
  SubtaskBreakdownModal: () => null,
}));

vi.mock("../TerminalModal", () => ({
  TerminalModal: () => null,
}));

vi.mock("../ScriptsModal", () => ({
  ScriptsModal: () => null,
}));

vi.mock("../FileBrowserModal", () => ({
  FileBrowserModal: () => null,
}));

const mockTodoModalProps = vi.fn();
vi.mock("../TodoModal", () => ({
  TodoModal: (props: any) => {
    mockTodoModalProps(props);
    return null;
  },
}));

vi.mock("../UsageIndicator", () => ({
  UsageIndicator: () => null,
}));

// Mock ScheduledTasksModal to capture props
const mockScheduledTasksModalProps = vi.fn();
vi.mock("../ScheduledTasksModal", () => ({
  ScheduledTasksModal: ({ projectId, ...rest }: any) => {
    mockScheduledTasksModalProps({ projectId, rest });
    return null;
  },
}));

vi.mock("../NewTaskModal", () => ({
  NewTaskModal: () => null,
}));

const mockSystemStatsModalProps = vi.fn();
vi.mock("../SystemStatsModal", () => ({
  SystemStatsModal: (props: any) => {
    mockSystemStatsModalProps(props);
    return null;
  },
}));

const mockActivityLogModalProps = vi.fn();
vi.mock("../ActivityLogModal", () => ({
  ActivityLogModal: (props: any) => {
    mockActivityLogModalProps(props);
    return (
      <button data-testid="activity-log-open-task" onClick={() => props.onOpenTaskDetail?.("FN-1")}>
        open task detail
      </button>
    );
  },
}));

vi.mock("../GitManagerModal", () => ({
  GitManagerModal: () => null,
}));

vi.mock("../AgentListModal", () => ({
  AgentListModal: () => null,
}));

vi.mock("../SetupWizardModal", () => ({
  SetupWizardModal: () => null,
}));

const mockModelOnboardingModalProps = vi.fn();
vi.mock("../ModelOnboardingModal", () => ({
  ModelOnboardingModal: (props: any) => {
    mockModelOnboardingModalProps(props);
    return (
      <button data-testid="onboarding-view-task" onClick={() => props.onViewTask?.({ id: "FN-1", title: "Created task" })}>
        view task
      </button>
    );
  },
}));

vi.mock("../ToastContainer", () => ({
  ToastContainer: () => null,
}));

vi.mock("../../hooks/useTaskHandlers", () => ({
  useTaskHandlers: () => ({
    handleModalCreate: vi.fn(),
    handlePlanningTaskCreated: vi.fn(),
    handlePlanningTasksCreated: vi.fn(),
    handleSubtaskTasksCreated: vi.fn(),
    handleGitHubImport: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjectActions", () => ({
  useProjectActions: () => ({
    handleSetupComplete: vi.fn(),
    handleModelOnboardingComplete: vi.fn(),
  }),
}));

// Mock @fusion/core types
vi.mock("@fusion/core", () => ({}));

// Mock ModalErrorBoundary
vi.mock("../ErrorBoundary", () => ({
  ModalErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function NavigationWrapper({ children }: { children: ReactNode }) {
  const history = useNavigationHistory({ enabled: true });
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, { wrapper: NavigationWrapper, ...options });
}

describe("AppModals", () => {
  const mockModalManager: ModalManager = {
    // State
    detailTask: null,
    detailTaskInitialTab: "definition",
    settingsOpen: false,
    settingsInitialSection: undefined,
    githubImportOpen: false,
    isPlanningOpen: false,
    planningInitialPlan: null,
    planningResumeSessionId: undefined,
    isSubtaskOpen: false,
    subtaskInitialDescription: null,
    subtaskResumeSessionId: undefined,
    terminalOpen: false,
    terminalInitialCommand: undefined,
    scriptsOpen: false,
    filesOpen: false,
    todosOpen: false,
    fileBrowserWorkspace: "project",
    fileBrowserInitialFile: null,
    usageOpen: false,
    usageAnchorRect: null,
    systemStatsOpen: false,
    schedulesOpen: false,
    newTaskModalOpen: false,
    activityLogOpen: false,
    gitManagerOpen: false,
    agentsOpen: false,
    setupWizardOpen: false,
    modelOnboardingOpen: false,
    anyModalOpen: false,
    // Handlers
    openDetailTask: vi.fn(),
    openDetailWithChangesTab: vi.fn(),
    updateDetailTask: vi.fn(),
    closeDetailTask: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    openGitHubImport: vi.fn(),
    closeGitHubImport: vi.fn(),
    openPlanning: vi.fn(),
    openPlanningWithInitialPlan: vi.fn(),
    resumePlanning: vi.fn(),
    openPlanningWithSession: vi.fn(),
    closePlanning: vi.fn(),
    openSubtaskBreakdown: vi.fn(),
    openSubtaskWithSession: vi.fn(),
    closeSubtask: vi.fn(),
    toggleTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    openScripts: vi.fn(),
    closeScripts: vi.fn(),
    runScript: vi.fn(),
    openFiles: vi.fn(),
    closeFiles: vi.fn(),
    openTodos: vi.fn(),
    closeTodos: vi.fn(),
    setFileWorkspace: vi.fn(),
    openUsage: vi.fn(),
    closeUsage: vi.fn(),
    openSystemStats: vi.fn(),
    closeSystemStats: vi.fn(),
    openSchedules: vi.fn(),
    closeSchedules: vi.fn(),
    openNewTask: vi.fn(),
    closeNewTask: vi.fn(),
    openActivityLog: vi.fn(),
    closeActivityLog: vi.fn(),
    openGitManager: vi.fn(),
    closeGitManager: vi.fn(),
    openAgents: vi.fn(),
    closeAgents: vi.fn(),
    openSetupWizard: vi.fn(),
    closeSetupWizard: vi.fn(),
    openModelOnboarding: vi.fn(),
    closeModelOnboarding: vi.fn(),
    onPlanningTaskCreated: vi.fn(),
    onPlanningTasksCreated: vi.fn(),
    onSubtaskTasksCreated: vi.fn(),
  };

  const mockToasts: Toast[] = [];
  const mockSettings = {
    prAuthAvailable: false,
    themeMode: "dark" as const,
    colorTheme: "default" as const,
    setThemeMode: vi.fn(),
    setColorTheme: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskDetailModalProps.mockClear();
    mockScheduledTasksModalProps.mockClear();
    mockModelOnboardingModalProps.mockClear();
    mockActivityLogModalProps.mockClear();
    mockSettingsModalProps.mockClear();
    mockSystemStatsModalProps.mockClear();
    mockTodoModalProps.mockClear();
  });

  it("renders without crashing", () => {
    render(
      <AppModals
        projectId={undefined}
        tasks={[]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={mockModalManager}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />
    );
    expect(document.body).toBeDefined();
  });

  it("renders TodoModal when todosOpen is true", () => {
    render(
      <AppModals
        projectId="proj-1"
        tasks={[]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={{ ...mockModalManager, todosOpen: true }}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />
    );

    expect(mockTodoModalProps).toHaveBeenCalledTimes(1);
  });

  it("does not render TodoModal when todosOpen is false", () => {
    render(
      <AppModals
        projectId="proj-1"
        tasks={[]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={{ ...mockModalManager, todosOpen: false }}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />
    );

    expect(mockTodoModalProps).not.toHaveBeenCalled();
  });

  it("passes the live board task snapshot into the open detail modal while preserving prompt data", async () => {
    const manager = {
      ...mockModalManager,
      detailTask: {
        id: "FN-123",
        title: "Stale detail task",
        description: "Original",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [{ timestamp: "2026-04-25T12:00:00.000Z", action: "Created task" }],
        prompt: "# Spec",
        createdAt: "2026-04-25T12:00:00.000Z",
        updatedAt: "2026-04-25T12:00:00.000Z",
      },
    };
    const liveTask = {
      id: "FN-123",
      title: "Live board task",
      description: "Updated",
      column: "in-progress" as const,
      status: "executing",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 300,
        cachedTokens: 100,
        cacheWriteTokens: 25,
        totalTokens: 1600,
        firstUsedAt: "2026-04-25T12:05:00.000Z",
        lastUsedAt: "2026-04-25T12:10:00.000Z",
      },
      createdAt: "2026-04-25T12:00:00.000Z",
      updatedAt: "2026-04-25T12:10:00.000Z",
    };

    render(
      <AppModals
        projectId={undefined}
        tasks={[liveTask]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={manager}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />,
    );

    await waitFor(() => {
      expect(mockTaskDetailModalProps).toHaveBeenCalled();
    });

    const detailTask = mockTaskDetailModalProps.mock.calls.at(-1)?.[0]?.task;
    expect(detailTask).toMatchObject({
      id: "FN-123",
      title: "Live board task",
      column: "in-progress",
      status: "executing",
      tokenUsage: liveTask.tokenUsage,
      prompt: "# Spec",
    });
    expect(detailTask.log).toEqual([
      { timestamp: "2026-04-25T12:00:00.000Z", action: "Created task" },
    ]);
  });

  describe("ModelOnboardingModal wiring", () => {
    it("passes empty project id and setup-wizard callback into onboarding modal when no project is selected", () => {
      const handleAddProject = vi.fn();
      const manager = { ...mockModalManager, modelOnboardingOpen: true };

      render(
        <AppModals
          projectId={undefined}
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject, handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      expect(mockModelOnboardingModalProps).toHaveBeenCalledTimes(1);
      const props = mockModelOnboardingModalProps.mock.calls[0][0];
      expect(props.projectId).toBe("");
      expect(props.onOpenSetupWizard).toBe(handleAddProject);
    });

    it("passes active project id into onboarding modal when a project is selected", () => {
      const manager = { ...mockModalManager, modelOnboardingOpen: true };

      render(
        <AppModals
          projectId="proj_123"
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      expect(mockModelOnboardingModalProps).toHaveBeenCalledTimes(1);
      const props = mockModelOnboardingModalProps.mock.calls[0][0];
      expect(props.projectId).toBe("proj_123");
    });
  });

  describe("Settings modal lazy loading", () => {
    it("renders SettingsModal asynchronously when settingsOpen is true", async () => {
      render(
        <AppModals
          projectId="proj-123"
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={{ ...mockModalManager, settingsOpen: true, settingsInitialSection: "memory" }}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      expect(await screen.findByTestId("settings-modal")).toBeInTheDocument();
      await waitFor(() => expect(mockSettingsModalProps).toHaveBeenCalled());
      const props = mockSettingsModalProps.mock.calls[0][0];
      expect(props.projectId).toBe("proj-123");
      expect(props.initialSection).toBe("memory");
    });
  });

  describe("ScheduledTasksModal projectId forwarding", () => {
    const commonProps = {
      tasks: [],
      projects: [],
      currentProject: null,
      toasts: mockToasts,
      removeToast: vi.fn(),
      projectActions: { handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() },
      taskHandlers: { handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() },
      taskOperations: { moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() },
      deepLink: { handleDetailClose: vi.fn() },
      settings: mockSettings,
    };

    it("does not render ScheduledTasksModal when schedulesOpen is false", () => {
      render(
        <AppModals
          {...commonProps}
          projectId="proj-123"
          addToast={vi.fn()}
          modalManager={{ ...mockModalManager, schedulesOpen: false }}
        />,
      );
      expect(mockScheduledTasksModalProps).not.toHaveBeenCalled();
    });

    it.each<[string, string | undefined, string | undefined]>([
      ["defined project id", "proj-abc", "proj-abc"],
      ["undefined project id", undefined, undefined],
      ["empty string project id passes through as-is", "", ""],
    ])("forwards projectId through to ScheduledTasksModal — %s", (_label, input, expected) => {
      render(
        <AppModals
          {...commonProps}
          projectId={input}
          addToast={vi.fn()}
          modalManager={{ ...mockModalManager, schedulesOpen: true }}
        />,
      );
      expect(mockScheduledTasksModalProps).toHaveBeenCalledTimes(1);
      expect(mockScheduledTasksModalProps.mock.calls[0][0].projectId).toBe(expected);
    });
  });

  describe("SystemStatsModal wiring", () => {
    const commonProps = {
      tasks: [],
      projects: [],
      currentProject: null,
      toasts: mockToasts,
      removeToast: vi.fn(),
      projectActions: { handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() },
      taskHandlers: { handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() },
      taskOperations: { moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() },
      deepLink: { handleDetailClose: vi.fn() },
      settings: mockSettings,
    };

    it("passes modal manager state and projectId through to SystemStatsModal", () => {
      const closeSystemStats = vi.fn();
      render(
        <AppModals
          {...commonProps}
          projectId="proj-system"
          addToast={vi.fn()}
          modalManager={{ ...mockModalManager, systemStatsOpen: true, closeSystemStats }}
        />,
      );

      expect(mockSystemStatsModalProps).toHaveBeenCalledTimes(1);
      expect(mockSystemStatsModalProps).toHaveBeenCalledWith(
        expect.objectContaining({
          isOpen: true,
          onClose: closeSystemStats,
          projectId: "proj-system",
        }),
      );
    });
  });

  describe("task detail history wiring", () => {
    const commonProps = {
      projectId: "proj-1",
      tasks: [{ id: "FN-1", title: "Task one" }],
      projects: [],
      currentProject: null,
      addToast: vi.fn(),
      toasts: mockToasts,
      removeToast: vi.fn(),
      projectActions: { handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() },
      taskHandlers: { handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() },
      taskOperations: { moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() },
      deepLink: { handleDetailClose: vi.fn() },
      settings: mockSettings,
    };

    it("pushes history for activity-log open and closes on popstate", async () => {
      const pushStateSpy = vi.spyOn(window.history, "pushState");
      const closeDetailTask = vi.fn();
      render(
        <AppModals
          {...commonProps}
          modalManager={{ ...mockModalManager, activityLogOpen: true, closeDetailTask }}
        />,
      );

      fireEvent.click(screen.getByTestId("activity-log-open-task"));
      expect(pushStateSpy).toHaveBeenCalled();

      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
      await waitFor(() => expect(closeDetailTask).toHaveBeenCalledTimes(1));
    });

    it("pushes history for onboarding view-task open and closes on popstate", async () => {
      const pushStateSpy = vi.spyOn(window.history, "pushState");
      const closeDetailTask = vi.fn();
      render(
        <AppModals
          {...commonProps}
          modalManager={{ ...mockModalManager, modelOnboardingOpen: true, closeDetailTask }}
        />,
      );

      fireEvent.click(screen.getByTestId("onboarding-view-task"));
      expect(pushStateSpy).toHaveBeenCalled();

      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
      await waitFor(() => expect(closeDetailTask).toHaveBeenCalledTimes(1));
    });

    it("pushes an additional history entry for task-to-task detail navigation", () => {
      const pushStateSpy = vi.spyOn(window.history, "pushState");
      render(
        <AppModals
          {...commonProps}
          modalManager={{ ...mockModalManager, detailTask: { id: "FN-1", title: "Task one" } }}
        />,
      );

      fireEvent.click(screen.getByTestId("task-detail-open-detail"));
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
      expect(mockModalManager.openDetailTask).toHaveBeenCalledWith({ id: "FN-2", title: "Nested" }, undefined);
    });
  });
});
