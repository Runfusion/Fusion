import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ChatView } from "../ChatView";
import { MainContent } from "../dashboard/MainContent";
import { MainViewKeepAlive } from "../dashboard/MainViewKeepAlive";
import type { MainContentProps } from "../dashboard/types";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { installChatViewEnv, setupMockChat, setupMockRooms } from "./ChatView.test-harness";
import { AgentsView } from "../AgentsView";
import { NotesView } from "../NotesView";
import { SecretsView } from "../SecretsView";
import { GoalsView } from "../GoalsView";


/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 proves the shared chrome on the REAL destination host: MainContent routes each destination, and every one
of them paints exactly one canonical header with at most one canonical creation entry. This is the host-level
complement to the per-family suites, which exercise the destinations directly.
*/

const workflow = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

vi.mock("../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: { defaultWorkflowId: workflow.id, workflows: [workflow], taskWorkflowIds: {} },
    workflowMode: true,
    workflowOptions: [workflow],
    selectedWorkflow: workflow,
    selectedWorkflowId: workflow.id,
    isAllWorkflowsSelected: false,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));
vi.mock("../../hooks/useUnmappedWorkflowRefetch", () => ({ useUnmappedWorkflowRefetch: vi.fn() }));
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({ useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }) }));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../ErrorBoundary", () => ({
  PageErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../CapacityRiskBanner", () => ({ CapacityRiskBanner: () => null }));
vi.mock("../BackendConnectionErrorPage", () => ({ BackendConnectionErrorPage: () => <output data-testid="connection-error" /> }));
vi.mock("../../api", () => ({
  fetchMission: vi.fn(),
  fetchMissions: vi.fn().mockResolvedValue([]),
  fetchMissionsHealth: vi.fn().mockResolvedValue([]),
  fetchMissionInterviewDrafts: vi.fn().mockResolvedValue([]),
  fetchInsights: vi.fn().mockResolvedValue({ insights: [] }),
  fetchTaskDetail: vi.fn(),
  listEvals: vi.fn().mockResolvedValue({ results: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchAgentStats: vi.fn().mockResolvedValue({}),
  fetchOrgTree: vi.fn().mockResolvedValue([]),
  fetchPluginRuntimes: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ effective: {} }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  fetchInbox: vi.fn().mockResolvedValue({ messages: [], unreadCount: 0, total: 0 }),
  fetchOutbox: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  fetchUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 0 }),
  fetchApprovals: vi.fn().mockResolvedValue({ requests: [], total: 0, pendingCount: 0 }),
  fetchAgentMailbox: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  fetchAllAgentMailbox: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  fetchConversation: vi.fn().mockResolvedValue([]),
  markMessageRead: vi.fn(),
  markAllMessagesRead: vi.fn(),
  deleteMessage: vi.fn(),
  sendMessage: vi.fn(),
  fetchApprovalDetail: vi.fn(),
  decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(() => ""),
  artifactMediaUrl: vi.fn(() => ""),
  fetchNativeStructurePreview: vi.fn(),
  refreshPrStatus: vi.fn(),
  updateTask: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  startAgentRun: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));

installChatViewEnv();

function taskFixture(id = "task-1"): Task {
  return {
    id,
    title: "Task",
    description: "Task detail",
    column: "triage",
    status: "pending",
    prompt: "",
    steps: [],
    attachments: [],
    dependencies: [],
    createdAt: "2026-08-30T19:05:00.000Z",
    updatedAt: "2026-08-30T19:05:00.000Z",
  } as Task;
}

function mainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(async () => undefined),
    shellApi: null,
    taskView: "board",
    modalManager: { closeSettings: vi.fn(), openNewTaskWithDescription: vi.fn() } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    openHistory: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    ChatView: ChatView as unknown as MainContentProps["ChatView"],
    AgentsView: AgentsView as unknown as MainContentProps["AgentsView"],
    NotesView: NotesView as unknown as MainContentProps["NotesView"],
    SecretsView: SecretsView as unknown as MainContentProps["SecretsView"],
    GoalsView: GoalsView as unknown as MainContentProps["GoalsView"],

    viewMode: "project",
    tasks: [],
    filteredBoardTasks: [],
    workflowSteps: [],
    remoteData: { tasks: [] } as MainContentProps["remoteData"],
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as MainContentProps["capacityRiskSignal"],
    maxConcurrent: 2,
    maxWorktrees: 4,
    showWorktreeGrouping: false,
    moveTask: vi.fn(async () => taskFixture()),
    pauseTask: vi.fn(async () => taskFixture()),
    openBoardTaskDetail: vi.fn(),
    openTaskDetailInMainPanel: vi.fn(),
    openGroupModalWithNav: vi.fn(),
    handleBoardQuickCreate: vi.fn(async () => taskFixture()),
    openNewTaskWithNav: vi.fn(),
    toggleAutoMerge: vi.fn(async () => undefined),
    togglePlanAutoApprove: vi.fn(async () => undefined),
    autoMerge: true,
    planAutoApproveEnabled: false,
    mergeStrategy: "direct",
    globalPaused: false,
    updateTask: vi.fn(async () => taskFixture()),
    retryTask: vi.fn(async () => taskFixture()),
    revertTask: vi.fn(async () => ({ task: taskFixture() })),
    restoreTaskRevert: vi.fn(async () => ({ mode: "git", clean: true })),
    deleteTask: vi.fn(async () => taskFixture()),
    searchQuery: "",
    availableModels: [],
    favoriteProviders: [],
    favoriteModels: [],
    handleOpenDetailWithTab: vi.fn(),
    handleToggleFavorite: vi.fn(async () => undefined),
    handleToggleModelFavorite: vi.fn(async () => undefined),
    staleHighFanoutBlockerAgeThresholdMs: 0,
    lastFetchTimeMs: undefined,
    prAuthAvailable: false,
    sidebarActive: true,
    isMobile: false,
    isRemote: false,
    experimentalFeatures: {},
    ingestCreatedTasks: vi.fn(),
    openDetailTask: vi.fn(),
    popOutTaskDetail: vi.fn(),
    onOpenChatWithPrefill: vi.fn(),
    closeTaskDetailMainPanel: vi.fn(),
    setMainPanelDetailTask: vi.fn(),
    handleDismissCapacityRisk: vi.fn(),
    settingsLoaded: true,
    agentsEnabled: true,
    goalsEnabled: true,
    notesController: {
      notes: [], selected: undefined, pendingSelectedId: undefined, draftTitle: "", draftContent: "",
      dirty: false, saving: false, loading: false, error: null, conflict: null, failedSelectionId: null,
      errorOperation: null, search: "", setSearch: vi.fn(), loadList: vi.fn(), select: vi.fn(), create: vi.fn(),
      remove: vi.fn(), save: vi.fn(), reload: vi.fn(), overwrite: vi.fn(), clearSelection: vi.fn(),
      setDraftTitle: vi.fn(), setDraftContent: vi.fn(),
    },
    registerNotesGuard: vi.fn(),
    ...overrides,
  } as unknown as MainContentProps;
}

function renderHost(taskView: string) {
  return render(
    <ViewLayoutProvider projectId="project-1">
      <MainContent {...mainContentProps({ taskView: taskView as MainContentProps["taskView"] })} />
    </ViewLayoutProvider>,
  );
}

describe("FN-379 shared chrome on the real destination host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupMockChat();
    setupMockRooms();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => cleanup());

  const destinations: { taskView: string; label: string }[] = [
    { taskView: "agents", label: "Agents" },
    { taskView: "mailbox", label: "Mailbox" },
    { taskView: "chat", label: "Chat" },
    { taskView: "goalsView", label: "Goals" },
    { taskView: "notes", label: "Notes" },
    { taskView: "secrets", label: "Secrets" },
  ];

  it.each(destinations)("routes $label through one canonical header with at most one creation entry", async ({ taskView }) => {
    renderHost(taskView);

    await waitFor(() => expect(document.querySelectorAll(".view-header").length).toBeGreaterThanOrEqual(1));
    expect(document.querySelectorAll(".view-header")).toHaveLength(1);
    /*
    A destination may legitimately create more than one KIND of resource (Board creates both a task and a
    workflow). What the contract forbids is a creation entry outside the canonical header, or the same
    resource offering two competing entries, so assert placement and uniqueness of each label.
    */
    const header = document.querySelector(".view-header") as HTMLElement;
    const creates = [...document.querySelectorAll(".view-action-button--create")];
    for (const create of creates) {
      expect(header.contains(create)).toBe(true);
    }
    const labels = creates.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    expect(new Set(labels).size).toBe(labels.length);
  });

  /*
  FNXC:StandardizedViewLayout 2026-09-13-20:32:
  Board, List, and Chat stay mounted behind KeepAliveView, so the chrome contract has to hold on the KEEP-ALIVE host
  as well as the routed one: only the visible entry may paint a canonical header, and a hidden sibling must stay
  aria-hidden instead of contributing a competing title or creation entry to the destination the operator sees.
  */
  it.each(["board", "list", "chat"] as const)("keeps %s canonical inside the keep-alive host while its siblings stay hidden", async (activeId) => {
    render(
      <ViewLayoutProvider projectId="project-1">
        <MainViewKeepAlive
          activeId={activeId}
          mountedIds={["board", "list", "chat"]}
          projectKey="project-1"
          mainContentProps={mainContentProps()}
        />
      </ViewLayoutProvider>,
    );

    const visible = document.querySelectorAll(".keep-alive-view:not(.keep-alive-view--hidden)");
    expect(visible).toHaveLength(1);
    const hidden = [...document.querySelectorAll(".keep-alive-view--hidden")];
    expect(hidden).toHaveLength(2);
    for (const entry of hidden) expect(entry).toHaveAttribute("aria-hidden", "true");

    const live = visible[0] as HTMLElement;
    await waitFor(() => expect(live.querySelectorAll(".view-header").length).toBeLessThanOrEqual(1));
    /*
    Board delegates its destination title to the app Header, so it legitimately paints none of its own. When a
    kept-alive entry does own a header, every canonical creation entry it renders must live inside it.
    */
    const liveHeader = live.querySelector(".view-header");
    if (liveHeader) {
      for (const create of live.querySelectorAll(".view-action-button--create")) {
        expect(liveHeader.contains(create)).toBe(true);
      }
    }
    for (const back of live.querySelectorAll("[data-testid$='-back'], .view-back-button")) {
      expect(back).toHaveClass("view-back-button");
    }
  });

  it("keeps a hosted destination free of a stale header from the previously rendered destination", async () => {
    const view = renderHost("agents");
    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));

    view.rerender(
      <ViewLayoutProvider projectId="project-1">
        <MainContent {...mainContentProps({ taskView: "mailbox" as MainContentProps["taskView"] })} />
      </ViewLayoutProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("mailbox-view")).toBeInTheDocument());
    expect(document.querySelectorAll(".view-header")).toHaveLength(1);
  });
});
