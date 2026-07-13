import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import {
  type Task,
  type TaskDetail,
  type WorkflowStep,
} from "@fusion/core";
import { Header, useViewportMode } from "./components/Header";
import { TaskDetailContent } from "./components/TaskDetailModal";
import { FloatingWindow } from "./components/FloatingWindow";
import { AppModals } from "./components/AppModals";
import { DashboardLoader, type DashboardLoaderStage } from "./components/DashboardLoader";
import { TopProgressBar } from "./components/TopProgressBar";
import { ExecutorStatusBar } from "./components/ExecutorStatusBar";
import { TerminalModal } from "./components/TerminalModal";
import { type CliActionId } from "./components/SessionNotificationBanner";
import {
  isOnboardingCompleted,
  isOnboardingResumable,
  isPostOnboardingDismissed,
} from "./components/model-onboarding-state";
import type { SectionId } from "./components/SettingsModal";
import { MobileNavBar } from "./components/MobileNavBar";
import { LeftSidebarNav } from "./components/LeftSidebarNav";
import { useRightDockController } from "./components/useRightDockController";
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
import { useDashboardKeyboardShortcuts } from "./hooks/useDashboardKeyboardShortcuts";
import { ModalDismissPreferenceProvider } from "./hooks/useOverlayDismiss";
import { useDeepLink } from "./hooks/useDeepLink";
import { useFavorites } from "./hooks/useFavorites";
import { useAuthOnboarding } from "./hooks/useAuthOnboarding";
import { useMobileKeyboard } from "./hooks/useMobileKeyboard";
import { isIOS, useMobileKeyboardViewportLock, useMobileViewportRestoreReset } from "./hooks/useMobileScrollLock";
import { computeMobileBarKeyboardFlags } from "./utils/mobileBarKeyboardFlags";
import { useSetupReadiness } from "./hooks/useSetupReadiness";
import { useGithubSetupWarningDelay } from "./hooks/useGithubSetupWarningDelay";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useViewState, type TaskView } from "./hooks/useViewState";
import { NavigationHistoryProvider, useNavigationHistory } from "./hooks/useNavigationHistory";
import { usePluginDashboardViews } from "./hooks/usePluginDashboardViews";
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
import { CostBadgeProvider } from "./context/CostBadgeContext";
import { ShellHostProvider, useShellHostContext } from "./context/ShellHostContext";
import { useShellConnection } from "./hooks/useShellConnection";
import { useStashOrphanCount } from "./hooks/useStashOrphanCount";
import { useChatUnreadBadge } from "./hooks/useChatUnreadBadge";
import { useMailboxUnread } from "./hooks/useMailboxUnread";
import { useApprovalBanner } from "./hooks/useApprovalBanner";
import { useBranchTaskFilters } from "./hooks/useBranchTaskFilters";
import { useDashboardHealth } from "./hooks/useDashboardHealth";
import { useAuthTokenRecovery } from "./hooks/useAuthTokenRecovery";
import { useScopedDismissFlag } from "./hooks/useScopedDismissFlag";
import { useCapacityRiskBanner } from "./hooks/useCapacityRiskBanner";
import { useMainPanelTaskDetail } from "./hooks/useMainPanelTaskDetail";
import { useBoardScrollRestore } from "./hooks/useBoardScrollRestore";
import { usePoppedOutTasks } from "./hooks/usePoppedOutTasks";
import { NativeShellOnboardingModal } from "./components/NativeShellOnboardingModal";
import { NativeShellConnectionManager } from "./components/NativeShellConnectionManager";
import { ShellConnectionStatus } from "./components/ShellConnectionStatus";
import { getShellConnectionNativeResult, type ShellConnectionNativeResult } from "./shell-native";
import type { AiSessionSummary, PluginDashboardViewEntry } from "./api";
import { fetchTaskDetail, fetchWorkflowSteps } from "./api";
import {
  SETUP_WARNING_DISMISSED_KEY,
  RETRY_WARNING_RATIO,
  resolveDesktopShellRedirectTarget,
  requiresNativeShellOnboarding,
  shouldShowFirstEverBootLoader,
  isSessionNeedingInputForBanner,
  isPlanningAwaitingInput,
  getCliActionDisabledReasonForBanner,
  executeCliSessionBannerAction,
} from "./utils/appLifecycle";
// Re-export the unit-tested lifecycle helpers so existing `from "./App"` /
// `from "../../App"` imports keep resolving after the bodies moved to utils.
export {
  didEnterAwaitingApproval,
  didEnterDone,
  requiresNativeShellOnboarding,
  shouldShowFirstEverBootLoader,
  isSessionNeedingInputForBanner,
  isPlanningAwaitingInput,
  getCliActionDisabledReasonForBanner,
  executeCliSessionBannerAction,
} from "./utils/appLifecycle";
import { subscribeSse } from "./sse-bus";
import { AuthTokenRecoveryDialog } from "./components/AuthTokenRecoveryDialog";
import { MainContent } from "./components/dashboard/MainContent";
import { DashboardBanners } from "./components/dashboard/DashboardBanners";
import type { DashboardBannersProps, MainContentProps } from "./components/dashboard/types";
import type { GraphWorkflowSelection } from "./components/GraphWorkflowSwitcherSlot";

// ChatView's CSS is imported eagerly so the styles bundle into the main
// CSS file. Without this, the lazy ChatView JS chunk loaded its own CSS
// link asynchronously, producing a brief flash of unstyled chat UI on
// first render.
import "./components/ChatView.css";

const IS_TEST_ENV = import.meta.env.MODE === "test";
export const TASK_DETAIL_FLOATING_GEOMETRY_KEY = "floating-window:task-detail";

const AgentsView = lazy(() => import("./components/AgentsView").then((m) => ({ default: m.AgentsView })));
const DocumentsView = lazy(() => import("./components/DocumentsView").then((m) => ({ default: m.DocumentsView })));
const InsightsView = lazy(() => import("./components/InsightsView").then((m) => ({ default: m.InsightsView })));
const ResearchView = lazy(() => import("./components/ResearchView").then((m) => ({ default: m.ResearchView })));
const EvalsView = lazy(() => import("./components/EvalsView").then((m) => ({ default: m.EvalsView })));
const ChatView = lazy(() => import("./components/ChatView").then((m) => ({ default: m.ChatView })));

const SkillsView = lazy(() => import("./components/SkillsView").then((m) => ({ default: m.SkillsView })));
const MemoryView = lazy(() => import("./components/MemoryView").then((m) => ({ default: m.MemoryView })));
const SecretsView = lazy(() => import("./components/SecretsView").then((m) => ({ default: m.SecretsView })));
const CommandCenter = lazy(() => import("./components/command-center/CommandCenter").then((m) => ({ default: m.CommandCenter })));
const DevServerView = lazy(() => import("./components/DevServerView").then((m) => ({ default: m.DevServerView })));
const TodoView = lazy(() => import("./components/TodoView").then((m) => ({ default: m.TodoView })));
const GoalsView = lazy(() => import("./components/GoalsView").then((m) => ({ default: m.GoalsView })));
const PullRequestView = lazy(() => import("./components/PullRequestView").then((m) => ({ default: m.PullRequestView })));
/*
FNXC:Navigation 2026-06-22-00:00:
Workflows, Import Tasks (GitHub import), and Automations render as embedded main-content views (presentation="embedded") via these lazy chunks; the same components still mount as modals in AppModals for the mobile overflow path.
*/
/*
FNXC:DashboardLazyViews 2026-06-22-00:00:
WorkflowEditorView, ImportTasksView, and AutomationsView are embedded main-content presentations that REUSE already-documented chunks (WorkflowNodeEditor, plus the GitHub import and scheduled-tasks modals mounted in AppModals). They are excluded from the curated "Lazy-Loaded Heavy Views" App-level inventory via the leading-underscore convention so the docs guard counts each heavy chunk once; renaming the underlying component would double-count it.
*/
const _WorkflowEditorView = lazy(() => import("./components/WorkflowNodeEditor").then((m) => ({ default: m.WorkflowNodeEditor })));
const _ImportTasksView = lazy(() => import("./components/GitHubImportModal").then((m) => ({ default: m.GitHubImportModal })));
const _AutomationsView = lazy(() => import("./components/ScheduledTasksModal").then((m) => ({ default: m.ScheduledTasksModal })));
/*
FNXC:Settings 2026-06-22-00:00:
SettingsView is the embedded main-content presentation of the SettingsModal chunk. It REUSES the already-documented SettingsModal lazy chunk (mounted in AppModals), so it uses the leading-underscore convention to stay out of the curated "Lazy-Loaded Heavy Views" inventory and avoid double-counting.
*/
const _SettingsView = lazy(() => import("./components/SettingsModal").then((m) => ({ default: m.SettingsView })));

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
    void import("./components/ChatView");

    void import("./components/SkillsView");
    void import("./components/MemoryView");
    void import("./components/SecretsView");
    void import("./components/command-center/CommandCenter");
    void import("./components/DevServerView");
    void import("./components/TodoView");
    void import("./components/GoalsView");
    void import("./components/PullRequestView");
  });
}

registerBundledPluginViews();

export function shouldOpenBoardTaskInDock(openTasksInRightSidebar: boolean, rightDockActive: boolean, initialTab?: DetailTaskTab): boolean {
  return !initialTab && openTasksInRightSidebar && rightDockActive;
}

export type BoardTaskOpenRoute = "popup" | "dock" | "main-panel";

export function getBoardTaskOpenRoute(options: {
  isMobile: boolean;
  openMobileTasksInPopup: boolean;
  openTasksInRightSidebar: boolean;
  rightDockActive: boolean;
  initialTab?: DetailTaskTab;
}): BoardTaskOpenRoute {
  if (!options.initialTab && options.openMobileTasksInPopup) {
    return "popup";
  }
  if (shouldOpenBoardTaskInDock(options.openTasksInRightSidebar, options.rightDockActive, options.initialTab)) {
    return "dock";
  }
  return "main-panel";
}

export interface DashboardShortcutPopupState {
  poppedOutTaskIds: string[];
  quickChatOpen: boolean;
  terminalOpen: boolean;
  modalClosers: Array<[boolean, () => void]>;
}

export interface DashboardShortcutPopupHandlers {
  closePoppedOutTask: (taskId: string) => void;
  closeQuickChat: () => void;
  closeTerminal: () => void;
}

export function isTaskPopupVisibleForView(options: {
  taskPopupsBoardListOnly: boolean;
  taskView: TaskView;
  originTaskView?: TaskView;
}): boolean {
  if (!options.taskPopupsBoardListOnly) return true;
  return (options.originTaskView === "board" || options.originTaskView === "list") && options.originTaskView === options.taskView;
}

/*
FNXC:DashboardShortcuts 2026-07-04-12:02:
The App-level Escape close order is factored into a pure helper so regression tests can prove the real dashboard shell ordering without rendering every lazy dashboard surface. The helper must close exactly one surface and return false when no popup is open so component-local Escape handlers remain authoritative.
*/
export function closeTopmostDashboardPopupForShortcut(
  state: DashboardShortcutPopupState,
  handlers: DashboardShortcutPopupHandlers,
): boolean {
  const lastPoppedOutTaskId = state.poppedOutTaskIds[state.poppedOutTaskIds.length - 1];
  if (lastPoppedOutTaskId) {
    handlers.closePoppedOutTask(lastPoppedOutTaskId);
    return true;
  }
  if (state.quickChatOpen) {
    handlers.closeQuickChat();
    return true;
  }
  if (state.terminalOpen) {
    handlers.closeTerminal();
    return true;
  }
  const match = state.modalClosers.find(([open]) => open);
  if (!match) return false;
  match[1]();
  return true;
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
  const { currentProject, setCurrentProject, clearCurrentProject, loading: currentProjectLoading } = useCurrentProject(projects, { nodeId: currentNodeId, projectsLoading });

  const {
    hasAiProvider,
    hasGithub,
    loading: setupReadinessLoading,
  } = useSetupReadiness(currentProject?.id);
  const showGithubSetupWarning = useGithubSetupWarningDelay({
    projectId: currentProject?.id,
    hasGithub,
    loading: setupReadinessLoading,
  });
  const visibleSetupHasWarnings = !hasAiProvider || (!hasGithub && showGithubSetupWarning);
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
  const { themeMode, colorTheme, dashboardFontScalePct, shadcnCustomColors, resolvedThemeMode, setThemeMode, setColorTheme, setDashboardFontScalePct, setShadcnCustomColors } = useTheme();

  // Background AI sessions - required before useModalManager
  const { sessions: bgSessions, generating: bgGenerating, needsInput: bgNeedsInput, planningSessions: bgPlanningSessions, dismissSession: bgDismiss } = useBackgroundSessions(currentProject?.id);
  /*
   * FNXC:SessionBanner 2026-06-14-19:32:
   * CLI agent sessions use `waiting_on_input` and `needs_attention` to represent user-actionable states. The banner feed must include those statuses in addition to the legacy planning-session statuses so visible CLI actions cannot be silently hidden from users.
   *
   * FNXC:SessionBanner 2026-07-05-00:00:
   * Planning `awaiting_input` sessions are excluded from the banner feed: the banner's Resume button did not
   * reliably redirect into Planning Mode. That signal now surfaces as a yellow `status-dot--pending` nav badge
   * (see `planningNeedsInput` below) whose click target is the already-correct `planning` view navigation.
   * Planning sessions in `error` status are unaffected and still render in the banner.
   */
  const sessionsNeedingInput = bgSessions.filter((s) => isSessionNeedingInputForBanner(s) && !isPlanningAwaitingInput(s));
  const sessionBannersHidden = useSessionBannersHidden();
  const planningNeedsInput = bgPlanningSessions.some((s) => s.status === "awaiting_input");

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
  const { viewMode, setViewMode, taskView, setTaskView, handleChangeTaskView } = useViewState({
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

  const { views: rawPluginDashboardViews } = usePluginDashboardViews(currentProject?.id);
  const graphPluginTaskView = useMemo(() => {
    // Prefer API response for the graph view (supports dynamic plugin discovery)
    const graphView = rawPluginDashboardViews.find(
      (entry) => entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph",
    );
    if (graphView) return `plugin:${graphView.pluginId}:${graphView.view.viewId}` as const;
    // Fall back to bundled static registration so the graph view works even when
    // the plugin is not installed/loaded through the API (e.g. fresh DB).
    if (isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")) {
      return `plugin:fusion-plugin-dependency-graph:graph` as const;
    }
    return null;
  }, [rawPluginDashboardViews]);

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

  // FNXC:DashboardLiveUpdates 2026-06-26-01:08:
  // SSE remains enabled only for board/list views to free connection slots for mission detail fetches. The false→true missed-event catch-up lives inside useTasks so App keeps the routing gate only and cannot double-fetch on task-view re-entry.
  const taskSseEnabled = taskView === "board" || taskView === "list";
  const { tasks, isStale, createTask, moveTask, pauseTask, unpauseTask, deleteTask, mergeTask, retryTask, bypassReview, resetTask, updateTask, duplicateTask, archiveTask, unarchiveTask, revertTask, archiveAllDone, loadArchivedTasks, loadMoreArchivedTasks, archivedHasMore, archivedLoadingMore, ingestCreatedTasks, lastFetchTimeMs } = useTasks(
    {
      ...(currentProject ? { projectId: currentProject.id } : {}),
      searchQuery: searchQuery || undefined,
      sseEnabled: taskSseEnabled,
    }
  );

  /*
  FNXC:Navigation 2026-06-22-00:00:
  Snapshot of the task whose detail is shown in the main panel (Board card click → full-panel detail). Kept as a snapshot so the view survives a tasks revalidation; renderMainContent prefers the live row from `tasks` by id and falls back to this snapshot.

  FNXC:TaskDetail 2026-06-23-00:41:
  Board task-card secondary actions can deep-link into the inline main-panel task detail. Files-changed must land on the embedded Changes tab instead of reopening the task in the modal path.
  */
  const { task: mainPanelDetailTask, initialTab: mainPanelDetailInitialTab, setTask: setMainPanelDetailTask, setInitialTab: setMainPanelDetailInitialTab } = useMainPanelTaskDetail();
  const { capture: captureCurrentBoardScrollSnapshot, requestRestore } = useBoardScrollRestore(taskView);
  const mainPanelDetailNavRevertRef = useRef<(() => void) | null>(null);
  /*
  FNXC:FloatingWindow 2026-06-22-20:45:
  Open popped-out task-detail windows. Each entry is a task snapshot rendered inside its own movable, resizable, non-blocking FloatingWindow. Several can be open at once and coexist with the right-dock pop-out and terminal (all click-through overlays). Snapshots survive a tasks revalidation; rendering prefers the live row by id and falls back to the snapshot. Pop-out dedupes by task id — re-popping an already-open task is a no-op (its window stays; focus-to-front in FloatingWindow handles re-raising on click).
  */
  const { entries: poppedOutTaskEntries, popOut: popOutTaskDetail, close: closePoppedOutTask } = usePoppedOutTasks();
  const popOutTaskDetailForCurrentView = useCallback((task: Task | TaskDetail) => {
    popOutTaskDetail(task, taskView);
  }, [popOutTaskDetail, taskView]);

  const boardSourceTasks = isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks;
  const [graphWorkflowSelection, setGraphWorkflowSelection] = useState<GraphWorkflowSelection | null>(null);

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
  // FNXC:MobileChatKeyboardLayout 2026-06-26-09:04:
  // When the keyboard is up on mobile we now hide the executor footer and
  // drop the reserved footer+nav padding on BOTH platforms (see
  // computeMobileBarKeyboardFlags) so the composer sits flush above the
  // keyboard with no empty gap. This supersedes the earlier Android gate
  // (FN-5707), which kept the footer visible and left a ~80px dead band
  // where the off-screen nav bar's padding remained reserved.
  // `footerKeyboardOpen` (the footer `bottom: 0` collapse class) stays
  // iOS-only: it only matters when the footer is still rendered (e.g. over
  // a modal), where Android's resizes-content already stacks it correctly.
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
  const { mailboxUnreadCount, mailboxPendingApprovalCount, setMailboxUnreadCount } = useMailboxUnread(currentProject?.id);
  const { chatHasUnreadResponse } = useChatUnreadBadge(currentProject?.id, { taskView, quickChatOpen });
  const { stashOrphanCount } = useStashOrphanCount(currentProject?.id);
  const [showGitHubStarPrompt, setShowGitHubStarPrompt] = useState(false);
  const gitHubStarPromptShown = useGitHubStarPromptShown();
  const handleStarPrompt = useCallback(() => setShowGitHubStarPrompt(true), []);
  const { candidate: approvalBannerCandidate, dismissApproval } = useApprovalBanner({
    tasks,
    currentProjectId: currentProject?.id,
    gitHubStarPromptShown,
    onStarPrompt: handleStarPrompt,
  });

  const {
    branchFilter,
    baseBranchFilter,
    branchOptions,
    baseBranchOptions,
    filteredBoardTasks,
    onBranchFilterChange: handleBranchFilterChange,
    onBaseBranchFilterChange: handleBaseBranchFilterChange,
  } = useBranchTaskFilters({ boardSourceTasks, currentProjectId: currentProject?.id });

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
  const { open: authTokenRecoveryOpen } = useAuthTokenRecovery();
  const {
    health: dashboardHealth,
    setHealth: setDashboardHealth,
    refreshing: dbCorruptionRefreshing,
    refreshError: dbCorruptionRefreshError,
    refresh: refreshDbCorruptionHealth,
  } = useDashboardHealth();
  const { dismissed: setupWarningDismissed, dismiss: handleDismissSetupWarning } = useScopedDismissFlag(SETUP_WARNING_DISMISSED_KEY, currentProject?.id);

  // Settings state
  const {
    maxConcurrent,
    autoMerge,
    mergeStrategy,
    planAutoApproveEnabled,
    showWorktreeGrouping,
    globalPaused,
    isTestMode,
    taskStuckTimeoutMs,
    staleHighFanoutBlockerAgeThresholdMs,
    capacityRiskBannerEnabled,
    capacityRiskTodoThreshold,
    openTasksInRightSidebar,
    openMobileTasksInPopup,
    taskPopupsBoardListOnly,
    showCostBadgeOnCards,
    modelPricingOverrides,
    taskDetailChatFirst,
    quickChatButtonMode,
    quickChatCloseOnOutsideClick,
    dashboardKeyboardShortcuts,
    dismissModalsOnOutsideClick,
    maxTotalRetriesBeforeFail,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    memoryEnabled,
    devServerEnabled,
    todosEnabled,
    goalsEnabled,
    setQuickChatButtonModeImmediate,
    toggleAutoMerge,
    togglePlanAutoApprove,
    refresh: refreshAppSettings,
  } = useAppSettings(currentProject?.id);

  const taskPopupsVisibleOnCurrentView = useCallback((originTaskView?: TaskView) => isTaskPopupVisibleForView({
    taskPopupsBoardListOnly,
    taskView,
    originTaskView,
  }), [taskPopupsBoardListOnly, taskView]);
  /*
  FNXC:TaskPopupViewGating 2026-07-13-00:00:
  Default-off preserves today's globally visible task popups. When enabled, a popup is render-attached to the Board/List view where it was opened: switching views unmounts the FloatingWindow without clearing the hook snapshot, and returning to that same view remounts it with the shared persisted geometry.
  */
  const visiblePoppedOutTaskEntries = useMemo(
    () => poppedOutTaskEntries.filter((entry) => taskPopupsVisibleOnCurrentView(entry.originTaskView)),
    [poppedOutTaskEntries, taskPopupsVisibleOnCurrentView],
  );
  const visiblePoppedOutTasks = useMemo(() => visiblePoppedOutTaskEntries.map((entry) => entry.task), [visiblePoppedOutTaskEntries]);

  const pluginDashboardViews = useMemo<PluginDashboardViewEntry[]>(() => {
    /*
    FNXC:RoadmapsNavigation 2026-06-22-18:50:
    The roadmap app view and experimental toggle were removed from the dashboard surface. Filter any plugin-provided Roadmaps dashboard view here so an installed/persisted plugin cannot reintroduce the sidebar destination.
    */
    return rawPluginDashboardViews.filter(
      (entry) => !(entry.pluginId === "fusion-plugin-roadmap" && entry.view.viewId === "roadmaps"),
    );
  }, [rawPluginDashboardViews]);

  const { stats: agentStats } = useAgents(currentProject?.id);

  const inProgressCount = useMemo(
    () => boardSourceTasks.filter((task) => task.column === "in-progress").length,
    [boardSourceTasks],
  );
  const inReviewCount = useMemo(
    () => boardSourceTasks.filter((task) => task.column === "in-review").length,
    [boardSourceTasks],
  );
  const { signal: capacityRiskSignal, dismissed: capacityRiskDismissed, dismiss: handleDismissCapacityRisk } = useCapacityRiskBanner({
    agentStats,
    inProgressCount,
    inReviewCount,
    capacityRiskBannerEnabled,
    capacityRiskTodoThreshold,
    settingsLoaded,
    currentProjectId: currentProject?.id,
  });

  /* FNXC:DefaultNavigation 2026-06-23-01:26: Skills graduated from Experimental and should remain visible on upgrades even when stale `experimentalFeatures.skillsView=false` is present. */
  const skillsEnabled = true;
  const nodesEnabled = experimentalFeatures.nodesView === true;
  const researchEnabled = experimentalFeatures.researchView === true;
  const evalsEnabled = experimentalFeatures.evalsView === true;
  /* FNXC:QuickAddSubtaskFlag 2026-06-21-00:00: Missing or false `subtaskBreakdown` settings must hide the AI Subtask quick-add handoff across List, Board, and New Task Modal surfaces; only an explicit true wires the callback. */
  const subtaskBreakdownEnabled = experimentalFeatures.subtaskBreakdown === true;
  /*
  FNXC:Navigation 2026-06-19-00:00:
  Experimental left sidebar navigation replaces the Header view shortcuts with a persistent sidebar on non-mobile project screens, while mobile continues to use the bottom navigation bar as the only primary navigation surface.

  FNXC:Navigation 2026-06-21-00:00:
  Left sidebar navigation is now the default primary navigation on non-mobile project screens. Keep `leftSidebarNav: false` as the explicit opt-out and keep mobile on the bottom navigation bar.
  */
  const leftSidebarNavEnabled = experimentalFeatures.leftSidebarNav !== false;
  /* FNXC:Navigation 2026-06-22-18:00: The right dock panel is no longer experimental or user-toggleable; tablet/desktop project screens always support it regardless of any stale persisted `rightDock` setting. */
  const rightDockEnabled = true;
  const executorFooterVisible = viewMode === "project" && !!currentProject;
  const rightDockActive = rightDockEnabled && !isMobile && executorFooterVisible;
  const sidebarActive = leftSidebarNavEnabled && !isMobile && executorFooterVisible;
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
    if (taskView === "todos" && !todosEnabled) {
      handleChangeTaskView("board");
    }
  }, [taskView, settingsLoaded, skillsEnabled, insightsEnabled, handleChangeTaskView, agentsEnabled, memoryEnabled, devServerEnabled, researchEnabled, evalsEnabled, goalsEnabled, todosEnabled, graphPluginTaskView]);

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
    setTaskView,
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
      /*
      FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
      Do not hard-code `column: "triage"` — this surface has no workflow picker, so it inherits the project-default workflow, and the store resolves the landing column from that workflow's intake column (e.g. Coding (Ideas) → "ideas") instead of forcing triage.
      */
      await createTask({
        title,
        description,
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

  /*
  FNXC:TaskDetailSwipeBack 2026-06-29-14:21:
  Mobile task-detail opens that use the modal path must still push a history entry even when the originating surface is the single-pane mobile list. AppModals owns nested-detail restoration, while this first-open path keeps the baseline dismiss-to-origin callback (`modalManager.closeDetailTask`) for the top-level modal entry.
  */
  const openDetailTask = useCallback((task: Task | TaskDetail, tab?: Parameters<typeof modalManager.openDetailTask>[1], opts?: { origin?: DetailTaskOrigin }) => {
    modalManager.openDetailTask(task, tab, opts);
    pushNav({ type: "modal", close: modalManager.closeDetailTask });
  }, [modalManager, pushNav]);

  /*
  FNXC:Navigation 2026-06-22-00:00:
  Board card clicks open task detail as a full main-content view that replaces the board (design: "Full main panel (replaces board)"), instead of the TaskDetailModal overlay. We store a snapshot of the clicked task and navigate to the registered `task-detail` view; renderMainContent renders TaskDetailContent embedded with a Back-to-board button. Only the Board uses this handler — list-view split-detail, right-dock cards, and other openDetail callers keep the modal behavior.

  FNXC:TaskDetailBack 2026-06-25-00:00:
  Browser and Android Back must close the currently viewed full-panel task detail before leaving the prior dashboard view. The history entry owns an idempotent revert callback that clears stale snapshot state for board/list origins or restores the previous task snapshot for nested task-detail links, and explicit Back-to-board consumes that same entry without pushing a contradictory view entry during popstate.
  */
  const openTaskDetailInMainPanel = useCallback((task: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    const previousView = taskView;
    const previousDetailTask = mainPanelDetailTask;
    const previousDetailTab = mainPanelDetailInitialTab;

    if (previousView === "task-detail" && previousDetailTask?.id === task.id && previousDetailTab === initialTab) {
      setMainPanelDetailTask(task);
      return;
    }

    if (previousView !== "task-detail") {
      captureCurrentBoardScrollSnapshot();
    }

    const revertMainPanelDetail = () => {
      if (previousView === "task-detail" && previousDetailTask) {
        setMainPanelDetailTask(previousDetailTask);
        setMainPanelDetailInitialTab(previousDetailTab);
        handleChangeTaskView("task-detail");
        mainPanelDetailNavRevertRef.current = null;
        return;
      }

      requestRestore();
      setMainPanelDetailTask(null);
      setMainPanelDetailInitialTab("chat");
      handleChangeTaskView(previousView);
      mainPanelDetailNavRevertRef.current = null;
    };

    setMainPanelDetailTask(task);
    setMainPanelDetailInitialTab(initialTab);
    handleChangeTaskView("task-detail");
    mainPanelDetailNavRevertRef.current = revertMainPanelDetail;
    pushNav({ type: "view", revert: revertMainPanelDetail });
  }, [captureCurrentBoardScrollSnapshot, handleChangeTaskView, mainPanelDetailInitialTab, mainPanelDetailTask, pushNav, requestRestore, taskView]);

  // FNXC:Navigation 2026-06-22-00:00: Leaving task-detail clears the snapshot so a stale task never lingers if the view is reopened empty.
  const closeTaskDetailMainPanel = useCallback(() => {
    const revert = mainPanelDetailNavRevertRef.current;
    if (revert) {
      removeNav(revert);
      mainPanelDetailNavRevertRef.current = null;
    }
    requestRestore();
    setMainPanelDetailTask(null);
    setMainPanelDetailInitialTab("chat");
    handleChangeTaskView("board");
  }, [handleChangeTaskView, removeNav, requestRestore]);

  const handleOpenDetailWithTab = useCallback((task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => {
    if (initialTab === "changes") {
      openTaskDetailInMainPanel(task, "changes");
      return;
    }
    modalManager.openDetailTask(task, initialTab);
    pushNav({ type: "modal", close: modalManager.closeDetailTask });
  }, [modalManager, openTaskDetailInMainPanel, pushNav]);

  /*
  FNXC:Settings 2026-06-22-00:00:
  Settings is now a main-content destination. The header/sidebar entry points navigate to the embedded `settings` view (carrying the requested deep-link section via setSettingsSection) instead of opening the modal overlay. handleTaskViewChange owns the back-navigation history entry, so no modal nav entry is pushed here.
  */
  const openSettingsWithNav = useCallback((section?: Parameters<typeof modalManager.openSettings>[0]) => {
    modalManager.setSettingsSection(section);
    handleTaskViewChange("settings");
  }, [modalManager, handleTaskViewChange]);

  /*
  FNXC:DashboardShortcuts 2026-07-04-00:00:
  FN-7553's openCommandCenter shortcut reuses the same handleTaskViewChange nav-history owner as openSettingsWithNav/openPlanningWithNav above, so Command Center never gets a second/duplicate nav destination beyond the existing Header/LeftSidebarNav/MobileNavBar "command-center" view entries.
  */
  const openCommandCenterWithNav = useCallback(() => {
    handleTaskViewChange("command-center");
  }, [handleTaskViewChange]);

  const openNewTaskWithNav = useCallback(() => {
    modalManager.openNewTask();
    pushNav({ type: "modal", close: modalManager.closeNewTask });
  }, [modalManager, pushNav]);

  /*
  FNXC:Navigation 2026-06-21-00:00:
  FN-6886 keeps the existing planning payload setters but routes every programmatic Planning Mode entry point to the docked `planning` view instead of pushing a modal overlay history entry.
  */
  const openPlanningWithNav = useCallback(() => {
    modalManager.openPlanning();
    handleTaskViewChange("planning");
  }, [handleTaskViewChange, modalManager]);

  const openPlanningWithInitialPlanWithNav = useCallback((initialPlan: string, workflowId?: string | null) => {
    modalManager.openPlanningWithInitialPlan(initialPlan, workflowId);
    handleTaskViewChange("planning");
  }, [handleTaskViewChange, modalManager]);

  const resumePlanningWithNav = useCallback(() => {
    modalManager.resumePlanning();
    handleTaskViewChange("planning");
  }, [handleTaskViewChange, modalManager]);

  const openSubtaskBreakdownWithNav = useCallback((description: string, workflowId?: string | null) => {
    modalManager.openSubtaskBreakdown(description, workflowId);
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

  const closeTerminalWithNav = useCallback(() => {
    removeNav(modalManager.closeTerminal);
    modalManager.closeTerminal();
  }, [modalManager, removeNav]);

  const toggleTerminalWithNav = useCallback(() => {
    if (!modalManager.terminalOpen) {
      modalManager.toggleTerminal();
      pushNav({ type: "modal", close: modalManager.closeTerminal });
    } else {
      closeTerminalWithNav();
    }
  }, [closeTerminalWithNav, modalManager, pushNav]);

  const closeTopmostPopupForShortcut = useCallback(() => {
    /*
    FNXC:DashboardShortcuts 2026-07-04-00:00:
    Escape should close only one visible dashboard popup per key press. Floating user surfaces close before fixed app modals so a Quick Chat or task popout on top does not accidentally dismiss the underlying Terminal, Settings, or Task Detail modal.

    FNXC:DashboardShortcuts 2026-07-04-12:02:
    Popped-out tasks are the most recent floating work surface and must close before Quick Chat. This preserves the topmost-popup invariant when a task popout overlays chat, then falls back to Terminal and modal-manager surfaces one layer per Escape.
    */
    return closeTopmostDashboardPopupForShortcut(
      {
        poppedOutTaskIds: visiblePoppedOutTasks.map((task) => task.id),
        quickChatOpen,
        terminalOpen: modalManager.terminalOpen,
        modalClosers: [
          [modalManager.filesOpen, modalManager.closeFiles],
          [modalManager.workflowEditorOpen, modalManager.closeWorkflowEditor],
          [modalManager.gitManagerOpen, modalManager.closeGitManager],
          [modalManager.activityLogOpen, modalManager.closeActivityLog],
          [modalManager.scriptsOpen, modalManager.closeScripts],
          [modalManager.agentsOpen, modalManager.closeAgents],
          [modalManager.usageOpen, modalManager.closeUsage],
          [modalManager.schedulesOpen, modalManager.closeSchedules],
          [modalManager.githubImportOpen, modalManager.closeGitHubImport],
          [modalManager.settingsOpen, modalManager.closeSettings],
          [Boolean(modalManager.detailTask), modalManager.closeDetailTask],
          [Boolean(modalManager.groupModalGroupId), modalManager.closeGroupModal],
          [modalManager.isSubtaskOpen, modalManager.closeSubtask],
          [modalManager.isPlanningOpen, modalManager.closePlanning],
          [modalManager.newTaskModalOpen, modalManager.closeNewTask],
          [modalManager.setupWizardOpen, modalManager.closeSetupWizard],
          [modalManager.modelOnboardingOpen, modalManager.closeModelOnboarding],
        ],
      },
      {
        closePoppedOutTask,
        closeQuickChat: () => setQuickChatOpen(false),
        closeTerminal: closeTerminalWithNav,
      },
    );
  }, [closePoppedOutTask, closeTerminalWithNav, modalManager, quickChatOpen, visiblePoppedOutTasks]);

  const openFilesWithNav = useCallback((workspace?: string, initialFile?: string | null) => {
    modalManager.openFiles(workspace, initialFile);
    pushNav({ type: "modal", close: modalManager.closeFiles });
  }, [modalManager, pushNav]);

  /*
  FNXC:DashboardShortcuts 2026-07-04-00:00:
  FN-7553 wires openFiles/openSettings/openCommandCenter/newTask into the same global listener as the base quickChat/terminal actions (FN-7494/FN-7507), reusing openFilesWithNav, openSettingsWithNav, openCommandCenterWithNav, and openNewTaskWithNav so no second nav destination is introduced.
  */
  useDashboardKeyboardShortcuts({
    shortcuts: dashboardKeyboardShortcuts,
    openQuickChat: () => setQuickChatOpen(true),
    toggleTerminal: toggleTerminalWithNav,
    closeTopmostPopup: closeTopmostPopupForShortcut,
    openFiles: () => openFilesWithNav(),
    openSettings: () => openSettingsWithNav(),
    openCommandCenter: openCommandCenterWithNav,
    openNewTask: openNewTaskWithNav,
  });

  const openFileInBrowser = useCallback((path: string, opts?: { workspace?: string; line?: number; col?: number }) => {
    modalManager.openFiles(opts?.workspace, path);
    pushNav({ type: "modal", close: modalManager.closeFiles });
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
        openAuthenticationSettings: () => openSettingsWithNav("authentication" as SectionId),
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

  /*
   * FNXC:DesktopSwitchServer 2026-07-04-13:20:
   * Single shared decision path for the in-dashboard "Switch server" navigation, covering BOTH directions
   * (remote -> local and local -> remote). This mirrors the working native-menu / desktopLaunchMode flow by
   * navigating the renderer to the selected server's origin, since the in-dashboard switch does not route
   * through the Electron main-process launch-mode handlers. See resolveDesktopShellRedirectTarget in
   * appLifecycle.ts for the pure decision logic and negative-state guards (not-running runtime, already-on-
   * target origin, non-desktop hosts, missing active profile).
   */
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const target = resolveDesktopShellRedirectTarget(shellState, window.location.href);
    if (target) {
      window.location.href = target;
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

  // Props for the extracted <MainContent> switch (see components/dashboard/MainContent.tsx).
  // Every value is passed by its App name; the switch renders the same subtrees as before.
  const rightDock = useRightDockController({ active: rightDockActive, projectId: currentProject?.id, addToast, settingsLoaded, researchReadinessVersion, goalAnchorId, tasks: isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks, workflowSteps, subscribePluginEvents, openDetailTask, openTaskPopup: popOutTaskDetailForCurrentView, openMobileTasksInPopup, openFileInBrowser, onMoveTask: moveTask, onDeleteTask: deleteTask, onArchiveTask: archiveTask, onRevertTask: revertTask, onMergeTask: mergeTask, onRetryTask: retryTask, onBypassReview: bypassReview, onResetTask: resetTask, onDuplicateTask: duplicateTask, onTaskUpdated: (task: Task) => ingestCreatedTasks([task]), openSettings: (section?: string) => openSettingsWithNav(section as SectionId), onOpenUsage: openUsageWithNav, onOpenActivityLog: openActivityLogWithNav, onOpenGitHubImport: openGitHubImportWithNav, onOpenGitManager: openGitManagerWithNav, onOpenSchedules: openSchedulesWithNav, onSendSelectionToTask: modalManager.openNewTaskWithDescription, onCreateTaskFromInsight: handleInsightTaskCreate, onNavigateToMission: handleOpenMission, onTaskCreated: (task: Task) => ingestCreatedTasks([task]), prAuthAvailable, autoMerge, taskDetailChatFirst, visibilityOptions: { experimentalFeatures: { insights: insightsEnabled, memoryView: memoryEnabled, devServerView: devServerEnabled, researchView: researchEnabled, evalsView: evalsEnabled, goalsView: goalsEnabled }, showSkillsTab: skillsEnabled, todosEnabled, pluginDashboardViews }, footerVisible: executorFooterVisible });

  /*
  FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
  Board card clicks are the only task-open path governed by openTasksInRightSidebar. When the project setting is enabled and the tablet/desktop right dock is active, the board keeps its current view and asks the dock controller to render task detail; otherwise the existing full main-panel replacement remains the fallback, including mobile and hidden-footer states.

  FNXC:MobileTaskPopups 2026-07-01-12:00:
  Board-card clicks on every viewport may opt into the existing task pop-out path, but only for ordinary task opens with no deep initial tab. The route is intentionally ordered as all-viewport popup, then tablet/desktop right dock, then main-panel fallback so the popup setting keeps the board visible when requested while deep-tab opens and non-board handlers keep their existing behavior.
  */
  const openBoardTaskDetail = useCallback((task: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    const route = getBoardTaskOpenRoute({
      isMobile,
      openMobileTasksInPopup,
      openTasksInRightSidebar,
      rightDockActive,
      initialTab,
    });

    if (route === "popup") {
      popOutTaskDetailForCurrentView(task);
      return;
    }

    if (route === "dock") {
      rightDock.openTaskInDock(task);
      return;
    }

    openTaskDetailInMainPanel(task, initialTab);
  }, [isMobile, openMobileTasksInPopup, openTaskDetailInMainPanel, openTasksInRightSidebar, popOutTaskDetailForCurrentView, rightDock, rightDockActive]);

  useEffect(() => {
    if (!openTasksInRightSidebar) {
      rightDock.closeDockTask();
    }
  }, [openTasksInRightSidebar, rightDock]);

  const mainContentProps: MainContentProps = {
    showBackendConnectionErrorPage,
    projectsError,
    t,
    retryingProjects,
    handleRetryProjects,
    shellApi,
    taskView,
    modalManager,
    handleChangeTaskView,
    refreshAppSettings,
    addToast,
    currentProject,
    themeMode,
    setThemeMode,
    colorTheme,
    setColorTheme,
    dashboardFontScalePct,
    setDashboardFontScalePct,
    shadcnCustomColors,
    setShadcnCustomColors,
    resolvedThemeMode,
    setQuickChatButtonModeImmediate,
    reopenOnboardingWithNav,
    viewMode,
    projects,
    projectsLoading,
    handleSelectProject,
    handleAddProject,
    handlePauseProject,
    handleResumeProject,
    handleRemoveProject,
    nodes,
    graphPluginTaskView,
    graphWorkflowSelection,
    setGraphWorkflowSelection,
    isRemote,
    remoteData,
    tasks,
    workflowSteps,
    subscribePluginEvents,
    openDetailTask,
    openFileInBrowser,
    prAuthAvailable,
    autoMerge,
    mergeStrategy,
    planAutoApproveEnabled,
    settingsLoaded,
    openMobileTasksInPopup,
    taskDetailChatFirst,
    skillsEnabled,
    experimentalFeatures,
    setQuickChatOpen,
    setMailboxUnreadCount,
    setMissionTargetId,
    setMissionResumeSessionId,
    setMilestoneSliceResumeSessionId,
    missionResumeSessionId,
    missionTargetId,
    milestoneSliceResumeSessionId,
    setGoalAnchorId,
    goalAnchorId,
    agentsEnabled,
    agentOnboardingEnabled,
    handleOpenTaskLogs,
    popOutTaskDetail: popOutTaskDetailForCurrentView,
    selectedPrId,
    insightsEnabled,
    handleInsightTaskCreate,
    researchEnabled,
    openSettingsWithNav,
    researchReadinessVersion,
    evalsEnabled,
    memoryEnabled,
    goalsEnabled,
    handleOpenMission,
    todosEnabled,
    openPlanningWithInitialPlanWithNav,
    ingestCreatedTasks,
    nodesEnabled,
    openWorkflowEditorWithNav,
    handlePlanningTaskCreated,
    handlePlanningTasksCreated,
    handleGitHubImport,
    devServerEnabled,
    mainPanelDetailTask,
    filteredBoardTasks,
    maxConcurrent,
    showWorktreeGrouping,
    moveTask,
    pauseTask,
    openBoardTaskDetail,
    openTaskDetailInMainPanel,
    openGroupModalWithNav,
    handleBoardQuickCreate,
    openNewTaskWithNav,
    subtaskBreakdownEnabled,
    openSubtaskBreakdownWithNav,
    toggleAutoMerge,
    togglePlanAutoApprove,
    globalPaused,
    updateTask,
    retryTask,
    archiveTask,
    unarchiveTask,
    revertTask,
    deleteTask,
    archiveAllDone,
    loadArchivedTasks,
    loadMoreArchivedTasks,
    archivedHasMore,
    archivedLoadingMore,
    searchQuery,
    availableModels,
    favoriteProviders,
    favoriteModels,
    handleOpenDetailWithTab,
    handleToggleFavorite,
    handleToggleModelFavorite,
    taskStuckTimeoutMs,
    staleHighFanoutBlockerAgeThresholdMs,
    lastFetchTimeMs,
    openCreateWorkflowWithNav,
    sidebarActive,
    isMobile,
    mainPanelDetailInitialTab,
    closeTaskDetailMainPanel,
    setMainPanelDetailTask,
    mergeTask,
    resetTask,
    duplicateTask,
    unpauseTask,
    capacityRiskBannerEnabled,
    capacityRiskDismissed,
    capacityRiskSignal,
    handleDismissCapacityRisk,
    AgentsView,
    ChatView,
    CommandCenter,
    DevServerView,
    DocumentsView,
    EvalsView,
    GoalsView,
    InsightsView,
    MemoryView,
    PullRequestView,
    ResearchView,
    SecretsView,
    SkillsView,
    TodoView,
    _AutomationsView,
    _ImportTasksView,
    _SettingsView,
    _WorkflowEditorView,
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

  // Props for the extracted <DashboardBanners> cluster (see components/dashboard/DashboardBanners.tsx).
  // Every value is passed by its App name; the cluster renders the same banners as before.
  const dashboardBannersProps: DashboardBannersProps = {
    viewMode,
    currentProject,
    authTokenRecoveryOpen,
    isTestMode,
    dashboardHealth,
    setDashboardHealth,
    taskView,
    modalManager,
    sessionBannersHidden,
    sessionsNeedingInput,
    handleOpenBackgroundSession,
    handleDismissNeedingInputSession,
    handleDismissAllNeedingInputSessions,
    handleCliAction,
    getCliActionDisabledReasonForBanner,
    openSettingsWithNav,
    showOnboardingResumeCard,
    showPostOnboardingRecommendations,
    updateAvailable,
    latestVersion,
    currentVersion,
    updateBannerDismissed,
    dismissUpdateBanner,
    refreshDbCorruptionHealth,
    dbCorruptionRefreshing,
    dbCorruptionRefreshError,
    setupReadinessLoading,
    hasWarnings: visibleSetupHasWarnings,
    setupWarningDismissed,
    handleDismissSetupWarning,
    hasAiProvider,
    hasGithub,
    showGithubSetupWarning,
    approvalBannerCandidate,
    dismissApproval,
    mailboxPendingApprovalCount,
    handleTaskViewChange,
    showGitHubStarPrompt,
    gitHubStarPromptShown,
    markGitHubStarPromptShown,
    setShowGitHubStarPrompt,
  };
  return (
    <ModalDismissPreferenceProvider enabled={dismissModalsOnOutsideClick}>
      <NavigationHistoryProvider value={{ pushNav, replaceCurrent, removeNav }}>
        <FileBrowserProvider openFile={openFileInBrowser}>
          <RetryWarningProvider value={maxTotalRetriesBeforeFail * RETRY_WARNING_RATIO}>
            <CostBadgeProvider value={{ enabled: showCostBadgeOnCards, pricingOverrides: modelPricingOverrides }}>
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
        onOpenUsage={openUsageWithNav}
        onOpenActivityLog={openActivityLogWithNav}
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        mailboxUnreadCount={mailboxUnreadCount}
        mailboxPendingApprovalCount={mailboxPendingApprovalCount}
        chatHasUnreadResponse={chatHasUnreadResponse}
        stashOrphanCount={stashOrphanCount}
        onOpenSchedules={openSchedulesWithNav}
        onOpenGitManager={openGitManagerWithNav}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onOpenFiles={openFilesWithNav}
        filesOpen={modalManager.filesOpen}
        todosEnabled={todosEnabled}
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
        leftSidebarNavActive={sidebarActive}
        rightDockAvailable={rightDockActive}
        rightDockOpen={rightDock.open}
        onToggleRightDock={rightDock.toggle}
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
          leftSidebarNav: leftSidebarNavEnabled,
          rightDock: rightDockEnabled,
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
      <DashboardBanners {...dashboardBannersProps} />
      <div className="dashboard-project-stack" data-testid="dashboard-project-stack">
      <div className={`dashboard-project-shell${sidebarActive ? " dashboard-project-shell--with-sidebar" : ""}${rightDockActive ? " dashboard-project-shell--with-right-dock" : ""}`} data-testid="dashboard-project-shell">
        {sidebarActive && (
          <LeftSidebarNav
            view={taskView}
            onChangeView={handleTaskViewChange}
            onNewTask={openNewTaskWithNav}
            onOpenSettings={openSettingsWithNav}
            todosEnabled={todosEnabled}
            mailboxUnreadCount={mailboxUnreadCount}
            mailboxPendingApprovalCount={mailboxPendingApprovalCount}
            chatHasUnreadResponse={chatHasUnreadResponse}
            planningNeedsInput={planningNeedsInput}
            experimentalFeatures={{
              insights: insightsEnabled,
              memoryView: memoryEnabled,
              devServerView: devServerEnabled,
              researchView: researchEnabled,
              evalsView: evalsEnabled,
              goalsView: goalsEnabled,
            }}
            pluginDashboardViews={pluginDashboardViews}
            showAgentsTab={agentsEnabled}
            showSkillsTab={skillsEnabled}
            projects={effectiveProjects}
            currentProject={currentProject}
            onSelectProject={handleSelectProject}
            onViewAllProjects={handleViewAllProjects}
            footerVisible={executorFooterVisible}
          />
        )}
        <div
          className={`project-content${executorFooterVisible && (!isMobile || !mobileKeyboardOpen) ? " project-content--with-footer" : ""}${isMobile && !mobileKeyboardOpen ? " project-content--with-mobile-nav" : ""}`}
        >
          <MainContent {...mainContentProps} />
        </div>
        {rightDock.dock}
      </div>
      {currentProject && (
        <TerminalModal
          isOpen={modalManager.terminalOpen}
          onClose={closeTerminalWithNav}
          initialCommand={modalManager.terminalInitialCommand}
          initialCommandGeneration={modalManager.terminalInitialCommandGeneration}
          projectId={currentProject.id}
          footerVisible={executorFooterVisible}
        />
      )}
      </div>
      {rightDock.modal}
      {executorFooterVisible && currentProject && (
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
          onToggleTerminal={toggleTerminalWithNav}
          quickChatButtonMode={quickChatButtonMode}
          onOpenQuickChat={() => setQuickChatOpen(true)}
          onOpenScripts={openScriptsWithNav}
          onRunScript={runScriptWithNav}
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
        onOpenGitHubImport={openGitHubImportWithNav}
        onOpenPlanning={openPlanningWithNav}
        onResumePlanning={resumePlanningWithNav}
        activePlanningSessionCount={bgPlanningSessions.length}
        planningNeedsInput={planningNeedsInput}
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
      {/*
      FNXC:ChatModal 2026-06-22-13:24:
      Quick Chat is replaced by the full ChatView in a movable/resizable FloatingWindow. The launcher icon is only the minimized entry point: clicking it opens the Chat modal, and the modal's minimize button closes the window back into that icon. Main Chat can also pop out into this same full Chat modal.

      FNXC:ChatModal 2026-06-22-14:57:
      Reopening Quick Chat from the FAB restores the last floating Chat window geometry through FloatingWindow's persisted/clamped geometry key. The modal's maximize button routes to the full Chat view and closes the floating modal without clearing ChatView's shared session selection state.

      FNXC:ChatModal 2026-06-27-00:00:
      Quick Chat is a transient utility window, so it opts into FloatingWindow's outside-click dismissal in addition to minimize, close, and maximize controls. Task pop-outs intentionally do not opt in because they are persistent workspace windows that should survive page clicks.

      FNXC:ChatModal 2026-06-28-00:00:
      Outside-click dismissal is now governed by the project-scoped quickChatCloseOnOutsideClick setting, default-on to preserve FN-7152 behavior. Other FloatingWindow callers still do not pass closeOnOutsidePointerDown, so task pop-outs and utility windows remain persistent.
      */}
      {viewMode === "project" && currentProject && (
        <QuickChatFAB
          showFAB={quickChatButtonMode === "floating"}
          open={quickChatOpen}
          onOpenChange={setQuickChatOpen}
        />
      )}
      {quickChatOpen && currentProject && (
        <FloatingWindow
          windowKey="chat-modal"
          title="Chat"
          onClose={() => setQuickChatOpen(false)}
          closeOnOutsidePointerDown={quickChatCloseOnOutsideClick}
          hideHeader
          dragHandleSelector=".chat-view--floating .view-header"
          className="floating-window--chat"
          persistGeometryKey="kb-dashboard-chat-floating-window"
          defaultSize={{ width: 980, height: 680 }}
          /*
          FNXC:ChatModal 2026-06-23-22:14:
          The full Chat pop-out must be resizable into a very narrow desktop utility window. ChatView already switches to its mobile one-pane layout at narrow widths, so allow the FloatingWindow to shrink below the old two-pane desktop minimum while preserving enough width for composer controls.
          */
          minSize={{ width: 300, height: 420 }}
        >
          <Suspense fallback={null}>
            <ChatView
              addToast={addToast}
              projectId={currentProject.id}
              experimentalFeatures={experimentalFeatures}
              floating
              onMaximize={() => {
                handleTaskViewChange("chat");
                setQuickChatOpen(false);
              }}
              onMinimize={() => setQuickChatOpen(false)}
              onClose={() => setQuickChatOpen(false)}
            />
          </Suspense>
        </FloatingWindow>
      )}
      {/*
      FNXC:FloatingWindow 2026-06-22-20:45:
      One movable, resizable, non-blocking FloatingWindow per popped-out task. Each hosts the same embedded TaskDetailContent List/Board use, wired to the same App task handlers. Live row preferred by id; falls back to the snapshot. Terminal/destructive actions and the window close button both remove the entry. Multiple entries → multiple coexisting windows; FloatingWindow's per-window z-counter handles focus-to-front so the clicked one comes on top.

      FNXC:TaskDetail 2026-06-22-12:20:
      Task pop-outs use TaskDetailContent's own gray header as the only visible header, matching the one-header fixed task modal while keeping FloatingWindow drag/resize. The generic Maximize title chrome is hidden; close now lives beside edit inside the task header.

      FNXC:TaskPopupGeometry 2026-07-03-00:00:
      Every task-detail FloatingWindow keeps its per-task windowKey for DOM identity, dedupe, cascade fallback, and z-index independence, but all task-detail popups share one persisted geometry key so operators do not resize or reposition the popup between tasks.

      FNXC:TaskPopupLayer 2026-07-04-18:36:
      Ordinary task-detail popups belong to the board/task-detail layer, not the global floating-utility stack. Pass the task-detail layer so board/right-dock task opens preserve the visible board context while utility windows keep the higher app-wide raise/focus contract.

      FNXC:TaskPopupViewGating 2026-07-13-00:00:
      Rendering uses visible entries only; the source hook keeps hidden popup snapshots mounted in React state rather than clearing them on view change. This distinction lets the opt-in setting attach each popup to its originating Board/List view while default-off continues to render all open popups globally.
      */}
      {visiblePoppedOutTaskEntries.map(({ task: snapshot }) => {
        const liveTask = tasks.find((candidate) => candidate.id === snapshot.id) ?? snapshot;
        const close = () => closePoppedOutTask(snapshot.id);
        return (
          <FloatingWindow
            key={snapshot.id}
            windowKey={`task-detail-${snapshot.id}`}
            title={liveTask.id}
            onClose={close}
            hideHeader
            dragHandleSelector=".task-detail-content--embedded > .modal-header"
            className="floating-window--task-detail"
            persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY}
            layer="task-detail"
          >
            <TaskDetailContent
              task={liveTask}
              projectId={currentProject?.id}
              tasks={tasks}
              embedded
              onOpenDetail={popOutTaskDetailForCurrentView}
              onMoveTask={moveTask}
              onDeleteTask={deleteTask}
              onMergeTask={mergeTask}
              onRetryTask={retryTask}
              onBypassReview={bypassReview}
              onResetTask={resetTask}
              onDuplicateTask={duplicateTask}
              onRequestClose={close}
              addToast={addToast}
              prAuthAvailable={prAuthAvailable}
              autoMergeEnabled={autoMerge}
              taskDetailChatFirst={taskDetailChatFirst}
            />
          </FloatingWindow>
        );
      })}
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
        onPlanningMode={openPlanningWithInitialPlanWithNav}
        onSubtaskBreakdown={subtaskBreakdownEnabled ? openSubtaskBreakdownWithNav : undefined}
        taskOperations={{ moveTask, deleteTask, mergeTask, archiveTask, revertTask, retryTask, bypassReview, resetTask, duplicateTask }}
        deepLink={{ handleDetailClose }}
        settings={{ prAuthAvailable, autoMerge, taskDetailChatFirst, themeMode, colorTheme, dashboardFontScalePct, shadcnCustomColors, resolvedThemeMode, setThemeMode, setColorTheme, setDashboardFontScalePct, setShadcnCustomColors, setQuickChatButtonModeImmediate }}
        onSettingsClose={handleSettingsCloseWithNav}
        onReopenOnboarding={reopenOnboardingWithNav}
        onOpenApprovals={(_approvalId) => handleTaskViewChange("mailbox")}
        agentOnboardingEnabled={agentOnboardingEnabled}
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
            </CostBadgeProvider>
          </RetryWarningProvider>
        </FileBrowserProvider>
      </NavigationHistoryProvider>
    </ModalDismissPreferenceProvider>
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
