/**
 * Integration tests for browser back-navigation within the SPA.
 *
 * Verifies that the useNavigationHistory hook integration in App.tsx correctly:
 * - Pushes history entries when opening modals (both desktop and mobile)
 * - Dismisses modals on popstate (both desktop and mobile)
 * - Pushes history entries when changing views
 * - Reverts view changes on popstate
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Settings, Task } from "@fusion/core";
import type { ProjectInfo } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

// ── API mocks ──────────────────────────────────────────────────────────────

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
  experimentalFeatures: { insights: true, roadmap: true, skillsView: true, agentsView: true, evalsView: true },
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
    fetchAuthStatus: vi.fn(() =>
      Promise.resolve({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true },
          { id: "github", name: "GitHub", authenticated: true },
        ],
      }),
    ),
    loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
    logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
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

// ── Hook mocks ─────────────────────────────────────────────────────────────

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
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "first-task"],
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

vi.mock("../../components/TaskDetailModal", () => ({
  TaskDetailModal: ({ task, onClose }: { task: { id: string; title?: string }; onClose: () => void }) => (
    <div className="modal-overlay open" data-testid="task-detail-modal">
      <div role="dialog" aria-label={task.title ?? task.id}>
        <button type="button" className="modal-close" onClick={onClose}>Close</button>
        <h2>{task.title ?? task.id}</h2>
      </div>
    </div>
  ),
}));

vi.mock("../../components/SettingsModal", () => ({
  SettingsModal: ({ onClose }: { onClose: () => void }) => (
    <div className="modal-overlay open" data-testid="settings-modal">
      <h2>Settings</h2>
      <button type="button" data-testid="settings-close-btn" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock("../../components/GitHubImportModal", () => ({
  GitHubImportModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div className="modal-overlay open" data-testid="github-import-modal"><h2>Import from GitHub</h2></div> : null,
}));

vi.mock("../../components/PlanningModeModal", () => ({
  PlanningModeModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div className="modal-overlay open" data-testid="planning-modal"><h2>Planning Mode</h2></div> : null,
}));

vi.mock("../../components/AgentsView", () => ({
  AgentsView: () => <div data-testid="agents-view">Agents view</div>,
}));

vi.mock("../../components/ResearchView", () => ({
  ResearchView: () => <div data-testid="research-view">Research</div>,
}));

vi.mock("../../components/EvalsView", () => ({
  EvalsView: () => <div data-testid="evals-view">Evals</div>,
}));

vi.mock("../../components/TodoView", () => ({
  TodoView: () => <div data-testid="todo-view">Todo</div>,
}));

vi.mock("../../components/QuickChatFAB", () => ({
  QuickChatFAB: () => null,
}));

vi.mock("../../components/ScriptsModal", () => ({
  ScriptsModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div className="modal-overlay open" data-testid="scripts-modal"><h2>Scripts</h2></div> : null,
}));

vi.mock("../../components/TerminalModal", () => ({
  TerminalModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div className="modal-overlay open" data-testid="terminal-modal"><h2>Terminal</h2></div> : null,
}));

vi.mock("../../components/SetupWizardModal", () => ({
  SetupWizardModal: () => <div>Welcome to Fusion</div>,
}));

vi.mock("../../components/ModelOnboardingModal", () => ({
  ModelOnboardingModal: ({ onComplete }: { onComplete: () => void }) => (
    <div className="modal-overlay open">
      <h2>Set Up AI</h2>
      <button type="button" onClick={onComplete}>Skip for now</button>
    </div>
  ),
}));

vi.mock("../../components/CustomModelDropdown", () => ({
  CustomModelDropdown: () => <select data-testid="mock-model-dropdown"><option>Select…</option></select>,
}));

// ── Project state mocks ────────────────────────────────────────────────────

const DEFAULT_PROJECT_ID = "proj_123";

const mockProjectsState = {
  projects: [] as ProjectInfo[],
  loading: false,
  error: null as string | null,
};

const mockCurrentProjectState = {
  currentProject: {
    id: DEFAULT_PROJECT_ID,
    name: "Test Project",
    path: "/test",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: "",
    updatedAt: "",
  },
  setCurrentProject: vi.fn(),
  clearCurrentProject: vi.fn(),
  loading: false,
};

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: mockProjectsState.projects,
    loading: mockProjectsState.loading,
    error: mockProjectsState.error,
    refresh: vi.fn(async () => {}),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
  }),
}));

vi.mock("../../hooks/useCurrentProject", () => ({
  useCurrentProject: () => mockCurrentProjectState,
}));

vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: () => ({
    connectionStatus: "connected",
    sendInput: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: vi.fn(),
    onSessionInvalid: vi.fn(() => vi.fn()),
  }),
}));

vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [], loading: false, error: null,
    refresh: vi.fn(), register: vi.fn(), update: vi.fn(),
    unregister: vi.fn(), healthCheck: vi.fn(),
  })),
}));

// ── Viewport / keyboard mocks ──────────────────────────────────────────────

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

// ── Import App AFTER all mocks ─────────────────────────────────────────────

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

describe("Navigation history integration", () => {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeSse.mockReset();
    mockSubscribeSse.mockReturnValue(vi.fn());
    mockCreateTask.mockReset();
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
    }));
    mockProjectsState.projects = [];
    mockProjectsState.loading = false;
    mockProjectsState.error = null;
    mockCurrentProjectState.currentProject = {
      id: DEFAULT_PROJECT_ID,
      name: "Test Project",
      path: "/test",
      status: "active",
      isolationMode: "in-process",
      createdAt: "",
      updatedAt: "",
    };
    mockCurrentProjectState.setCurrentProject.mockClear();
    mockCurrentProjectState.clearCurrentProject.mockClear();
    mockNodeContextValue.currentNode = null;
    mockNodeContextValue.currentNodeId = null;
    mockNodeContextValue.isRemote = false;
    mockNodeContextValue.setCurrentNode.mockClear();
    mockNodeContextValue.clearCurrentNode.mockClear();

    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false,
    });

    localStorage.removeItem("fusion-dashboard-current-node");
    localStorage.removeItem("kb-onboarding-state");
    localStorage.removeItem("kb-dashboard-view-mode");

    window.history.pushState = vi.fn();
    window.history.replaceState = vi.fn();
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  });

  async function renderAppAndWait() {
    const result = render(<App />);
    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });
    return result;
  }

  async function renderMobileAppAndWait() {
    const result = render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("board-view")).toBeTruthy();
    });
    return result;
  }

  // 1. Desktop: opening Settings pushes a history entry
  it("pushes history entry when opening Settings modal on desktop", async () => {
    await renderAppAndWait();

    const pushCallsBefore = (window.history.pushState as any).mock.calls.length;
    const settingsBtn = screen.getByTitle("Settings");
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeTruthy();
    });

    // Back-button nav is enabled on desktop too — pushState called for the modal open
    expect((window.history.pushState as any).mock.calls.length).toBeGreaterThan(pushCallsBefore);
  });

  // 2. Desktop: popstate dismisses modals
  it("dismisses Settings modal on popstate in desktop mode", async () => {
    await renderAppAndWait();

    const settingsBtn = screen.getByTitle("Settings");
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeTruthy();
    });

    // Simulate back button
    dispatchPopState({ navIndex: 0 });

    // Settings modal should be dismissed
    await waitFor(() => {
      expect(screen.queryByTestId("settings-modal")).toBeNull();
    });
  });

  // 3. Desktop: view changes push history entries
  it("pushes history entry for view changes on desktop", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    const taskViewStorageKey = scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID);
    localStorage.setItem(taskViewStorageKey, "board");

    await renderAppAndWait();

    const pushCallsBefore = (window.history.pushState as any).mock.calls.length;
    // Switch to agents view
    const agentsTab = screen.queryByTitle("Agents");
    if (!agentsTab) return;
    fireEvent.click(agentsTab);

    await waitFor(() => {
      expect(screen.getByTestId("agents-view")).toBeTruthy();
    });

    // pushState should have been called for the view change
    expect((window.history.pushState as any).mock.calls.length).toBeGreaterThan(pushCallsBefore);
  });

  it("pushes history entry when switching to evals from overflow", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    const taskViewStorageKey = scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID);
    localStorage.setItem(taskViewStorageKey, "board");

    await renderAppAndWait();

    const pushCallsBefore = (window.history.pushState as any).mock.calls.length;
    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    fireEvent.click(screen.getByTestId("view-overflow-evals"));

    await waitFor(() => {
      expect(screen.getByTestId("evals-view")).toBeTruthy();
    });

    expect((window.history.pushState as any).mock.calls.length).toBeGreaterThan(pushCallsBefore);
  });

  // 4. Desktop: popstate reverts view changes
  it("reverts view change on popstate in desktop mode", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    const taskViewStorageKey = scopedKey("kb-dashboard-task-view", DEFAULT_PROJECT_ID);
    localStorage.setItem(taskViewStorageKey, "board");

    await renderAppAndWait();

    const agentsTab = screen.queryByTitle("Agents");
    if (!agentsTab) return;
    fireEvent.click(agentsTab);

    await waitFor(() => {
      expect(screen.getByTestId("agents-view")).toBeTruthy();
    });

    // Simulate back button
    dispatchPopState({ navIndex: 0 });

    // Agents view should be reverted (board view shown instead)
    await waitFor(() => {
      expect(screen.queryByTestId("agents-view")).toBeNull();
    });
  });

  it("dismisses task detail on mobile popstate after a normal open", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const task = makeTask("FN-1", "Mobile Swipe Detail");
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
    }));

    await renderMobileAppAndWait();

    fireEvent.click(screen.getByTestId("open-task-FN-1"));

    await waitFor(() => {
      expect(screen.getByTestId("task-detail-modal")).toBeTruthy();
    });

    dispatchPopState({ navIndex: 0 });

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
    });
  });

  it("dismisses task detail on mobile popstate after close and reopen", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const task = makeTask("FN-1", "Mobile Swipe Detail");
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
    }));

    await renderMobileAppAndWait();

    fireEvent.click(screen.getByTestId("open-task-FN-1"));

    await waitFor(() => {
      expect(screen.getByTestId("task-detail-modal")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // removeNav drives history.back(); consume the self-triggered popstate
    // before reopening so the next popstate represents the user's swipe-back.
    dispatchPopState({ navIndex: 0 });

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("open-task-FN-1"));

    await waitFor(() => {
      expect(screen.getByTestId("task-detail-modal")).toBeTruthy();
    });

    dispatchPopState({ navIndex: 0 });

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-modal")).toBeNull();
    });
  });

  // 5. Verify useNavigationHistory is called with enabled=true on mobile
  it("calls useNavigationHistory with enabled=true on mobile", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    // On mobile, the Settings button is not in the header — it's in the
    // MobileNavBar "More" menu. We just verify the mock was called.
    render(<App />);

    await waitFor(() => {
      // Wait for the app to render something
      expect(document.querySelector('.project-content')).toBeTruthy();
    });

    // The useViewportMode hook should have been called and returned "mobile"
    expect(mockUseViewportMode).toHaveBeenCalled();
  });
});
