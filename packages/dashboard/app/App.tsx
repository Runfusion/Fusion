import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
  type ChatRoomMessage,
  type Task,
  type TaskDetail,
  type WorkflowStep,
} from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../core/src/near-duplicate-canonical";
import { Header, useViewportMode } from "./components/Header";
import { Board } from "./components/Board";
import { TaskCard } from "./components/TaskCard";
import { ListView } from "./components/ListView";
import { ProjectOverview } from "./components/ProjectOverview";
import { MissionManager } from "./components/MissionManager";
import { MailboxView } from "./components/MailboxView";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import { AppModals } from "./components/AppModals";
import { BackendConnectionErrorPage } from "./components/BackendConnectionErrorPage";
import { DashboardLoader, type DashboardLoaderStage } from "./components/DashboardLoader";
import { TopProgressBar } from "./components/TopProgressBar";
import { ExecutorStatusBar } from "./components/ExecutorStatusBar";
import { SessionNotificationBanner, type CliActionId } from "./components/SessionNotificationBanner";
import { CliBinaryInstallBanner } from "./components/CliBinaryInstallBanner";
import { SetupWarningBanner } from "./components/SetupWarningBanner";
import { CapacityRiskBanner } from "./components/CapacityRiskBanner";
import { TestModeBanner } from "./components/TestModeBanner";
import { OAuthReloginBanner } from "./components/OAuthReloginBanner";
import { TaskIdIntegrityBanner } from "./components/TaskIdIntegrityBanner";
import { DbCorruptionBanner } from "./components/DbCorruptionBanner";
import { UpdateAvailableBanner } from "./components/UpdateAvailableBanner";
import MergeAdvanceNotice from "./components/MergeAdvanceNotice";
import { ApprovalNotificationBanner } from "./components/ApprovalNotificationBanner";
import { GitHubStarPrompt } from "./components/GitHubStarPrompt";
import { OnboardingResumeCard } from "./components/OnboardingResumeCard";
import { PostOnboardingRecommendations } from "./components/PostOnboardingRecommendations";
import {
  isOnboardingCompleted,
  isOnboardingResumable,
  isPostOnboardingDismissed,
} from "./components/model-onboarding-state";
import type { SectionId } from "./components/SettingsModal";
import { MobileNavBar } from "./components/MobileNavBar";
import { QuickChatFAB } from "./components/QuickChatFAB";
import { ToastContainer } from "./components/ToastContainer";
import { useBackgroundSessions } from "./hooks/useBackgroundSessions";
import { useGitHubStarPromptShown, markGitHubStarPromptShown } from "./hooks/useGitHubStarPrompt";
import { useSessionBannersHidden } from "./hooks/useSessionBannerPref";
import { useTasks } from "./hooks/useTasks";
import { useProjects } from "./hooks/useProjects";
import { useAgents } from "./hooks/useAgents";
import { useNodes } from "./hooks/useNodes";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import { ToastProvider, useToast } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { useTheme } from "./hooks/useTheme";
import { useModalManager, type DetailTaskOrigin, type DetailTaskTab } from "./hooks/useModalManager";
import { useAppSettings } from "./hooks/useAppSettings";
import { useDeepLink } from "./hooks/useDeepLink";
import { useFavorites } from "./hooks/useFavorites";
import { useAuthOnboarding } from "./hooks/useAuthOnboarding";
import { useMobileKeyboard } from "./hooks/useMobileKeyboard";
import { isIOS, useMobileKeyboardViewportLock, useMobileViewportRestoreReset } from "./hooks/useMobileScrollLock";
import { computeMobileBarKeyboardFlags } from "./utils/mobileBarKeyboardFlags";
import { useSetupReadiness } from "./hooks/useSetupReadiness";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useViewState, type TaskView } from "./hooks/useViewState";
import { NavigationHistoryProvider, useNavigationHistory } from "./hooks/useNavigationHistory";
import { usePluginDashboardViews } from "./hooks/usePluginDashboardViews";
import { PluginDashboardViewHost } from "./plugins/PluginDashboardViewHost";
import { isPluginViewId, isPluginViewRegistered } from "./plugins/pluginViewRegistry";
import { registerBundledPluginViews } from "./plugins/registerBundledPluginViews";
import { useProjectActions } from "./hooks/useProjectActions";
import { useTaskHandlers } from "./hooks/useTaskHandlers";
import { useRemoteNodeData } from "./hooks/useRemoteNodeData";
import { useRemoteNodeEvents } from "./hooks/useRemoteNodeEvents";
import { isLikelyTabSuspensionError } from "./hooks/visibilitySuspension";
import { NodeProvider, useNodeContext } from "./context/NodeContext";
import { FileBrowserProvider } from "./context/FileBrowserContext";
import { ShellProvider } from "./context/ShellContext";
import { RetryWarningProvider } from "./context/RetryWarningContext";
import { ShellHostProvider, useShellHostContext } from "./context/ShellHostContext";
import { useShellConnection } from "./hooks/useShellConnection";
import { NativeShellOnboardingModal } from "./components/NativeShellOnboardingModal";
import { NativeShellConnectionManager } from "./components/NativeShellConnectionManager";
import { ShellConnectionStatus } from "./components/ShellConnectionStatus";
import { getShellConnectionNativeResult, type ShellConnectionNativeResult } from "./shell-native";
import type { AiSessionSummary, DashboardHealthResponse } from "./api";
import { api, fetchDashboardHealth, fetchUnreadCount, fetchTaskDetail, fetchWorkflowSteps, refreshDashboardHealth, relaunchCliSession } from "./api";
import { getScopedItem, removeScopedItem, setScopedItem } from "./utils/projectStorage";
import { subscribeSse } from "./sse-bus";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } from "./auth";
import { AuthTokenRecoveryDialog } from "./components/AuthTokenRecoveryDialog";

// ChatView's CSS is imported eagerly so the styles bundle into the main
// CSS file. Without this, the lazy ChatView JS chunk loaded its own CSS
// link asynchronously, producing a brief flash of unstyled chat UI on
// first render.
import "./components/ChatView.css";

const IS_TEST_ENV = import.meta.env.MODE === "test";

const AgentsView = lazy(() => import("./components/AgentsView").then((m) => ({ default: m.AgentsView })));
const DocumentsView = lazy(() => import("./components/DocumentsView").then((m) => ({ default: m.DocumentsView })));
const InsightsView = lazy(() => import("./components/InsightsView").then((m) => ({ default: m.InsightsView })));
const ResearchView = lazy(() => import("./components/ResearchView").then((m) => ({ default: m.ResearchView })));
const EvalsView = lazy(() => import("./components/EvalsView").then((m) => ({ default: m.EvalsView })));
const NodesView = lazy(() => import("./components/NodesView").then((m) => ({ default: m.NodesView })));
const ChatView = lazy(() => import("./components/ChatView").then((m) => ({ default: m.ChatView })));

const SkillsView = lazy(() => import("./components/SkillsView").then((m) => ({ default: m.SkillsView })));
const MemoryView = lazy(() => import("./components/MemoryView").then((m) => ({ default: m.MemoryView })));
const SecretsView = lazy(() => import("./components/SecretsView").then((m) => ({ default: m.SecretsView })));
const CommandCenter = lazy(() => import("./components/command-center/CommandCenter").then((m) => ({ default: m.CommandCenter })));
const DevServerView = lazy(() => import("./components/DevServerView").then((m) => ({ default: m.DevServerView })));
const _TodoView = lazy(() => import("./components/TodoView").then((m) => ({ default: m.TodoView })));
const GoalsView = lazy(() => import("./components/GoalsView").then((m) => ({ default: m.GoalsView })));
const StashRecoveryView = lazy(() => import("./components/StashRecoveryView").then((m) => ({ default: m.StashRecoveryView })));
const PullRequestView = lazy(() => import("./components/PullRequestView").then((m) => ({ default: m.PullRequestView })));

// Warm lazy chunks during browser idle so first navigation to each view is
// instant. Each chunk is ~10–80 kB; total prefetch finishes well under a
// second on broadband. Uses requestIdleCallback so it never blocks render.
function prefetchLazyViews() {
  if (IS_TEST_ENV) {
    return;
  }

  const idle =
    (typeof window !== "undefined" && (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback) ||
    ((cb: () => void) => setTimeout(cb, 200));
  idle(() => {
    void import("./components/AgentsView");
    void import("./components/DocumentsView");
    void import("./components/InsightsView");
    void import("./components/ResearchView");
    void import("./components/EvalsView");
    void import("./components/NodesView");
    void import("./components/ChatView");

    void import("./components/SkillsView");
    void import("./components/MemoryView");
    void import("./components/SecretsView");
    void import("./components/command-center/CommandCenter");
    void import("./components/DevServerView");
    void import("./components/TodoView");
    void import("./components/GoalsView");
    void import("./components/StashRecoveryView");
    void import("./components/PullRequestView");
  });
}

registerBundledPluginViews();

const SETUP_WARNING_DISMISSED_KEY = "kb-setup-warning-dismissed";
const WORKING_BRANCH_FILTER_STORAGE_KEY = "kb-dashboard-working-branch-filter";
const BASE_BRANCH_FILTER_STORAGE_KEY = "kb-dashboard-base-branch-filter";
const NO_BRANCH_FILTER_VALUE = "__fusion:no-branch__";
const APPROVAL_BANNER_DISMISSED_STORAGE_KEY = "fusion:approval-banner-dismissed";
const CAPACITY_RISK_DISMISSED_KEY = "kb-capacity-risk-banner-dismissed";
const RETRY_WARNING_RATIO = 0.8;

interface ApprovalBannerCandidate {
  dedupeKey: string;
  updatedAtMs: number;
}

export function didEnterAwaitingApproval(nextStatus: string | undefined, previousStatus: string | undefined): boolean {
  return nextStatus === "awaiting-approval" && previousStatus !== "awaiting-approval";
}

export function didEnterDone(nextStatus: string | undefined, previousStatus: string | undefined): boolean {
  return nextStatus === "done" && previousStatus !== undefined && previousStatus !== "done";
}

function parseDateMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function loadApprovalBannerDismissals(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(APPROVAL_BANNER_DISMISSED_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, number>;
    const map = new Map<string, number>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function persistApprovalBannerDismissals(map: Map<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    const data: Record<string, number> = {};
    for (const [key, value] of map) {
      data[key] = value;
    }
    window.localStorage.setItem(APPROVAL_BANNER_DISMISSED_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // no-op
  }
}

function buildRemoteDashboardUrl(serverUrl: string, authToken?: string | null): string {
  const url = new URL(serverUrl);
  if (authToken) {
    url.searchParams.set("rt", authToken);
  }
  return url.toString();
}

export function requiresNativeShellOnboarding(
  shellState: { host: "web" | "mobile-shell" | "desktop-shell"; desktopMode?: "local" | "remote"; activeProfileId: string | null },
  shellReady: boolean,
  shellOnboardingComplete: boolean,
): boolean {
  if (!shellReady || shellOnboardingComplete || shellState.host === "web") {
    return false;
  }

  if (shellState.host === "mobile-shell") {
    return !shellState.activeProfileId;
  }

  if (shellState.desktopMode === "local") {
    return false;
  }

  return !shellState.activeProfileId;
}

export function shouldShowFirstEverBootLoader(projectsLoading: boolean, projectCount: number): boolean {
  return projectsLoading && projectCount === 0;
}

export function isSessionNeedingInputForBanner(session: AiSessionSummary): boolean {
  return (
    session.status === "awaiting_input" ||
    session.status === "error" ||
    session.status === "waiting_on_input" ||
    session.status === "needs_attention"
  );
}

export function getCliActionDisabledReasonForBanner(session: AiSessionSummary, action: CliActionId): string | null {
  if ((action === "advance" || action === "relaunch") && !session.cliSessionId) {
    return "CLI session id is missing.";
  }
  return null;
}

interface CliActionDeps {
  currentProjectId?: string;
  retryTask: (id: string) => Promise<unknown>;
  moveTask: (id: string, column: "todo") => Promise<unknown>;
  openAuthenticationSettings: () => void;
  addToast: (message: string, type: "success" | "error") => void;
  apiClient?: typeof api;
  relaunchCliSessionClient?: typeof relaunchCliSession;
}

export async function executeCliSessionBannerAction(
  session: AiSessionSummary,
  action: CliActionId,
  deps: CliActionDeps,
): Promise<void> {
  try {
    /*
     * FNXC:SessionBanner 2026-06-14-19:32:
     * CLI banner verbs must either call an existing dashboard route/flow or be disabled by the banner. `advance` confirms the CLI session, `retry` and `cancel` reuse task operations keyed by the session id until summaries expose a distinct task id, and `reauthenticate` opens the existing authentication settings flow.
     *
     * FNXC:SessionBanner 2026-06-14-20:16:
     * `relaunch` is now a supported route-backed action for resume-exhausted CLI sessions; if `cliSessionId` is absent the handler exits without firing a malformed API call, preserving the no-silent-no-op invariant through the banner disabled reason.
     */
    if (action === "advance") {
      if (!session.cliSessionId) {
        throw new Error("CLI session id is required to advance this session.");
      }
      await (deps.apiClient ?? api)(`/cli-sessions/${encodeURIComponent(session.cliSessionId)}/confirm-advance`, {
        method: "POST",
        body: JSON.stringify({ decision: "advance", ...(deps.currentProjectId ? { projectId: deps.currentProjectId } : {}) }),
      });
      return;
    }

    if (action === "relaunch") {
      if (!session.cliSessionId) return;
      await (deps.relaunchCliSessionClient ?? relaunchCliSession)(session.cliSessionId, deps.currentProjectId);
      deps.addToast("CLI session relaunch requested", "success");
      return;
    }

    if (action === "retry") {
      await deps.retryTask(session.id);
      return;
    }

    if (action === "cancel") {
      await deps.moveTask(session.id, "todo");
      return;
    }

    if (action === "reauthenticate") {
      deps.openAuthenticationSettings();
      return;
    }

    throw new Error("This CLI action is not supported yet.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "CLI action failed";
    deps.addToast(message, "error");
  }
}

function AppInner() {
  const { t } = useTranslation("app");
  const { toasts, addToast, removeToast } = useToast();
  const { shellApi, state: shellState, ready: shellReady, openConnectionManagerSignal } = useShellConnection();
  const shellHost = useShellHostContext();

  // Warm lazy view chunks during browser idle so first navigation is instant.
  useEffect(() => {
    prefetchLazyViews();
  }, []);

  // Project management hooks - MUST be called before any conditional logic
  const { projects, loading: projectsLoading, error: projectsError, refresh: refreshProjects } = useProjects();
  const hasEverLoadedProjectsRef = useRef(projects.length > 0);
  const { nodes } = useNodes();

  useEffect(() => {
    if (projects.length > 0) {
      hasEverLoadedProjectsRef.current = true;
    }
  }, [projects.length]);

  // Node context for local/remote node switching - must be called before useCurrentProject
  const { currentNode, currentNodeId, isRemote, setCurrentNode, clearCurrentNode } = useNodeContext();

  // Current project with node-aware persistence
  const { currentProject, setCurrentProject, clearCurrentProject, loading: currentProjectLoading } = useCurrentProject(projects, { nodeId: currentNodeId });

  const {
    hasAiProvider,
    hasGithub,
    loading: setupReadinessLoading,
    hasWarnings,
  } = useSetupReadiness(currentProject?.id);
  const {
    updateAvailable,
    latestVersion,
    currentVersion,
    dismissed: updateBannerDismissed,
    dismiss: dismissUpdateBanner,
  } = useUpdateCheck();
  
  // Sync node context with useNodes() results:
  // - Resolve saved node ID to full NodeConfig when nodes list loads
  // - Fall back to local if selected node is missing or deleted
  useEffect(() => {
    // If we have a saved node ID but no currentNode yet (initial hydration),
    // resolve it from the nodes list
    if (currentNodeId && !currentNode && nodes.length > 0) {
      const foundNode = nodes.find((n) => n.id === currentNodeId);
      if (foundNode) {
        setCurrentNode(foundNode);
        return;
      }
    }
    
    // If we have a currentNode but the saved ID no longer exists in nodes list,
    // fall back to local view
    if (currentNodeId && nodes.length > 0) {
      const nodeExists = nodes.some((n) => n.id === currentNodeId);
      if (!nodeExists) {
        // Selected node was deleted or unregistered - fall back to local
        clearCurrentNode();
      }
    }
  }, [currentNodeId, currentNode, nodes, setCurrentNode, clearCurrentNode]);
  
  // Search query state - must be defined before useTasks
  const [searchQuery, setSearchQuery] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [baseBranchFilter, setBaseBranchFilter] = useState("");

  useEffect(() => {
    setBranchFilter(getScopedItem(WORKING_BRANCH_FILTER_STORAGE_KEY, currentProject?.id) ?? "");
    setBaseBranchFilter(getScopedItem(BASE_BRANCH_FILTER_STORAGE_KEY, currentProject?.id) ?? "");
  }, [currentProject?.id]);

  const handleBranchFilterChange = useCallback((value: string) => {
    setBranchFilter(value);
    setScopedItem(WORKING_BRANCH_FILTER_STORAGE_KEY, value, currentProject?.id);
  }, [currentProject?.id]);

  const handleBaseBranchFilterChange = useCallback((value: string) => {
    setBaseBranchFilter(value);
    setScopedItem(BASE_BRANCH_FILTER_STORAGE_KEY, value, currentProject?.id);
  }, [currentProject?.id]);

  // Host capability handed to plugin dashboard views: subscribe to a plugin's
  // custom SSE events (forwarded by the server as `plugin:custom`, scoped to the
  // current project) over the shared bus — so plugins push live updates without
  // deep-importing the dashboard's sse-bus or opening their own EventSource.
  const subscribePluginEvents = useCallback(
    (pluginId: string, onEvent: (e: { event: string; payload: unknown }) => void) => {
      const params = new URLSearchParams();
      if (currentProject?.id) params.set("projectId", currentProject.id);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      return subscribeSse(`/api/events${query}`, {
        events: {
          "plugin:custom": (event: MessageEvent) => {
            try {
              const d = JSON.parse(event.data) as { pluginId?: string; event?: string; payload?: unknown };
              if (d.pluginId === pluginId && typeof d.event === "string") {
                onEvent({ event: d.event, payload: d.payload });
              }
            } catch {
              // Ignore malformed plugin:custom payloads.
            }
          },
        },
      });
    },
    [currentProject?.id],
  );

  // Remote node data and events when in remote mode (pass searchQuery for server-side filtering)
  const remoteData = useRemoteNodeData(currentNodeId, { projectId: currentProject?.id, searchQuery: searchQuery || undefined });
  useRemoteNodeEvents(currentNodeId);

  // Use remote data when in remote mode, local data otherwise
  const effectiveProjects = isRemote && remoteData.projects.length > 0 ? remoteData.projects : projects;
  
  // Theme management - required before useViewState
  const { themeMode, colorTheme, dashboardFontScalePct, setThemeMode, setColorTheme, setDashboardFontScalePct } = useTheme();

  // Background AI sessions - required before useModalManager
  const { sessions: bgSessions, generating: bgGenerating, needsInput: bgNeedsInput, planningSessions: bgPlanningSessions, dismissSession: bgDismiss } = useBackgroundSessions(currentProject?.id);
  /*
   * FNXC:SessionBanner 2026-06-14-19:32:
   * CLI agent sessions use `waiting_on_input` and `needs_attention` to represent user-actionable states. The banner feed must include those statuses in addition to the legacy planning-session statuses so visible CLI actions cannot be silently hidden from users.
   */
  const sessionsNeedingInput = bgSessions.filter(isSessionNeedingInputForBanner);
  const sessionBannersHidden = useSessionBannersHidden();

  // Modal state/handlers - required before useViewState
  const modalManager = useModalManager({
    projectId: currentProject?.id,
    planningSessions: bgPlanningSessions,
  });

  // Viewport mode and mobile detection — MUST be before useViewState so that
  // useNavigationHistory (and pushNav) are defined before handleTaskViewChange
  // references them, avoiding a TDZ violation.
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";

  // Navigation history for browser back button (desktop + mobile).
  const { pushNav, replaceCurrent, removeNav } = useNavigationHistory({ enabled: true });

  // View state must be defined before useTasks since useTasks depends on taskView for SSE gating
  const { viewMode, setViewMode, taskView, handleChangeTaskView } = useViewState({
    projectsLoading,
    projectsError,
    currentProjectLoading,
    currentProject,
    projectsLength: projects.length,
    setupWizardOpen: modalManager.setupWizardOpen,
    openSetupWizard: modalManager.openSetupWizard,
    themeMode,
    setThemeMode,
  });

  const { views: pluginDashboardViews } = usePluginDashboardViews(currentProject?.id);
  const graphPluginTaskView = useMemo(() => {
    // Prefer API response for the graph view (supports dynamic plugin discovery)
    const graphView = pluginDashboardViews.find(
      (entry) => entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph",
    );
    if (graphView) return `plugin:${graphView.pluginId}:${graphView.view.viewId}` as const;
    // Fall back to bundled static registration so the graph view works even when
    // the plugin is not installed/loaded through the API (e.g. fresh DB).
    if (isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")) {
      return `plugin:fusion-plugin-dependency-graph:graph` as const;
    }
    return null;
  }, [pluginDashboardViews]);

  // History-aware view change handler — pushes nav entry on back-navigation stack.
  const handleTaskViewChange = useCallback((newView: TaskView) => {
    if (newView === "missions") {
      setMissionResumeSessionId(undefined);
      setMissionTargetId(undefined);
      setMilestoneSliceResumeSessionId(undefined);
    }
    if (newView !== "goalsView") {
      setGoalAnchorId(undefined);
    }
    const previousView = taskView;
    handleChangeTaskView(newView);
    if (previousView !== newView) {
      pushNav({ type: "view", revert: () => handleChangeTaskView(previousView) });
    }
  }, [handleChangeTaskView, taskView, pushNav]);

  // Tasks hook with project context and search query
  // SSE is only enabled for board/list views to free connection slots for mission detail fetches
  const taskSseEnabled = taskView === "board" || taskView === "list";
  const { tasks, isStale, createTask, moveTask, pauseTask, unpauseTask, deleteTask, mergeTask, retryTask, resetTask, updateTask, duplicateTask, archiveTask, unarchiveTask, archiveAllDone, loadArchivedTasks, refreshTasks, ingestCreatedTasks, lastFetchTimeMs } = useTasks(
    {
      ...(currentProject ? { projectId: currentProject.id } : {}),
      searchQuery: searchQuery || undefined,
      sseEnabled: taskSseEnabled,
    }
  );

  const previousTaskViewRef = useRef<TaskView>(taskView);

  useEffect(() => {
    const previousTaskView = previousTaskViewRef.current;
    const wasTaskView = previousTaskView === "board" || previousTaskView === "list";
    const isTaskView = taskView === "board" || taskView === "list";

    // Task SSE is disabled off board/list. Refetch once when returning because
    // in-app navigation does not trigger document.visibilitychange.
    if (!wasTaskView && isTaskView) {
      void refreshTasks();
    }

    previousTaskViewRef.current = taskView;
  }, [taskView, refreshTasks]);

  const boardSourceTasks = isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks;

  const [researchReadinessVersion, setResearchReadinessVersion] = useState(0);
  const mountTimeRef = useRef(performance.now());
  const projectsReadyLoggedRef = useRef(false);
  const projectReadyLoggedRef = useRef(false);
  const dashboardReadyLoggedRef = useRef(false);

  const loadingStage = useMemo<DashboardLoaderStage>(() => {
    if (projectsLoading) return "projects";
    if (currentProjectLoading) return "project";
    return "tasks";
  }, [projectsLoading, currentProjectLoading]);

  useEffect(() => {
    if (!projectsLoading && !projectsReadyLoggedRef.current) {
      projectsReadyLoggedRef.current = true;
      const msg = `projects loaded at ${Math.round(performance.now() - mountTimeRef.current)}ms from mount`;
      if (!IS_TEST_ENV) {
        console.log(`[App] ${msg}`);
      }
    }
    if (!currentProjectLoading && !projectReadyLoggedRef.current) {
      projectReadyLoggedRef.current = true;
      const msg = `current-project resolved at ${Math.round(performance.now() - mountTimeRef.current)}ms from mount`;
      if (!IS_TEST_ENV) {
        console.log(`[App] ${msg}`);
      }
    }
  }, [projectsLoading, currentProjectLoading]);

  const initialLoadComplete = !projectsLoading && !currentProjectLoading;
  const isFirstEverBoot = shouldShowFirstEverBootLoader(projectsLoading, projects.length);

  useEffect(() => {
    if (!initialLoadComplete || dashboardReadyLoggedRef.current) {
      return;
    }
    dashboardReadyLoggedRef.current = true;
    const msg = `dashboard ready at ${Math.round(performance.now() - mountTimeRef.current)}ms from mount`;
    if (!IS_TEST_ENV) {
      console.log(`[App] ${msg}`);
    }
  }, [initialLoadComplete]);

  const [quickChatOpen, setQuickChatOpen] = useState(false);

  const { keyboardOpen } = useMobileKeyboard({ enabled: isMobile });
  // Keyboard visibility controls both MobileNavBar rendering and whether
  // the project content reserves bottom padding for the mobile nav bar.
  // When a modal is open, modal-local inputs can trigger the keyboard without
  // affecting the underlying dashboard layout — the modal handles its own
  // viewport. Without this guard, modal keyboard state leaks into the app-level
  // layout, causing stale bottom-padding offsets after the keyboard closes.
  //
  // Android-gated: with `interactive-widget=resizes-content` the layout
  // viewport itself shrinks with the soft keyboard, so we DON'T want to
  // also hide the nav bar / strip its padding — that produces a layout
  // jump while the focused input is settling, which Android Chrome treats
  // as the focus target moving and dismisses the keyboard immediately.
  // iOS doesn't shrink the layout viewport, so the iOS path keeps the
  // hide-nav-on-keyboard behavior intact.
  //
  // FN-5707: keep nav pinning cross-platform, but only apply the footer
  // keyboard-collapse class on iOS. On Android, collapsing the footer to
  // `bottom: 0` overlaps it with the nav bar because the layout viewport
  // already shrinks and the stacked footer position is already correct.
  const { footerHidden, navKeyboardOpen, footerKeyboardOpen } = computeMobileBarKeyboardFlags({
    isMobile,
    keyboardOpen,
    anyModalOpen: modalManager.anyModalOpen,
    overlayOpen: isMobile && quickChatOpen,
    isIOS: isIOS(),
  });
  const mobileKeyboardOpen = footerHidden;
  const mobileNavKeyboardOpen = navKeyboardOpen;
  // App-level scroll lock for inline editing (TaskCard inline edit, etc.):
  // when the keyboard is up outside of any modal, pin the body so iOS can't
  // shift the document or visualViewport, and so the dashboard snaps back
  // into place when the keyboard dismisses. Modals manage their own lock
  // via useMobileScrollLock — the reference-counted hook handles overlap.
  useMobileKeyboardViewportLock(mobileKeyboardOpen);
  // Complements FN-6362's keyboard metrics reset by recovering stale document scroll on foreground.
  useMobileViewportRestoreReset(isMobile);

  // App-level mailbox/chat unread state (used for header/mobile nav badges)
  const [mailboxUnreadCount, setMailboxUnreadCount] = useState(0);
  const [mailboxPendingApprovalCount, setMailboxPendingApprovalCount] = useState(0);
  const [chatHasUnreadResponse, setChatHasUnreadResponse] = useState(false);
  const [stashOrphanCount, setStashOrphanCount] = useState(0);
  const [approvalBannerCandidate, setApprovalBannerCandidate] = useState<ApprovalBannerCandidate | null>(null);
  const [showGitHubStarPrompt, setShowGitHubStarPrompt] = useState(false);
  const taskStatusByIdRef = useRef<Map<string, string | undefined>>(new Map());
  const seenApprovalKeysRef = useRef<Set<string>>(new Set());
  const approvalDismissalsRef = useRef<Map<string, number>>(loadApprovalBannerDismissals());
  const gitHubStarPromptShown = useGitHubStarPromptShown();

  const refreshMailboxUnreadCount = useCallback(() => {
    fetchUnreadCount(currentProject?.id)
      .then((data: { unreadCount: number; pendingApprovalCount?: number }) => {
        setMailboxUnreadCount(data.unreadCount);
        setMailboxPendingApprovalCount(data.pendingApprovalCount ?? 0);
      })
      .catch((err) => {
        console.warn("[App] Failed to fetch mailbox unread count:", err);
      });
  }, [currentProject?.id]);

  useEffect(() => {
    const next = new Map<string, string | undefined>();
    const nextSeen = new Set<string>();
    for (const task of tasks) {
      next.set(task.id, task.status);
      if (task.status === "awaiting-approval") {
        nextSeen.add(`task:${task.id}`);
      }
    }
    taskStatusByIdRef.current = next;
    seenApprovalKeysRef.current = nextSeen;
  }, [tasks]);

  // Initial fetch + live updates from mailbox SSE events.
  useEffect(() => {
    refreshMailboxUnreadCount();

    const params = new URLSearchParams();
    if (currentProject?.id) {
      params.set("projectId", currentProject.id);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    const triggerApprovalBanner = (candidate: ApprovalBannerCandidate) => {
      const dismissedAt = approvalDismissalsRef.current.get(candidate.dedupeKey);
      if (dismissedAt !== undefined && candidate.updatedAtMs <= dismissedAt) {
        return;
      }
      setApprovalBannerCandidate(candidate);
    };

    return subscribeSse(`/api/events${query}`, {
      onReconnect: refreshMailboxUnreadCount,
      events: {
        "message:sent": refreshMailboxUnreadCount,
        "message:received": refreshMailboxUnreadCount,
        "message:read": refreshMailboxUnreadCount,
        "message:deleted": refreshMailboxUnreadCount,
        "approval:requested": (event: MessageEvent) => {
          refreshMailboxUnreadCount();
          try {
            const payload = JSON.parse(event.data) as { id?: string; taskId?: string; updatedAt?: string; createdAt?: string };
            const dedupeKey = payload.id ? `approval:${payload.id}` : payload.taskId ? `task:${payload.taskId}` : undefined;
            if (!dedupeKey || seenApprovalKeysRef.current.has(dedupeKey)) {
              return;
            }
            seenApprovalKeysRef.current.add(dedupeKey);
            triggerApprovalBanner({
              dedupeKey,
              updatedAtMs: parseDateMs(payload.updatedAt ?? payload.createdAt),
            });
          } catch {
            // no-op
          }
        },
        "approval:updated": refreshMailboxUnreadCount,
        "approval:decided": refreshMailboxUnreadCount,
        "task:updated": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as { id?: string; status?: string; updatedAt?: string };
            if (!payload?.id) {
              return;
            }
            const dedupeKey = `task:${payload.id}`;
            const previousStatus = taskStatusByIdRef.current.get(payload.id);
            taskStatusByIdRef.current.set(payload.id, payload.status);
            if (!gitHubStarPromptShown && didEnterDone(payload.status, previousStatus)) {
              setShowGitHubStarPrompt(true);
            }
            if (payload.status !== "awaiting-approval") {
              seenApprovalKeysRef.current.delete(dedupeKey);
              approvalDismissalsRef.current.delete(dedupeKey);
              persistApprovalBannerDismissals(approvalDismissalsRef.current);
              return;
            }
            if (seenApprovalKeysRef.current.has(dedupeKey)) {
              return;
            }
            if (didEnterAwaitingApproval(payload.status, previousStatus)) {
              seenApprovalKeysRef.current.add(dedupeKey);
              triggerApprovalBanner({
                dedupeKey,
                updatedAtMs: parseDateMs(payload.updatedAt),
              });
              refreshMailboxUnreadCount();
            }
          } catch {
            // no-op
          }
        },
      },
    });
  }, [currentProject?.id, gitHubStarPromptShown, refreshMailboxUnreadCount]);

  useEffect(() => {
    if (taskView === "chat") {
      setChatHasUnreadResponse(false);
    }
  }, [taskView]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<{ count: number }>("/stash-recovery/orphans");
        if (!cancelled) setStashOrphanCount(data.count ?? 0);
      } catch {
        if (!cancelled) setStashOrphanCount(0);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentProject?.id]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (currentProject?.id) {
      params.set("projectId", currentProject.id);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    return subscribeSse(`/api/events${query}`, {
      events: {
        "chat:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as { role?: string; projectId?: string | null };
            if (payload.role !== "assistant") return;
            if (taskView === "chat") return;
            if (payload.projectId && currentProject?.id && payload.projectId !== currentProject.id) return;
            setChatHasUnreadResponse(true);
          } catch {
            // no-op
          }
        },
        "chat:room:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as ChatRoomMessage & { projectId?: string | null };
            if (payload.role === "user") return;
            if (taskView === "chat") return;
            if (payload.projectId && currentProject?.id && payload.projectId !== currentProject.id) return;
            setChatHasUnreadResponse(true);
          } catch {
            // no-op
          }
        },
      },
    });
  }, [currentProject?.id, taskView]);

  const branchOptions = useMemo(() => {
    return Array.from(
      new Set(
        boardSourceTasks
          .map((task) => task.branch?.trim())
          .filter((branch): branch is string => Boolean(branch && branch.length > 0)),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [boardSourceTasks]);

  const baseBranchOptions = useMemo(() => {
    return Array.from(
      new Set(
        boardSourceTasks
          .map((task) => task.baseBranch?.trim())
          .filter((baseBranch): baseBranch is string => Boolean(baseBranch && baseBranch.length > 0)),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [boardSourceTasks]);

  const filteredBoardTasks = useMemo(() => {
    return boardSourceTasks.filter((task) => {
      const taskBranch = task.branch?.trim() ?? "";
      const taskBaseBranch = task.baseBranch?.trim() ?? "";
      if (branchFilter === NO_BRANCH_FILTER_VALUE) {
        if (taskBranch.length > 0) {
          return false;
        }
      } else if (branchFilter.length > 0 && taskBranch !== branchFilter) {
        return false;
      }
      if (baseBranchFilter === NO_BRANCH_FILTER_VALUE) {
        if (taskBaseBranch.length > 0) {
          return false;
        }
      } else if (baseBranchFilter.length > 0 && taskBaseBranch !== baseBranchFilter) {
        return false;
      }
      return true;
    });
  }, [boardSourceTasks, branchFilter, baseBranchFilter]);

  // Nodes management is an overlay view (not a modal), so it stays local to App.
  const [nodesOpen, setNodesOpen] = useState(false);
  const closeNodes = useCallback(() => {
    setNodesOpen(false);
  }, []);
  const [retryingProjects, setRetryingProjects] = useState(false);
  const [missionResumeSessionId, setMissionResumeSessionId] = useState<string | undefined>(undefined);
  const [missionTargetId, setMissionTargetId] = useState<string | undefined>(undefined);
  const [goalAnchorId, setGoalAnchorId] = useState<string | undefined>(undefined);
  const [selectedPrId, setSelectedPrId] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const v = new URL(window.location.href).searchParams.get("pr");
    return v ?? undefined;
  });
  const [milestoneSliceResumeSessionId, setMilestoneSliceResumeSessionId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (taskView !== "goalsView" && goalAnchorId !== undefined) {
      setGoalAnchorId(undefined);
    }
  }, [goalAnchorId, taskView]);
  useEffect(() => {
    if (taskView !== "pull-requests" && selectedPrId !== undefined) {
      setSelectedPrId(undefined);
    }
  }, [selectedPrId, taskView]);
  const [authTokenRecoveryOpen, setAuthTokenRecoveryOpen] = useState(false);
  const [dashboardHealth, setDashboardHealth] = useState<DashboardHealthResponse | null>(null);
  const [dbCorruptionRefreshing, setDbCorruptionRefreshing] = useState(false);
  const [dbCorruptionRefreshError, setDbCorruptionRefreshError] = useState<string | null>(null);
  const [setupWarningDismissed, setSetupWarningDismissed] = useState(
    () => getScopedItem(SETUP_WARNING_DISMISSED_KEY, currentProject?.id) === "true",
  );
  const [capacityRiskDismissed, setCapacityRiskDismissed] = useState(
    () => getScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProject?.id) === "true",
  );

  useEffect(() => {
    setSetupWarningDismissed(
      getScopedItem(SETUP_WARNING_DISMISSED_KEY, currentProject?.id) === "true",
    );
  }, [currentProject?.id]);

  useEffect(() => {
    setCapacityRiskDismissed(
      getScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProject?.id) === "true",
    );
  }, [currentProject?.id]);

  const refreshDbCorruptionHealth = useCallback(async () => {
    setDbCorruptionRefreshing(true);
    setDbCorruptionRefreshError(null);
    try {
      const health = await refreshDashboardHealth();
      setDashboardHealth(health);
    } catch (error) {
      setDbCorruptionRefreshError(error instanceof Error ? error.message : "Failed to refresh database health.");
    } finally {
      setDbCorruptionRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchDashboardHealth()
      .then((health) => {
        if (!cancelled) {
          setDashboardHealth(health);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDashboardHealth(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleDaemonAuthFailure = () => {
      setAuthTokenRecoveryOpen(true);
    };

    window.addEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleDaemonAuthFailure);
    return () => {
      window.removeEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleDaemonAuthFailure);
    };
  }, []);

  const handleDismissSetupWarning = useCallback(() => {
    setScopedItem(SETUP_WARNING_DISMISSED_KEY, "true", currentProject?.id);
    setSetupWarningDismissed(true);
  }, [currentProject?.id]);

  const handleDismissCapacityRisk = useCallback(() => {
    setScopedItem(CAPACITY_RISK_DISMISSED_KEY, "true", currentProject?.id);
    setCapacityRiskDismissed(true);
  }, [currentProject?.id]);

  // Settings state
  const {
    maxConcurrent,
    autoMerge,
    globalPaused,
    enginePaused,
    isTestMode,
    taskStuckTimeoutMs,
    staleHighFanoutBlockerAgeThresholdMs,
    capacityRiskBannerEnabled,
    capacityRiskTodoThreshold,
    showQuickChatFAB,
    maxTotalRetriesBeforeFail,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    memoryEnabled,
    devServerEnabled,
    todosEnabled,
    goalsEnabled,
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
    refresh: refreshAppSettings,
  } = useAppSettings(currentProject?.id);

  const { stats: agentStats } = useAgents(currentProject?.id);

  const inProgressCount = useMemo(
    () => boardSourceTasks.filter((task) => task.column === "in-progress").length,
    [boardSourceTasks],
  );
  const inReviewCount = useMemo(
    () => boardSourceTasks.filter((task) => task.column === "in-review").length,
    [boardSourceTasks],
  );
  const capacityRiskSignal = useMemo(
    () =>
      computeCapacityRisk({
        todoCount: agentStats?.todoTaskCount ?? 0,
        inProgressCount,
        inReviewCount,
        idleNonEphemeralAgentCount: agentStats?.idleNonEphemeralCount ?? 0,
        threshold: capacityRiskTodoThreshold ?? DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
      }),
    [agentStats?.todoTaskCount, agentStats?.idleNonEphemeralCount, inProgressCount, inReviewCount, capacityRiskTodoThreshold],
  );

  const previousCapacityRiskBannerEnabledRef = useRef(capacityRiskBannerEnabled);
  const previousCapacityRiskTodoThresholdRef = useRef(capacityRiskTodoThreshold);
  const previousCapacityRiskProjectIdRef = useRef(currentProject?.id);
  const capacityRiskSettingsHydratedRef = useRef(false);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    if (!capacityRiskSettingsHydratedRef.current || previousCapacityRiskProjectIdRef.current !== currentProject?.id) {
      capacityRiskSettingsHydratedRef.current = true;
      previousCapacityRiskProjectIdRef.current = currentProject?.id;
      previousCapacityRiskBannerEnabledRef.current = capacityRiskBannerEnabled;
      previousCapacityRiskTodoThresholdRef.current = capacityRiskTodoThreshold;
      return;
    }

    const wasEnabled = previousCapacityRiskBannerEnabledRef.current;
    const previousThreshold = previousCapacityRiskTodoThresholdRef.current;
    const bannerEnabledChangedToTrue = !wasEnabled && capacityRiskBannerEnabled;
    const thresholdChanged = previousThreshold !== capacityRiskTodoThreshold;

    if (bannerEnabledChangedToTrue || thresholdChanged) {
      removeScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProject?.id);
      setCapacityRiskDismissed(false);
    }

    previousCapacityRiskProjectIdRef.current = currentProject?.id;
    previousCapacityRiskBannerEnabledRef.current = capacityRiskBannerEnabled;
    previousCapacityRiskTodoThresholdRef.current = capacityRiskTodoThreshold;
  }, [settingsLoaded, capacityRiskBannerEnabled, capacityRiskTodoThreshold, currentProject?.id]);

  const skillsEnabled = experimentalFeatures.skillsView === true;
  const nodesEnabled = experimentalFeatures.nodesView === true;
  const researchEnabled = experimentalFeatures.researchView === true;
  const evalsEnabled = experimentalFeatures.evalsView === true;
  const agentOnboardingEnabled = experimentalFeatures.agentOnboarding === true;
  const agentsEnabled = true;

  // Settings close handler with side effects — used by both AppModals
  // onSettingsClose and the nav entry close callback so back-navigation
  // also refreshes app settings and increments research-readiness.
  // MUST be defined after useAppSettings so refreshAppSettings is not TDZ.
  const handleSettingsClose = useCallback(() => {
    modalManager.closeSettings();
    setResearchReadinessVersion((current) => current + 1);
    void refreshAppSettings();
  }, [modalManager, refreshAppSettings]);

  const handleSettingsCloseWithNav = useCallback(() => {
    removeNav(handleSettingsClose);
    handleSettingsClose();
  }, [handleSettingsClose, removeNav]);

  // Redirect to board if feature-gated views are disabled.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (isPluginViewId(taskView)) return;
    if (taskView === "graph" && !graphPluginTaskView) {
      handleChangeTaskView("board");
      return;
    }
    if (taskView === "skills" && !skillsEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "insights" && !insightsEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "agents" && !agentsEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "memory" && !memoryEnabled) {
      handleChangeTaskView("board");
    }
    if ((taskView === "devserver" || taskView === "dev-server") && !devServerEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "research" && !researchEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "evals" && !evalsEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "goalsView" && !goalsEnabled) {
      handleChangeTaskView("board");
    }
  }, [taskView, settingsLoaded, skillsEnabled, insightsEnabled, handleChangeTaskView, agentsEnabled, memoryEnabled, devServerEnabled, researchEnabled, evalsEnabled, goalsEnabled, graphPluginTaskView]);

  // Auto-close nodes overlay if feature flag is toggled off while overlay is open
  useEffect(() => {
    if (nodesOpen && !nodesEnabled) {
      removeNav(closeNodes);
      closeNodes();
    }
  }, [closeNodes, nodesOpen, nodesEnabled, removeNav]);
  const {
    availableModels,
    favoriteProviders,
    favoriteModels,
    toggleFavoriteProvider,
    toggleFavoriteModel,
  } = useFavorites();

  // Auth and onboarding bootstrap logic extracted to a dedicated hook.
  useAuthOnboarding({
    projectId: currentProject?.id,
    setupWizardOpen: modalManager.setupWizardOpen,
    openModelOnboarding: modalManager.openModelOnboarding,
    openSettings: modalManager.openSettings,
  });

  const {
    handleSelectProject,
    handleViewAllProjects,
    handleOpenSettings: _handleOpenSettings,
    handleAddProject,
    handleSetupComplete,
    handleModelOnboardingComplete,
    handlePauseProject,
    handleResumeProject,
    handleRemoveProject,
    handleToggleFavorite,
    handleToggleModelFavorite,
  } = useProjectActions({
    setCurrentProject,
    clearCurrentProject,
    setViewMode,
    currentProject,
    refreshProjects,
    toggleFavoriteProvider,
    toggleFavoriteModel,
    addToast,
    openSettings: modalManager.openSettings,
    openSetupWizard: modalManager.openSetupWizard,
    closeSetupWizard: modalManager.closeSetupWizard,
    closeModelOnboarding: modalManager.closeModelOnboarding,
  });

  const { handleDetailClose } = useDeepLink({
    projectId: currentProject?.id,
    projects,
    projectsLoading,
    currentProject,
    setCurrentProject,
    addToast,
    openTaskDetail: modalManager.openDetailTask,
    closeTaskDetail: modalManager.closeDetailTask,
  });

  const handleInsightTaskCreate = useCallback(
    async ({ insightId, title, description }: { insightId: string; title: string; description: string }) => {
      await createTask({
        title,
        description,
        column: "triage",
        source: {
          sourceType: "dashboard_ui",
          sourceMetadata: {
            origin: "insights",
            insightId,
          },
        },
      });
    },
    [createTask],
  );

  // Task handlers
  const {
    handleBoardQuickCreate,
    handleModalCreate,
    handlePlanningTaskCreated,
    handlePlanningTasksCreated,
    handleSubtaskTasksCreated,
    handleGitHubImport,
  } = useTaskHandlers({
    createTask,
    ingestCreatedTasks,
    onPlanningTaskCreated: modalManager.onPlanningTaskCreated,
    onPlanningTasksCreated: modalManager.onPlanningTasksCreated,
    onSubtaskTasksCreated: modalManager.onSubtaskTasksCreated,
    addToast,
  });

  const handleOpenDetailWithTab = useCallback((task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => {
    if (initialTab === "changes") {
      modalManager.openDetailWithChangesTab(task);
    } else {
      modalManager.openDetailTask(task, initialTab);
    }
    pushNav({ type: "modal", close: modalManager.closeDetailTask });
  }, [modalManager, pushNav]);

  const handleOpenTaskLogs = useCallback(async (taskId: string) => {
    try {
      const task = await fetchTaskDetail(taskId, currentProject?.id);
      modalManager.openDetailTask(task, "logs");
      pushNav({ type: "modal", close: modalManager.closeDetailTask });
    } catch (err) {
      addToast(`Failed to open task logs: ${(err as Error).message}`, "error");
    }
  }, [modalManager, currentProject?.id, addToast, pushNav]);

  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetchWorkflowSteps(currentProject?.id)
      .then((steps) => {
        if (!cancelled) {
          setWorkflowSteps(steps);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkflowSteps([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]);

  const workflowStepNameLookup = useMemo(
    () => new Map(workflowSteps.map((step) => [step.id, step.name] as const)),
    [workflowSteps],
  );

  const _handleOpenNodes = useCallback(() => {
    if (!nodesEnabled) return;
    setNodesOpen((prev) => !prev);
  }, [nodesEnabled]);

  const closeNodesWithNav = useCallback(() => {
    removeNav(closeNodes);
    closeNodes();
  }, [closeNodes, removeNav]);

  // History-aware nodes toggle — pushes nav entry only when opening
  const handleOpenNodesWithNav = useCallback(() => {
    if (!nodesEnabled) return;
    if (!nodesOpen) {
      setNodesOpen(true);
      pushNav({ type: "view", revert: closeNodes });
    } else {
      closeNodesWithNav();
    }
  }, [closeNodes, closeNodesWithNav, nodesEnabled, nodesOpen, pushNav]);

  // History-aware modal open handlers — push nav entries for back-navigation.
  const openDetailTask = useCallback((task: Task | TaskDetail, tab?: Parameters<typeof modalManager.openDetailTask>[1], opts?: { origin?: DetailTaskOrigin }) => {
    modalManager.openDetailTask(task, tab, opts);
    pushNav({ type: "modal", close: modalManager.closeDetailTask });
  }, [modalManager, pushNav]);

  const openSettingsWithNav = useCallback((section?: Parameters<typeof modalManager.openSettings>[0]) => {
    modalManager.openSettings(section);
    pushNav({ type: "modal", close: handleSettingsClose });
  }, [modalManager, pushNav, handleSettingsClose]);

  const openNewTaskWithNav = useCallback(() => {
    modalManager.openNewTask();
    pushNav({ type: "modal", close: modalManager.closeNewTask });
  }, [modalManager, pushNav]);

  const openPlanningWithNav = useCallback(() => {
    modalManager.openPlanning();
    pushNav({ type: "modal", close: modalManager.closePlanning });
  }, [modalManager, pushNav]);

  const openPlanningWithInitialPlanWithNav = useCallback((initialPlan: string) => {
    modalManager.openPlanningWithInitialPlan(initialPlan);
    pushNav({ type: "modal", close: modalManager.closePlanning });
  }, [modalManager, pushNav]);

  const resumePlanningWithNav = useCallback(() => {
    modalManager.resumePlanning();
    pushNav({ type: "modal", close: modalManager.closePlanning });
  }, [modalManager, pushNav]);

  const openSubtaskBreakdownWithNav = useCallback((description: string) => {
    modalManager.openSubtaskBreakdown(description);
    pushNav({ type: "modal", close: modalManager.closeSubtask });
  }, [modalManager, pushNav]);

  const openGroupModalWithNav = useCallback((groupId: string) => {
    modalManager.openGroupModal(groupId);
    pushNav({ type: "modal", close: modalManager.closeGroupModal });
  }, [modalManager, pushNav]);

  const openGitHubImportWithNav = useCallback(() => {
    modalManager.openGitHubImport();
    pushNav({ type: "modal", close: modalManager.closeGitHubImport });
  }, [modalManager, pushNav]);

  const toggleTerminalWithNav = useCallback(() => {
    if (!modalManager.terminalOpen) {
      modalManager.toggleTerminal();
      pushNav({ type: "modal", close: modalManager.closeTerminal });
    } else {
      removeNav(modalManager.closeTerminal);
      modalManager.toggleTerminal();
    }
  }, [modalManager, pushNav, removeNav]);

  const openFilesWithNav = useCallback((workspace?: string, initialFile?: string | null) => {
    modalManager.openFiles(workspace, initialFile);
    pushNav({ type: "modal", close: modalManager.closeFiles });
  }, [modalManager, pushNav]);

  const openFileInBrowser = useCallback((path: string, opts?: { workspace?: string; line?: number; col?: number }) => {
    modalManager.openFiles(opts?.workspace, path);
    pushNav({ type: "modal", close: modalManager.closeFiles });
  }, [modalManager, pushNav]);

  const openTodosWithNav = useCallback(() => {
    modalManager.openTodos();
    pushNav({ type: "modal", close: modalManager.closeTodos });
  }, [modalManager, pushNav]);

  const openActivityLogWithNav = useCallback(() => {
    modalManager.openActivityLog();
    pushNav({ type: "modal", close: modalManager.closeActivityLog });
  }, [modalManager, pushNav]);

  const openGitManagerWithNav = useCallback(() => {
    modalManager.openGitManager();
    pushNav({ type: "modal", close: modalManager.closeGitManager });
  }, [modalManager, pushNav]);

  const openSchedulesWithNav = useCallback(() => {
    modalManager.openSchedules();
    pushNav({ type: "modal", close: modalManager.closeSchedules });
  }, [modalManager, pushNav]);

  const openScriptsWithNav = useCallback(() => {
    modalManager.openScripts();
    pushNav({ type: "modal", close: modalManager.closeScripts });
  }, [modalManager, pushNav]);

  const openWorkflowEditorWithNav = useCallback((workflowId?: string) => {
    modalManager.openWorkflowEditor(undefined, workflowId);
    pushNav({ type: "modal", close: modalManager.closeWorkflowEditor });
  }, [modalManager, pushNav]);

  const openCreateWorkflowWithNav = useCallback(() => {
    modalManager.openWorkflowEditor("create");
    pushNav({ type: "modal", close: modalManager.closeWorkflowEditor });
  }, [modalManager, pushNav]);

  const openUsageWithNav = useCallback((anchorRect?: DOMRect | null) => {
    modalManager.openUsage(anchorRect);
    pushNav({ type: "modal", close: modalManager.closeUsage });
  }, [modalManager, pushNav]);

  // Modal-to-modal transition: scripts -> terminal uses replaceCurrent
  const runScriptWithNav = useCallback(async (name: string, command: string) => {
    await modalManager.runScript(name, command);
    replaceCurrent({ type: "modal", close: modalManager.closeTerminal });
  }, [modalManager, replaceCurrent]);

  // Modal-to-modal transition: settings -> onboarding uses replaceCurrent
  const reopenOnboardingWithNav = useCallback(() => {
    modalManager.closeSettings();
    modalManager.openModelOnboarding();
    replaceCurrent({ type: "modal", close: modalManager.closeModelOnboarding });
  }, [modalManager, replaceCurrent]);

  const handleOpenProjectDirectory = useCallback(() => {
    modalManager.setFileWorkspace("project");
    modalManager.openFiles();
  }, [modalManager]);

  const handleRetryProjects = useCallback(async () => {
    setRetryingProjects(true);
    try {
      await refreshProjects();
    } finally {
      setRetryingProjects(false);
    }
  }, [refreshProjects]);

  const handleOpenMission = useCallback((missionId: string) => {
    setMissionTargetId(missionId);
    setMissionResumeSessionId(undefined);
    handleChangeTaskView("missions");
  }, [handleChangeTaskView]);

  const handleOpenBackgroundSession = useCallback((session: AiSessionSummary) => {
    if (session.type === "planning") {
      modalManager.openPlanningWithSession(session.id);
    } else if (session.type === "subtask") {
      modalManager.openSubtaskWithSession(session.id);
    } else if (session.type === "mission_interview") {
      setMissionTargetId(undefined);
      setMissionResumeSessionId(session.id);
      setMilestoneSliceResumeSessionId(undefined);
      handleChangeTaskView("missions");
    } else if (session.type === "milestone_interview" || session.type === "slice_interview") {
      // For milestone/slice interviews, we need to fetch the session to get the target ID
      // Then navigate to missions view with the resume session ID
      setMissionResumeSessionId(undefined);
      setMissionTargetId(undefined);
      setMilestoneSliceResumeSessionId(session.id);
      handleChangeTaskView("missions");
    }
  }, [handleChangeTaskView, modalManager]);

  // Dismissing the "needs input" banner only hides the prompt — it must NOT
  // delete the underlying session. Sessions remain accessible from the
  // Planning modal's sidebar (or the AI background tasks pill) so the user
  // can return to them later. The banner already tracks dismissals locally
  // via its own `dismissedIds` set, so these handlers are intentional no-ops.
  const handleDismissNeedingInputSession = useCallback(() => {
    // intentional no-op
  }, []);
  const handleDismissAllNeedingInputSessions = useCallback(() => {
    // intentional no-op
  }, []);

  const handleCliAction = useCallback(
    (session: AiSessionSummary, action: CliActionId) =>
      executeCliSessionBannerAction(session, action, {
        currentProjectId: currentProject?.id,
        retryTask,
        moveTask,
        openAuthenticationSettings: () => modalManager.openSettings("authentication" as SectionId),
        addToast,
      }),
    [addToast, currentProject?.id, modalManager, moveTask, retryTask],
  );

  const [shellOnboardingComplete, setShellOnboardingComplete] = useState(false);
  const [shellConnectionManagerOpen, setShellConnectionManagerOpen] = useState(false);
  const [shellConnectionStatus, setShellConnectionStatus] = useState<ShellConnectionNativeResult | null>(null);

  const requiresShellOnboarding = requiresNativeShellOnboarding(shellState, shellReady, shellOnboardingComplete);

  useEffect(() => {
    if (!shellApi || openConnectionManagerSignal === 0) {
      return;
    }
    setShellConnectionManagerOpen(true);
  }, [shellApi, openConnectionManagerSignal]);

  useEffect(() => {
    let cancelled = false;
    void getShellConnectionNativeResult(shellHost.host).then((result) => {
      if (!cancelled) {
        setShellConnectionStatus(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [shellHost.host, shellState.activeProfileId, shellState.desktopMode, shellState.host, shellState.profiles]);

  useEffect(() => {
    if (shellState.host !== "desktop-shell") {
      return;
    }

    if (shellState.desktopMode !== "local") {
      return;
    }

    if (shellState.localServer?.status !== "ready" || !shellState.localServer.port) {
      return;
    }

    if (window.location.port === String(shellState.localServer.port)) {
      return;
    }

    window.location.href = `http://localhost:${shellState.localServer.port}`;
  }, [shellState]);

  useEffect(() => {
    if (shellState.host !== "desktop-shell" || shellState.desktopMode !== "remote") {
      return;
    }

    const activeProfile = shellState.profiles.find((profile) => profile.id === shellState.activeProfileId);
    if (!activeProfile || typeof window === "undefined") {
      return;
    }

    const nextUrl = buildRemoteDashboardUrl(activeProfile.serverUrl, activeProfile.authToken ?? null);
    if (window.location.href !== nextUrl) {
      window.location.href = nextUrl;
    }
  }, [shellState]);

  const isSuppressedProjectResumeError =
    Boolean(projectsError) &&
    isLikelyTabSuspensionError(projectsError ?? "") &&
    hasEverLoadedProjectsRef.current;

  const showBackendConnectionErrorPage =
    !projectsLoading &&
    !currentProjectLoading &&
    projects.length === 0 &&
    !currentProject &&
    Boolean(projectsError) &&
    !isSuppressedProjectResumeError;

  // Render main content based on view mode
  const renderMainContent = () => {
    if (showBackendConnectionErrorPage) {
      return (
        <BackendConnectionErrorPage
          errorMessage={projectsError ?? t("app.backendError.failedFetch", "Failed to fetch projects")}
          isRetrying={retryingProjects}
          onRetry={handleRetryProjects}
          onManageConnection={shellApi ? () => {
            void shellApi.openConnectionManager();
          } : undefined}
        />
      );
    }

    if (nodesOpen) {
      return (
        <div className="nodes-management-overlay">
          <PageErrorBoundary>
            <Suspense fallback={null}>
              <NodesView addToast={addToast} onClose={closeNodesWithNav} />
            </Suspense>
          </PageErrorBoundary>
        </div>
      );
    }

    if (viewMode === "overview") {
      return (
        <PageErrorBoundary>
          <ProjectOverview
            projects={projects}
            loading={projectsLoading}
            onSelectProject={handleSelectProject}
            onAddProject={handleAddProject}
            onPauseProject={handlePauseProject}
            onResumeProject={handleResumeProject}
            onRemoveProject={handleRemoveProject}
            nodes={nodes}
          />
        </PageErrorBoundary>
      );
    }

    const resolvedPluginTaskView = taskView === "graph" ? graphPluginTaskView : (isPluginViewId(taskView) ? taskView : null);

    // Project view
    if (resolvedPluginTaskView) {
      const pluginTasks = isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks;
      return (
        <PageErrorBoundary>
          <PluginDashboardViewHost
            taskView={resolvedPluginTaskView as `plugin:${string}:${string}`}
            context={{
              projectId: currentProject?.id,
              tasks: pluginTasks,
              workflowSteps,
              subscribePluginEvents,
              openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => openDetailTask(task, initialTab),
              openFile: openFileInBrowser,
              renderTaskCard: (task: Task | TaskDetail) => (
                <TaskCard
                  task={task}
                  projectId={currentProject?.id}
                  onOpenDetail={(value: Task | TaskDetail) => openDetailTask(value)}
                  addToast={addToast}
                  workflowStepNameLookup={workflowStepNameLookup}
                  disableDrag={true}
                  prAuthAvailable={prAuthAvailable}
                  autoMergeEnabled={autoMerge}
                  nearDuplicateCanonicalInactive={typeof task.sourceMetadata?.nearDuplicateOf === "string"
                    ? isNearDuplicateCanonicalInactive(pluginTasks.find((candidate) => candidate.id === task.sourceMetadata?.nearDuplicateOf))
                    : undefined}
                />
              ),
              addToast,
            }}
          />
        </PageErrorBoundary>
      );
    }

    if (taskView === "skills") {
      if (!settingsLoaded || !skillsEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <SkillsView
              addToast={addToast}
              projectId={currentProject?.id}
              onClose={() => handleChangeTaskView("board")}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "chat") {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <ChatView
              addToast={addToast}
              projectId={currentProject?.id}
              experimentalFeatures={experimentalFeatures}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "mailbox") {
      return (
        <PageErrorBoundary>
          <MailboxView
            projectId={currentProject?.id}
            addToast={addToast}
            onUnreadCountChange={setMailboxUnreadCount}
          />
        </PageErrorBoundary>
      );
    }


    if (taskView === "missions") {
      return (
        <PageErrorBoundary>
          <MissionManager
            isInline={true}
            isOpen={true}
            onClose={() => {
              setMissionTargetId(undefined);
              setMissionResumeSessionId(undefined);
              setMilestoneSliceResumeSessionId(undefined);
              handleChangeTaskView("board");
            }}
            addToast={addToast}
            projectId={currentProject?.id}
            onSelectTask={(taskId) => {
              const task = tasks.find((t) => t.id === taskId);
              if (task) openDetailTask(task as TaskDetail);
            }}
            availableTasks={tasks.map((t) => ({ id: t.id, title: t.title }))}
            resumeSessionId={missionResumeSessionId}
            targetMissionId={missionTargetId}
            milestoneSliceResumeSessionId={milestoneSliceResumeSessionId}
            onMilestoneSliceResumeFetchError={() => setMilestoneSliceResumeSessionId(undefined)}
            onNavigateToGoal={(goalId) => {
              setGoalAnchorId(goalId);
              handleChangeTaskView("goalsView");
            }}
          />
        </PageErrorBoundary>
      );
    }

    if (taskView === "agents" && agentsEnabled) {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <AgentsView
              addToast={addToast}
              projectId={currentProject?.id}
              onOpenTaskLogs={handleOpenTaskLogs}
              agentOnboardingEnabled={agentOnboardingEnabled}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "documents") {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <DocumentsView
              projectId={currentProject?.id}
              addToast={addToast}
              onOpenDetail={openDetailTask}
              onSendSelectionToTask={modalManager.openNewTaskWithDescription}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "stash-recovery") {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <StashRecoveryView />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "pull-requests") {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <PullRequestView pullRequestId={selectedPrId} projectId={currentProject?.id} />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "insights") {
      if (!settingsLoaded || !insightsEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <InsightsView
              projectId={currentProject?.id}
              addToast={addToast}
              onClose={() => handleChangeTaskView("board")}
              onCreateTask={handleInsightTaskCreate}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "research") {
      if (!settingsLoaded || !researchEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <ResearchView
              projectId={currentProject?.id}
              addToast={addToast}
              onOpenSettings={(section) => modalManager.openSettings(section as SectionId)}
              readinessVersion={researchReadinessVersion}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "evals") {
      if (!settingsLoaded || !evalsEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <EvalsView
              projectId={currentProject?.id}
              onOpenSettings={(section) => modalManager.openSettings(section as SectionId)}
              onOpenTaskDetail={(taskId) => {
                void fetchTaskDetail(taskId, currentProject?.id)
                  .then((task) => openDetailTask(task as TaskDetail))
                  .catch((error) => addToast(error instanceof Error ? error.message : "Failed to open task detail", "error"));
              }}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "memory") {
      if (!settingsLoaded || !memoryEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <MemoryView
              addToast={addToast}
              projectId={currentProject?.id}
              onSendSelectionToTask={modalManager.openNewTaskWithDescription}
            />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "secrets") {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <SecretsView addToast={addToast} />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "goalsView") {
      if (!settingsLoaded || !goalsEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <GoalsView anchorGoalId={goalAnchorId} onNavigateToMission={handleOpenMission} />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "command-center") {
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <CommandCenter />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "devserver" || taskView === "dev-server") {
      if (!settingsLoaded || !devServerEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <DevServerView addToast={addToast} projectId={currentProject?.id} />
          </Suspense>
        </PageErrorBoundary>
      );
    }

    if (taskView === "board") {
      return (
        <PageErrorBoundary>
          {capacityRiskBannerEnabled && !capacityRiskDismissed ? (
            <CapacityRiskBanner signal={capacityRiskSignal} onDismiss={handleDismissCapacityRisk} />
          ) : null}
          <Board
            tasks={filteredBoardTasks}
            projectId={currentProject?.id}
            maxConcurrent={maxConcurrent}
            onMoveTask={moveTask}
            onPauseTask={pauseTask}
            onOpenDetail={openDetailTask}
            onOpenGroupModal={openGroupModalWithNav}
            addToast={addToast}
            onQuickCreate={handleBoardQuickCreate}
            onNewTask={openNewTaskWithNav}
            onPlanningMode={openPlanningWithInitialPlanWithNav}
            onSubtaskBreakdown={openSubtaskBreakdownWithNav}
            autoMerge={autoMerge}
            onToggleAutoMerge={toggleAutoMerge}
            globalPaused={globalPaused}
            onUpdateTask={updateTask}
            onRetryTask={retryTask}
            onArchiveTask={archiveTask}
            onUnarchiveTask={unarchiveTask}
            onDeleteTask={deleteTask}
            onArchiveAllDone={archiveAllDone}
            onLoadArchivedTasks={loadArchivedTasks}
            searchQuery={searchQuery}
            availableModels={availableModels}
            onOpenDetailWithTab={handleOpenDetailWithTab}
            favoriteProviders={favoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={handleToggleFavorite}
            onToggleModelFavorite={handleToggleModelFavorite}
            taskStuckTimeoutMs={taskStuckTimeoutMs}
            staleHighFanoutBlockerAgeThresholdMs={staleHighFanoutBlockerAgeThresholdMs}
            onOpenMission={handleOpenMission}
            lastFetchTimeMs={lastFetchTimeMs}
            prAuthAvailable={prAuthAvailable}
            onOpenWorkflowEditor={openWorkflowEditorWithNav}
            onCreateWorkflow={openCreateWorkflowWithNav}
          />
        </PageErrorBoundary>
      );
    }

    // List view
    return (
      <PageErrorBoundary>
        <ListView
          tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
          projectId={currentProject?.id}
          onMoveTask={moveTask}
          onRetryTask={retryTask}
          onDeleteTask={deleteTask}
          onPauseTask={pauseTask}
          onUnpauseTask={unpauseTask}
          onArchiveTask={archiveTask}
          onMergeTask={mergeTask}
          onResetTask={resetTask}
          onDuplicateTask={duplicateTask}
          onOpenDetail={(task, options) => openDetailTask(task, undefined, options)}
          addToast={addToast}
          globalPaused={globalPaused}
          onNewTask={openNewTaskWithNav}
          onQuickCreate={handleBoardQuickCreate}
          onPlanningMode={openPlanningWithInitialPlanWithNav}
          onSubtaskBreakdown={openSubtaskBreakdownWithNav}
          availableModels={availableModels}
          favoriteProviders={favoriteProviders}
          favoriteModels={favoriteModels}
          onToggleFavorite={handleToggleFavorite}
          onToggleModelFavorite={handleToggleModelFavorite}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          searchQuery={searchQuery}
          lastFetchTimeMs={lastFetchTimeMs}
          prAuthAvailable={prAuthAvailable}
          autoMerge={autoMerge}
          onCreateWorkflow={openCreateWorkflowWithNav}
        />
      </PageErrorBoundary>
    );
  };

  const showOnboardingResumeCard = !modalManager.modelOnboardingOpen && isOnboardingResumable();
  const showPostOnboardingRecommendations =
    !modalManager.modelOnboardingOpen &&
    !showOnboardingResumeCard &&
    isOnboardingCompleted() &&
    !isPostOnboardingDismissed();

  // Top progress bar reflects any in-flight revalidation: projects, current-project, or tasks.
  // Add new sources here, not inside TopProgressBar.
  const isRevalidating = projectsLoading || currentProjectLoading || isStale;

  return (
    <NavigationHistoryProvider value={{ pushNav, replaceCurrent, removeNav }}>
      <FileBrowserProvider openFile={openFileInBrowser}>
        <RetryWarningProvider value={maxTotalRetriesBeforeFail * RETRY_WARNING_RATIO}>
        {isFirstEverBoot ? (
          <>
            <DashboardLoader stage={loadingStage} />
            <ToastContainer toasts={toasts} onRemove={removeToast} />
          </>
        ) : (
          <>
            <TopProgressBar visible={isRevalidating} />
            <Header
        shellHost={shellHost.host}
        onOpenSettings={openSettingsWithNav}
        onOpenGitHubImport={openGitHubImportWithNav}
        onOpenPlanning={openPlanningWithNav}
        onResumePlanning={resumePlanningWithNav}
        activePlanningSessionCount={bgPlanningSessions.length}
        onOpenUsage={openUsageWithNav}
        onOpenActivityLog={openActivityLogWithNav}
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        mailboxUnreadCount={mailboxUnreadCount}
        mailboxPendingApprovalCount={mailboxPendingApprovalCount}
        chatHasUnreadResponse={chatHasUnreadResponse}
        stashOrphanCount={stashOrphanCount}
        onOpenSchedules={openSchedulesWithNav}
        onOpenGitManager={openGitManagerWithNav}
        onOpenNodes={handleOpenNodesWithNav}
        showNodesButton={nodesEnabled}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onOpenScripts={openScriptsWithNav}
        onRunScript={runScriptWithNav}
        onToggleTerminal={toggleTerminalWithNav}
        onOpenFiles={openFilesWithNav}
        filesOpen={modalManager.filesOpen}
        onOpenTodos={openTodosWithNav}
        todosOpen={modalManager.todosOpen}
        todosEnabled={todosEnabled}
        globalPaused={globalPaused}
        enginePaused={enginePaused}
        onToggleGlobalPause={toggleGlobalPause}
        onToggleEnginePause={toggleEnginePause}
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : undefined}
        showSkillsTab={skillsEnabled}
        showAgentsTab={agentsEnabled}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        branchFilter={branchFilter}
        baseBranchFilter={baseBranchFilter}
        branchOptions={branchOptions}
        baseBranchOptions={baseBranchOptions}
        onBranchFilterChange={handleBranchFilterChange}
        onBaseBranchFilterChange={handleBaseBranchFilterChange}
        projects={effectiveProjects}
        currentProject={currentProject}
        onSelectProject={handleSelectProject}
        onViewAllProjects={handleViewAllProjects}
        projectId={currentProject?.id}
        mobileNavEnabled={isMobile}
        // Node switching props
        availableNodes={nodes}
        currentNode={currentNode}
        onSelectNode={(node) => {
          if (node === null) {
            clearCurrentNode();
          } else {
            setCurrentNode(node);
          }
        }}
        isRemote={isRemote}
        experimentalFeatures={{
          insights: insightsEnabled,
          memoryView: memoryEnabled,
          devServer: devServerEnabled,
          devServerView: devServerEnabled,
          researchView: researchEnabled,
          evalsView: evalsEnabled,
          goalsView: goalsEnabled,
        }}
        pluginDashboardViews={pluginDashboardViews}
        shellConnectionControl={
          !isMobile && shellConnectionStatus ? (
            <ShellConnectionStatus
              status={shellConnectionStatus}
              onError={(message) => addToast(message, "error")}
            />
          ) : undefined
        }
      />
      {viewMode === "project" && currentProject && (
        <>
          <TestModeBanner isActive={isTestMode} />
          <OAuthReloginBanner
            onReLogin={(_providerId) => modalManager.openSettings("authentication" as SectionId)}
          />
        </>
      )}
      {viewMode === "project" && currentProject && !nodesOpen && taskView !== "missions" && !modalManager.isPlanningOpen && !sessionBannersHidden && (
        <SessionNotificationBanner
          sessions={sessionsNeedingInput}
          onResumeSession={handleOpenBackgroundSession}
          onDismissSession={handleDismissNeedingInputSession}
          onDismissAll={handleDismissAllNeedingInputSessions}
          onCliAction={handleCliAction}
          getCliActionDisabledReason={getCliActionDisabledReasonForBanner}
        />
      )}
      {viewMode === "project" && currentProject && (
        <CliBinaryInstallBanner
          onOpenSettings={() => modalManager.openSettings("general" as SectionId)}
        />
      )}
      {viewMode === "project" && currentProject && showOnboardingResumeCard && (
        <OnboardingResumeCard onResume={modalManager.openModelOnboarding} />
      )}
      {viewMode === "project" && currentProject && showPostOnboardingRecommendations && (
        <PostOnboardingRecommendations
          onOpenModelOnboarding={modalManager.openModelOnboarding}
          onOpenSettings={(section) => modalManager.openSettings(section as SectionId)}
        />
      )}
      {viewMode === "project" && currentProject && updateAvailable && latestVersion && currentVersion && !updateBannerDismissed && (
        <UpdateAvailableBanner
          latestVersion={latestVersion}
          currentVersion={currentVersion}
          onDismiss={dismissUpdateBanner}
        />
      )}
      {viewMode === "project" && currentProject && (
        <MergeAdvanceNotice projectId={currentProject.id} />
      )}
      {viewMode === "project" && currentProject && dashboardHealth?.taskIdIntegrity?.status === "anomaly" && dashboardHealth.taskIdIntegrity.recommendedAction && (
        <TaskIdIntegrityBanner
          report={dashboardHealth.taskIdIntegrity}
          recommendedAction={dashboardHealth.taskIdIntegrity.recommendedAction}
          onRefresh={(report, recommendedAction) => {
            setDashboardHealth((current) => {
              if (!current) {
                return null;
              }
              return {
                ...current,
                status:
                  report.status === "anomaly"
                  || !current.database.healthy
                  || current.database.corruptionDetected
                    ? "degraded"
                    : "ok",
                taskIdIntegrity: {
                  ...report,
                  recommendedAction,
                },
              };
            });
          }}
        />
      )}
      {viewMode === "project" && currentProject && dashboardHealth?.database?.corruptionDetected === true && (
        <DbCorruptionBanner
          errors={dashboardHealth.database.corruptionErrors}
          lastCheckedAt={dashboardHealth.database.lastCheckedAt}
          onRefresh={refreshDbCorruptionHealth}
          refreshing={dbCorruptionRefreshing}
          refreshError={dbCorruptionRefreshError}
        />
      )}
      {viewMode === "project" && currentProject && !setupReadinessLoading && hasWarnings && !setupWarningDismissed && (
        <SetupWarningBanner
          hasAiProvider={hasAiProvider}
          hasGithub={hasGithub}
          onDismiss={handleDismissSetupWarning}
        />
      )}
      {viewMode === "project" && currentProject && approvalBannerCandidate && (
        <ApprovalNotificationBanner
          pendingCount={Math.max(mailboxPendingApprovalCount, 1)}
          onOpenMailbox={() => handleTaskViewChange("mailbox")}
          onDismiss={() => {
            approvalDismissalsRef.current.set(
              approvalBannerCandidate.dedupeKey,
              Math.max(Date.now(), approvalBannerCandidate.updatedAtMs),
            );
            persistApprovalBannerDismissals(approvalDismissalsRef.current);
            setApprovalBannerCandidate(null);
          }}
        />
      )}
      {viewMode === "project" && currentProject && showGitHubStarPrompt && !gitHubStarPromptShown && (
        <GitHubStarPrompt
          onDismiss={() => {
            markGitHubStarPromptShown();
            setShowGitHubStarPrompt(false);
          }}
        />
      )}
      <div
        className={`project-content${viewMode === "project" && currentProject && (!isMobile || !mobileKeyboardOpen) ? " project-content--with-footer" : ""}${isMobile && !mobileKeyboardOpen ? " project-content--with-mobile-nav" : ""}`}
      >
        {renderMainContent()}
      </div>
      {viewMode === "project" && currentProject && !nodesOpen && (
        <ExecutorStatusBar
          tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
          projectId={currentProject.id}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          staleHighFanoutBlockerAgeThresholdMs={staleHighFanoutBlockerAgeThresholdMs}
          backgroundSessions={bgSessions}
          backgroundGenerating={bgGenerating}
          backgroundNeedsInput={bgNeedsInput}
          onOpenBackgroundSession={handleOpenBackgroundSession}
          onDismissBackgroundSession={bgDismiss}
          lastFetchTimeMs={lastFetchTimeMs}
          currentProjectPath={currentProject.path}
          onOpenProjectDirectory={handleOpenProjectDirectory}
          keyboardOpen={footerKeyboardOpen}
          hideWhenKeyboardOpen={mobileKeyboardOpen}
        />
      )}
      <MobileNavBar
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : () => {}}
        footerVisible={viewMode === "project" && !!currentProject}
        modalOpen={modalManager.anyModalOpen}
        keyboardOpen={mobileNavKeyboardOpen}
        onOpenSettings={openSettingsWithNav}
        onOpenActivityLog={openActivityLogWithNav}
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        onOpenNodes={handleOpenNodesWithNav}
        mailboxUnreadCount={mailboxUnreadCount}
        mailboxPendingApprovalCount={mailboxPendingApprovalCount}
        chatHasUnreadResponse={chatHasUnreadResponse}
        stashOrphanCount={stashOrphanCount}
        onOpenGitManager={openGitManagerWithNav}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onOpenSchedules={openSchedulesWithNav}
        onOpenScripts={openScriptsWithNav}
        onToggleTerminal={toggleTerminalWithNav}
        onOpenFiles={openFilesWithNav}
        onOpenTodos={openTodosWithNav}
        todosOpen={modalManager.todosOpen}
        onOpenGitHubImport={openGitHubImportWithNav}
        onOpenPlanning={openPlanningWithNav}
        onResumePlanning={resumePlanningWithNav}
        activePlanningSessionCount={bgPlanningSessions.length}
        onOpenUsage={() => openUsageWithNav(null)}
        onViewAllProjects={handleViewAllProjects}
        onRunScript={runScriptWithNav}
        projectId={currentProject?.id}
        showSkillsTab={skillsEnabled}
        experimentalFeatures={{
          insights: insightsEnabled,
          memoryView: memoryEnabled,
          devServer: devServerEnabled,
          devServerView: devServerEnabled,
          todoView: todosEnabled,
          researchView: researchEnabled,
          evalsView: evalsEnabled,
          goalsView: goalsEnabled,
          nodesView: nodesEnabled,
        }}
        pluginDashboardViews={pluginDashboardViews}
        shellConnectionControl={
          isMobile && shellConnectionStatus ? (
            <ShellConnectionStatus
              status={shellConnectionStatus}
              onError={(message) => addToast(message, "error")}
            />
          ) : undefined
        }
      />
      {viewMode === "project" && currentProject && taskView !== "chat" && taskView !== "mailbox" && taskView !== "insights" && taskView !== "evals" && taskView !== "devserver" && taskView !== "dev-server" && taskView !== "graph" && !isPluginViewId(taskView) && (
        <QuickChatFAB
          projectId={currentProject.id}
          addToast={addToast}
          showFAB={showQuickChatFAB}
          open={quickChatOpen}
          onOpenChange={setQuickChatOpen}
          favoriteProviders={favoriteProviders}
          favoriteModels={favoriteModels}
          onToggleFavorite={handleToggleFavorite}
          onToggleModelFavorite={handleToggleModelFavorite}
        />
      )}
      <AppModals
        projectId={currentProject?.id}
        tasks={tasks}
        projects={projects}
        currentProject={currentProject}
        addToast={addToast}
        toasts={toasts}
        removeToast={removeToast}
        modalManager={modalManager}
        projectActions={{ handleAddProject, handleSetupComplete, handleModelOnboardingComplete }}
        taskHandlers={{
          handleModalCreate,
          handlePlanningTaskCreated,
          handlePlanningTasksCreated,
          handleSubtaskTasksCreated,
          handleGitHubImport,
        }}
        taskOperations={{ moveTask, deleteTask, mergeTask, archiveTask, retryTask, resetTask, duplicateTask }}
        deepLink={{ handleDetailClose }}
        settings={{ prAuthAvailable, autoMerge, themeMode, colorTheme, dashboardFontScalePct, setThemeMode, setColorTheme, setDashboardFontScalePct }}
        onSettingsClose={handleSettingsCloseWithNav}
        onReopenOnboarding={reopenOnboardingWithNav}
        onOpenApprovals={(_approvalId) => handleTaskViewChange("mailbox")}
      />
      <AuthTokenRecoveryDialog open={authTokenRecoveryOpen} />
            {shellApi && (
              <>
                <NativeShellOnboardingModal
                  open={requiresShellOnboarding}
                  shellApi={shellApi}
                  shellState={shellState}
                  onComplete={() => setShellOnboardingComplete(true)}
                />
                <NativeShellConnectionManager
                  open={shellConnectionManagerOpen}
                  shellApi={shellApi}
                  shellState={shellState}
                  onClose={() => setShellConnectionManagerOpen(false)}
                />
              </>
            )}
          </>
        )}
        </RetryWarningProvider>
      </FileBrowserProvider>
    </NavigationHistoryProvider>
  );
}

export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ShellHostProvider>
          <ShellProvider>
            <NodeProvider>
              <ConfirmDialogProvider>
                <AppInner />
              </ConfirmDialogProvider>
            </NodeProvider>
          </ShellProvider>
        </ShellHostProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}
