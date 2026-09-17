/**
 * FN-468 — Chat doit avoir un hôte de page sur TOUTE la bande du shell mobile (téléphone ET tablette).
 *
 * Symptôme corrigé : entre 769 et 1023 px, la tablette n'a plus ni dock droit ni colonne de gauche, mais
 * `resolveChatHost` ne connaissait que le tiroir téléphone. Il renvoyait donc `"none"`, `chatPageHostEnabled`
 * restait faux dans `MainContent`, l'entrée Chat était évincée du keep-alive, et le bouton Chat de la pill (comme
 * le raccourci clavier liste de conversations) affichait une zone principale VIDE.
 *
 * Ces cas montent la composition de PRODUCTION (`resolveChatHost` → `MainContent` → keep-alive → `ChatView`) :
 * l'ancien comportement (`chatPageHost: "none"`) ne rend aucune surface Chat, le nouveau en rend une.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ChatView } from "../ChatView";
import { MainContent } from "../dashboard/MainContent";
import type { MainContentProps } from "../dashboard/types";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { installChatViewEnv, setupMockChat, setupMockRooms } from "./ChatView.test-harness";
import { resolveChatHost } from "../../utils/navigationPlacement";
import { isMobileShellMode } from "../../hooks/useViewportMode";

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
  fetchUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 0 }),
  fetchInbox: vi.fn().mockResolvedValue({ messages: [], unreadCount: 0, total: 0 }),
  fetchOutbox: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
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
  fetchNativeStructurePreview: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  startAgentRun: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(() => ""),
  artifactMediaUrl: vi.fn(() => ""),
  refreshPrStatus: vi.fn(),
  updateTask: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));

installChatViewEnv();

function taskFixture(): Task {
  return {
    id: "task-1",
    title: "Task",
    description: "Task detail",
    column: "triage",
    status: "pending",
    prompt: "",
    steps: [],
    attachments: [],
    dependencies: [],
    createdAt: "2026-09-16T20:16:00.000Z",
    updatedAt: "2026-09-16T20:16:00.000Z",
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
    taskView: "chat",
    modalManager: { closeSettings: vi.fn(), openNewTaskWithDescription: vi.fn() } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    openHistory: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    ChatView: ChatView as unknown as MainContentProps["ChatView"],
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
    sidebarActive: false,
    /* La tablette n'est PAS un téléphone : `isMobile` reste faux, donc aucun tiroir plein écran n'est monté. */
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

function renderChatHost(overrides: Partial<MainContentProps>) {
  return render(
    <ViewLayoutProvider projectId="project-1">
      <MainContent {...mainContentProps(overrides)} />
    </ViewLayoutProvider>,
  );
}

describe("FN-468 Chat host across the mobile shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupMockChat();
    setupMockRooms();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => cleanup());

  /*
  Le décideur partagé : sur tablette il n'y a ni tiroir téléphone, ni dock, ni colonne, et le host doit
  néanmoins exister. C'est ce que l'ancien contrat rendait impossible (`"none"`).
  */
  it("resolves a page host for the tablet band with neither a drawer nor a dock", () => {
    expect(
      resolveChatHost({
        mobileDrawerActive: false,
        mobileShellActive: isMobileShellMode("tablet"),
        rightDockActive: false,
        navigationPlacement: "footer",
      }),
    ).toBe("mobile-page");
    expect(
      resolveChatHost({
        mobileDrawerActive: false,
        mobileShellActive: isMobileShellMode("desktop"),
        rightDockActive: true,
        navigationPlacement: "footer",
      }),
    ).toBe("dock");
  });

  // Preuve symptomatique : l'ancien host tablette (`"none"`) ne rendait AUCUNE surface Chat.
  it("renders no Chat surface under the pre-fix tablet host", async () => {
    const { container } = renderChatHost({ chatPageHost: "none" });
    await waitFor(() => expect(container.querySelector(".chat-view")).toBeNull());
    expect(container.querySelector(".chat-view")).toBeNull();
  });

  // Après correction : le host de page tablette monte réellement Chat dans la zone principale.
  it("renders a Chat surface for the tablet page host without any drawer wrapper", async () => {
    const { container } = renderChatHost({ chatPageHost: "mobile-page" });
    await waitFor(() => expect(container.querySelector(".chat-view")).not.toBeNull());
    expect(container.querySelector(".mobile-drawer")).toBeNull();
  });
});
