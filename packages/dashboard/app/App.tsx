import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, lazy, Suspense, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  type Task,
  type TaskDetail,
  type WorkflowStep,
  WHITEBOARD_VIEW_FLAG,
  isExperimentalFeatureEnabled,
} from "@fusion/core";
import { Header, useViewportMode } from "./components/Header";
import { isMobileShellMode } from "./hooks/useViewportMode";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
import {
  DashboardWindowManagerProvider,
  DashboardWindowManagerScope,
  useDashboardWindowBottomDockReservation,
  useDashboardWindowGroupVisible,
  useDashboardWindowVisibility,
} from "./context/DashboardWindowManagerContext";
import {
  AppTaskPopoutWindows,
  useAppMainPanelTaskDetailState,
  useAppPoppedOutTaskState,
} from "./components/TaskDetailHostBoundaries";
import { PlanningDrawer, ProjectsDrawer } from "./components/MobileDrawer";
import { PoppedOutChatWindows } from "./components/PoppedOutChatWindows";
import { PoppedOutNoteWindows } from "./components/PoppedOutNoteWindows";
import { AppModals, openAppFileInBrowser } from "./components/AppModals";
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
import { DesktopActionBar } from "./components/DesktopActionBar";
import { buildDashboardNavigationEntries } from "./components/dashboardNavigationEntries";
import { resolveNavigationQuickAccessEntryIds } from "../../core/src/board/mobile-nav-primary-items";
import { useRightDockController, type RightDockControllerInput } from "./components/useRightDockController";
import { ToastContainer } from "./components/ToastContainer";
import { ProjectOverview } from "./components/ProjectOverview";
import { useBackgroundSessions } from "./hooks/useBackgroundSessions";
import { useGitHubStarPromptState, markGitHubStarPromptShown, refreshGitHubStarPromptDismissal } from "./hooks/useGitHubStarPrompt";
import { useSessionBannersHidden } from "./hooks/useSessionBannerPref";
import { useTasks } from "./hooks/useTasks";
import { useBoardWorkflows } from "./hooks/useBoardWorkflows";
import type { ExecutorColumnFlags } from "./hooks/useExecutorStats";
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
import { QuickAddSubmitOnEnterProvider } from "./hooks/useQuickAddSubmitOnEnter";
import { useDeepLink } from "./hooks/useDeepLink";
import { useFavorites } from "./hooks/useFavorites";
import { useAuthOnboarding } from "./hooks/useAuthOnboarding";
import { useMobileKeyboard } from "./hooks/useMobileKeyboard";
import { useKeyboardFocusPending } from "./hooks/useKeyboardFocusPending";
import { useMobileKeyboardViewportLock, useMobileViewportRestoreReset } from "./hooks/useMobileScrollLock";
import { computeMobileBarKeyboardFlags } from "./utils/mobileBarKeyboardFlags";
import { recordActivity } from "./utils/activity-trace";
import { closeViewShortcut, readShortcutAnchorRect, resolveChatListShortcutTarget, retainViewNavRevert } from "./utils/dashboardShortcutToggles";
import { normalizeNavigationPlacement, resolveChatHost, resolveNavigationSurfaces } from "./utils/navigationPlacement";
/* FNXC:HeaderNavigationOwnership 2026-09-17-02:14: FN-481 — table de décision partagée entre le Header et la pill. */
import { resolveHeaderNavigationOwnership } from "./utils/headerNavigationOwnership";
/* FNXC:ToolSurfaces 2026-09-15-16:04: FN-426 — one decider for retired standalone tool destinations. */
import { isRedirectedToolSurface, resolveToolSurfaceRoute } from "./utils/toolSurfaceRouting";
import { DashboardToolPopover } from "./components/DashboardToolPopover";
import { ActivityLogModal } from "./components/ActivityLogModal";
/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426: stable ids shared by each trigger's `aria-controls` and its panel, so assistive technology can follow the
relationship without the Header and App inventing two different strings.
*/
const ACTIVITY_TOOL_PANEL_ID = "dashboard-activity-panel";
const NOTES_TOOL_PANEL_ID = "dashboard-notes-panel";
const CHAT_TOOL_PANEL_ID = "dashboard-chat-panel";
import type { SectionId as GitManagerSectionId } from "./components/GitManagerModal";
import { useSetupReadiness } from "./hooks/useSetupReadiness";
import { useGithubSetupWarningDelay } from "./hooks/useGithubSetupWarningDelay";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useViewState, type TaskView } from "./hooks/useViewState";
import { NavigationHistoryProvider, useNavigationHistory } from "./hooks/useNavigationHistory";
import { usePluginDashboardViews } from "./hooks/usePluginDashboardViews";
import { isPluginViewId, isPluginViewRegistered } from "./plugins/pluginViewRegistry";
import { registerBundledPluginViews } from "./plugins/registerBundledPluginViews";
import { useProjectActions } from "./hooks/useProjectActions";
import { useDesktopViewWindows } from "./hooks/useDesktopViewWindows";
import { useNotes } from "./hooks/useNotes";
import { useTaskHandlers } from "./hooks/useTaskHandlers";
import { useRemoteNodeData } from "./hooks/useRemoteNodeData";
import { useRemoteNodeEvents } from "./hooks/useRemoteNodeEvents";
import { isLikelyTabSuspensionError } from "./hooks/visibilitySuspension";
import { NodeProvider, useNodeContext } from "./context/NodeContext";
import { FileBrowserProvider } from "./context/FileBrowserContext";
import { ShellProvider } from "./context/ShellContext";
import { RetryWarningProvider } from "./context/RetryWarningContext";
import { CostBadgeProvider } from "./context/CostBadgeContext";
import { ChatMessageLayoutProvider } from "./context/ChatMessageLayoutContext";
import { ChatSubmitOnEnterProvider } from "./context/ChatSubmitOnEnterContext";
import { ShellHostProvider, useShellHostContext } from "./context/ShellHostContext";
import { useShellConnection } from "./hooks/useShellConnection";
import { useStashOrphanCount } from "./hooks/useStashOrphanCount";
import { useChatUnreadBadge } from "./hooks/useChatUnreadBadge";
import { useMailboxUnread } from "./hooks/useMailboxUnread";
import { useApprovalBanner } from "./hooks/useApprovalBanner";
import { useDashboardHealth } from "./hooks/useDashboardHealth";
import { useAuthTokenRecovery } from "./hooks/useAuthTokenRecovery";
import { useScopedDismissFlag } from "./hooks/useScopedDismissFlag";
import { useCapacityRiskBanner } from "./hooks/useCapacityRiskBanner";
import { useBoardScrollRestore } from "./hooks/useBoardScrollRestore";
import type { PoppedOutTaskEntry } from "./hooks/usePoppedOutTasks";
import { usePoppedOutChats, type PoppedOutChatEntry } from "./hooks/usePoppedOutChats";
import { usePoppedOutNotes } from "./hooks/usePoppedOutNotes";
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
  shouldShowSessionInBanner,
  getCliActionDisabledReasonForBanner,
  executeCliSessionBannerAction,
} from "./utils/appLifecycle";
// Re-export the unit-tested lifecycle helpers so existing `from "./App"` /
// `from "./App"` imports keep resolving after the bodies moved to utils.
export {
  didEnterAwaitingApproval,
  didEnterDone,
  requiresNativeShellOnboarding,
  shouldShowFirstEverBootLoader,
  isSessionNeedingInputForBanner,
  shouldShowSessionInBanner,
  getCliActionDisabledReasonForBanner,
  executeCliSessionBannerAction,
} from "./utils/appLifecycle";
import { subscribeSse } from "./sse-bus";
import { AuthTokenRecoveryPage } from "./components/AuthTokenRecoveryPage";
import {
  AppMainPanelTaskDetailComposition,
  MainContentListView,
  type AppMainPanelTaskDetailMainContentProps,
} from "./components/dashboard/MainContent";
import { PlanningKeepAlive } from "./components/dashboard/PlanningKeepAlive";
import { NATIVE_STRUCTURE_OPEN_EVENT, type NativeStructureOpenEventDetail } from "./components/nativeStructureNavigation";
import { DashboardBanners } from "./components/dashboard/DashboardBanners";
import type { DashboardBannersProps } from "./components/dashboard/types";
import type { GraphWorkflowSelection } from "./components/GraphWorkflowSwitcherSlot";

// ChatView's CSS is imported eagerly so the styles bundle into the main
// CSS file. Without this, the lazy ChatView JS chunk loaded its own CSS
// link asynchronously, producing a brief flash of unstyled chat UI on
// first render.
import "./components/ChatView.css";
import { useChatMailReportRouting } from "./components/chatReportHandoff";

const IS_TEST_ENV = import.meta.env.MODE === "test";

const AgentsView = lazy(() => import("./components/AgentsView").then((m) => ({ default: m.AgentsView })));
const NotesView = lazy(() => import("./components/NotesView").then((m) => ({ default: m.NotesView })));
/* FNXC:WhiteboardAlpha 2026-09-10-05:42: Keep every Whiteboard-owned module behind this destination-only boundary; unlike ordinary lazy views it is intentionally excluded from idle prefetch. */
const WhiteboardView = lazy(() => import("./components/WhiteboardView").then((m) => ({ default: m.WhiteboardView })));
const InsightsView = lazy(() => import("./components/InsightsView").then((m) => ({ default: m.InsightsView })));
const ResearchView = lazy(() => import("./components/ResearchView").then((m) => ({ default: m.ResearchView })));
const EvalsView = lazy(() => import("./components/EvalsView").then((m) => ({ default: m.EvalsView })));
const ChatView = lazy(() => import("./components/ChatView").then((m) => ({ default: m.ChatView })));

const SkillsView = lazy(() => import("./components/SkillsView").then((m) => ({ default: m.SkillsView })));
const SnippetsView = lazy(() => import("./components/SnippetsView").then((m) => ({ default: m.SnippetsView })));
const MemoryView = lazy(() => import("./components/MemoryView").then((m) => ({ default: m.MemoryView })));
const SecretsView = lazy(() => import("./components/SecretsView").then((m) => ({ default: m.SecretsView })));
const CommandCenter = lazy(() => import("./components/command-center/CommandCenter").then((m) => ({ default: m.CommandCenter })));
const DevServerView = lazy(() => import("./components/DevServerView").then((m) => ({ default: m.DevServerView })));
const GoalsView = lazy(() => import("./components/GoalsView").then((m) => ({ default: m.GoalsView })));
const PullRequestView = lazy(() => import("./components/PullRequestView").then((m) => ({ default: m.PullRequestView })));
/*
FNXC:Navigation 2026-09-15-05:29:
Import Tasks (GitHub import) and Automations render as embedded main-content views via these lazy chunks; the same components still mount as modals in AppModals for the mobile overflow path. Workflows no longer has a modal twin — FN-407 made the embedded view its only presentation.
*/
/*
FNXC:DashboardLazyViews 2026-09-15-05:29:
The leading-underscore convention marks an embedded main-content presentation that REUSES a chunk already curated elsewhere, so `extractAppLazyViews` (which filters `_`-prefixed names) counts each heavy chunk once. It still applies to _ImportTasksView, _AutomationsView, and _SettingsView, whose chunks are also mounted as modals in AppModals.

FN-407 RE-HOMED WorkflowNodeEditor here. AppModals no longer declares or mounts it, so this is now its ONLY lazy declaration and therefore its curation site — hence no underscore. The MainContentProps key deliberately keeps the historical `_WorkflowEditorView` name and is passed explicitly below, so the re-homing does not ripple a rename through dashboard/types.ts, MainContent.tsx, and their tests.
*/
const WorkflowNodeEditor = lazy(() => import("./components/WorkflowNodeEditor").then((m) => ({ default: m.WorkflowNodeEditor })));
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
    void import("./components/NotesView");
    void import("./components/InsightsView");
    void import("./components/ResearchView");
    void import("./components/EvalsView");
    void import("./components/ChatView");

    void import("./components/SkillsView");
    void import("./components/SnippetsView");
    void import("./components/MemoryView");
    void import("./components/SecretsView");
    void import("./components/command-center/CommandCenter");
    void import("./components/DevServerView");
    void import("./components/GoalsView");
    void import("./components/PullRequestView");
  });
}

registerBundledPluginViews();

/*
FNXC:ViewportChrome 2026-08-23-18:14:
App-level keyboard state follows Fusion's viewport-mode classification rather than useMobileKeyboard's <=768px heuristic. Landscape phones render the nav in mobile mode; this production seam keeps that path executable in tests.
*/
export function useMobileBarKeyboardState({
  isMobile,
  anyModalOpen,
  overlayOpen,
}: {
  isMobile: boolean;
  anyModalOpen: boolean;
  overlayOpen: boolean;
}) {
  const keyboardMetrics = useMobileKeyboard({ enabled: isMobile, allowNonMobileViewport: isMobile });
  const keyboardFocusPending = useKeyboardFocusPending(isMobile) || false;
  const navigationViewport = keyboardMetrics.navigationViewport ?? {
    active: keyboardMetrics.keyboardOpen,
    keyboardOverlap: keyboardMetrics.keyboardOverlap,
    viewportHeight: keyboardMetrics.viewportHeight,
    viewportOffsetTop: keyboardMetrics.viewportOffsetTop,
  };
  return {
    ...keyboardMetrics,
    keyboardOverlap: navigationViewport.keyboardOverlap,
    viewportHeight: navigationViewport.viewportHeight,
    viewportOffsetTop: navigationViewport.viewportOffsetTop,
    keyboardFocusPending,
    ...computeMobileBarKeyboardFlags({
      isMobile,
      keyboardOpen: keyboardMetrics.keyboardOpen,
      keyboardFocusPending,
      navigationViewportActive: navigationViewport.active,
      anyModalOpen,
      overlayOpen,
    }),
  };
}

export type BoardTaskOpenRoute = "popup" | "main-panel";

/*
FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
FN-442 removed the `openTasksInRightSidebar` and `openMobileTasksInPopup` project settings, so the board/list/detail-chip
task-open decision has exactly one input left: the floating task window is the unconditional route, and the main panel
survives only as the mobile-drawer fallback (phones keep one detail owner). The board-card entry into the right dock is
gone; `rightSidebarEnabled` and the dock's own task tools (`openTaskInDock`/`closeDockTask`) are untouched. The helper
stays exported so the decision remains unit-testable on its own.
*/
export function getBoardTaskOpenRoute(options: { mobileDrawerActive: boolean }): BoardTaskOpenRoute {
  return options.mobileDrawerActive ? "main-panel" : "popup";
}

export type CoexistingTaskOpenRoute = "task-window" | "main-panel";

/*
FNXC:HistoryModalSurface 2026-09-15-19:12:
FN-428: opening a task from a coexisting surface (History) must never mount the blocking modal presentation. Desktop and tablet route to a coexisting task window; mobile routes to the main panel because task pop-outs are deliberately purged there (one detail owner on mobile).
*/
export function getCoexistingTaskOpenRoute(options: { mobileDrawerActive: boolean }): CoexistingTaskOpenRoute {
  return options.mobileDrawerActive ? "main-panel" : "task-window";
}

export interface DashboardShortcutPopupState {
  poppedOutTaskEntries: Array<Pick<PoppedOutTaskEntry, "task">>;
  poppedOutChatEntries: Array<Pick<PoppedOutChatEntry, "projectId" | "session">>;
  poppedOutNoteEntries?: Array<{ projectId: string; note: { id: string } }>;
  windowsGloballyHidden?: boolean;
  terminalOpen: boolean;
  modalClosers: Array<[boolean, () => void]>;
}

export interface DashboardShortcutPopupHandlers {
  closePoppedOutTask: (taskId: string) => void;
  closePoppedOutChat: (projectId: string, sessionId: string) => void;
  closePoppedOutNote?: (projectId: string, noteId: string) => void;
  closeTerminal: () => void;
}

/*
FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392 removes per-view task-popup gating entirely. A task window is project-scoped, not view-scoped: it stays mounted
and visible in every view of the active project, so no predicate or composite (task, view) identity key remains.
*/

/*
FNXC:ChatWindows 2026-09-14-11:35:
App owns detached Chat and Notes windows for every wide shell. Conversation identities are project-scoped and deduplicated; the exposed Chat set records only an existing window because global visibility replaces chat-only minimization.
*/
export function useAppDesktopRightDockWindows(
  projectId?: string,
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: the dock's Chat list delegates conversation identity to this project-scoped owner. A pending external prefill
  is claimed here so exactly the opened or created window receives it; an undefined project creates nothing at all.
  */
  consumePendingComposerPrefill?: () => string | undefined,
) {
  const chats = usePoppedOutChats();
  const notes = usePoppedOutNotes();
  const openSessionInNewWindow = useCallback((session: import("./hooks/useChat").ChatSessionInfo) => {
    if (!projectId) return;
    const composerPrefill = consumePendingComposerPrefill?.();
    chats.popOut(projectId, session, composerPrefill ? { composerPrefill } : undefined);
  }, [chats.popOut, consumePendingComposerPrefill, projectId]);
  const openNoteInWindow = useCallback((note: import("@fusion/core").ProjectNoteSummary) => {
    if (projectId) notes.popOut(projectId, note);
  }, [notes.popOut, projectId]);
  const openChatWindows = useMemo(() => {
    const sessionIds = new Set<string>();
    if (!projectId) return sessionIds;
    for (const entry of chats.entries) {
      if (entry.projectId === projectId) sessionIds.add(entry.session.id);
    }
    return sessionIds;
  }, [chats.entries, projectId]);

  return { chats, notes, openSessionInNewWindow, openNoteInWindow, openChatWindows };
}

export interface AppDesktopRightDockCompositionInput {
  projectId?: string;
  owner: ReturnType<typeof useAppDesktopRightDockWindows>;
  controllerInput: Omit<RightDockControllerInput,
    | "projectId"
    | "onOpenSessionInNewWindow"
    | "openChatWindows"
    | "onOpenNote"
  >;
  chatWindowProps: Omit<import("./components/PoppedOutChatWindows").PoppedOutChatWindowsProps,
    | "entries"
    | "projectId"
    | "onClose"
    | "onOpenSessionInNewWindow"
    | "onSessionSynced"
  >;
  noteWindowProps: Omit<import("./components/PoppedOutNoteWindows").PoppedOutNoteWindowsProps,
    | "entries"
    | "projectId"
    | "onClose"
  >;
}

/*
FNXC:DesktopRightDock 2026-09-12-05:14:
Le shell App et la régression d’intégration doivent appeler la même frontière de composition. Elle câble elle-même les callbacks Chat/Notes dans le vrai contrôleur du dock et produit les fenêtres correspondantes, afin qu’une omission dans ce chemin de production fasse échouer le test au lieu de rester masquée par un harness qui réassemble les pièces.
*/
export function useAppDesktopRightDockComposition({
  projectId,
  owner,
  controllerInput,
  chatWindowProps,
  noteWindowProps,
}: AppDesktopRightDockCompositionInput) {
  const rightDock = useRightDockController({
    ...controllerInput,
    projectId,
    onOpenSessionInNewWindow: owner.openSessionInNewWindow,
    openChatWindows: owner.openChatWindows,
    onOpenNote: owner.openNoteInWindow,
  });
  /*
  FNXC:ProjectNotes 2026-09-15-03:29:
  FN-404 : les Notes n’ont aucun abonnement SSE ; leur source vivante est le `notesController` déjà partagé par la page
  Notes et la liste du dock. Chaque publication de cette liste resynchronise en place l’instantané des fenêtres
  détachées du projet courant, de sorte qu’un renommage externe atteigne leur titre sans toucher `focusNonce` ni
  l’ordre d’activation. Après un enregistrement effectué par la fenêtre elle-même, la révision publiée égale celle déjà
  chargée, donc aucune re-sélection n’est déclenchée et aucune boucle n’est possible.
  */
  const liveNotes = controllerInput.notesController?.notes;
  const syncNote = owner.notes.syncNote;
  useEffect(() => {
    if (!projectId || !liveNotes) return;
    for (const summary of liveNotes) syncNote(projectId, summary);
  }, [liveNotes, projectId, syncNote]);
  const windows = projectId ? (
    <>
      <PoppedOutNoteWindows
        {...noteWindowProps}
        entries={owner.notes.entries}
        projectId={projectId}
        onClose={owner.notes.close}
      />
      <PoppedOutChatWindows
        {...chatWindowProps}
        entries={owner.chats.entries}
        projectId={projectId}
        onClose={owner.chats.close}
        onOpenSessionInNewWindow={owner.openSessionInNewWindow}
        /*
        FNXC:ChatWindows 2026-09-14-23:48:
        FN-396: a detached window keeps its own conversation identity current, so a rename repaints its header and
        accessible name without the operator closing and reopening the window.
        */
        onSessionSynced={owner.chats.syncSession}
      />
    </>
  ) : null;
  return { rightDock, windows };
}

/*
FNXC:DashboardShortcuts 2026-07-04-12:02:
The App-level Escape close order is factored into a pure helper so regression tests can prove the real dashboard shell ordering without rendering every lazy dashboard surface. The helper must close exactly one surface and return false when no popup is open so component-local Escape handlers remain authoritative.

FNXC:DashboardShortcuts 2026-09-02-05:24:
Escape must never dismiss a chat window the operator cannot see, mirroring the existing visible-only rule for task pop-outs while preserving the surrounding close order.
*/
export function closeTopmostDashboardPopupForShortcut(
  state: DashboardShortcutPopupState,
  handlers: DashboardShortcutPopupHandlers,
): boolean {
  if (state.windowsGloballyHidden) return false;
  const lastPoppedOutTask = state.poppedOutTaskEntries[state.poppedOutTaskEntries.length - 1];
  if (lastPoppedOutTask) {
    handlers.closePoppedOutTask(lastPoppedOutTask.task.id);
    return true;
  }
  const lastPoppedOutNote = state.poppedOutNoteEntries?.at(-1);
  if (lastPoppedOutNote && handlers.closePoppedOutNote) {
    handlers.closePoppedOutNote(lastPoppedOutNote.projectId, lastPoppedOutNote.note.id);
    return true;
  }
  const lastPoppedOutChat = state.poppedOutChatEntries.at(-1);
  if (lastPoppedOutChat) {
    handlers.closePoppedOutChat(lastPoppedOutChat.projectId, lastPoppedOutChat.session.id);
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
  const dashboardWindowVisibility = useDashboardWindowVisibility();
  const chatSurfaceVisible = useDashboardWindowGroupVisible("chat");
  useEffect(() => {
    const latest = toasts[toasts.length - 1];
    if (latest) recordActivity({ kind: latest.type === "error" ? "error" : "toast", label: latest.message });
  }, [toasts]);
  const { shellApi, state: shellState, ready: shellReady, openConnectionManagerSignal } = useShellConnection();
  const shellHost = useShellHostContext();

  // Warm lazy view chunks during browser idle so first navigation is instant.
  useEffect(() => {
    prefetchLazyViews();
  }, []);

  // Project management hooks - MUST be called before any conditional logic
  const { projects, loading: projectsLoading, error: projectsError, refresh: refreshProjects } = useProjects();
  const hasEverLoadedProjectsRef = useRef(projects.length > 0);
  const { nodes, loading: nodesLoading } = useNodes();

  useEffect(() => {
    if (projects.length > 0) {
      hasEverLoadedProjectsRef.current = true;
    }
  }, [projects.length]);

  // Node context for local/remote node switching - must be called before useCurrentProject
  const { currentNode, currentNodeId, isRemote, setCurrentNode, clearCurrentNode } = useNodeContext();

  // Current project with node-aware persistence
  const { currentProject, setCurrentProject, clearCurrentProject, loading: currentProjectLoading } = useCurrentProject(projects, { nodeId: currentNodeId, projectsLoading });
  /* FNXC:DesktopViewWindows 2026-09-11-19:35: App owns one Notes controller across page/window presentation changes so a dirty draft and conflict cannot be reset by responsive chrome changes. */
  const notesController = useNotes(currentProject?.id);

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
  
  // Resolve a persisted node identity once its current list response arrives.
  // Destructive missing-node fallback is intentionally deferred until the
  // project-scoped Notes guard exists below.
  useEffect(() => {
    if (!currentNodeId || currentNode || nodesLoading) return;
    const foundNode = nodes.find((node) => node.id === currentNodeId);
    if (foundNode) setCurrentNode(foundNode);
  }, [currentNodeId, currentNode, nodes, nodesLoading, setCurrentNode]);
  
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
      /*
      FNXC:PluginEvents 2026-07-26-16:46:
      Resync contract (see SseSubscription in sse-bus.ts). This subscription is a pure relay: it parses
      `plugin:custom`, filters by pluginId, and hands the payload to the plugin view's callback. It
      holds no state of its own, so there is nothing here to refetch — and the host cannot synthesize a
      refetch for the plugin either, because `plugin:custom` payloads are opaque and no generic
      "current plugin state" endpoint exists. Adding a refetch here would only add a request to the
      visible-edge burst without correcting anything, so this takes the documented replaySafe opt-out.
      RESIDUAL RISK, stated deliberately: a plugin view that accumulates state purely from these events
      still diverges across a hidden-suspend gap. The fix belongs in the plugin surface, which must
      resync when its own view remounts or through its own authoritative fetch; the relay cannot do it.
      */
      return subscribeSse(`/api/events${query}`, {
        replaySafe: {
          reason:
            "relay-only: no host state; plugin:custom payloads are opaque so the host has no authoritative refetch, plugin views own their resync",
        },
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
  const { themeMode, colorTheme, uiStyle, dashboardFontScalePct, shadcnCustomColors, resolvedThemeMode, setThemeMode, setColorTheme, setUiStyle, setDashboardFontScalePct, setShadcnCustomColors } = useTheme();

  // Background AI sessions - required before useModalManager
  const { sessions: bgSessions, planningSessions: bgPlanningSessions } = useBackgroundSessions(currentProject?.id);
  /*
   * FNXC:SessionBanner 2026-07-16-20:55:
   * FN-8229 replaces the removed footer AI pill with this banner feed. It keeps
   * non-planning generating and error sessions observable while Planning owns
   * all of its statuses through the docked view and navigation badge.
   */
  const sessionsNeedingInput = bgSessions.filter(shouldShowSessionInBanner);
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
  /*
  FNXC:Navigation 2026-09-16-19:44:
  FN-468 : `mobileShellActive` décide la PROPRIÉTÉ DU SHELL DE NAVIGATION — vrai sous 1024 px, téléphone ET
  tablette — tandis que `isMobile` reste réservé au téléphone pour le clavier virtuel, les drawers plein écran,
  les tâches détachées et les restaurations de viewport. Les deux ne doivent jamais être confondus : élargir
  `isMobile` à la tablette transformerait la tablette en téléphone pour la géométrie tactile, ce que FN-468
  interdit explicitement.
  */
  const mobileShellActive = isMobileShellMode(viewportMode);

  // Navigation history for browser back button (desktop + mobile).
  /*
  FNXC:Navigation 2026-09-14-19:51:
  Publish the hook's memoized result as the provider value. A fresh object literal here re-ran every consumer's
  context-dependent effects on each App render — which replayed MobileNavBar's opening focus and reset the mobile
  navigation popover's scroll position mid-tap.
  */
  const navigationHistory = useNavigationHistory({ enabled: true });
  const { pushNav, replaceCurrent, removeNav, promoteNav } = navigationHistory;
  const viewNavRevertRef = useRef(new Map<TaskView, (() => void)[]>());

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

  useEffect(() => {
    recordActivity({ kind: "view", label: String(viewMode) });
  }, [viewMode]);
  useEffect(() => {
    /*
    FNXC:ReportPipeline 2026-07-18-12:50:
    Report traces must retain uncaught client errors independently of toast UI.
    Window errors reveal failures that never produce a typed error toast.
    */
    const recordError = (event: ErrorEvent) => recordActivity({ kind: "error", label: event.message });
    window.addEventListener("error", recordError);
    return () => window.removeEventListener("error", recordError);
  }, []);

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

  /*
  FNXC:DashboardShortcuts 2026-07-16-00:00:
  FN-8069 makes Settings and Command Center shortcuts true toggles. Retain the exact view-revert callback pushed to navigation history so a shortcut can remove that identity-matched entry and restore the captured prior view for shortcut and Header/MobileNavBar opens alike; the callback deletes itself for shortcut close and Browser Back paths (Runfusion/Fusion#2118).
  */
  const desktopWindowRouterRef = useRef<(view: TaskView) => boolean>(() => false);
  const commitTaskViewChange = useCallback((newView: TaskView) => {
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
      const revert = retainViewNavRevert(
        newView,
        previousView,
        viewNavRevertRef.current,
        handleChangeTaskView,
      );
      pushNav({ type: "view", revert });
    }
  }, [handleChangeTaskView, taskView, pushNav]);
  /*
  FNXC:ListInRightDock 2026-09-14-04:42:
  FN-382: on every non-mobile host List is a dock tool, not a page. An explicit request for it — sidebar, footer,
  header toggle, a stored view or a `?view=list` deep link — selects the dock tool and opens the dock, leaving the
  current destination on screen and writing no navigation entry. Phone hosts are untouched: they keep the dedicated
  route, both nav producers and the drawer. When the dock is unavailable (no project shell, feature off) the ordinary
  route still answers, so the destination can never become unreachable.
  */
  /*
  FNXC:HistoryModalSurface 2026-09-15-04:29:
  FN-403: History has one open/close owner for every entry point — the Board complete-column action, the mobile
  navigation registry, a deep link and a persisted `patchnode` view all land here. Opening it never changes
  `taskView`, so the operator's current destination stays on screen, and it pushes exactly one navigation entry so
  Browser Back closes it.
  */
  const openHistoryWithNav = useCallback(() => {
    if (modalManager.historyOpen) return;
    modalManager.openHistory();
    pushNav({ type: "modal", close: modalManager.closeHistory });
  }, [modalManager, pushNav]);
  const closeHistoryWithNav = useCallback(() => {
    removeNav(modalManager.closeHistory);
    modalManager.closeHistory();
  }, [modalManager, removeNav]);

  const listDockRouteRef = useRef<((newView: TaskView) => boolean) | null>(null);
  const chatWindowRouteRef = useRef<((newView: TaskView) => boolean) | null>(null);
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: legacy tool destinations (`pull-requests`, `secrets`) still arrive from bookmarks, persisted views, restored
  history, and customized mobile items. They are answered by their NEW owner here — one decider, assigned below where
  the Settings opener exists — so no caller has to know the mapping and no destination gains a second owner.
  */
  const toolSurfaceRouteRef = useRef<((newView: TaskView) => boolean) | null>(null);
  const primaryChatWindowOpenRef = useRef(false);
  const closePrimaryChatWindowRef = useRef<(() => void) | null>(null);
  const handleTaskViewChange = useCallback((newView: TaskView) => {
    /* FNXC:HistoryModalSurface 2026-09-15-04:29: FN-403: a `patchnode` view request opens the History modal instead of navigating; History is no longer a destination. */
    if (newView === "patchnode") {
      openHistoryWithNav();
      return;
    }
    if (toolSurfaceRouteRef.current?.(newView)) return;
    if (chatWindowRouteRef.current?.(newView)) return;
    if (listDockRouteRef.current?.(newView)) return;
    if (!desktopWindowRouterRef.current(newView)) commitTaskViewChange(newView);
  }, [commitTaskViewChange, openHistoryWithNav]);

  /*
  FNXC:NativeStructureEmbed 2026-07-19-19:30:
  NativeStructurePreview deliberately reports callback/view-state destinations instead of URLs.
  Listen once at the dashboard root so cards from general, task-bound, floating, and dock chat
  open their owning view without duplicating navigation logic at any chat render call-site.
  */
  useEffect(() => {
    const openNativeStructure = (event: Event) => {
      const { payload } = (event as CustomEvent<NativeStructureOpenEventDetail>).detail;
      if (!payload?.available) return;
      const target = payload.openTarget;
      if (target.view === "missions") {
        // FNXC:NativeStructureEmbed 2026-07-20-01:00: Mission navigation resets stale selection
        // state. Navigate before setting this preview's target so the destination opens the
        // referenced mission rather than an unselected Missions view.
        handleTaskViewChange("missions");
        setMissionTargetId(target.missionId ?? target.id);
        return;
      }
      if (target.view === "goals") {
        handleTaskViewChange("goalsView");
        setGoalAnchorId(target.id);
        return;
      }
      if (target.view === "roadmaps") {
        // FNXC:NativeStructureEmbed 2026-07-19-12:45: Roadmap previews open the registered
        // plugin destination through TaskView state, never a synthetic URL deep-link.
        handleTaskViewChange("plugin:fusion-plugin-roadmap:roadmaps");
        return;
      }
      handleTaskViewChange(target.view);
    };
    window.addEventListener(NATIVE_STRUCTURE_OPEN_EVENT, openNativeStructure);
    return () => window.removeEventListener(NATIVE_STRUCTURE_OPEN_EVENT, openNativeStructure);
  }, [handleTaskViewChange]);

  // FNXC:DashboardLiveUpdates 2026-06-26-01:08:
  // SSE remains enabled only for board/list views to free connection slots for mission detail fetches. The false→true missed-event catch-up lives inside useTasks so App keeps the routing gate only and cannot double-fetch on task-view re-entry.
  const taskSseEnabled = taskView === "board" || taskView === "list";
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-03:50:
  HOISTED above `useTasks` so its planner-activity stamp can be a role question.

  The board-workflow payload is the only per-task trait source on this screen, and it depends on
  `projectId` alone — nothing about tasks — so reading it first is safe. `useTasks` previously gated
  that stamp on the literal `{triage, todo}` pair, which matches nothing on a renamed board, so the
  planning border and pulsing badge never appeared while the planner was working the card.

  REMOTE NODES GET NO FLAGS, deliberately: their rows belong to another store, so local
  board-workflow metadata must never be applied to their ids — the same rule the footer index below
  already follows. They keep the legacy fallback.
  */
  const { boardWorkflows: footerBoardWorkflows } = useBoardWorkflows({ projectId: currentProject?.id });
  const resolveTaskWorkflowId = useCallback((task: Task) => {
    if (isRemote || !footerBoardWorkflows) return undefined;
    return footerBoardWorkflows.taskWorkflowIds[task.id] ?? footerBoardWorkflows.defaultWorkflowId;
  }, [footerBoardWorkflows, isRemote]);

  const resolveTaskColumnFlagsForActivity = useCallback((task: Task) => {
    if (!footerBoardWorkflows) return undefined;
    const workflowId = resolveTaskWorkflowId(task);
    return footerBoardWorkflows.workflows
      .find((workflow) => workflow.id === workflowId)
      ?.columns.find((column) => column.id === task.column)?.flags;
  }, [footerBoardWorkflows, resolveTaskWorkflowId]);

  const { tasks, isStale, createTask, moveTask, boostTask, pauseTask, unpauseTask, deleteTask, mergeTask, retryTask, bypassReview, resetTask, updateTask, duplicateTask, revertTask, restoreTaskRevert, loadMoreCurrentTasks, retryCurrentTasksPagination, currentTasksTotal, currentTasksHasMore, currentTasksLoadingMore, currentTasksPaginationError, currentTasksProgressKey, loadMoreCompletedTasks, retryCompletedTasksPagination, completedCounts, completedHasMore, completedLoadingMore, completedPaginationError, completedProgressKey, ingestCreatedTasks, lastFetchTimeMs } = useTasks(
    {
      ...(currentProject ? { projectId: currentProject.id } : {}),
      searchQuery: searchQuery || undefined,
      sseEnabled: taskSseEnabled,
      resolveColumnFlags: resolveTaskColumnFlagsForActivity,
      resolveWorkflowId: resolveTaskWorkflowId,
    }
  );
  const remoteTaskRequestIdentity = isRemote
    ? `${currentNodeId ?? ""}\u0000${currentProject?.id ?? ""}`
    : null;
  const remoteTaskSourceRef = useRef<{
    identity: string | null;
    readiness: "ready" | "awaiting-load" | "loading";
  }>({
    identity: remoteTaskRequestIdentity,
    readiness: "ready",
  });
  const remoteTaskSource = remoteTaskSourceRef.current;
  if (remoteTaskSource.identity !== remoteTaskRequestIdentity) {
    remoteTaskSource.identity = remoteTaskRequestIdentity;
    remoteTaskSource.readiness = isRemote ? "awaiting-load" : "ready";
  }
  if (isRemote && remoteData.loading) {
    remoteTaskSource.readiness = "loading";
  } else if (isRemote && !remoteData.error && remoteTaskSource.readiness === "loading") {
    remoteTaskSource.readiness = "ready";
  }
  /*
  FNXC:TaskSearchSource 2026-09-10-01:08:
  Remote task rows are authoritative even when the result is empty. A node or project change must first cross the remote hook's loading cycle, so rows retained from the preceding source can never leak into Board, List, the dock, or task-number suggestions.
  */
  const boardSourceTasks = !isRemote
    ? tasks
    : remoteTaskSource.readiness === "ready" && !remoteData.error
      ? remoteData.tasks
      : [];
  const footerTasks = boardSourceTasks;
  const footerColumnFlagsByTaskId = useMemo(() => {
    const index = new Map<string, ExecutorColumnFlags>();
    // FNXC:ConcurrencyIndicators 2026-08-04-10:00: remote tasks belong to a
    // different store, so local board-workflow metadata must never be applied to
    // their ids. Until the remote node supplies its own traits, use only the
    // documented literal fallback rather than fabricate custom lifecycle state.
    if (isRemote || !footerBoardWorkflows) return index;
    const workflowsById = new Map(footerBoardWorkflows.workflows.map((workflow) => [workflow.id, workflow]));
    // Build traits for the exact local rows supplied to the footer.
    for (const task of footerTasks) {
      const workflow = workflowsById.get(footerBoardWorkflows.taskWorkflowIds[task.id] ?? footerBoardWorkflows.defaultWorkflowId);
      const flags = workflow?.columns.find((column) => column.id === task.column)?.flags;
      if (flags) index.set(task.id, flags);
    }
    return index;
  }, [footerBoardWorkflows, footerTasks, isRemote]);
  /*
  FNXC:ConcurrencyIndicators 2026-08-03-12:00:
  FN-8453 threads board workflow traits into the footer so custom intake,
  complete, WIP, and merge columns share the same live-agent predicate as the engine.
  */

  /*
  FNXC:Navigation 2026-06-22-00:00:
  Snapshot of the task whose detail is shown in the main panel (Board card click → full-panel detail). Kept as a snapshot so the view survives a tasks revalidation; renderMainContent prefers the live row from `tasks` by id and falls back to this snapshot.

  FNXC:TaskDetail 2026-06-23-00:41:
  Board task-card secondary actions can deep-link into the inline main-panel task detail. Files-changed must land on the embedded Changes tab instead of reopening the task in the modal path.
  */
  const { capture: captureCurrentBoardScrollSnapshot, requestRestore } = useBoardScrollRestore(taskView);
  const mainPanelTaskDetail = useAppMainPanelTaskDetailState({
    taskView,
    changeTaskView: handleChangeTaskView,
    captureBoardScroll: captureCurrentBoardScrollSnapshot,
    requestBoardScrollRestore: requestRestore,
    pushNav,
    removeNav,
  });
  const {
    task: mainPanelDetailTask,
    open: openTaskDetailInMainPanel,
    close: closeTaskDetailMainPanel,
  } = mainPanelTaskDetail;
  /*
  FNXC:FloatingWindow 2026-07-15-15:20:
  FN-8016 identifies a popped-out task detail by task id plus origin view. The same task can therefore coexist in separate view-scoped FloatingWindows while re-opening it on one view refreshes only that entry.
  */
  const poppedOutTasks = useAppPoppedOutTaskState({ isMobile, pushNav, removeNav });
  const {
    entries: poppedOutTaskEntries,
    open: popOutTaskDetailForCurrentView,
    close: closePoppedOutTaskWithNav,
    closeAll: closeAllPoppedOutTasks,
    clearNavigation: clearPoppedOutTaskNavigation,
  } = poppedOutTasks;
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: on a wide host Chat is the dock LIST, which has no composer, so an external prefill is parked here and handed
  to the single conversation the operator then opens or creates. The mobile Chat route keeps consuming the state value
  directly. The pending text is consumed exactly once, so it never leaks into a second conversation.
  */
  const pendingChatComposerPrefillRef = useRef<string | undefined>(undefined);
  const consumePendingChatComposerPrefill = useCallback(() => {
    const pending = pendingChatComposerPrefillRef.current;
    pendingChatComposerPrefillRef.current = undefined;
    return pending;
  }, []);
  const appRightDockWindows = useAppDesktopRightDockWindows(currentProject?.id, consumePendingChatComposerPrefill);
  const {
    entries: poppedOutChatEntries,
    close: closePoppedOutChat,
    closeAll: closeAllPoppedOutChats,
  } = appRightDockWindows.chats;
  const {
    entries: poppedOutNoteEntries,
    close: closePoppedOutNote,
    closeAll: closeAllPoppedOutNotes,
  } = appRightDockWindows.notes;
  const { openSessionInNewWindow } = appRightDockWindows;

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

  const [chatComposerPrefill, setChatComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);

  /*
  FNXC:PlanningKeepAlive 2026-09-14-11:35:
  Planning Mode mounts only after its first open for the current project, then stays mounted-but-hidden across sidebar navigation so the interview survives round-trips. Reset on project change so one project's retained interview cannot leak into another; the PlanningKeepAlive key supplies the matching React identity boundary.
  */
  const [planningEverOpenedProjectId, setPlanningEverOpenedProjectId] = useState<string | null>(null);
  const planningLatchProjectIdRef = useRef<string | undefined>(undefined);
  const planningViewActive = taskView === "planning";
  useEffect(() => {
    const projectId = currentProject?.id;
    if (planningLatchProjectIdRef.current !== projectId) {
      planningLatchProjectIdRef.current = projectId;
      setPlanningEverOpenedProjectId(planningViewActive && projectId ? projectId : null);
      return;
    }
    if (planningViewActive && projectId) {
      setPlanningEverOpenedProjectId(projectId);
    }
  }, [currentProject?.id, planningViewActive]);

  /*
  FNXC:GitHubImportChat 2026-09-14-17:46:
  Import and task/report actions seed the canonical Chat host at App scope, then route through the same responsive launcher as Header and sidebar navigation. No dedicated transient Chat owner exists.
  */
  const openChatWithPrefill = useCallback((text: string) => {
    setChatComposerPrefill({ text, nonce: Date.now() });
    pendingChatComposerPrefillRef.current = text;
    handleTaskViewChange("chat");
  }, [handleTaskViewChange]);

  const {
    footerHidden,
    navKeyboardOpen,
    footerKeyboardOpen,
    keyboardOverlap,
    viewportHeight,
    viewportOffsetTop,
  } = useMobileBarKeyboardState({
    isMobile,
    anyModalOpen: modalManager.anyModalOpen,
    overlayOpen: isMobile && taskView === "chat",
  });
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
  // `footerKeyboardOpen` uses only the immediate focus/keyboard trigger. A
  // footer that remains rendered over a modal must also drop its bottom
  // reservation on both platforms to avoid a dead band; unlike the pill, it
  // must not inherit the visual viewport's keyboard-dismissal tail.
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
  const {
    mailboxUnreadCount,
    mailboxPendingApprovalCount,
    setMailboxUnreadCount,
  } = useMailboxUnread(currentProject?.id);
  const { stashOrphanCount } = useStashOrphanCount(currentProject?.id);
  const [showGitHubStarPrompt, setShowGitHubStarPrompt] = useState(false);
  /*
  FNXC:GithubStarAsk 2026-08-23-23:35:
  The banner gate hides the ask while the durable answer is unknown, but the done-transition TRIGGER
  below reads the durable answer alone. That transition is one-shot: gating it on the unknown state
  would drop it for good, so a fresh browser profile would never show the ask even when nobody had
  dismissed it.
  */
  const { dismissed: gitHubStarPromptDismissed, resolved: gitHubStarPromptResolved } = useGitHubStarPromptState();
  const gitHubStarPromptShown = gitHubStarPromptDismissed || !gitHubStarPromptResolved;
  /*
  FNXC:GithubStarAsk 2026-08-23-23:43:
  Every trigger that would SHOW the ask re-reads the durable answer first — both of them route through
  here: a task first reaching done, and onboarding completing. The mount-time lookup can be stale by
  then (first-run setup routinely has this tab open while the operator answers `fn onboard` in a
  terminal), and showing an ask the operator already dismissed elsewhere is the exact duplicate the
  shared record exists to prevent.
  */
  const handleStarPrompt = useCallback(() => {
    void refreshGitHubStarPromptDismissal().then((alreadyAnswered) => {
      if (!alreadyAnswered) setShowGitHubStarPrompt(true);
    });
  }, []);
  const { candidate: approvalBannerCandidate, dismissApproval } = useApprovalBanner({
    tasks,
    currentProjectId: currentProject?.id,
    gitHubStarPromptShown: gitHubStarPromptDismissed,
    onStarPrompt: handleStarPrompt,
  });

  const [retryingProjects, setRetryingProjects] = useState(false);
  const [missionResumeSessionId, setMissionResumeSessionId] = useState<string | undefined>(undefined);
  const [missionTargetId, setMissionTargetId] = useState<string | undefined>(undefined);
  const [goalAnchorId, setGoalAnchorId] = useState<string | undefined>(undefined);
  /*
  FNXC:CommandCenterAgentActivity 2026-08-10-01:54:
  Agent activity raises a focused-agent anchor through App's existing view router rather than changing routing itself. The request id mirrors goalAnchorId but preserves repeated activation of one agent.
  */
  const [agentAnchor, setAgentAnchor] = useState<{ agentId: string; requestId: number } | undefined>(undefined);
  const [selectedPrId, setSelectedPrId] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const v = new URL(window.location.href).searchParams.get("pr");
    return v ?? undefined;
  });
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: which Git Manager section the page opens on. Set to `pull-requests` by the Pull Requests entry points and
  legacy links; cleared when the operator leaves Git so a later plain Git click lands on Status again.
  */
  const [gitManagerInitialSection, setGitManagerInitialSection] = useState<GitManagerSectionId | undefined>(undefined);
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: exactly ONE navigation panel among Activity, Notes, and the footer Chat list is open at a time. Modelling it
  as a single discriminated value (rather than three booleans) makes that mutual exclusion structural: opening one
  replaces the other, and no combination can show two lists of the same tool at once. Usage stays independent — it is
  a different surface with its own trigger and its own state.
  */
  const [toolPanel, setToolPanel] = useState<{ kind: "activity" | "notes" | "chat"; anchorRect: DOMRect | null } | null>(null);
  const closeToolPanel = useCallback(() => setToolPanel(null), []);
  const openToolPanel = useCallback((kind: "activity" | "notes" | "chat", anchorRect: DOMRect | null) => {
    setToolPanel((current) => (current?.kind === kind ? null : { kind, anchorRect }));
  }, []);
  const [milestoneSliceResumeSessionId, setMilestoneSliceResumeSessionId] = useState<string | undefined>(undefined);
  /*
  FNXC:ToolSurfaces 2026-09-16-23:06:
  FN-435 : sur téléphone le journal d'activité passe par la modale plein écran, jamais par la popover. Une rotation
  d'écran peut faire basculer le point de rupture alors que la popover est déjà ouverte ; sans cette fermeture elle
  resterait ancrée à un rect périmé, écrasée contre le bord. L'état n'est délibérément PAS transféré vers la modale :
  une ouverture fantôme que l'opérateur n'a pas demandée serait pire que la fermeture.
  FN-437 étend la fermeture à Notes. L'affirmation FN-435 « Notes n'a pas besoin de ce traitement » reposait sur
  l'existence d'un hôte Notes mobile partageant le même état ; cet hôte (le tiroir `mobile-drawer-notes`) est retiré
  parce que le Header n'expose plus son déclencheur sur téléphone. Le propriétaire mobile de Notes est désormais
  l'entrée `mobile-more-item-notes` du menu du pied de page, qui route vers la vue Notes plein écran hébergée par
  `MainContentDrawer` — un état `toolPanel.kind === "notes"` hérité de tablette resterait donc sans hôte NI déclencheur
  pour le refermer.
  */
  useEffect(() => {
    if (!isMobile) return;
    setToolPanel((current) => (current?.kind === "activity" || current?.kind === "notes" ? null : current));
  }, [isMobile]);

  useEffect(() => {
    if (taskView !== "goalsView" && goalAnchorId !== undefined) {
      setGoalAnchorId(undefined);
    }
  }, [goalAnchorId, taskView]);
  useEffect(() => {
    if (taskView !== "agents" && agentAnchor !== undefined) {
      setAgentAnchor(undefined);
    }
  }, [agentAnchor, taskView]);
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: the linked pull request now belongs to the Git Manager page, so its selection is released when the operator
  leaves Git — not when they leave the retired standalone Pull Requests route.
  */
  useEffect(() => {
    if (taskView !== "git-manager" && selectedPrId !== undefined) {
      setSelectedPrId(undefined);
    }
  }, [selectedPrId, taskView]);
  useEffect(() => {
    if (taskView !== "git-manager" && gitManagerInitialSection !== undefined) {
      setGitManagerInitialSection(undefined);
    }
  }, [gitManagerInitialSection, taskView]);
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
    maxWorktrees,
    autoMerge,
    mergeStrategy,
    planAutoApproveEnabled,
    showWorktreeGrouping,
    globalPaused,
    isTestMode,
    staleHighFanoutBlockerAgeThresholdMs,
    capacityRiskBannerEnabled,
    capacityRiskTodoThreshold,
    showCostBadgeOnCards,
    modelPricingOverrides,
    taskDetailDefaultTab,
    chatMessageLayout,
    navigationPlacement,
    rightSidebarEnabled,
    dashboardKeyboardShortcuts,
    dismissModalsOnOutsideClick,
    quickAddSubmitOnEnter,
    chatSubmitOnEnter,
    skipConfirmationDialogs,
    maxTotalRetriesBeforeFail,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    memoryEnabled,
    devServerEnabled,
    goalsEnabled,
    /* FN-446: the reused project quick-access selection drives the shared footer's direct row. */
    mobileNavPrimaryItems,
    /* FN-511 : option mobile de tiroir gestuel — masque le hamburger et arme le geste d'ouverture du menu. */
    mobileNavMenuSwipeGesture,
    setChatMessageLayoutImmediate,
    setNavigationPlacementImmediate,
    setRightSidebarEnabledImmediate,
    setShowCostBadgeOnCardsImmediate,
    setTaskDetailDefaultTabImmediate,
    setMobileNavPrimaryItemsImmediate,
    setMobileNavMenuSwipeGestureImmediate,
    toggleAutoMerge,
    togglePlanAutoApprove,
    refresh: refreshAppSettings,
  } = useAppSettings(currentProject?.id);
  const [navigationMenuOpen, setUiMenuOpen] = useState(false);
  const [projectsDrawerOpen, setProjectsDrawerOpen] = useState(false);


  /*
  FNXC:RoadmapsNavigation 2026-07-19-12:00:
  Preserve the plugin manifest's roadmaps entry now that the bundled host registers its view.
  Native-structure roadmap-item previews use this as their callback-driven open destination.
  */
  const pluginDashboardViews = useMemo<PluginDashboardViewEntry[]>(
    () => rawPluginDashboardViews,
    [rawPluginDashboardViews],
  );

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
  const ideationEnabled = experimentalFeatures.ideationView === true;
  const whiteboardEnabled = isExperimentalFeatureEnabled({ experimentalFeatures }, WHITEBOARD_VIEW_FLAG);
  /* FNXC:OfficialDashboardDesign 2026-09-13-00:38: The native shell is Fusion's unconditional dashboard design; historical alphaUpdates settings never participate in production composition. */
  const mobileDrawerActive = isMobile && viewMode === "project" && Boolean(currentProject);

  /*
  FNXC:MobileDrawer 2026-09-10-04:41:
  The mobile shell has one task-detail owner. Clear legacy pop-outs when the presentation boundary activates; every new Board, List, dock, plugin, and pop-out request is routed to the shared main-content drawer below instead of creating a second detail subscription.
  */
  useEffect(() => {
    if (!mobileDrawerActive || poppedOutTaskEntries.length === 0) return;
    clearPoppedOutTaskNavigation();
    closeAllPoppedOutTasks();
  }, [mobileDrawerActive, clearPoppedOutTaskNavigation, closeAllPoppedOutTasks, poppedOutTaskEntries.length]);

  useEffect(() => {
    if (!mobileDrawerActive) {
      delete document.documentElement.dataset.mobileDrawers;
      return;
    }
    document.documentElement.dataset.mobileDrawers = "true";
    return () => { delete document.documentElement.dataset.mobileDrawers; };
  }, [mobileDrawerActive, currentProject?.id]);
  /*
  FNXC:Navigation 2026-06-19-00:00:
  Experimental left sidebar navigation replaces the Header view shortcuts with a persistent sidebar on non-mobile project screens, while mobile continues to use the bottom navigation bar as the only primary navigation surface.

  FNXC:Navigation 2026-06-21-00:00:
  Left sidebar navigation is now the default primary navigation on non-mobile project screens. Keep `leftSidebarNav: false` as the explicit opt-out and keep mobile on the bottom navigation bar.

  FNXC:Navigation 2026-09-15-14:41:
  FN-419 supersedes the flag as a PLACEMENT gate: the project setting `navigationPlacement` is now the single decider,
  resolved by `resolveNavigationSurfaces`. `leftSidebarNavEnabled` survives only as part of the `experimentalFeatures`
  payload handed to Header (no API removal); it must never re-enter the surface computation, because combining it with
  an explicit "sidebar" placement would leave an operator with zero navigation surfaces and no in-product way out.
  */
  const leftSidebarNavEnabled = experimentalFeatures.leftSidebarNav !== false;
  /*
  FNXC:RightSidebarOptional 2026-09-15-16:04:
  FN-426 makes the right dock OPTIONAL and default-off. Every tool it used to own now has a canonical host (Git and
  Files pages, Activity/Notes header popovers, the footer Chat list, the header Board/List toggle, Secrets in project
  settings, Pull Requests inside Git), so nothing depends on it.

  Availability is the loaded project setting ONLY. It deliberately ignores the dock's LOCAL preferences
  (`fusion:right-dock-open`, `-pinned`, `-width`, `-view`): those record how the operator last used the panel and must
  never be able to resurrect a panel the project has turned off — which is exactly what a pre-FN-426 stored
  `right-dock-open=true` would otherwise do on first paint. Availability also requires hydrated settings, so the
  unhydrated frame renders no shell it may have to retract.
  */
  const rightDockEnabled = settingsLoaded && rightSidebarEnabled === true;
  const projectShellPresent = viewMode === "project" && !!currentProject;
  /*
  FNXC:DesktopNavigation 2026-09-15-14:41:
  FN-419 replaces the old rule ("tablet and desktop share the wide footer while the sidebar is only removed on
  desktop") which made the tablet tier mount BOTH primary navigation surfaces at once. One shared pure resolver now
  owns every surface flag, so footer and sidebar are mutually exclusive on every breakpoint by construction. The
  desktop pilot (windows, router, Notes guards) stays bound to the FOOTER placement; `sidebar` placement falls back to
  ordinary page routing on desktop. In `sidebar` placement the shell has no bottom bar at all, so neither the pilot
  footer nor the legacy `ExecutorStatusBar` is mounted and no `--executor-footer-height` reservation is emitted.
  */
  const navigationSurfaces = resolveNavigationSurfaces({
    viewportMode,
    projectShellPresent,
    navigationPlacement: normalizeNavigationPlacement(navigationPlacement),
  });
  const desktopNavigationActive = navigationSurfaces.desktopPilotActive;
  const wideFooterActive = navigationSurfaces.footerNavActive;
  const executorFooterVisible = navigationSurfaces.executorFooterVisible;
  const shellFooterVisible = executorFooterVisible || wideFooterActive;
  /*
  FNXC:TerminalLayout 2026-09-15-07:57:
  FN-409 removes the phantom 36px band above the pinned terminal. The bottom bar is FIXED and paints over the
  bottom of `.dashboard-project-stack`. When the pinned terminal is in flow at the bottom of that stack, it is the
  only element the bar covers, so a reservation by the shell ABOVE it protects nothing and renders as an empty band
  between the application content and the terminal. While the terminal reports itself pinned, the shell consumers
  (`.project-content--with-footer`, `.left-sidebar-nav--with-footer`, `.right-dock--with-footer`) stop reserving and
  `.terminal-below-host--with-footer` remains the single legitimate consumer of `--executor-footer-height` in the stack.
  `MobileNavBar` keeps `executorFooterVisible`.
  The terminal is the source of truth for its EFFECTIVE presentation, so the shell never reads `localStorage` here.

  FNXC:TerminalLayout 2026-09-17-04:51:
  FN-487 adds the SECOND producer of a bottom reservation: any window docked along the bottom
  (`snapMode: "bottom"`) publishes its band through the window manager, and this stack reserves it exactly like the
  pinned terminal's host does. While such a band is active it already covers the fixed bottom bar, so the shell
  consumers stop reserving that bar a second time and `TerminalModal` receives a disabled `footerVisible` — otherwise
  FN-409's empty 36px band returns, this time above the docked window.
  */
  const [terminalPinnedBelow, setTerminalPinnedBelow] = useState(false);
  const handleTerminalPinnedLayoutChange = useCallback((pinned: boolean) => {
    setTerminalPinnedBelow(pinned);
  }, []);
  const bottomDockReservationPx = useDashboardWindowBottomDockReservation();
  const bottomDockReservationActive = bottomDockReservationPx > 0;
  const shellFooterReservationVisible = shellFooterVisible && !terminalPinnedBelow && !bottomDockReservationActive;
  const terminalFooterVisible = shellFooterVisible && !bottomDockReservationActive;
  const mobileNavVisible = projectShellPresent;
  /*
  FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
  FN-481 : App est l'unique composition du Header et de la pill, donc c'est ici que la navigation basse apprend ce que
  le Header offre DÉJÀ. Les capacités passées au résolveur sont EXACTEMENT celles transmises au Header plus bas
  (`onOpenUsage` toujours fourni, panneaux Notes/Activity liés à `currentProject`, projets effectifs, sélection et
  gestion de projet), pour qu'aucune seconde table indépendante ne puisse dériver. Sur téléphone cela retire Projets
  et Usage du bas ; sur tablette cela retire en plus Notes et Activity, sans jamais retirer une destination dont le
  Header n'offre pas réellement l'accès.
  */
  const headerOwnedNavigationItems = useMemo(
    () => resolveHeaderNavigationOwnership({
      mode: viewportMode,
      mobileNavEnabled: mobileShellActive,
      hasOpenUsage: true,
      hasOpenNotesPanel: Boolean(currentProject),
      hasOpenActivityPanel: Boolean(currentProject),
      projectCount: effectiveProjects.length,
      hasSelectProject: true,
      hasViewAllProjects: true,
    }),
    [currentProject, effectiveProjects.length, mobileShellActive, viewportMode],
  );
  /*
  FNXC:MobileDrawer 2026-09-10-17:16:
  A shared drawer is the foreground layer, not a replacement for its navigation trigger. Keep the pill mounted behind Usage and modal-owned Task Detail while ordinary blocking modals continue to suppress mobile navigation.
  */
  const sharedModalDrawerOpen = mobileDrawerActive && Boolean(modalManager.usageOpen || modalManager.detailTask);
  /*
  FNXC:NativeShell 2026-09-11-15:01:
  App remains the sole owner of the mobile popover's accessible open state while MobileNavBar owns both its trailing pill trigger and canonical menu surface. Any shell boundary that removes the pill closes this transient menu; the legacy More drawer remains MobileNavBar-owned.

  FNXC:MobilePillKeyboard 2026-09-13-10:32:
  Keyboard transitions are no longer shell boundaries because the official pill remains mounted throughout them. Moving focus from a field into the opened menu closes the keyboard, so that metric change must update geometry without immediately dismissing the App-owned popover.
  */
  useEffect(() => {
    setUiMenuOpen(false);
  }, [currentProject?.id, isMobile, modalManager.anyModalOpen, viewMode]);
  /* FN-468 : le dock droit est une surface large ; il disparaît sur toute la bande du shell mobile, tablette comprise. */
  const rightDockActive = rightDockEnabled && !mobileShellActive && projectShellPresent;
  const sidebarActive = navigationSurfaces.sidebarActive;
  const desktopViewWindows = useDesktopViewWindows({
    enabled: desktopNavigationActive,
    projectId: currentProject?.id,
    navigation: { pushNav, removeNav, promoteNav },
    showBoard: () => { if (taskView !== "board") handleChangeTaskView("board"); },
    showNotesPage: () => handleChangeTaskView("notes"),
    notesDirty: notesController.dirty,
  });
  const missingNodeFallbackGenerationRef = useRef(0);
  const latestNodeScopeRef = useRef({ currentNodeId, nodes, nodesLoading });
  latestNodeScopeRef.current = { currentNodeId, nodes, nodesLoading };
  const nodeListIdentity = nodes.map((node) => node.id).join("\u0000");
  const currentNodeMissing = Boolean(currentNodeId && !nodesLoading && !nodes.some((node) => node.id === currentNodeId));
  useEffect(() => {
    const generation = ++missingNodeFallbackGenerationRef.current;
    if (!currentNodeId || !currentNodeMissing) return;
    const missingNodeId = currentNodeId;

    /*
    FNXC:DesktopViewWindows 2026-09-11-20:29:
    A node disappearing from an authoritative list is a project-scope exit, not a harmless local fallback. The pilot owner resolves the dirty-Notes verdict first, then runs this freshness fence before it discards the draft or closes any window, so a node that reappears while confirmation is open leaves the complete prior scope intact.
    */
    void desktopViewWindows.requestCloseAll(() => {
      const latest = latestNodeScopeRef.current;
      return generation === missingNodeFallbackGenerationRef.current
        && !latest.nodesLoading
        && latest.currentNodeId === missingNodeId
        && !latest.nodes.some((node) => node.id === missingNodeId);
    }).then((accepted) => {
      if (accepted) clearCurrentNode();
    });

    return () => {
      if (missingNodeFallbackGenerationRef.current === generation) {
        missingNodeFallbackGenerationRef.current += 1;
      }
    };
  }, [desktopViewWindows.requestCloseAll, clearCurrentNode, currentNodeId, currentNodeMissing, nodeListIdentity]);
  desktopWindowRouterRef.current = (target) => {
    if (!desktopNavigationActive) return false;
    if (desktopViewWindows.windows.length === 0) return false;
    void desktopViewWindows.requestCloseAll().then((accepted) => {
      if (accepted) commitTaskViewChange(target);
    });
    return true;
  };
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

  /*
  FNXC:HistoryModalSurface 2026-09-15-04:29:
  FN-403: a legacy persisted view value or a programmatic navigation can still carry `patchnode`, which is no
  longer a main-content destination. Coerce it to Board and open the History modal once, in a layout effect so no
  empty/fallback main-content frame is ever painted, and never write `patchnode` back to view storage.
  */
  useLayoutEffect(() => {
    if (taskView !== "patchnode") return;
    handleChangeTaskView("board");
    openHistoryWithNav();
  }, [taskView, handleChangeTaskView, openHistoryWithNav]);

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
    /*
    FNXC:Navigation 2026-07-30-00:00:
    FN-8352 promotes Ideation to a default-off experimental top-level view.
    Redirect persisted and deep-linked disabled views to Board so MainContent
    never leaves users on a blank unavailable surface.
    */
    if (taskView === "ideation" && !ideationEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "whiteboard" && !whiteboardEnabled) {
      handleChangeTaskView("board");
    }
    if (taskView === "goalsView" && !goalsEnabled) {
      handleChangeTaskView("board");
    }
  }, [taskView, settingsLoaded, skillsEnabled, insightsEnabled, handleChangeTaskView, agentsEnabled, memoryEnabled, devServerEnabled, researchEnabled, evalsEnabled, ideationEnabled, whiteboardEnabled, goalsEnabled, graphPluginTaskView]);

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

  /*
  FNXC:ProjectSwitchModalReset 2026-09-14-11:35:
  Project-scoped task and Chat surfaces span modal, main-panel, dock, expanded, and detached owners. A project swap must dismiss all of them, so useProjectActions receives a stable ref whose implementation is refreshed after those owners are composed.
  */
  const closeProjectScopedUiRef = useRef<() => void>(() => {});
  const closeProjectScopedUi = useCallback(() => closeProjectScopedUiRef.current(), []);

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
    closeProjectScopedModals: closeProjectScopedUi,
    requestCloseProjectScopedUi: desktopViewWindows.requestCloseAll,
    // FNXC:GithubStarAsk 2026-08-19-03:59: finishing onboarding is the first moment we ask for a GitHub star.
    onOnboardingCompleted: handleStarPrompt,
  });

  /*
  FNXC:MobileDrawer 2026-09-10-05:38:
  Projects opened from the mobile pill must remain project-scoped so Board stays mounted behind the shared drawer. Selecting another project closes the drawer before the normal project transition; every other entry retains the overview route that clears the current project.
  */
  const openProjectsFromMobileNav = useCallback(() => {
    if (mobileDrawerActive) {
      setProjectsDrawerOpen(true);
      return;
    }
    handleViewAllProjects();
  }, [mobileDrawerActive, handleViewAllProjects]);

  useEffect(() => {
    if (!mobileDrawerActive) setProjectsDrawerOpen(false);
  }, [mobileDrawerActive, currentProject?.id]);

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
    handleGitHubImport,
  } = useTaskHandlers({
    createTask,
    ingestCreatedTasks,
    onPlanningTaskCreated: modalManager.onPlanningTaskCreated,
    onPlanningTasksCreated: modalManager.onPlanningTasksCreated,
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
  FNXC:TaskPopupDeepTabs 2026-09-16-02:53:
  FN-442: every board TaskCard deep-tab action (files changed, retries, workflow) routes to the floating task window with
  its requested tab, unconditionally. Routing once is what keeps a single click from opening both a FloatingWindow and a
  main-panel/modal detail surface; the mobile drawer keeps its main-panel fallback.
  */
  const handleOpenDetailWithTab = useCallback((task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => {
    if (getBoardTaskOpenRoute({ mobileDrawerActive }) === "main-panel") {
      openTaskDetailInMainPanel(task, initialTab);
      return;
    }
    popOutTaskDetailForCurrentView(task, initialTab);
  }, [mobileDrawerActive, openTaskDetailInMainPanel, popOutTaskDetailForCurrentView]);

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

  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: the single redirect for retired standalone tool destinations. `pull-requests` becomes the Git Manager page
  with its PR section preselected (the linked `?pr=` id survives untouched), and `secrets` opens Settings at the
  project Secrets section. Both go through the ordinary navigation owners, so exactly one history entry is written
  and Back behaves like any other destination change.
  */
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: a retired destination does not only arrive through a click. A persisted per-project view, a restored history
  entry, and a `?view=` deep link all write `taskView` directly, bypassing `handleTaskViewChange`. Re-applying the
  route whenever the resolved view IS a retired one covers those paths with the same single decider, and terminates
  because every route target is itself a real destination.
  */
  useEffect(() => {
    if (!isRedirectedToolSurface(taskView)) return;
    toolSurfaceRouteRef.current?.(taskView);
  }, [taskView]);

  toolSurfaceRouteRef.current = (requestedView: TaskView) => {
    const route = resolveToolSurfaceRoute(requestedView);
    if (route.kind === "git-pull-requests") {
      setGitManagerInitialSection("pull-requests");
      commitTaskViewChange("git-manager");
      return true;
    }
    if (route.kind === "settings-section") {
      openSettingsWithNav(route.section);
      return true;
    }
    return false;
  };

  const openNewTaskWithNav = useCallback((workflowId?: string | null) => {
    modalManager.openNewTask(workflowId);
    pushNav({ type: "modal", close: modalManager.closeNewTask });
  }, [modalManager, pushNav]);

  const closeFilesWithNav = useCallback(() => {
    removeNav(modalManager.closeFiles);
    modalManager.closeFiles();
  }, [modalManager, removeNav]);

  const closeNewTaskWithNav = useCallback(() => {
    removeNav(modalManager.closeNewTask);
    modalManager.closeNewTask();
  }, [modalManager, removeNav]);

  /*
  FNXC:Navigation 2026-06-21-00:00:
  FN-6886 keeps the existing planning payload setters but routes every programmatic Planning Mode entry point to the docked `planning` view instead of pushing a modal overlay history entry.
  */
  const openPlanningWithNav = useCallback(() => {
    modalManager.openPlanning();
    handleTaskViewChange("planning");
  }, [handleTaskViewChange, modalManager]);

  const openPlanningWithInitialPlanWithNav = useCallback((initialPlan: string, workflowId?: string | null, sourceIssue?: { provider: "github"; repository: string; issueNumber: number; url: string; title?: string }) => {
    modalManager.openPlanningWithInitialPlan(initialPlan, workflowId, sourceIssue);
    handleTaskViewChange("planning");
  }, [handleTaskViewChange, modalManager]);

  const resumePlanningWithNav = useCallback(() => {
    modalManager.resumePlanning();
    handleTaskViewChange("planning");
  }, [handleTaskViewChange, modalManager]);


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

  /*
  FNXC:DesktopViewWindows 2026-09-11-20:21:
  App's Escape authority can close Task Detail before the later-mounted modal host receives the key. Consume the exact navigation callback first and perform the same detail/deep-link cleanup so no phantom modal entry remains above History or Notes.
  */
  const closeDetailTaskWithNav = useCallback(() => {
    removeNav(modalManager.closeDetailTask);
    modalManager.closeDetailTask();
    handleDetailClose();
  }, [handleDetailClose, modalManager, removeNav]);

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
    FNXC:DashboardShortcuts 2026-09-14-11:35:
    Escape closes one visible dashboard surface per press. Global-hidden windows release App-level Escape ownership, while detached work surfaces precede the canonical expanded Chat window and fixed app modals.
    */
    const closedHigherPrioritySurface = closeTopmostDashboardPopupForShortcut(
      {
        poppedOutTaskEntries,
        poppedOutChatEntries,
        poppedOutNoteEntries,
        windowsGloballyHidden: dashboardWindowVisibility?.hiddenSnapshotActive,
        terminalOpen: modalManager.terminalOpen,
        modalClosers: [
          [primaryChatWindowOpenRef.current, () => closePrimaryChatWindowRef.current?.()],
          /* FNXC:HistoryModalSurface 2026-09-15-04:29: FN-403: History is a coexisting window, so Escape closes it after detached task/chat/note windows and the terminal but before the blocking modals underneath. */
          [modalManager.historyOpen, closeHistoryWithNav],
          [modalManager.filesOpen, modalManager.closeFiles],
          /* FNXC:WorkflowEditorEmbedding 2026-09-15-05:29: FN-407 removed the workflow editor's modal presentation, so it has no Escape closer — it is a persistent view like Settings, not an overlay. */
          [modalManager.gitManagerOpen, modalManager.closeGitManager],
          [modalManager.activityLogOpen, modalManager.closeActivityLog],
          [modalManager.scriptsOpen, modalManager.closeScripts],
          [modalManager.agentsOpen, modalManager.closeAgents],
          [modalManager.usageOpen, modalManager.closeUsage],
          [modalManager.schedulesOpen, modalManager.closeSchedules],
          [modalManager.githubImportOpen, modalManager.closeGitHubImport],
          [modalManager.settingsOpen, modalManager.closeSettings],
          [Boolean(modalManager.detailTask), closeDetailTaskWithNav],
          [Boolean(modalManager.groupModalGroupId), modalManager.closeGroupModal],
          [modalManager.isPlanningOpen, modalManager.closePlanning],
          [modalManager.newTaskModalOpen, modalManager.closeNewTask],
          [modalManager.setupWizardOpen, modalManager.closeSetupWizard],
          [modalManager.modelOnboardingOpen, modalManager.closeModelOnboarding],
        ],
      },
      {
        closePoppedOutTask: closePoppedOutTaskWithNav,
        closePoppedOutChat,
        closePoppedOutNote: (projectId, noteId) => { void desktopViewWindows.requestGuardedClose(`note:${projectId}:${noteId}`); },
        closeTerminal: closeTerminalWithNav,
      },
    );
    if (closedHigherPrioritySurface) return true;
    const pilotTopmost = desktopViewWindows.topmost;
    if (!pilotTopmost) return false;
    /*
    FNXC:DesktopViewWindows 2026-09-11-20:06:
    Non-modal pilot windows still participate in App's single-surface Escape authority. Existing task/chat/modal owners retain their higher-priority close order; otherwise Escape requests closure of only the topmost pilot and honors the Notes discard guard before touching anything underneath.
    */
    void desktopViewWindows.requestClose(pilotTopmost);
    return true;
  }, [desktopViewWindows.requestClose, desktopViewWindows.requestGuardedClose, desktopViewWindows.topmost, closeDetailTaskWithNav, closeHistoryWithNav, closePoppedOutChat, closePoppedOutTaskWithNav, closeTerminalWithNav, dashboardWindowVisibility?.hiddenSnapshotActive, modalManager, poppedOutChatEntries, poppedOutNoteEntries, poppedOutTaskEntries]);

  const openFilesWithNav = useCallback((workspace?: string, initialFile?: string | null) => {
    modalManager.openFiles(workspace, initialFile);
    pushNav({ type: "modal", close: modalManager.closeFiles });
  }, [modalManager, pushNav]);

  const closeViewShortcutWithNav = useCallback((view: TaskView) => {
    closeViewShortcut(
      view,
      viewNavRevertRef.current,
      removeNav,
      () => handleChangeTaskView("board"),
    );
  }, [handleChangeTaskView, removeNav]);

  /*
  FNXC:DashboardShortcuts 2026-09-14-11:35:
  The generic shortcut routes through the same window-manager snapshot as the permanent footer button; keyboard and pointer actions must never choose different surface sets.
  */
  const toggleDashboardWindowVisibility = useCallback(() => {
    dashboardWindowVisibility?.toggleVisibility();
  }, [dashboardWindowVisibility]);

  /*
  FNXC:DashboardShortcuts 2026-09-16-02:27:
  FN-441 : le clavier doit choisir le MÊME hôte et la MÊME ancre que le pointeur.

  FNXC:DashboardShortcuts 2026-09-16-19:44:
  FN-468 déplace la frontière : sur tout le shell mobile (téléphone ET tablette, sous 1024 px) la liste des chats
  est la destination `chat` (tiroir plein écran de MainViewKeepAlive), parce que la popover du pied de page n'a
  plus d'hôte sous 1024 px — le pied de page large n'y existe plus. À partir de 1024 px c'est la popover `chat`
  du pied de page ancrée sur `desktop-nav-chat-panel`. La bascule réutilise intégralement les propriétaires
  existants (handleTaskViewChange / closeViewShortcutWithNav côté vue, openToolPanel / closeToolPanel côté popover)
  pour ne jamais créer une seconde entrée d'historique de navigation ni un second propriétaire de session de
  conversation. Sans projet courant aucun hôte n'existe : l'action est inerte.
  */
  const toggleChatListShortcut = useCallback(() => {
    const target = resolveChatListShortcutTarget({ hasProject: Boolean(currentProject), mobileShellActive });
    if (target === "none") return;
    if (target === "drawer") {
      if (taskView === "chat") closeViewShortcutWithNav("chat");
      else handleTaskViewChange("chat");
      return;
    }
    if (toolPanel?.kind === "chat") {
      closeToolPanel();
      return;
    }
    openToolPanel("chat", readShortcutAnchorRect("desktop-nav-chat-panel"));
  }, [closeToolPanel, closeViewShortcutWithNav, currentProject, handleTaskViewChange, mobileShellActive, openToolPanel, taskView, toolPanel?.kind]);

  useDashboardKeyboardShortcuts({
    shortcuts: dashboardKeyboardShortcuts,
    toggleModalVisibility: toggleDashboardWindowVisibility,
    toggleTerminal: toggleTerminalWithNav,
    closeTopmostPopup: closeTopmostPopupForShortcut,
    toggleFiles: () => modalManager.filesOpen ? closeFilesWithNav() : openFilesWithNav(),
    toggleSettings: () => taskView === "settings" ? closeViewShortcutWithNav("settings") : openSettingsWithNav(),
    toggleCommandCenter: () => taskView === "command-center" ? closeViewShortcutWithNav("command-center") : openCommandCenterWithNav(),
    toggleNewTask: () => modalManager.newTaskModalOpen ? closeNewTaskWithNav() : openNewTaskWithNav(),
    toggleChatList: toggleChatListShortcut,
  });

  const openFileInBrowser = useCallback((path: string, opts?: { workspace?: string; line?: number; col?: number }) => {
    openAppFileInBrowser(modalManager, pushNav, path, opts);
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

  /*
  FNXC:WorkflowEditorEmbedding 2026-09-15-05:29:
  FN-407: every workflow entry point now behaves exactly like choosing Workflows in the nav — it navigates to the
  `workflows` main-content view carrying optional view parameters. This mirrors openSettingsWithNav: no modal nav
  entry is pushed here because handleTaskViewChange owns the back-navigation entry for a view destination.
  Creation is not an entry point at all; it is the `wf-new-workflow` header action inside that view.
  */
  const openWorkflowEditorWithNav = useCallback((workflowId?: string) => {
    modalManager.setWorkflowViewParams({ workflowId });
    handleTaskViewChange("workflows");
  }, [modalManager, handleTaskViewChange]);

  const openWorkflowSettingsWithNav = useCallback(() => {
    modalManager.setWorkflowViewParams({ panel: "settings" });
    handleTaskViewChange("workflows");
  }, [modalManager, handleTaskViewChange]);

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
      /*
      FNXC:Navigation 2026-07-15-00:00:
      Background planning sessions must navigate to the embedded `taskView === "planning"` surface as well as setting resume state. This mirrors the mission interview branches below and the openPlanning*WithNav helpers, so footer and needs-input resume entry points actually render the reconnected session.
      */
      modalManager.openPlanningWithSession(session.id);
      handleChangeTaskView("planning");
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
  // Planning modal's sidebar or the session notification banner so the user
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
        /*
        FNXC:WorkflowLifecycleColumns 2026-08-01-02:10:
        Resolve Cancel's destination from the card's OWN workflow. Without this the banner moved to a
        hardcoded `"todo"`, which `moves.ts` REJECTS on a board that does not declare it — the button
        threw instead of cancelling. Wired here rather than left optional: an unsupplied parameter is
        the inert shape this program has already found five times.
        */
        resolveCancelColumn: (taskId: string) => {
          if (!footerBoardWorkflows) return undefined;
          const workflow = footerBoardWorkflows.workflows.find(
            (candidate) => candidate.id === (footerBoardWorkflows.taskWorkflowIds[taskId] ?? footerBoardWorkflows.defaultWorkflowId),
          );
          return workflow?.columns.find((column) => column.flags?.hold === true)?.id;
        },
      }),
    [addToast, currentProject?.id, footerBoardWorkflows, modalManager, moveTask, retryTask],
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

  /*
  FNXC:WorkflowControls 2026-09-16-23:24:
  FN-483 : contexte visuel du Board de fond, distinct de `taskView`. Sur téléphone avec un projet, `MainViewKeepAlive`
  garde le Board monté ET actif sous chaque drawer, donc le Header doit continuer d'exposer `#header-workflow-slot`
  pendant toute la navigation entre drawers ; sinon le Board replie son sélecteur en ligne sous le header. La vue
  globale et la page d'erreur backend désactivent ce fond (même condition qu'`earlyHidden` dans MainContent), donc
  elles reviennent au contrat Board/List de la route active.
  */
  const boardBackgroundActive = mobileDrawerActive && !showBackendConnectionErrorPage;

  // Props for the extracted <MainContent> switch (see components/dashboard/MainContent.tsx).
  // Every value is passed by its App name; the switch renders the same subtrees as before.
  const notesDirtyRef = useRef(notesController.dirty);
  notesDirtyRef.current = notesController.dirty;
  const desktopNavigationActiveRef = useRef(desktopNavigationActive);
  desktopNavigationActiveRef.current = desktopNavigationActive;
  const registerDesktopDockNotesGuard = useCallback((guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => {
    /*
    FNXC:DesktopRightDock 2026-09-11-22:51:
    The compact dock may retain its mounted content after a responsive transition, but it must never overwrite the standard Notes page guard. Keep its last dock guard sticky only while the desktop dock owns Notes; the standard page installs its own live closure after the handoff.
    */
    if (!desktopNavigationActiveRef.current) return () => {};
    desktopViewWindows.registerGuard(
      "notes",
      () => !notesDirtyRef.current || guard(),
      () => { if (notesDirtyRef.current) onAccepted?.(); },
    );
    return () => {};
  }, [desktopViewWindows.registerGuard]);
  const registerStandardNotesGuard = useCallback((guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => {
    if (desktopNavigationActiveRef.current) return () => {};
    return desktopViewWindows.registerGuard(
      "notes",
      () => !notesDirtyRef.current || guard(),
      () => { if (notesDirtyRef.current) onAccepted?.(); },
    );
  }, [desktopViewWindows.registerGuard]);
  /*
  FNXC:ListInRightDock 2026-09-14-03:31:
  FN-382: the dock renders the SAME List surface as the route, so it needs the main-content wiring that is assembled
  further down this render. A ref keeps the callback identity stable for the memoized dock render props while always
  reading the current props, and the dock body renders later in the same pass, so it never sees a stale snapshot.
  */
  const mainContentPropsRef = useRef<AppMainPanelTaskDetailMainContentProps | null>(null);
  const renderDockListView = useCallback(
    () => (mainContentPropsRef.current ? <MainContentListView {...mainContentPropsRef.current} listHost="dock" /> : null),
    [],
  );

  const { mailComposerPrefill, onSendAsReport: handleSendChatMessageAsReport } = useChatMailReportRouting(
    () => handleChangeTaskView("mailbox"),
    () => {
      closePrimaryChatWindowRef.current?.();
      if (taskView === "chat") handleChangeTaskView("board");
    },
  );

  const { rightDock, windows: desktopRightDockWindows } = useAppDesktopRightDockComposition({
    projectId: currentProject?.id,
    owner: appRightDockWindows,
    controllerInput: { active: rightDockActive, addToast, columnFlagsByTaskId: footerColumnFlagsByTaskId, settingsLoaded, researchReadinessVersion, goalAnchorId, tasks: boardSourceTasks, workflowSteps, subscribePluginEvents, openDetailTask: mobileDrawerActive ? openTaskDetailInMainPanel : openDetailTask, notesController, registerNotesGuard: registerDesktopDockNotesGuard, openFileInBrowser, onUpdateTask: updateTask, onDeleteTask: deleteTask, onRevertTask: revertTask, onRestoreRevertTask: restoreTaskRevert, onMergeTask: mergeTask, onRetryTask: retryTask, onOpenChatWithPrefill: openChatWithPrefill, onPauseTask: pauseTask, onUnpauseTask: unpauseTask, onBypassReview: bypassReview, onResetTask: resetTask, onDuplicateTask: duplicateTask, onTaskUpdated: (task: Task) => ingestCreatedTasks([task]), openSettings: (section?: string) => openSettingsWithNav(section as SectionId), onOpenUsage: openUsageWithNav, onOpenActivityLog: openActivityLogWithNav, onOpenGitHubImport: openGitHubImportWithNav, onOpenGitManager: openGitManagerWithNav, onOpenSchedules: openSchedulesWithNav, onSendSelectionToTask: modalManager.openNewTaskWithDescription, onCreateTaskFromInsight: handleInsightTaskCreate, onNavigateToMission: handleOpenMission, onTaskCreated: (task: Task) => ingestCreatedTasks([task]), prAuthAvailable, autoMerge, taskDetailDefaultTab, renderListView: isMobile || taskView === "list" ? undefined : renderDockListView, onSendAsReport: handleSendChatMessageAsReport, visibilityOptions: { hostMode: desktopNavigationActive ? "desktop" : "standard", experimentalFeatures: { insights: insightsEnabled, memoryView: memoryEnabled, devServerView: devServerEnabled, researchView: researchEnabled, evalsView: evalsEnabled, goalsView: goalsEnabled }, showSkillsTab: skillsEnabled, pluginDashboardViews, listViewAvailable: !isMobile }, footerVisible: shellFooterReservationVisible },
    chatWindowProps: { addToast, experimentalFeatures, onSendAsReport: handleSendChatMessageAsReport },
    noteWindowProps: {
      addToast,
      onChanged: () => void notesController.loadList(notesController.search),
      registerGuard: (projectId, noteId, guard, onAccepted) => desktopViewWindows.registerGuard(`note:${projectId}:${noteId}`, guard, () => {
        onAccepted?.();
        closePoppedOutNote(projectId, noteId);
      }),
    },
  });

  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: the wide primary Chat host is the dock LIST again, not an expanded window. A wide Chat request therefore
  selects the Chat tool and opens the dock in one operation, leaving the current destination on screen; the mobile route
  is untouched. `primaryChatWindowOpen` now describes that dock list, so Escape and the Mailbox hand-off close only it
  and never a detached conversation.
  */
  const chatDockHostOpen = rightDock.open && rightDock.selectedView === "chat";
  primaryChatWindowOpenRef.current = chatDockHostOpen;
  closePrimaryChatWindowRef.current = () => { if (chatDockHostOpen) rightDock.toggle(); };
  const selectChatInDock = useCallback(() => {
    rightDock.selectView("chat");
    if (!rightDock.open) rightDock.toggle();
  }, [rightDock]);
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: the unread badge clears while the operator is actually looking at Chat. On a wide host that is the dock's
  inline list (or any visible detached conversation); on mobile it remains the Chat route. The hook is resolved here
  because the dock host state only exists after the dock composition above.
  */
  /*
  FNXC:ChatSurfaceUnification 2026-09-15-14:41:
  FN-419 adds a THIRD primary Chat host: in `sidebar` placement, selecting Chat from the left column shows the
  conversation in the main page exactly like Notes, instead of hijacking the right dock. `resolveChatHost` returns
  exactly one host, so the FN-392 "one primary Chat host" invariant still holds; a page host (mobile OR sidebar)
  clears the unread badge through the Chat route, while the dock host keeps its inline-list/detached signal.
  */
  /*
  FNXC:ChatSurfaceUnification 2026-09-16-20:16:
  FN-468: the tablet band lost both wide Chat hosts (right dock and left column), so Chat needs an explicit page host
  across the entire mobile shell. `mobileShellActive && projectShellPresent` keeps the host bound to a mounted project
  shell; the phone-only drawer WRAPPER remains `mobileDrawerActive`, so the tablet renders Chat as an ordinary page.
  */
  const chatPageHostKind = resolveChatHost({
    mobileDrawerActive,
    mobileShellActive: mobileShellActive && projectShellPresent,
    rightDockActive,
    navigationPlacement: normalizeNavigationPlacement(navigationPlacement),
  });
  const chatHostIsPage = chatPageHostKind === "mobile-page" || chatPageHostKind === "sidebar-page";
  const { chatHasUnreadResponse } = useChatUnreadBadge(currentProject?.id, {
    primaryHostActive: chatHostIsPage ? taskView === "chat" : (chatDockHostOpen || chatSurfaceVisible),
  });
  chatWindowRouteRef.current = (newView: TaskView) => {
    if (newView !== "chat") return false;
    if (chatPageHostKind === "mobile-page") {
      if (taskView !== "chat") commitTaskViewChange("chat");
      return true;
    }
    /* Sidebar placement (and a shell with no dock) lets Chat be an ordinary main-page destination. */
    if (chatPageHostKind !== "dock") return false;
    selectChatInDock();
    if (taskView === "chat") handleChangeTaskView("board");
    return true;
  };

  /*
  FNXC:ChatSurfaceUnification 2026-09-15-14:41:
  Responsive handoff preserves the user's primary Chat intent while enforcing one host. A wide Chat route becomes the
  dock list ONLY while the dock is the resolved host; a wide dock Chat selection becomes the mobile route. FN-419 adds
  the inverse transition: when the main page is the resolved Chat host, a dock whose selected tool is Chat is RE-POINTED
  to the default dock tool instead of being closed.

  FNXC:ChatSurfaceUnification 2026-09-15-15:40:
  Closing the dock here made it unopenable: the dock's selected view is persisted (`fusion:right-dock-view`), so an
  operator who last used the dock's Chat tab in `footer` placement kept `selectedView === "chat"` forever. Every
  Header dock toggle (and every `openTaskInDock` board click) re-opened the dock and this effect immediately closed it
  again, so the control looked dead and the tab strip — which only renders while the dock is open — was unreachable.
  Re-pointing the selection keeps exactly one primary Chat host AND keeps the dock openable and navigable.
  */
  useEffect(() => {
    if (mobileDrawerActive && chatDockHostOpen) {
      rightDock.toggle();
      if (taskView !== "chat") handleChangeTaskView("chat");
      return;
    }
    if (chatPageHostKind === "sidebar-page" && rightDock.selectedView === "chat") {
      /* "files" is the dock's own storage fallback (readStoredRightDockView), so it is always an inline-legal tool. */
      rightDock.selectView("files");
      return;
    }
    if (chatPageHostKind === "dock" && taskView === "chat") {
      selectChatInDock();
      handleChangeTaskView("board");
    }
  }, [mobileDrawerActive, chatDockHostOpen, chatPageHostKind, handleChangeTaskView, rightDock, selectChatInDock, taskView]);

  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426 REMOVES the List → dock interception FN-382 introduced. It was the last routing rule that could only be
  satisfied by the right dock: with the dock optional, intercepting List would make the list unreachable for every
  operator who leaves it off. List is an ordinary destination again on every breakpoint, reached from the header
  Board/List toggle.

  The dock's explicit List tab survives for operators who opt back in, and `renderListView` below withholds it while
  the List ROUTE is on screen — suspending the peer content rather than deleting the route — so exactly one List owner
  is ever active.
  */
  listDockRouteRef.current = () => false;

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442: a board card click always opens the floating task window — on desktop, tablet, and phone alike, with or without
  a deep initial tab — so the board stays visible behind it and there is no setting to enable. Only the mobile drawer
  keeps the full main-panel replacement, because phones deliberately host exactly one task-detail owner.
  */
  const openBoardTaskDetail = useCallback((task: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    if (getBoardTaskOpenRoute({ mobileDrawerActive }) === "main-panel") {
      openTaskDetailInMainPanel(task, initialTab);
      return;
    }
    popOutTaskDetailForCurrentView(task, initialTab);
  }, [mobileDrawerActive, openTaskDetailInMainPanel, popOutTaskDetailForCurrentView]);

  /*
  FNXC:HistoryModalSurface 2026-09-15-19:12:
  FN-428: single owner of the coexisting task-open decision. History (a coexisting FloatingWindow) and the shared
  `popOutTaskDetail` prop both route through it, so neither can drift back to the blocking `TaskDetailModal`
  presentation whose `.floating-window-overlay--modal` veil covered and neutralized the History window. Escape ordering
  (task window before History) stays owned by `closeTopmostDashboardPopupForShortcut`.
  */
  const openTaskDetailInWindow = useCallback((task: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    if (getCoexistingTaskOpenRoute({ mobileDrawerActive }) === "main-panel") {
      openTaskDetailInMainPanel(task, initialTab);
      return;
    }
    popOutTaskDetailForCurrentView(task, initialTab);
  }, [mobileDrawerActive, openTaskDetailInMainPanel, popOutTaskDetailForCurrentView]);


  /*
  FNXC:ProjectSwitchModalReset 2026-09-14-11:35:
  Project switching dismisses every task/detail/detached/expanded owner before the next project appears. Assign each render so the ref-stable project action always sees current state.
  */
  closeProjectScopedUiRef.current = () => {
    modalManager.closeProjectScopedModals();
    closeAllPoppedOutTasks();
    closeAllPoppedOutChats();
    closeAllPoppedOutNotes();
    if (mainPanelDetailTask) {
      closeTaskDetailMainPanel();
    }
    rightDock.closeDockTask();
    rightDock.closeViewWindow();
  };

  const mainContentProps: AppMainPanelTaskDetailMainContentProps = {
    showBackendConnectionErrorPage,
    projectsError,
    t,
    retryingProjects,
    handleRetryProjects,
    shellApi,
    taskView,
    pluginDashboardViews,
    modalManager,
    handleChangeTaskView,
    openHistory: openHistoryWithNav,
    refreshAppSettings,
    addToast,
    currentProject,
    themeMode,
    setThemeMode,
    colorTheme,
    uiStyle,
    setColorTheme,
    setUiStyle,
    dashboardFontScalePct,
    setDashboardFontScalePct,
    shadcnCustomColors,
    setShadcnCustomColors,
    resolvedThemeMode,
    setChatMessageLayoutImmediate,
    rightSidebarEnabled,
    setRightSidebarEnabledImmediate,
    setShowCostBadgeOnCardsImmediate,
    setTaskDetailDefaultTabImmediate,
    setMobileNavPrimaryItemsImmediate,
    setMobileNavMenuSwipeGestureImmediate,
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
    remoteData: { ...remoteData, tasks: boardSourceTasks },
    tasks: boardSourceTasks,
    workflowSteps,
    subscribePluginEvents,
    openDetailTask,
    openFileInBrowser,
    prAuthAvailable,
    autoMerge,
    mergeStrategy,
    planAutoApproveEnabled,
    settingsLoaded,
    showCostBadgeOnCards,
    taskDetailDefaultTab,
    chatMessageLayout,
    skillsEnabled,
    experimentalFeatures,
    onOpenSessionInNewWindow: openSessionInNewWindow,
    chatComposerPrefill,
    mailComposerPrefill,
    onSendAsReport: handleSendChatMessageAsReport,
    onOpenChatWithPrefill: openChatWithPrefill,
    setMailboxUnreadCount,
    setMissionTargetId,
    setMissionResumeSessionId,
    setMilestoneSliceResumeSessionId,
    missionResumeSessionId,
    missionTargetId,
    milestoneSliceResumeSessionId,
    setGoalAnchorId,
    goalAnchorId,
    agentAnchor,
    setAgentAnchor,
    agentsEnabled,
    agentOnboardingEnabled,
    handleOpenTaskLogs,
    popOutTaskDetail: openTaskDetailInWindow,
    selectedPrId,
    gitManagerInitialSection,
    insightsEnabled,
    handleInsightTaskCreate,
    researchEnabled,
    openSettingsWithNav,
    researchReadinessVersion,
    evalsEnabled,
    ideationEnabled,
    whiteboardEnabled,
    memoryEnabled,
    goalsEnabled,
    handleOpenMission,
    openPlanningWithInitialPlanWithNav,
    ingestCreatedTasks,
    nodesEnabled,
    handleGitHubImport,
    devServerEnabled,
    filteredBoardTasks: boardSourceTasks,
    maxConcurrent,
    maxWorktrees,
    showWorktreeGrouping,
    moveTask,
    /* FNXC:TaskQueueOrder 2026-09-17-12:07: FN-509 — Boost travels with the ordinary card mutations. */
    boostTask,
    pauseTask,
    openBoardTaskDetail,
    openGroupModalWithNav,
    handleBoardQuickCreate,
    openNewTaskWithNav,
    toggleAutoMerge,
    togglePlanAutoApprove,
    globalPaused,
    updateTask,
    retryTask,
    revertTask,
    restoreTaskRevert,
    deleteTask,
    loadMoreCurrentTasks,
    currentTasksTotal,
    currentTasksHasMore,
    currentTasksLoadingMore,
    currentTasksPaginationError,
    currentTasksProgressKey,
    retryCurrentTasksPagination,
    loadMoreCompletedTasks,
    completedCounts,
    completedHasMore,
    completedLoadingMore,
    completedPaginationError,
    completedProgressKey,
    retryCompletedTasksPagination,
    searchQuery,
    availableModels,
    favoriteProviders,
    favoriteModels,
    handleOpenDetailWithTab,
    handleToggleFavorite,
    handleToggleModelFavorite,
    staleHighFanoutBlockerAgeThresholdMs,
    lastFetchTimeMs,
    sidebarActive,
    /* FNXC:ChatSurfaceUnification 2026-09-15-14:41: FN-419 hands the resolved primary Chat host to the keep-alive tree so `sidebar` placement mounts Chat as a main page. */
    chatPageHost: chatPageHostKind,
    notesController,
    registerNotesGuard: registerStandardNotesGuard,
    isMobile,
    mergeTask,
        resetTask,
    duplicateTask,
    unpauseTask,
    capacityRiskBannerEnabled,
    capacityRiskDismissed,
    capacityRiskSignal,
    handleDismissCapacityRisk,
    // FNXC:WorkflowLifecycleColumns 2026-07-30-12:15: reuse the footer's per-task column traits
    // so main-content views resolve lifecycle roles instead of matching column names.
    columnFlagsByTaskId: footerColumnFlagsByTaskId,
    AgentsView,
    ChatView,
    CommandCenter,
    DevServerView,
    NotesView,
    WhiteboardView,
    EvalsView,
    GoalsView,
    InsightsView,
    MemoryView,
    PullRequestView,
    ResearchView,
    SecretsView,
    SkillsView,
    SnippetsView,
    _AutomationsView,
    _ImportTasksView,
    _SettingsView,
    _WorkflowEditorView: WorkflowNodeEditor,
  };
  mainContentPropsRef.current = mainContentProps;

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
  const desktopQuickAccessEntryIds = useMemo(() => resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems }), [mobileNavPrimaryItems]);
  const desktopNavigationEntries = buildDashboardNavigationEntries({
    view: taskView,
    onChangeView: async (target) => {
      if (!await desktopViewWindows.requestCloseAll()) return false;
      commitTaskViewChange(target);
      return true;
    },
    onNewTask: () => openNewTaskWithNav(),
    onOpenSettings: async () => {
      if (!await desktopViewWindows.requestCloseAll()) return false;
      modalManager.setSettingsSection(undefined);
      commitTaskViewChange("settings");
      return true;
    },
    pluginDashboardViews,
    showAgents: agentsEnabled,
    showSkills: skillsEnabled,
    flags: { memory: memoryEnabled, whiteboard: whiteboardEnabled, goals: goalsEnabled, insights: insightsEnabled, research: researchEnabled, ideation: ideationEnabled, evals: evalsEnabled },
    /* FN-426: Dev Server moved out of the right dock into primary navigation, keeping its existing experimental gate. */
    showDevServer: devServerEnabled,
    /*
    FNXC:DesktopNavigation 2026-09-16-04:15:
    FN-446: reading the live hook value (not the saved settings payload) is what makes Settings' pre-save preview
    (`setMobileNavPrimaryItemsImmediate`) reclassify the footer immediately.
    */
    quickAccessEntryIds: desktopQuickAccessEntryIds,
    mailboxUnreadCount,
    mailboxPendingApprovalCount,
    chatHasUnreadResponse,
    /*
    FNXC:DesktopNavigation 2026-09-17-16:53:
    FN-511 : le Chat entre dans la barre du bas par le REGISTRE, plus par une prop dédiée de `DesktopActionBar`. Son
    ouverture réutilise l'ancrage existant du raccourci clavier (`readShortcutAnchorRect("desktop-nav-chat-panel")`),
    donc le même propriétaire de popover qu'avant, où que l'hôte rende le bouton (piste de droite, rangée directe ou
    menu « More »). Sans projet courant l'option est omise, donc aucune entrée n'est construite.
    */
    onOpenChatPanel: currentProject ? () => openToolPanel("chat", readShortcutAnchorRect("desktop-nav-chat-panel")) : undefined,
    chatPanelOpen: toolPanel?.kind === "chat",
    chatPanelId: CHAT_TOOL_PANEL_ID,
    planningNeedsInput,
  });
  const desktopActiveNavigationId = desktopViewWindows.topmost ?? taskView;
  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  REMOVED: the AlphaProvider wrapper. The presentation is native, so there is no perimeter provider; the
  fragment keeps the window-manager scope and the provider stack exactly as they were.
  */
  return (
    <>
    <DashboardWindowManagerScope scopeKey={currentProject?.id} />
    <ViewLayoutProvider projectId={currentProject?.id}>
    <ConfirmDialogProvider skipConfirmations={skipConfirmationDialogs}>
      <ChatMessageLayoutProvider value={chatMessageLayout}>
      <ChatSubmitOnEnterProvider value={chatSubmitOnEnter}>
      <ModalDismissPreferenceProvider enabled={dismissModalsOnOutsideClick}>
        <QuickAddSubmitOnEnterProvider enabled={quickAddSubmitOnEnter}>
      <NavigationHistoryProvider value={navigationHistory}>
        <FileBrowserProvider openFile={openFileInBrowser}>
          <RetryWarningProvider value={maxTotalRetriesBeforeFail * RETRY_WARNING_RATIO}>
            <CostBadgeProvider value={{ enabled: showCostBadgeOnCards, pricingOverrides: modelPricingOverrides }}>
        {/* FNXC:AuthTokenRecovery 2026-09-10-21:28: A latched daemon-auth failure must win the first render over both the first-boot loader and the dashboard shell, leaving one blocking full-screen recovery page. */}
        {authTokenRecoveryOpen ? (
          <AuthTokenRecoveryPage open />
        ) : isFirstEverBoot ? (
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
        /* FNXC:ToolSurfaces 2026-09-16-23:06: FN-437 — le Header ne rend plus ce déclencheur sur téléphone (le menu du pied de page appelle directement `onOpenActivityLog`), donc la branche mobile de ce câblage était devenue morte. */
        onOpenActivityPanel={currentProject ? (anchorRect) => openToolPanel("activity", anchorRect) : undefined}
        activityPanelOpen={toolPanel?.kind === "activity"}
        activityPanelId={ACTIVITY_TOOL_PANEL_ID}
        onOpenNotesPanel={currentProject ? (anchorRect) => openToolPanel("notes", anchorRect) : undefined}
        notesPanelOpen={toolPanel?.kind === "notes"}
        notesPanelId={NOTES_TOOL_PANEL_ID}
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
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : undefined}
        onNewTask={viewMode === "project" && currentProject ? openNewTaskWithNav : undefined}
        showSkillsTab={skillsEnabled}
        showAgentsTab={agentsEnabled}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        /*
        FNXC:TaskSearch 2026-09-17-09:41:
        FN-477: the header search no longer receives `boardSourceTasks` as its catalogue, and the
        selected result is no longer re-looked-up inside it. That lookup was the second reason a task
        outside the loaded board pages could not be opened even once the server had returned it — the
        row was found, then discarded because the board had never paged it in.
        The search collection is separate from `useTasks` and `useRemoteNodeData`, so neither a
        result nor a search error can overwrite the board's own data.
        */
        onSelectSearchTask={(task) => { openDetailTask(task); }}
        addToast={addToast}
        /* The selected node id is authoritative from the switch, before the node object resolves. */
        {...(currentNodeId ? { searchNodeId: currentNodeId } : {})}
        projects={effectiveProjects}
        currentProject={currentProject}
        onSelectProject={handleSelectProject}
        onViewAllProjects={handleViewAllProjects}
        projectId={currentProject?.id}
        mobileNavEnabled={mobileShellActive}
        /* FNXC:WorkflowControls 2026-09-16-23:24: FN-483 — le Board de fond garde la propriété du slot pendant les drawers téléphone. */
        boardBackgroundActive={boardBackgroundActive}
        /* FNXC:Navigation 2026-09-15-14:41: Any wide primary surface (footer OR sidebar) owns routing, so Header must not re-render its view shortcuts and create a third navigation. */
        leftSidebarNavActive={navigationSurfaces.headerPrimaryNavSuppressed}
        rightDockAvailable={rightDockActive}
        rightDockOpen={rightDock.open}
        onToggleRightDock={rightDock.toggle}
        // Node switching props
        availableNodes={nodes}
        currentNode={currentNode}
        onSelectNode={async (node) => {
          const targetNodeId = node?.id ?? null;
          if (targetNodeId === currentNodeId) return true;
          /*
          FNXC:DesktopViewWindows 2026-09-11-20:06:
          Node changes replace the project scope just like project selection does. The shared pilot-window guard must accept before NodeContext mutates, otherwise a dirty Notes controller can reset before its discard decision; refusal also keeps the selector open for a retry.
          */
          if (!await desktopViewWindows.requestCloseAll()) return false;
          if (node === null) clearCurrentNode();
          else setCurrentNode(node);
          return true;
        }}
        isRemote={isRemote}
        experimentalFeatures={{
          insights: insightsEnabled,
          memoryView: memoryEnabled,
          devServer: devServerEnabled,
          devServerView: devServerEnabled,
          researchView: researchEnabled,
          evalsView: evalsEnabled,
          ideationView: ideationEnabled,
          whiteboardView: whiteboardEnabled,
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
      <div
        className={`dashboard-project-stack${bottomDockReservationActive ? " dashboard-project-stack--bottom-dock" : ""}`}
        data-testid="dashboard-project-stack"
        style={bottomDockReservationActive ? ({ "--bottom-dock-reservation": `${bottomDockReservationPx}px` } as CSSProperties) : undefined}
      >
      <div className={`dashboard-project-shell${sidebarActive ? " dashboard-project-shell--with-sidebar" : ""}${rightDockActive ? " dashboard-project-shell--with-right-dock" : ""}`} data-testid="dashboard-project-shell">
        {sidebarActive && (
          <LeftSidebarNav
            view={taskView}
            onChangeView={handleTaskViewChange}
            onNewTask={openNewTaskWithNav}
            onOpenSettings={openSettingsWithNav}
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
              ideationView: ideationEnabled,
              whiteboardView: whiteboardEnabled,
              goalsView: goalsEnabled,
            }}
            pluginDashboardViews={pluginDashboardViews}
            showAgentsTab={agentsEnabled}
            showSkillsTab={skillsEnabled}
            projects={effectiveProjects}
            currentProject={currentProject}
            onSelectProject={handleSelectProject}
            onViewAllProjects={handleViewAllProjects}
            footerVisible={shellFooterReservationVisible}
            /* FNXC:Navigation 2026-09-15-14:41: FN-419 gives the sidebar the engine control and Terminal action because `sidebar` placement removes the bottom bar entirely; the window-visibility toggle stays footer-only. */
            tasks={footerTasks}
            projectId={currentProject?.id}
            columnFlagsByTaskId={footerColumnFlagsByTaskId}
            onToggleTerminal={toggleTerminalWithNav}
          />
        )}
        <div
          className={`project-content${shellFooterReservationVisible && (!isMobile || !mobileKeyboardOpen) ? " project-content--with-footer" : ""}${mobileShellActive && mobileNavVisible && !(modalManager.anyModalOpen || taskView === "chat") ? " project-content--with-mobile-nav" : ""}`}
        >
          <AppMainPanelTaskDetailComposition
            state={mainPanelTaskDetail}
            mainContentProps={mainContentProps}
          />
          {mobileDrawerActive && currentProject && (
            <ProjectsDrawer
              open={projectsDrawerOpen}
              title={t("nav.projects", "Projects")}
              onClose={() => setProjectsDrawerOpen(false)}
            >
              <ProjectOverview
                projects={projects}
                loading={projectsLoading}
                onSelectProject={(project) => {
                  setProjectsDrawerOpen(false);
                  handleSelectProject(project);
                }}
                onAddProject={handleAddProject}
                onPauseProject={handlePauseProject}
                onResumeProject={handleResumeProject}
                onRemoveProject={handleRemoveProject}
                nodes={nodes}
              />
            </ProjectsDrawer>
          )}
          {/*
          FNXC:PlanningKeepAlive 2026-07-22-12:30:
          Kept-alive Planning Mode renders as a sibling of the MainContent switch inside .project-content (which is position:relative for the hidden out-of-flow overlay state). Keyed by project id + planningEntryGeneration so project switches and payload-carrying planning entry points remount with fresh-open semantics while plain navigation restores the live instance.
          */}
          {viewMode === "project" && currentProject && planningEverOpenedProjectId === currentProject.id && (
            isMobile ? (
              <PlanningDrawer
                open={planningViewActive && !modalManager.detailTask}
                title={t("nav.planning", "Planning")}
                onClose={() => {
                  modalManager.closePlanning();
                  handleTaskViewChange("board");
                }}
              >
                <PlanningKeepAlive
                  key={`${currentProject.id}:${modalManager.planningEntryGeneration}`}
                  active={planningViewActive}
                  /* FNXC:WorkflowControls 2026-09-16-23:24: FN-483 — le drawer Planning téléphone est hébergé au-dessus du Board de fond, qui possède déjà le slot. */
                  showWorkflowControls={!boardBackgroundActive}
                  projectId={currentProject.id}
                  tasks={tasks}
                  bgPlanningSessions={bgPlanningSessions}
                  modalManager={modalManager}
                  handleChangeTaskView={handleTaskViewChange}
                  handlePlanningTaskCreated={handlePlanningTaskCreated}
                  handlePlanningTasksCreated={handlePlanningTasksCreated}
                  openBoardTaskDetail={openBoardTaskDetail}
                />
              </PlanningDrawer>
            ) : (
              <PlanningKeepAlive
                key={`${currentProject.id}:${modalManager.planningEntryGeneration}`}
                active={planningViewActive}
                projectId={currentProject.id}
                tasks={tasks}
                bgPlanningSessions={bgPlanningSessions}
                modalManager={modalManager}
                handleChangeTaskView={handleTaskViewChange}
                handlePlanningTaskCreated={handlePlanningTaskCreated}
                handlePlanningTasksCreated={handlePlanningTasksCreated}
                openBoardTaskDetail={openBoardTaskDetail}
              />
            )
          )}
        </div>
        {rightDock.dock}
      </div>
      {wideFooterActive ? <DesktopActionBar entries={desktopNavigationEntries} activeId={desktopActiveNavigationId} tasks={footerTasks} projectId={currentProject?.id} columnFlagsByTaskId={footerColumnFlagsByTaskId} onToggleTerminal={toggleTerminalWithNav} /> : null}
      {/*
      FNXC:ToolSurfaces 2026-09-15-16:04:
      FN-426: the three navigation panels that replace right-dock-only hosting. Each mounts its body only while open,
      so a closed panel holds no polling or subscription; each delegates to the SAME owner its dock/page equivalent
      used (`notesController` + `openNoteInWindow` for Notes, `openSessionInNewWindow` for Chat), so opening a note or
      a conversation never creates a second editor, transcript, or session owner.
      */}
      {currentProject && !isMobile && toolPanel?.kind === "activity" ? (
        <DashboardToolPopover
          open
          onClose={closeToolPanel}
          anchorRect={toolPanel.anchorRect}
          id={ACTIVITY_TOOL_PANEL_ID}
          testId="activity-tool-popover"
          ariaLabel="Activity Log"
          width={520}
        >
          <ActivityLogModal
            isOpen
            onClose={closeToolPanel}
            tasks={boardSourceTasks as Task[]}
            projects={effectiveProjects}
            projectId={currentProject.id}
            onOpenTaskDetail={(taskId: string) => {
              closeToolPanel();
              const task = boardSourceTasks.find((candidate) => candidate.id === taskId);
              if (task) openDetailTask(task);
            }}
            presentation="embedded"
          />
        </DashboardToolPopover>
      ) : null}
      {/*
      FNXC:ToolSurfaces 2026-09-16-23:06:
      FN-435 : l'hôte de Notes est résolu par le point de rupture MESURÉ (`useViewportMode`), jamais par une supposition
      CSS, et il n'existe qu'UN SEUL propriétaire Notes à la fois. Sur tablette et ordinateur c'est cette popover, qui
      héberge la vue COMPLÈTE (rail liste + éditeur simultanés) et ne délègue plus à une fenêtre de note détachée :
      cliquer une note depuis cette popover n'ouvre plus de seconde fenêtre. Le raccourci Notes du dock optionnel
      conserve, lui, son `onOpenNote` — sa liste est volontairement sans détail et serait inerte sans cible.
      FN-437 retire la branche mobile (le tiroir `mobile-drawer-notes`) : le Header n'expose plus de déclencheur Notes
      sur téléphone, donc cet hôte n'avait plus aucune entrée. Le propriétaire mobile est désormais l'entrée
      `mobile-more-item-notes` du menu du pied de page, qui route vers la même `NotesView` plein écran dans
      `MainContentDrawer`, avec la même navigation interne liste ↔ éditeur — un seul propriétaire mobile au lieu de deux.
      La popover reçoit une hauteur définie pour la même raison que Chat : un parent à hauteur indéfinie ferait
      s'effondrer le rail et l'éditeur du layout deux panneaux.
      */}
      {currentProject && !isMobile && toolPanel?.kind === "notes" ? (
        <DashboardToolPopover
          open
          onClose={closeToolPanel}
          anchorRect={toolPanel.anchorRect}
          id={NOTES_TOOL_PANEL_ID}
          testId="notes-tool-popover"
          ariaLabel="Notes"
          width={760}
          preferredHeight={560}
        >
          <Suspense fallback={null}>
            <NotesView
              projectId={currentProject.id}
              addToast={addToast}
              controller={notesController}
              registerGuard={registerStandardNotesGuard}
              compact
            />
          </Suspense>
        </DashboardToolPopover>
      ) : null}
      {currentProject && toolPanel?.kind === "chat" ? (
        <DashboardToolPopover
          open
          onClose={closeToolPanel}
          anchorRect={toolPanel.anchorRect}
          id={CHAT_TOOL_PANEL_ID}
          testId="chat-tool-popover"
          ariaLabel="Conversations"
          /*
          FNXC:ToolSurfaces 2026-09-15-20:24:
          FN-433: only Chat asks for a definite height. Its conversation list is virtualized and measures its container,
          so an indefinite-height parent collapses the list to nothing; Activity and Notes stay content-sized.
          */
          preferredHeight={560}
          /*
          FNXC:ToolSurfaces 2026-09-15-22:15:
          FN-436 : exigence opérateur — la liste des conversations doit être quasiment collée à la bordure droite de
          l'écran. Son déclencheur `desktop-nav-chat-panel` n'est PAS la dernière action de la barre du bas (Terminal,
          Réglages et la bascule de visibilité des fenêtres le suivent), donc l'alignement par défaut sur l'ancre
          ouvrait la popover loin du bord. Seul cet hôte opte pour `viewport-end` ; Activité et Notes restent alignés
          sous leur bouton d'en-tête.
          */
          align="viewport-end"
        >
          <Suspense fallback={null}>
            <ChatView
              projectId={currentProject.id}
              addToast={addToast}
              experimentalFeatures={{ insights: insightsEnabled, memoryView: memoryEnabled, devServerView: devServerEnabled, researchView: researchEnabled, evalsView: evalsEnabled, goalsView: goalsEnabled }}
              /*
              FNXC:ToolSurfaces 2026-09-16-04:37:
              FN-447: ouvrir une conversation avec Ctrl/Cmd enfoncé, ou via l'action « Open in new window » du menu
              contextuel, ouvre la fenêtre SANS refermer la liste, pour que plusieurs conversations puissent être
              ouvertes d'affilée. Le clic simple continue de refermer la popover. Escape et le clic sur le backdrop
              restent les fermetures explicites de DashboardToolPopover.
              */
              onOpenSessionInNewWindow={(session, options) => { if (!options?.keepListOpen) closeToolPanel(); openSessionInNewWindow(session); }}
              openChatWindows={appRightDockWindows.openChatWindows}
              onSendAsReport={handleSendChatMessageAsReport}
              compactLayout
              listOnly
            />
          </Suspense>
        </DashboardToolPopover>
      ) : null}
      {/*
      FNXC:HistoryModalSurface 2026-09-15-04:29:
      FN-403: History no longer has a pilot-window host here. AppModals owns the single PatchnodeView instance,
      so no breakpoint can mount a second one and the current main view is never replaced on open.
      */}
      {/*
      FNXC:Terminal 2026-07-26-11:40:
      Mount the terminal ONLY while it is open. It used to be mounted for the whole session (visibility driven purely by `isOpen`), so a closed terminal still ran `useTerminalSessions` + `useTerminal`: a live PTY WebSocket, its heartbeat interval, and — because xterm is torn down on close, leaving no `onData` subscriber — an UNBOUNDED client-side buffer of every byte the shell emitted while the user was elsewhere. Background timers/sockets are a primary tab-discard signal on iOS Safari and Chrome Android, and the growing buffer is the memory pressure that triggers the discard; together they are why returning to the dashboard after a few minutes costs a full white-splash reload.
      This does NOT regress the "persist across tab switches" requirement: `terminalOpen` survives view switches, so switching views keeps the modal mounted and its buffer intact. Only an explicit close unmounts. Terminal tabs are server-side PTY sessions restored on reopen, with scrollback replayed by the server on reconnect.

      FNXC:Terminal 2026-07-26-14:10 (CORRECTION — the paragraph above originally ended "close already disposed xterm and its scrollback, so nothing is lost that closing did not already discard"; that was FALSE and must not be reasserted):
      Closing DID dispose xterm, but the WebSocket stayed open with zero `onData` subscribers, so `useTerminal`'s `initialBufferRef.current.data` accumulated EVERY byte emitted while closed and `onData()` replayed the whole array verbatim when xterm re-initialized on reopen. Reopen was therefore lossless for arbitrarily long closed-terminal output. It no longer is: unmounting closes the socket, and reopen now starts from the server's replay — `MAX_SCROLLBACK_SIZE = 50000` CHARACTERS in `packages/dashboard/src/terminal-service.ts` (~600-800 typical lines), not lines and not unbounded.
      Keeping the component mounted is nonetheless the WRONG repair, because the property it preserved was itself the defect: that buffer has no cap and is never drained while closed, so a long-running command (a watch build, `tail -f`) left in a closed terminal grows the heap without bound for as long as the app is open — strictly worse than losing scrollback, and precisely the memory pressure that gets the tab discarded. There is no in-component way to keep both properties: the buffer lives inside `useTerminal`, which cannot outlive the mount.
      The real ceiling is the server ring, and the correct place to recover the lost history is to raise `MAX_SCROLLBACK_SIZE` (the repo's own CLI-agent session ring is 512 KiB by comparison) or to bound-and-persist the client buffer outside the component. Both are outside this change's file scope; this comment records the deliberate, known trade so it is not rediscovered as a mystery.
      */}
      {currentProject && modalManager.terminalOpen && (
        <TerminalModal
          isOpen={modalManager.terminalOpen}
          onClose={closeTerminalWithNav}
          initialCommand={modalManager.terminalInitialCommand}
          initialCommandGeneration={modalManager.terminalInitialCommandGeneration}
          projectId={currentProject.id}
          footerVisible={terminalFooterVisible}
          onPinnedLayoutChange={handleTerminalPinnedLayoutChange}
          focusNonce={modalManager.terminalInitialCommandGeneration}
        />
      )}
      </div>
      {rightDock.modal}
      {executorFooterVisible && currentProject && (
        <ExecutorStatusBar
          tasks={footerTasks}
          projectId={currentProject.id}
          columnFlagsByTaskId={footerColumnFlagsByTaskId}
          staleHighFanoutBlockerAgeThresholdMs={staleHighFanoutBlockerAgeThresholdMs}
          lastFetchTimeMs={lastFetchTimeMs}
          currentProjectPath={currentProject.path}
          onOpenProjectDirectory={handleOpenProjectDirectory}
          keyboardOpen={footerKeyboardOpen}
          hideWhenKeyboardOpen={mobileKeyboardOpen}
          onToggleTerminal={toggleTerminalWithNav}
          onOpenScripts={openScriptsWithNav}
          onRunScript={runScriptWithNav}
        />
      )}
      {/*
      FNXC:Navigation 2026-09-16-17:41:
      FN-467: the phone pill and the shared tablet/desktop footer row read the SAME live project setting
      (`mobileNavPrimaryItems`), so a Settings preview before save reclassifies both surfaces at once instead of leaving
      the phone on a hard-coded list. The raw persisted value is passed through; MobileNavBar delegates every
      normalization step (legacy ids, dedup, cap, default fallback) to the core resolver.
      */}
      <MobileNavBar
        view={taskView}
        onChangeView={mobileNavVisible ? handleTaskViewChange : () => {}}
        footerVisible={executorFooterVisible}
        hidden={!mobileNavVisible}
        modalOpen={modalManager.anyModalOpen && !sharedModalDrawerOpen}
        keyboardOpen={mobileNavKeyboardOpen}
        keyboardMetrics={{ keyboardOverlap, viewportHeight, viewportOffsetTop }}
        quickAccessItems={mobileNavPrimaryItems}
        /* FNXC:MobileNavGesture 2026-09-17-16:53: FN-511 — sous cette option le hamburger n'est pas rendu et le glissement vers le haut ouvre le menu en tiroir. */
        menuGestureEnabled={mobileNavMenuSwipeGesture}
        /* FNXC:HeaderNavigationOwnership 2026-09-17-02:14: FN-481 — un accès déjà présent dans le Header ne revient ni dans la rangée ni dans « More ». */
        headerOwnedItems={headerOwnedNavigationItems}
        navigationMenuOpen={navigationMenuOpen}
        onUiMenuOpenChange={setUiMenuOpen}
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
        onViewAllProjects={openProjectsFromMobileNav}
        onRunScript={runScriptWithNav}
        projectId={currentProject?.id}
        showSkillsTab={skillsEnabled}
        experimentalFeatures={{
          insights: insightsEnabled,
          memoryView: memoryEnabled,
          devServer: devServerEnabled,
          devServerView: devServerEnabled,
          researchView: researchEnabled,
          evalsView: evalsEnabled,
          ideationView: ideationEnabled,
          whiteboardView: whiteboardEnabled,
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
      {desktopRightDockWindows}
      {/*
      FNXC:FloatingWindow 2026-06-22-20:45:
      One movable, resizable, non-blocking FloatingWindow per popped-out task. Each hosts the same embedded TaskDetailContent List/Board use, wired to the same App task handlers. Live row preferred by id; falls back to the snapshot. Terminal/destructive actions and the window close button both remove the entry. Multiple entries → multiple coexisting windows; FloatingWindow's per-window z-counter handles focus-to-front so the clicked one comes on top.

      FNXC:TaskDetail 2026-06-22-12:20:
      Task pop-outs use TaskDetailContent's own gray header as the only visible header, matching the one-header fixed task modal while keeping FloatingWindow drag/resize. The generic Maximize title chrome is hidden; close now lives beside edit inside the task header.

      FNXC:TaskPopupGeometry 2026-09-14-22:36:
      Every task-detail FloatingWindow keeps its per-task windowKey for DOM identity, dedupe, and z-index independence. FN-394 deleted durable window geometry: a task popup is NOT restored from a stored rectangle and no longer shares one with the other task popups. Each opening is its own — standard size, centred in the live work area — with separation supplied only by the shared manager-owned cascade of untouched windows.

      FNXC:TaskPopupLayer 2026-09-14-22:36:
      Task-detail, Chat, and utility windows share ONE stack since FN-394, so a newly opened window of any type comes in front and pointer/focus raises whichever surface the operator engages.

      FNXC:TaskWindowIdentity 2026-09-14-17:46:
      FN-392: every entry renders one window keyed by task id, and a view change mutates nothing here. The embedded task
      detail — including an open terminal WebSocket and any child dialog — stays mounted and visible as the operator
      moves through Board, List, Planning, Agents, Settings, Chat, and plugin views. Only a global hide suspends its
      reads; only a project change or the mobile drawer boundary closes it.
      */}
      <AppTaskPopoutWindows
        entries={poppedOutTaskEntries}
        liveTasks={tasks}
        onCloseTask={closePoppedOutTaskWithNav}
        windowProps={{
          projectId: currentProject?.id,
          tasks,
          globalPaused,
          onOpenDetail: popOutTaskDetailForCurrentView,
          /* FNXC:TaskRevert 2026-09-15-10:00 (FN-416): popped-out detail offers the same single restore-the-revert action as every other host. */
          onRestoreRevertTask: restoreTaskRevert,
          onDeleteTask: deleteTask,
          onMergeTask: mergeTask,
          onRetryTask: retryTask,
          onPauseTask: pauseTask,
          onUnpauseTask: unpauseTask,
          onBypassReview: bypassReview,
          onResetTask: resetTask,
          onDuplicateTask: duplicateTask,
          onRefinementCreated: (task) => ingestCreatedTasks([task]),
          addToast,
          prAuthAvailable,
          autoMergeEnabled: autoMerge,
          taskDetailDefaultTab,
        }}
      />
      <AppModals
        projectId={currentProject?.id}
        mobileDrawer={mobileDrawerActive}
        tasks={tasks}
        columnFlagsByTaskId={footerColumnFlagsByTaskId}
        globalPaused={globalPaused}
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
          handleGitHubImport,
        }}
        onRefinementCreated={(task) => ingestCreatedTasks([task])}
        onPlanningMode={openPlanningWithInitialPlanWithNav}
        onOpenChatWithPrefill={openChatWithPrefill}
        taskOperations={{ moveTask, deleteTask, mergeTask, revertTask, restoreTaskRevert, retryTask, pauseTask, unpauseTask, bypassReview, resetTask, duplicateTask }}
        deepLink={{ handleDetailClose }}
        settings={{ prAuthAvailable, autoMerge, showCostBadgeOnCards, taskDetailDefaultTab, chatMessageLayout, navigationPlacement: normalizeNavigationPlacement(navigationPlacement), rightSidebarEnabled, themeMode, colorTheme, uiStyle, dashboardFontScalePct, shadcnCustomColors, resolvedThemeMode, setThemeMode, setColorTheme, setUiStyle, setDashboardFontScalePct, setShadcnCustomColors, setChatMessageLayoutImmediate, setNavigationPlacementImmediate, setRightSidebarEnabledImmediate, setShowCostBadgeOnCardsImmediate, setTaskDetailDefaultTabImmediate, setMobileNavPrimaryItemsImmediate, setMobileNavMenuSwipeGestureImmediate }}
        onSettingsClose={handleSettingsCloseWithNav}
        onReopenOnboarding={reopenOnboardingWithNav}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onOpenWorkflowSettings={openWorkflowSettingsWithNav}
        onOpenApprovals={(_approvalId) => handleTaskViewChange("mailbox")}
        /*
        FNXC:HistoryModalSurface 2026-09-15-19:12:
        FN-428: History is itself a coexisting FloatingWindow, so activating one of its entries opens a coexisting task
        window (transparent, click-through overlay) and never the blocking presentation, which mounted
        `.floating-window-overlay--modal` and made History look closed while it was only veiled and inert. History stays
        mounted, interactive and unrefetched; Escape still closes the task window before History through
        `closeTopmostDashboardPopupForShortcut`. Detail lookup stays fail-soft for entries whose task is gone.
        */
        onOpenTaskDetailById={async (taskId) => {
          const task = await fetchTaskDetail(taskId, currentProject?.id);
          openTaskDetailInWindow(task);
        }}
        agentOnboardingEnabled={agentOnboardingEnabled}
      />
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
        </QuickAddSubmitOnEnterProvider>
      </ModalDismissPreferenceProvider>
      </ChatSubmitOnEnterProvider>
      </ChatMessageLayoutProvider>
    </ConfirmDialogProvider>
    </ViewLayoutProvider>
    </>
  );
}

export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ShellHostProvider>
          <ShellProvider>
            <NodeProvider>
              <DashboardWindowManagerProvider>
                <AppInner />
              </DashboardWindowManagerProvider>
            </NodeProvider>
          </ShellProvider>
        </ShellHostProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}
