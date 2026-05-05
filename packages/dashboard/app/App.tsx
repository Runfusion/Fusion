import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
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
import { ExecutorStatusBar } from "./components/ExecutorStatusBar";
import { SessionNotificationBanner } from "./components/SessionNotificationBanner";
import { CliBinaryInstallBanner } from "./components/CliBinaryInstallBanner";
import { SetupWarningBanner } from "./components/SetupWarningBanner";
import { UpdateAvailableBanner } from "./components/UpdateAvailableBanner";
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
import { useSessionBannersHidden } from "./hooks/useSessionBannerPref";
import { useTasks } from "./hooks/useTasks";
import { useProjects } from "./hooks/useProjects";
import { useNodes } from "./hooks/useNodes";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { ToastProvider, useToast } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { useTheme } from "./hooks/useTheme";
import { useModalManager, type DetailTaskOrigin } from "./hooks/useModalManager";
import { useAppSettings } from "./hooks/useAppSettings";
import { useDeepLink } from "./hooks/useDeepLink";
import { useFavorites } from "./hooks/useFavorites";
import { useAuthOnboarding } from "./hooks/useAuthOnboarding";
import { useMobileKeyboard } from "./hooks/useMobileKeyboard";
import { useMobileScrollLock } from "./hooks/useMobileScrollLock";
import { useSetupReadiness } from "./hooks/useSetupReadiness";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useViewState, type TaskView } from "./hooks/useViewState";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { usePluginDashboardViews } from "./hooks/usePluginDashboardViews";
import { PluginDashboardViewHost } from "./plugins/PluginDashboardViewHost";
import { isPluginViewId } from "./plugins/pluginViewRegistry";
import { useProjectActions } from "./hooks/useProjectActions";
import { useTaskHandlers } from "./hooks/useTaskHandlers";
import { useRemoteNodeData } from "./hooks/useRemoteNodeData";
import { useRemoteNodeEvents } from "./hooks/useRemoteNodeEvents";
import { NodeProvider, useNodeContext } from "./context/NodeContext";
import { ShellProvider } from "./context/ShellContext";
import { useShellConnection } from "./hooks/useShellConnection";
import { NativeShellOnboardingModal } from "./components/NativeShellOnboardingModal";
import { NativeShellConnectionManager } from "./components/NativeShellConnectionManager";
import { NativeShellConnectionStatus } from "./components/NativeShellConnectionStatus";
import type { AiSessionSummary } from "./api";
import { fetchUnreadCount, reportDashboardPerf, fetchTaskDetail, fetchWorkflowSteps } from "./api";
import { getScopedItem, setScopedItem } from "./utils/projectStorage";
import { subscribeSse } from "./sse-bus";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } from "./auth";
import { AuthTokenRecoveryDialog } from "./components/AuthTokenRecoveryDialog";

// ChatView's CSS is imported eagerly so the styles bundle into the main
// CSS file. Without this, the lazy ChatView JS chunk loaded its own CSS
// link asynchronously, producing a brief flash of unstyled chat UI on
// first render.
import "./components/ChatView.css";

const IS_TEST_ENV = import.meta.env.MODE === "test";
const DASHBOARD_READY_SETTLE_DELAY_MS = IS_TEST_ENV ? 0 : 200;

const AgentsView = lazy(() => import("./components/AgentsView").then((m) => ({ default: m.AgentsView })));
const DocumentsView = lazy(() => import("./components/DocumentsView").then((m) => ({ default: m.DocumentsView })));
const InsightsView = lazy(() => import("./components/InsightsView").then((m) => ({ default: m.InsightsView })));
const ResearchView = lazy(() => import("./components/ResearchView").then((m) => ({ default: m.ResearchView })));
const NodesView = lazy(() => import("./components/NodesView").then((m) => ({ default: m.NodesView })));
const ChatView = lazy(() => import("./components/ChatView").then((m) => ({ default: m.ChatView })));
const RoadmapsView = lazy(() => import("./components/RoadmapsView").then((m) => ({ default: m.RoadmapsView })));
const SkillsView = lazy(() => import("./components/SkillsView").then((m) => ({ default: m.SkillsView })));
const MemoryView = lazy(() => import("./components/MemoryView").then((m) => ({ default: m.MemoryView })));
const DevServerView = lazy(() => import("./components/DevServerView").then((m) => ({ default: m.DevServerView })));
const _TodoView = lazy(() => import("./components/TodoView").then((m) => ({ default: m.TodoView })));

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
    void import("./components/NodesView");
    void import("./components/ChatView");
    void import("./components/RoadmapsView");
    void import("./components/SkillsView");
    void import("./components/MemoryView");
    void import("./components/DevServerView");
    void import("./components/TodoView");
  });
}

const SETUP_WARNING_DISMISSED_KEY = "kb-setup-warning-dismissed";

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

function AppInner() {
  const { toasts, addToast, removeToast } = useToast();
  const { shellApi, state: shellState, ready: shellReady } = useShellConnection();
  const isElectron = typeof window !== "undefined" && Boolean((window as Window & { electronAPI?: unknown }).electronAPI);

  // Warm lazy view chunks during browser idle so first navigation is instant.
  useEffect(() => {
    prefetchLazyViews();
  }, []);

  // Project management hooks - MUST be called before any conditional logic
  const { projects, loading: projectsLoading, error: projectsError, refresh: refreshProjects } = useProjects();
  const { nodes } = useNodes();

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
  
  // Remote node data and events when in remote mode (pass searchQuery for server-side filtering)
  const remoteData = useRemoteNodeData(currentNodeId, { projectId: currentProject?.id, searchQuery: searchQuery || undefined });
  useRemoteNodeEvents(currentNodeId);

  // Use remote data when in remote mode, local data otherwise
  const effectiveProjects = isRemote && remoteData.projects.length > 0 ? remoteData.projects : projects;
  
  // Theme management - required before useViewState
  const { themeMode, colorTheme, dashboardFontScalePct, setThemeMode, setColorTheme, setDashboardFontScalePct } = useTheme();

  // Background AI sessions - required before useModalManager
  const { sessions: bgSessions, generating: bgGenerating, needsInput: bgNeedsInput, planningSessions: bgPlanningSessions, dismissSession: bgDismiss } = useBackgroundSessions(currentProject?.id);
  const sessionsNeedingInput = bgSessions.filter(
    (session) => session.status === "awaiting_input" || session.status === "error"
  );
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

  // Navigation history for mobile back button / iOS swipe-back.
  const { pushNav, replaceCurrent } = useNavigationHistory({ enabled: isMobile });

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

  // History-aware view change handler — pushes nav entry on mobile.
  const handleTaskViewChange = useCallback((newView: TaskView) => {
    if (newView === "missions") {
      setMissionResumeSessionId(undefined);
      setMissionTargetId(undefined);
      setMilestoneSliceResumeSessionId(undefined);
    }
    const previousView = taskView;
    handleChangeTaskView(newView);
    // pushNav reads enabledRef internally; isMobile not needed in deps.
    if (previousView !== newView) {
      pushNav({ type: "view", revert: () => handleChangeTaskView(previousView) });
    }
  }, [handleChangeTaskView, taskView, pushNav]);

  // Tasks hook with project context and search query
  // SSE is only enabled for board/list views to free connection slots for mission detail fetches
  const taskSseEnabled = taskView === "board" || taskView === "list";
  const { tasks, createTask, moveTask, pauseTask, deleteTask, mergeTask, retryTask, resetTask, updateTask, duplicateTask, archiveTask, unarchiveTask, archiveAllDone, loadArchivedTasks, ingestCreatedTasks, lastFetchTimeMs } = useTasks(
    {
      ...(currentProject ? { projectId: currentProject.id } : {}),
      searchQuery: searchQuery || undefined,
      sseEnabled: taskSseEnabled,
    }
  );

  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [researchReadinessVersion, setResearchReadinessVersion] = useState(0);
  const mountTimeRef = useRef(performance.now());
  const projectsReadyLoggedRef = useRef(false);
  const projectReadyLoggedRef = useRef(false);

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
        reportDashboardPerf("[App]", msg);
      }
    }
    if (!currentProjectLoading && !projectReadyLoggedRef.current) {
      projectReadyLoggedRef.current = true;
      const msg = `current-project resolved at ${Math.round(performance.now() - mountTimeRef.current)}ms from mount`;
      if (!IS_TEST_ENV) {
        console.log(`[App] ${msg}`);
        reportDashboardPerf("[App]", msg);
      }
    }
  }, [projectsLoading, currentProjectLoading]);

  useEffect(() => {
    if (initialLoadComplete) {
      return;
    }

    if (projectsLoading || currentProjectLoading) {
      return;
    }

    const settleStart = performance.now();
    const settleTimer = window.setTimeout(() => {
      const msg = `dashboard ready at ${Math.round(performance.now() - mountTimeRef.current)}ms from mount (settle delay=${Math.round(performance.now() - settleStart)}ms)`;
      if (!IS_TEST_ENV) {
        console.log(`[App] ${msg}`);
        reportDashboardPerf("[App]", msg);
      }
      setInitialLoadComplete(true);
    }, DASHBOARD_READY_SETTLE_DELAY_MS);

    return () => {
      window.clearTimeout(settleTimer);
    };
  }, [initialLoadComplete, projectsLoading, currentProjectLoading]);

  const { keyboardOpen } = useMobileKeyboard({ enabled: isMobile });
  // Keyboard visibility controls both MobileNavBar rendering and whether
  // the project content reserves bottom padding for the mobile nav bar.
  // When a modal is open, modal-local inputs can trigger the keyboard without
  // affecting the underlying dashboard layout — the modal handles its own
  // viewport. Without this guard, modal keyboard state leaks into the app-level
  // layout, causing stale bottom-padding offsets after the keyboard closes.
  const mobileKeyboardOpen = isMobile && keyboardOpen && !modalManager.anyModalOpen;
  // App-level scroll lock for inline editing (TaskCard inline edit, etc.):
  // when the keyboard is up outside of any modal, pin the body so iOS can't
  // shift the document or visualViewport, and so the dashboard snaps back
  // into place when the keyboard dismisses. Modals manage their own lock
  // via useMobileScrollLock — the reference-counted hook handles overlap.
  useMobileScrollLock(mobileKeyboardOpen);

  // App-level mailbox unread count state (used for header/mobile nav badges)
  const [mailboxUnreadCount, setMailboxUnreadCount] = useState(0);

  const refreshMailboxUnreadCount = useCallback(() => {
    fetchUnreadCount(currentProject?.id)
      .then((data: { unreadCount: number }) => {
        setMailboxUnreadCount(data.unreadCount);
      })
      .catch((err) => {
        console.warn("[App] Failed to fetch mailbox unread count:", err);
      });
  }, [currentProject?.id]);

  // Initial fetch + live updates from mailbox SSE events.
  useEffect(() => {
    refreshMailboxUnreadCount();

    const params = new URLSearchParams();
    if (currentProject?.id) {
      params.set("projectId", currentProject.id);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    return subscribeSse(`/api/events${query}`, {
      events: {
        "message:sent": refreshMailboxUnreadCount,
        "message:received": refreshMailboxUnreadCount,
        "message:read": refreshMailboxUnreadCount,
        "message:deleted": refreshMailboxUnreadCount,
      },
    });
  }, [currentProject?.id, refreshMailboxUnreadCount]);

  // Nodes management is an overlay view (not a modal), so it stays local to App.
  const [nodesOpen, setNodesOpen] = useState(false);
  const [retryingProjects, setRetryingProjects] = useState(false);
  const [missionResumeSessionId, setMissionResumeSessionId] = useState<string | undefined>(undefined);
  const [missionTargetId, setMissionTargetId] = useState<string | undefined>(undefined);
  const [milestoneSliceResumeSessionId, setMilestoneSliceResumeSessionId] = useState<string | undefined>(undefined);
  const [quickChatOpen, setQuickChatOpen] = useState(false);
  const [authTokenRecoveryOpen, setAuthTokenRecoveryOpen] = useState(false);
  const [setupWarningDismissed, setSetupWarningDismissed] = useState(
    () => getScopedItem(SETUP_WARNING_DISMISSED_KEY, currentProject?.id) === "true",
  );

  useEffect(() => {
    setSetupWarningDismissed(
      getScopedItem(SETUP_WARNING_DISMISSED_KEY, currentProject?.id) === "true",
    );
  }, [currentProject?.id]);

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

  // Settings state
  const {
    maxConcurrent,
    autoMerge,
    globalPaused,
    enginePaused,
    taskStuckTimeoutMs,
    showQuickChatFAB,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    roadmapEnabled,
    memoryEnabled,
    devServerEnabled,
    todosEnabled,
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
    refresh: refreshAppSettings,
  } = useAppSettings(currentProject?.id);

  const skillsEnabled = experimentalFeatures.skillsView === true;
  const nodesEnabled = experimentalFeatures.nodesView === true;
  const researchEnabled = experimentalFeatures.researchView === true;
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

  // Redirect to board if feature-gated views are disabled.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (isPluginViewId(taskView)) return;
    if (taskView === "skills" && !skillsEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "insights" && !insightsEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "roadmaps" && !roadmapEnabled) {
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
  }, [taskView, settingsLoaded, skillsEnabled, insightsEnabled, roadmapEnabled, handleChangeTaskView, agentsEnabled, memoryEnabled, devServerEnabled, researchEnabled]);

  // Auto-close nodes overlay if feature flag is toggled off while overlay is open
  useEffect(() => {
    if (nodesOpen && !nodesEnabled) {
      setNodesOpen(false);
    }
  }, [nodesOpen, nodesEnabled]);
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
    handleOpenSettings,
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

  const handleOpenDetailWithTab = useCallback((task: Task | TaskDetail, initialTab: "changes") => {
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

  const handleOpenNodes = useCallback(() => {
    if (!nodesEnabled) return;
    setNodesOpen((prev) => !prev);
  }, [nodesEnabled]);

  // History-aware nodes toggle — pushes nav entry only when opening
  const handleOpenNodesWithHistory = useCallback(() => {
    if (!nodesEnabled) return;
    if (!nodesOpen) {
      setNodesOpen(true);
      pushNav({ type: "view", revert: () => setNodesOpen(false) });
    } else {
      setNodesOpen(false);
    }
  }, [nodesEnabled, nodesOpen, pushNav]);

  // History-aware modal open handlers — push nav entries on mobile only.
  // Desktop (isMobile=false): pushNav/replaceCurrent are no-ops.
  const openDetailTaskWithHistory = useCallback((task: Task | TaskDetail, tab?: Parameters<typeof modalManager.openDetailTask>[1], opts?: { origin?: DetailTaskOrigin }) => {
    modalManager.openDetailTask(task, tab, opts);
    pushNav({ type: "modal", close: modalManager.closeDetailTask });
  }, [modalManager, pushNav]);

  const openSettingsWithHistory = useCallback((section?: Parameters<typeof modalManager.openSettings>[0]) => {
    modalManager.openSettings(section);
    pushNav({ type: "modal", close: handleSettingsClose });
  }, [modalManager, pushNav, handleSettingsClose]);

  const openNewTaskWithHistory = useCallback(() => {
    modalManager.openNewTask();
    pushNav({ type: "modal", close: modalManager.closeNewTask });
  }, [modalManager, pushNav]);

  const openPlanningWithHistory = useCallback(() => {
    modalManager.openPlanning();
    pushNav({ type: "modal", close: modalManager.closePlanning });
  }, [modalManager, pushNav]);

  const openPlanningWithInitialPlanWithHistory = useCallback((initialPlan: string) => {
    modalManager.openPlanningWithInitialPlan(initialPlan);
    pushNav({ type: "modal", close: modalManager.closePlanning });
  }, [modalManager, pushNav]);

  const resumePlanningWithHistory = useCallback(() => {
    modalManager.resumePlanning();
    pushNav({ type: "modal", close: modalManager.closePlanning });
  }, [modalManager, pushNav]);

  const openSubtaskBreakdownWithHistory = useCallback((description: string) => {
    modalManager.openSubtaskBreakdown(description);
    pushNav({ type: "modal", close: modalManager.closeSubtask });
  }, [modalManager, pushNav]);

  const openGitHubImportWithHistory = useCallback(() => {
    modalManager.openGitHubImport();
    pushNav({ type: "modal", close: modalManager.closeGitHubImport });
  }, [modalManager, pushNav]);

  const toggleTerminalWithHistory = useCallback(() => {
    // Only push if terminal is currently closed (opening)
    if (!modalManager.terminalOpen) {
      modalManager.toggleTerminal();
      pushNav({ type: "modal", close: modalManager.closeTerminal });
    } else {
      modalManager.toggleTerminal();
    }
  }, [modalManager, pushNav]);

  const openFilesWithHistory = useCallback(() => {
    modalManager.openFiles();
    pushNav({ type: "modal", close: modalManager.closeFiles });
  }, [modalManager, pushNav]);

  const openTodosWithHistory = useCallback(() => {
    modalManager.openTodos();
    pushNav({ type: "modal", close: modalManager.closeTodos });
  }, [modalManager, pushNav]);

  const openActivityLogWithHistory = useCallback(() => {
    modalManager.openActivityLog();
    pushNav({ type: "modal", close: modalManager.closeActivityLog });
  }, [modalManager, pushNav]);

  const openGitManagerWithHistory = useCallback(() => {
    modalManager.openGitManager();
    pushNav({ type: "modal", close: modalManager.closeGitManager });
  }, [modalManager, pushNav]);

  const openSystemStatsWithHistory = useCallback(() => {
    modalManager.openSystemStats();
    pushNav({ type: "modal", close: modalManager.closeSystemStats });
  }, [modalManager, pushNav]);

  const openSchedulesWithHistory = useCallback(() => {
    modalManager.openSchedules();
    pushNav({ type: "modal", close: modalManager.closeSchedules });
  }, [modalManager, pushNav]);

  const openScriptsWithHistory = useCallback(() => {
    modalManager.openScripts();
    pushNav({ type: "modal", close: modalManager.closeScripts });
  }, [modalManager, pushNav]);

  const openWorkflowStepsWithHistory = useCallback(() => {
    modalManager.openWorkflowSteps();
    pushNav({ type: "modal", close: modalManager.closeWorkflowSteps });
  }, [modalManager, pushNav]);

  const openUsageWithHistory = useCallback((anchorRect?: DOMRect | null) => {
    modalManager.openUsage(anchorRect);
    pushNav({ type: "modal", close: modalManager.closeUsage });
  }, [modalManager, pushNav]);

  // Modal-to-modal transition: scripts -> terminal uses replaceCurrent
  const runScriptWithHistory = useCallback(async (name: string, command: string) => {
    await modalManager.runScript(name, command);
    replaceCurrent({ type: "modal", close: modalManager.closeTerminal });
  }, [modalManager, replaceCurrent]);

  // Modal-to-modal transition: settings -> onboarding uses replaceCurrent
  const reopenOnboardingWithHistory = useCallback(() => {
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

  const [shellOnboardingComplete, setShellOnboardingComplete] = useState(false);
  const [shellConnectionManagerOpen, setShellConnectionManagerOpen] = useState(false);

  const requiresShellOnboarding = requiresNativeShellOnboarding(shellState, shellReady, shellOnboardingComplete);

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

  const showBackendConnectionErrorPage =
    !projectsLoading &&
    !currentProjectLoading &&
    projects.length === 0 &&
    !currentProject &&
    Boolean(projectsError);

  // Render main content based on view mode
  const renderMainContent = () => {
    if (showBackendConnectionErrorPage) {
      return (
        <BackendConnectionErrorPage
          errorMessage={projectsError ?? "Failed to fetch projects"}
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
              <NodesView addToast={addToast} onClose={() => setNodesOpen(false)} />
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

    // Project view
    if (isPluginViewId(taskView)) {
      return (
        <PageErrorBoundary>
          <PluginDashboardViewHost
            taskView={taskView as `plugin:${string}:${string}`}
            context={{
              projectId: currentProject?.id,
              tasks: isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks,
              workflowSteps,
              openTaskDetail: isMobile
                ? (task: Task | TaskDetail, initialTab?: Parameters<typeof modalManager.openDetailTask>[1]) =>
                    openDetailTaskWithHistory(task, initialTab)
                : (task: Task | TaskDetail, initialTab?: Parameters<typeof modalManager.openDetailTask>[1]) =>
                    modalManager.openDetailTask(task, initialTab),
              renderTaskCard: (task: Task) => (
                <TaskCard
                  task={task}
                  projectId={currentProject?.id}
                  onOpenDetail={isMobile ? (value: Task | TaskDetail) => openDetailTaskWithHistory(value) : (value: Task | TaskDetail) => modalManager.openDetailTask(value)}
                  addToast={addToast}
                  workflowStepNameLookup={workflowStepNameLookup}
                />
              ),
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
            <ChatView addToast={addToast} projectId={currentProject?.id} />
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

    if (taskView === "roadmaps") {
      if (!settingsLoaded || !roadmapEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <RoadmapsView addToast={addToast} projectId={currentProject?.id} />
          </Suspense>
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
              if (task) (isMobile ? openDetailTaskWithHistory : modalManager.openDetailTask)(task as TaskDetail);
            }}
            availableTasks={tasks.map((t) => ({ id: t.id, title: t.title }))}
            resumeSessionId={missionResumeSessionId}
            targetMissionId={missionTargetId}
            milestoneSliceResumeSessionId={milestoneSliceResumeSessionId}
            onMilestoneSliceResumeFetchError={() => setMilestoneSliceResumeSessionId(undefined)}
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
              onOpenDetail={isMobile ? openDetailTaskWithHistory : modalManager.openDetailTask}
            />
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

    if (taskView === "memory") {
      if (!settingsLoaded || !memoryEnabled) {
        return null;
      }
      return (
        <PageErrorBoundary>
          <Suspense fallback={null}>
            <MemoryView addToast={addToast} projectId={currentProject?.id} />
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
          <Board
            tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
            projectId={currentProject?.id}
            maxConcurrent={maxConcurrent}
            onMoveTask={moveTask}
            onPauseTask={pauseTask}
            onOpenDetail={isMobile ? openDetailTaskWithHistory : modalManager.openDetailTask}
            addToast={addToast}
            onQuickCreate={handleBoardQuickCreate}
            onNewTask={isMobile ? openNewTaskWithHistory : modalManager.openNewTask}
            onPlanningMode={isMobile ? openPlanningWithInitialPlanWithHistory : modalManager.openPlanningWithInitialPlan}
            onSubtaskBreakdown={isMobile ? openSubtaskBreakdownWithHistory : modalManager.openSubtaskBreakdown}
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
            onOpenMission={handleOpenMission}
            lastFetchTimeMs={lastFetchTimeMs}
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
          onMergeTask={mergeTask}
          onResetTask={resetTask}
          onDuplicateTask={duplicateTask}
          onOpenDetail={isMobile ? (task, options) => openDetailTaskWithHistory(task, undefined, options) : (task, options) => modalManager.openDetailTask(task, undefined, options)}
          addToast={addToast}
          globalPaused={globalPaused}
          onNewTask={isMobile ? openNewTaskWithHistory : modalManager.openNewTask}
          onQuickCreate={handleBoardQuickCreate}
          onPlanningMode={isMobile ? openPlanningWithInitialPlanWithHistory : modalManager.openPlanningWithInitialPlan}
          onSubtaskBreakdown={isMobile ? openSubtaskBreakdownWithHistory : modalManager.openSubtaskBreakdown}
          availableModels={availableModels}
          favoriteProviders={favoriteProviders}
          favoriteModels={favoriteModels}
          onToggleFavorite={handleToggleFavorite}
          onToggleModelFavorite={handleToggleModelFavorite}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          searchQuery={searchQuery}
          lastFetchTimeMs={lastFetchTimeMs}
          prAuthAvailable={prAuthAvailable}
        />
      </PageErrorBoundary>
    );
  };

  if (!initialLoadComplete) {
    return (
      <>
        <DashboardLoader stage={loadingStage} />
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  const showOnboardingResumeCard = !modalManager.modelOnboardingOpen && isOnboardingResumable();
  const showPostOnboardingRecommendations =
    !modalManager.modelOnboardingOpen &&
    !showOnboardingResumeCard &&
    isOnboardingCompleted() &&
    !isPostOnboardingDismissed();

  return (
    <>
      <Header
        isElectron={isElectron}
        onOpenSettings={isMobile ? openSettingsWithHistory : handleOpenSettings}
        onOpenGitHubImport={isMobile ? openGitHubImportWithHistory : modalManager.openGitHubImport}
        onOpenPlanning={isMobile ? openPlanningWithHistory : modalManager.openPlanning}
        onResumePlanning={isMobile ? resumePlanningWithHistory : modalManager.resumePlanning}
        activePlanningSessionCount={bgPlanningSessions.length}
        onOpenUsage={isMobile ? openUsageWithHistory : modalManager.openUsage}
        onOpenActivityLog={isMobile ? openActivityLogWithHistory : modalManager.openActivityLog}
        onOpenSystemStats={isMobile ? openSystemStatsWithHistory : modalManager.openSystemStats}
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        mailboxUnreadCount={mailboxUnreadCount}
        onOpenSchedules={isMobile ? openSchedulesWithHistory : modalManager.openSchedules}
        onOpenGitManager={isMobile ? openGitManagerWithHistory : modalManager.openGitManager}
        onOpenNodes={isMobile ? handleOpenNodesWithHistory : handleOpenNodes}
        showNodesButton={nodesEnabled}
        onOpenWorkflowSteps={isMobile ? openWorkflowStepsWithHistory : modalManager.openWorkflowSteps}
        onOpenScripts={isMobile ? openScriptsWithHistory : modalManager.openScripts}
        onRunScript={isMobile ? runScriptWithHistory : modalManager.runScript}
        onToggleTerminal={isMobile ? toggleTerminalWithHistory : modalManager.toggleTerminal}
        onOpenFiles={isMobile ? openFilesWithHistory : modalManager.openFiles}
        filesOpen={modalManager.filesOpen}
        onOpenTodos={isMobile ? openTodosWithHistory : modalManager.openTodos}
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
          roadmap: roadmapEnabled,
          memoryView: memoryEnabled,
          devServer: devServerEnabled,
          devServerView: devServerEnabled,
          researchView: researchEnabled,
        }}
        pluginDashboardViews={pluginDashboardViews}
        shellConnectionControl={shellApi && shellState.host !== "web" ? (
          <NativeShellConnectionStatus state={shellState} onManage={() => setShellConnectionManagerOpen(true)} />
        ) : undefined}
      />
      {viewMode === "project" && currentProject && !nodesOpen && taskView !== "missions" && !modalManager.isPlanningOpen && !sessionBannersHidden && (
        <SessionNotificationBanner
          sessions={sessionsNeedingInput}
          onResumeSession={handleOpenBackgroundSession}
          onDismissSession={handleDismissNeedingInputSession}
          onDismissAll={handleDismissAllNeedingInputSessions}
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
      {viewMode === "project" && currentProject && !setupReadinessLoading && hasWarnings && !setupWarningDismissed && (
        <SetupWarningBanner
          hasAiProvider={hasAiProvider}
          hasGithub={hasGithub}
          onDismiss={handleDismissSetupWarning}
        />
      )}
      <div
        className={`project-content${viewMode === "project" && currentProject ? " project-content--with-footer" : ""}${isMobile && !mobileKeyboardOpen ? " project-content--with-mobile-nav" : ""}`}
      >
        {renderMainContent()}
      </div>
      {viewMode === "project" && currentProject && !nodesOpen && (
        <ExecutorStatusBar
          tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
          projectId={currentProject.id}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          backgroundSessions={bgSessions}
          backgroundGenerating={bgGenerating}
          backgroundNeedsInput={bgNeedsInput}
          onOpenBackgroundSession={handleOpenBackgroundSession}
          onDismissBackgroundSession={bgDismiss}
          lastFetchTimeMs={lastFetchTimeMs}
          currentProjectPath={currentProject.path}
          onOpenProjectDirectory={handleOpenProjectDirectory}
        />
      )}
      <MobileNavBar
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : () => {}}
        footerVisible={viewMode === "project" && !!currentProject}
        modalOpen={modalManager.anyModalOpen}
        keyboardOpen={mobileKeyboardOpen}
        onOpenSettings={isMobile ? openSettingsWithHistory : handleOpenSettings}
        onOpenActivityLog={isMobile ? openActivityLogWithHistory : modalManager.openActivityLog}
        onOpenSystemStats={isMobile ? openSystemStatsWithHistory : modalManager.openSystemStats}
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        onOpenNodes={isMobile ? handleOpenNodesWithHistory : handleOpenNodes}
        mailboxUnreadCount={mailboxUnreadCount}
        onOpenGitManager={isMobile ? openGitManagerWithHistory : modalManager.openGitManager}
        onOpenWorkflowSteps={isMobile ? openWorkflowStepsWithHistory : modalManager.openWorkflowSteps}
        onOpenSchedules={isMobile ? openSchedulesWithHistory : modalManager.openSchedules}
        onOpenScripts={isMobile ? openScriptsWithHistory : modalManager.openScripts}
        onToggleTerminal={isMobile ? toggleTerminalWithHistory : modalManager.toggleTerminal}
        onOpenFiles={isMobile ? openFilesWithHistory : modalManager.openFiles}
        onOpenTodos={isMobile ? openTodosWithHistory : modalManager.openTodos}
        todosOpen={modalManager.todosOpen}
        onOpenGitHubImport={isMobile ? openGitHubImportWithHistory : modalManager.openGitHubImport}
        onOpenPlanning={isMobile ? openPlanningWithHistory : modalManager.openPlanning}
        onResumePlanning={isMobile ? resumePlanningWithHistory : modalManager.resumePlanning}
        activePlanningSessionCount={bgPlanningSessions.length}
        onOpenUsage={isMobile ? () => openUsageWithHistory(null) : () => modalManager.openUsage(null)}
        onViewAllProjects={handleViewAllProjects}
        onRunScript={isMobile ? runScriptWithHistory : modalManager.runScript}
        projectId={currentProject?.id}
        showSkillsTab={skillsEnabled}
        experimentalFeatures={{
          insights: insightsEnabled,
          roadmap: roadmapEnabled,
          memoryView: memoryEnabled,
          devServer: devServerEnabled,
          devServerView: devServerEnabled,
          todoView: todosEnabled,
          researchView: researchEnabled,
          nodesView: nodesEnabled,
        }}
        pluginDashboardViews={pluginDashboardViews}
        shellConnectionControl={shellApi && shellState.host !== "web" ? (
          <NativeShellConnectionStatus state={shellState} onManage={() => setShellConnectionManagerOpen(true)} />
        ) : undefined}
      />
      {viewMode === "project" && currentProject && taskView !== "chat" && taskView !== "mailbox" && taskView !== "insights" && taskView !== "devserver" && taskView !== "dev-server" && !isPluginViewId(taskView) && (
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
        taskOperations={{ moveTask, deleteTask, mergeTask, retryTask, resetTask, duplicateTask }}
        deepLink={{ handleDetailClose }}
        settings={{ prAuthAvailable, themeMode, colorTheme, dashboardFontScalePct, setThemeMode, setColorTheme, setDashboardFontScalePct }}
        onSettingsClose={handleSettingsClose}
        onReopenOnboarding={isMobile ? reopenOnboardingWithHistory : () => {
          modalManager.closeSettings();
          modalManager.openModelOnboarding();
        }}
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
  );
}

export function App() {
  return (
    <ToastProvider>
      <ShellProvider>
        <NodeProvider>
          <ConfirmDialogProvider>
            <AppInner />
          </ConfirmDialogProvider>
        </NodeProvider>
      </ShellProvider>
    </ToastProvider>
  );
}
