/**
 * Focused regression coverage for mobile task-detail swipe-back behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Settings, Task } from "@fusion/core";
import type { ProjectInfo } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

const DEFAULT_PROJECT_ID = "proj-1";

const defaultSettings: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: true,
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
  experimentalFeatures: { insights: true, roadmap: true, skillsView: true, agentsView: true, evalsView: true, todoView: true, leftSidebarNav: false, rightDock: false },
};

const mockSubscribeSse = vi.fn((..._args: any[]) => vi.fn());
vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: any[]) => mockSubscribeSse(...args),
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks: vi.fn(() => Promise.resolve([])),
    fetchConfig: vi.fn(() => Promise.resolve({ maxConcurrent: 2, rootDir: "/workspace/project" })),
    fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
    updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
    fetchGlobalSettings: vi.fn(() => Promise.resolve({})),
    fetchAuthStatus: vi.fn(() => Promise.resolve({ providers: [] })),
    fetchModels: vi.fn(() => Promise.resolve({ models: [], favoriteProviders: [], favoriteModels: [] })),
    fetchGitRemotes: vi.fn(() => Promise.resolve([])),
    fetchAgents: vi.fn(() => Promise.resolve([])),
    fetchTaskDetail: vi.fn((id: string) => Promise.resolve({ id, title: `Task ${id}` })),
    fetchUnreadCount: vi.fn(() => Promise.resolve({ unreadCount: 0 })),
    fetchPluginDashboardViews: vi.fn(() => Promise.resolve([])),
    fetchExecutorStats: vi.fn(() => Promise.resolve({
      globalPause: false,
      enginePaused: false,
      maxConcurrent: 2,
      lastActivityAt: new Date().toISOString(),
    })),
    fetchScripts: vi.fn(() => Promise.resolve({})),
    runScript: vi.fn(() => Promise.resolve({ sessionId: "sess-1", command: "echo" })),
    killPtyTerminalSession: vi.fn(() => Promise.resolve({ killed: true })),
  });
});

const mockCreateTask = vi.fn();
const mockUseTasks = vi.fn(() => ({
  tasks: [],
  createTask: mockCreateTask,
  moveTask: vi.fn(),
  deleteTask: vi.fn(),
  mergeTask: vi.fn(),
  retryTask: vi.fn(),
  updateTask: vi.fn(),
  duplicateTask: vi.fn(),
  archiveTask: vi.fn(),
  unarchiveTask: vi.fn(),
  archiveAllDone: vi.fn(),
  refreshTasks: vi.fn(),
}));
vi.mock("../../hooks/useTasks", () => ({
  useTasks: (_options?: any) => mockUseTasks(),
}));

vi.mock("../../hooks/useInsights", () => ({
  useInsights: () => ({
    sections: [], loading: false, error: null, latestRun: null,
    isRunInFlight: false, runError: null, refresh: vi.fn(),
    runInsights: vi.fn(), dismiss: vi.fn(), createTask: vi.fn(),
    dismissStates: new Map(), createTaskStates: new Map(),
    totalCount: 0, dismissedCount: 0,
  }),
}));

vi.mock("../../hooks/useRemoteNodeData", () => ({
  useRemoteNodeData: vi.fn(() => ({
    projects: [], tasks: [], health: null, loading: false,
    error: null, refresh: vi.fn(),
  })),
}));

vi.mock("../../hooks/useRemoteNodeEvents", () => ({
  useRemoteNodeEvents: vi.fn(() => ({ isConnected: false, lastEvent: null })),
}));

vi.mock("../../hooks/useBackgroundSessions", () => ({
  useBackgroundSessions: vi.fn(() => ({
    sessions: [], generating: false, needsInput: false,
    planningSessions: [], dismissSession: vi.fn(),
  })),
}));

const mockNodeContextValue = {
  currentNode: null, currentNodeId: null, isRemote: false,
  setCurrentNode: vi.fn(), clearCurrentNode: vi.fn(),
};
vi.mock("../../context/NodeContext", () => ({
  NodeProvider: ({ children }: { children: React.ReactNode }) => children,
  useNodeContext: vi.fn(() => mockNodeContextValue),
}));

vi.mock("../../components/model-onboarding-state", () => ({
  isOnboardingResumable: () => false,
  getOnboardingResumeStep: () => null,
  getOnboardingState: () => null,
  saveOnboardingState: vi.fn(),
  clearOnboardingState: vi.fn(),
  isOnboardingCompleted: () => false,
  markOnboardingCompleted: vi.fn(),
  markStepSkipped: vi.fn(),
  getOnboardingCompletedAt: () => null,
  getSkippedSteps: () => [],
  getStepData: () => null,
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "agent", "first-task"],
}));

vi.mock("../../components/Board", () => ({
  Board: ({ tasks, onOpenDetail }: { tasks: Task[]; onOpenDetail: (task: Task) => void }) => (
    <div data-testid="board-view">
      {tasks.map((task) => (
        <button key={task.id} type="button" data-testid={`open-task-${task.id}`} onClick={() => onOpenDetail(task)}>
          {task.title}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../../components/ListView", () => ({
  ListView: ({ tasks, onOpenDetail }: { tasks: Task[]; onOpenDetail: (task: Task, options?: { origin?: "list-mobile" }) => void }) => (
    <div data-testid="list-view">
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          data-testid={`list-open-${task.id}`}
          onClick={() => {
            if (mockUseViewportMode() === "mobile") {
              onOpenDetail(task, { origin: "list-mobile" });
            }
          }}
        >
          {task.title}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../../components/TaskDetailModal", () => ({
  TaskDetailModal: ({
    task,
    onClose,
    onOpenDetail,
    mobileHeaderMode,
  }: {
    task: { id: string; title?: string };
    onClose: () => void;
    onOpenDetail: (task: { id: string; title: string }) => void;
    mobileHeaderMode?: "back" | "close";
  }) => (
    <div className="modal-overlay open" data-testid="task-detail-modal">
      <div role="dialog" aria-label={task.title ?? task.id}>
        <div data-testid="task-detail-mobile-header-mode">{mobileHeaderMode ?? "close"}</div>
        <button type="button" data-testid="task-detail-close" onClick={onClose}>Close</button>
        {task.id === "FN-1" ? (
          <button type="button" data-testid="task-detail-open-nested" onClick={() => onOpenDetail({ id: "FN-2", title: "Nested Task" })}>
            Open nested
          </button>
        ) : null}
        <h2>{task.title ?? task.id}</h2>
      </div>
    </div>
  ),
  TaskDetailContent: ({
    task,
    onBackToBoard,
  }: {
    task: { id: string; title?: string };
    onBackToBoard?: () => void;
  }) => (
    <div data-testid="task-detail-main-panel-content">
      {onBackToBoard ? <button type="button" data-testid="task-detail-back-to-board" onClick={onBackToBoard}>Back to board</button> : null}
      <h2>{task.title ?? task.id}</h2>
    </div>
  ),
}));

vi.mock("../../components/SettingsModal", () => ({
  SettingsModal: ({ onClose }: { onClose: () => void }) => (
    <div className="modal-overlay open" data-testid="settings-modal">
      <button type="button" data-testid="settings-close-btn" onClick={onClose}>Close</button>
    </div>
  ),
  SettingsView: () => <div data-testid="settings-view">Settings</div>,
}));

vi.mock("../../components/GitHubImportModal", () => ({ GitHubImportModal: () => null }));
vi.mock("../../components/PlanningModeModal", () => ({ PlanningModeModal: () => null }));
vi.mock("../../components/AgentsView", () => ({ AgentsView: () => <div data-testid="agents-view">Agents</div> }));
vi.mock("../../components/ResearchView", () => ({ ResearchView: () => <div data-testid="research-view">Research</div> }));
vi.mock("../../components/EvalsView", () => ({ EvalsView: () => <div data-testid="evals-view">Evals</div> }));
vi.mock("../../components/TodoView", () => ({ TodoView: () => <div data-testid="todo-view">Todo</div> }));
vi.mock("../../components/QuickChatFAB", () => ({ QuickChatFAB: () => null }));
vi.mock("../../components/ScriptsModal", () => ({ ScriptsModal: () => null }));
vi.mock("../../components/TerminalModal", () => ({ TerminalModal: () => null }));
vi.mock("../../components/FileBrowser", () => ({ FileBrowserModal: () => null }));
vi.mock("../../components/ActivityLogModal", () => ({ ActivityLogModal: () => null }));
vi.mock("../../components/GitManagerModal", () => ({ GitManagerModal: () => null }));
vi.mock("../../components/SchedulesModal", () => ({ SchedulesModal: () => null }));
vi.mock("../../components/WorkflowEditorModal", () => ({ WorkflowEditorModal: () => null }));
vi.mock("../../components/AgentsModal", () => ({ AgentsModal: () => null }));
vi.mock("../../components/SubtaskBreakdownModal", () => ({ SubtaskBreakdownModal: () => null }));
vi.mock("../../components/UsageModal", () => ({ UsageModal: () => null }));
vi.mock("../../components/ModelOnboardingModal", () => ({ ModelOnboardingModal: () => null }));
vi.mock("../../components/SetupWizardModal", () => ({ SetupWizardModal: () => null }));
vi.mock("../../components/GroupTaskModal", () => ({ GroupTaskModal: () => null }));
vi.mock("../../components/ProjectSelector", () => ({ ProjectSelector: () => <div /> }));
vi.mock("../../components/ProjectCard", () => ({ ProjectCard: () => <div /> }));
vi.mock("../../components/Sidebar", () => ({ Sidebar: () => <div /> }));
vi.mock("../../components/Header", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/Header")>();
  return {
    ...actual,
    Header: () => <div><button title="Settings" type="button">Settings</button></div>,
  };
});
vi.mock("../../components/MobileNavBar", () => ({ MobileNavBar: () => null }));
vi.mock("../../components/RightDock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/RightDock")>();
  return {
    ...actual,
    RightDock: () => null,
    RightDockExpandModal: () => null,
  };
});

const mockUseProjects = vi.fn(() => ({ projects: [], loading: false, error: null }));
const mockCurrentProjectState = {
  currentProject: {
    id: DEFAULT_PROJECT_ID,
    name: "Test Project",
    path: "/test",
    status: "active",
    isolationMode: "in-process",
    createdAt: "",
    updatedAt: "",
  } as ProjectInfo,
  loading: false,
  setCurrentProject: vi.fn(),
  clearCurrentProject: vi.fn(),
};
vi.mock("../../hooks/useProjects", () => ({ useProjects: () => mockUseProjects() }));
vi.mock("../../hooks/useCurrentProject", () => ({
  useCurrentProject: () => mockCurrentProjectState,
}));
vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [], loading: false, error: null,
    refresh: vi.fn(), register: vi.fn(), update: vi.fn(), unregister: vi.fn(), healthCheck: vi.fn(),
  })),
}));

const mockUseViewportMode = vi.fn(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
  useViewportMode: (..._args: unknown[]) => mockUseViewportMode(..._args),
}));

const mockUseMobileKeyboard = vi.fn(() => ({
  keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (..._args: unknown[]) => mockUseMobileKeyboard(..._args),
}));

import { App } from "../../App";

function makeTask(id: string, title: string): Task {
  return {
    id,
    title,
    description: "Test task description",
    column: "todo",
    status: "todo",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as Task;
}

function dispatchPopState(state: Record<string, unknown> | null) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}

async function renderAppAndWait(expectedTestId: string = "board-view") {
  const result = render(<App />);
  await waitFor(() => {
    expect(screen.getByTestId(expectedTestId)).toBeTruthy();
  });
  return result;
}

describe("Task detail mobile swipe-back", () => {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeSse.mockReset();
    mockSubscribeSse.mockReturnValue(vi.fn());
    mockUseTasks.mockReset();
    mockUseTasks.mockImplementation(() => ({
      tasks: [],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false,
    });
    localStorage.clear();
    window.history.pushState = vi.fn();
    window.history.replaceState = vi.fn();
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  });

  it("dismisses the board main-panel task detail on mobile popstate", async () => {
    const task = makeTask("FN-1", "Board Detail");
    mockUseTasks.mockImplementation(() => ({
      tasks: [task],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));

    await renderAppAndWait("board-view");
    fireEvent.click(screen.getByTestId("open-task-FN-1"));

    await waitFor(() => {
      expect(screen.getByTestId("task-detail-main-panel-content")).toBeInTheDocument();
    });

    dispatchPopState({ navIndex: 0 });

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-main-panel-content")).toBeNull();
      expect(screen.getByTestId("board-view")).toBeInTheDocument();
    });
  });

  it("dismisses the list-mobile task detail on mobile popstate", async () => {
    const task = makeTask("FN-1", "Mobile List Detail");
    mockUseTasks.mockImplementation(() => ({
      tasks: [task],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID), "list");

    await renderAppAndWait("list-view");
    fireEvent.click(screen.getByTestId("list-open-FN-1"));

    await waitFor(() => {
      expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
      expect(screen.getByTestId("task-detail-mobile-header-mode")).toHaveTextContent("back");
    });

    dispatchPopState({ navIndex: 0 });

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
      expect(screen.getByTestId("list-view")).toBeInTheDocument();
    });
  });

  it("pushes a fresh mobile nav entry after close and reopen from the list", async () => {
    const task = makeTask("FN-1", "Repeat Mobile List Detail");
    mockUseTasks.mockImplementation(() => ({
      tasks: [task],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID), "list");

    await renderAppAndWait("list-view");
    fireEvent.click(screen.getByTestId("list-open-FN-1"));

    await waitFor(() => {
      expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
    });
    expect(window.history.pushState).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("task-detail-close"));
    dispatchPopState({ navIndex: 0 });
    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("list-open-FN-1"));
    await waitFor(() => {
      expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
    });

    expect(window.history.pushState).toHaveBeenCalledTimes(2);

    dispatchPopState({ navIndex: 0 });
    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
      expect(screen.getByTestId("list-view")).toBeInTheDocument();
    });
  });

  it("restores the previous modal detail when mobile popstate closes a nested task detail", async () => {
    const task = makeTask("FN-1", "Parent Task");
    mockUseTasks.mockImplementation(() => ({
      tasks: [task, makeTask("FN-2", "Nested Task")],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID), "list");

    await renderAppAndWait("list-view");
    fireEvent.click(screen.getByTestId("list-open-FN-1"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Parent Task" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("task-detail-open-nested"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Nested Task" })).toBeInTheDocument();
    });
    expect(window.history.pushState).toHaveBeenCalledTimes(2);

    dispatchPopState({ navIndex: 1 });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Parent Task" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog", { name: "Nested Task" })).toBeNull();
  });

  it("pops multiple mobile detail entries back to the list target on a rapid Android-style pop", async () => {
    const task = makeTask("FN-1", "Parent Task");
    mockUseTasks.mockImplementation(() => ({
      tasks: [task, makeTask("FN-2", "Nested Task")],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID), "list");

    await renderAppAndWait("list-view");
    fireEvent.click(screen.getByTestId("list-open-FN-1"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Parent Task" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("task-detail-open-nested"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Nested Task" })).toBeInTheDocument();
    });

    dispatchPopState({ navIndex: 0 });

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
      expect(screen.getByTestId("list-view")).toBeInTheDocument();
    });
  });

  it("does not push mobile detail history entries on desktop list selection", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    const task = makeTask("FN-1", "Desktop List Detail");
    mockUseTasks.mockImplementation(() => ({
      tasks: [task],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      refreshTasks: vi.fn(),
    }));
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID), "list");

    await renderAppAndWait("list-view");
    fireEvent.click(screen.getByTestId("list-open-FN-1"));

    expect(window.history.pushState).not.toHaveBeenCalled();
    expect(screen.queryByTestId("task-detail-modal")).toBeNull();
  });
});
