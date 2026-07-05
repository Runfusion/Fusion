/**
 * FN-7587 companion suite: board main-panel (MainContent.tsx) mobile predictive-back
 * transition class gating.
 *
 * FNXC:TaskDetailSwipeBack 2026-07-05-12:45:
 * Split out from `TaskDetail.mobile-transition.test.tsx` because this surface needs the
 * full App-level mock harness (mirrors `TaskDetail.swipe-back.test.tsx`'s harness: Board/
 * ListView/TaskDetailModal module mocks, real lucide-react icons via Header) which conflicts
 * with the TaskDetailModal-focused `test-helpers` harness's fixed lucide-react icon allowlist
 * if both are combined in one test module (vi.mock hoisting collides).
 *
 * Asserts only the class-gating invariant: `.task-detail-main-panel--mobile-transition` is
 * present on mobile and absent on desktop. Does not re-derive dismissal-routing coverage,
 * which stays the responsibility of `TaskDetail.swipe-back.test.tsx` /
 * `navigation-history.test.tsx` (run unmodified per PROMPT.md).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Settings, Task } from "@fusion/core";
import type { ProjectInfo } from "../../api";

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
  ListView: () => <div data-testid="list-view" />,
}));

vi.mock("../../components/TaskDetailModal", () => ({
  TaskDetailModal: () => null,
  TaskDetailContent: ({ task }: { task: { id: string; title?: string } }) => (
    <div data-testid="task-detail-main-panel-content">
      <h2>{task.title ?? task.id}</h2>
    </div>
  ),
}));

vi.mock("../../components/SettingsModal", () => ({
  SettingsModal: () => null,
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
    id: "proj-1",
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

function makeBoardTask(id: string, title: string): Task {
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

async function renderAppAndWait(expectedTestId: string = "board-view") {
  const result = render(<App />);
  await waitFor(() => {
    expect(screen.getByTestId(expectedTestId)).toBeTruthy();
  });
  return result;
}

describe("Board main-panel task-detail — mobile transition class gating (MainContent.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeSse.mockReset();
    mockSubscribeSse.mockReturnValue(vi.fn());
    mockUseTasks.mockReset();
  });

  it("applies the mobile transition class to the board main-panel surface when the viewport is mobile", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const task = makeBoardTask("FN-1", "Board Detail");
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
    expect(document.querySelector(".task-detail-main-panel--mobile-transition")).toBeInTheDocument();
  });

  it("does NOT apply the mobile transition class to the board main-panel surface on desktop", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    const task = makeBoardTask("FN-1", "Board Detail");
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
    expect(document.querySelector(".task-detail-main-panel")).toBeInTheDocument();
    expect(document.querySelector(".task-detail-main-panel--mobile-transition")).not.toBeInTheDocument();
  });
});
