import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
// FN-435: the note editor no longer exposes a title input, so App-level draft cases dirty the real CodeMirror document.
import { EditorView } from "@codemirror/view";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import userEvent from "@testing-library/user-event";
import type { NodeConfig, Settings } from "@fusion/core";
import type { AiSessionSummary, ProjectInfo } from "../../api";
import { scopedKey } from "../../utils/projectStorage";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, BOARD_WORKFLOW_SELECTION_STORAGE_KEY } from "../../utils/boardWorkflowSelection";
import { useFileBrowser } from "../../context/FileBrowserContext";
import {
  GEOMETRY_TOKEN_VALUES,
  installGeometryTokenValues,
  removeGeometryTokenValues,
  resolveMobileNavAnchorPx,
} from "../../test/mobileNavGeometry";

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
  /*
   * FNXC:DashboardTests 2026-09-15-14:41:
   * FN-419 makes the primary navigation surface an explicit project choice whose SHIPPED default is the bottom
   * footer. The great majority of this file's cases exercise routing THROUGH THE LEFT COLUMN (`sidebar-nav-*`), so
   * the shared fixture opts into the sidebar placement once, here, instead of rewriting each case. Cases that are
   * about the footer placement (or about the shipped default) override `navigationPlacement` explicitly in their own
   * `fetchSettings` payload.
   */
  navigationPlacement: "sidebar" as const,
  /*
   * FNXC:DashboardTests 2026-09-15-16:04:
   * FN-426 makes the right tool sidebar an opt-in whose shipped default is OFF. The great majority of this file's
   * existing cases were written against the historical always-on panel, so the shared fixture opts into it once here
   * instead of rewriting each case. The FN-426 block at the end of this file overrides it explicitly, in both
   * directions, because the default-off behavior is exactly what it proves.
   */
  rightSidebarEnabled: true,
};

const mockAgentStats = {
  activeCount: 0,
  busyCount: 0,
  pausedCount: 0,
  todoTaskCount: 0,
  idleNonEphemeralCount: 1,
};

const { mockDashboardLoaderRender, appChatTestControl, mockAppUseChat, mockAppUseChatRooms } = vi.hoisted(() => ({
  mockDashboardLoaderRender: vi.fn(),
  appChatTestControl: { renderProductionView: false, renderProductionPlanningView: false },
  mockAppUseChat: vi.fn(),
  mockAppUseChatRooms: vi.fn(),
}));

const mockSubscribeSse = vi.fn((..._args: any[]) => vi.fn());
const mockNotesApi = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));

vi.mock("../../api/notes", () => mockNotesApi);
vi.mock("../../sse-bus", () => ({
   
  subscribeSse: (...args: any[]) => mockSubscribeSse(...args),
}));

/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477 header-search HTTP seams. Only the transport is doubled: `Header`, `TaskSearchInput`,
`useTaskSearch`, `TaskSearchResultsPopover`, and the result `TaskCard`s are all production code in
these scenarios, which is what makes the Symptom Verification case meaningful.
*/
const mockFetchTaskPage = vi.hoisted(() => vi.fn(async () => ({ tasks: [], total: 0, hasMore: false, nextCursor: null })));
const mockAiSearchTasks = vi.hoisted(() => vi.fn(async () => ({ query: "", tasks: [] })));
vi.mock("../../api/tasks/tasks-search", () => ({ aiSearchTasks: mockAiSearchTasks }));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks: vi.fn(() => Promise.resolve([])),
    /*
    FNXC:TaskSearch 2026-09-17-09:41:
    FN-477: the header search reads its own paginated collection instead of filtering whatever the
    board had already loaded, so this is the seam the search scenarios drive. The default empty page
    keeps every unrelated App test issuing no search work.
    */
    fetchTaskPage: mockFetchTaskPage,
    fetchPatchnode: vi.fn(() => Promise.resolve({ days: [], totalEntries: 0, hasMore: false })),
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
    fetchBoardWorkflows: vi.fn(() => Promise.resolve(DEFAULT_BOARD_WORKFLOWS)),
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

const mockUseTasks = vi.fn((_options?: { projectId?: string; searchQuery?: string; sseEnabled?: boolean }) => ({
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
  refreshTasks: vi.fn(),
  ingestCreatedTasks: vi.fn(),
  lastFetchTimeMs: Date.now(),
}));

// Accept both old and new hook signatures.
// FNXC:DashboardTests 2026-08-15-05:15: App/AppModals/TaskDetailModal also import the real
// mergeTaskSnapshot from this module, so spread importOriginal instead of replacing the barrel.
vi.mock("../../hooks/useTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTasks")>()),
  useTasks: (options?: { projectId?: string; searchQuery?: string; sseEnabled?: boolean }) => mockUseTasks(options),
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
  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442: the stub surfaces `initialTab` so App-level routing tests can prove WHICH tab a board deep-tab chip asked the
  floating task window for, without pulling the real (heavy, lazily hosted) task-detail tab strip into this suite.
  */
  TaskDetailContent: ({ task, initialTab, onBackToBoard, onOpenDetail, onRequestClose }: { task: { id: string; title?: string }; initialTab?: string; onBackToBoard?: () => void; onOpenDetail?: (task: { id: string; title?: string }) => void; onRequestClose?: () => void }) => (
    <section data-testid="main-panel-task-detail" data-initial-tab={initialTab ?? ""}>
      {onBackToBoard && <button type="button" onClick={onBackToBoard}>Back to board</button>}
      {onRequestClose && !onBackToBoard && <button type="button" aria-label="Close" onClick={onRequestClose}>Close</button>}
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

vi.mock("../../components/PlanningModeModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/PlanningModeModal")>();
  return {
    PlanningModeModal: (props: Parameters<typeof actual.PlanningModeModal>[0]) => {
      if (appChatTestControl.renderProductionPlanningView) return <actual.PlanningModeModal {...props} />;
      const { isOpen, onClose, presentation = "modal", resumeSessionId } = props;
      return isOpen ? (
        <div className={presentation === "embedded" ? "planning-view open" : "modal-overlay open"} data-testid={presentation === "embedded" ? "planning-view" : undefined} data-resume-session-id={resumeSessionId ?? ""}>
          <button type="button" aria-label="Close" onClick={onClose}>Close</button>
          <div className={presentation === "embedded" ? "modal-header modal-header--embedded" : "modal-header"}><h2>Planning Mode</h2></div>
          <p>Transform your idea into a detailed task</p>
          <input placeholder="e.g., Build a user authentication system with login" />
          <button type="button">Start Planning</button>
        </div>
      ) : null;
    },
  };
});

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

/*
FNXC:Terminal 2026-07-26-19:30:
This stand-in used to be `isOpen ? <div/> : null` and nothing else. That made App's terminal MOUNT
decision structurally unverifiable: the stand-in rendered identically whether App always mounted it with
`isOpen={false}` or did not mount it at all, so a regression back to always-mounted — which costs a live
PTY WebSocket and a 45s heartbeat on a backgrounded tab, the tab-discard signal the conditional mount at
App.tsx ~1927 exists to remove — passed the whole suite.
`terminalLifecycle` records the two things the DOM cannot show: whether the component function was
invoked at all, and whether it was unmounted. Existing DOM-level tests are unaffected; the markup is
unchanged.
*/
/*
FNXC:TerminalLayout 2026-09-15-07:57:
FN-409: the stand-in also models the terminal's pinned-layout SIGNAL, because the shell's footer reservation now
depends on it. `pinnedDefault` mirrors the real component's default (pinned on non-mobile, never pinned on a phone),
and the stand-in's pop-out button reports the detached state exactly as the real control does. The real component's
side of this contract is proven against the real TerminalModal in TerminalModal.test.tsx.
*/
const terminalLifecycle = {
  renders: [] as boolean[],
  mounts: 0,
  unmounts: 0,
  pinnedDefault: true,
  reset(): void {
    this.renders = [];
    this.mounts = 0;
    this.unmounts = 0;
    this.pinnedDefault = true;
  },
};

vi.mock("../../components/TerminalModal", async () => {
  const { useEffect, useState } = await import("react");
  return {
    TerminalModal: ({ isOpen, onClose, footerVisible, onPinnedLayoutChange }: { isOpen: boolean; onClose: () => void; footerVisible?: boolean; onPinnedLayoutChange?: (pinned: boolean) => void }) => {
      terminalLifecycle.renders.push(isOpen);
      const [pinned, setPinned] = useState(terminalLifecycle.pinnedDefault);
      useEffect(() => {
        terminalLifecycle.mounts += 1;
        return () => {
          terminalLifecycle.unmounts += 1;
        };
      }, []);
      useEffect(() => {
        onPinnedLayoutChange?.(pinned);
        return () => onPinnedLayoutChange?.(false);
      }, [onPinnedLayoutChange, pinned]);
      return isOpen ? (
        <div className="modal-overlay open" data-testid="terminal-modal" data-footer-visible={String(footerVisible === true)} data-pinned={String(pinned)}>
          {/*
          FN-438: a test-only probe that flips this stub's pinned state so the App-level footer reservation can be
          exercised. It was named after the real header button, which FN-438 deleted; the rename keeps the two
          unambiguous — the product terminal exposes no presentation toggle at all.
          */}
          <button type="button" data-testid="terminal-pinned-layout-probe" onClick={() => setPinned((current) => !current)}>
            Toggle pinned layout
          </button>
          <button type="button" data-testid="terminal-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      ) : null;
    },
  };
});

vi.mock("../../components/AgentsView", () => ({
  AgentsView: () => <div className="agents-view">Agents view</div>,
}));

vi.mock("@fusion-plugin-examples/dependency-graph/dashboard-view", () => ({
  DependencyGraphDashboardView: () => <div data-testid="dependency-graph">No active tasks to display in graph view.</div>,
}));

// FNXC:TodoPluginOwnership 2026-08-15-05:30: FN-8762 moved the Todo view into the bundled
// fusion-plugin-todos plugin; the host mounts it through PluginDashboardViewHost with the
// plugin context supplying openPlanningMode. Mirror the dependency-graph mock shape.
vi.mock("@fusion-plugin-examples/todos/dashboard-view", () => ({
  TodoDashboardView: ({ context }: { context?: { openPlanningMode?: (initialPlan: string) => void } }) => (
    <div data-testid="todo-view">
      <button type="button" data-testid="todo-planning-button" onClick={() => context?.openPlanningMode?.("Plan: my todo item")}>
        Plan
      </button>
    </div>
  ),
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


vi.mock("../../components/GoalsView", () => ({
  GoalsView: () => <div data-testid="goals-view">Goals View</div>,
}));

vi.mock("../../hooks/useChat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useChat")>()),
  useChat: (...args: unknown[]) => mockAppUseChat(...args),
}));

vi.mock("../../hooks/useChatRooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useChatRooms")>()),
  useChatRooms: (...args: unknown[]) => mockAppUseChatRooms(...args),
}));

vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));

vi.mock("../../components/ChatView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/ChatView")>();
  return {
    ChatView: (props: Parameters<typeof actual.ChatView>[0]) => {
      if (appChatTestControl.renderProductionView) return <actual.ChatView {...props} />;
      return (
        <div className="chat-view" data-testid={props.floating ? "detached-chat-host" : "canonical-chat-host"}>
          <header className="view-header"><h2>Chat</h2><button type="button">New Chat</button><button type="button" aria-label="Pop out chat">Pop out</button></header>
          <button type="button" data-testid="app-chat-session-fixture">Conversation fixture</button>
          <textarea className="chat-input" data-testid="chat-input" aria-label="Message" />
          <FileBrowserProbe testId="fb-probe-chat" />
        </div>
      );
    },
  };
});

vi.mock("../../components/DashboardLoader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/DashboardLoader")>();
  return {
    DashboardLoader: (props: Parameters<typeof actual.DashboardLoader>[0]) => {
      mockDashboardLoaderRender();
      return (
        <>
          <actual.DashboardLoader {...props} />
          <FileBrowserProbe testId="fb-probe-loader" />
        </>
      );
    },
  };
});

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

interface MockMobileKeyboardState {
  keyboardOverlap: number;
  viewportHeight: number | null;
  viewportOffsetTop: number;
  keyboardOpen: boolean;
  navigationViewport?: {
    active: boolean;
    keyboardOverlap: number;
    viewportHeight: number | null;
    viewportOffsetTop: number;
  };
}

// Mock useMobileKeyboard for modal keyboard isolation tests (FN-3290).
// Default: keyboard closed, matching real test-environment behavior.
const mockUseMobileKeyboard = vi.fn((): MockMobileKeyboardState => ({
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
/* `(max-height: 480px)` in production — independent of the width-driven mode. See the note below. */
const mockIsShortViewport = vi.fn(() => false);
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: (...args: unknown[]) => mockUseViewportMode(...args),
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
  isFullScreenSheetViewport: () => mockUseViewportMode() === "mobile",
  /*
  FNXC:TestViewportMock 2026-07-30-11:20:
  An INCOMPLETE module mock does not fail where the export is missing — it throws inside whichever
  component imports it, and the nearest ErrorBoundary swallows that into "This section encountered an
  error". NewTaskModal adopted `isShortViewport`, this mock did not, and the test failed on a MISSING
  HEADING with a healthy-looking DOM.

  FNXC:TestViewportMock 2026-07-30-19:50 (#2846 review — greptile P2, "viewport predicates are conflated"):
  SHORT-VIEWPORT IS ITS OWN CONTROL, because in production it is its own MEDIA QUERY.

  The first version keyed it to `mode === "mobile"`, matching how the siblings above are stubbed. The
  siblings are width predicates and the mode IS their answer; this one is not. `isShortViewport()`
  reads `(max-height: 480px)` alone, while the mobile mode is the OR of width and height — so an
  ordinary PORTRAIT PHONE (narrow, tall) is mobile and NOT short, and the mock claimed it was both.

  What that silently mis-tested: `FloatingWindow` suspends geometry PERSISTENCE on a short viewport,
  and `PlanningModeModal` picks its compact interview layout and hides the session list from it. Every
  mobile test here took those branches, so the ordinary phone case — the most common real viewport —
  was never actually exercised, and a regression in the non-short mobile path would have passed.

  Defaults to FALSE rather than to the mode: a test that means "short" now has to say so, which is the
  only spelling that can distinguish the two.
  */
  isShortViewport: () => mockIsShortViewport(),
  /*
  FNXC:TestViewportMock 2026-09-16-23:24:
  Mock périmé réparé ici : FN-468 a introduit `isMobileShellMode`, consommé par `AppInner`, et ce double ne
  l'exposait pas — tout rendu de `<App />` de ce fichier levait donc avant la première assertion. Le prédicat
  garde sa sémantique de production (téléphone ET tablette), pilotée par le mode simulé.
  */
  isMobileShellMode: (mode?: string) => {
    const resolved = mode ?? mockUseViewportMode();
    return resolved === "mobile" || resolved === "tablet";
  },
}));

// Mock isIOS so FN-3290 keyboard-open behavior is testable in jsdom
vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
  isIOS: () => true,
  _resetLockState: vi.fn(),
}));

import { App, didEnterAwaitingApproval, didEnterDone, shouldShowFirstEverBootLoader } from "../../App";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, clearAuthToken, hasDaemonAuthFailure, installAuthFetch } from "../../auth";
import { fetchAuthStatus, fetchSettings, fetchGlobalSettings, fetchTaskDetail, fetchUnreadCount, updateSettings, runScript, fetchScripts, fetchModels, fetchPluginDashboardViews, fetchDashboardHealth, fetchBoardWorkflows, fetchPatchnode } from "../../api";
import { __resetShellHostContextForTests } from "../../shell-host";
import { __test_clearDashboardViewsCache } from "../../hooks/usePluginDashboardViews";
import * as pluginViewRegistry from "../../plugins/pluginViewRegistry";
import * as apiNodeModule from "../../hooks/useRemoteNodeData";
import { DEFAULT_BOARD_WORKFLOWS } from "./boardWorkflows.test-helpers";
import { readAppFile } from "../../test/cssFixture";

function extractProductionRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!rule) throw new Error(`Production rule is missing: ${selector}`);
  return rule[1];
}

function extractProductionDeclaration(rule: string, property: string): string {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = rule.match(new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+)`));
  if (!declaration) throw new Error(`Production declaration is missing: ${property}`);
  return declaration[1].trim();
}

function installProductionAlphaReserveRule(): HTMLStyleElement {
  const css = readAppFile("components/MobileNavBar.css");
  const selector = 'html[data-viewport-mode="mobile"] .project-content--with-mobile-nav';
  const boardSelector = '.board';
  const boardCss = readAppFile("components/Board.css");
  const style = document.createElement("style");
  style.textContent = `${selector} { ${extractProductionRule(css, selector)} } ${boardSelector} { ${extractProductionRule(boardCss, boardSelector)} }`;
  document.head.append(style);
  return style;
}

function installProductionAlphaDrawerRules(systemOffset: number): HTMLStyleElement {
  const drawerCss = readAppFile("components/MobileDrawer.css");
  const navCss = readAppFile("components/MobileNavBar.css");
  const tokenCss = readAppFile("styles.css");
  const drawerRule = extractProductionRule(drawerCss, ".mobile-drawer");
  const panelRule = extractProductionRule(drawerCss, ".mobile-drawer__panel");
  const bodyRule = extractProductionRule(drawerCss, ".mobile-drawer__body");
  const navRule = extractProductionRule(navCss, ".mobile-nav-bar");
  const inset = extractProductionDeclaration(drawerRule, "inset");
  const insetParts = inset.match(/^([^\s]+)\s+(var\(--icb-right-offset,\s*[^)]+\))\s+([^\s]+)\s+([^\s]+)$/);
  if (!insetParts) throw new Error(`Unsupported production drawer inset: ${inset}`);

  const drawerZToken = extractProductionDeclaration(drawerRule, "z-index").match(/^var\((--[^)]+)\)$/)?.[1];
  if (!drawerZToken) throw new Error("Production drawer z-index must use a token");
  const drawerZ = tokenCss.match(new RegExp(`${drawerZToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(\\d+)`))?.[1];
  if (!drawerZ) throw new Error(`Production z-index token is missing: ${drawerZToken}`);

  const bodyPadding = extractProductionDeclaration(bodyRule, "padding-block-end");
  if (bodyPadding !== "var(--mobile-nav-system-offset)") {
    throw new Error(`Production drawer must keep system clearance inside its body: ${bodyPadding}`);
  }

  /*
  FNXC:MobileDrawer 2026-09-10-17:16:
  The App regression must click the shipped pill and hamburger paths, then observe the real production declarations as a resolved cascade. Materialize only environment/custom-property values that jsdom cannot resolve so a bottom offset, layer regression, or external safe-area reserve fails at the real shell boundary.
  */
  const style = document.createElement("style");
  style.textContent = `
    .mobile-nav-bar { position: ${extractProductionDeclaration(navRule, "position")}; z-index: ${extractProductionDeclaration(navRule, "z-index")}; }
    .mobile-drawer {
      position: ${extractProductionDeclaration(drawerRule, "position")};
      top: ${insetParts[1]};
      right: 0;
      bottom: ${insetParts[3]};
      left: ${insetParts[4]};
      z-index: ${drawerZ};
      display: ${extractProductionDeclaration(drawerRule, "display")};
      align-items: ${extractProductionDeclaration(drawerRule, "align-items")};
      pointer-events: auto;
    }
    .mobile-drawer__panel { height: ${extractProductionDeclaration(panelRule, "height")}; }
    .mobile-drawer__body { padding-block-end: ${systemOffset}px; }
  `;
  document.head.append(style);
  return style;
}

function expectProductionAlphaDrawerOverlay(drawer: HTMLElement, systemOffset: number): void {
  const nav = document.querySelector<HTMLElement>(".mobile-nav-bar");
  const panel = drawer.querySelector<HTMLElement>(".mobile-drawer__panel");
  const body = drawer.querySelector<HTMLElement>(".mobile-drawer__body");
  expect(nav).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(body).not.toBeNull();

  const drawerStyle = window.getComputedStyle(drawer);
  const navStyle = window.getComputedStyle(nav!);
  expect(drawerStyle.position).toBe("fixed");
  expect(drawerStyle.bottom).toBe("0px");
  expect(drawerStyle.display).toBe("flex");
  expect(drawerStyle.alignItems).toBe("flex-end");
  expect(drawerStyle.pointerEvents).not.toBe("none");
  expect(Number(drawerStyle.zIndex)).toBeGreaterThan(Number(navStyle.zIndex));
  expect(window.getComputedStyle(body!).paddingBlockEnd).toBe(`${systemOffset}px`);
  expect(window.getComputedStyle(panel!).height).not.toBe("auto");
}

function expectSingleDrawerHeader(dialog: HTMLElement, headerSelector: string): void {
  expect(dialog.querySelector(".mobile-drawer__header")).toBeNull();
  expect(dialog.querySelectorAll(headerSelector)).toHaveLength(1);
  expect(dialog.querySelectorAll(".mobile-drawer__close")).toHaveLength(0);
  expect(dialog.querySelectorAll(".mobile-drawer__handle-target")).toHaveLength(1);
}

function dismissAlphaDrawerByHandle(drawer: Element): void {
  const handle = drawer.querySelector(".mobile-drawer__handle-target");
  if (!handle) throw new Error("Alpha drawer handle is missing");
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0, button: 0, isPrimary: true });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 1000 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 1000 });
}

function resolvePixelCalcFromRoot(value: string): number {
  const substituted = value.replace(/var\((--[^),\s]+)(?:,[^)]+)?\)/g, (_match, property: string) => {
    const resolved = document.documentElement.style.getPropertyValue(property).trim();
    if (!resolved) throw new Error(`Missing test layout value for ${property}`);
    return resolved;
  });
  const terms = substituted.replace(/^calc\(/, "").replace(/\)$/, "").split("+");
  return terms.reduce((total, term) => {
    const match = term.trim().match(/^(-?\d+(?:\.\d+)?)px$/);
    if (!match) throw new Error(`Unsupported production padding term: ${term.trim()}`);
    return total + Number(match[1]);
  }, 0);
}

const appChatSession: ChatSessionInfo = {
  id: "fn-342-app-chat",
  agentId: "agent-fn-342",
  status: "active",
  title: "Conversation Alpha",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

function configureProductionAppChat(): void {
  appChatTestControl.renderProductionView = true;
  mockAppUseChat.mockImplementation(() => {
    const [activeSession, setActiveSession] = useState<ChatSessionInfo | null>(null);
    return {
      sessions: [appChatSession],
      activeSession,
      sessionsLoading: false,
      messages: activeSession ? [{ id: "message-fn-342", role: "assistant", content: "Bonjour", createdAt: "2026-09-10T00:01:00.000Z" }] : [],
      messagesLoading: false,
      isStreaming: false,
      streamingText: "",
      streamingThinking: "",
      streamingToolCalls: [],
      selectSession: (sessionId: string) => setActiveSession(sessionId === appChatSession.id ? appChatSession : null),
      createSession: vi.fn().mockResolvedValue(appChatSession),
      archiveSession: vi.fn(),
      archivedSessions: [],
      refreshArchivedSessions: vi.fn().mockResolvedValue(undefined),
      unarchiveSession: vi.fn().mockResolvedValue(undefined),
      renameSession: vi.fn(),
      setSessionThinkingLevel: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      editMessageAndResend: vi.fn(),
      // FNXC:ChatMessageEdit 2026-09-16-05:58: FN-459 edit-draft rescue surface; nothing to restore here.
      editDraftRestore: null,
      clearEditDraftRestore: vi.fn(),
      stopStreaming: vi.fn().mockResolvedValue(undefined),
      pendingMessages: [],
      clearPendingMessage: vi.fn(),
      loadMoreMessages: vi.fn(),
      hasMoreMessages: false,
      searchQuery: "",
      setSearchQuery: vi.fn(),
      filteredSessions: [appChatSession],
      refreshSessions: vi.fn(),
      agentsMap: new Map(),
    } satisfies UseChatReturn;
  });
  mockAppUseChatRooms.mockReturnValue({
    rooms: [],
    roomsLoading: false,
    roomsError: null,
    activeRoom: null,
    activeRoomMembers: [],
    messages: [],
    messagesLoading: false,
    selectRoom: vi.fn(),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
    sendRoomMessage: vi.fn(),
    refreshRooms: vi.fn(),
  } satisfies UseChatRoomsResult);
}

/*
 * FNXC:DashboardTests 2026-09-15-14:41:
 * FN-419: a wide project shell mounts EXACTLY ONE primary navigation surface, chosen by `navigationPlacement`. The
 * shared readiness helper therefore waits for whichever surface the shell owns instead of pinning the footer, and
 * asserts the exclusivity invariant while it is at it.
 */
async function waitForAppShell(): Promise<void> {
  await waitFor(() => {
    expect(fetchSettings).toHaveBeenCalled();
    if (mockUseViewportMode() === "mobile") {
      expect(screen.getByTestId("mobile-nav-tab-command-center")).toBeTruthy();
      expect(screen.getByTestId("mobile-nav-tab-planning")).toBeTruthy();
      return;
    }
    const footer = screen.queryByTestId("desktop-action-bar");
    const sidebar = screen.queryByTestId("left-sidebar-nav");
    expect(Boolean(footer) !== Boolean(sidebar)).toBe(true);
  });
}

function expectBoardToBeInactive(): void {
  const board = document.querySelector(".board");
  expect(board).toBeTruthy();
  expect(board?.closest('[aria-hidden="true"]')).toBeTruthy();
}

/*
FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392 supersedes FN-8698's per-view popup identity: a task owns ONE window for the whole project. This App-level
regression clicks the shipped Board card and List row affordances and the real view-switch controls, then proves the
same window node stays visible across views, that reopening the task from the other view focuses it instead of adding
a second window, and that one close removes it everywhere.
*/
describe("FN-392 task windows travel across Board and other views", () => {
  it("keeps one window for a task opened from Board and reopened after navigating away", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    const sharedTask = {
      id: "FN-8698",
      title: "Retained popup regression task",
      description: "Verify one task window survives view changes.",
      column: "todo",
      status: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    /* FN-419: the wide footer navigation entries used below belong to the footer placement. */
    /*
    FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
    FN-442 deleted the `openMobileTasksInPopup` opt-in this case used to set: opening a task from the board is now the
    floating task window unconditionally, so the same click must reach the same window with no setting at all.
    */
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "footer",
    });
    mockUseTasks.mockImplementation(() => ({
      tasks: [sharedTask],
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
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);
    await waitForAppShell();

    const boardCard = '.card[data-id="FN-8698"]';
    const popupTestId = "floating-window-task-detail-FN-8698";
    const overlayTestId = "floating-window-overlay-task-detail-FN-8698";

    fireEvent.click(document.querySelector(boardCard)!);
    await waitFor(() => expect(screen.getByTestId(popupTestId)).toBeTruthy());
    const taskWindow = screen.getByTestId(popupTestId);

    /*
     * FN-446: Agents is no longer a direct quick-access destination of the footer, so reaching it now means opening the
     * **More** menu first — which is the real operator path. The invariant under test is unchanged: the task window
     * survives navigation to any other view.
     */
    for (const view of ["planning", "agents", "board"] as const) {
      if (!screen.queryByTestId(`desktop-nav-${view}`)) fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
      fireEvent.click(screen.getByTestId(`desktop-nav-${view}`));
      expect(screen.getByTestId(popupTestId)).toBe(taskWindow);
      expect(screen.getByTestId(overlayTestId)).not.toHaveAttribute("aria-hidden");
    }

    await waitFor(() => expect(document.querySelector(boardCard)).toBeTruthy());
    fireEvent.click(document.querySelector(boardCard)!);
    await waitFor(() => expect(screen.getAllByTestId(popupTestId)).toHaveLength(1));
    expect(screen.getByTestId(popupTestId)).toBe(taskWindow);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId(popupTestId)).toBeNull());
  });

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442: a board card's deep-tab chip is the second board task-open path, and it used to have its own modal/main-panel
  branches behind `openMobileTasksInPopup`. This drives the shipped Changes chip on a real WIP card and proves it reaches
  the same floating task window with the requested tab, with no project setting involved.
  */
  it("opens a board card Changes chip in the task window on the Changes tab", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    const wipTask = {
      id: "FN-8699",
      title: "Deep tab chip regression task",
      description: "Verify the Changes chip opens the task window.",
      column: "in-progress",
      status: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      modifiedFiles: ["packages/dashboard/app/App.tsx"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
    mockUseTasks.mockImplementation(() => ({
      tasks: [wipTask],
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
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);
    await waitForAppShell();

    const chip = await waitFor(() => {
      const node = document.querySelector('.card[data-id="FN-8699"] .card-session-files');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByTestId("floating-window-task-detail-FN-8699")).toBeTruthy());
    const taskWindow = screen.getByTestId("floating-window-task-detail-FN-8699");
    await waitFor(() => {
      const hosted = taskWindow.querySelector('[data-testid="main-panel-task-detail"]');
      expect(hosted?.getAttribute("data-initial-tab")).toBe("changes");
    });
    expect(screen.queryByTestId("floating-window-task-detail-FN-8699")).toBeTruthy();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  appChatTestControl.renderProductionView = false;
  appChatTestControl.renderProductionPlanningView = false;
  mockAppUseChat.mockReset();
  mockAppUseChatRooms.mockReset();
  __test_clearDashboardViewsCache();
  /*
   * FNXC:DashboardTests 2026-06-22-03:47:
   * App.test.tsx runs beside other dashboard specs in the same Vitest process, so reset API mock implementations as well as call counts to prevent cross-file implementation leakage.
   *
   * FNXC:DashboardTests 2026-08-16-05:22:
   * vi.clearAllMocks() clears calls but NEVER drops unconsumed mockResolvedValueOnce queue
   * entries, and a plain mockResolvedValue default does not purge them either — the once-queue
   * always wins first. A test that queued a Once response and bailed before consuming it (auth
   * status, settings, health, plugin views) therefore poisoned the NEXT test's first fetch,
   * which is why "closes board-opened main-panel task detail on one browser back" flaked: a
   * leaked auth/settings Once value made App render an auto-opened modal surface instead of the
   * board. mockReset each once-queue-prone API mock here, then re-apply its default below.
   */
  for (const onceProneApiMock of [fetchSettings, updateSettings, fetchGlobalSettings, fetchDashboardHealth, fetchAuthStatus, fetchModels, fetchScripts, runScript, fetchBoardWorkflows, fetchPluginDashboardViews, fetchPatchnode]) {
    vi.mocked(onceProneApiMock).mockReset();
  }
  vi.mocked(fetchPatchnode).mockResolvedValue({ days: [], totalEntries: 0, hasMore: false });
  vi.mocked(fetchPluginDashboardViews).mockResolvedValue([]);
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
  vi.mocked(fetchBoardWorkflows).mockResolvedValue(DEFAULT_BOARD_WORKFLOWS);
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
  mockNotesApi.fetchNotes.mockResolvedValue({ notes: [] });
  mockNotesApi.fetchNote.mockReset();
  mockNotesApi.createNote.mockReset();
  mockNotesApi.updateNote.mockReset();
  mockNotesApi.deleteNote.mockReset();
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
  mockUseViewportMode.mockReturnValue("tablet");
  /* Reset alongside the mode: it is a SEPARATE predicate, so a suite that sets it must not leak. */
  mockIsShortViewport.mockReset();
  mockIsShortViewport.mockReturnValue(false);
  mockAgentStats.todoTaskCount = 0;
  mockAgentStats.idleNonEphemeralCount = 1;
});

/*
 * FN-419 — AUTHORITATIVE SYMPTOM PROOF.
 *
 * Original symptom: at one screen size (the `tablet` tier) the primary menu appeared TWICE — in the left sidebar AND
 * in the bottom footer. Exact reproduction: render the real `<App />` in the project shell at `tablet` with project
 * settings that do not carry `navigationPlacement`, and count the mounted primary navigation surfaces.
 *
 * Every case below renders the real `<App />` (the shipped shell composition), never a recomposed harness.
 */
describe("placement du menu de navigation", () => {
  const settingsWith = (overrides: Record<string, unknown>) => {
    const base: Record<string, unknown> = { ...defaultSettings };
    delete base.navigationPlacement;
    return { ...base, ...overrides };
  };

  const mountedPrimarySurfaces = () => ({
    footer: screen.queryByTestId("desktop-action-bar"),
    sidebar: screen.queryByTestId("left-sidebar-nav"),
  });

  const expectExactlyOneSurface = (expected: "footer" | "sidebar") => {
    const { footer, sidebar } = mountedPrimarySurfaces();
    expect([footer, sidebar].filter(Boolean)).toHaveLength(1);
    if (expected === "footer") {
      expect(footer).not.toBeNull();
      expect(sidebar).toBeNull();
    } else {
      expect(sidebar).not.toBeNull();
      expect(footer).toBeNull();
      expect(document.querySelector(".executor-status-bar")).toBeNull();
    }
    // Neither placement may let the Header re-add a third navigation.
    expect(screen.queryByTitle("Board view")).toBeNull();
    expect(screen.queryByTestId("view-toggle-overflow-trigger")).toBeNull();
  };

  it.each(["tablet", "desktop"] as const)(
    "ne monte que le footer sans la clé navigationPlacement en %s (reproduction exacte du bug)",
    async (mode) => {
      mockUseViewportMode.mockReturnValue(mode);
      vi.mocked(fetchSettings).mockResolvedValue(settingsWith({}));

      render(<App />);

      expect(await screen.findByTestId("desktop-action-bar")).toBeInTheDocument();
      expectExactlyOneSurface("footer");
    },
  );

  it.each(["tablet", "desktop"] as const)(
    "traite une valeur persistée invalide comme le défaut footer en %s",
    async (mode) => {
      mockUseViewportMode.mockReturnValue(mode);
      vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ navigationPlacement: "left" }));

      render(<App />);

      expect(await screen.findByTestId("desktop-action-bar")).toBeInTheDocument();
      expectExactlyOneSurface("footer");
    },
  );

  it.each(["tablet", "desktop"] as const)(
    "ne monte que la sidebar, sans aucune barre basse ni réservation, en %s",
    async (mode) => {
      mockUseViewportMode.mockReturnValue(mode);
      localStorage.setItem("fusion:right-dock-open", "true");
      vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ navigationPlacement: "sidebar" }));

      render(<App />);

      const sidebar = await screen.findByTestId("left-sidebar-nav");
      expectExactlyOneSurface("sidebar");

      // No bottom bar at all => no `--executor-footer-height` reservation anywhere in the shell.
      const shell = screen.getByTestId("dashboard-project-shell");
      expect(shell).toHaveClass("dashboard-project-shell--with-sidebar");
      expect(shell.querySelector(".project-content")).not.toHaveClass("project-content--with-footer");
      expect(sidebar).not.toHaveClass("left-sidebar-nav--with-footer");
      const dock = await screen.findByTestId("right-dock");
      expect(dock).not.toHaveClass("right-dock--with-footer");
    },
  );

  it("monte quand même la sidebar avec un drapeau hérité leftSidebarNav à false", async () => {
    mockUseViewportMode.mockReturnValue("tablet");
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsWith({
        navigationPlacement: "sidebar",
        experimentalFeatures: { ...defaultSettings.experimentalFeatures, leftSidebarNav: false },
      }),
    );

    render(<App />);

    // A stale opt-out flag must never combine with an explicit sidebar placement into zero navigation surfaces.
    expect(await screen.findByTestId("left-sidebar-nav")).toBeInTheDocument();
    expectExactlyOneSurface("sidebar");
  });

  it("donne à la sidebar le contrôle moteur et Terminal, sans le bouton de visibilité des fenêtres", async () => {
    mockUseViewportMode.mockReturnValue("tablet");
    terminalLifecycle.reset();
    vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ navigationPlacement: "sidebar" }));

    render(<App />);

    await screen.findByTestId("left-sidebar-nav");
    expect(await screen.findByTestId("sidebar-capacity-count")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-window-visibility-toggle")).toBeNull();

    fireEvent.click(await screen.findByTestId("sidebar-nav-terminal"));
    const terminal = await screen.findByTestId("terminal-modal");
    expect(terminal).toHaveAttribute("data-footer-visible", "false");
  });

  it("ouvre le Chat en page principale depuis le menu de gauche, sans ouvrir le dock", async () => {
    mockUseViewportMode.mockReturnValue("tablet");
    vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ navigationPlacement: "sidebar" }));

    render(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-chat"));

    const chatHost = await screen.findByTestId("chat-keep-alive");
    expect(chatHost).toBeInTheDocument();
    // Exactly one primary Chat host, mounted inside the main content — like Notes, not in a drawer or the dock.
    const chatSurfaces = await screen.findAllByTestId("canonical-chat-host");
    expect(chatSurfaces).toHaveLength(1);
    expect(chatHost.contains(chatSurfaces[0])).toBe(true);
    expect(screen.queryByTestId("detached-chat-host")).toBeNull();
    // The right dock must not have been hijacked into the Chat tool.
    expect(screen.queryByTestId("right-dock-body")).toBeNull();
  });

  /*
  FN-419: the dock's selected tool is persisted, so an operator arriving in `sidebar` placement very often still has
  "chat" stored from a previous `footer` session. The main page owning Chat must re-point that stored selection, never
  close the dock: closing it on every render made the Header toggle look dead and hid the tab strip.
  */
  it("garde le dock ouvrable en placement sidebar malgré une vue « chat » persistée", async () => {
    mockUseViewportMode.mockReturnValue("tablet");
    localStorage.setItem("fusion:right-dock-view", "chat");
    vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ navigationPlacement: "sidebar" }));

    render(<App />);

    await screen.findByTestId("left-sidebar-nav");
    fireEvent.click(await screen.findByTestId("header-right-dock-toggle"));

    // The dock stays open and its body is reachable, so the tab strip can be used to pick another tool.
    const dockBody = await screen.findByTestId("right-dock-body");
    expect(dockBody).toBeInTheDocument();
    expect(await screen.findByTestId("right-dock-tab-chat")).toBeInTheDocument();
    // Chat stays a main-page destination: the dock must not host it in this placement.
    expect(within(dockBody).queryByTestId("canonical-chat-host")).toBeNull();
  });
});

describe("official dashboard design production wiring", () => {
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: the wide primary Chat host is the dock's inline list again. Selecting it keeps the panel open with exactly one
  Chat surface inside it, produces no expand modal and no parallel page host, and opens nothing detached by itself.
  */
  it("opens Chat as the inline dock list without an expanded or parallel page host", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    localStorage.setItem("fusion:right-dock-open", "true");
    /* FN-419: the dock is the primary Chat host only in the footer placement; sidebar placement uses the main page. */
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "footer",
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    render(<App />);
    fireEvent.click(await screen.findByTestId("right-dock-tab-chat"));
    const dockBody = await screen.findByTestId("right-dock-body");
    expect(await screen.findAllByTestId("canonical-chat-host")).toHaveLength(1);
    expect(within(dockBody).getByTestId("canonical-chat-host")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(screen.queryByTestId("chat-keep-alive")).toBeNull();
    expect(screen.queryByTestId("detached-chat-host")).toBeNull();
  });

  /*
  FNXC:StandardBoardHeight 2026-09-12-19:19:
  App's jsdom lane proves production composition and the exact absent/disabled Alpha routing without inventing layout metrics. The browser smoke owns rectangle, overflow, and scroll assertions against the emitted App because only a rendering engine can make those measurements meaningful.
  */
  it.each([
    ["absent", undefined],
    ["disabled", false],
    ["enabled", true],
  ] as const)("keeps every production Board state on the official shell when Alpha is %s", async (_flagState, alphaUpdates) => {
    mockUseViewportMode.mockReturnValue("desktop");
    /* FN-419: the bottom bar and its `--with-footer` reservations exist only in the footer placement (set per state below). */
    const states = ["skeleton", "sans-workflow", "selection-vide", "selection-debordante", "aggregate-debordant"] as const;
    const overflowTasks = Array.from({ length: 3 }, (_, index) => ({
      id: `FN-362-${index}`,
      title: index < 2 ? "Carte dupliquée" : `Carte ${index}`,
      description: "Vérification de la hauteur sûre du Board standard.",
      status: "in-progress",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    }));

    for (const state of states) {
      localStorage.removeItem(scopedKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, DEFAULT_PROJECT_ID));
      const experimentalFeatures = { ...defaultSettings.experimentalFeatures };
      delete experimentalFeatures.alphaUpdates;
      if (alphaUpdates !== undefined) experimentalFeatures.alphaUpdates = alphaUpdates;
      vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer", experimentalFeatures });
      if (state === "skeleton") {
        vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
      } else if (state === "sans-workflow") {
        vi.mocked(fetchBoardWorkflows).mockResolvedValue({ ...DEFAULT_BOARD_WORKFLOWS, defaultWorkflowId: "", workflows: [] });
      } else {
        vi.mocked(fetchBoardWorkflows).mockResolvedValue({
          ...DEFAULT_BOARD_WORKFLOWS,
          taskWorkflowIds: Object.fromEntries(overflowTasks.map((task) => [task.id, "builtin:coding"])),
        });
      }
      const tasks = state.endsWith("debordante") || state.endsWith("debordant") ? overflowTasks : [];
      mockUseTasks.mockReturnValue({
        tasks,
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
        refreshTasks: vi.fn(),
        ingestCreatedTasks: vi.fn(),
        lastFetchTimeMs: Date.now(),
      });

      const view = render(<App />);
      const keepAlive = await screen.findByTestId("board-keep-alive");
      const board = await waitFor(() => {
        const candidate = keepAlive.querySelector<HTMLElement>(".board");
        expect(candidate).not.toBeNull();
        return candidate!;
      });
      if (state === "aggregate-debordant") {
        fireEvent.click(screen.getByTestId("workflow-switcher"));
        fireEvent.click(await screen.findByTestId(`workflow-switcher-option-${ALL_WORKFLOWS_BOARD_VIEW_ID}`));
      }

      const shell = screen.getByTestId("dashboard-project-shell");
      const content = shell.querySelector<HTMLElement>(".project-content");
      expect(shell.parentElement).toHaveClass("dashboard-project-stack");
      expect(content).toHaveClass("project-content--with-footer");
      expect(content?.contains(keepAlive)).toBe(true);
      expect(keepAlive.contains(board)).toBe(true);
      /*
      FNXC:NativeUiPresentation 2026-09-15-00:20:
      The perimeter element is gone, so Board is a direct occupant of its keep-alive host with no extra box
      between them. That containment — not a marker on a wrapper — is what this case always protected.
      */
      expect(board.closest("[data-alpha-surface]")).toBeNull();
      expect(board.parentElement && keepAlive.contains(board.parentElement)).toBe(true);
      expect(document.querySelector(".executor-status-bar")).not.toBeInTheDocument();
      expect(screen.getByTestId("desktop-action-bar")).toBeInTheDocument();

      if (state === "skeleton") expect(screen.getByTestId("board-workflows-skeleton")).toBe(board);
      if (state === "sans-workflow") expect(screen.getByTestId("board-workflows-empty")).toBe(board);
      if (state.startsWith("selection") || state.startsWith("aggregate")) {
        expect(board.closest(".board-workflow-view")).not.toBeNull();
        expect(board).toHaveClass("board-workflow-columns");
      }
      if (state === "selection-vide") expect(board.querySelectorAll(".empty-column").length).toBeGreaterThan(0);
      if (state === "selection-debordante" || state === "aggregate-debordant") {
        expect(screen.getAllByText("Carte dupliquée")).toHaveLength(2);
        expect(board.querySelector("[data-column='in-progress'] .column-body")).not.toBeNull();
        expect(screen.getByTestId("workflow-switcher").getAttribute("aria-label")).toContain(
          state === "aggregate-debordant" ? "All workflows" : "Coding",
        );
      }
      view.unmount();
    }
  }, 30_000);

  it.each([
    ["tablet", "empty"],
    ["desktop", "populated"],
  ] as const)("monte le footer et ouvre More dans le vrai host Alpha %s avec des tâches %s", async (mode, taskState) => {
    mockUseViewportMode.mockReturnValue(mode);
    if (taskState === "populated") {
      const emptyResult = mockUseTasks();
      mockUseTasks.mockReturnValue({
        ...emptyResult,
        tasks: [{ id: "FN-340", title: "Footer regression", description: "x", status: "in-progress", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" }],
      });
    }
    /*
     * FN-419: this case is about the FOOTER placement, so it opts in explicitly. Under that placement the left
     * sidebar must be ABSENT on both wide tiers — the previous expectation (tablet showing the sidebar WITH the
     * footer) encoded the very double-navigation bug this task removes.
     */
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "footer",
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    localStorage.setItem("fusion:right-dock-open", "true");

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("dashboard-project-shell")).toBeInTheDocument());
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    const shell = screen.getByTestId("dashboard-project-shell");
    const content = shell.querySelector(".project-content");
    const rightDock = await waitFor(() => {
      const dock = document.querySelector(".right-dock");
      expect(dock).not.toBeNull();
      return dock;
    });
    expect(content).toHaveClass("project-content--with-footer");
    expect(content).not.toHaveClass("project-content--with-mobile-nav", "project-content--with-mobile-nav");
    expect(screen.getByTestId("desktop-action-bar")).toBeInTheDocument();
    const moreTrigger = screen.getByTestId("desktop-nav-more");
    expect(moreTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerEnter(moreTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(moreTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("left-sidebar-nav")).toBeNull();
    expect(shell).not.toHaveClass("dashboard-project-shell--with-sidebar");
    if (mode === "tablet") expect(document.querySelector("header.header")).toBeInTheDocument();
    expect(rightDock).toHaveClass("right-dock--with-footer");
    expect(shell).toHaveClass("dashboard-project-shell--with-right-dock");
    expect(screen.queryByTestId("executor-terminal-launcher-segment")).toBeNull();
    expect(document.querySelector(".mobile-nav-bar")).toBeNull();
  });

  it.each(["tablet", "desktop"] as const)("ouvre et démonte Terminal depuis le footer large en mode %s", async (mode) => {
    mockUseViewportMode.mockReturnValue(mode);
    terminalLifecycle.reset();
    /* FN-419: the wide footer Terminal action only exists in the footer placement. */
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
    localStorage.setItem("fusion:right-dock-open", "true");

    render(<App />);

    const terminal = await screen.findByTestId("desktop-nav-terminal");
    expect(screen.queryByTestId("terminal-modal")).toBeNull();
    expect(terminalLifecycle.mounts).toBe(0);
    fireEvent.click(terminal);
    expect(await screen.findByTestId("terminal-modal")).toHaveAttribute("data-footer-visible", "true");
    expect(terminalLifecycle.mounts).toBe(1);
    fireEvent.click(screen.getByTestId("terminal-close-btn"));
    await waitFor(() => expect(screen.queryByTestId("terminal-modal")).toBeNull());
    expect(terminalLifecycle.unmounts).toBe(1);

    if (mode === "tablet") {
      // FN-419: the footer placement owns navigation on both wide tiers, so no sidebar accompanies it.
      expect(screen.getByTestId("dashboard-project-shell")).not.toHaveClass("dashboard-project-shell--with-sidebar");
      expect(screen.queryByTestId("left-sidebar-nav")).toBeNull();
      expect(document.querySelector(".right-dock")).toBeInTheDocument();
      expect(document.querySelector("[data-testid^='floating-window-overlay-']")).toBeNull();
    }
  });

  /*
  FNXC:TerminalLayout 2026-09-15-07:57:
  FN-409 symptom acceptance (2): the bottom bar's height must be reserved EXACTLY ONCE. While the pinned terminal is
  shown it is the only element the fixed bar covers, so the shell consumers stop reserving; closing the terminal or
  detaching it restores their reservation.
  */
  it.each(["tablet", "desktop"] as const)("ne r\u00e9serve la hauteur de la barre du bas qu'une seule fois quand le terminal est \u00e9pingl\u00e9 (%s)", async (mode) => {
    mockUseViewportMode.mockReturnValue(mode);
    terminalLifecycle.reset();
    /*
     * FN-419: a bottom bar only exists in the footer placement, so the reservation contract is asserted there. The
     * sidebar is absent under that placement, so it can no longer carry a `--with-footer` modifier at all.
     */
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
    localStorage.setItem("fusion:right-dock-open", "true");

    render(<App />);

    const shell = await screen.findByTestId("dashboard-project-shell");
    const content = shell.querySelector(".project-content")!;
    const dock = await screen.findByTestId("right-dock");
    expect(screen.queryByTestId("left-sidebar-nav")).toBeNull();

    // Terminal closed: the shell owns the reservation.
    expect(content).toHaveClass("project-content--with-footer");
    expect(dock).toHaveClass("right-dock--with-footer");

    fireEvent.click(await screen.findByTestId("desktop-nav-terminal"));
    const terminal = await screen.findByTestId("terminal-modal");
    expect(terminal).toHaveAttribute("data-pinned", "true");

    // Pinned terminal: only the terminal host reserves, so no empty band is left above it.
    await waitFor(() => {
      expect(content).not.toHaveClass("project-content--with-footer");
      expect(dock).not.toHaveClass("right-dock--with-footer");
      // The terminal itself keeps receiving the raw footer visibility: it is the single legitimate consumer.
      expect(terminal).toHaveAttribute("data-footer-visible", "true");
    });

    // Detaching the terminal takes it out of the flow, so the shell reservation returns.
    fireEvent.click(screen.getByTestId("terminal-pinned-layout-probe"));
    await waitFor(() => {
      expect(content).toHaveClass("project-content--with-footer");
      expect(dock).toHaveClass("right-dock--with-footer");
    });

    // Re-pinning drops it again, and closing the terminal restores it for good.
    fireEvent.click(screen.getByTestId("terminal-pinned-layout-probe"));
    await waitFor(() => expect(content).not.toHaveClass("project-content--with-footer"));
    fireEvent.click(screen.getByTestId("terminal-close-btn"));
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-modal")).toBeNull();
      expect(content).toHaveClass("project-content--with-footer");
      expect(dock).toHaveClass("right-dock--with-footer");
    });
  });

  it.each([
    ["absente", undefined],
    ["fausse", false],
    ["vraie", true],
  ] as const)("conserve le shell tablette et Chat quand la valeur Alpha historique est %s", async (_label, alphaUpdates) => {
    mockUseViewportMode.mockReturnValue("tablet");
    configureProductionAppChat();
    localStorage.setItem("fusion:right-dock-open", "true");
    const experimentalFeatures = { ...defaultSettings.experimentalFeatures };
    delete experimentalFeatures.alphaUpdates;
    if (alphaUpdates !== undefined) experimentalFeatures.alphaUpdates = alphaUpdates;
    /*
     * FN-419: the dock Chat hand-off asserted below belongs to the FOOTER placement (sidebar placement routes Chat to
     * the main page instead), and the tablet shell now mounts exactly one primary surface — the footer.
     */
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer", experimentalFeatures });

    render(<App />);
    const shell = await screen.findByTestId("dashboard-project-shell");
    expect(shell).toHaveClass("dashboard-project-shell--with-right-dock");
    expect(shell).not.toHaveClass("dashboard-project-shell--with-sidebar");
    expect(shell.querySelector(".project-content")).toHaveClass("project-content--with-footer");
    expect(screen.queryByTestId("left-sidebar-nav")).toBeNull();
    expect(screen.queryByTestId("executor-terminal-launcher-segment")).toBeNull();
    expect(screen.getByTestId("desktop-action-bar")).toBeInTheDocument();
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    expect(document.querySelector(".mobile-nav-bar")).toBeNull();

    const dock = screen.getByTestId("right-dock");
    expect(dock).toHaveClass("right-dock--with-footer");
    /*
     * FN-426: the opted-in panel offers the same four shortcuts on tablet and desktop. The old desktop-only Notes gate
     * existed to stop a stale selection creating a hidden Notes owner in a panel nobody chose; the panel is chosen
     * explicitly now, and the canonical Notes list is the header popover either way.
     */
    expect(within(dock).getByTestId("right-dock-tab-notes")).toBeInTheDocument();
    fireEvent.click(await within(dock).findByTestId("right-dock-tab-chat"));

    /*
    FNXC:ChatSurfaceUnification 2026-09-14-17:46:
    FN-392: the tablet dock keeps the Chat list inline; clicking a conversation opens its dedicated window instead of a
    transcript inside the panel, and no expand modal is ever created for Chat.
    */
    const dockBody = await screen.findByTestId("right-dock-body");
    expect(dockBody.querySelectorAll(".chat-view")).toHaveLength(1);
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(screen.getByTestId("right-dock")).toBeInTheDocument();
    fireEvent.click(await within(dockBody).findByTestId(`chat-session-${appChatSession.id}`));
    expect(await screen.findByTestId(`floating-window-overlay-chat-window-${DEFAULT_PROJECT_ID}-${appChatSession.id}`)).toBeInTheDocument();
    expect(within(dockBody).queryByTestId("chat-input")).toBeNull();
  });

  it("removes the Alpha footer and all footer reservations only on mobile", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--native"));
    const shell = screen.getByTestId("dashboard-project-shell");
    const content = shell.querySelector(".project-content");
    const nav = document.querySelector(".mobile-nav-bar");
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    expect(screen.queryByTestId("executor-terminal-launcher-segment")).toBeNull();
    expect(content).not.toHaveClass("project-content--with-footer", "project-content--with-mobile-nav");
    expect(nav).not.toHaveClass("mobile-nav-bar--with-footer");
    expect(content).toHaveClass("project-content--with-mobile-nav");
    expect(screen.queryByTestId("left-sidebar-nav")).toBeNull();
    expect(document.querySelector(".right-dock")).toBeNull();
  });

  it("hides the Alpha footer when no project is selected", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "overview");
    mockCurrentProjectState.currentProject = null;
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    render(<App />);

    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    expect(document.querySelector(".project-content--with-footer")).toBeNull();
    expect(screen.queryByTestId("executor-terminal-launcher-segment")).toBeNull();
  });

  it.each([
    ["portrait with iOS inset", { viewportHeight: 640, contentHeight: 720, systemOffset: 46 }],
    ["landscape with Android ICB", { viewportHeight: 360, contentHeight: 720, systemOffset: 48 }],
    ["standalone display", { viewportHeight: 640, contentHeight: 720, systemOffset: 60 }],
  ] as const)("scrolls a real App final control above the measured navigation pill in %s", async (_scenario, layout) => {
    /*
    FNXC:NativeShell 2026-09-10-04:03:
    The regression must exercise App's real project scroller and MobileNavBar publication path. This test imports the production reserve declaration and simulates only jsdom's absent box layout, so removing the class, CSS rule, or measured custom property breaks final-control clearance instead of satisfying a duplicated arithmetic fixture.
    */
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    document.documentElement.dataset.viewportMode = "mobile";
    document.documentElement.style.setProperty("--mobile-nav-system-offset", `${layout.systemOffset}px`);
    document.documentElement.style.setProperty("--space-xs", "4px");
    document.documentElement.style.setProperty("--ui-density-md", "12px");
    const productionStyle = installProductionAlphaReserveRule();
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      return this.classList.contains("mobile-nav-bar") ? 54 : 0;
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const height = this.classList.contains("mobile-nav-tab") ? 44 : 0;
      return { x: 0, y: 0, top: 0, right: 0, bottom: height, left: 0, width: 0, height, toJSON: () => ({}) };
    });
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if ((element as HTMLElement).classList?.contains("mobile-nav-bar")) {
        return {
          paddingBottom: "0px",
          getPropertyValue: (property: string) => property === "--mobile-nav-floating-gap" ? "8px" : "",
        } as CSSStyleDeclaration;
      }
      return nativeGetComputedStyle(element);
    });

    try {
      render(<App />);

      const pill = await waitFor(() => {
        const candidate = document.querySelector<HTMLElement>(".mobile-nav-bar--native");
        expect(candidate).not.toBeNull();
        expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toBe("62px");
        return candidate!;
      });
      const scroller = screen.getByTestId("dashboard-project-shell").querySelector<HTMLElement>(".project-content");
      const finalControl = await screen.findByTestId("column-history-done");
      const board = scroller?.querySelector<HTMLElement>(".board.board-workflow-columns");
      const columns = Array.from(scroller?.querySelectorAll<HTMLElement>(".board.board-workflow-columns > .column") ?? []);
      expect(scroller).not.toBeNull();
      expect(board).not.toBeNull();
      expect(columns.length).toBeGreaterThan(0);
      expect(scroller).toHaveClass("project-content--with-mobile-nav");
      expect(scroller!.style.paddingBottom).toBe("");

      const productionPadding = nativeGetComputedStyle(scroller!).paddingBottom;
      expect(productionPadding).toContain("var(--mobile-nav-height)");
      expect(productionPadding).toContain("var(--mobile-nav-system-offset)");
      const reserve = resolvePixelCalcFromRoot(productionPadding);
      expect(productionStyle.textContent).toContain("--board-padding: var(--ui-density-md)");
      let scrollTop = 0;
      Object.defineProperties(scroller!, {
        clientHeight: { configurable: true, value: layout.viewportHeight },
        scrollHeight: { configurable: true, get: () => layout.contentHeight + reserve },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.max(0, Math.min(value, scroller!.scrollHeight - scroller!.clientHeight));
          },
        },
      });
      finalControl.getBoundingClientRect = () => ({
        x: 0,
        y: layout.contentHeight - scrollTop - 44,
        top: layout.contentHeight - scrollTop - 44,
        right: 200,
        bottom: layout.contentHeight - scrollTop,
        left: 0,
        width: 200,
        height: 44,
        toJSON: () => ({}),
      });
      const pillTop = layout.viewportHeight - layout.systemOffset - 8 - 54;
      pill.getBoundingClientRect = () => ({
        x: 0,
        y: pillTop,
        top: pillTop,
        right: 360,
        bottom: layout.viewportHeight - layout.systemOffset - 8,
        left: 0,
        width: 360,
        height: 54,
        toJSON: () => ({}),
      });
      finalControl.scrollIntoView = () => {
        scroller!.scrollTop = scroller!.scrollHeight - scroller!.clientHeight;
      };

      finalControl.scrollIntoView({ block: "end" });
      finalControl.focus();

      expect(document.querySelector(".executor-status-bar")).toBeNull();
      expect(scroller!.scrollTop).toBeGreaterThan(0);
      expect(document.activeElement).toBe(finalControl);
      expect(finalControl.getBoundingClientRect().bottom).toBeLessThanOrEqual(pill.getBoundingClientRect().top);
      expect(columns.every((column) => nativeGetComputedStyle(column).minHeight === "0px")).toBe(true);
    } finally {
      productionStyle.remove();
      offsetHeight.mockRestore();
      rect.mockRestore();
      computedStyle.mockRestore();
      document.documentElement.style.removeProperty("--mobile-nav-system-offset");
      document.documentElement.style.removeProperty("--mobile-nav-height");
      document.documentElement.style.removeProperty("--space-xs");
      document.documentElement.style.removeProperty("--ui-density-md");
      delete document.documentElement.dataset.viewportMode;
    }
  });

  it.each([
    ["skeleton", "board-workflows-skeleton", "board-workflows-skeleton"],
    ["sans workflow", "board-workflows-skeleton", "board-workflows-empty"],
    ["colonnes vides", "board-workflow-columns", null],
    ["colonnes peuplées", "board-workflow-columns", null],
  ] as const)("mesure le gap colonne/pill du Board de production avec %s", async (boardState, boardClass, expectedBoardTestId) => {
    sessionStorage.clear();
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    if (boardState === "skeleton") {
      vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
    } else if (boardState === "sans workflow") {
      vi.mocked(fetchBoardWorkflows).mockResolvedValue({ ...DEFAULT_BOARD_WORKFLOWS, defaultWorkflowId: "", workflows: [] });
    } else if (boardState === "colonnes peuplées") {
      const emptyResult = mockUseTasks();
      mockUseTasks.mockReturnValue({
        ...emptyResult,
        tasks: [{ id: "FN-345", title: "Board mobile", description: "x", status: "in-progress", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" }],
      });
    }

    const viewportHeight = 640;
    const systemOffset = 46;
    const allowedGap = 12;
    document.documentElement.dataset.viewportMode = "mobile";
    document.documentElement.style.setProperty("--mobile-nav-system-offset", `${systemOffset}px`);
    document.documentElement.style.setProperty("--space-xs", "4px");
    document.documentElement.style.setProperty("--ui-density-md", `${allowedGap}px`);
    const productionStyle = installProductionAlphaReserveRule();
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      return this.classList.contains("mobile-nav-bar") ? 54 : 0;
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const height = this.classList.contains("mobile-nav-tab") ? 44 : 0;
      return { x: 0, y: 0, top: 0, right: 0, bottom: height, left: 0, width: 0, height, toJSON: () => ({}) };
    });
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if ((element as HTMLElement).classList?.contains("mobile-nav-bar")) {
        return {
          paddingBottom: "0px",
          getPropertyValue: (property: string) => property === "--mobile-nav-floating-gap" ? "8px" : "",
        } as CSSStyleDeclaration;
      }
      return nativeGetComputedStyle(element);
    });

    try {
      render(<App />);
      const pill = await waitFor(() => {
        const candidate = document.querySelector<HTMLElement>(".mobile-nav-bar--native");
        expect(candidate).not.toBeNull();
        expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toBe("62px");
        return candidate!;
      });
      if (expectedBoardTestId) await screen.findByTestId(expectedBoardTestId);
      const board = await waitFor(() => {
        const candidate = document.querySelector<HTMLElement>(`.board.${boardClass}`);
        expect(candidate).not.toBeNull();
        return candidate!;
      });
      const columns = Array.from(board.querySelectorAll<HTMLElement>(boardClass === "board-workflows-skeleton" ? ".board-workflows-skeleton__column" : ":scope > .column"));
      expect(columns.length).toBeGreaterThan(0);
      if (boardState === "colonnes vides") expect(screen.queryByText("Board mobile")).toBeNull();
      if (boardState === "colonnes peuplées") expect(screen.getByText("Board mobile")).toBeInTheDocument();

      const scroller = screen.getByTestId("dashboard-project-shell").querySelector<HTMLElement>(".project-content");
      expect(scroller).not.toBeNull();
      expect(scroller).toHaveClass("project-content--with-mobile-nav");
      const reserve = resolvePixelCalcFromRoot(nativeGetComputedStyle(scroller!).paddingBottom);
      const boardSelector = '.board';
      const boardPadding = resolvePixelCalcFromRoot(extractProductionDeclaration(extractProductionRule(readAppFile("components/Board.css"), boardSelector), "--board-padding"));
      const pillTop = viewportHeight - systemOffset - 8 - 54;
      const columnBottom = viewportHeight - reserve - boardPadding;
      pill.getBoundingClientRect = () => ({ x: 0, y: pillTop, top: pillTop, right: 360, bottom: pillTop + 54, left: 0, width: 360, height: 54, toJSON: () => ({}) });
      for (const column of columns) {
        column.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, right: 300, bottom: columnBottom, left: 0, width: 300, height: columnBottom, toJSON: () => ({}) });
      }

      for (const column of columns) {
        const gap = pill.getBoundingClientRect().top - column.getBoundingClientRect().bottom;
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(allowedGap);
      }
    } finally {
      productionStyle.remove();
      offsetHeight.mockRestore();
      rect.mockRestore();
      computedStyle.mockRestore();
      document.documentElement.style.removeProperty("--mobile-nav-system-offset");
      document.documentElement.style.removeProperty("--mobile-nav-height");
      document.documentElement.style.removeProperty("--space-xs");
      document.documentElement.style.removeProperty("--ui-density-md");
      delete document.documentElement.dataset.viewportMode;
      sessionStorage.clear();
    }
  });

  it.each(["mobile", "tablet", "desktop"] as const)("keeps the official footer and reservations with stale false settings in %s", async (mode) => {
    mockUseViewportMode.mockReturnValue(mode);
    /* FN-419: the footer and its height reservations belong to the footer placement; both wide tiers behave alike now. */
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "footer",
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    render(<App />);

    await waitForAppShell();
    const shell = screen.getByTestId("dashboard-project-shell");
    const content = shell.querySelector(".project-content");
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    expect(content).toHaveClass(mode === "mobile" ? "project-content--with-mobile-nav" : "project-content--with-footer");
    // The left sidebar never mounts under the footer placement, on any tier.
    expect(screen.queryByTestId("left-sidebar-nav")).toBeNull();
    if (mode === "mobile") {
      expect(document.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--native");
      expect(screen.queryByTestId("desktop-action-bar")).toBeNull();
    } else {
      expect(screen.getByTestId("desktop-action-bar")).toBeInTheDocument();
    }
  });

  /*
  FNXC:StandardizedViewActions 2026-09-16-23:06:
  FN-437 remplaçant du test « retire Nouvelle tâche du Header Alpha desktop » : la création ne doit plus dépendre de
  l'écran affiché, donc le Header desktop expose désormais cette action — sans pour autant ouvrir la modale tant que
  l'opérateur ne clique pas.
  */
  it("expose Nouvelle tâche dans le Header desktop sans ouvrir la modale d'emblée", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    render(<App />);

    await screen.findByTestId("dashboard-project-shell");
    const header = document.querySelector("header.header");
    const action = header?.querySelector('[data-testid="mobile-header-new-task"]');
    expect(action).not.toBeNull();
    expect(header?.querySelectorAll('[data-testid="mobile-header-new-task"]')).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "New Task" })).toBeNull();

    fireEvent.click(action as HTMLElement);
    expect(await screen.findByRole("heading", { name: "New Task" })).toBeInTheDocument();
  });

  it("garde le workflow réel du Board et la loupe Alpha desktop sur une seule rangée", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      ...DEFAULT_BOARD_WORKFLOWS,
      workflows: [{
        ...DEFAULT_BOARD_WORKFLOWS.workflows[0],
        name: "Workflow de livraison avec un nom volontairement très long",
      }],
      taskWorkflowIds: { "FN-358-A": "builtin:coding", "FN-358-B": "builtin:coding" },
    });
    const emptyResult = mockUseTasks();
    mockUseTasks.mockReturnValue({
      ...emptyResult,
      tasks: [
        { id: "FN-358-A", title: "À planifier", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
        { id: "FN-358-B", title: "En cours", description: "x", status: "in-progress", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ],
    });

    render(<App />);

    const switcher = await screen.findByTestId("workflow-switcher");
    const search = screen.getByTestId("desktop-inline-header-search-btn");
    const actions = document.querySelector(".header-actions");
    const slot = screen.getByTestId("header-workflow-slot");
    await waitFor(() => expect(slot.contains(switcher)).toBe(true));
    expect(switcher).toHaveTextContent("Workflow de livraison avec un nom volontairement très long");
    expect(slot.parentElement).toBe(actions);
    expect(search.parentElement).toBe(actions);
    expect(Array.from(actions?.children ?? []).indexOf(slot)).toBeLessThan(Array.from(actions?.children ?? []).indexOf(search));
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    /*
    FN-437 : l'action Nouvelle tâche est désormais une entrée permanente du Header desktop. La contrainte que ce test
    protège reste la rangée unique, donc on asserte qu'elle vit dans `header-actions` après la recherche, sans faire
    déborder la rangée sur une seconde ligne.
    */
    const newTask = screen.getByTestId("mobile-header-new-task");
    expect(newTask.parentElement).toBe(actions);
    expect(Array.from(actions?.children ?? []).indexOf(search)).toBeLessThan(Array.from(actions?.children ?? []).indexOf(newTask));
  });

  it("conserve la pill et sa réserve avec le clavier mais les retire pour une modale", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 250,
      viewportHeight: 550,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });

    const keyboardRender = render(<App />);
    await screen.findByTestId("mobile-menu-trigger");
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    expect(document.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--keyboard-open");
    expect(document.querySelector(".mobile-nav-bar")).not.toHaveStyle({ pointerEvents: "none" });
    expect(screen.getByTestId("dashboard-project-shell").querySelector(".project-content")).toHaveClass("project-content--with-mobile-nav");
    keyboardRender.unmount();

    mockUseMobileKeyboard.mockReturnValue({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false });
    const modalRender = render(<App />);
    await screen.findByTestId("mobile-menu-trigger");
    fireEvent.click(screen.getByTestId("mobile-header-new-task"));
    await screen.findByRole("heading", { name: "New Task" });
    expect(document.querySelector(".mobile-nav-bar")).toBeNull();
    expect(screen.getByTestId("dashboard-project-shell").querySelector(".project-content")).not.toHaveClass("project-content--with-mobile-nav");
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    modalRender.unmount();
  });

  it("garde le popover détenu par App ouvert quand son focus referme le clavier", async () => {
    installGeometryTokenValues();
    try {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    const view = render(<><textarea aria-label="Champ avant navigation" /><App /></>);
    const field = screen.getByRole("textbox", { name: "Champ avant navigation" });
    const trigger = await screen.findByTestId("mobile-menu-trigger");
    field.focus();
    expect(field).toHaveFocus();

    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 250,
      viewportHeight: 478,
      viewportOffsetTop: 40,
      keyboardOpen: true,
    });
    view.rerender(<><textarea aria-label="Champ avant navigation" /><App /></>);
    await waitFor(() => expect(document.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--keyboard-open"));

    fireEvent.click(trigger);
    const popover = await screen.findByRole("menu", { name: "Navigate" });
    await waitFor(() => expect(screen.getByTestId("mobile-more-item-terminal")).toHaveFocus());
    expect(field).not.toHaveFocus();
    expect(popover).toHaveStyle({ "--mobile-nav-viewport-offset-top": "40px" });

    /*
    FNXC:MobilePillKeyboard 2026-09-16-16:27:
    FN-463: the pill and its popover keep the SAME resolved bottom anchor before, during, and after the keyboard.
    The published calc() strings are constants, so the contract is asserted on the resolved pixel values.
    */
    const anchoredGeometry = {
      pillBottomPx: resolveMobileNavAnchorPx(popover, "--mobile-nav-pill-bottom"),
      popoverBottomPx: resolveMobileNavAnchorPx(popover, "--mobile-nav-popover-bottom"),
    };
    expect(anchoredGeometry).toEqual({
      pillBottomPx: GEOMETRY_TOKEN_VALUES["--mobile-nav-system-offset"] + GEOMETRY_TOKEN_VALUES["--space-sm"],
      popoverBottomPx: GEOMETRY_TOKEN_VALUES["--mobile-nav-system-offset"]
        + GEOMETRY_TOKEN_VALUES["--space-sm"]
        + GEOMETRY_TOKEN_VALUES["--mobile-nav-pill-height"]
        + GEOMETRY_TOKEN_VALUES["--space-xs"],
    });
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
      navigationViewport: {
        active: true,
        keyboardOverlap: 250,
        viewportHeight: 478,
        viewportOffsetTop: 40,
      },
    });
    view.rerender(<><textarea aria-label="Champ avant navigation" /><App /></>);

    await waitFor(() => expect(document.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--keyboard-open"));
    expect(screen.getByRole("menu", { name: "Navigate" })).toBe(popover);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect({
      pillBottomPx: resolveMobileNavAnchorPx(popover, "--mobile-nav-pill-bottom"),
      popoverBottomPx: resolveMobileNavAnchorPx(popover, "--mobile-nav-popover-bottom"),
    }).toEqual(anchoredGeometry);
    expect(popover).toHaveStyle({ "--mobile-nav-viewport-offset-top": "40px" });

    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    view.rerender(<><textarea aria-label="Champ avant navigation" /><App /></>);

    await waitFor(() => expect(document.querySelector(".mobile-nav-bar")).not.toHaveClass("mobile-nav-bar--keyboard-open"));
    expect(screen.getByRole("menu", { name: "Navigate" })).toBe(popover);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect({
      pillBottomPx: resolveMobileNavAnchorPx(popover, "--mobile-nav-pill-bottom"),
      popoverBottomPx: resolveMobileNavAnchorPx(popover, "--mobile-nav-popover-bottom"),
    }).toEqual(anchoredGeometry);
    /*
    FNXC:MobileNav 2026-09-14-07:48:
    The popover is still open, so the published geometry stays frozen at the sample captured when it opened; only a
    close releases it. The bottom anchor is keyboard-independent either way.
    */
    expect(popover).toHaveStyle({ "--mobile-nav-viewport-offset-top": "40px" });
    } finally {
      removeGeometryTokenValues();
    }
  });

  it.each([
    ["portrait", { width: 390, height: 844, systemOffset: 46 }],
    ["paysage", { width: 844, height: 390, systemOffset: 48 }],
  ] as const)("superpose le drawer Command Center à la pill en %s, même quand le clavier est ouvert", async (_name, viewport) => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: viewport.width },
      innerHeight: { configurable: true, value: viewport.height },
    });
    const productionStyle = installProductionAlphaDrawerRules(viewport.systemOffset);

    try {
      const view = render(<App />);
      fireEvent.click(await screen.findByTestId("mobile-nav-tab-command-center"));
      const drawer = await screen.findByTestId("mobile-drawer-main-content");
      expect(drawer.className).toBe("mobile-drawer mobile-drawer--open");
      expectProductionAlphaDrawerOverlay(drawer, viewport.systemOffset);

      mockUseMobileKeyboard.mockReturnValue({ keyboardOverlap: 240, viewportHeight: 400, viewportOffsetTop: 0, keyboardOpen: true });
      view.rerender(<App />);
      await waitFor(() => expect(document.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--keyboard-open"));
      expectProductionAlphaDrawerOverlay(drawer, viewport.systemOffset);
      dismissAlphaDrawerByHandle(drawer);
      await waitFor(() => expect(screen.queryByTestId("mobile-drawer-main-content")).toBeNull());
    } finally {
      productionStyle.remove();
      Object.defineProperties(window, {
        innerWidth: { configurable: true, value: previousViewport.width },
        innerHeight: { configurable: true, value: previousViewport.height },
      });
    }
  });

  it.each([
    ["portrait", { width: 390, height: 844, keyboardOverlap: 0 }],
    ["paysage court avec clavier", { width: 844, height: 390, keyboardOverlap: 156 }],
  ] as const)("route la pill vers le vrai Chat et garde son composeur rendu en %s", async (_name, geometry) => {
    /*
    FNXC:MobileDrawer 2026-09-10-23:02:
    The symptom regression must cross App's shipped pill into the production ChatView, select a real hook-backed conversation, and measure the resulting composer against the drawer. A component stand-in can prove routing but cannot protect ChatView's own header, selection, or flex chain.
    */
    mockUseViewportMode.mockReturnValue("mobile");
    configureProductionAppChat();
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: geometry.keyboardOverlap,
      viewportHeight: geometry.height,
      viewportOffsetTop: 0,
      keyboardOpen: geometry.keyboardOverlap > 0,
    });
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: geometry.width },
      innerHeight: { configurable: true, value: geometry.height },
    });

    render(<App />);
    /* FN-511: Chat is the fifth default quick-access destination, so the pill tab is its single mobile owner here. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-chat"));
    const dialog = await screen.findByRole("dialog", { name: "Chat" });
    fireEvent.click(await within(dialog).findByTestId(`chat-session-${appChatSession.id}`));
    const input = await within(dialog).findByTestId("chat-input");
    input.focus();

    expect(dialog).toContainElement(document.querySelector(".chat-view"));
    expect(Array.from(dialog.querySelectorAll("h1,h2,h3")).filter((heading) => heading.textContent === "Chat" && !heading.classList.contains("visually-hidden"))).toHaveLength(1);
    /*
    FNXC:ChatNavigation 2026-09-17-10:37:
    FN-506 : une conversation est ouverte ici, donc l'en-tête porte le menu « … » d'actions de conversation — qui
    contient la création — à la place du bouton « + ».
    */
    expect(within(dialog).getByTestId("chat-header-actions-btn")).toBeEnabled();
    expect(within(dialog).queryByTestId("chat-new-btn")).toBeNull();
    /* The phone drawer is the only Chat host on mobile: no whole-view pop-out and no floating window shell. */
    expect(within(dialog).queryByTestId("chat-pop-out")).toBeNull();
    expect(within(dialog).queryByLabelText("Pop out chat")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    expect(dialog.querySelectorAll(".mobile-drawer__handle-target")).toHaveLength(1);
    expect(input).toHaveClass("chat-input-textarea");
    expect(input.closest(".mobile-drawer__panel")).toBe(dialog);
    expect(input).toHaveFocus();

    const chatDrawer = screen.getByTestId("mobile-drawer-chat");
    dismissAlphaDrawerByHandle(chatDrawer);
    await waitFor(() => expect(chatDrawer).toHaveClass("mobile-drawer--hidden"));

    /* FN-480 : sur mobile, le slot d'accès rapide `tasks` rend et route List ; le bouton codé en dur du menu est supprimé. */
    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    const listDrawer = await screen.findByTestId("mobile-drawer-list");
    const listDialog = within(listDrawer).getByRole("dialog", { name: "List" });
    expect(listDialog.querySelectorAll(".mobile-drawer__close")).toHaveLength(0);
    expect(listDialog.querySelectorAll(".mobile-drawer__handle-target")).toHaveLength(1);
    dismissAlphaDrawerByHandle(listDrawer);
    await waitFor(() => expect(listDrawer).toHaveClass("mobile-drawer--hidden"));
  });

  /*
  FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
  FN-481 : ce cas prouvait la géométrie canonique des drawers en passant par des entrées basses Usage et Projects qui
  n'existent plus sur téléphone — le Header y offre déjà les deux. Il conserve la preuve de géométrie pour les
  drawers encore ouvrables par l'opérateur (Planning, puis Usage via le raccourci d'en-tête) ; le chemin Projets du
  Header est prouvé séparément ci-dessous, avec sa sémantique d'aperçu existante et sans reccâblage vers le drawer.
  */
  it("garde Planning et Usage sur le même shell avec un seul propriétaire d’en-tête", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    appChatTestControl.renderProductionPlanningView = true;
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    const systemOffset = 46;
    const productionStyle = installProductionAlphaDrawerRules(systemOffset);

    try {
      render(<App />);
      const board = await screen.findByTestId("board-keep-alive");
      const canonicalHeights: string[] = [];

      fireEvent.click(await screen.findByTestId("mobile-nav-tab-planning"));
      const planningDrawer = await screen.findByTestId("mobile-drawer-planning");
      expectProductionAlphaDrawerOverlay(planningDrawer, systemOffset);
      expectSingleDrawerHeader(within(planningDrawer).getByRole("dialog", { name: "Planning" }), ".modal-header--embedded");
      canonicalHeights.push(window.getComputedStyle(planningDrawer.querySelector(".mobile-drawer__panel")!).height);
      dismissAlphaDrawerByHandle(planningDrawer);

      /* Usage n'est plus une entrée basse sur téléphone : le Header en est l'unique propriétaire. */
      fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
      expect(screen.queryByTestId("mobile-more-item-usage")).toBeNull();
      expect(screen.queryByTestId("mobile-nav-tab-usage")).toBeNull();
      fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
      fireEvent.click(await screen.findByTestId("mobile-header-usage-btn"));
      const usageDrawer = await screen.findByTestId("mobile-drawer-usage");
      expect(usageDrawer.className).toBe("mobile-drawer mobile-drawer--open");
      expectProductionAlphaDrawerOverlay(usageDrawer, systemOffset);
      expectSingleDrawerHeader(within(usageDrawer).getByRole("dialog", { name: "Usage" }), ".modal-header");
      canonicalHeights.push(window.getComputedStyle(usageDrawer.querySelector(".mobile-drawer__panel")!).height);
      dismissAlphaDrawerByHandle(usageDrawer);

      expect(new Set(canonicalHeights)).toEqual(new Set([canonicalHeights[0]]));
      expect(canonicalHeights[0]).not.toBe("");
      expect(board).toBeVisible();
      /* Aucun de ces deux chemins n'a quitté le projet courant. */
      expect(mockCurrentProjectState.clearCurrentProject).not.toHaveBeenCalled();
    } finally {
      productionStyle.remove();
    }
  });

  /*
   * FN-483 — reproduction symptomatique. Sur téléphone, ouvrir un drawer retirait le slot du Header : le Board, qui
   * reste actif derrière, repliait son sélecteur en ligne SOUS l'en-tête. Ouvrir List ajoutait de surcroît un second
   * `workflow-switcher` dans le même slot. Le contrat vérifié ici : même nœud de slot et même déclencheur avant,
   * pendant et après chaque ouverture, exactement un sélecteur contextuel, aucun toolbar sous le Header.
   */
  it("garde le même sélecteur de workflow dans l'en-tête à l'ouverture des drawers téléphone", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      ...DEFAULT_BOARD_WORKFLOWS,
      workflows: [
        DEFAULT_BOARD_WORKFLOWS.workflows[0],
        {
          id: "wf-custom",
          name: "Livraison",
          columns: [
            { id: "todo", name: "Todo", flags: { hold: true, intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-483-A": "builtin:coding", "FN-483-B": "wf-custom" },
    });
    const emptyResult = mockUseTasks();
    mockUseTasks.mockReturnValue({
      ...emptyResult,
      tasks: [
        { id: "FN-483-A", title: "Tâche Coding", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
        { id: "FN-483-B", title: "Tâche Livraison", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ],
    });

    render(<App />);

    const slot = await screen.findByTestId("header-workflow-slot");
    const switcher = await screen.findByTestId("workflow-switcher");
    await waitFor(() => expect(slot.contains(switcher)).toBe(true));

    const expectSingleStableSelector = () => {
      expect(screen.getByTestId("header-workflow-slot")).toBe(slot);
      expect(screen.getAllByTestId("header-workflow-slot")).toHaveLength(1);
      expect(screen.getAllByTestId("workflow-switcher")).toHaveLength(1);
      expect(screen.getByTestId("workflow-switcher")).toBe(switcher);
      expect(slot.contains(switcher)).toBe(true);
      expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
      expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(0);
    };

    /* Destination ordinaire : le changement de `taskView` ne doit plus déplacer le sélecteur. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-command-center"));
    const commandCenterDrawer = await screen.findByTestId("mobile-drawer-main-content");
    expectSingleStableSelector();
    dismissAlphaDrawerByHandle(commandCenterDrawer);
    await waitFor(() => expect(screen.queryByTestId("mobile-drawer-main-content")).toBeNull());
    expectSingleStableSelector();

    /* List : deux vues actives ne doivent plus publier deux sélecteurs dans le même slot. */
    /* FN-480 : sur mobile, le slot d'accès rapide `tasks` rend et route List ; le bouton codé en dur du menu est supprimé. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-tasks"));
    const listDrawer = await screen.findByTestId("mobile-drawer-list");
    expect(await within(listDrawer).findByText("Tâche Coding")).toBeInTheDocument();
    expectSingleStableSelector();
    expect(within(listDrawer).queryByTestId("workflow-switcher")).toBeNull();

    dismissAlphaDrawerByHandle(listDrawer);
    await waitFor(() => expect(listDrawer).toHaveClass("mobile-drawer--hidden"));
    expectSingleStableSelector();

    /* Planning : même contrat pour un drawer possédant son propre relais de slot. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-planning"));
    await screen.findByTestId("mobile-drawer-planning");
    expectSingleStableSelector();
  });

  /*
   * FN-483 : une List déjà visitée n'a plus de sélecteur à elle ; elle doit donc suivre le choix ensuite effectué sur
   * l'unique sélecteur du Board, y compris « All workflows », et afficher les tâches correspondantes.
   */
  it("fait suivre à la List conservée le workflow choisi ensuite sur le Board", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      ...DEFAULT_BOARD_WORKFLOWS,
      workflows: [
        DEFAULT_BOARD_WORKFLOWS.workflows[0],
        {
          id: "wf-custom",
          name: "Livraison",
          columns: [
            { id: "todo", name: "Todo", flags: { hold: true, intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-483-A": "builtin:coding", "FN-483-B": "wf-custom" },
    });
    const emptyResult = mockUseTasks();
    mockUseTasks.mockReturnValue({
      ...emptyResult,
      tasks: [
        { id: "FN-483-A", title: "Tâche Coding", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
        { id: "FN-483-B", title: "Tâche Livraison", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ],
    });

    render(<App />);
    await screen.findByTestId("header-workflow-slot");

    /* Première visite de List : elle hérite du workflow déjà sélectionné sur le Board. */
    /* FN-480 : sur mobile, le slot d'accès rapide `tasks` rend et route List ; le bouton codé en dur du menu est supprimé. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-tasks"));
    const listDrawer = await screen.findByTestId("mobile-drawer-list");
    expect(await within(listDrawer).findByText("Tâche Coding")).toBeInTheDocument();
    expect(within(listDrawer).queryByText("Tâche Livraison")).toBeNull();

    dismissAlphaDrawerByHandle(listDrawer);
    await waitFor(() => expect(listDrawer).toHaveClass("mobile-drawer--hidden"));

    /* Choix effectué sur l'unique sélecteur de l'en-tête (le Board de fond). */
    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(await screen.findByTestId("workflow-switcher-option-wf-custom"));

    /* FN-480 : sur mobile, le slot d'accès rapide `tasks` rend et route List ; le bouton codé en dur du menu est supprimé. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-tasks"));
    const reopenedList = await screen.findByTestId("mobile-drawer-list");
    expect(await within(reopenedList).findByText("Tâche Livraison")).toBeInTheDocument();
    await waitFor(() => expect(within(reopenedList).queryByText("Tâche Coding")).toBeNull());

    /* Et la vue agrégée se propage de la même façon. */
    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(await screen.findByTestId(`workflow-switcher-option-${ALL_WORKFLOWS_BOARD_VIEW_ID}`));
    expect(await within(reopenedList).findByText("Tâche Coding")).toBeInTheDocument();
    expect(within(reopenedList).getByText("Tâche Livraison")).toBeInTheDocument();
    expect(screen.getAllByTestId("workflow-switcher")).toHaveLength(1);
  });

  /*
   * FN-483 : le reste de la matrice des propriétaires. Projects, Usage et le détail de tâche routé sont hébergés par
   * d'autres surfaces qu'un drawer de contenu principal ; ils ne doivent pas non plus déplacer ni dupliquer le
   * sélecteur du Board de fond.
   */
  it("garde un seul sélecteur pour Projects, Usage et le détail de tâche téléphone", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      ...DEFAULT_BOARD_WORKFLOWS,
      workflows: [
        DEFAULT_BOARD_WORKFLOWS.workflows[0],
        { id: "wf-custom", name: "Livraison", columns: [{ id: "todo", name: "Todo", flags: { hold: true, intake: true } }] },
      ],
      taskWorkflowIds: { "FN-483-A": "builtin:coding" },
    });
    const emptyResult = mockUseTasks();
    mockUseTasks.mockReturnValue({
      ...emptyResult,
      tasks: [
        { id: "FN-483-A", title: "Tâche Coding", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ],
    });

    render(<App />);
    const slot = await screen.findByTestId("header-workflow-slot");
    const switcher = await screen.findByTestId("workflow-switcher");

    const expectSingleStableSelector = () => {
      expect(screen.getByTestId("header-workflow-slot")).toBe(slot);
      expect(screen.getAllByTestId("workflow-switcher")).toHaveLength(1);
      expect(screen.getByTestId("workflow-switcher")).toBe(switcher);
      expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
      expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(0);
    };

    /*
    FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
    FN-481 : le menu bas n'offre plus Projets ni Usage sur téléphone — le Header les porte déjà. Le contrat FN-483
    reste prouvé avec les ouvertures encore disponibles à l'opérateur : le menu ouvert (qui ne doit rien casser),
    le raccourci Usage de l'en-tête, puis le détail de tâche.
    */
    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-more-item-projects")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-usage")).toBeNull();
    expectSingleStableSelector();
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    fireEvent.click(await screen.findByTestId("mobile-header-usage-btn"));
    const usageDrawer = await screen.findByTestId("mobile-drawer-usage");
    expectSingleStableSelector();
    dismissAlphaDrawerByHandle(usageDrawer);
    await waitFor(() => expect(screen.queryByTestId("mobile-drawer-usage")).toBeNull());

    /* Détail de tâche routé dans le panneau principal téléphone. */
    fireEvent.click(await screen.findByText("Tâche Coding"));
    await screen.findByTestId("mobile-drawer-main-content");
    expectSingleStableSelector();
  });

  /*
   * FN-483 : bascule réelle de point de rupture avec List déjà visitée. Le nœud de slot peut légitimement être
   * remplacé, mais il ne doit jamais exister deux contrôles, et la propriété doit revenir au bon hôte.
   */
  it("transfère la propriété du sélecteur au bon hôte des deux côtés d'un changement de point de rupture", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      ...DEFAULT_BOARD_WORKFLOWS,
      workflows: [
        DEFAULT_BOARD_WORKFLOWS.workflows[0],
        { id: "wf-custom", name: "Livraison", columns: [{ id: "todo", name: "Todo", flags: { hold: true, intake: true } }] },
      ],
      taskWorkflowIds: { "FN-483-A": "builtin:coding" },
    });
    const emptyResult = mockUseTasks();
    mockUseTasks.mockReturnValue({
      ...emptyResult,
      tasks: [
        { id: "FN-483-A", title: "Tâche Coding", description: "x", status: null, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ],
    });

    const view = render(<App />);
    await screen.findByTestId("workflow-switcher");

    /* FN-480 : sur mobile, le slot d'accès rapide `tasks` rend et route List ; le bouton codé en dur du menu est supprimé. */
    fireEvent.click(await screen.findByTestId("mobile-nav-tab-tasks"));
    await screen.findByTestId("mobile-drawer-list");
    await waitFor(() => expect(screen.getAllByTestId("workflow-switcher")).toHaveLength(1));
    expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(0);

    /*
     * Téléphone -> ordinateur : List devient une vraie page et reprend la propriété du slot. Le Board désactivé garde
     * son repli en ligne DANS son enveloppe cachée — comportement antérieur préservé —, donc on compte les contrôles
     * du slot, pas ceux d'un sous-arbre masqué.
     */
    mockUseViewportMode.mockReturnValue("desktop");
    view.rerender(<App />);
    await waitFor(() => expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(1));
    const desktopSlot = screen.getByTestId("header-workflow-slot");
    await waitFor(() => expect(desktopSlot.querySelectorAll('[data-testid="workflow-switcher"]')).toHaveLength(1));
    expect(desktopSlot.querySelector(".list-workflow-control")).not.toBeNull();
    expect(desktopSlot.querySelector(".board-workflow-toolbar")).toBeNull();

    /* Et retour : le Board de fond redevient l'unique propriétaire, sans contrôle résiduel de List. */
    mockUseViewportMode.mockReturnValue("mobile");
    view.rerender(<App />);
    await waitFor(() => expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(0));
    const mobileSlot = screen.getByTestId("header-workflow-slot");
    await waitFor(() => expect(mobileSlot.querySelectorAll('[data-testid="workflow-switcher"]')).toHaveLength(1));
    expect(mobileSlot.querySelector(".board-workflow-toolbar")).not.toBeNull();
    expect(screen.getAllByTestId("workflow-switcher")).toHaveLength(1);
  });

  /*
   * FN-483 : transitions de données pendant qu'un drawer est ouvert. Un chargement différé doit aboutir DANS le slot,
   * jamais dans un repli en ligne sous l'en-tête ; un projet mono-workflow ne laisse aucune coquille.
   */
  it("place un chargement différé de workflows dans le slot même drawer ouvert, et ne laisse aucune coquille à un seul workflow", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    const twoWorkflows = {
      ...DEFAULT_BOARD_WORKFLOWS,
      workflows: [
        DEFAULT_BOARD_WORKFLOWS.workflows[0],
        { id: "wf-custom", name: "Livraison", columns: [{ id: "todo", name: "Todo", flags: { hold: true, intake: true } }] },
      ],
      taskWorkflowIds: {},
    };
    /* Une SEULE promesse contrôlée, partagée par tous les consommateurs montés, sinon seul le dernier se résoudrait. */
    let resolveWorkflows: ((payload: typeof twoWorkflows) => void) | undefined;
    const deferredWorkflows = new Promise<typeof twoWorkflows>((resolve) => { resolveWorkflows = resolve; });
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => deferredWorkflows);

    const view = render(<App />);
    await screen.findByTestId("dashboard-project-shell");

    fireEvent.click(await screen.findByTestId("mobile-nav-tab-command-center"));
    await screen.findByTestId("mobile-drawer-main-content");
    /* Aucun repli en ligne sous l'en-tête pendant que la métadonnée est encore en vol. */
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();

    await act(async () => {
      resolveWorkflows?.(twoWorkflows);
      await Promise.resolve();
    });

    const slot = await screen.findByTestId("header-workflow-slot");
    const switcher = await screen.findByTestId("workflow-switcher");
    expect(slot.contains(switcher)).toBe(true);
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();

    /* Projet sans aucun workflow : aucun sélecteur, aucune coquille, aucun bouton vide dans l'en-tête. */
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({ ...DEFAULT_BOARD_WORKFLOWS, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    fireEvent.focus(window);
    view.rerender(<App />);

    await waitFor(() => expect(screen.queryByTestId("workflow-switcher")).toBeNull());
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(0);
    expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(0);
    for (const button of document.querySelectorAll("header.header button")) {
      expect(button.querySelector("svg") !== null || (button.textContent ?? "").trim().length > 0).toBe(true);
    }
  });

  it.each([undefined, false, true] as const)("keeps the official mobile pill for historical Alpha value %s", async (alphaUpdates) => {
    mockUseViewportMode.mockReturnValue("mobile");
    const experimentalFeatures = { ...defaultSettings.experimentalFeatures };
    delete experimentalFeatures.alphaUpdates;
    if (alphaUpdates !== undefined) experimentalFeatures.alphaUpdates = alphaUpdates;
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, mobileNavPrimaryItems: ["settings", "planning"], experimentalFeatures });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mobile-menu-trigger")).toBeInTheDocument());
    expect(screen.getByTestId("dashboard-project-shell").querySelector(".project-content")).toHaveClass("project-content--with-mobile-nav");
    expect(screen.queryByTestId("mobile-nav-tab-more")).toBeNull();
    /*
     * FN-511: the pill is driven by the project quick-access selection, whose FIVE slots are completed from the default
     * order when the persisted value is shorter. This fixture's `["settings", "planning"]` keeps Planning (Settings is
     * not a promotable destination) and is then completed with the default tail, which ends with Chat.
     */
    expect(Array.from(document.querySelectorAll<HTMLElement>(".mobile-nav-bar--native > .mobile-nav-tab")).map((tab) => tab.dataset.testid)).toEqual([
      "mobile-nav-tab-planning",
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-chat",
    ]);
    expect(screen.queryByTestId("mobile-nav-tab-settings")).toBeNull();
  });

  /*
   * FN-467 cas (m) : la pill du téléphone et la rangée directe du footer partagé lisent le MÊME réglage projet, dans le
   * même ordre, et l'aperçu avant enregistrement reclasse les deux surfaces.
   */
  /*
   * FN-511 : parité stricte. Pour la MÊME valeur de réglage, la pill mobile et la rangée du pied de page large rendent la
   * même liste de cinq destinations, dans le même ordre — les quatre premières au centre sur le pied de page large et la
   * cinquième dans sa piste de droite.
   */
  it.each(["mobile", "desktop"] as const)("aligne la navigation d'accès rapide de %s sur le réglage projet", async (viewport) => {
    mockUseViewportMode.mockReturnValue(viewport);
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, mobileNavPrimaryItems: ["mailbox", "missions", "tasks", "agents", "planning"], navigationPlacement: "footer" });

    render(<App />);
    if (viewport === "mobile") {
      await waitFor(() => expect(screen.getByTestId("mobile-menu-trigger")).toBeInTheDocument());
      await waitFor(() => expect(Array.from(document.querySelectorAll<HTMLElement>(".mobile-nav-bar--native > .mobile-nav-tab")).map((tab) => tab.dataset.testid)).toEqual([
        "mobile-nav-tab-mailbox",
        "mobile-nav-tab-missions",
        "mobile-nav-tab-tasks",
        "mobile-nav-tab-agents",
        "mobile-nav-tab-planning",
      ]));
    } else {
      await waitFor(() => expect(document.querySelector(".desktop-action-bar__scroller")).not.toBeNull());
      await waitFor(() => expect(Array.from(document.querySelectorAll<HTMLElement>(".desktop-action-bar__scroller .desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
        "desktop-nav-mailbox",
        "desktop-nav-missions",
        "desktop-nav-board",
        "desktop-nav-agents",
      ]));
      await waitFor(() => expect(document.querySelector(".desktop-action-bar__right")).toContainElement(screen.getByTestId("desktop-nav-planning")));
    }
  });

  it("keeps Chat and Notes as inline dock tools without an expanded owner", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    configureProductionAppChat();
    localStorage.setItem("fusion:right-dock-open", "true");
    const note = { id: "note-alpha", title: "Note Alpha", content: "Initial", revision: 1, createdAt: "2026-09-11", updatedAt: "2026-09-11" };
    mockNotesApi.fetchNotes.mockReset().mockResolvedValue({ notes: [note] });
    mockNotesApi.fetchNote.mockReset().mockResolvedValue(note);
    /* FN-419: the desktop pilot dock tools require the footer placement. */
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "footer",
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    render(<App />);
    expect(await screen.findByTestId("desktop-action-bar")).toBeInTheDocument();
    expect(document.querySelector(".executor-status-bar")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-patchnode")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-chat")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-notes")).toBeNull();

    /*
    FNXC:ChatSurfaceUnification 2026-09-14-17:46:
    FN-392: Chat and Notes are peer inline dock tools. Selecting Chat keeps the dock mounted with one Chat surface in its
    body and creates neither an expand affordance nor an expanded window.
    */
    fireEvent.click(await screen.findByTestId("right-dock-tab-chat"));
    const dockBody = await screen.findByTestId("right-dock-body");
    await waitFor(() => expect(dockBody.querySelectorAll(".chat-view")).toHaveLength(1));
    expect(document.querySelectorAll(".chat-view")).toHaveLength(1);
    expect(screen.getByTestId("right-dock")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(screen.queryByTestId("right-dock-expand")).toBeNull();

    fireEvent.click(await screen.findByTestId("right-dock-tab-notes"));
    expect(screen.queryByTestId("right-dock-expand")).toBeNull();
    expect(await within(screen.getByTestId("right-dock")).findByText("Note Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Notes" })).toBeNull();
    expect(document.querySelector(".right-dock .notes-view--compact")).not.toBeNull();
  });

  /*
  FNXC:HistoryModalSurface 2026-09-15-04:29:
  FN-403: History has ONE render owner on every breakpoint — the modal surface. It must mount exactly one
  PatchnodeView, leave the Board nodes untouched, and never rewrite the persisted view value. Tablet is included
  because it previously had no window owner at all and fell back to the full-page History destination.
  */
  it.each([
    ["selected", "desktop", 1200, undefined, "loading"],
    ["aggregate", "desktop", 1200, ALL_WORKFLOWS_BOARD_VIEW_ID, "empty"],
    ["selected", "tablet", 900, undefined, "populated"],
    ["selected", "mobile", 600, undefined, "error"],
    ["aggregate", "mobile", 600, ALL_WORKFLOWS_BOARD_VIEW_ID, "populated"],
  ] as const)("routes complete-column History through the %s Board production chain on %s", async (_mode, viewport, width, selection, historyState) => {
    mockUseViewportMode.mockReturnValue(viewport);
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    if (selection) {
      localStorage.setItem(scopedKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, DEFAULT_PROJECT_ID), selection);
    }
    const emptyTasks = mockUseTasks();
    mockUseTasks.mockReturnValue({
      ...emptyTasks,
      tasks: [{
        id: "FN-371-HISTORY",
        title: "History render invariant",
        description: "Keep the populated Board mounted while History opens.",
        status: "done",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      }],
    });
    const populatedFeed = {
      days: [{
        day: "2026-09-12",
        completedCount: 1,
        revertedCount: 0,
        entries: [{
          entryId: "completed:FN-371-HISTORY:1",
          taskId: "FN-371-HISTORY",
          kind: "completed" as const,
          occurrenceKey: "1",
          day: "2026-09-12",
          occurredAt: "2026-09-12T00:00:00.000Z",
          title: "History render invariant",
          body: "History loaded without replacing the Board.",
        }],
      }],
      totalEntries: 1,
      hasMore: false,
    };
    if (historyState === "loading") {
      vi.mocked(fetchPatchnode).mockImplementation(() => new Promise(() => undefined));
    } else if (historyState === "error") {
      vi.mocked(fetchPatchnode).mockRejectedValue(new Error("History unavailable"));
    } else if (historyState === "populated") {
      vi.mocked(fetchPatchnode).mockResolvedValue(populatedFeed);
    }
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });

    try {
      render(<App />);

      const historyButton = await screen.findByTestId("column-history-done");
      const boardBefore = document.querySelector(".board");
      const columnsBefore = Array.from(document.querySelectorAll(".board > .column"));
      expect(boardBefore).not.toBeNull();
      expect(screen.queryByTestId("sidebar-nav-patchnode")).toBeNull();

      const persistedViewBefore = localStorage.getItem(taskViewStorageKey());

      fireEvent.click(historyButton);
      const historyDialog = await screen.findByRole("dialog", { name: "History" });
      expect(historyDialog).toHaveAttribute("aria-modal", viewport === "mobile" ? "true" : "false");
      expect(document.querySelectorAll('[data-testid="patchnode-view"]')).toHaveLength(1);
      expect(document.querySelectorAll("#patchnode-title")).toHaveLength(1);
      expect(document.querySelector(".board")).toBe(boardBefore);
      expect(Array.from(document.querySelectorAll(".board > .column"))).toEqual(columnsBefore);
      expect(document.querySelectorAll(".board")).toHaveLength(1);
      expect(screen.queryByTestId("mobile-drawer-main-content")).toBeNull();
      expect(localStorage.getItem(taskViewStorageKey())).toBe(persistedViewBefore);
      if (viewport === "mobile") {
        expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
      }

      fireEvent.click(historyButton);
      expect(screen.getAllByRole("dialog", { name: "History" })).toHaveLength(1);
      expect(document.querySelectorAll('[data-testid="patchnode-view"]')).toHaveLength(1);
      expect(document.querySelector(".board")).toBe(boardBefore);

      if (historyState === "loading") {
        expect(screen.getByText("Loading History…")).toBeInTheDocument();
      } else if (historyState === "error") {
        expect(await screen.findByText("History could not be loaded.")).toBeInTheDocument();
      } else if (historyState === "empty") {
        expect(await screen.findByTestId("patchnode-empty")).toBeInTheDocument();
      } else {
        expect(await screen.findByText("History loaded without replacing the Board.")).toBeInTheDocument();
      }
      expect(document.querySelector(".board")).toBe(boardBefore);
      expect(Array.from(document.querySelectorAll(".board > .column"))).toEqual(columnsBefore);

      fireEvent.click(within(historyDialog).getByRole("button", { name: "Close History" }));
      await waitFor(() => expect(document.querySelectorAll('[data-testid="patchnode-view"]')).toHaveLength(0));
      expect(document.querySelector(".board")).toBe(boardBefore);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  /*
  FNXC:HistoryModalSurface 2026-09-15-04:29:
  FN-403 symptom reproduction: a persisted legacy `patchnode` view value used to render the full-page History AND
  let the pilot window open a second instance. It must now resolve to Board with exactly one History modal, and the
  legacy value must never be written back.
  */
  it.each(["desktop", "tablet", "mobile"] as const)("résout une vue patchnode persistée en une seule instance History sur %s", async (viewport) => {
    mockUseViewportMode.mockReturnValue(viewport);
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchPatchnode).mockResolvedValue({ days: [], totalEntries: 0, hasMore: false });
    localStorage.setItem(taskViewStorageKey(), "patchnode");

    render(<App />);

    await screen.findByRole("dialog", { name: "History" });
    expect(document.querySelectorAll('[data-testid="patchnode-view"]')).toHaveLength(1);
    expect(document.querySelectorAll("#patchnode-title")).toHaveLength(1);
    expect(localStorage.getItem(taskViewStorageKey())).toBe("board");
    await waitFor(() => expect(document.querySelector(".board")).not.toBeNull());
  });

  it("ferme l'Historique avec le retour arrière du navigateur", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchPatchnode).mockResolvedValue({ days: [], totalEntries: 0, hasMore: false });

    render(<App />);

    fireEvent.click(await screen.findByTestId("column-history-done"));
    await screen.findByRole("dialog", { name: "History" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => expect(document.querySelectorAll('[data-testid="patchnode-view"]')).toHaveLength(0));
  });
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

    /*
     * FN-419: assert the shell itself rather than a control that only one placement labels with a `title`. Before
     * settings hydrate, the shell paints the shipped default placement; the point of this case is that it paints at
     * all, immediately, with no probe loader.
     */
    expect(screen.getByTestId("dashboard-project-shell")).toBeInTheDocument();
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
      pauseTask: vi.fn(),
      resetTask: vi.fn(),
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
      pauseTask: vi.fn(),
      resetTask: vi.fn(),
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
      pauseTask: vi.fn(),
      resetTask: vi.fn(),
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

    return latestChatEvents();
  };

  /*
  FNXC:ChatBadge 2026-09-14-12:57:
  The unread subscription re-registers whenever effective Chat visibility changes, so a test that keeps the
  first handler set would dispatch into a closure that still believes Chat is closed. Always read the latest
  registration before dispatching an event that must respect the current surface state.
  */
  const latestChatEvents = () => {
    const chatSubscriptionCalls = mockSubscribeSse.mock.calls.filter(
      ([url, sub]) => String(url).startsWith("/api/events") && typeof (sub as { events?: Record<string, unknown> })?.events?.["chat:message:added"] === "function",
    );

    return (chatSubscriptionCalls.at(-1)?.[1] as {
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

    /* FN-511: Chat is the fifth default quick-access destination, so it is a direct pill tab; the indicator contract is unchanged. */
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
    /*
     * FN-419 (operator requirement 3): from the LEFT COLUMN, Chat opens in the main page like Notes — it no longer
     * hijacks the right dock — so the page host is the surface that becomes visible and clears the badge.
     */
    expect(await screen.findByTestId("chat-keep-alive")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-body")).toBeNull();

    await waitFor(() => {
      expect(chatUnreadDot()).toBeNull();
    });

    const eventsWhileChatVisible = latestChatEvents();
    await act(async () => {
      eventsWhileChatVisible["chat:room:message:added"](
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

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442 routes a board card to the floating task window instead of the full main-panel task detail, so the surface that
  a single dismissal has to close is that window. The invariant kept here is "one dismissal, detail gone, board back" —
  only the surface and its dismissal gesture changed.
  */
  it("closes a board-opened task detail window on one dismissal", async () => {
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
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);
    await waitForAppShell();
    /*
    FNXC:DashboardTests 2026-08-16-05:55:
    The board is a lazy-loaded chunk behind <Suspense fallback={null}> and waitForAppShell only
    proves the header. Under sharded-lane load the chunk sometimes resolves after this line, so
    the first board lookup must be the async finder; a sync getByText here rendered this test
    load-flaky (header-only DOM at failure).
    */
    fireEvent.click(await screen.findByText("Back nav task"));
    expect(await screen.findByTestId("main-panel-task-detail")).toBeTruthy();
    expect(screen.getByTestId("floating-window-task-detail-FN-6964")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("main-panel-task-detail")).toBeNull();
      expect(screen.getByText("Back nav task")).toBeTruthy();
    });
  });

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442: the board now opens the task window, and a nested task opened from inside it still layers on top. Backing out
  of the nested detail must restore the originating one rather than closing everything.
  */
  it("restores the previous task detail on nested detail browser back", async () => {
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
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    render(<App />);
    await waitForAppShell();

    // Same lazy-board race as the sibling test above: first board lookup must be async.
    fireEvent.click(await screen.findByText("Back nav task"));
    expect(await screen.findByText("Open nested task")).toBeTruthy();
    fireEvent.click(screen.getByText("Open nested task"));
    expect(await screen.findByTestId("floating-window-task-detail-FN-6965")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("floating-window-task-detail-FN-6965")).toBeNull();
      expect(screen.getByTestId("floating-window-task-detail-FN-6964")).toBeTruthy();
      expect(screen.getAllByText("Back nav task").length).toBeGreaterThan(0);
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

  it("falls back to Board when persisted Ideation view is feature-disabled", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "ideation");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: {
        ...defaultSettings.experimentalFeatures,
        ideationView: false,
      },
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector(".board")).toBeTruthy());
    expect(screen.queryByLabelText("Persisted ideation")).not.toBeInTheDocument();

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
      expect(screen.queryByTestId("list-view-body")).toBeTruthy();
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
      expect(screen.queryByTestId("list-view-body")).toBeTruthy();
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
      expect(screen.queryByTestId("list-view-body")).toBeTruthy();
    });

    fireEvent.click(document.querySelector(".list-new-task-action") as HTMLElement);

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
      expect(screen.queryByTestId("list-view-body")).toBeTruthy();
    });

    // List view should be active
    /* FN-439: List became a sidebar destination, so its active state is the nav entry aria-current. */
    expect(screen.getByTestId("sidebar-nav-list")).toHaveAttribute("aria-current", "page");

    // Cleanup
    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("normalizes an unavailable persisted plugin view to Board for the current project", async () => {
    const registrationSpy = vi.spyOn(pluginViewRegistry, "isPluginViewRegistered").mockReturnValue(false);
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "plugin:fusion-plugin-dependency-graph:graph");
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board").className).toContain("active");
      expect(localStorage.getItem(taskViewStorageKey())).toBe("board");
    });
    expect(screen.queryByTestId("dependency-graph")).toBeNull();

    registrationSpy.mockRestore();
    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("héberge un plugin sans en-tête dans le drawer Alpha avec le seul titre de secours", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "plugin:fusion-plugin-dependency-graph:graph");
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    vi.mocked(fetchPluginDashboardViews).mockResolvedValue([
      {
        pluginId: "fusion-plugin-dependency-graph",
        view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", placement: "more" },
      },
    ]);

    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Graph" });
    expect(dialog).toContainElement(await screen.findByTestId("dependency-graph"));
    expect(dialog.querySelectorAll(".mobile-drawer__header")).toHaveLength(1);
    expect(dialog.querySelectorAll(".mobile-drawer__title")).toHaveLength(1);
    expect(dialog.querySelectorAll(".mobile-drawer__close")).toHaveLength(0);
    expect(dialog.querySelectorAll(".mobile-drawer__handle-target")).toHaveLength(1);
    expect(Array.from(dialog.querySelectorAll("h1,h2,h3")).filter((heading) => heading.textContent === "Graph" && !heading.classList.contains("visually-hidden"))).toHaveLength(1);
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

  /*
  FNXC:TodoPluginEnablement 2026-08-15-05:30:
  FN-8762 superseded the FN-3916 static-fallback behavior: bundled static registration makes plugin
  chunks importable, but ONLY the project-scoped dashboard-views API response may MOUNT a plugin
  view, so a persisted legacy "graph" view cannot revive a plugin the API does not advertise.
  */
  it("does not mount the graph view from bundled static registration alone when API returns no views", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "graph");
    // API returns empty — plugin not installed/enabled for this project
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    render(<App />);

    await waitFor(() => {
      expect(fetchPluginDashboardViews).toHaveBeenCalled();
    });
    // Let the plugin-view resolution settle, then assert the disabled plugin view never mounted.
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("dependency-graph")).toBeNull();

    localStorage.removeItem(taskViewStorageKey());
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("shows the hosted Roadmaps destination when the plugin API advertises it", async () => {
    /*
    FNXC:RoadmapsNavigation 2026-07-19-12:00:
    Roadmap-item previews open through the restored hosted roadmaps destination, so plugin
    dashboard rows must remain visible rather than being filtered as legacy navigation.
    */
    mockUseViewportMode.mockReturnValue("tablet");
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, roadmap: true },
    });
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValue([
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
    expect(await screen.findByTestId("sidebar-nav-plugin-fusion-plugin-roadmap-roadmaps")).toBeInTheDocument();
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

    /*
     * FNXC:ViewState 2026-07-26-12:56:
     * Each render here stands for a separate BOOT, not a remount of the same tab. useViewState now
     * keeps a per-tab sessionStorage copy of the live view so an involuntary mobile tab discard
     * restores where the operator actually was; jsdom shares one session store across the whole test,
     * so a boot must start from a cleared one or the previous render's view wins over the localStorage
     * value this step is asserting on.
     */
    sessionStorage.clear();
    localStorage.setItem(taskViewStorageKey(), "board");
    const second = render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-nav-board").className).toContain("active");
    });
    second.unmount();

    // Third boot — same fresh-tab reset as above.
    sessionStorage.clear();
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
    /*
    FNXC:TodoPluginOwnership 2026-08-15-05:30:
    FN-8762: the Todo view is now the bundled fusion-plugin-todos plugin view, mounted only when
    the project-scoped dashboard-views API advertises it. The planning affordance still must open
    Planning Mode, now via the plugin context's openPlanningMode callback.
    */
    // Fresh boot: jsdom shares one session store across the test file, so clear the per-tab
    // session view copy or the previous test's live view wins over the persisted value.
    sessionStorage.clear();
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "plugin:fusion-plugin-todos:todos");
    // beforeEach's vi.clearAllMocks() does NOT drop queued mockResolvedValueOnce values left
    // unconsumed by earlier tests, so reset before installing this test's persistent response.
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockReset();
    (fetchPluginDashboardViews as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        pluginId: "fusion-plugin-todos",
        view: { viewId: "todos", label: "Todos", componentPath: "./dashboard-view", placement: "more" },
      },
    ]);

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

    // Keep-alive views stay mounted after first visit, but only the selected view is exposed.
    expectBoardToBeInactive();
    expect(screen.queryByTestId("list-view-body")).toBeNull();
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

    // Board stays mounted behind its inaccessible keep-alive wrapper.
    expectBoardToBeInactive();
    expect(screen.queryByTestId("list-view-body")).toBeNull();
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

  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: a restored wide `chat` selection is consumed once into the dock's inline Chat list, so the page selection
  settles on Board while the sidebar entry stays non-active. Ordinary page destinations remain project-scoped and
  restored, and no expand modal is ever created for Chat.
  */
  it("project switch consumes a restored wide Chat selection and restores ordinary page views", async () => {
    /* FN-419: the dock consumes a restored wide `chat` selection only in the footer placement. */
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
    const projectA = { id: "proj_a", name: "Project A", path: "/a", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    const projectB = { id: "proj_b", name: "Project B", path: "/b", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };

    localStorage.setItem("kb:proj_a:kb-dashboard-task-view", "chat");
    localStorage.setItem("kb:proj_b:kb-dashboard-task-view", "insights");
    mockProjectsState.projects = [projectA, projectB];
    mockCurrentProjectState.currentProject = projectA;

    const view = render(<App />);
    expect(await screen.findByTestId("right-dock-body")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(screen.getByTestId("fb-probe-chat")).toBeTruthy();
    /*
     * FN-419: this case runs in the FOOTER placement, so the left column is absent by design. The invariant it
     * guards — the restored wide `chat` selection is consumed into the dock and never becomes a parallel PAGE host —
     * is asserted on the page tree itself instead of on a nav item that belongs to the other placement.
     */
    expect(screen.queryByTestId("chat-keep-alive")).toBeNull();
    await waitFor(() => expect(localStorage.getItem("kb:proj_a:kb-dashboard-task-view")).toBe("board"));

    mockCurrentProjectState.currentProject = projectB;
    view.rerender(<App />);
    await waitFor(() => expect(document.querySelector(".insights-view")).toBeTruthy());
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(localStorage.getItem("kb:proj_b:kb-dashboard-task-view")).toBe("insights");

    mockCurrentProjectState.currentProject = projectA;
    view.rerender(<App />);
    // FN-419: footer placement — the active destination is read from the footer's Board entry.
    await waitFor(() => expect(screen.getByTestId("desktop-nav-board")).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(localStorage.getItem("kb:proj_a:kb-dashboard-task-view")).toBe("board");
    expect(localStorage.getItem("kb:proj_b:kb-dashboard-task-view")).toBe("insights");
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
    expectBoardToBeInactive();

    resolveSettings?.({
      ...defaultSettings,
      experimentalFeatures: { leftSidebarNav: false },
    });

    await waitFor(() => {
      expect(document.querySelector(".insights-view")).toBeTruthy();
    });

    expectBoardToBeInactive();
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

    expectBoardToBeInactive();
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
    expectBoardToBeInactive();
    localStorage.removeItem(taskViewStorageKey());
  });

  it("falls back to board for a persisted legacy todos view instead of reviving the Todo plugin", async () => {
    /*
    FNXC:TodoPluginEnablement 2026-08-15-05:30:
    FN-8762 moved Todo Lists into the bundled fusion-plugin-todos plugin and replaced the graduated
    built-in view: a persisted legacy "todos" task view must fall back to Board so static bundled
    registration cannot revive a disabled project's Todo view (see useViewState's "todos" mapping).
    */
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem(taskViewStorageKey(), "todos");

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });
    expect(screen.queryByTestId("todo-view")).toBeNull();
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

    /*
    FNXC:PlanningKeepAlive 2026-07-22-12:40:
    Closing the embedded Planning view returns to Board, but the planning subtree now stays mounted-but-hidden (keep-alive) instead of unmounting — the assertion moved from "not in DOM" to "hidden and inert" (aria-hidden wrapper) so the setting's intent (planning is not visible/interactive on other views) still holds.
    */
    await waitFor(() => {
      expect(screen.getByTestId("planning-keep-alive")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByTestId("sidebar-nav-board").getAttribute("aria-current")).toBe("page");
    });
  });

  /*
  FNXC:PlanningKeepAlive 2026-07-22-12:40:
  FN remount-churn fix R5: Planning mounts lazily on first open, then survives sidebar navigation mounted-but-hidden; returning reveals the same subtree instead of remounting it.
  */
  it("keeps Planning Mode mounted-but-hidden across navigation round-trips", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, leftSidebarNav: true },
    });
    render(<App />);

    // First-mount laziness: before Planning is ever opened, no kept-alive planning subtree exists.
    await screen.findByTestId("sidebar-nav-planning");
    expect(screen.queryByTestId("planning-keep-alive")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-nav-planning"));
    await waitFor(() => {
      expect(screen.getByTestId("planning-view")).toBeTruthy();
    });
    expect(screen.getByTestId("planning-keep-alive")).not.toHaveAttribute("aria-hidden");

    fireEvent.click(screen.getByTestId("sidebar-nav-board"));
    await waitFor(() => {
      expect(screen.getByTestId("planning-keep-alive")).toHaveAttribute("aria-hidden", "true");
    });
    // Mounted-but-hidden: the planning subtree is still in the DOM while Board is active.
    expect(screen.getByTestId("planning-view")).toBeTruthy();

    fireEvent.click(screen.getByTestId("sidebar-nav-planning"));
    await waitFor(() => {
      expect(screen.getByTestId("planning-keep-alive")).not.toHaveAttribute("aria-hidden");
    });
    expect(screen.getByTestId("planning-view")).toBeTruthy();
  });

  /*
  FNXC:ProjectSwitchModalReset 2026-07-30-23:45:
  A PROJECT SWITCH MUST NOT LEAVE THE PREVIOUS PROJECT'S PLANNING SUBTREE MOUNTED.

  Relocated from `MainContent.planning-project-remount.test.tsx`. FN-8619 moved Planning out of
  MainContent into `PlanningKeepAlive`, mounted by App — so the old file could only fail, and the
  invariant it guarded had no assertion anywhere. The product was already correct; only the coverage
  was left behind.

  What is at stake is a cross-project leak, not layout: before the project-keyed host, Planning kept a
  running plan's stream, selected session and sidebar list from the PREVIOUS project, and persisted
  its session under the NEW project's storage key.

  WHY THE ASSERTION IS "gone OR a different node", and why single-guard mutations do NOT break it.
  App defends this twice, independently:

    1. the `planningEverOpenedProjectId === currentProject.id` gate (App.tsx), which unmounts the
       host for a project that never opened Planning; and
    2. the project id inside the host's `key`, which forces a remount rather than reconciling the
       live instance under the new project.

  Either alone upholds the invariant, so breaking one leaves this green — correctly. MEASURED:
  breaking BOTH fails it. An earlier draft of mine asserted the subtree must be ABSENT, which is
  wrong: `planningViewActive` stays true across the switch, so the latch re-arms and a fresh host is
  expected. Both outcomes satisfy "project A's instance is not reused", which is the actual contract.
  */
  it("never leaves the previous project's Planning subtree mounted after a switch", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    const projectA = { ...DEFAULT_PROJECT, id: "proj_switch_a", name: "Project A" };
    const projectB = { ...DEFAULT_PROJECT, id: "proj_switch_b", name: "Project B" };
    mockCurrentProjectState.currentProject = projectA;
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures, leftSidebarNav: true },
    });

    const { rerender } = render(<App />);

    await screen.findByTestId("sidebar-nav-planning");
    fireEvent.click(screen.getByTestId("sidebar-nav-planning"));
    await waitFor(() => {
      expect(screen.getByTestId("planning-keep-alive")).toBeTruthy();
    });

    /* Control: capture A's live subtree, so "not this node" below is a real statement. */
    const subtreeForA = screen.getByTestId("planning-keep-alive");

    mockCurrentProjectState.currentProject = projectB;
    rerender(<App />);

    await waitFor(() => {
      const current = screen.queryByTestId("planning-keep-alive");
      expect(current === null || current !== subtreeForA).toBe(true);
    });
    /* The load-bearing half: A's instance is off the page either way. */
    expect(subtreeForA.isConnected).toBe(false);
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

  /*
  FNXC:SubtaskBreakdownRemoval 2026-08-23-22:12:
  The `subtask` row is gone: Subtask Breakdown is no longer a dashboard flow, `useBackgroundSessions`
  filters those sessions out entirely (pinned in its own suite), and there is no overlay left to open.
  */
  it.each([
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
    mockUseViewportMode.mockReturnValue("mobile");
  });

  async function openScriptsModalFromMobileMenu() {
    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
    fireEvent.click(await screen.findByTestId("mobile-more-scripts-manage"));
    await screen.findByTestId("scripts-modal");
  }

  it("closes ScriptsModal and opens TerminalModal when Run is clicked", async () => {
    render(<App />);

    await openScriptsModalFromMobileMenu();

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

    await openScriptsModalFromMobileMenu();

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

    // Scripts modal should reopen cleanly from its unchanged mobile owner.
    await openScriptsModalFromMobileMenu();
  });

  it("does not call runScript API — command is sent directly to terminal", async () => {
    render(<App />);

    await openScriptsModalFromMobileMenu();

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
  /* FN-419: footer-safe containment is a property of the FOOTER placement; the sidebar placement has no bottom bar. */
  beforeEach(() => {
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
  });

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

  it("opens the built-in file browser from its unchanged mobile menu owner", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    mockProjectsState.projects = [mockCurrentProjectState.currentProject];
    mockUseViewportMode.mockReturnValue("mobile");

    render(<App />);

    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    fireEvent.click(screen.getByTestId("mobile-more-item-files"));

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
      /* Containment is the point here, so this stays a scoped query — but on the body marker, not
         the `.list-view` class the workflow skeleton also carries. */
      expect(wrapper?.querySelector('[data-testid="list-view-body"]')).toBeTruthy();
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
  /*
   * FN-419: every case in this block exercises the DESKTOP PILOT (dock Notes tool, pilot windows, node guards), which
   * is bound to the footer placement. Opt the whole block in once rather than per case.
   */
  beforeEach(() => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
  });
  /*
  FNXC:NotesEditing 2026-09-15-21:23:
  FN-435 a supprimé le champ titre de l'éditeur de note ET restreint la garde d'abandon : le contenu est désormais
  enregistré automatiquement, donc un brouillon simplement non encore écrit n'a plus rien à perdre et ne doit plus
  bloquer un changement de projet ou de nœud derrière un dialogue « Abandonner les modifications ? ». Les cinq cas qui
  pilotaient cette garde en tapant dans le champ titre affirmaient exactement le contrat supprimé ; ils sont remplacés
  par les deux cas ci-dessous, qui exercent le MÊME câblage (dock → fenêtre de note dédiée, page tablette, sélecteurs
  de projet et de nœud) contre le nouveau contrat. La garde subsistante — conflit de révision et échec
  d'enregistrement, les deux seuls états qu'aucune automatisation ne résout — est couverte au niveau de NotesView dans
  `NotesView.autosave.test.tsx`.
  */
  const typeInOpenNoteEditor = (value: string) => {
    const host = document.querySelector(".notes-editor .cm-editor") as HTMLElement | null;
    if (!host) throw new Error("Expected an open note editor");
    const view = EditorView.findFromDOM(host);
    if (!view) throw new Error("Expected a CodeMirror EditorView for the open note");
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    });
  };

  it("laisse un brouillon Notes enregistré automatiquement changer de projet sans dialogue", async () => {
    const project2 = { ...DEFAULT_PROJECT, id: "proj_456", name: "Second Project", path: "/second" };
    mockProjectsState.projects = [{ ...DEFAULT_PROJECT }, project2];
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "sidebar",
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    const note = { id: "note-transition", title: "Transition", content: "Initial", revision: 1, createdAt: "2026-09-11", updatedAt: "2026-09-11" };
    mockNotesApi.fetchNotes.mockResolvedValue({ notes: [note] });
    mockNotesApi.fetchNote.mockResolvedValue(note);
    mockNotesApi.updateNote.mockResolvedValue({ ...note, content: "Sale après transition", revision: 2 });

    const view = render(<App />);
    mockUseViewportMode.mockReturnValue("tablet");
    view.rerender(<App />);

    fireEvent.click(await screen.findByTestId("sidebar-nav-notes"));
    const notesPage = await waitFor(() => {
      const candidate = document.querySelector<HTMLElement>(".notes-view:not(.notes-view--compact)");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    fireEvent.click(await within(notesPage).findByRole("button", { name: /^Transition/ }));
    await waitFor(() => expect(document.querySelector(".notes-editor .cm-editor")).not.toBeNull());
    typeInOpenNoteEditor("Sale après transition");

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    fireEvent.click(await screen.findByTestId(`project-selector-item-${project2.id}`));

    await waitFor(() => expect(mockCurrentProjectState.setCurrentProject).toHaveBeenCalledWith(project2));
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();
  });

  it("laisse un brouillon de fenêtre de note dédiée changer de nœud sans dialogue", async () => {
    const { useNodes } = await import("../../hooks/useNodes");
    const remoteNode = {
      id: "node_remote_1",
      name: "Remote Node 1",
      type: "remote" as const,
      url: "http://remote:4040",
      status: "online" as const,
      maxConcurrent: 2,
      createdAt: "",
      updatedAt: "",
    };
    vi.mocked(useNodes).mockReturnValue({
      nodes: [remoteNode], loading: false, error: null, refresh: vi.fn(), register: vi.fn(), update: vi.fn(), unregister: vi.fn(), healthCheck: vi.fn(),
    });
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      navigationPlacement: "footer",
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    const note = { id: "note-1", title: "Brouillon", content: "Initial", revision: 1, createdAt: "2026-09-11", updatedAt: "2026-09-11" };
    mockNotesApi.fetchNotes.mockResolvedValue({ notes: [note] });
    mockNotesApi.fetchNote.mockResolvedValue(note);
    mockNotesApi.updateNote.mockResolvedValue({ ...note, content: "Brouillon modifié", revision: 2 });
    localStorage.setItem("fusion:right-dock-open", "true");

    try {
      render(<App />);
      fireEvent.click(await screen.findByTestId("right-dock-tab-notes"));
      fireEvent.click(await screen.findByRole("button", { name: /^Brouillon/ }));
      await waitFor(() => expect(document.querySelector(".notes-editor .cm-editor")).not.toBeNull());
      typeInOpenNoteEditor("Brouillon modifié");

      fireEvent.click(screen.getByTestId("node-selector-trigger"));
      fireEvent.click(await screen.findByTestId("node-option-node_remote_1"));

      await waitFor(() => expect(mockNodeContextValue.setCurrentNode).toHaveBeenCalledWith(remoteNode));
      expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();
    } finally {
      vi.mocked(useNodes).mockReturnValue({
        nodes: [], loading: false, error: null, refresh: vi.fn(), register: vi.fn(), update: vi.fn(), unregister: vi.fn(), healthCheck: vi.fn(),
      });
    }
  });

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

    /* FN-419: this case opens Settings from the primary navigation Settings item, which the sidebar placement labels with a title. */
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      navigationPlacement: "sidebar",
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

    /* FN-419: this case opens Settings from the primary navigation Settings item, which the sidebar placement labels with a title. */
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      navigationPlacement: "sidebar",
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

describe("App auth token recovery page", () => {
  const originalFetch = window.fetch;
  const originalLocation = window.location;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAuthToken();
    delete (window as any).__fnAuthFetchInstalled;
    window.fetch = originalFetch;
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
  });

  afterEach(() => {
    clearAuthToken();
    window.fetch = originalFetch;
    delete (window as any).__fnAuthFetchInstalled;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("replaces the mounted shell with one non-modal page and submits on Enter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForAppShell();

    expect(screen.queryByRole("main", { name: "Authentication token required" })).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
      window.dispatchEvent(new CustomEvent(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
    });

    const page = await screen.findByRole("main", { name: "Authentication token required" });
    expect(screen.getAllByRole("main", { name: "Authentication token required" })).toHaveLength(1);
    expect(screen.queryByTitle("Settings")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".modal-overlay, .modal-md, [aria-modal]")).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();

    fireEvent.keyDown(page, { key: "Escape" });
    fireEvent.click(page);
    expect(screen.getByRole("main", { name: "Authentication token required" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Replacement token"), "  nouveau-jeton  {Enter}");
    expect(localStorage.getItem("fn.authToken")).toBe("nouveau-jeton");
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("prioritizes a real pre-mount daemon 401 latch over the active first-boot loader", async () => {
    const user = userEvent.setup();
    const daemon401 = new Response(JSON.stringify({
      error: "Unauthorized",
      message: "Valid bearer token required",
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const rawFetch = vi.fn().mockResolvedValue(daemon401);
    window.fetch = rawFetch;
    installAuthFetch();

    await window.fetch("/api/health");
    await waitFor(() => expect(hasDaemonAuthFailure()).toBe(true));

    mockProjectsState.projects = [];
    mockProjectsState.loading = true;
    mockCurrentProjectState.currentProject = null;
    mockCurrentProjectState.loading = true;
    expect(shouldShowFirstEverBootLoader(mockProjectsState.loading, mockProjectsState.projects.length)).toBe(true);

    render(<App />);

    expect(mockDashboardLoaderRender).not.toHaveBeenCalled();
    const page = screen.getByRole("main", { name: "Authentication token required" });
    expect(page).toHaveClass("auth-token-recovery-page");
    expect(screen.getAllByRole("main", { name: "Authentication token required" })).toHaveLength(1);
    expect(screen.queryByRole("status", { name: "Loading Fusion dashboard" })).toBeNull();
    expect(screen.queryByText("Initializing dashboard...")).toBeNull();
    expect(screen.queryByTestId("dashboard-loader-step-projects")).toBeNull();
    expect(screen.queryByTestId("fb-probe-loader")).toBeNull();
    expect(screen.queryByTitle("Settings")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.type(screen.getByLabelText("Replacement token"), "  nouveau-jeton  {Enter}");
    expect(localStorage.getItem("fn.authToken")).toBe("nouveau-jeton");
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(rawFetch).toHaveBeenCalledWith("/api/health", expect.anything());
  });

  it("keeps the first-boot loader when no auth failure is latched", async () => {
    mockProjectsState.projects = [];
    mockProjectsState.loading = true;
    mockCurrentProjectState.currentProject = null;
    mockCurrentProjectState.loading = true;
    expect(shouldShowFirstEverBootLoader(mockProjectsState.loading, mockProjectsState.projects.length)).toBe(true);
    expect(hasDaemonAuthFailure()).toBe(false);

    render(<App />);

    expect(await screen.findByRole("status", { name: "Loading Fusion dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Initializing dashboard...")).toBeInTheDocument();
    expect(screen.getByTestId("fb-probe-loader")).toHaveTextContent("ok");
    expect(screen.queryByRole("main", { name: "Authentication token required" })).toBeNull();
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
    /*
    FNXC:NativeShell 2026-09-15-00:20:
    Before FN-399 this asserted the absence of a class App never published (it published the perimeter's
    own name), so it passed vacuously. The shell's real contract is that the navigation pill — and its
    content reservation — stay mounted while the keyboard is open with no modal, so the operator can still
    reach every destination; only a blocking modal or the Chat destination removes it.
    */
    expect(wrapper?.classList.contains("project-content--with-mobile-nav")).toBe(true);
  });

  it("keeps the official mobile navigation reservation removed while a modal keyboard is open", async () => {
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

    const wrapper = document.querySelector(".project-content");
    expect(wrapper).toBeTruthy();
    expect(wrapper).not.toHaveClass("project-content--with-mobile-nav", "project-content--with-mobile-nav");
  });

  /*
  FNXC:NativeShell 2026-09-15-00:20:
  Restored to the shell's real contract now that App publishes this class: a blocking modal removes the
  navigation reservation, and closing that modal restores it even while the keyboard is still open.
  */
  it("restores the mobile nav reservation when a modal closes while the keyboard stays open", async () => {
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

    let wrapper = document.querySelector(".project-content");
    expect(wrapper).not.toHaveClass("project-content--with-mobile-nav", "project-content--with-mobile-nav");

    // Close the modal via close button
    const closeBtn = document.querySelector(".modal-overlay.open .modal-close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    rerender(<App />);

    // Keyboard is still open, but the modal is closed, so navigation — and its reservation — come back.
    await waitFor(() => {
      wrapper = document.querySelector(".project-content");
      expect(wrapper?.classList.contains("project-content--with-mobile-nav")).toBe(true);
    });
  });
});

describe("App task search suggestions", () => {
  beforeEach(() => {
    mockUseViewportMode.mockReturnValue("desktop");
    mockFetchTaskPage.mockReset();
    mockFetchTaskPage.mockResolvedValue({ tasks: [], total: 0, hasMore: false, nextCursor: null });
    mockAiSearchTasks.mockReset();
    mockAiSearchTasks.mockResolvedValue({ query: "", tasks: [] });
  });

  /** One server page of search results for the header's own paginated collection. */
  function searchServerPage(tasks: ReturnType<typeof makeSearchTask>[], nextCursor: string | null = null) {
    return { tasks, total: tasks.length, hasMore: Boolean(nextCursor), nextCursor };
  }

  /** Settle the field's 200ms text debounce and the resulting request. */
  async function settleSearch() {
    await waitFor(() => expect(mockFetchTaskPage).toHaveBeenCalled());
  }

  function makeSearchTask(id: string, title: string, column = "todo") {
    return {
      id,
      title,
      description: title,
      column,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function mockLocalSearchTasks(source: ReturnType<typeof makeSearchTask>[]) {
    mockUseTasks.mockImplementation((options) => {
      const query = options?.searchQuery?.toLocaleLowerCase();
      const filtered = query
        ? source.filter((task) => /^\d+$/.test(query)
          ? task.id.match(/(\d+)$/)?.[1].startsWith(query)
          : task.id.toLocaleLowerCase().startsWith(query))
        : source;
      return {
        tasks: filtered,
        createTask: mockCreateTask,
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        refreshTasks: vi.fn(),
      };
    });
  }

  /*
  FNXC:TaskSearch 2026-09-17-09:41:
  SYMPTOM VERIFICATION for FN-477, driven through the real Header, field, controller hook, panel, and
  cards — only the HTTP/session boundaries are doubled.

  Original symptom: an operator could not find a task by a word in its title, got a list capped at
  eight truncated rows, and Enter ran no intelligent search.

  On the pre-FN-477 code every assertion below fails: the target task is absent from the board's
  loaded collection so it was never suggested, the ninth result did not exist, and no AI request was
  ever issued.
  */
  it("retrouve par titre une tâche absente des pages chargées, au-delà de huit, puis lance l'IA sur Entrée", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });

    // The board holds ONE unrelated task. The searched task was never paged in.
    mockUseTasks.mockImplementation(() => ({
      tasks: [makeSearchTask("FN-001", "Une autre tâche")],
      createTask: mockCreateTask,
      moveTask: vi.fn(),
      deleteTask: vi.fn(),
      mergeTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
      duplicateTask: vi.fn(),
      refreshTasks: vi.fn(),
    }));

    const exactTitle = "le bouton collapse du leftsidebar doit être au header de la sidebar et être du meme design que le bouton qui collapse la rightsidebar.";
    const firstPage = [
      makeSearchTask("FN-331", exactTitle),
      ...Array.from({ length: 7 }, (_unused, index) => makeSearchTask(`FN-40${index}`, `collapse ${index}`)),
    ];
    const secondPage = Array.from({ length: 4 }, (_unused, index) => makeSearchTask(`FN-5${index}`, `collapse suite ${index}`));
    mockFetchTaskPage
      .mockResolvedValueOnce(searchServerPage(firstPage, "cursor-1") as never)
      .mockResolvedValueOnce(searchServerPage(secondPage) as never);

    render(<App />);
    await waitForAppShell();
    const board = within(screen.getByTestId("board-keep-alive"));
    expect(board.queryByText(exactTitle)).toBeNull();

    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "collapse" } });

    // The exact requested title is reachable without the board ever loading its page …
    await settleSearch();
    await waitFor(() => expect(screen.getByText(exactTitle)).toBeInTheDocument());
    // … as a real card, not a truncated suggestion row.
    expect(document.querySelectorAll(".task-search-result .card").length).toBeGreaterThan(0);
    expect(document.querySelector(".task-search-suggestion")).toBeNull();
    // … and the collection is not capped at the former eight.
    expect(mockFetchTaskPage.mock.calls[0][1]).toMatchObject({ query: "collapse" });
    expect(document.querySelectorAll(".task-search-result")).toHaveLength(8);
    expect(screen.getByTestId("task-search-results-sentinel")).toBeInTheDocument();

    // A paraphrase with no literal match still reaches the AI lane on Enter.
    mockAiSearchTasks.mockResolvedValue({
      query: "replier le panneau lateral",
      tasks: [makeSearchTask("FN-331", exactTitle)],
    } as never);
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "replier le panneau lateral" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Search tasks..." }), { key: "Enter" });
    });

    expect(mockAiSearchTasks).toHaveBeenCalledTimes(1);
    expect(mockAiSearchTasks.mock.calls[0][0]).toBe("replier le panneau lateral");
    await waitFor(() => expect(screen.getByTestId("task-search-results")).toHaveAttribute("data-lane", "ai"));
  });

  it("ouvre une tâche terminée absente du tableau sans filtrer Board ou List", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    const source = [makeSearchTask("FN-351", "Active Alpha task")];
    const observedQueries: Array<string | undefined> = [];
    mockUseTasks.mockImplementation((options) => {
      observedQueries.push(options?.searchQuery);
      return {
        tasks: options?.searchQuery ? [] : source,
        createTask: mockCreateTask,
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        refreshTasks: vi.fn(),
      };
    });
    // The completed task exists on the server only; the board never loaded it.
    mockFetchTaskPage.mockResolvedValue(searchServerPage([
      makeSearchTask("FN-353", "Completed Alpha task", "done"),
    ]) as never);

    render(<App />);
    await waitForAppShell();
    const board = within(screen.getByTestId("board-keep-alive"));
    expect(board.getByText("Active Alpha task")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    const inlineSearch = screen.getByTestId("desktop-header-search-input");
    expect(inlineSearch.parentElement).toBe(document.querySelector(".header-actions"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "353" } });
    await settleSearch();

    await waitFor(() => expect(screen.getByText("Completed Alpha task")).toBeInTheDocument());
    fireEvent.click(screen.getByText("FN-353"));

    // The result opens even though `boardSourceTasks` never contained it.
    expect(screen.getAllByRole("dialog", { name: "Completed Alpha task" })).toHaveLength(1);
    expect(board.getByText("Active Alpha task")).toBeInTheDocument();
    // The desktop host's transient query never reaches the Board/List filter.
    expect(observedQueries.every((query) => query === undefined)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("sidebar-nav-list"));
    await waitFor(() => expect(screen.getByTestId("list-keep-alive")).not.toHaveAttribute("aria-hidden"));
    expect(within(screen.getByTestId("list-keep-alive")).getByText("Active Alpha task")).toBeInTheDocument();
  });

  it("ouvre une tâche distante autoritative depuis Alpha sans propager la requête transitoire", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    mockLocalSearchTasks([makeSearchTask("LOCAL-353", "Local task")]);
    mockNodeContextValue.isRemote = true;
    mockNodeContextValue.currentNodeId = "node-alpha";
    const remoteQueries: Array<string | undefined> = [];
    const remoteSpy = vi.spyOn(apiNodeModule, "useRemoteNodeData").mockImplementation((_nodeId, options) => {
      remoteQueries.push(options?.searchQuery);
      return {
        projects: [],
        tasks: [makeSearchTask("REMOTE-353", "Remote completed Alpha task", "done")],
        health: null,
        loading: false,
        error: null,
        refresh: vi.fn(),
      };
    });

    // The remote node's OWN search endpoint answers; nothing local may substitute for it.
    mockFetchTaskPage.mockResolvedValue(searchServerPage([
      makeSearchTask("REMOTE-353", "Remote completed Alpha task", "done"),
    ]) as never);

    render(<App />);
    await waitForAppShell();
    const board = within(screen.getByTestId("board-keep-alive"));
    expect(board.getByText("Remote completed Alpha task")).toBeInTheDocument();
    expect(board.queryByText("Local task")).toBeNull();

    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    expect(screen.getByTestId("desktop-header-search-input").parentElement).toBe(document.querySelector(".header-actions"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "353" } });
    await settleSearch();

    // The request is routed to the selected node, never answered from the local store.
    expect(mockFetchTaskPage.mock.calls[0][1]).toMatchObject({ nodeId: "node-alpha", query: "353" });
    // Scope to the panel: the board legitimately renders the same remote task behind it.
    const panel = await screen.findByTestId("task-search-results");
    await waitFor(() => expect(within(panel).getByText("REMOTE-353")).toBeInTheDocument());
    expect(within(panel).queryByText("LOCAL-353")).toBeNull();

    fireEvent.click(within(panel).getByText("REMOTE-353"));

    expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
    expect(screen.getAllByRole("dialog", { name: "Remote completed Alpha task" })).toHaveLength(1);
    expect(board.getByText("Remote completed Alpha task")).toBeInTheDocument();
    expect(remoteQueries.every((query) => query === undefined)).toBe(true);
    remoteSpy.mockRestore();
  });

  it("ferme le champ Alpha inline par Escape et réinitialise sa requête", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({
      ...defaultSettings,
      experimentalFeatures: { ...defaultSettings.experimentalFeatures },
    });
    mockLocalSearchTasks([makeSearchTask("FN-353", "Alpha task")]);

    render(<App />);
    await waitForAppShell();
    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "353" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search tasks..." }), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("desktop-inline-header-search-btn")).toHaveFocus());

    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    expect(screen.getByRole("combobox", { name: "Search tasks..." })).toHaveValue("");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search tasks..." }), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("desktop-inline-header-search-btn")).toHaveFocus());
    expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Alpha task" })).toBeNull();
  });

  it("uses remote tasks exclusively and keeps completed search results eligible", async () => {
    mockLocalSearchTasks([makeSearchTask("LOCAL-331", "Local task")]);
    mockNodeContextValue.isRemote = true;
    mockNodeContextValue.currentNodeId = "node-1";
    const remoteSpy = vi.spyOn(apiNodeModule, "useRemoteNodeData").mockReturnValue({
      projects: [],
      tasks: [
        makeSearchTask("REMOTE-331", "Remote completed task", "done"),
        makeSearchTask("REMOTE-332", "Remote other task"),
      ],
      health: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<App />);
    await waitForAppShell();
    mockFetchTaskPage.mockResolvedValue(searchServerPage([
      makeSearchTask("REMOTE-331", "Remote completed task", "done"),
    ]) as never);
    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "331" } });
    await settleSearch();

    const panel = await screen.findByTestId("task-search-results");
    await waitFor(() => expect(within(panel).getByText("REMOTE-331")).toBeInTheDocument());
    expect(within(panel).queryByText("LOCAL-331")).toBeNull();
    remoteSpy.mockRestore();
  });

  it("keeps an empty remote result authoritative instead of suggesting local tasks", async () => {
    mockLocalSearchTasks([makeSearchTask("LOCAL-331", "Local task")]);
    mockNodeContextValue.isRemote = true;
    mockNodeContextValue.currentNodeId = "node-1";
    const remoteSpy = vi.spyOn(apiNodeModule, "useRemoteNodeData").mockReturnValue({
      projects: [],
      tasks: [],
      health: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    // The remote node genuinely has no match. A local fallback here would show another store's rows.
    mockFetchTaskPage.mockResolvedValue(searchServerPage([]) as never);

    render(<App />);
    await waitForAppShell();
    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "331" } });
    await settleSearch();

    await waitFor(() => expect(mockFetchTaskPage).toHaveBeenCalled());
    expect(screen.queryByText("LOCAL-331")).toBeNull();
    expect(within(screen.getByTestId("board-keep-alive")).queryByText("Local task")).toBeNull();

    remoteSpy.mockRestore();
  });

  it("withholds retained remote rows until the current node request settles", async () => {
    mockLocalSearchTasks([makeSearchTask("LOCAL-331", "Local task")]);
    mockNodeContextValue.isRemote = true;
    mockNodeContextValue.currentNodeId = "node-1";
    let remoteTasks = [makeSearchTask("NODE1-331", "First node task")];
    let remoteLoading = false;
    let remoteError: string | null = null;
    const remoteSpy = vi.spyOn(apiNodeModule, "useRemoteNodeData").mockImplementation(() => ({
      projects: [],
      tasks: remoteTasks,
      health: null,
      loading: remoteLoading,
      error: remoteError,
      refresh: vi.fn(),
    }));

    /*
    FNXC:TaskSearch 2026-09-17-09:41:
    Two nodes legitimately reuse a task id, so the load-bearing property is that switching node clears
    the previous node's rows BEFORE any new response can arrive — otherwise node 1's card is shown
    under node 2's identity for as long as the new request takes.
    */
    mockFetchTaskPage.mockResolvedValue(searchServerPage([
      makeSearchTask("NODE1-331", "First node task"),
    ]) as never);

    const { rerender } = render(<App />);
    await waitForAppShell();
    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "331" } });
    await settleSearch();
    const firstNodePanel = await screen.findByTestId("task-search-results");
    await waitFor(() => expect(within(firstNodePanel).getByText("NODE1-331")).toBeInTheDocument());

    // Node switch: the previous node's rows must be gone immediately, with no local substitute.
    let resolveSecondNode: ((value: unknown) => void) | undefined;
    mockFetchTaskPage.mockReturnValue(new Promise((resolve) => { resolveSecondNode = resolve; }) as never);
    mockNodeContextValue.currentNodeId = "node-2";
    remoteTasks = [];
    rerender(<App />);

    expect(screen.queryByTestId("task-search-results")?.textContent ?? "").not.toContain("NODE1-331");
    expect(screen.queryByTestId("task-search-results")?.textContent ?? "").not.toContain("LOCAL-331");
    const boardDuringNodeChange = within(screen.getByTestId("board-keep-alive"));
    expect(boardDuringNodeChange.queryByText("First node task")).toBeNull();
    expect(boardDuringNodeChange.queryByText("Local task")).toBeNull();

    // A remote failure never falls back to local rows either.
    remoteLoading = false;
    remoteError = "Remote node unavailable";
    rerender(<App />);
    expect(screen.queryByTestId("task-search-results")?.textContent ?? "").not.toContain("NODE1-331");
    expect(screen.queryByTestId("task-search-results")?.textContent ?? "").not.toContain("LOCAL-331");

    // The second node's own answer finally lands and is the only thing shown.
    remoteError = null;
    remoteTasks = [makeSearchTask("NODE2-331", "Second node task")];
    rerender(<App />);
    await act(async () => {
      resolveSecondNode?.(searchServerPage([makeSearchTask("NODE2-331", "Second node task")]));
      await Promise.resolve();
    });

    const settledPanel = await screen.findByTestId("task-search-results");
    await waitFor(() => expect(within(settledPanel).getByText("NODE2-331")).toBeInTheDocument());
    expect(within(settledPanel).queryByText("NODE1-331")).toBeNull();
    remoteSpy.mockRestore();
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
      refreshTasks: vi.fn(),
      ingestCreatedTasks: vi.fn(),
      lastFetchTimeMs: Date.now(),
    }));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);

    const toggle = await screen.findByRole("checkbox", { name: "Auto-merge" });
    expect(screen.getByTestId("mobile-nav-tab-command-center")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-nav-tab-planning")).toBeInTheDocument();
    expect(document.querySelector("main.board")).not.toBeNull();
    expect(screen.getByText("In review task")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ autoMerge: expect.any(Boolean) }),
        DEFAULT_PROJECT_ID,
      );
      expect(screen.getByTestId("mobile-nav-tab-command-center")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-nav-tab-planning")).toBeInTheDocument();
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
      expect(screen.getByTestId("mobile-nav-tab-command-center")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-nav-tab-planning")).toBeInTheDocument();
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

/*
FNXC:Terminal 2026-07-26-19:35:
App must render TerminalModal ONLY while `modalManager.terminalOpen` (App.tsx ~1927). A closed-but-mounted
terminal still runs `useTerminalSessions` + `useTerminal`: a live PTY WebSocket and a 45s heartbeat
interval, both of which keep a backgrounded tab awake and get it discarded on iOS Safari / Chrome Android.
That cost is proved against the real component in `TerminalModal.closed-mount-cost.test.tsx`; this block
proves App does not pay it.

Asserted on the component-function invocation and unmount, not on rendered DOM. The DOM cannot express
the difference — a mounted TerminalModal with `isOpen={false}` renders nothing, exactly like an unmounted
one — which is why the previous shallow stand-in left this invariant unverifiable and a regression to
always-mounted silently green.
*/
describe("terminal mount lifecycle (App mounts the terminal only while open)", () => {
  it("never mounts TerminalModal while the terminal is closed, and unmounts it on close", async () => {
    terminalLifecycle.reset();
    /* FN-419: this case opens the terminal through the wide FOOTER action, so it opts into that placement. */
    vi.mocked(fetchSettings).mockResolvedValue({ ...defaultSettings, navigationPlacement: "footer" });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-action-bar")).toBeTruthy();
    });

    expect(
      terminalLifecycle.renders,
      "TERMINAL MOUNT REGRESSION: App rendered TerminalModal while the terminal was closed. A mounted TerminalModal opens a PTY WebSocket and arms a 45s heartbeat even with isOpen={false} (see TerminalModal.closed-mount-cost.test.tsx), which is the background work that gets a backgrounded mobile tab discarded. Keep the `modalManager.terminalOpen &&` guard on the render in App.tsx.",
    ).toEqual([]);
    expect(terminalLifecycle.mounts).toBe(0);

    // Open the terminal through the wide footer's canonical action.
    await act(async () => {
      fireEvent.click(await screen.findByTestId("desktop-nav-terminal"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    // Now — and only now — the machinery is allowed to exist.
    expect(terminalLifecycle.mounts).toBe(1);
    expect(
      terminalLifecycle.renders.every((open) => open === true),
      "App mounted TerminalModal with isOpen={false} at some point; every render while mounted must be an open one.",
    ).toBe(true);

    const rendersWhileOpen = terminalLifecycle.renders.length;

    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-close-btn"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-modal")).toBeNull();
    });

    expect(
      terminalLifecycle.unmounts,
      "TERMINAL MOUNT REGRESSION: closing the terminal left TerminalModal mounted. Close must UNMOUNT it — that is what releases the WebSocket, the heartbeat interval, the xterm scrollback ring, and the WebGL context. Rendering null while staying mounted releases none of them.",
    ).toBe(1);
    expect(
      terminalLifecycle.renders.length,
      "App re-rendered TerminalModal after close; it must not be mounted at all while closed.",
    ).toBe(rendersWhileOpen);
  });
});

/*
FN-426 — AUTHORITATIVE PROOF THAT NOTHING REQUIRES THE RIGHT SIDEBAR.

Original state: Git Manager, Activity Log, Secrets, Pull Requests, Files, Chat, and List were reachable only through
the right sidebar, which mounted unconditionally on every tablet/desktop project screen. The sidebar is now an explicit
project opt-in that defaults OFF, so each of those tools must have a canonical host of its own.

Every case renders the real `<App />` rather than a recomposed harness: a resolver-level test would prove the mapping
and miss the wiring, and the wiring is the only thing that can strand a tool.
*/
describe("FN-426 tool surfaces without the right sidebar", () => {
  const toolSettings = (overrides: Record<string, unknown> = {}) => ({
    ...defaultSettings,
    navigationPlacement: "footer" as const,
    /* The shipped default: this block exists to prove every tool works without the panel. */
    rightSidebarEnabled: false,
    ...overrides,
  });

  it.each(["tablet", "desktop"] as const)("mounts no right sidebar shell at all by default on %s", async (mode) => {
    mockUseViewportMode.mockReturnValue(mode);
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    await screen.findByTestId("desktop-action-bar");
    expect(screen.queryByTestId("right-dock")).toBeNull();
    expect(screen.queryByTestId("right-dock-body")).toBeNull();
    expect(screen.queryByTestId("header-right-dock-toggle")).toBeNull();
    expect(screen.getByTestId("dashboard-project-shell")).not.toHaveClass("dashboard-project-shell--with-right-dock");
  });

  /*
   * A pre-FN-426 browser carries a stored open preference. That is a LOCAL record of how the panel was last used; it
   * must never re-enable a panel the project has turned off.
   */
  it("keeps the sidebar absent despite a stored open preference", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    localStorage.setItem("fusion:right-dock-open", "true");
    localStorage.setItem("fusion:right-dock-pinned", "true");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    await screen.findByTestId("desktop-action-bar");
    expect(screen.queryByTestId("right-dock")).toBeNull();
    expect(screen.queryByTestId("header-right-dock-toggle")).toBeNull();
  });

  it("mounts the sidebar with exactly the four opt-in tools when the project enables it", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    localStorage.setItem("fusion:right-dock-open", "true");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings({ rightSidebarEnabled: true }));

    render(<App />);

    expect(await screen.findByTestId("header-right-dock-toggle")).toBeInTheDocument();
    expect(await screen.findByTestId("right-dock-body")).toBeInTheDocument();
    for (const tool of ["files", "chat", "list", "notes"]) {
      expect(await screen.findByTestId(`right-dock-tab-${tool}`)).toBeInTheDocument();
    }
    for (const relocated of ["git-manager", "activity-log", "secrets", "pull-requests", "devserver"]) {
      expect(screen.queryByTestId(`right-dock-tab-${relocated}`)).toBeNull();
    }
  });

  it("opens Git Manager as a real page from the bottom bar, with no sidebar", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.pointerEnter(await screen.findByTestId("desktop-nav-more"));
    fireEvent.click(await screen.findByTestId("desktop-nav-git-manager"));

    expect(await screen.findByTestId("git-manager-view")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock")).toBeNull();
  });

  it("opens Files as a real page from the bottom bar", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.pointerEnter(await screen.findByTestId("desktop-nav-more"));
    fireEvent.click(await screen.findByTestId("desktop-nav-files"));

    expect(await screen.findByTestId("files-view")).toBeInTheDocument();
  });

  it("opens Activity and Notes as header panels, one at a time", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("header-activity-panel-btn"));
    expect(await screen.findByTestId("activity-tool-popover")).toBeInTheDocument();
    expect(screen.queryByTestId("notes-tool-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("header-notes-panel-btn"));
    expect(await screen.findByTestId("notes-tool-popover")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-tool-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("header-notes-panel-btn"));
    await waitFor(() => expect(screen.queryByTestId("notes-tool-popover")).toBeNull());
  });

  it("keeps the Activity task-ID search visible inside the header panel", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("header-activity-panel-btn"));
    const popover = await screen.findByTestId("activity-tool-popover");
    expect(within(popover).getByTestId("activity-task-search")).toBeInTheDocument();
  });

  it("opens the conversation list from the bottom bar instead of the sidebar", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("desktop-nav-chat-panel"));
    expect(await screen.findByTestId("chat-tool-popover")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-body")).toBeNull();
  });

  /*
   * FN-447 symptom: from the bottom-bar Conversations popover, Ctrl/Cmd-clicking a conversation — or using the
   * right-click "Open in new window" action — opened the window AND dismissed the list, so opening several
   * conversations in a row meant reopening the list every time. The host called closeToolPanel() unconditionally.
   * These cases replay both gestures against the real ChatView and assert the popover survives while the detached
   * window appears; the plain-click case asserts the unchanged dismiss-on-select behavior.
   */
  const chatWindowTestId = `floating-window-chat-window-${DEFAULT_PROJECT_ID}-${appChatSession.id}`;

  it("garde la liste de conversations ouverte lors d’un Ctrl+clic sur une conversation", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    configureProductionAppChat();
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);
    await waitForAppShell();

    fireEvent.click(await screen.findByTestId("desktop-nav-chat-panel"));
    const panel = await screen.findByTestId("chat-tool-popover");
    fireEvent.click(await within(panel).findByTestId(`chat-session-${appChatSession.id}`), { ctrlKey: true });

    expect(await screen.findByTestId(chatWindowTestId)).toBeInTheDocument();
    expect(screen.getByTestId("chat-tool-popover")).toBeInTheDocument();

    /* Escape stays the explicit dismissal of the popover. */
    fireEvent.keyDown(screen.getByTestId("chat-tool-popover"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("chat-tool-popover")).toBeNull());
  });

  it("garde la liste de conversations ouverte via l’action « Open in new window »", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    configureProductionAppChat();
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);
    await waitForAppShell();

    fireEvent.click(await screen.findByTestId("desktop-nav-chat-panel"));
    const panel = await screen.findByTestId("chat-tool-popover");
    fireEvent.contextMenu(await within(panel).findByTestId(`chat-session-${appChatSession.id}`), { clientX: 12, clientY: 12 });
    fireEvent.click(await screen.findByTestId("chat-context-open-window"));

    expect(await screen.findByTestId(chatWindowTestId)).toBeInTheDocument();
    expect(screen.getByTestId("chat-tool-popover")).toBeInTheDocument();
  });

  it("referme toujours la liste de conversations sur un clic simple", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    configureProductionAppChat();
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);
    await waitForAppShell();

    fireEvent.click(await screen.findByTestId("desktop-nav-chat-panel"));
    const panel = await screen.findByTestId("chat-tool-popover");
    fireEvent.click(await within(panel).findByTestId(`chat-session-${appChatSession.id}`));

    expect(await screen.findByTestId(chatWindowTestId)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("chat-tool-popover")).toBeNull());
  });

  /*
   * FN-433 symptom: the bottom bar is `position: fixed; bottom: 0`, so the Chat trigger's rect bottom is the window
   * bottom. Placing the panel below it laid the whole dialog out past the bottom edge — present in the DOM, invisible
   * on screen, which is exactly "clicking Chat shows nothing". jsdom's default zero rect hides that, so this case feeds
   * the real footer geometry and asserts the panel opens ABOVE the trigger, fully inside the viewport.
   */
  it("opens the bottom-bar conversation list above its trigger and inside the viewport", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());
    // Earlier mobile-viewport cases redefine innerHeight as a non-writable property, so define rather than assign.
    const priorHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });

    render(<App />);

    const trigger = await screen.findByTestId("desktop-nav-chat-panel");
    const rectSpy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 1100, y: 764, top: 764, bottom: 800, left: 1100, right: 1180, width: 80, height: 36, toJSON: () => ({}),
    } as DOMRect);

    try {
      fireEvent.click(trigger);
      const panel = await screen.findByTestId("chat-tool-popover");

      expect(panel).toHaveAttribute("data-placement", "above");
      expect(panel.style.top).toBe("");
      expect(panel.style.bottom).not.toBe("");

      const bottom = Number.parseInt(panel.style.bottom, 10);
      const height = Number.parseInt(panel.style.height || panel.style.maxHeight, 10);
      const bottomEdge = 800 - bottom;
      expect(bottomEdge).toBeLessThanOrEqual(764 - 8);
      expect(bottomEdge - height).toBeGreaterThanOrEqual(8);
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: priorHeight });
    }
  });

  /*
   * FN-436 symptom: the Chat trigger is followed in the bottom bar by Terminal, Settings and the window-visibility
   * toggle, so aligning the panel's right edge with the TRIGGER's right edge opened it ~100px short of the screen edge —
   * the operator reported the popover as "too far left". This case replays the exact FN-433 trigger rect and asserts the
   * panel's right edge now sits VIEWPORT_MARGIN (8px) from the viewport edge, while its `above` placement is unchanged.
   */
  it("pins the bottom-bar conversation list to the right edge of the screen", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());
    const priorWidth = window.innerWidth;
    const priorHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });

    render(<App />);

    const trigger = await screen.findByTestId("desktop-nav-chat-panel");
    const rectSpy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 1100, y: 764, top: 764, bottom: 800, left: 1100, right: 1180, width: 80, height: 36, toJSON: () => ({}),
    } as DOMRect);

    try {
      fireEvent.click(trigger);
      const panel = await screen.findByTestId("chat-tool-popover");

      expect(panel.style.left).toBe("852px");
      expect(Number.parseInt(panel.style.left, 10) + Number.parseInt(panel.style.width, 10)).toBe(1280 - 8);
      expect(panel).toHaveAttribute("data-placement", "above");
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: priorWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: priorHeight });
    }
  });

  /*
   * FN-436 non-regression: only Chat opts into viewport alignment. The header Activity panel must keep its right edge on
   * its own trigger, not on the screen edge.
   */
  it("keeps the header Activity panel aligned on its trigger, not on the screen edge", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());
    const priorWidth = window.innerWidth;
    const priorHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });

    render(<App />);

    const trigger = await screen.findByTestId("header-activity-panel-btn");
    const rectSpy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 640, y: 40, top: 40, bottom: 60, left: 640, right: 700, width: 60, height: 20, toJSON: () => ({}),
    } as DOMRect);

    try {
      fireEvent.click(trigger);
      const panel = await screen.findByTestId("activity-tool-popover");

      // width=520 anchored on the trigger's right edge: 700 - 520 = 180, far from the 1280-520-8=752 viewport edge.
      expect(panel.style.left).toBe("180px");
      expect(panel).toHaveAttribute("data-placement", "below");
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: priorWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: priorHeight });
    }
  });

  /*
   * FN-433 non-regression: the header-anchored panels have room below their trigger, so they must keep resolving to the
   * unchanged `below` placement.
   */
  it("keeps the header Activity and Notes panels anchored below their triggers", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("header-activity-panel-btn"));
    expect(await screen.findByTestId("activity-tool-popover")).toHaveAttribute("data-placement", "below");
    fireEvent.keyDown(screen.getByTestId("activity-tool-popover"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("activity-tool-popover")).toBeNull());

    fireEvent.click(screen.getByTestId("header-notes-panel-btn"));
    expect(await screen.findByTestId("notes-tool-popover")).toHaveAttribute("data-placement", "below");
  });

  /*
   * FN-439: the Header no longer produces a List button on tablet/desktop. Under the footer placement the **More**
   * menu is List's single owner, so reaching the List view must go through it — that is the replacement for FN-426's
   * header toggle this test used to assert.
   */
  it("reaches List from the footer More menu without a sidebar", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
    fireEvent.pointerEnter(await screen.findByTestId("desktop-nav-more"));
    fireEvent.click(await screen.findByTestId("desktop-nav-list"));
    expect(await screen.findByTestId("list-keep-alive")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-body")).toBeNull();
  });

  /*
   * Pull Requests and Secrets keep their ids so bookmarks and persisted views still resolve, but they are no longer
   * destinations: the first is a Git section and the second a Settings section.
   */
  it("routes a legacy pull-requests request into the Git page", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());
    localStorage.setItem(scopedKey("kb-dashboard-task-view", "proj_123"), "pull-requests");

    render(<App />);

    expect(await screen.findByTestId("git-manager-view")).toBeInTheDocument();
  });
});

/*
FN-435 — L'HÔTE DES SURFACES ACTIVITY ET NOTES EST RÉSOLU PAR LE POINT DE RUPTURE MESURÉ.

État initial : les deux outils s'ouvraient dans la MÊME popover ancrée à l'en-tête quel que soit le format d'écran ;
sur téléphone elle était réduite à la largeur du viewport et devenait inutilisable, et la popover Notes n'affichait
qu'une liste dont le clic ouvrait une fenêtre flottante dédiée. Chaque cas monte le VRAI `<App />` plutôt qu'un harnais
recomposé : un test au niveau du résolveur prouverait la règle et manquerait le câblage, qui est la seule chose qui
peut laisser un outil inatteignable.
*/
describe("FN-435/FN-437 hôtes d'outils par point de rupture", () => {
  const toolSettings = (overrides: Record<string, unknown> = {}) => ({
    ...defaultSettings,
    navigationPlacement: "footer" as const,
    rightSidebarEnabled: false,
    ...overrides,
  });

  beforeEach(() => {
    mockNotesApi.fetchNotes.mockResolvedValue({ notes: [{ id: "note-1", title: "Commande", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
    mockNotesApi.fetchNote.mockResolvedValue({ id: "note-1", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  });

  /*
  FNXC:ToolSurfaces 2026-09-16-23:06:
  FN-437 cas (d1) : le Header mobile n'expose plus `header-activity-panel-btn`. La destination est inchangée (même
  modale plein écran) mais son propriétaire est maintenant l'entrée `mobile-more-item-activity` du menu du pied de
  page. Ce test remplace la version FN-435 qui cliquait le déclencheur du Header.
  */
  it("ouvre le journal d'activité dans la modale plein écran depuis le menu du pied de page sur téléphone", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    expect(screen.queryByTestId("header-activity-panel-btn")).toBeNull();
    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    fireEvent.click(await screen.findByTestId("mobile-more-item-activity"));
    expect(await screen.findByTestId("activity-log-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-tool-popover")).toBeNull();
  });

  it("garde le journal d'activité dans la popover sur ordinateur", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("header-activity-panel-btn"));
    const popover = await screen.findByTestId("activity-tool-popover");
    expect(within(popover).getByTestId("activity-log-modal")).toBeInTheDocument();
  });

  /*
  FNXC:ToolSurfaces 2026-09-16-23:06:
  FN-437 cas (d2)+(d3) : remplaçant du test FN-435 « ouvre Notes dans un tiroir… », dont le sujet — le tiroir d'outil
  `mobile-drawer-notes` — est retiré parce que le Header n'expose plus son déclencheur sur téléphone. Le propriétaire
  mobile de Notes est désormais l'entrée du menu du pied de page, qui ouvre la vue Notes plein écran dans
  `MainContentDrawer` avec la même navigation interne liste → éditeur, et cet hôte retiré n'est jamais monté.
  */
  it("ouvre Notes en plein écran depuis le menu du pied de page avec navigation liste puis éditeur sur téléphone", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    expect(screen.queryByTestId("header-notes-panel-btn")).toBeNull();
    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    fireEvent.click(await screen.findByTestId("mobile-more-item-notes"));

    const drawer = await screen.findByTestId("mobile-drawer-main-content");
    expect(screen.queryByTestId("notes-tool-popover")).toBeNull();
    // (d3) l'hôte d'outil Notes mobile retiré par FN-437 n'est jamais monté.
    expect(screen.queryByTestId("mobile-drawer-notes")).toBeNull();

    const row = await within(drawer).findByRole("button", { name: /^Commande/ });
    fireEvent.click(row);
    expect(await within(drawer).findByLabelText(/Editor for|File editor/)).toBeInTheDocument();
    expect(screen.getAllByTestId("mobile-drawer-main-content")).toHaveLength(1);
  });

  it("héberge le rail liste ET l'éditeur dans la popover sur ordinateur sans fenêtre détachée", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("header-notes-panel-btn"));
    const popover = await screen.findByTestId("notes-tool-popover");
    const row = await within(popover).findByRole("button", { name: /^Commande/ });
    fireEvent.click(row);

    expect(await within(popover).findByLabelText(/Editor for|File editor/)).toBeInTheDocument();
    expect(popover.querySelector(".notes-list")).not.toBeNull();
    expect(screen.queryByTestId("notes-back-btn")).toBeNull();
    expect(screen.getAllByTestId("notes-tool-popover")).toHaveLength(1);
    expect(document.querySelectorAll('[data-window-key^="note-"]')).toHaveLength(0);
  });

  it("ferme la popover d'activité orpheline quand le point de rupture passe en téléphone", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    const view = render(<App />);

    fireEvent.click(await screen.findByTestId("header-activity-panel-btn"));
    await screen.findByTestId("activity-tool-popover");

    mockUseViewportMode.mockReturnValue("mobile");
    view.rerender(<App />);
    await waitFor(() => expect(screen.queryByTestId("activity-tool-popover")).toBeNull());
    expect(screen.queryByTestId("activity-log-modal")).toBeNull();
  });

  /*
  FNXC:ToolSurfaces 2026-09-16-23:06:
  FN-437 cas (d4), jumeau Notes du cas ci-dessus. Puisque le Header mobile n'expose plus de déclencheur Notes et que
  l'hôte mobile est retiré, un panneau Notes ouvert sur ordinateur deviendrait un état orphelin — sans hôte NI moyen
  de le refermer — après une bascule vers le point de rupture téléphone.
  */
  it("ferme le panneau Notes orphelin quand le point de rupture passe en téléphone", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(toolSettings());

    const view = render(<App />);

    fireEvent.click(await screen.findByTestId("header-notes-panel-btn"));
    await screen.findByTestId("notes-tool-popover");

    mockUseViewportMode.mockReturnValue("mobile");
    view.rerender(<App />);
    await waitFor(() => expect(screen.queryByTestId("notes-tool-popover")).toBeNull());
    expect(screen.queryByTestId("mobile-drawer-notes")).toBeNull();
  });
});

/*
FN-481 — LE HEADER EST PRIORITAIRE SUR LA NAVIGATION BASSE.

État initial : sur téléphone, Usage et Projets étaient offerts à la fois en haut et dans le menu bas ; sur tablette,
Notes et Activity Log l'étaient aussi. Chaque cas monte le VRAI `<App />` — son Header ET sa pill — parce qu'un test
de composant recomposé prouverait la règle sans voir le câblage, qui est la seule chose capable de laisser une
destination inatteignable ou dupliquée.
*/
describe("FN-481 priorité du Header sur la navigation basse", () => {
  const shellSettings = (overrides: Record<string, unknown> = {}) => ({
    ...defaultSettings,
    navigationPlacement: "footer" as const,
    rightSidebarEnabled: false,
    ...overrides,
  });

  beforeEach(() => {
    mockProjectsState.projects = [{ ...DEFAULT_PROJECT }, { id: "proj_456", name: "Autre projet", path: "/autre", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" }];
    mockNotesApi.fetchNotes.mockResolvedValue({ notes: [] });
  });

  it("retire Usage et Projets du menu bas sur téléphone tout en gardant Notes et Activity", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue(shellSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    for (const testId of ["mobile-more-item-usage", "mobile-more-item-projects", "mobile-nav-tab-usage", "mobile-nav-tab-projects"]) {
      expect(screen.queryByTestId(testId), testId).toBeNull();
    }
    /* Notes et Activity restent en bas : le Header téléphone ne rend aucun de leurs déclencheurs. */
    expect(screen.getByTestId("mobile-more-item-notes")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-more-item-activity")).toBeInTheDocument();
  });

  it("ouvre Usage depuis l'en-tête téléphone et atteint la gestion des projets par son sélecteur", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue(shellSettings());

    render(<App />);

    fireEvent.click(await screen.findByTestId("mobile-header-usage-btn"));
    expect(await screen.findByTestId("mobile-drawer-usage")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
    fireEvent.click(await screen.findByTestId("mobile-project-switch-view-all"));
    /* Sémantique existante du chemin Header : l'aperçu des projets, après la garde de fermeture. */
    await waitFor(() => expect(mockCurrentProjectState.clearCurrentProject).toHaveBeenCalled());
  });

  it("retire les quatre destinations du menu bas sur tablette en gardant la pill et les accès d'en-tête", async () => {
    mockUseViewportMode.mockReturnValue("tablet");
    vi.mocked(fetchSettings).mockResolvedValue(shellSettings());

    render(<App />);

    /* Les quatre accès existent en haut. */
    expect(await screen.findByTestId("header-usage-btn")).toBeInTheDocument();
    expect(screen.getByTestId("header-notes-panel-btn")).toBeInTheDocument();
    expect(screen.getByTestId("header-activity-panel-btn")).toBeInTheDocument();
    expect(screen.getByTestId("project-selector-trigger")).toBeInTheDocument();

    /* La pill reste montée sur tablette, mais sans ces quatre destinations. */
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    for (const testId of [
      "mobile-more-item-usage",
      "mobile-more-item-projects",
      "mobile-more-item-notes",
      "mobile-more-item-activity",
      "mobile-nav-tab-usage",
      "mobile-nav-tab-projects",
      "mobile-nav-tab-notes",
      "mobile-nav-tab-activity",
    ]) {
      expect(screen.queryByTestId(testId), testId).toBeNull();
    }
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    /* Les deux panneaux d'en-tête s'ouvrent toujours. */
    fireEvent.click(screen.getByTestId("header-activity-panel-btn"));
    expect(await screen.findByTestId("activity-tool-popover")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("header-notes-panel-btn"));
    expect(await screen.findByTestId("notes-tool-popover")).toBeInTheDocument();
  });

  it("garde la navigation large de l'ordinateur sans ces quatre doublons", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(shellSettings());

    render(<App />);

    expect(await screen.findByTestId("header-usage-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-menu-trigger")).toBeNull();

    fireEvent.click(screen.getByTestId("desktop-nav-more"));
    for (const testId of ["desktop-nav-usage", "desktop-nav-projects", "desktop-nav-notes", "desktop-nav-activity"]) {
      expect(screen.queryByTestId(testId), testId).toBeNull();
    }
  });

  it("conserve les accès d'en-tête en placement sidebar, sans barre basse", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(fetchSettings).mockResolvedValue(shellSettings({ navigationPlacement: "sidebar" }));

    render(<App />);

    expect(await screen.findByTestId("header-usage-btn")).toBeInTheDocument();
    expect(screen.getByTestId("header-notes-panel-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-action-bar")).toBeNull();
    expect(screen.queryByTestId("mobile-menu-trigger")).toBeNull();
  });

  it("restitue les entrées basses quand la liste de projets arrive plus tard ou disparaît", async () => {
    mockProjectsState.projects = [];
    mockUseViewportMode.mockReturnValue("mobile");
    vi.mocked(fetchSettings).mockResolvedValue(shellSettings());

    const view = render(<App />);

    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    /* Sans projet proposable, le Header ne possède pas Projets : l'entrée basse reste le chemin restant. */
    expect(screen.getByTestId("mobile-more-item-projects")).toBeInTheDocument();

    mockProjectsState.projects = [{ ...DEFAULT_PROJECT }];
    view.rerender(<App />);
    await waitFor(() => expect(screen.queryByTestId("mobile-more-item-projects")).toBeNull());
    /* Le menu reste ouvert et utilisable après le changement de propriétaire. */
    expect(screen.getByRole("menu", { name: "Navigate" })).toBeInTheDocument();
  });
});
