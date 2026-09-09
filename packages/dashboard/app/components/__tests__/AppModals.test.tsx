import { createElement, useEffect as reactUseEffect } from "react";
import type { ReactElement, ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render as rtlRender, screen, waitFor, type RenderOptions } from "@testing-library/react";
import { AppModals } from "../AppModals";
import { TaskCard } from "../TaskCard";
import { ListView } from "../ListView";
import { useTasks } from "../../hooks/useTasks";
import { clearCache, SWR_CACHE_KEYS } from "../../utils/swrCache";
import * as taskApi from "../../api";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import type { ModalManager } from "../../hooks/useModalManager";
import type { Toast } from "../../hooks/useToast";

const sseSubscriptions = vi.hoisted(() => [] as Array<{
  url: string;
  events?: Record<string, (event: { data: string }) => void>;
}>);
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((url: string, options: { events?: Record<string, (event: { data: string }) => void> }) => {
    sseSubscriptions.push({ url, events: options.events });
    return vi.fn();
  }),
}));

// Spy through the real detail host so lifecycle assertions exercise its rendered state.
const mockTaskDetailModalProps = vi.fn();
vi.mock("../TaskDetailModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../TaskDetailModal")>();
  return {
    ...actual,
    TaskDetailModal: (props: React.ComponentProps<typeof actual.TaskDetailModal>) => {
      mockTaskDetailModalProps(props);
      return createElement(actual.TaskDetailModal, props);
    },
  };
});

const mockSettingsModalProps = vi.fn();
vi.mock("../SettingsModal", () => ({
  SettingsModal: (props: any) => {
    mockSettingsModalProps(props);
    return <div data-testid="settings-modal">Settings Modal</div>;
  },
}));


/*
FNXC:Terminal 2026-07-26-19:50:
This mock is VESTIGIAL: AppModals does not render TerminalModal — App.tsx does, gated on
`modalManager.terminalOpen`. It is kept only to keep the heavy xterm module out of this file's graph if
an import path ever reaches it. It is deliberately NOT a shallow `isOpen ? <div/> : null` stand-in,
because that shape is what made App's terminal mount/unmount invariant unverifiable (see the lifecycle
recorder in App.test.tsx). The guard below fails if the terminal ever moves into AppModals, so this mock
cannot silently become the thing that hides the invariant a second time.
*/
vi.mock("../TerminalModal", () => ({
  TerminalModal: () => null,
}));

vi.mock("../ScriptsModal", () => ({
  ScriptsModal: () => null,
}));

vi.mock("../FileBrowserModal", () => ({
  FileBrowserModal: () => null,
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

const mockNewTaskModalProps = vi.fn();
vi.mock("../NewTaskModal", () => ({
  NewTaskModal: (props: any) => {
    mockNewTaskModalProps(props);
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

const githubImportMounts = vi.hoisted(() => [] as string[]);
vi.mock("../GitHubImportModal", () => ({
  GitHubImportModal: ({ projectId }: { projectId?: string }) => {
    if (projectId) githubImportMounts.push(projectId);
    return null;
  },
}));

vi.mock("../GitManagerModal", () => ({
  GitManagerModal: () => null,
}));

vi.mock("../AgentListModal", () => ({
  AgentListModal: () => null,
}));

const mockSetupWizardModalProps = vi.fn();
vi.mock("../SetupWizardModal", () => ({
  SetupWizardModal: (props: any) => {
    mockSetupWizardModalProps(props);
    return <div data-testid="setup-wizard-modal" />;
  },
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

    handleGitHubImport: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjectActions", () => ({
  useProjectActions: () => ({
    handleSetupComplete: vi.fn(),
    handleModelOnboardingComplete: vi.fn(),
  }),
}));

// Preserve runtime core constants because the real TaskDetailModal now renders in this suite.
vi.mock("@fusion/core", async (importOriginal) => importOriginal<typeof import("@fusion/core")>());

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

const integrationNoop = vi.fn();
const integrationAsyncNoop = vi.fn(async () => ({}));

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn() });
  }
}

function mockMobileViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 600px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function restoreDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Drives the same hook-owned board row into every production status renderer. */
function PlanningStatusConvergenceHarness({ detailTask, modalManager, settings }: {
  detailTask: Record<string, unknown>;
  modalManager: ModalManager;
  settings: Record<string, unknown>;
}) {
  const { tasks } = useTasks({ projectId: "project-a" });
  const task = tasks[0];
  if (!task) return null;

  return (
    <>
      <TaskCard task={task} onOpenDetail={integrationNoop} addToast={integrationNoop} projectId="project-a" />
      <ListView
        tasks={tasks}
        projectId="project-a"
        onMoveTask={integrationAsyncNoop}
        onDeleteTask={integrationAsyncNoop}
        onMergeTask={integrationAsyncNoop}
        onOpenDetail={integrationNoop}
        addToast={integrationNoop}
      />
      <AppModals
        projectId="project-a"
        tasks={tasks}
        projects={[]}
        currentProject={null}
        addToast={integrationNoop}
        toasts={[]}
        removeToast={integrationNoop}
        modalManager={modalManager}
        projectActions={{ handleAddProject: integrationNoop, handleSetupComplete: integrationNoop, handleModelOnboardingComplete: integrationNoop }}
        taskHandlers={{ handleModalCreate: integrationAsyncNoop, handlePlanningTaskCreated: integrationNoop, handlePlanningTasksCreated: integrationNoop, handleGitHubImport: integrationNoop }}
        taskOperations={{ moveTask: integrationAsyncNoop, deleteTask: integrationAsyncNoop, mergeTask: integrationAsyncNoop, retryTask: integrationAsyncNoop, duplicateTask: integrationAsyncNoop }}
        deepLink={{ handleDetailClose: integrationNoop }}
        settings={settings as any}
      />
      <output data-testid="planning-harness-detail-id">{String(detailTask.id)}</output>
    </>
  );
}

describe("AppModals", () => {
  const mockModalManager: ModalManager = {
    // State
    detailTask: null,
    detailTaskInitialTab: "chat",
    settingsOpen: false,
    settingsInitialSection: undefined,
    githubImportOpen: false,
    isPlanningOpen: false,
    planningInitialPlan: null,
    planningResumeSessionId: undefined,
    terminalOpen: false,
    terminalInitialCommand: undefined,
    terminalInitialCommandGeneration: 0,
    scriptsOpen: false,
    filesOpen: false,
    fileBrowserWorkspace: "project",
    fileBrowserInitialFile: null,
    usageOpen: false,
    usageAnchorRect: null,
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
    toggleTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    openScripts: vi.fn(),
    closeScripts: vi.fn(),
    runScript: vi.fn(),
    openFiles: vi.fn(),
    closeFiles: vi.fn(),
    setFileWorkspace: vi.fn(),
    openUsage: vi.fn(),
    closeUsage: vi.fn(),
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
    closeProjectScopedModals: vi.fn(),
    onPlanningTaskCreated: vi.fn(),
    onPlanningTasksCreated: vi.fn(),
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
    sseSubscriptions.length = 0;
    vi.spyOn(taskApi, "fetchCompletedTasks").mockResolvedValue({ tasks: [], total: 0, hasMore: false });
    clearCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}project-a`);
    mockTaskDetailModalProps.mockClear();
    mockScheduledTasksModalProps.mockClear();
    mockModelOnboardingModalProps.mockClear();
    mockActivityLogModalProps.mockClear();
    mockSettingsModalProps.mockClear();
    mockNewTaskModalProps.mockClear();
    restoreDesktopViewport();
  });

  it("bridges the production move handler into NewTaskModal Start", async () => {
    const moveTask = vi.fn();
    render(
      <AppModals
        projectId="project-a"
        tasks={[]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={{ ...mockModalManager, newTaskModalOpen: true }}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask, deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />,
    );

    const modalProps = mockNewTaskModalProps.mock.calls[0]?.[0];
    expect(modalProps?.onMoveTask).toEqual(expect.any(Function));
    await modalProps.onMoveTask("FN-START", "building");
    expect(moveTask).toHaveBeenCalledWith("FN-START", "building");
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
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />
    );
    expect(document.body).toBeDefined();
  });

  /*
  FNXC:ProjectSwitchModalReset 2026-08-20-18:40:
  Switching projects must remount project-keyed modals. A prop update on the surviving
  instance can persist the old project's draft under the new project's storage key.
  */
  it("remounts the project-keyed GitHub import modal when the active project changes", () => {
    const buildProps = (projectId: string) => ({
      projectId,
      tasks: [],
      projects: [],
      currentProject: null,
      addToast: vi.fn(),
      toasts: mockToasts,
      removeToast: vi.fn(),
      modalManager: mockModalManager,
      projectActions: { handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() },
      taskHandlers: { handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() },
      taskOperations: { moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() },
      deepLink: { handleDetailClose: vi.fn() },
      settings: mockSettings,
    });

    githubImportMounts.length = 0;
    const { rerender } = render(<AppModals {...buildProps("proj_a")} />);
    expect(githubImportMounts).toEqual(["proj_a"]);

    rerender(<AppModals {...buildProps("proj_b")} />);

    // A fresh mount for the new project — not a prop update on the old instance.
    expect(githubImportMounts).toEqual(["proj_a", "proj_b"]);
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
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
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

  /*
  FNXC:TaskDetailStateStability 2026-08-05-02:55:
  This is the rendered production modal reproduction: scheduler resync delivers Todo after the
  dependency/file-overlap queue transition. The open detail must continuously show Queued because
  AppModals reconciles its retained detail snapshot with the live board by lifecycle freshness.
  */
  it("does not roll an open queued detail back when a stale scheduler board row arrives", async () => {
    const detail = {
      id: "FN-QUEUED",
      title: "Blocked task",
      description: "",
      column: "todo",
      status: "queued",
      overlapBlockedBy: "FN-UPSTREAM",
      dependencies: ["FN-UPSTREAM"],
      steps: [],
      log: [{ timestamp: "2026-08-05T10:02:00.000Z", action: "Queued for dependency" }],
      prompt: "# Prompt",
      createdAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:02:00.000Z",
      columnMovedAt: "2026-08-05T10:02:00.000Z",
    };
    const staleSchedulerTodo = {
      ...detail,
      status: undefined,
      prompt: undefined,
      log: [],
      updatedAt: "2026-08-05T10:00:00.000Z",
      columnMovedAt: "2026-08-05T10:00:00.000Z",
    };
    const manager = { ...mockModalManager, detailTask: detail };

    const renderModal = (tasks: typeof detail[]) => (
      <AppModals
        projectId="project-a"
        tasks={tasks}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={manager}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />
    );
    const { rerender } = render(renderModal([detail]));
    await waitFor(() => expect(mockTaskDetailModalProps).toHaveBeenCalled());

    rerender(renderModal([staleSchedulerTodo]));

    const renderedTask = mockTaskDetailModalProps.mock.calls.at(-1)?.[0]?.task;
    expect(renderedTask).toMatchObject({ status: "queued", overlapBlockedBy: "FN-UPSTREAM", prompt: "# Prompt" });
    expect(renderedTask.log).toEqual(detail.log);
  });

  it("keeps an open planning detail authoritative while the board has only live planner evidence", async () => {
    const detail = {
      id: "FN-8798",
      title: "Revision task",
      description: "",
      column: "triage" as const,
      status: "planning",
      dependencies: [],
      steps: [],
      log: [],
      prompt: "# Prompt",
      createdAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:01:00.000Z",
    };
    const boardRow = {
      ...detail,
      status: "needs-replan",
      prompt: undefined,
      updatedAt: "2026-08-05T10:00:00.000Z",
      recentAgentActivityAt: "2026-08-05T10:01:00.000Z",
    };
    const manager = { ...mockModalManager, detailTask: detail };

    render(
      <AppModals
        projectId="project-a"
        tasks={[boardRow]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={manager}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />,
    );

    await waitFor(() => expect(mockTaskDetailModalProps).toHaveBeenCalled());
    expect(mockTaskDetailModalProps.mock.calls.at(-1)?.[0]?.task).toMatchObject({
      id: "FN-8798",
      status: "planning",
      prompt: "# Prompt",
    });
    expect(screen.getByTestId("task-detail-status-badge")).toHaveTextContent("Planning");
  });

  it("drives SSE planner activity and its authoritative status update through board, the desktop list row, and the real detail host", async () => {
    vi.spyOn(taskApi, "fetchTasks").mockReset();
    vi.spyOn(taskApi, "fetchBoardWorkflows").mockReset();
    window.localStorage.setItem("kb:project-a:kb-dashboard-list-columns", JSON.stringify(["title", "status"]));
    const parkedTask = {
      id: "FN-8798",
      title: "Revision task",
      description: "",
      column: "triage" as const,
      status: "needs-replan",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# Prompt",
      createdAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:00:00.000Z",
      columnMovedAt: "2026-08-05T10:00:00.000Z",
    };
    const manager = { ...mockModalManager, detailTask: parkedTask };
    vi.spyOn(taskApi, "fetchTasks").mockResolvedValueOnce([parkedTask] as any);
    vi.spyOn(taskApi, "fetchBoardWorkflows").mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [{ id: "triage", name: "Planning", flags: { intake: true } }],
      }],
      taskWorkflowIds: { [parkedTask.id]: "builtin:coding" },
    });

    render(<PlanningStatusConvergenceHarness detailTask={parkedTask} modalManager={manager} settings={mockSettings} />);

    await waitFor(() => expect(sseSubscriptions.some(({ url }) => url.startsWith("/api/events"))).toBe(true));
    const boardEvents = sseSubscriptions.find(({ url }) => url.startsWith("/api/events"))?.events;
    act(() => {
      boardEvents?.["agent:log"]?.({ data: JSON.stringify({
        taskId: parkedTask.id,
        timestamp: "2026-08-05T10:01:00.000Z",
        type: "tool",
        agent: "triage",
      }) });
      boardEvents?.["task:updated"]?.({ data: JSON.stringify({
        ...parkedTask,
        status: "planning",
        updatedAt: "2026-08-05T10:02:00.000Z",
      }) });
    });

    await waitFor(() => {
      expect(document.querySelector('.card[data-id="FN-8798"] .card-status-badge')).toHaveTextContent("Planning");
      expect(document.querySelector('tr[data-id="FN-8798"] td.list-cell .list-status-badge')).toHaveTextContent("Planning");
      expect(screen.getByTestId("task-detail-status-badge")).toHaveTextContent("Planning");
    });

    const inProgressTask = {
      ...parkedTask,
      column: "in-progress" as const,
      status: "planning",
      updatedAt: "2026-08-05T10:03:00.000Z",
      columnMovedAt: "2026-08-05T10:03:00.000Z",
    };
    act(() => {
      boardEvents?.["task:moved"]?.({ data: JSON.stringify({
        task: inProgressTask,
        from: "triage",
        to: "in-progress",
      }) });
    });

    await waitFor(() => {
      expect(document.querySelector('.card[data-id="FN-8798"] .card-status-badge')).toHaveTextContent("Planning");
      expect(document.querySelector('tr[data-id="FN-8798"] td.list-cell .list-status-badge')).toHaveTextContent("Planning");
      expect(screen.getByTestId("task-detail-status-badge")).toHaveTextContent("Planning");
    });

    vi.mocked(taskApi.fetchTasks).mockResolvedValueOnce([{
      ...inProgressTask,
      status: null,
    }] as any);
    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(taskApi.fetchTasks).toHaveBeenCalledTimes(2));
    /*
    FNXC:TaskStatusBadge 2026-08-09-08:24:
    FN-8826's empty-status WIP lifecycle fallback and FN-8764/FN-8798's stale-planning
    retirement are compatible: an authoritative status:null refresh must stop the card claiming
    Planning, not stop it rendering its In Progress lifecycle badge. The detail header intentionally
    has no fallback because its sibling .detail-column-badge already names the lane.
    */
    await waitFor(() => {
      const card = document.querySelector('.card[data-id="FN-8798"]');
      const cardBadge = card?.querySelector(".card-status-badge");
      const desktopListBadge = document.querySelector('tr[data-id="FN-8798"] td.list-cell .list-status-badge');
      expect(card).toBeInTheDocument();
      expect(cardBadge).toHaveTextContent(/in progress/i);
      expect(cardBadge).not.toHaveTextContent(/planning/i);
      expect(cardBadge?.className).not.toMatch(/queued-to-plan|planning/i);
      expect(desktopListBadge).toHaveTextContent(/in progress/i);
      expect(desktopListBadge).not.toHaveTextContent(/planning/i);
      expect(document.querySelector("#task-detail-modal-title")).toHaveTextContent("FN-8798");
      expect(screen.queryByTestId("task-detail-status-badge")).not.toBeInTheDocument();
    });
  });

  /*
  FNXC:TaskStatusBadge 2026-08-09-08:24:
  ListView has two responsive status-badge renderers: .list-card on mobile and td.list-cell on
  desktop. Both share getTaskWipLifecycleBadgeLabel, but one jsdom render exercises only desktop,
  so this cross-surface guard explicitly mounts and proves the mobile renderer.
  */
  it("drives SSE planner activity and its authoritative status update through board, the mobile list card, and the real detail host", async () => {
    vi.spyOn(taskApi, "fetchTasks").mockReset();
    vi.spyOn(taskApi, "fetchBoardWorkflows").mockReset();
    const viewportSpy = mockMobileViewport();
    try {
      window.localStorage.setItem("kb:project-a:kb-dashboard-list-columns", JSON.stringify(["title", "status"]));
      const parkedTask = {
        id: "FN-8798",
        title: "Revision task",
        description: "",
        column: "triage" as const,
        status: "needs-replan",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        prompt: "# Prompt",
        createdAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-08-05T10:00:00.000Z",
        columnMovedAt: "2026-08-05T10:00:00.000Z",
      };
      const manager = { ...mockModalManager, detailTask: parkedTask };
      vi.spyOn(taskApi, "fetchTasks").mockResolvedValueOnce([parkedTask] as any);
      vi.spyOn(taskApi, "fetchBoardWorkflows").mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [{ id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Planning", flags: { intake: true } }] }],
        taskWorkflowIds: { [parkedTask.id]: "builtin:coding" },
      });

      render(<PlanningStatusConvergenceHarness detailTask={parkedTask} modalManager={manager} settings={mockSettings} />);
      await waitFor(() => expect(sseSubscriptions.some(({ url }) => url.startsWith("/api/events"))).toBe(true));
      await waitFor(() => {
        expect(document.querySelector(".list-cards")).toBeInTheDocument();
        expect(document.querySelector('tr[data-id="FN-8798"]')).not.toBeInTheDocument();
      });
      const boardEvents = sseSubscriptions.find(({ url }) => url.startsWith("/api/events"))?.events;
      act(() => {
        boardEvents?.["agent:log"]?.({ data: JSON.stringify({ taskId: parkedTask.id, timestamp: "2026-08-05T10:01:00.000Z", type: "tool", agent: "triage" }) });
        boardEvents?.["task:updated"]?.({ data: JSON.stringify({ ...parkedTask, status: "planning", updatedAt: "2026-08-05T10:02:00.000Z" }) });
      });
      await waitFor(() => {
        expect(document.querySelector('.card[data-id="FN-8798"] .card-status-badge')).toHaveTextContent("Planning");
        expect(document.querySelector(".list-card .list-status-badge")).toHaveTextContent("Planning");
        expect(screen.getByTestId("task-detail-status-badge")).toHaveTextContent("Planning");
      });

      const inProgressTask = { ...parkedTask, column: "in-progress" as const, status: "planning", updatedAt: "2026-08-05T10:03:00.000Z", columnMovedAt: "2026-08-05T10:03:00.000Z" };
      act(() => boardEvents?.["task:moved"]?.({ data: JSON.stringify({ task: inProgressTask, from: "triage", to: "in-progress" }) }));
      await waitFor(() => {
        expect(document.querySelector('.card[data-id="FN-8798"] .card-status-badge')).toHaveTextContent("Planning");
        expect(document.querySelector(".list-card .list-status-badge")).toHaveTextContent("Planning");
        expect(screen.getByTestId("task-detail-status-badge")).toHaveTextContent("Planning");
      });

      vi.mocked(taskApi.fetchTasks).mockResolvedValueOnce([{ ...inProgressTask, status: null }] as any);
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(taskApi.fetchTasks).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        const card = document.querySelector('.card[data-id="FN-8798"]');
        const cardBadge = card?.querySelector(".card-status-badge");
        const mobileListBadge = document.querySelector(".list-card .list-status-badge");
        expect(card).toBeInTheDocument();
        expect(cardBadge).toHaveTextContent(/in progress/i);
        expect(cardBadge).not.toHaveTextContent(/planning/i);
        expect(cardBadge?.className).not.toMatch(/queued-to-plan|planning/i);
        expect(mobileListBadge).toHaveTextContent(/in progress/i);
        expect(mobileListBadge).not.toHaveTextContent(/planning/i);
        expect(document.querySelector("#task-detail-modal-title")).toHaveTextContent("FN-8798");
        expect(screen.queryByTestId("task-detail-status-badge")).not.toBeInTheDocument();
      });
    } finally {
      viewportSpy.mockRestore();
      restoreDesktopViewport();
    }
  });

  describe("ModelOnboardingModal wiring", () => {
    beforeEach(() => {
      mockModelOnboardingModalProps.mockClear();
      mockSetupWizardModalProps.mockClear();
    });

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
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
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

    it("hides model onboarding while setup wizard is open as its project sub-flow", async () => {
      const manager = { ...mockModalManager, modelOnboardingOpen: true, setupWizardOpen: true };

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
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      await waitFor(() => {
        expect(mockSetupWizardModalProps).toHaveBeenCalledTimes(1);
      });
      expect(mockModelOnboardingModalProps).not.toHaveBeenCalled();
      expect(mockSetupWizardModalProps.mock.calls[0][0].includeAgentStep).toBe(false);
    });

    it("keeps the standalone setup wizard agent step for new projects", async () => {
      const manager = { ...mockModalManager, setupWizardOpen: true };

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
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      await waitFor(() => {
        expect(mockSetupWizardModalProps).toHaveBeenCalledTimes(1);
      });
      expect(mockSetupWizardModalProps.mock.calls[0][0].includeAgentStep).toBe(true);
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
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
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
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
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
      taskHandlers: { handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() },
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
      taskHandlers: { handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleGitHubImport: vi.fn() },
      taskOperations: { moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() },
      deepLink: { handleDetailClose: vi.fn() },
      settings: mockSettings,
    };

    it("pushes history for activity-log open and closes with deep-link cleanup on popstate", async () => {
      const pushStateSpy = vi.spyOn(window.history, "pushState");
      const closeDetailTask = vi.fn();
      const handleDetailClose = vi.fn();
      render(
        <AppModals
          {...commonProps}
          deepLink={{ handleDetailClose }}
          modalManager={{ ...mockModalManager, activityLogOpen: true, closeDetailTask }}
        />,
      );

      fireEvent.click(screen.getByTestId("activity-log-open-task"));
      expect(pushStateSpy).toHaveBeenCalled();

      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
      await waitFor(() => expect(closeDetailTask).toHaveBeenCalledTimes(1));
      expect(handleDetailClose).toHaveBeenCalledTimes(1);
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

      act(() => {
        mockTaskDetailModalProps.mock.calls.at(-1)?.[0]?.onOpenDetail({ id: "FN-2", title: "Nested" });
      });
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
      /*
      FNXC:TaskDetailNav 2026-07-07-09:15:
      FN-7352 (route completed-task refine menus to detail) added a third `opts?: { origin?: DetailTaskOrigin }` argument to openDetailTask / openDetailTaskWithNav, so the modalManager call now carries three args (task, tab, opts). A task-to-task open with no explicit tab/origin passes (task, undefined, undefined).
      */
      expect(mockModalManager.openDetailTask).toHaveBeenCalledWith({ id: "FN-2", title: "Nested" }, undefined, undefined);
    });
  });
});

describe("AppModals does not own the terminal", () => {
  it("never renders TerminalModal (its mount lifecycle is App's, and is asserted there)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(resolve(fileURLToPath(import.meta.url), "../../AppModals.tsx"), "utf8");
    expect(
      source.includes("TerminalModal"),
      "TerminalModal moved into AppModals. Its mount/unmount invariant (a mounted-but-closed terminal holds a PTY WebSocket and a 45s heartbeat) is currently asserted against App.tsx in App.test.tsx, and the `() => null` mock in this file would hide it here. Move the lifecycle recorder over before landing this.",
    ).toBe(false);
  });
});
