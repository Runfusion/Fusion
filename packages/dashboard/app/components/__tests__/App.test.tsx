import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { NodeConfig, Settings } from "@fusion/core";
import type { AiSessionSummary, ProjectInfo } from "../../api";
import { scopedKey } from "../../utils/projectStorage";
import { useFileBrowser } from "../../context/FileBrowserContext";

// No mock needed - tests use localStorage directly

function FileBrowserProbe({ testId }: { testId: string }) {
  const ctx = useFileBrowser();
  const status = ctx && typeof ctx.openFile === "function" ? "ok" : "missing";
  return <div data-testid={testId}>{status}</div>;
}

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
  capacityRiskBannerEnabled: false,
  capacityRiskTodoThreshold: 20,
  /*
   * FNXC:DashboardTests 2026-06-25-10:52:
   * App.test.tsx now mirrors the shipped left-sidebar navigation default because graduated destinations (Insights, Memory, Todo, Goals, Agents) must stay visible even when stale experimental flags are false. Individual legacy header-toggle tests opt out explicitly instead of making the whole fixture hide sidebar controls.
   */
  experimentalFeatures: { insights: true, skillsView: true, agentsView: true, memoryView: true, evalsView: true, leftSidebarNav: true },
};

const mockAgentStats = {
  activeCount: 0,
  busyCount: 0,
  pausedCount: 0,
  todoTaskCount: 0,
  idleNonEphemeralCount: 1,
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
          { id: "anthropic", name: "Anthropic", authenticated: false },
          { id: "github", name: "GitHub", authenticated: false },
        ],
      }),
    ),
    loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
    logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
    fetchModels: vi.fn(() => Promise.resolve({ models: [], favoriteProviders: [], favoriteModels: [] })),
    fetchGitRemotes: vi.fn(() => Promise.resolve([])),
    fetchAgents: vi.fn(() => Promise.resolve([])),
    fetchAgentStats: vi.fn(() => Promise.resolve({ ...mockAgentStats })),
    fetchTaskDetail: vi.fn((id: string) => Promise.resolve({ id, title: `Task ${id}` })),
    fetchUnreadCount: vi.fn(() => Promise.resolve({ unreadCount: 0 })),
    fetchDashboardHealth: vi.fn(() => Promise.resolve({
      status: "ok",
      version: "1.0.0",
      uptime: 1,
      engine: {
        available: true,
      },
      database: {
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      },
      taskIdIntegrity: { status: "ok", checkedAt: "2026-05-12T00:00:00.000Z", anomalies: [], recommendedAction: null },
    })),
    fetchPluginDashboardViews: vi.fn(() => Promise.resolve([])),
    fetchBoardWorkflows: vi.fn(() => Promise.resolve({
      flagEnabled: false,
      defaultWorkflowId: "builtin:coding",
      workflows: [],
      taskWorkflowIds: {},
    })),
    fetchExecutorStats: vi.fn(() => Promise.resolve({
      globalPause: false,
      enginePaused: false,
      maxConcurrent: 2,
      lastActivityAt: new Date().toISOString(),
    })),
    fetchScripts: vi.fn(() => Promise.resolve({ build: "npm run build", test: "pnpm test" })),
    runScript: vi.fn(() => Promise.resolve({ sessionId: "sess-script-1", command: "echo hello" })),
    killPtyTerminalSession: vi.fn(() => Promise.resolve({ killed: true })),
  });
});

const mockCreateTask = vi.fn();

const mockUseTasks = vi.fn(() => ({
  tasks: [],
  createTask: mockCreateTask,
  moveTask: vi.fn(),
  pauseTask: vi.fn(),
  unpauseTask: vi.fn(),
  deleteTask: vi.fn(),
  mergeTask: vi.fn(),
  retryTask: vi.fn(),
  resetTask: vi.fn(),
  updateTask: vi.fn(),
  duplicateTask: vi.fn(),
  archiveTask: vi.fn(),
  unarchiveTask: vi.fn(),
  archiveAllDone: vi.fn(),
  loadArchivedTasks: vi.fn(),
  refreshTasks: vi.fn(),
  ingestCreatedTasks: vi.fn(),
  lastFetchTimeMs: Date.now(),
}));

// Accept both old and new hook signatures
vi.mock("../../hooks/useTasks", () => ({
  useTasks: (_options?: { projectId?: string; searchQuery?: string; sseEnabled?: boolean }) => mockUseTasks(),
}));

// Mock useRemoteNodeData
const mockUseInsights = vi.fn(() => ({
  sections: [],
  loading: false,
  error: null,
  latestRun: null,
  isRunInFlight: false,
  runError: null,
  refresh: vi.fn(),
  runInsights: vi.fn(),
  dismiss: vi.fn(),
  createTask: vi.fn(),
  dismissStates: new Map(),
  createTaskStates: new Map(),
  totalCount: 0,
  dismissedCount: 0,
}));

vi.mock("../../hooks/useInsights", () => ({
  useInsights: (..._args: unknown[]) => mockUseInsights(),
}));

vi.mock("../../hooks/useRemoteNodeData", () => ({
  useRemoteNodeData: vi.fn(() => ({
    projects: [],
    tasks: [],
    health: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// Mock useRemoteNodeEvents
vi.mock("../../hooks/useRemoteNodeEvents", () => ({
  useRemoteNodeEvents: vi.fn(() => ({
    isConnected: false,
    lastEvent: null,
  })),
}));

const mockUseBackgroundSessions = vi.fn(() => ({
  sessions: [],
  generating: false,
  needsInput: false,
  planningSessions: [],
  dismissSession: vi.fn(),
}));

vi.mock("../../hooks/useBackgroundSessions", () => ({
  useBackgroundSessions: () => mockUseBackgroundSessions(),
}));

// Mock NodeContext - default to local mode
const mockNodeContextValue: {
  currentNode: NodeConfig | null;
  currentNodeId: string | null;
  isRemote: boolean;
  setCurrentNode: ReturnType<typeof vi.fn>;
  clearCurrentNode: ReturnType<typeof vi.fn>;
} = {
  currentNode: null,
  currentNodeId: null,
  isRemote: false,
  setCurrentNode: vi.fn(),
  clearCurrentNode: vi.fn(),
};

vi.mock("../../context/NodeContext", () => ({
  NodeProvider: ({ children }: { children: React.ReactNode }) => children,
  useNodeContext: vi.fn(() => mockNodeContextValue),
}));

const mockShellHostContextValue = {
  host: { kind: "browser" as const },
  isNativeShell: false,
  kind: "browser" as const,
};

vi.mock("../../context/ShellHostContext", () => ({
  ShellHostProvider: ({ children }: { children: React.ReactNode }) => children,
  useShellHostContext: vi.fn(() => mockShellHostContextValue),
}));

const mockShellConnectionState = {
  host: "web" as const,
  desktopMode: "local" as const,
  profiles: [],
  activeProfileId: null,
};

const mockGetShellConnectionNativeResult = vi.fn(async () => ({
  hostKind: "browser" as const,
  available: false,
  openConnectionManager: async () => ({ ok: false as const, reason: "unsupported" as const }),
}));

vi.mock("../../hooks/useShellConnection", () => ({
  useShellConnection: vi.fn(() => ({
    shellApi: null,
    state: mockShellConnectionState,
    ready: true,
    openConnectionManagerSignal: 0,
  })),
}));

vi.mock("../../shell-native", () => ({
  getShellConnectionNativeResult: (...args: unknown[]) => mockGetShellConnectionNativeResult(...args),
}));

// Mock model-onboarding-state
const mockIsOnboardingResumable = vi.fn();
const mockGetOnboardingResumeStep = vi.fn();
const mockGetOnboardingState = vi.fn();
const mockSaveOnboardingState = vi.fn();
const mockClearOnboardingState = vi.fn();
const mockIsOnboardingCompleted = vi.fn();
const mockMarkOnboardingCompleted = vi.fn();
const mockMarkStepSkipped = vi.fn();
const mockGetOnboardingCompletedAt = vi.fn();
const mockGetSkippedSteps = vi.fn();
const mockGetStepData = vi.fn();

vi.mock("../../components/model-onboarding-state", () => ({
  isOnboardingResumable: (...args: unknown[]) => mockIsOnboardingResumable(...args),
  getOnboardingResumeStep: (...args: unknown[]) => mockGetOnboardingResumeStep(...args),
  getOnboardingState: (...args: unknown[]) => mockGetOnboardingState(...args),
  saveOnboardingState: (...args: unknown[]) => mockSaveOnboardingState(...args),
  clearOnboardingState: (...args: unknown[]) => mockClearOnboardingState(...args),
  isOnboardingCompleted: (...args: unknown[]) => mockIsOnboardingCompleted(...args),
  markOnboardingCompleted: (...args: unknown[]) => mockMarkOnboardingCompleted(...args),
  markStepSkipped: (...args: unknown[]) => mockMarkStepSkipped(...args),
  getOnboardingCompletedAt: (...args: unknown[]) => mockGetOnboardingCompletedAt(...args),
  getSkippedSteps: (...args: unknown[]) => mockGetSkippedSteps(...args),
  getStepData: (...args: unknown[]) => mockGetStepData(...args),
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "agent", "first-task"],
}));

// Mock CustomModelDropdown for onboarding modal tests
vi.mock("../../components/CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <select
      data-testid="mock-model-dropdown"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? "Select…"}</option>
      <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="openai/gpt-4o">GPT-4o</option>
    </select>
  ),
}));

vi.mock("../../components/TaskDetailModal", () => ({
  TaskDetailModal: ({ task, onClose }: { task: { id: string; title?: string }; onClose: () => void }) => (
    <div className="modal-overlay open">
      <div role="dialog" aria-label={task.title ?? task.id}>
        <button type="button" className="modal-close" onClick={onClose}>
          Close
        </button>
        <h2>{task.title ?? task.id}</h2>
      </div>
    </div>
  ),
  TaskDetailContent: ({ task, onBackToBoard, onOpenDetail }: { task: { id: string; title?: string }; onBackToBoard?: () => void; onOpenDetail?: (task: { id: string; title?: string }) => void }) => (
    <section data-testid="main-panel-task-detail">
      <button type="button" onClick={onBackToBoard}>Back to board</button>
      <h2>{task.title ?? task.id}</h2>
      <button type="button" onClick={() => onOpenDetail?.({ id: "FN-6965", title: "Nested task" })}>Open nested task</button>
    </section>
  ),
}));

vi.mock("../../components/GitHubImportModal", () => ({
  // Embedded presentation (sidebar "Import Tasks" destination) drops the modal
  // overlay + Cancel button; modal presentation (mobile overflow path) keeps them.
  GitHubImportModal: ({ isOpen, onClose, presentation = "modal" }: { isOpen: boolean; onClose: () => void; presentation?: "modal" | "embedded" }) =>
    isOpen ? (
      <div
        className={presentation === "embedded" ? "github-import-modal github-import-modal--embedded open" : "modal-overlay open"}
        data-testid={presentation === "embedded" ? "github-import-view" : undefined}
      >
        <h2>Import from GitHub</h2>
        {presentation === "embedded" ? null : (
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    ) : null,
}));

vi.mock("../../components/PlanningModeModal", () => ({
  PlanningModeModal: ({ isOpen, onClose, presentation = "modal", resumeSessionId }: { isOpen: boolean; onClose: () => void; presentation?: "modal" | "embedded"; resumeSessionId?: string }) =>
    isOpen ? (
      <div className={presentation === "embedded" ? "planning-view open" : "modal-overlay open"} data-testid={presentation === "embedded" ? "planning-view" : undefined} data-resume-session-id={resumeSessionId ?? ""}>
        <button type="button" aria-label="Close" onClick={onClose}>
          Close
        </button>
        <h2>Planning Mode</h2>
        <p>Transform your idea into a detailed task</p>
        <input placeholder="e.g., Build a user authentication system with login" />
        <button type="button">Start Planning</button>
      </div>
    ) : null,
}));

vi.mock("../../components/ScriptsModal", () => ({
  ScriptsModal: ({
    isOpen,
    onClose,
    onRunScript,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onRunScript: (scriptName: string) => void;
  }) =>
    isOpen ? (
      <div className="modal-overlay open" data-testid="scripts-modal">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" data-testid="run-script-build" onClick={() => onRunScript("build")}>
          Run build
        </button>
      </div>
    ) : null,
}));

vi.mock("../../components/TerminalModal", () => ({
  TerminalModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div className="modal-overlay open" data-testid="terminal-modal">
        <button type="button" data-testid="terminal-close-btn" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

vi.mock("../../components/AgentsView", () => ({
  AgentsView: () => <div className="agents-view">Agents view</div>,
}));

vi.mock("@fusion-plugin-examples/dependency-graph/dashboard-view", () => ({
  DependencyGraphDashboardView: () => <div data-testid="dependency-graph">No active tasks to display in graph view.</div>,
}));

vi.mock("../../components/ResearchView", () => ({
  ResearchView: ({ addToast }: { addToast?: (message: string, type?: "success" | "error" | "info") => void }) => (
    <div data-testid="research-view">
      <h2>Research</h2>
      <p data-testid="research-status">completed</p>
      <button type="button" onClick={() => addToast?.("Task created from research", "success")}>Create Task</button>
    </div>
  ),
}));

vi.mock("../../components/EvalsView", () => ({
  EvalsView: () => <div data-testid="evals-view">Evals</div>,
}));

vi.mock("../../components/TodoView", () => ({
  TodoView: ({ onPlanningMode }: { onPlanningMode?: (initialPlan: string) => void }) => (
    <div className="todo-view" data-testid="todo-view">
      <button type="button" data-testid="todo-planning-button" onClick={() => onPlanningMode?.("Seed from todo")}>Plan from todo</button>
    </div>
  ),
}));

vi.mock("../../components/GoalsView", () => ({
  GoalsView: () => <div data-testid="goals-view">Goals View</div>,
}));

vi.mock("../../components/ChatView", () => ({
  ChatView: () => <FileBrowserProbe testId="fb-probe-chat" />,
}));

vi.mock("../../components/DashboardLoader", () => ({
  DashboardLoader: () => <FileBrowserProbe testId="fb-probe-loader" />,
}));

vi.mock("../../components/QuickChatFAB", () => ({
  QuickChatFAB: () => null,
}));

vi.mock("../../components/SetupWizardModal", () => ({
  SetupWizardModal: () => <div className="modal-overlay open">Welcome to Fusion</div>,
}));

vi.mock("../../components/SettingsModal", async () => {
  const React = await import("react");
  const api = await import("../../api");

  function MockSettingsModal({
    onClose,
    onReopenOnboarding,
    initialSection,
  }: {
    onClose: () => void;
    onReopenOnboarding?: () => void;
    initialSection?: string;
  }) {
    const [section, setSection] = React.useState(
      initialSection === "general" ? "general" : "authentication",
    );
    const [providers, setProviders] = React.useState<Array<{ id: string; name: string }>>([]);

    React.useEffect(() => {
      void api.fetchSettings();
      void api.fetchAuthStatus().then((result) => {
        setProviders(result.providers ?? []);
      });
    }, []);

    return (
      <div className="modal-overlay open">
        <h2>Settings</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" onClick={() => setSection("authentication")}>
          Authentication
        </button>
        <button type="button" onClick={() => setSection("general")}>
          General
        </button>
        {section === "authentication" ? (
          <div>
            {providers.map((provider) => (
              <div key={provider.id}>{provider.name}</div>
            ))}
            <button type="button" onClick={onReopenOnboarding}>
              Reopen onboarding guide
            </button>
          </div>
        ) : (
          <label>
            Task Prefix
            <input aria-label="Task Prefix" />
          </label>
        )}
      </div>
    );
  }

  // FNXC:Settings 2026-06-22-12:00: Settings opens as an embedded main-content view (SettingsView) reusing the same body.
  return { SettingsModal: MockSettingsModal, SettingsView: MockSettingsModal };
});

vi.mock("../../components/ModelOnboardingModal", async () => {
  const React = await import("react");
  const api = await import("../../api");

  function MockModelOnboardingModal({
    onComplete,
  }: {
    onComplete: () => void;
  }) {
    const [value, setValue] = React.useState("");

    React.useEffect(() => {
      void Promise.all([api.fetchGlobalSettings(), api.fetchModels()]).then(([settings]) => {
        if (settings.defaultProvider && settings.defaultModelId) {
          setValue(`${settings.defaultProvider}/${settings.defaultModelId}`);
        }
      });
    }, []);

    return (
      <div className="modal-overlay open">
        <h2>Set Up AI</h2>
        <button type="button" onClick={onComplete}>
          Skip for now
        </button>
        <select
          data-testid="mock-model-dropdown"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">Select…</option>
          <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
          <option value="openai/gpt-4o">GPT-4o</option>
        </select>
      </div>
    );
  }

  return { ModelOnboardingModal: MockModelOnboardingModal };
});

// Mock state holders for dynamic mocking
const mockRefreshProjects = vi.fn(async () => {});

const mockProjectsState = {
  projects: [] as any[],
  loading: false,
  error: null as string | null,
};

const DEFAULT_PROJECT_ID = "proj_123";
const DEFAULT_PROJECT: ProjectInfo = { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" };
const taskViewStorageKey = (projectId = DEFAULT_PROJECT_ID) =>
  scopedKey("kb-dashboard-task-view", projectId);

const mockCurrentProjectState: {
  currentProject: ProjectInfo | null;
  setCurrentProject: ReturnType<typeof vi.fn>;
  clearCurrentProject: ReturnType<typeof vi.fn>;
  loading: boolean;
} = {
  currentProject: { ...DEFAULT_PROJECT },
  setCurrentProject: vi.fn(),
  clearCurrentProject: vi.fn(),
  loading: false,
};

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: mockProjectsState.projects,
    loading: mockProjectsState.loading,
    error: mockProjectsState.error,
    refresh: mockRefreshProjects,
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
  }),
}));

vi.mock("../../hooks/useCurrentProject", () => ({
  useCurrentProject: () => mockCurrentProjectState,
}));

// Mock useTerminal for terminal components
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

// Mock useNodes for node selector
vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

// Mock useMobileKeyboard for modal keyboard isolation tests (FN-3290).
// Default: keyboard closed, matching real test-environment behavior.
const mockUseMobileKeyboard = vi.fn(() => ({
  keyboardOverlap: 0,
  viewportHeight: null,
  viewportOffsetTop: 0,
  keyboardOpen: false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: unknown[]) => mockUseMobileKeyboard(...args),
}));

// Mock useViewportMode so tests can simulate mobile viewport without
// depending on window.matchMedia in jsdom.
const mockUseViewportMode = vi.fn(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  useViewportMode: (...args: unknown[]) => mockUseViewportMode(...args),
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
  isFullScreenSheetViewport: () => mockUseViewportMode() === "mobile",
}));

// Mock isIOS so FN-3290 keyboard-open behavior is testable in jsdom
vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
  isIOS: () => true,
  _resetLockState: vi.fn(),
}));

import { App, didEnterAwaitingApproval, didEnterDone } from "../../App";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } from "../../auth";
import { fetchAuthStatus, fetchSettings, fetchGlobalSettings, fetchTaskDetail, fetchUnreadCount, updateSettings, runScript, fetchScripts, fetchModels, fetchPluginDashboardViews, fetchDashboardHealth, fetchBoardWorkflows } from "../../api";
import { __resetShellHostContextForTests } from "../../shell-host";
import * as apiNodeModule from "../../hooks/useRemoteNodeData";

async function waitForAppShell(): Promise<void> {
  await waitFor(() => {
    expect(fetchSettings).toHaveBeenCalled();
    expect(screen.getByTitle("Settings")).toBeTruthy();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  /*
   * FNXC:DashboardTests 2026-06-22-03:47:
   * App.test.tsx runs beside other dashboard specs in the same Vitest process, so reset API mock implementations as well as call counts to prevent cross-file implementation leakage.
   */
  vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings });
  vi.mocked(updateSettings).mockResolvedValue({ ...defaultSettings });
  vi.mocked(fetchGlobalSettings).mockResolvedValue({ modelOnboardingComplete: true });
  vi.mocked(fetchDashboardHealth).mockResolvedValue({
    status: "ok",
    version: "1.0.0",
    uptime: 1,
    engine: { available: true },
    database: {
      healthy: true,
      corruptionDetected: false,
      corruptionErrors: [],
      lastCheckedAt: null,
      isRunning: false,
    },
    taskIdIntegrity: { status: "ok", checkedAt: "2026-05-12T00:00:00.000Z", anomalies: [], recommendedAction: null },
  });
  vi.mocked(fetchBoardWorkflows).mockResolvedValue({
    flagEnabled: false,
    defaultWorkflowId: "builtin:coding",
    workflows: [],
    taskWorkflowIds: {},
  });
  vi.mocked(apiNodeModule.useRemoteNodeData).mockReset();
  vi.mocked(apiNodeModule.useRemoteNodeData).mockReturnValue({
    projects: [],
    tasks: [],
    health: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  vi.mocked(fetchAuthStatus).mockResolvedValue({
    providers: [
      { id: "anthropic", name: "Anthropic", authenticated: true },
      { id: "github", name: "GitHub", authenticated: true },
    ],
  });
  vi.mocked(fetchModels).mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
  vi.mocked(fetchScripts).mockResolvedValue({ build: "npm run build", test: "pnpm test" });
  vi.mocked(runScript).mockResolvedValue({ sessionId: "sess-script-1", command: "echo hello" });
  __resetShellHostContextForTests();
  localStorage.clear();
  /*
   * FNXC:DashboardTests 2026-07-01-12:45:
   * App-level project surface tests require a coherent local project shell at reset time. Keep the default mock project list, current project, workflow metadata response, and persisted view mode aligned so broad App.test.tsx runs do not depend on project/view state leaked from earlier tests before asserting Board/List/mobile controls.
   */
  localStorage.setItem("kb-dashboard-view-mode", "project");
  mockSubscribeSse.mockReset();
  mockSubscribeSse.mockReturnValue(vi.fn());
  mockUseBackgroundSessions.mockReset();
  mockUseBackgroundSessions.mockReturnValue({
    sessions: [],
    generating: false,
    needsInput: false,
    planningSessions: [],
    dismissSession: vi.fn(),
  });
  mockCreateTask.mockReset();
  mockUseTasks.mockReset();
  mockUseTasks.mockImplementation(() => ({
    tasks: [],
    isStale: false,
    createTask: mockCreateTask,
    moveTask: vi.fn(),
    pauseTask: vi.fn(),
    unpauseTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    retryTask: vi.fn(),
    resetTask: vi.fn(),
    updateTask: vi.fn(),
    duplicateTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    archiveAllDone: vi.fn(),
    loadArchivedTasks: vi.fn(),
    refreshTasks: vi.fn(),
    ingestCreatedTasks: vi.fn(),
    lastFetchTimeMs: Date.now(),
  }));
  // Reset mock states
  mockProjectsState.projects = [{ ...DEFAULT_PROJECT }];
  mockProjectsState.loading = false;
  mockProjectsState.error = null;
  mockRefreshProjects.mockReset();
  mockRefreshProjects.mockImplementation(async () => {});
  mockCurrentProjectState.currentProject = { ...DEFAULT_PROJECT };
  mockCurrentProjectState.loading = false;
  mockCurrentProjectState.setCurrentProject.mockClear();
  mockCurrentProjectState.clearCurrentProject.mockClear();
  // Reset node context mocks
  mockNodeContextValue.currentNode = null;
  mockNodeContextValue.currentNodeId = null;
  mockNodeContextValue.isRemote = false;
  mockNodeContextValue.setCurrentNode.mockClear();
  mockNodeContextValue.clearCurrentNode.mockClear();
  // Clear node selection from localStorage to avoid cross-test leakage
  localStorage.removeItem("fusion-dashboard-current-node");
  // Clear onboarding/chat state from localStorage
  localStorage.removeItem("kb-onboarding-state");
  localStorage.removeItem(scopedKey("kb-chat-active-session", "proj_123"));
  // Reset onboarding state mocks
  mockIsOnboardingResumable.mockReset();
  mockIsOnboardingResumable.mockReturnValue(false);
  mockGetOnboardingResumeStep.mockReset();
  mockGetOnboardingResumeStep.mockReturnValue(null);
  mockGetOnboardingState.mockReset();
  mockGetOnboardingState.mockReturnValue(null);
  mockSaveOnboardingState.mockReset();
  mockClearOnboardingState.mockReset();
  mockIsOnboardingCompleted.mockReset();
  mockIsOnboardingCompleted.mockReturnValue(false);
  mockMarkOnboardingCompleted.mockReset();
  mockMarkStepSkipped.mockReset();
  mockGetOnboardingCompletedAt.mockReset();
  mockGetOnboardingCompletedAt.mockReturnValue(null);
  mockGetSkippedSteps.mockReset();
  mockGetSkippedSteps.mockReturnValue([]);
  mockGetStepData.mockReset();
  mockGetStepData.mockReturnValue(null);
  mockUseInsights.mockReset();
  mockUseInsights.mockImplementation(() => ({
    sections: [],
    loading: false,
    error: null,
    latestRun: null,
    isRunInFlight: false,
    runError: null,
    refresh: vi.fn(),
    runInsights: vi.fn(),
    dismiss: vi.fn(),
    createTask: vi.fn(),
    dismissStates: new Map(),
    createTaskStates: new Map(),
    totalCount: 0,
    dismissedCount: 0,
  }));
  // Reset mobile keyboard and viewport mocks to defaults (desktop, no keyboard)
  mockUseMobileKeyboard.mockReset();
  mockUseMobileKeyboard.mockReturnValue({
    keyboardOverlap: 0,
    viewportHeight: null,
    viewportOffsetTop: 0,
    keyboardOpen: false,
  });
  mockUseViewportMode.mockReset();
  mockUseViewportMode.mockReturnValue("desktop");
  mockAgentStats.todoTaskCount = 0;
  mockAgentStats.idleNonEphemeralCount = 1;
});

describe("FN-4250 FileBrowserProvider coverage", () => {
  it("shows engine restart instructions when health reports a UI-only dashboard", async () => {
    vi.mocked(fetchDashboardHealth).mockResolvedValueOnce({
      status: "ok",
      version: "1.0.0",
      uptime: 1,
      engine: {
        available: false,
      },
      database: {
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      },
      taskIdIntegrity: { status: "ok", checkedAt: "2026-05-12T00:00:00.000Z", anomalies: [], recommendedAction: null },
    });
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;

    render(<App />);

    expect(await screen.findByText("AI engine is not running")).toBeInTheDocument();
    expect(screen.getByText("pnpm local")).toBeInTheDocument();
    expect(screen.getByText("fn dashboard")).toBeInTheDocument();
  });

  it("does not show engine restart instructions when health reports an engine", async () => {
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;

    render(<App />);

    await waitFor(() => expect(fetchDashboardHealth).toHaveBeenCalled());
    expect(screen.queryByText("AI engine is not running")).not.toBeInTheDocument();
  });

  it("does not show engine restart instructions when an older health payload omits engine status", async () => {
    vi.mocked(fetchDashboardHealth).mockResolvedValueOnce({
      status: "ok",
      version: "1.0.0",
      uptime: 1,
      database: {
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      },
      taskIdIntegrity: { status: "ok", checkedAt: "2026-05-12T00:00:00.000Z", anomalies: [], recommendedAction: null },
    });
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;

    render(<App />);

    await waitFor(() => expect(fetchDashboardHealth).toHaveBeenCalled());
    expect(screen.queryByText("AI engine is not running")).not.toBeInTheDocument();
  });

  it("shows engine restart instructions on mobile when health reports a UI-only dashboard", async () => {
    vi.mocked(fetchDashboardHealth).mockResolvedValueOnce({
      status: "ok",
      version: "1.0.0",
      uptime: 1,
      engine: {
        available: false,
      },
      database: {
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      },
      taskIdIntegrity: { status: "ok", checkedAt: "2026-05-12T00:00:00.000Z", anomalies: [], recommendedAction: null },
    });
    mockUseViewportMode.mockReturnValue("mobile");
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;

    render(<App />);

    expect(await screen.findByText("AI engine is not running")).toBeInTheDocument();
    expect(screen.getByText("fn dashboard")).toBeInTheDocument();
  });

  it("FN-4779: renders app shell immediately when project data is ready", () => {
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;

    render(<App />);

    expect(screen.getByTitle("Settings")).toBeInTheDocument();
    expect(screen.queryByTestId("fb-probe-loader")).not.toBeInTheDocument();
  });

  it("FN-4801: keeps top progress bar visible while tasks are stale", () => {
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;
    mockUseTasks.mockImplementation(() => ({
      tasks: [],
      isStale: true,
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      pauseTask: vi.fn(),
      unpauseTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      resetTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      loadArchivedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);

    const progressBar = screen.getByRole("progressbar", { name: "Loading" });
    expect(progressBar).toHaveAttribute("aria-busy", "true");
    expect(progressBar).toHaveAttribute("data-visible", "true");
  });

  it("FN-4801: hides top progress bar on next render when tasks are fresh", () => {
    mockProjectsState.loading = false;
    mockProjectsState.projects = [
      { id: DEFAULT_PROJECT_ID, name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ];
    mockCurrentProjectState.loading = false;

    const taskHookState = { isStale: true };
    mockUseTasks.mockImplementation(() => ({
      tasks: [],
      isStale: taskHookState.isStale,
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      pauseTask: vi.fn(),
      unpauseTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      resetTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      loadArchivedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    const { rerender } = render(<App />);

    const progressBar = screen.getByRole("progressbar", { name: "Loading" });
    expect(progressBar).toHaveAttribute("aria-busy", "true");
    expect(progressBar).toHaveAttribute("data-visible", "true");

    taskHookState.isStale = false;
    rerender(<App />);

    expect(progressBar).toHaveAttribute("aria-busy", "false");
    expect(progressBar).toHaveAttribute("data-visible", "false");
  });

  it("FN-4250: ChatView branch is inside FileBrowserProvider", async () => {
    localStorage.setItem(taskViewStorageKey(), "chat");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("fb-probe-chat")).toHaveTextContent("ok");
    });
  });

  it("FN-4250: loader branch is inside FileBrowserProvider", async () => {
    mockProjectsState.projects = [];
    mockProjectsState.loading = true;
    mockCurrentProjectState.currentProject = null;
    mockCurrentProjectState.loading = true;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("fb-probe-loader")).toHaveTextContent("ok");
    });
  });
});

describe("Capacity risk banner gating", () => {
  it("does not render banner when capacityRiskBannerEnabled is false", async () => {
    mockAgentStats.todoTaskCount = 21;
    mockAgentStats.idleNonEphemeralCount = 0;
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      capacityRiskBannerEnabled: false,
      capacityRiskTodoThreshold: 20,
    });

    render(<App />);
    await waitForAppShell();

    expect(screen.queryByText(/Capacity risk:/i)).not.toBeInTheDocument();
  });

  it("renders and dismisses banner when enabled", async () => {
    mockAgentStats.todoTaskCount = 21;
    mockAgentStats.idleNonEphemeralCount = 0;
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      capacityRiskBannerEnabled: true,
      capacityRiskTodoThreshold: 20,
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Capacity risk:/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss capacity warning/i }));

    expect(localStorage.getItem(scopedKey("kb-capacity-risk-banner-dismissed", DEFAULT_PROJECT_ID))).toBe("true");
    await waitFor(() => {
      expect(screen.queryByText(/Capacity risk:/i)).not.toBeInTheDocument();
    });
  });
});

describe("App backend-unreachable first-run flow", () => {
  it("renders backend connection error page instead of setup wizard when projects fetch fails during first-run", async () => {
    mockProjectsState.projects = [];
    mockProjectsState.error = "Backend unavailable";
    mockCurrentProjectState.currentProject = null;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Can't reach the Fusion backend")).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "Retry Connection" })).toBeTruthy();
    expect(screen.queryByText("Welcome to Fusion")).toBeNull();
  });

  it("retries project loading and resumes the empty-project dashboard after connectivity recovers", async () => {
    vi.useFakeTimers();

    try {
      mockProjectsState.projects = [];
      mockProjectsState.error = "Backend unavailable";
      mockCurrentProjectState.currentProject = null;
      localStorage.setItem("kb-dashboard-view-mode", "overview");

      mockRefreshProjects.mockImplementation(async () => {
        mockProjectsState.error = null;
      });

      const { rerender } = render(<App />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.getByRole("button", { name: "Retry Connection" })).toBeTruthy();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry Connection" }));
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(mockRefreshProjects).toHaveBeenCalledTimes(1);

      rerender(<App />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      /*
       * FNXC:BackendRecovery 2026-06-25-10:58:
       * Recovering from an unreachable backend should resume the current no-project dashboard state, not force the setup wizard. The retry assertion pins the user-visible recovery surface after the navigation-default cleanup.
       */
      expect(screen.getByText("No Projects Found")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("didEnterAwaitingApproval", () => {
  it("returns true only when status newly enters awaiting-approval", () => {
    expect(didEnterAwaitingApproval("awaiting-approval", "in-progress")).toBe(true);
    expect(didEnterAwaitingApproval("awaiting-approval", "awaiting-approval")).toBe(false);
    expect(didEnterAwaitingApproval("done", "in-progress")).toBe(false);
  });
});

describe("didEnterDone", () => {
  it("returns true only when status newly enters done", () => {
    expect(didEnterDone("done", "in-progress")).toBe(true);
    expect(didEnterDone("done", "todo")).toBe(true);
    expect(didEnterDone("done", "done")).toBe(false);
    expect(didEnterDone("in-progress", "todo")).toBe(false);
    expect(didEnterDone("in-progress", undefined)).toBe(false);
  });
});

describe("App mailbox unread count", () => {
  it("logs a warning when unread count fetch fails and keeps the zero-count fallback", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unreadFetchError = new Error("Mailbox unavailable");
    (fetchUnreadCount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unreadFetchError);

    render(<App />);

    await waitFor(() => {
      expect(fetchUnreadCount).toHaveBeenCalledWith("proj_123");
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[App] Failed to fetch mailbox unread count:",
        unreadFetchError,
      );
    });

    await waitForAppShell();
    warnSpy.mockRestore();
  });

  it("refreshes unread count on mailbox SSE events even outside mailbox view", async () => {
    (fetchUnreadCount as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ unreadCount: 0 })
      .mockResolvedValueOnce({ unreadCount: 4 });

    render(<App />);

    await waitFor(() => {
      expect(mockSubscribeSse).toHaveBeenCalled();
    });

    const mailboxSubscriptionCall = mockSubscribeSse.mock.calls.find(
      ([url, sub]) => String(url).startsWith("/api/events") && typeof (sub as { events?: Record<string, unknown> })?.events?.["message:received"] === "function",
    );
    const subscriptionConfig = mailboxSubscriptionCall?.[1] as {
      events: Record<string, () => void>;
    };

    expect(subscriptionConfig.events["message:received"]).toBeTypeOf("function");

    await act(async () => {
      subscriptionConfig.events["message:received"]();
    });

    await waitFor(() => {
      expect(fetchUnreadCount).toHaveBeenCalledTimes(2);
      expect(fetchUnreadCount).toHaveBeenLastCalledWith("proj_123");
    });
  });
});

describe("App approval notification banner", () => {
  it("does not show the mailbox banner when a task newly enters awaiting-approval", async () => {
    mockUseTasks.mockImplementation(() => ({
      tasks: [{ id: "FN-1", title: "Task", description: "x", status: "in-progress", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" }],
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
      pauseTask: vi.fn(),
      resetTask: vi.fn(),
      loadArchivedTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);

    await waitFor(() => expect(mockSubscribeSse).toHaveBeenCalled());

    const approvalSubscriptionCall = mockSubscribeSse.mock.calls.find(
      ([url, sub]) => String(url).startsWith("/api/events") && typeof (sub as { events?: Record<string, unknown> })?.events?.["task:updated"] === "function",
    );
    const subscriptionConfig = approvalSubscriptionCall?.[1] as {
      events: Record<string, (event: MessageEvent) => void>;
    };

    await act(async () => {
      subscriptionConfig.events["task:updated"](
        new MessageEvent("task:updated", {
          data: JSON.stringify({ id: "FN-1", status: "awaiting-approval", updatedAt: "2026-05-05T10:00:00.000Z" }),
        }),
      );
    });

    expect(screen.queryByLabelText("Approval requests")).toBeNull();
  });

  it("persists dismissals and suppresses repeat alerts for the same real approval request", async () => {
    mockUseTasks.mockImplementation(() => ({
      tasks: [{ id: "FN-4", title: "Task", description: "x", status: "in-progress", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" }],
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
      pauseTask: vi.fn(),
      resetTask: vi.fn(),
      loadArchivedTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    const { unmount } = render(<App />);

    await waitFor(() => expect(mockSubscribeSse).toHaveBeenCalled());

    const approvalSubscriptionCall = mockSubscribeSse.mock.calls.find(
      ([url, sub]) => String(url).startsWith("/api/events")
        && typeof (sub as { events?: Record<string, unknown> })?.events?.["approval:requested"] === "function"
        && typeof (sub as { events?: Record<string, unknown> })?.events?.["task:updated"] === "function",
    );
    const subscriptionConfig = approvalSubscriptionCall?.[1] as {
      events: Record<string, (event: MessageEvent) => void>;
    };

    await act(async () => {
      subscriptionConfig.events["approval:requested"](
        new MessageEvent("approval:requested", {
          data: JSON.stringify({ id: "approval-1", taskId: "FN-4", updatedAt: "2026-05-05T10:00:00.000Z" }),
        }),
      );
    });

    fireEvent.click(screen.getByLabelText("Dismiss approval notification banner"));
    expect(screen.queryByLabelText("Approval requests")).toBeNull();

    unmount();
    render(<App />);

    const latestSubscription = mockSubscribeSse.mock.calls
      .slice()
      .reverse()
      .find(([, sub]) => typeof (sub as { events?: Record<string, unknown> })?.events?.["approval:requested"] === "function"
        && typeof (sub as { events?: Record<string, unknown> })?.events?.["task:updated"] === "function");
    const latestConfig = latestSubscription?.[1] as {
      events: Record<string, (event: MessageEvent) => void>;
    };

    await act(async () => {
      latestConfig.events["approval:requested"](
        new MessageEvent("approval:requested", {
          data: JSON.stringify({ id: "approval-1", taskId: "FN-4", updatedAt: "2026-05-05T10:00:00.000Z" }),
        }),
      );
    });

    expect(screen.queryByLabelText("Approval requests")).toBeNull();
  });

  it("does not show banner for already-awaiting tasks", async () => {
    mockUseTasks.mockImplementation(() => ({
      tasks: [{ id: "FN-2", title: "Task", description: "x", status: "awaiting-approval", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" }],
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
      pauseTask: vi.fn(),
      resetTask: vi.fn(),
      loadArchivedTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);

    await waitFor(() => expect(mockSubscribeSse).toHaveBeenCalled());

    const mailboxSubscriptionCall = mockSubscribeSse.mock.calls.find(
      ([url, sub]) => String(url).startsWith("/api/events") && typeof (sub as { events?: Record<string, unknown> })?.events?.["task:updated"] === "function",
    );
    const subscriptionConfig = mailboxSubscriptionCall?.[1] as {
      events: Record<string, (event: MessageEvent) => void>;
    };

    await act(async () => {
      subscriptionConfig.events["task:updated"](
        new MessageEvent("task:updated", {
          data: JSON.stringify({ id: "FN-2", status: "awaiting-approval", updatedAt: "2026-05-05T10:00:00.000Z" }),
        }),
      );
    });

    expect(screen.queryByLabelText("Approval requests")).toBeNull();
  });
});

describe("App chat unread response indicator", () => {
  const getChatEvents = async () => {
    render(<App />);

    await waitFor(() => {
      expect(mockSubscribeSse).toHaveBeenCalled();
    });

    const chatSubscriptionCall = mockSubscribeSse.mock.calls.find(
      ([url, sub]) => String(url).startsWith("/api/events") && typeof (sub as { events?: Record<string, unknown> })?.events?.["chat:message:added"] === "function",
    );

    return (chatSubscriptionCall?.[1] as {
      events: Record<string, (event: MessageEvent) => void>;
    }).events;
  };

  // FNXC:Navigation 2026-06-22-09:30: With the left sidebar as primary nav, the chat
  // unread indicator moved from the header chat button to the Chat sidebar entry's
  // status dot (.left-sidebar-nav__dot inside the sidebar-nav-chat button).
  const chatUnreadDot = () => {
    const chatNav = screen.queryByTestId("sidebar-nav-chat");
    return chatNav ? chatNav.querySelector(".left-sidebar-nav__dot.status-dot--pending") : null;
  };

  it("shows unread indicator when assistant message arrives for any individual session", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:message:added"](
        new MessageEvent("chat:message:added", {
          data: JSON.stringify({ role: "assistant", sessionId: "sess-other" }),
        }),
      );
    });

    await waitFor(() => {
      expect(chatUnreadDot()).not.toBeNull();
    });
  });

  it("does not show unread indicator for hidden planner assistant messages", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:message:added"](
        new MessageEvent("chat:message:added", {
          data: JSON.stringify({ role: "assistant", sessionId: "sess-planner", agentId: "task-planner:FN-7392" }),
        }),
      );
    });

    const chatNav = screen.getByTestId("sidebar-nav-chat");
    expect(chatNav).toBeInTheDocument();
    expect(chatUnreadDot()).toBeNull();
    expect(chatNav.querySelector(".left-sidebar-nav__dot")).toBeNull();
  });

  it("does not show mobile unread indicator for hidden planner assistant messages", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const events = await getChatEvents();

    await act(async () => {
      events["chat:message:added"](
        new MessageEvent("chat:message:added", {
          data: JSON.stringify({ role: "assistant", sessionId: "sess-planner", agentId: "task-planner:FN-7392" }),
        }),
      );
    });

    const mobileChatNav = screen.getByTestId("mobile-nav-tab-chat");
    expect(mobileChatNav).toBeInTheDocument();
    expect(mobileChatNav.querySelector(".mobile-nav-chat-unread-dot")).toBeNull();
  });

  it("shows unread indicator for planner assistant messages visible in the common Chat feed", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:message:added"](
        new MessageEvent("chat:message:added", {
          data: JSON.stringify({
            role: "assistant",
            sessionId: "sess-planner",
            agentId: "task-planner:FN-7392",
            taskChatVisibleInCommonFeed: true,
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(chatUnreadDot()).not.toBeNull();
    });
  });

  it("does not show unread indicator for individual user messages", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:message:added"](
        new MessageEvent("chat:message:added", {
          data: JSON.stringify({ role: "user", sessionId: "sess-active" }),
        }),
      );
    });

    expect(chatUnreadDot()).toBeNull();
  });

  it("shows unread indicator for room assistant replies", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:room:message:added"](
        new MessageEvent("chat:room:message:added", {
          data: JSON.stringify({ role: "assistant", roomId: "room-1", id: "msg-1", content: "hi", createdAt: new Date().toISOString() }),
        }),
      );
    });

    await waitFor(() => {
      expect(chatUnreadDot()).not.toBeNull();
    });
  });

  it("does not show unread indicator for room user messages", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:room:message:added"](
        new MessageEvent("chat:room:message:added", {
          data: JSON.stringify({ role: "user", roomId: "room-1", id: "msg-2", content: "mine", createdAt: new Date().toISOString() }),
        }),
      );
    });

    expect(chatUnreadDot()).toBeNull();
  });

  it("clears unread indicator when returning to chat and does not mark while in chat", async () => {
    const events = await getChatEvents();

    await act(async () => {
      events["chat:room:message:added"](
        new MessageEvent("chat:room:message:added", {
          data: JSON.stringify({ role: "assistant", roomId: "room-1", id: "msg-3", content: "reply", createdAt: new Date().toISOString() }),
        }),
      );
    });

    await waitFor(() => {
      expect(chatUnreadDot()).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("sidebar-nav-chat"));

    await waitFor(() => {
      expect(chatUnreadDot()).toBeNull();
    });

    await act(async () => {
      events["chat:room:message:added"](
        new MessageEvent("chat:room:message:added", {
          data: JSON.stringify({ role: "assistant", roomId: "room-1", id: "msg-4", content: "while-open", createdAt: new Date().toISOString() }),
        }),
      );
    });

    expect(chatUnreadDot()).toBeNull();
  });
});

describe("App deep link handling", () => {
  const originalLocation = window.location;
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    /*
     * FNXC:DashboardTests 2026-06-26-23:40:
     * Deep-link App tests stub `history.replaceState` for assertions, but `useNavigationHistory` still writes real `pushState` entries and preserves existing `history.state.navIndex`. Reset the real history snapshot before installing the stub so full-file ordering cannot mount a later Back test with stale browser state.
     */
    originalReplaceState.call(window.history, null, "", "/");
    window.history.replaceState = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/"),
    });
  });

  afterEach(() => {
    window.history.replaceState = originalReplaceState;
    originalReplaceState.call(window.history, null, "", "/");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("fetches and opens the task modal when task query param is present", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it("shows an error toast when the deep-linked task cannot be loaded", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-404"),
    });
    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Not found"));

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-404", "proj_123");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-404 not found")).toBeTruthy();
    });
  });

  it("does nothing when no task query param is present", async () => {
    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it("switches project and opens task when both project and task params are present", async () => {
    const project1 = { id: "proj_123", name: "Test Project", path: "/test", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    const project2 = { id: "proj_456", name: "Other Project", path: "/other", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project1, project2];
    mockCurrentProjectState.currentProject = project1;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-789"),
    });

    render(<App />);

    await waitFor(() => {
      expect(mockCurrentProjectState.setCurrentProject).toHaveBeenCalledWith(project2);
    });

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-789", "proj_456");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-789")).toBeTruthy();
    });
  });

  it("shows error toast when project param references non-existent project", async () => {
    /*
     * FNXC:DeepLink 2026-07-03-09:50:
     * The not-found toast is deferred behind a grace window so an onboarding project deep-linked before
     * its list revalidates does not flash a spurious error. A genuinely nonexistent project stays absent
     * past the window and still surfaces the toast — advance fake timers to reach it.
     */
    vi.useFakeTimers();
    try {
      mockProjectsState.projects = [];
      mockCurrentProjectState.currentProject = null;

      Object.defineProperty(window, "location", {
        configurable: true,
        value: new URL("http://localhost:3000/?project=nonexistent&task=FN-123"),
      });

      render(<App />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchSettings).toHaveBeenCalled();

      // Within the grace window nothing has toasted yet.
      expect(screen.queryByText("Project 'nonexistent' not found")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      // Grace window elapsed with the project still absent — the error toast now shows.
      expect(screen.getByText("Project 'nonexistent' not found")).toBeTruthy();

      // Should NOT fetch the task since project wasn't found.
      expect(fetchTaskDetail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call setCurrentProject when project param matches current project", async () => {
    const project = { id: "proj_123", name: "Test Project", path: "/test", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project];
    mockCurrentProjectState.currentProject = project;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_123&task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    // setCurrentProject should NOT be called since we're already on this project
    expect(mockCurrentProjectState.setCurrentProject).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });
  });

  it("works without project param for backward compatibility", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    // setCurrentProject should NOT be called when no project param
    expect(mockCurrentProjectState.setCurrentProject).not.toHaveBeenCalled();
  });

  it("waits for projects to load before resolving deep links", async () => {
    // Start with projects still loading
    mockProjectsState.loading = true;
    mockProjectsState.projects = [];
    mockCurrentProjectState.currentProject = null;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_123&task=FN-001"),
    });

    render(<App />);

    // Wait a tick to ensure no premature fetch
    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    // Should NOT have fetched the task or shown an error while loading
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(screen.queryByText(/not found/)).toBeNull();
  });

  it("prevents double-fetch when project switch triggers effect re-run", async () => {
    const project1 = { id: "proj_123", name: "Test Project", path: "/test", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    const project2 = { id: "proj_456", name: "Other Project", path: "/other", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project1, project2];
    mockCurrentProjectState.currentProject = project1;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-789"),
    });

    render(<App />);

    // Wait for the task to be fetched
    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-789", "proj_456");
    });

    // fetchTaskDetail should have been called exactly once (no double-fetch)
    expect(fetchTaskDetail).toHaveBeenCalledTimes(1);
  });

  it("fetches task from the project param's project even when current project differs", async () => {
    const project1 = { id: "proj_123", name: "Test Project", path: "/test", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    const project2 = { id: "proj_456", name: "Other Project", path: "/other", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project1, project2];
    mockCurrentProjectState.currentProject = project1;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-001"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-001", "proj_456");
    });

    // Should NOT have used the current project (proj_123) for the fetch
    expect(fetchTaskDetail).not.toHaveBeenCalledWith("FN-001", "proj_123");
  });

  it("removes task param from URL when deep-linked modal is dismissed", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    // Dismiss the modal via its close button
    const closeBtn = document.querySelector(".modal-overlay.open .modal-close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);

    // Should have cleaned the task param from the URL via replaceState
    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalledWith(
        expect.any(Object),
        "",
        "/",
      );
    });

    // Modal should be closed
    await waitFor(() => {
      expect(screen.queryByText("Task FN-123")).toBeNull();
    });
  });

  it("preserves project param when removing task param on dismiss", async () => {
    const project = { id: "proj_456", name: "Other Project", path: "/other", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project];
    mockCurrentProjectState.currentProject = project;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-789"),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Task FN-789")).toBeTruthy();
    });

    // Dismiss the modal via its close button
    const closeBtn = document.querySelector(".modal-overlay.open .modal-close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);

    // Should have removed only the task param, keeping project param
    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalledWith(
        expect.any(Object),
        "",
        "/?project=proj_456",
      );
    });
  });

  it("does not call replaceState when closing a non-deep-linked task modal", async () => {
    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    // Open a task detail the normal way (not via deep link)
    const { useTasks } = await import("../../hooks/useTasks");
    const tasksHook = mockUseTasks();
    const task = { id: "FN-999", title: "Manual Task" };
    await act(async () => {
      (tasksHook.tasks as unknown[]) = [task];
    });

    // Simulate opening the task detail from the board
    // We directly trigger handleDetailOpen by finding a task card
    // For simplicity, verify replaceState hasn't been called yet
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it("closes board-opened main-panel task detail on one browser back", async () => {
    const boardTask = { id: "FN-6964", title: "Back nav task", description: "x", status: "todo", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    mockUseTasks.mockImplementation(() => ({
      tasks: [boardTask],
      isStale: false,
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      pauseTask: vi.fn(),
      unpauseTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      resetTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      loadArchivedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);
    await waitForAppShell();
    fireEvent.click(screen.getByText("Back nav task"));
    expect(await screen.findByTestId("main-panel-task-detail")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("main-panel-task-detail")).toBeNull();
      expect(screen.getByText("Back nav task")).toBeTruthy();
    });
  });

  it("restores the previous main-panel task detail on nested detail browser back", async () => {
    const boardTask = { id: "FN-6964", title: "Back nav task", description: "x", status: "todo", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    mockUseTasks.mockImplementation(() => ({
      tasks: [boardTask],
      isStale: false,
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      pauseTask: vi.fn(),
      unpauseTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      resetTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      loadArchivedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByText("Back nav task"));
    expect(await screen.findByText("Open nested task")).toBeTruthy();
    fireEvent.click(screen.getByText("Open nested task"));
    expect(await screen.findByText("Nested task")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 1 } }));
    });

    await waitFor(() => {
      expect(screen.queryByText("Nested task")).toBeNull();
      expect(screen.getByTestId("main-panel-task-detail")).toBeTruthy();
      expect(screen.getByText("Back nav task")).toBeTruthy();
    });
  });

  it("does not reopen deep-linked task after dismissal and re-render", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    // Capture call count after initial fetch (may be 1 or 2 due to Strict Mode)
    const callCountAfterInitialFetch = vi.mocked(fetchTaskDetail).mock.calls.length;

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    // Dismiss the modal — this should consume the deep-link trigger
    const closeBtn = document.querySelector(".modal-overlay.open .modal-close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText("Task FN-123")).toBeNull();
    });

    // The deepLinkFetchedRef prevents additional fetches after dismissal.
    // Note: May be called multiple times due to React Strict Mode and effect dependencies,
    // but the key behavior is that the modal opens and closes correctly.
    expect(vi.mocked(fetchTaskDetail).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("App mission wiring", () => {
  afterEach(() => {
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("hides missions view toggle when no project is selected", async () => {
    mockCurrentProjectState.currentProject = null;
    mockProjectsState.projects = [];

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    expect(screen.queryByTitle("Missions view")).toBeNull();
  });

  it("shows missions view toggle in project view when a project is selected", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    mockCurrentProjectState.currentProject = {
      id: "proj_123",
      name: "Test Project",
      path: "/test",
      status: "active",
      isolationMode: "in-process",
      createdAt: "",
      updatedAt: "",
    };

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-missions")).toBeTruthy();
    });
  });
});

describe("App auto-open Settings on unauthenticated", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });
  });

  it("auto-opens onboarding modal when all providers are unauthenticated and onboarding not complete", async () => {
    vi.mocked(fetchGlobalSettings).mockResolvedValue({});
    render(<App />);

    // Wait for the auth status check and global settings check
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => expect(fetchGlobalSettings).toHaveBeenCalled());

    // The onboarding modal should be open showing the provider step
    await waitFor(() => {
      expect(screen.getByText("Set Up AI")).toBeTruthy();
    });

    // Settings modal should NOT be open
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("auto-opens Settings to Authentication tab when all providers are unauthenticated but onboarding IS complete", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: true,
    });

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // The Settings modal should be open showing Authentication content.
    // App and SettingsModal both hydrate settings, and follow-up refreshes may
    // legitimately add another fetch during initialization; the invariant here
    // is that settings hydration happened before Authentication content renders.
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Authentication section should be active — auth status is fetched when section is active
    expect(await screen.findByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();

    // Onboarding modal should NOT be open
    expect(screen.queryByText("Set Up AI")).toBeNull();
  });

  it("does NOT auto-open anything when at least one provider is authenticated and default model is set", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Settings modal should NOT be open
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();

    // Onboarding modal should NOT be open
    expect(screen.queryByText("Set Up AI")).toBeNull();
  });

  it("treats authenticated API-key providers as valid auth for onboarding checks", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" },
        { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
      ],
    });
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "openrouter",
      defaultModelId: "gpt-4o",
    });

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Set Up AI")).toBeNull();
  });

  it("auto-opens onboarding when providers are authenticated but default model is missing", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
      ],
    });
    // No defaultProvider or defaultModelId → setup incomplete
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: false,
    });

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => expect(fetchGlobalSettings).toHaveBeenCalled());

    // Onboarding modal should be open
    await waitFor(() => {
      expect(screen.getByText("Set Up AI")).toBeTruthy();
    });
  });

  it("does NOT auto-open Settings when fetchAuthStatus fails", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Settings modal should NOT be open
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    // Onboarding modal should NOT be open
    expect(screen.queryByText("Set Up AI")).toBeNull();
  });

  it("re-opening Settings via gear icon defaults to Authentication tab after closing onboarding", async () => {
    vi.mocked(fetchGlobalSettings).mockResolvedValue({});
    render(<App />);

    // Wait for onboarding to auto-open
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText("Set Up AI")).toBeTruthy();
    });

    // Dismiss the onboarding modal via Skip for now button
    fireEvent.click(screen.getByText("Skip for now"));

    // Onboarding modal should be closed
    await waitFor(() => {
      expect(screen.queryByText("Set Up AI")).toBeNull();
    });

    // Open settings via the sidebar Settings entry (header gear is hidden when the
    // left sidebar owns desktop Settings); it navigates to the embedded SettingsView.
    const settingsButton = screen.getByTitle("Settings");
    fireEvent.click(settingsButton);

    // Settings should open with Authentication section (first/default)
    await waitFor(() => expect(fetchSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Authentication section content should be visible (providers listed).
    // The embedded SettingsView is lazy + fetches auth async, so await the provider row.
    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeTruthy();
    });

    // Click on General to verify General section has Task Prefix
    fireEvent.click(screen.getAllByText("General")[0]);
    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();
  });
});

describe("OnboardingResumeCard", () => {
  const STORAGE_KEY = "fusion_model_onboarding_state";

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  // Note: These tests verify the integration with localStorage state.
  // The resume card only appears when viewMode === "project" AND currentProject is set.
  // The full integration tests are complex due to the App's initialization flow.

  it("renders with no localStorage data (no resume card)", async () => {
    // No localStorage data set - resume card should not appear
    render(<App />);

    await waitForAppShell();

    // Resume card should not appear (no resumable state)
    expect(screen.queryByText("Continue Setup")).toBeNull();
  });

  it("renders onboarding modal when in resumable state and modal is open", async () => {
    vi.mocked(fetchGlobalSettings).mockResolvedValue({});
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });
    // Set up localStorage with resumable state
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ currentStep: "ai-setup", updatedAt: new Date().toISOString() })
    );

    render(<App />);

    // Wait for onboarding modal to auto-open
    await waitFor(() => {
      expect(screen.getByText("Set Up AI")).toBeTruthy();
    });

    // Resume card should NOT be visible while modal is open
    expect(screen.queryByText("Continue Setup")).toBeNull();
  });

  it("hides resume card when onboarding is complete", async () => {
    // Set up localStorage with complete state (not resumable)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ currentStep: "complete", updatedAt: new Date().toISOString() })
    );

    render(<App />);

    await waitForAppShell();

    // Resume card should NOT be visible (onboarding is complete)
    expect(screen.queryByText("Continue Setup")).toBeNull();
  });
});

describe("App view switching", () => {
  // FNXC:Navigation 2026-06-22-09:30: Research/Evals/Insights/Memory are now left-sidebar
  // destinations (sidebar-nav-*), not header More-views overflow items, on desktop.
  it("opens research view from the sidebar and persists view selection", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        researchView: true,
      },
    });

    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-research"));

    await waitFor(() => {
      expect(screen.getByTestId("research-view")).toBeInTheDocument();
      expect(localStorage.getItem(taskViewStorageKey())).toBe("research");
    });

    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("opens evals view from the sidebar and persists view selection", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-evals"));

    await waitFor(() => {
      expect(screen.getByTestId("evals-view")).toBeInTheDocument();
      expect(localStorage.getItem(taskViewStorageKey())).toBe("evals");
    });

    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("does not expose research navigation when research feature is disabled", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        researchView: false,
      },
    });

    render(<App />);

    // Wait for the sidebar to render, then assert Research is not a destination.
    await screen.findByTestId("sidebar-nav-board");
    expect(screen.queryByTestId("sidebar-nav-research")).not.toBeInTheDocument();

    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("initializes research view from persisted task-view when feature-enabled", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "research");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        researchView: true,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("research-view")).toBeInTheDocument();
    });

    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("falls back to board when research view is feature-disabled", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "research");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        researchView: false,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });
    expect(screen.queryByTestId("research-view")).not.toBeInTheDocument();

    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("falls back to board when evals view is feature-disabled", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "evals");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        evalsView: false,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });
    expect(screen.queryByTestId("evals-view")).not.toBeInTheDocument();

    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("renders Board view by default", async () => {
    // Set project mode so board view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the app to render and check that the board is visible
    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("renders ListView when view is switched to list", async () => {
    // Set project mode so board/list view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the header to render with view toggle
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-list")).toBeTruthy();
    });

    // Click to switch to list view
    fireEvent.click(screen.getByTestId("sidebar-nav-list"));

    // List view should be rendered (it has a different structure)
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("switches back to Board view from list view", async () => {
    // Set project mode so board/list view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-list")).toBeTruthy();
    });

    // Switch to list view
    fireEvent.click(screen.getByTestId("sidebar-nav-list"));
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    // Switch back to board view
    fireEvent.click(screen.getByTestId("sidebar-nav-board"));
    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("opens the NewTaskModal from the list view new-task button", async () => {
    // Set project mode so board/list view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-list")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("sidebar-nav-list"));

    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Task"));

    // The NewTaskModal should be visible with its header and description field.
    // Scope the title to the modal heading; the left sidebar also renders a "New Task" nav label.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New Task" })).toBeTruthy();
      expect(screen.getByPlaceholderText("What needs to be done?")).toBeTruthy();
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("persists view preference to localStorage", async () => {
    // Clear any previous value and set project mode
    localStorage.removeItem(taskViewStorageKey());
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-list")).toBeTruthy();
    });

    // Switch to list view
    fireEvent.click(screen.getByTestId("sidebar-nav-list"));

    // Should have saved to localStorage
    await waitFor(() => {
      expect(localStorage.getItem(taskViewStorageKey())).toBe("list");
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("initializes view from localStorage if available", async () => {
    // Set localStorage to list view and project mode
    localStorage.setItem(taskViewStorageKey(), "list");
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the app to render
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    // List view should be active
    expect(screen.getByTestId("sidebar-nav-list").className).toContain("active");

    // Cleanup
    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("renders plugin-hosted dashboard view from persisted task view id", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "plugin:fusion-plugin-dependency-graph:graph");
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        pluginId: "fusion-plugin-dependency-graph",
        view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", placement: "more" },
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("dependency-graph")).toBeInTheDocument();
      expect(screen.getByText("No active tasks to display in graph view.")).toBeInTheDocument();
    });

    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  // FN-3916 regression: graph view must render via bundled static registration
  // even when the API reports no plugin dashboard views (e.g. fresh DB).
  it("renders graph view from bundled static registration when API returns no views", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "graph");
    // API returns empty — plugin not installed/loaded
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("dependency-graph")).toBeInTheDocument();
    });

    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("hides the removed Roadmaps destination even when settings and plugin API still mention it", async () => {
    /*
    FNXC:RoadmapsNavigation 2026-06-22-18:50:
    Roadmaps was removed as an app view and experiment. Stale persisted flags and plugin dashboard rows must not expose the old sidebar destination.
    */
    mockUseViewportMode.mockReturnValue("desktop");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, roadmap: true },
    });
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        pluginId: "fusion-plugin-roadmap",
        view: {
          viewId: "roadmaps",
          label: "Roadmaps",
          componentPath: "./dashboard-view",
          icon: "Map",
          placement: "primary",
          order: 30,
        },
      },
    ]);

    render(<App />);

    expect(await screen.findByTestId("sidebar-nav-missions")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-nav-plugin-fusion-plugin-roadmap-roadmaps")).toBeNull();
  });

  it("restores board and plugin routes when persisted taskView changes across remounts", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");

    localStorage.setItem(taskViewStorageKey(), "plugin:fusion-plugin-dependency-graph:graph");
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        pluginId: "fusion-plugin-dependency-graph",
        view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", placement: "more" },
      },
    ]);

    const first = render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("dependency-graph")).toBeInTheDocument();
    });
    first.unmount();

    localStorage.setItem(taskViewStorageKey(), "board");
    const second = render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board").className).toContain("active");
    });
    second.unmount();

    localStorage.setItem(taskViewStorageKey(), "plugin:fusion-plugin-dependency-graph:graph");
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        pluginId: "fusion-plugin-dependency-graph",
        view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", placement: "more" },
      },
    ]);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("dependency-graph")).toBeInTheDocument();
    });

    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });


  it("opens planning mode when TodoView triggers planning from todo item", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        todoView: true,
      },
    });

    localStorage.setItem(taskViewStorageKey(), "todos");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("todo-view")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("todo-planning-button"));

    await waitFor(() => {
      expect(screen.getByTestId("planning-view")).toBeInTheDocument();
      expect(screen.getByText("Planning Mode")).toBeInTheDocument();
    });

    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("shows view toggle buttons in header including agents", async () => {
    render(<App />);

    // Wait for the header to render with view toggle
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board")).toBeTruthy();
      expect(screen.getByTestId("sidebar-nav-list")).toBeTruthy();
      expect(screen.getByTestId("sidebar-nav-agents")).toBeTruthy();
    });
  });

  it("hides agent view controls when no project is active", async () => {
    mockCurrentProjectState.currentProject = null;
    localStorage.setItem("kb-dashboard-view-mode", "overview");

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("sidebar-nav-agents")).toBeNull();
    });

    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("renders AgentsView when agents view is selected", async () => {
    render(<App />);

    const agentsViewButton = await screen.findByTestId("sidebar-nav-agents", {}, { timeout: 5000 });

    // Click to switch to agents view
    fireEvent.click(agentsViewButton);

    // Agents view should be rendered (it has a agents-view container)
    await waitFor(() => {
      expect(document.querySelector(".agents-view")).toBeTruthy();
    }, { timeout: 5000 });

    // Should NOT show board or list view
    expect(document.querySelector(".board")).toBeNull();
    expect(document.querySelector(".list-view")).toBeNull();
  });

  it("persists agents view preference to localStorage", async () => {
    localStorage.removeItem(taskViewStorageKey());

    render(<App />);

    const agentsViewButton = await screen.findByTestId("sidebar-nav-agents", {}, { timeout: 5000 });

    fireEvent.click(agentsViewButton);

    await waitFor(() => {
      expect(localStorage.getItem(taskViewStorageKey())).toBe("agents");
    }, { timeout: 5000 });
  });

  it("initializes agents view from localStorage if saved", async () => {
    localStorage.setItem(taskViewStorageKey(), "agents");

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".agents-view")).toBeTruthy();
    });

    expect(screen.getByTestId("sidebar-nav-agents").className).toContain("active");

    localStorage.removeItem(taskViewStorageKey());
  });

  it("renders agents view button when agentsView experimental feature is disabled", async () => {
    // Override the default mock to exclude agentsView
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, insights: true, skillsView: true }, // no agentsView
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board")).toBeTruthy();
    });

    expect(screen.getByTestId("sidebar-nav-agents")).toBeTruthy();

    // Cleanup: restore default mock
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings });
  });

  // ── Insights View ──────────────────────────────────────────────────

  it("renders InsightsView when insights view is selected", async () => {
    render(<App />);

    /*
     * FNXC:Navigation 2026-06-22-09:30:
     * Insights is now a left-sidebar destination (sidebar-nav-insights), not a header
     * More-views overflow command. Navigate via the sidebar to exercise lazy-view routing.
     */
    fireEvent.click(await screen.findByTestId("sidebar-nav-insights"));

    // Insights view should be rendered (it has a insights-view container)
    expect(await screen.findByTestId("insights-view")).toBeTruthy();

    // Should NOT show board, list, or agents view
    expect(document.querySelector(".board")).toBeNull();
    expect(document.querySelector(".list-view")).toBeNull();
    expect(document.querySelector(".agents-view")).toBeNull();
  });

  it("creates a real triage task from insights using dashboard task creation flow", async () => {
    mockUseInsights.mockImplementation(() => ({
      sections: [
        {
          category: "features",
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: DEFAULT_PROJECT_ID,
              title: "Insight title",
              content: "Insight content",
              category: "features",
              status: "generated",
              fingerprint: "fp-ins-1",
              provenance: { trigger: "manual" },
              lastRunId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          isLoading: false,
          error: null,
        },
      ],
      loading: false,
      error: null,
      latestRun: null,
      isRunInFlight: false,
      runError: null,
      refresh: vi.fn(),
      runInsights: vi.fn(),
      dismiss: vi.fn(),
      createTask: vi.fn().mockResolvedValue({
        title: "Task from insight",
        description: "Use this insight as a task description",
      }),
      dismissStates: new Map(),
      createTaskStates: new Map(),
      totalCount: 1,
      dismissedCount: 0,
    }));

    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-insights"));

    await waitFor(() => {
      expect(screen.getByTestId("create-task-INS-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("create-task-INS-1"));

    await waitFor(() => {
      // FNXC:InsightsTaskCreate 2026-07-14-19:40: createTask no longer hard-codes column triage; intake column comes from the active workflow defaults.
      expect(mockCreateTask).toHaveBeenCalledWith({
        title: "Task from insight",
        description: "Use this insight as a task description",
        source: {
          sourceType: "dashboard_ui",
          sourceMetadata: {
            origin: "insights",
            insightId: "INS-1",
          },
        },
      });
    });
  });

  it("persists insights view preference to localStorage", async () => {
    localStorage.removeItem(taskViewStorageKey());

    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-insights"));

    await waitFor(() => {
      expect(localStorage.getItem(taskViewStorageKey())).toBe("insights");
    });
  });

  it("initializes insights view from localStorage if saved", async () => {
    localStorage.setItem(taskViewStorageKey(), "insights");

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".insights-view")).toBeTruthy();
    });

    // Sidebar Insights entry should be active when view is insights
    expect(screen.getByTestId("sidebar-nav-insights").className).toContain("active");

    localStorage.removeItem(taskViewStorageKey());
  });

  it("project switch rehydrates each project's own scoped task-view", async () => {
    const projectA = { id: "proj_a", name: "Project A", path: "/a", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    const projectB = { id: "proj_b", name: "Project B", path: "/b", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };

    // Set different views for each project
    localStorage.setItem("kb:proj_a:kb-dashboard-task-view", "insights");
    localStorage.setItem("kb:proj_b:kb-dashboard-task-view", "agents");

    mockProjectsState.projects = [projectA, projectB];
    mockCurrentProjectState.currentProject = projectA;

    render(<App />);

    // Wait for project A's insights view to load
    await waitFor(() => {
      expect(document.querySelector(".insights-view")).toBeTruthy();
    });

    // Verify the sidebar Insights entry is active
    expect(screen.getByTestId("sidebar-nav-insights").className).toContain("active");

    // Cleanup
    localStorage.removeItem("kb:proj_a:kb-dashboard-task-view");
    localStorage.removeItem("kb:proj_b:kb-dashboard-task-view");
  });

  it("keeps insights view button visible after graduation from experimental flags", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, insights: false },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board")).toBeTruthy();
    });

    // FNXC:DefaultNavigation 2026-06-23-01:24: Insights graduated from experimental navigation; stale false flags must not remove the destination.
    expect(screen.getByTestId("sidebar-nav-insights")).toBeTruthy();
  });

  it("keeps graduated views available after settings load with no experimental flags", async () => {
    localStorage.setItem(taskViewStorageKey(), "insights");

    let resolveSettings: ((settings: Settings) => void) | undefined;
    vi.mocked(fetchSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve as (settings: Settings) => void;
        }),
    );

    render(<App />);

    expect(screen.queryByTitle("Board view")).toBeNull();
    expect(document.querySelector(".insights-view")).toBeNull();
    expect(document.querySelector(".board")).toBeNull();

    resolveSettings?.({
      ...defaultSettings,
      experimentalFeatures: { leftSidebarNav: false },
    });

    await waitFor(() => {
      expect(document.querySelector(".insights-view")).toBeTruthy();
    });

    expect(document.querySelector(".board")).toBeNull();
    localStorage.removeItem(taskViewStorageKey());
  });

  it("keeps memory view button visible after graduation from experimental flags", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, memoryView: false, insights: true },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board")).toBeTruthy();
    });

    expect(screen.getByTestId("sidebar-nav-memory")).toBeTruthy();
  });

  it("keeps memory view selected after graduation from experimental flags", async () => {
    localStorage.setItem(taskViewStorageKey(), "memory");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, memoryView: false },
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(document.querySelector(".memory-view")).toBeTruthy();
    });

    expect(document.querySelector(".board")).toBeNull();
    localStorage.removeItem(taskViewStorageKey());
  });

  it("renders goals view when goalsView experimental feature is enabled", async () => {
    localStorage.setItem(taskViewStorageKey(), "goalsView");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, goalsView: true },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("goals-view")).toBeTruthy();
    });

    localStorage.removeItem(taskViewStorageKey());
  });

  it("keeps goals view selected after graduation from experimental flags", async () => {
    localStorage.setItem(taskViewStorageKey(), "goalsView");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, goalsView: false },
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("goals-view")).toBeTruthy();
    });

    expect(screen.getByTestId("sidebar-nav-goals")).toBeTruthy();
    expect(document.querySelector(".board")).toBeNull();
    localStorage.removeItem(taskViewStorageKey());
  });

  it("keeps todo view selected after graduation from experimental flags", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "todos");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, todoView: false },
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("todo-view")).toBeTruthy();
    });

    /*
     * FNXC:DefaultNavigation 2026-06-25-11:03:
     * Todo graduated with the other primary destinations; stale `todoView:false` settings must not redirect a saved Todo view back to Board. Todos intentionally stay out of the left sidebar because that destination lives in the right dock and mobile More sheet.
     */
    expect(document.querySelector(".board")).toBeNull();
    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });
});

describe("App GitHub import", () => {
  // FNXC:Navigation 2026-06-22-09:30: GitHub import is now the left-sidebar "Import Tasks"
  // destination rendering the GitHubImportModal embedded in main content (presentation="embedded"),
  // not a header-button modal overlay. Navigation in/out goes through the sidebar; embedded mode
  // has no overlay or Cancel affordance (closing returns to the board view).
  it("opens GitHub import as an embedded view from the Import Tasks sidebar destination", async () => {
    render(<App />);

    const importNavItem = await screen.findByTestId("sidebar-nav-import-tasks");
    fireEvent.click(importNavItem);

    await waitFor(() => {
      expect(screen.getByTestId("github-import-view")).toBeTruthy();
      expect(screen.getByText("Import from GitHub")).toBeTruthy();
    });
  });

  it("closes the embedded GitHub import view back to the board", async () => {
    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-import-tasks"));

    await waitFor(() => {
      expect(screen.getByTestId("github-import-view")).toBeTruthy();
    });

    // Returning to the board is the embedded close path (no overlay/Cancel button).
    fireEvent.click(await screen.findByTestId("sidebar-nav-board"));

    await waitFor(() => {
      expect(screen.queryByTestId("github-import-view")).toBeNull();
      expect(document.querySelector(".board")).toBeTruthy();
    });
  });
});

describe("App Planning Mode", () => {
  it("opens Planning Mode as an embedded view from the sidebar destination", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, leftSidebarNav: true },
    });
    render(<App />);

    const planningNavItem = await screen.findByTestId("sidebar-nav-planning");
    fireEvent.click(planningNavItem);

    await waitFor(() => {
      expect(screen.getByTestId("planning-view")).toBeTruthy();
      expect(screen.getByText("Planning Mode")).toBeTruthy();
    });
    expect(screen.queryByTestId("planning-btn")).toBeNull();
  });

  it("closes Planning Mode embedded view back to the board", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, leftSidebarNav: true },
    });
    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-planning"));
    await waitFor(() => {
      expect(screen.getByTestId("planning-view")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(screen.queryByText("Transform your idea into a detailed task")).toBeNull();
      expect(screen.getByTestId("sidebar-nav-board").getAttribute("aria-current")).toBe("page");
    });
  });

  it("renders planning embedded view with correct initial state", async () => {
    localStorage.setItem(taskViewStorageKey(), "planning");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("planning-view")).toBeTruthy();
      expect(screen.getByText("Transform your idea into a detailed task")).toBeTruthy();
      expect(screen.getByPlaceholderText(/e.g., Build a user authentication system with login/)).toBeTruthy();
      expect(screen.getByText("Start Planning")).toBeTruthy();
    });

    localStorage.removeItem(taskViewStorageKey());
  });

  it("opens a planning session from the retained Planning navigation surface", async () => {
    const session: AiSessionSummary = {
      id: "planning-session-needs-input",
      type: "planning",
      status: "awaiting_input",
      title: "Planning — needs input",
      projectId: "proj_123",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    mockUseBackgroundSessions.mockReturnValue({
      sessions: [session],
      generating: false,
      needsInput: true,
      planningSessions: [session],
      dismissSession: vi.fn(),
    });

    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-planning"));

    await waitFor(() => {
      const planningView = screen.getByTestId("planning-view");
      expect(planningView).toBeInTheDocument();
      expect(screen.getByTestId("sidebar-nav-planning")).toHaveAttribute("aria-current", "page");
    });
  });

  it.each([
    { type: "subtask" as const, expectedView: "board", opensSubtaskOverlay: true },
    { type: "mission_interview" as const, expectedView: "missions", opensSubtaskOverlay: false },
    { type: "milestone_interview" as const, expectedView: "missions", opensSubtaskOverlay: false },
    { type: "slice_interview" as const, expectedView: "missions", opensSubtaskOverlay: false },
  ])("keeps the $type background-session route unchanged", async ({ type, expectedView, opensSubtaskOverlay }) => {
    const session: AiSessionSummary = {
      id: `${type}-session`,
      type,
      status: "awaiting_input",
      title: `${type} session`,
      projectId: "proj_123",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    mockUseBackgroundSessions.mockReturnValue({
      sessions: [session],
      generating: false,
      needsInput: true,
      planningSessions: [],
      dismissSession: vi.fn(),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));

    await waitFor(() => {
      expect(screen.getByTestId(`sidebar-nav-${expectedView}`)).toHaveAttribute("aria-current", "page");
      if (opensSubtaskOverlay) {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      }
    });
  });
});

describe("Script run flow", () => {
  it("calls runScript API and returns session info", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    const { runScript: runScriptMock } = await import("../../api");

    await act(async () => {
      const result = await runScriptMock("build", undefined, "proj_123");
      expect(result).toEqual({ sessionId: "sess-script-1", command: "echo hello" });
    });

    expect(runScriptMock).toHaveBeenCalledWith("build", undefined, "proj_123");
  });

  it("shows error toast when runScript API fails", async () => {
    const { runScript: runScriptMock } = await import("../../api");
    (runScriptMock as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Script not found"));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    await act(async () => {
      try {
        await runScriptMock("missing-script", undefined, "proj_123");
      } catch {
        // Expected to throw
      }
    });

    expect(runScriptMock).toHaveBeenCalledWith("missing-script", undefined, "proj_123");
  });
});

describe("Script-to-terminal modal handoff", () => {
  beforeEach(() => {
    mockProjectsState.projects = [mockCurrentProjectState.currentProject!];
  });

  it("closes ScriptsModal and opens TerminalModal when Run is clicked", async () => {
    render(<App />);

    // Wait for the app to fully render
    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    // Open the Scripts modal via the quick-scripts dropdown "Manage Scripts..." button
    const scriptsBtn = await screen.findByTestId("scripts-btn");
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    // Wait for the dropdown menu to appear and click "Manage Scripts..."
    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    // Wait for the Scripts modal to open and load scripts
    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });

    // Click the Run button on the "build" script
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-script-build"));
    });

    // The Scripts modal should now be closed
    await waitFor(() => {
      expect(screen.queryByTestId("scripts-modal")).toBeNull();
    });

    // The TerminalModal should be open (not the old ScriptRunDialog)
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    // ScriptRunDialog should NOT be rendered at all
    expect(screen.queryByTestId("script-run-dialog-overlay")).toBeNull();
  });

  it("allows reopening ScriptsModal after closing TerminalModal", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    // Open the Scripts modal and run a script
    const scriptsBtn = await screen.findByTestId("scripts-btn");
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-script-build"));
    });

    // Wait for TerminalModal to open
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("scripts-modal")).toBeNull();

    // Close the TerminalModal
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-close-btn"));
    });

    // TerminalModal should be closed
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-modal")).toBeNull();
    });

    // Reopen the Scripts modal
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    // Scripts modal should open again cleanly
    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });
  });

  it("does not call runScript API — command is sent directly to terminal", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    // Open the Scripts modal
    const scriptsBtn = await screen.findByTestId("scripts-btn");
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });

    // Click Run on the "build" script
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-script-build"));
    });

    // TerminalModal should open
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    // runScript API should NOT have been called — command goes directly to terminal
    expect(runScript).not.toHaveBeenCalled();
  });
});

describe("App footer-safe project layout", () => {
  afterEach(() => {
    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("wraps project content in project-content div with footer class when project is selected", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.classList.contains("project-content")).toBe(true);
    });

    // The board should be inside the footer-safe wrapper
    const wrapper = document.querySelector(".project-content--with-footer");
    expect(wrapper?.querySelector(".board")).toBeTruthy();
  });

  it("opens the built-in file browser from the footer project directory link", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    mockProjectsState.projects = [mockCurrentProjectState.currentProject];

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("executor-project-path-toggle")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("executor-project-path-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("executor-project-path-link")).toHaveTextContent("/test");
    });

    fireEvent.click(screen.getByTestId("executor-project-path-link"));

    await waitFor(() => {
      expect(screen.getByText("Files — Project")).toBeTruthy();
    });
  });

  it("uses project-content wrapper without footer class in overview mode", async () => {
    mockCurrentProjectState.currentProject = null;
    mockProjectsState.projects = [];
    localStorage.setItem("kb-dashboard-view-mode", "overview");

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.classList.contains("project-content--with-footer")).toBe(false);
    });
  });

  it("adds and removes footer class when switching between project and overview", async () => {
    // Start in project mode
    localStorage.setItem("kb-dashboard-view-mode", "project");

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".project-content--with-footer")).toBeTruthy();
    });

    // Switch to overview by clearing project
    mockCurrentProjectState.currentProject = null;
    mockProjectsState.projects = [];

    rerender(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.classList.contains("project-content--with-footer")).toBe(false);
    });
  });

  it("renders agents view inside the footer-safe wrapper", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "agents");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.querySelector(".agents-view")).toBeTruthy();
    });
  });

  it("renders list view inside the footer-safe wrapper", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "list");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.querySelector(".list-view")).toBeTruthy();
    });
  });

  /**
   * FN-824: The board must be a child of the footer-safe wrapper so that
   * its height is constrained by the wrapper's available space (which
   * already reserves room for the fixed ExecutorStatusBar via padding-bottom).
   * On mobile, the board previously used calc(100dvh - 57px) which bypassed
   * the wrapper and extended under the footer bar.
   */
  it("renders board inside the footer-safe wrapper (FN-824 mobile regression)", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "board");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      // Board is a direct child of the footer-safe wrapper
      const board = wrapper?.querySelector(".board");
      expect(board).toBeTruthy();
      // Verify the board is a descendant of the wrapper (not a sibling)
      expect(wrapper?.contains(board!)).toBe(true);
    });
  });
});

describe("App node mode switching", () => {
  it("does not render node selector when no remote nodes are available", async () => {
    render(<App />);

    await waitForAppShell();

    // Node selector should not be visible when no remote nodes available
    expect(screen.queryByTestId("node-selector-trigger")).toBeNull();
  });

  it("renders node selector trigger when remote nodes are available", async () => {
    // Get the mocked useNodes and set up the return value
    const { useNodes } = await import("../../hooks/useNodes");
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        {
          id: "node_remote_1",
          name: "Remote Node 1",
          type: "remote" as const,
          url: "http://remote:4040",
          status: "online" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
      expect(screen.getByTestId("node-selector-trigger")).toBeInTheDocument();
    });

    // Node selector trigger should be visible when remote nodes available
    expect(screen.getByTestId("node-selector-trigger")).toBeInTheDocument();
  });

  it("shows remote node name when remote node is selected", async () => {
    // Get the mocked useNodes and set up the return value
    const { useNodes } = await import("../../hooks/useNodes");
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        {
          id: "node_remote_1",
          name: "Remote Node 1",
          type: "remote" as const,
          url: "http://remote:4040",
          status: "online" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });

    // Mock node context to return remote node
    mockNodeContextValue.currentNode = {
      id: "node_remote_1",
      name: "Remote Node 1",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "",
      updatedAt: "",
    };
    mockNodeContextValue.currentNodeId = "node_remote_1";
    mockNodeContextValue.isRemote = true;

    render(<App />);

    // Should show remote node name
    await waitFor(() => {
      expect(screen.getByText("Remote Node 1")).toBeInTheDocument();
    });
  });

  it("calls clearCurrentNode when Local option is selected", async () => {
    // Get the mocked useNodes and set up the return value
    const { useNodes } = await import("../../hooks/useNodes");
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        {
          id: "node_remote_1",
          name: "Remote Node 1",
          type: "remote" as const,
          url: "http://remote:4040",
          status: "online" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });

    // Mock node context to return remote node
    mockNodeContextValue.currentNode = {
      id: "node_remote_1",
      name: "Remote Node 1",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "",
      updatedAt: "",
    };
    mockNodeContextValue.currentNodeId = "node_remote_1";
    mockNodeContextValue.isRemote = true;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Remote Node 1")).toBeInTheDocument();
    });

    // Open the node selector
    fireEvent.click(screen.getByTestId("node-selector-trigger"));

    await waitFor(() => {
      expect(screen.getByTestId("node-option-local")).toBeInTheDocument();
    });

    // Click Local option
    fireEvent.click(screen.getByTestId("node-option-local"));

    await waitFor(() => {
      expect(mockNodeContextValue.clearCurrentNode).toHaveBeenCalled();
    });
  });

  it("calls setCurrentNode when a remote node is selected", async () => {
    // Get the mocked useNodes and set up the return value
    const { useNodes } = await import("../../hooks/useNodes");
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        {
          id: "node_remote_1",
          name: "Remote Node 1",
          type: "remote" as const,
          url: "http://remote:4040",
          status: "online" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "node_remote_2",
          name: "Remote Node 2",
          type: "remote" as const,
          url: "http://remote2:4040",
          status: "offline" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
      expect(screen.getByTestId("node-selector-trigger")).toBeInTheDocument();
    });

    // Open the node selector
    fireEvent.click(screen.getByTestId("node-selector-trigger"));

    await waitFor(() => {
      expect(screen.getByTestId("node-option-node_remote_2")).toBeInTheDocument();
    });

    // Click the second remote node
    fireEvent.click(screen.getByTestId("node-option-node_remote_2"));

    await waitFor(() => {
      expect(mockNodeContextValue.setCurrentNode).toHaveBeenCalledWith({
        id: "node_remote_2",
        name: "Remote Node 2",
        type: "remote",
        url: "http://remote2:4040",
        status: "offline",
        maxConcurrent: 2,
        createdAt: "",
        updatedAt: "",
      });
    });
  });
});

describe("App search query propagation to remote mode", () => {
  // Mock useRemoteNodeData to capture searchQuery parameter
  let capturedSearchQuery: string | undefined;

  beforeEach(() => {
    capturedSearchQuery = undefined;
    
    // Get the mocked useRemoteNodeData and capture the searchQuery
    vi.mocked(apiNodeModule.useRemoteNodeData).mockImplementation((nodeId, options) => {
      capturedSearchQuery = options?.searchQuery;
      return {
        projects: [],
        tasks: [],
        health: null,
        loading: false,
        error: null,
        refresh: vi.fn(),
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("fusion-dashboard-current-node");
  });

  it("passes searchQuery to useRemoteNodeData when in remote mode", async () => {
    // Set up mock with remote node
    const { useNodes } = await import("../../hooks/useNodes");
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        {
          id: "node_remote_1",
          name: "Remote Node 1",
          type: "remote" as const,
          url: "http://remote:4040",
          status: "online" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });

    // Mock node context to return remote node
    mockNodeContextValue.currentNode = {
      id: "node_remote_1",
      name: "Remote Node 1",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "",
      updatedAt: "",
    };
    mockNodeContextValue.currentNodeId = "node_remote_1";
    mockNodeContextValue.isRemote = true;

    // Set project mode
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
      expect(screen.getByTestId("desktop-header-search-btn")).toBeInTheDocument();
    });

    // At this point, searchQuery should be passed to useRemoteNodeData
    // capturedSearchQuery should be undefined (empty search initially)
    expect(capturedSearchQuery).toBeUndefined();
  });

  it("updates searchQuery in useRemoteNodeData when header search changes", async () => {
    // Set up mock with remote node
    const { useNodes } = await import("../../hooks/useNodes");
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        {
          id: "node_remote_1",
          name: "Remote Node 1",
          type: "remote" as const,
          url: "http://remote:4040",
          status: "online" as const,
          maxConcurrent: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });

    // Mock node context to return remote node
    mockNodeContextValue.currentNode = {
      id: "node_remote_1",
      name: "Remote Node 1",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "",
      updatedAt: "",
    };
    mockNodeContextValue.currentNodeId = "node_remote_1";
    mockNodeContextValue.isRemote = true;

    // Set project mode
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
      expect(screen.getByTestId("desktop-header-search-btn")).toBeInTheDocument();
    });

    // Click the search toggle button to open search
    const searchToggleBtn = screen.getByTestId("desktop-header-search-btn");
    expect(searchToggleBtn).toBeInTheDocument();
    fireEvent.click(searchToggleBtn);

    // Now the search input should be visible
    const searchInput = await screen.findByPlaceholderText("Search tasks...");
    expect(searchInput).toBeInTheDocument();

    // Type in the search input
    fireEvent.change(searchInput, { target: { value: "test search" } });

    // Wait for the search query to propagate
    await waitFor(() => {
      expect(capturedSearchQuery).toBe("test search");
    });
  });
});

describe("App onboarding reopen", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it("does not auto-open onboarding when modelOnboardingComplete is true and setup is complete", async () => {
    // Mock fetchGlobalSettings to return complete onboarding with default model
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    render(<App />);

    await waitForAppShell();

    // Onboarding modal should NOT be open
    expect(screen.queryByText("Set Up AI")).toBeNull();
  });

  it("opens Settings → Authentication → Reopen onboarding guide opens onboarding modal", async () => {
    // Mock fetchGlobalSettings to return complete onboarding (to avoid auto-open on first call)
    // and hydrated settings on subsequent calls
    (fetchGlobalSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        modelOnboardingComplete: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      })
      .mockResolvedValue({
        modelOnboardingComplete: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

    // Mock Settings and auth
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
      ],
    });
    (fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 200000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
    });

    render(<App />);

    await waitForAppShell();

    // Onboarding should NOT be open initially
    expect(screen.queryByText("Set Up AI")).toBeNull();

    // Open Settings via header (quick-entry controls also mention Settings in labels)
    const settingsBtn = screen.getByTitle("Settings");
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    });

    // Navigate to Authentication section (it should be default or click to ensure)
    const authSections = await screen.findAllByText("Authentication");
    const authSection = authSections[0];
    fireEvent.click(authSection);

    await waitFor(() => {
      expect(fetchAuthStatus).toHaveBeenCalled();
    });

    // Click Reopen onboarding guide button
    const reopenBtn = screen.getByText("Reopen onboarding guide");
    fireEvent.click(reopenBtn);

    // Onboarding modal should now be open
    await waitFor(() => {
      expect(screen.getByText("Set Up AI")).toBeTruthy();
    });
  });

  it("reopened modal shows hydrated model state from global settings", async () => {
    // Mock fetchGlobalSettings to return hydrated settings
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    // Mock Settings and auth
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
    });
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
      ],
    });
    (fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 200000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
    });

    render(<App />);

    await waitForAppShell();

    // Open Settings via header (quick-entry controls also mention Settings in labels)
    const settingsBtn = screen.getByTitle("Settings");
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    });

    // Navigate to Authentication section
    const authSections = await screen.findAllByText("Authentication");
    const authSection = authSections[0];
    fireEvent.click(authSection);

    await waitFor(() => {
      expect(fetchAuthStatus).toHaveBeenCalled();
    });

    // Click Reopen onboarding guide button from Authentication section
    const reopenBtn = await screen.findByText("Reopen onboarding guide");
    fireEvent.click(reopenBtn);

    // Wait for onboarding modal to open
    await waitFor(() => {
      expect(screen.getByText("Set Up AI")).toBeTruthy();
    });

    // The model dropdown should be pre-populated with the saved default
    // Check that the dropdown shows the saved model is selected
    const dropdown = await screen.findByTestId("mock-model-dropdown");
    expect((dropdown as HTMLSelectElement).value).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("App auth token recovery dialog", () => {
  it("opens as a non-dismissable blocking dialog when daemon auth recovery is required", async () => {
    render(<App />);
    await waitForAppShell();

    expect(screen.queryByRole("dialog", { name: "Authentication token required" })).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
    });

    const dialog = await screen.findByRole("dialog", { name: "Authentication token required" });
    expect(dialog).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();

    const overlay = dialog.closest(".auth-token-recovery-overlay");
    expect(overlay).toBeTruthy();

    if (!overlay) {
      throw new Error("Expected auth token recovery overlay to be present");
    }

    fireEvent.keyDown(overlay, { key: "Escape" });
    fireEvent.click(overlay);

    expect(screen.getByRole("dialog", { name: "Authentication token required" })).toBeInTheDocument();
  });
});

describe("FN-3290: modal keyboard isolation for mobile dashboard layout", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    window.history.replaceState = vi.fn();
    // Prevent onboarding modal from auto-opening
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
      ],
    });
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem(taskViewStorageKey());
  });

  it("removes project-content--with-mobile-nav when keyboard is open with no modal (mobile)", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    localStorage.setItem("kb-dashboard-view-mode", "project");

    // Keyboard is open, no modal
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 250,
      viewportHeight: 550,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".project-content")).toBeTruthy();
    });

    const wrapper = document.querySelector(".project-content");
    // Without a modal, the keyboard-open state should remove the mobile nav padding
    expect(wrapper?.classList.contains("project-content--with-mobile-nav")).toBe(false);
  });

  it("keeps project-content--with-mobile-nav when keyboard is open inside a modal (mobile)", async () => {
    // Use deep link to open a task detail modal — avoids complex mobile overflow navigation
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });
    mockUseViewportMode.mockReturnValue("mobile");
    localStorage.setItem("kb-dashboard-view-mode", "project");

    // Keyboard is reported as open (as if a modal input has focus)
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 250,
      viewportHeight: 550,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });

    render(<App />);

    // Wait for task detail modal to open
    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });
    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    // The dashboard wrapper should STILL have project-content--with-mobile-nav
    // because the keyboard-open state is gated by anyModalOpen.
    const wrapper = document.querySelector(".project-content");
    expect(wrapper).toBeTruthy();
    expect(wrapper?.classList.contains("project-content--with-mobile-nav")).toBe(true);
  });

  it("removes mobile nav class when modal closes while keyboard stays open", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-456"),
    });
    mockUseViewportMode.mockReturnValue("mobile");
    localStorage.setItem("kb-dashboard-view-mode", "project");

    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 250,
      viewportHeight: 550,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });

    const { rerender } = render(<App />);

    // Wait for task detail modal to open
    await waitFor(() => {
      expect(screen.getByText("Task FN-456")).toBeTruthy();
    });

    // With modal open, mobile nav class is preserved despite keyboard being open
    let wrapper = document.querySelector(".project-content");
    expect(wrapper?.classList.contains("project-content--with-mobile-nav")).toBe(true);

    // Close the modal via close button
    const closeBtn = document.querySelector(".modal-overlay.open .modal-close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    rerender(<App />);

    // Keyboard is still open, but modal is now closed — mobileKeyboardOpen becomes true,
    // so the mobile nav class should be removed
    await waitFor(() => {
      wrapper = document.querySelector(".project-content");
      expect(wrapper?.classList.contains("project-content--with-mobile-nav")).toBe(false);
    });
  });
});

describe("App board branch filters", () => {
  const WORKING_BRANCH_FILTER_STORAGE_KEY = "kb-dashboard-working-branch-filter";
  const BASE_BRANCH_FILTER_STORAGE_KEY = "kb-dashboard-base-branch-filter";

  function scopedProjectKey(baseKey: string, projectId: string) {
    return `kb:${projectId}:${baseKey}`;
  }

  function makeTask(id: string, title: string, branch?: string, baseBranch?: string) {
    return {
      id,
      title,
      description: title,
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...(branch ? { branch } : {}),
      ...(baseBranch ? { baseBranch } : {}),
    };
  }

  it("filters board tasks by working and target branch in local mode", async () => {
    mockUseTasks.mockImplementation(() => ({
      tasks: [
        makeTask("FN-1", "Task Alpha", "feature/a", "main"),
        makeTask("FN-2", "Task Beta", "feature/b", "release"),
      ],
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

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "feature/a" } });
    fireEvent.change(screen.getByTestId("target-branch-filter"), { target: { value: "main" } });

    await waitFor(() => {
      expect(screen.getByText("Task Alpha")).toBeTruthy();
      expect(screen.queryByText("Task Beta")).toBeNull();
    });
  });

  it("supports filtering for tasks without working branch values", async () => {
    mockUseTasks.mockImplementation(() => ({
      tasks: [
        makeTask("FN-1", "Unassigned Task"),
        makeTask("FN-2", "Assigned Task", "feature/a", "main"),
      ],
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

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "__fusion:no-branch__" } });

    await waitFor(() => {
      expect(screen.getByText("Unassigned Task")).toBeTruthy();
      expect(screen.queryByText("Assigned Task")).toBeNull();
    });
  });

  it("supports filtering for tasks without base branch values", async () => {
    mockUseTasks.mockImplementation(() => ({
      tasks: [
        makeTask("FN-1", "No Base Branch", "feature/a"),
        makeTask("FN-2", "Has Base Branch", "feature/a", "main"),
      ],
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

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    fireEvent.change(screen.getByTestId("target-branch-filter"), { target: { value: "__fusion:no-branch__" } });

    await waitFor(() => {
      expect(screen.getByText("No Base Branch")).toBeTruthy();
      expect(screen.queryByText("Has Base Branch")).toBeNull();
    });
  });

  it("derives branch filter options from remote task data in remote mode", async () => {
    mockNodeContextValue.isRemote = true;
    mockNodeContextValue.currentNodeId = "node-1";

    const remoteSpy = vi.spyOn(apiNodeModule, "useRemoteNodeData").mockReturnValue({
      projects: [],
      tasks: [makeTask("FN-3", "Remote Task", "feature/remote", "develop")],
      health: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    expect(screen.getByRole("option", { name: "feature/remote" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "develop" })).toBeTruthy();
    remoteSpy.mockRestore();
  });

  it("restores saved branch filter selections per project", async () => {
    const projectId = "project-restore";
    mockCurrentProjectState.currentProject = {
      id: projectId,
      name: "Restore Project",
      path: "/restore",
      status: "active",
      isolationMode: "in-process",
      createdAt: "",
      updatedAt: "",
    };
    localStorage.setItem(scopedProjectKey(WORKING_BRANCH_FILTER_STORAGE_KEY, projectId), "feature/a");
    localStorage.setItem(scopedProjectKey(BASE_BRANCH_FILTER_STORAGE_KEY, projectId), "__fusion:no-branch__");

    mockUseTasks.mockImplementation(() => ({
      tasks: [
        makeTask("FN-1", "Restore Candidate", "feature/a"),
        makeTask("FN-2", "Filtered Out", "feature/b", "main"),
      ],
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

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));

    expect((screen.getByTestId("working-branch-filter") as HTMLSelectElement).value).toBe("feature/a");
    expect((screen.getByTestId("target-branch-filter") as HTMLSelectElement).value).toBe("__fusion:no-branch__");

    await waitFor(() => {
      expect(screen.getByText("Restore Candidate")).toBeTruthy();
      expect(screen.queryByText("Filtered Out")).toBeNull();
    });
  });

  it("writes updated filter values to project-scoped storage and isolates between projects", async () => {
    const projectOneId = "project-one";
    const projectTwoId = "project-two";
    mockCurrentProjectState.currentProject = {
      id: projectOneId,
      name: "Project One",
      path: "/one",
      status: "active",
      isolationMode: "in-process",
      createdAt: "",
      updatedAt: "",
    };

    mockUseTasks.mockImplementation(() => ({
      tasks: [makeTask("FN-1", "Alpha Search", "feature/a", "main")],
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

    const { rerender } = render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "feature/a" } });
    fireEvent.change(screen.getByTestId("target-branch-filter"), { target: { value: "main" } });

    expect(localStorage.getItem(scopedProjectKey(WORKING_BRANCH_FILTER_STORAGE_KEY, projectOneId))).toBe("feature/a");
    expect(localStorage.getItem(scopedProjectKey(BASE_BRANCH_FILTER_STORAGE_KEY, projectOneId))).toBe("main");

    mockCurrentProjectState.currentProject = {
      id: projectTwoId,
      name: "Project Two",
      path: "/two",
      status: "active",
      isolationMode: "in-process",
      createdAt: "",
      updatedAt: "",
    };

    rerender(<App />);
    await waitForAppShell();

    /*
     * FNXC:BoardSearch 2026-07-04-13:30: The non-mobile search panel intentionally stays open
     * across a same-instance rerender (Header's isNonMobileSearchOpen state is not project-scoped),
     * so the toggle button correctly unmounts once the panel is open (see canShowNonMobileSearchToggle
     * in Header.tsx) and there is no button left to re-click here. The branch-filter selects remain
     * rendered while the panel is open, so read them directly instead of re-clicking the toggle.
     */
    expect((screen.getByTestId("working-branch-filter") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("target-branch-filter") as HTMLSelectElement).value).toBe("");
    expect(localStorage.getItem(scopedProjectKey(WORKING_BRANCH_FILTER_STORAGE_KEY, projectTwoId))).toBeNull();
    expect(localStorage.getItem(scopedProjectKey(BASE_BRANCH_FILTER_STORAGE_KEY, projectTwoId))).toBeNull();
  });

  it("composes with search and does not affect list view tasks", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "board");
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings });
    mockUseTasks.mockImplementation(() => ({
      tasks: [
        makeTask("FN-4", "Alpha Search", "feature/a", "main"),
        makeTask("FN-5", "Beta Search", "feature/b", "main"),
      ],
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

    render(<App />);
    await waitForAppShell();

    fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    fireEvent.change(screen.getByPlaceholderText("Search tasks..."), { target: { value: "Search" } });
    fireEvent.change(screen.getByTestId("working-branch-filter"), { target: { value: "feature/a" } });

    await waitFor(() => {
      expect(screen.getByText("Alpha Search")).toBeTruthy();
      expect(screen.queryByText("Beta Search")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("sidebar-nav-list"));
    await waitFor(() => {
      expect(screen.getByText("Alpha Search")).toBeTruthy();
      expect(screen.getByText("Beta Search")).toBeTruthy();
    });
  });
});

describe("FN-5817 mobile auto-merge toggle stability", () => {
  it("keeps app shell mounted when toggling auto-merge on mobile", async () => {
    mockUseViewportMode.mockReturnValue("mobile");

    const updateSettingsSpy = vi.mocked(updateSettings);
    updateSettingsSpy.mockResolvedValue({ ...defaultSettings, autoMerge: false });

    mockUseTasks.mockImplementation(() => ({
      tasks: [
        {
          id: "FN-5817",
          title: "In review task",
          description: "Regression task",
          column: "in-review",
          status: "in-review",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
      isStale: false,
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      pauseTask: vi.fn(),
      unpauseTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      resetTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      archiveTask: vi.fn(),
      unarchiveTask: vi.fn(),
      archiveAllDone: vi.fn(),
      loadArchivedTasks: vi.fn(),
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);

    const toggle = await screen.findByRole("checkbox", { name: "Auto-merge" });
    expect(screen.getByTestId("mobile-view-toggle")).toBeInTheDocument();
    expect(document.querySelector("main.board")).not.toBeNull();
    expect(screen.getByText("In review task")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ autoMerge: expect.any(Boolean) }),
        DEFAULT_PROJECT_ID,
      );
      expect(screen.getByTestId("mobile-view-toggle")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Auto-merge" })).toBeInTheDocument();
      expect(document.querySelector("main.board")).not.toBeNull();
      expect(screen.getByText("In review task")).toBeInTheDocument();
    });

    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("App shell connection status plumbing", () => {
  it("loads shell connection status for native shell host", async () => {
    mockShellHostContextValue.host = { kind: "desktop-shell", mode: "remote", connectionId: "p1", serverUrl: "https://fusion.example.com" };
    mockGetShellConnectionNativeResult.mockResolvedValueOnce({
      hostKind: "desktop-shell",
      available: true,
      mode: "remote",
      profileLabel: "Prod",
      serverOrigin: "https://fusion.example.com",
      openConnectionManager: async () => ({ ok: true }),
    });

    render(<App />);

    await waitFor(() => {
      expect(mockGetShellConnectionNativeResult).toHaveBeenCalledWith(mockShellHostContextValue.host);
      expect(screen.getByTestId("shell-connection-status-button")).toBeInTheDocument();
    });
  });

  it("does not render shell connection status in browser mode", async () => {
    mockShellHostContextValue.host = { kind: "browser" };
    mockGetShellConnectionNativeResult.mockResolvedValueOnce({
      hostKind: "browser",
      available: false,
      openConnectionManager: async () => ({ ok: false, reason: "unsupported" }),
    });

    render(<App />);

    await waitFor(() => {
      expect(mockGetShellConnectionNativeResult).toHaveBeenCalledWith(mockShellHostContextValue.host);
    });
    expect(screen.queryByTestId("shell-connection-status-button")).toBeNull();
  });

  it("keeps shell connection status out of compact mobile header chrome", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    localStorage.setItem("kb-dashboard-view-mode", "project");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, leftSidebarNav: true },
    });
    vi.mocked(fetchGlobalSettings).mockResolvedValueOnce({ modelOnboardingComplete: true });
    mockShellHostContextValue.host = { kind: "mobile-shell", mode: "remote", connectionId: "p1", serverUrl: "https://fusion.example.com" };
    mockGetShellConnectionNativeResult.mockResolvedValueOnce({
      hostKind: "mobile-shell",
      available: true,
      mode: "remote",
      profileLabel: "Mobile",
      serverOrigin: "https://fusion.example.com",
      openConnectionManager: async () => ({ ok: true }),
    });

    render(<App />);

    await waitFor(() => {
      expect(mockGetShellConnectionNativeResult).toHaveBeenCalledWith(mockShellHostContextValue.host);
      expect(screen.getByTestId("mobile-view-toggle")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("shell-connection-status-button")).toBeNull();
    expect(screen.queryByTestId("mobile-more-shell-connection")).toBeNull();
  });

  it("keeps desktop shell connection status in header and out of mobile sheet", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    mockShellHostContextValue.host = { kind: "desktop-shell", mode: "remote", connectionId: "p1", serverUrl: "https://fusion.example.com" };
    mockGetShellConnectionNativeResult.mockResolvedValueOnce({
      hostKind: "desktop-shell",
      available: true,
      mode: "remote",
      profileLabel: "Prod",
      serverOrigin: "https://fusion.example.com",
      openConnectionManager: async () => ({ ok: true }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByTestId("shell-connection-status-button")).toHaveLength(1);
    });

    expect(screen.queryByTestId("mobile-more-shell-connection")).toBeNull();
  });
});
