/*
FNXC:MainContent 2026-06-24-00:00:
MainContent is the dashboard main-content router extracted from AppInner's render path. Its hook-free switch still owns every ordinary destination, while Board, List, and Chat yield to MainViewKeepAlive so visited project views preserve local state without remaining active behind another route. The lazy view chunks (and their leading-underscore inventory convention) stay declared in App.tsx per the docs guard and are threaded in as props; the eager ChatView.css import remains in App.tsx so the styles bundle into the main CSS file.
*/
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import type { NativeStructurePreviewResult, NativeStructureRef, Task, TaskDetail } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { ListView } from "../ListView";
import { MainPanelTaskDetailHost, type AppMainPanelTaskDetailState } from "../TaskDetailHostBoundaries";
import { applyLocalTaskPatch, mergeTaskSnapshot } from "../../hooks/useTasks";
import { ProjectOverview } from "../ProjectOverview";
import { MissionManager } from "../MissionManager";
import { MailboxView } from "../MailboxView";
import { IdeationPanel } from "../command-center/IdeationPanel";
import type { NativeStructureCandidate } from "../MessageComposer";
import { PageErrorBoundary } from "../ErrorBoundary";
import { BackendConnectionErrorPage } from "../BackendConnectionErrorPage";
import { HeaderWorkflowSwitcherSlot } from "../HeaderWorkflowSwitcherSlot";
import { GraphWorkflowSwitcherSlot, filterTasksByGraphWorkflowSelection } from "../GraphWorkflowSwitcherSlot";
import { PluginDashboardViewHost } from "../../plugins/PluginDashboardViewHost";
import { PluginDashboardHostChromeContext } from "../../plugins/PluginDashboardViewHeader";
import { buildPluginTaskViewId, getPluginViewId, isPluginViewId } from "../../plugins/pluginViewRegistry";
import { getPluginNavIcon } from "../pluginNavIcon";
import { isNearDuplicateCanonicalInactive } from "../../../../core/src/duplicates/near-duplicate-canonical";
import { fetchMission, fetchMissions, fetchInsights, fetchTaskDetail, listEvals } from "../../api";
import { attachNativeStructureRefToDrag } from "../../utils/nativeStructureDrag";
import type { DetailTaskTab } from "../../hooks/useModalManager";
import type { TaskView } from "../../hooks/useViewState";
import type { PluginDashboardViewEntry } from "../../api";
import type { SectionId } from "../SettingsModal";
import type { MainContentProps } from "./types";
import { MainViewKeepAlive, isKeepAliveMainViewId, type KeepAliveMainViewId } from "./MainViewKeepAlive";
import { MobileDrawer } from "../MobileDrawer";

/*
FNXC:CommandCenterAgentActivity 2026-08-10-01:54:
A monotonic request id makes repeated clicks for the same agent observable to AgentsView. Date.now() can collide in one millisecond and under frozen timers, silently losing the focus request.
*/
let agentAnchorRequestSeq = 0;
export function nextAgentAnchorRequestId(): number { return ++agentAnchorRequestSeq; }

/*
FNXC:WorkflowEditorEmbedding 2026-09-15-05:29:
FN-407 made the Workflows view the single workflow-editor surface. Entry points that name a workflow (a task's
Edit workflow) or a panel (Settings' Open workflow settings) hand those over as VIEW PARAMETERS rather than modal
state. Clearing them on unmount is what makes a later plain "Workflows" nav entry open clean instead of
resurrecting the previously preselected workflow. Declared at module scope so navigating away and back does not
remount the editor as a brand-new element type.
*/
function WorkflowsMainView({
  View,
  addToast,
  projectId,
  initialPanel,
  initialWorkflowId,
  onClose,
  onClearParams,
}: {
  View: MainContentProps["_WorkflowEditorView"];
  addToast: MainContentProps["addToast"];
  projectId?: string;
  initialPanel?: "settings";
  initialWorkflowId?: string;
  onClose: () => void;
  onClearParams: () => void;
}) {
  useEffect(() => onClearParams, [onClearParams]);
  return (
    <PageErrorBoundary>
      <Suspense fallback={null}>
        <View
          isOpen={true}
          onClose={onClose}
          addToast={addToast}
          projectId={projectId}
          initialPanel={initialPanel}
          initialWorkflowId={initialWorkflowId}
        />
      </Suspense>
    </PageErrorBoundary>
  );
}

const MOBILE_DRAWER_TITLES: Partial<Record<string, string>> = {
  "command-center": "Dashboard",
  planning: "Planning",
  chat: "Chat",
  mailbox: "Mailbox",
  list: "List",
  agents: "Agents",
  missions: "Missions",
  notes: "Notes",
  secrets: "Secrets",
  skills: "Skills & Snippets",
  insights: "Insights",
  memory: "Memory",
  research: "Research",
  evals: "Evals",
  ideation: "Ideation",
  goalsView: "Goals",
  "dev-server": "Dev Server",
  settings: "Settings",
  workflows: "Workflows",
  schedules: "Automation",
  "github-import": "Import from GitHub",
  /* FNXC:HistoryModalSurface 2026-09-15-04:29: FN-403 removed the `patchnode` entry — History never renders inside the main-content drawer; it owns its own modal/drawer surface. */
  "task-detail": "Task detail",
};

export function resolveMobileDrawerTitle(taskView: TaskView, pluginDashboardViews: PluginDashboardViewEntry[]): string {
  if (isPluginViewId(taskView)) {
    return pluginDashboardViews.find((entry) => buildPluginTaskViewId(entry.pluginId, entry.view.viewId) === taskView)?.view.label ?? "Plugin";
  }
  return MOBILE_DRAWER_TITLES[taskView] ?? "Workspace";
}

interface MainContentDrawerProps {
  taskView: TaskView;
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/*
FNXC:MobileDrawer 2026-09-10-23:59:
Ordinary and plugin destinations share this production bridge so header ownership is derived from the routed task view in one place. Browser smoke mounts this same bridge, preventing fixture copies from silently disagreeing with MainContent.
*/
export function MainContentDrawer({ taskView, open, title, onClose, children }: MainContentDrawerProps) {
  /*
  FNXC:StandardizedPluginViews 2026-09-13-22:40:
  When the drawer paints the fallback title for a plugin destination it owns that header, so the plugin
  host must contribute only actions and body. Publishing the same derivation both ways keeps one visual
  header authority per surface instead of stacking two titles.
  */
  const drawerOwnsHeader = isPluginViewId(taskView);
  return (
    <MobileDrawer
      open={open}
      title={title}
      onClose={onClose}
      keepMounted
      testId="mobile-drawer-main-content"
      contentOwnsHeader={!drawerOwnsHeader}
      contentOwnsScroll={false}
    >
      <PluginDashboardHostChromeContext.Provider value={{ hostOwnsHeader: drawerOwnsHeader }}>
        {children}
      </PluginDashboardHostChromeContext.Provider>
    </MobileDrawer>
  );
}

type AppOwnedMainPanelBinding =
  | "mainPanelDetailTask"
  | "mainPanelDetailInitialTab"
  | "setMainPanelDetailTask"
  | "openTaskDetailInMainPanel"
  | "closeTaskDetailMainPanel";

export type AppMainPanelTaskDetailMainContentProps = Omit<MainContentProps, AppOwnedMainPanelBinding>;

export interface AppMainPanelTaskDetailCompositionProps {
  state: AppMainPanelTaskDetailState;
  mainContentProps: AppMainPanelTaskDetailMainContentProps;
}

/*
FNXC:TaskDetailPresentation 2026-09-11-14:13:
The production MainContent composition owns the final projection of App's task-detail state. Tests mount this component directly so omitting or replacing the authoritative open, close, tab, snapshot, or setter binding breaks the same path App ships.
*/
export function AppMainPanelTaskDetailComposition({ state, mainContentProps }: AppMainPanelTaskDetailCompositionProps) {
  return (
    <MainContent
      {...mainContentProps}
      mainPanelDetailTask={state.task}
      mainPanelDetailInitialTab={state.initialTab}
      setMainPanelDetailTask={state.setTask}
      openTaskDetailInMainPanel={state.open}
      closeTaskDetailMainPanel={state.close}
    />
  );
}

/*
FNXC:ListInRightDock 2026-09-14-03:31:
FN-382: the List surface is defined ONCE here and mounted by two hosts — the main-content route (phone, and any
fallback route) and the non-mobile right dock. Extracting it keeps a single wiring of tasks, handlers, workflow
controls and Quick Entry, so reading or creating a task from the dock cannot drift from the dedicated view.
*/
export function MainContentListView(props: AppMainPanelTaskDetailMainContentProps & { listHost?: "route" | "dock" }) {
  const {
    tasks,
    isRemote,
    remoteData,
    currentProject,
    retryTask,
    onOpenChatWithPrefill,
    deleteTask,
    pauseTask,
    unpauseTask,
    revertTask,
    restoreTaskRevert,
    mergeTask,
    resetTask,
    duplicateTask,
    ingestCreatedTasks,
    openDetailTask,
    popOutTaskDetail,
    addToast,
    globalPaused,
    openNewTaskWithNav,
    availableModels,
    favoriteProviders,
    favoriteModels,
    handleToggleFavorite,
    handleToggleModelFavorite,
    searchQuery,
    lastFetchTimeMs,
    autoMerge,
    openMobileTasksInPopup,
    mergeStrategy,
  } = props;

  return (
    <PageErrorBoundary>
      <ListView
        tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
        projectId={currentProject?.id}
        onRetryTask={retryTask}
        onOpenChatWithPrefill={onOpenChatWithPrefill}
        onDeleteTask={deleteTask}
        onPauseTask={pauseTask}
        onUnpauseTask={unpauseTask}
        onRevertTask={revertTask}
        onRestoreRevertTask={restoreTaskRevert}
        onMergeTask={mergeTask}
        onResetTask={resetTask}
        onDuplicateTask={duplicateTask}
        /* FNXC:TaskRefine 2026-09-14-22:23: FN-400 — the row hosts its own Refine composer; only the created child comes back up. */
        onRefinementCreated={(task) => ingestCreatedTasks([task])}
        onOpenDetail={(task, options) => openDetailTask(task, undefined, options)}
        onPopOut={popOutTaskDetail}
        addToast={addToast}
        globalPaused={globalPaused}
        onNewTask={openNewTaskWithNav}
        availableModels={availableModels}
        favoriteProviders={favoriteProviders}
        favoriteModels={favoriteModels}
        onToggleFavorite={handleToggleFavorite}
        onToggleModelFavorite={handleToggleModelFavorite}
        searchQuery={searchQuery}
        lastFetchTimeMs={lastFetchTimeMs}
        autoMerge={autoMerge}
        openMobileTasksInPopup={openMobileTasksInPopup}
        mergeStrategy={mergeStrategy}
        /*
        FNXC:ListInRightDock 2026-09-14-05:12:
        Only the ROUTE host portals its workflow selector into the shared header slot. The dock host renders its own
        inline, otherwise the current destination and the dock would both publish a switcher into that slot and the
        header would carry two identical controls.
        */
        workflowControlsInHeader={props.listHost !== "dock"}
        compact={props.listHost === "dock"}
        /*
        FNXC:ListInRightDock 2026-09-14-08:05:
        Only ONE List instance may claim the shared header workflow slot. The dock host is never the active route, so
        it declares itself inactive; ListView portals its selector solely from the active route host, which is what
        kept the mobile header from showing the switcher twice.
        */
        active={props.listHost !== "dock"}
      />
    </PageErrorBoundary>
  );
}

export function MainContent(props: MainContentProps) {
  const {
  columnFlagsByTaskId,
  showBackendConnectionErrorPage,
  projectsError,
  t,
  retryingProjects,
  handleRetryProjects,
  shellApi,
  taskView,
  pluginDashboardViews,
  modalManager,
  /* FNXC:TaskRevert 2026-09-15-10:00 (FN-416): restore-the-revert reaches the main-panel detail host. */
  restoreTaskRevert,
  handleChangeTaskView,
  refreshAppSettings,
  addToast,
  currentProject,
  themeMode,
  setThemeMode,
  colorTheme,
  uiStyle,
  setUiStyle,
  setColorTheme,
  dashboardFontScalePct,
  setDashboardFontScalePct,
  shadcnCustomColors,
  setShadcnCustomColors,
  resolvedThemeMode,
  setChatMessageLayoutImmediate,
  setOpenTasksInRightSidebarImmediate,
  setOpenMobileTasksInPopupImmediate,
  setShowCostBadgeOnCardsImmediate,
  setTaskDetailChatFirstImmediate,
  setMobileNavPrimaryItemsImmediate,
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
  settingsLoaded,
  openTasksInRightSidebar,
  openMobileTasksInPopup,
  showCostBadgeOnCards,
  taskDetailChatFirst,
  chatMessageLayout,
  skillsEnabled,
  experimentalFeatures: _experimentalFeatures,
  mailComposerPrefill,
  onOpenChatWithPrefill,
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
  popOutTaskDetail,
  selectedPrId,
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
  mainPanelDetailTask,
  pauseTask,
  openTaskDetailInMainPanel,
  globalPaused,
  updateTask,
  retryTask,
  deleteTask,
  sidebarActive: _sidebarActive,
  chatPageHost,
  notesController,
  registerNotesGuard,
  isMobile,
  mainPanelDetailInitialTab,
  closeTaskDetailMainPanel,
  setMainPanelDetailTask,
  mergeTask,
  resetTask,
  duplicateTask,
  unpauseTask,
  AgentsView,
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
  _WorkflowEditorView,
  } = props;
  const [missionWorkflowId, setMissionWorkflowId] = useState<string | null>(null);
  const [nativeStructureCandidates, setNativeStructureCandidates] = useState<NativeStructureCandidate[]>([]);

  /*
  FNXC:NativeStructureEmbed 2026-07-20-14:30:
  The mailbox owns no structure data, so MainContent assembles its picker candidates from the
  existing project-scoped mission, insight, evaluation, and goal sources. Clear the prior project
  before loading to prevent attaching cross-project refs. Persist only refs and labels;
  NativeStructurePreview resolves current details lazily after the message is sent.
  */
  useEffect(() => {
    let active = true;
    const projectId = currentProject?.id;
    setNativeStructureCandidates([]);
    const ref = (kind: NativeStructureRef["kind"], id: string): NativeStructureRef => ({ kind, id, ...(projectId ? { projectId } : {}) });

    void Promise.all([
      fetchMissions(projectId).catch(() => []),
      fetchInsights({ limit: 100 }, projectId).catch(() => ({ insights: [], count: 0 })),
      listEvals({ limit: 100 }, projectId).catch(() => ({ results: [], count: 0 })),
      fetch(projectId ? `/api/goals?projectId=${encodeURIComponent(projectId)}` : "/api/goals")
        .then(async (response) => response.ok ? response.json() as Promise<{ goals?: Array<{ id: string; title: string }> }> : { goals: [] })
        .catch(() => ({ goals: [] })),
      fetch(projectId ? `/api/plugins/fusion-plugin-roadmap/roadmaps?projectId=${encodeURIComponent(projectId)}` : "/api/plugins/fusion-plugin-roadmap/roadmaps")
        .then(async (response) => response.ok ? response.json() as Promise<Array<{ id: string }>> : [])
        .catch(() => [] as Array<{ id: string }>),
    ]).then(async ([missions, insights, evals, goalsResponse, roadmaps]) => {
      const missionHierarchies = await Promise.all(missions.map(async (mission) => {
        try {
          return await fetchMission(mission.id, projectId);
        } catch {
          return undefined;
        }
      }));
      const roadmapHierarchies = await Promise.all(roadmaps.map(async (roadmap) => {
        try {
          const response = await fetch(`/api/plugins/fusion-plugin-roadmap/roadmaps/${encodeURIComponent(roadmap.id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
          return response.ok ? await response.json() as { milestones?: Array<{ features?: Array<{ id: string; title: string }> }> } : undefined;
        } catch {
          return undefined;
        }
      }));
      if (!active) return;

      const candidates: NativeStructureCandidate[] = [
        ...missions.map((mission) => ({ ref: ref("mission", mission.id), label: mission.title })),
        ...missionHierarchies.flatMap((mission) => mission?.milestones.map((milestone) => ({ ref: ref("milestone", milestone.id), label: milestone.title })) ?? []),
        ...insights.insights.map((insight) => ({ ref: ref("research-finding", insight.id), label: insight.title })),
        ...evals.results.map((result) => ({ ref: ref("eval-result", result.id), label: result.taskSnapshot.title || result.taskId })),
        ...(Array.isArray(goalsResponse.goals) ? goalsResponse.goals : []).map((goal) => ({ ref: ref("goal", goal.id), label: goal.title })),
        ...roadmapHierarchies.flatMap((roadmap) => roadmap?.milestones?.flatMap((milestone) => milestone.features ?? []) ?? []).map((feature) => ({ ref: ref("roadmap-item", feature.id), label: feature.title })),
      ];
      setNativeStructureCandidates(candidates);
    });

    return () => { active = false; };
  }, [currentProject?.id]);

  /*
  FNXC:NativeStructureEmbed 2026-07-20-12:00:
  Mail previews navigate through the dashboard's existing stateful destinations instead of URLs.
  Milestones retain their parent mission anchor when the lazy preview resolver supplies it.
  */
  const onOpenNativeStructure = useCallback((ref: NativeStructureRef, payload: NativeStructurePreviewResult) => {
    switch (ref.kind) {
      case "mission":
      case "milestone":
        setMissionTargetId(payload.available ? payload.openTarget.missionId ?? payload.openTarget.id : ref.id);
        handleChangeTaskView("missions");
        break;
      case "goal":
        setGoalAnchorId(ref.id);
        handleChangeTaskView("goalsView");
        break;
      case "research-finding":
        handleChangeTaskView("research");
        break;
      case "eval-result":
        handleChangeTaskView("evals");
        break;
      case "roadmap-item":
        // FNXC:NativeStructureEmbed 2026-08-09-05:13: Mail and chat must share the hosted Roadmaps destination; this switch previously drifted.
        handleChangeTaskView(getPluginViewId("fusion-plugin-roadmap", "roadmaps"));
        break;
    }
  }, [handleChangeTaskView, setGoalAnchorId, setMissionTargetId]);

  const projectKey = currentProject?.id ?? "all-projects";
  const mobileDrawerEnabled = isMobile && viewMode === "project" && currentProject !== null;
  /*
  FNXC:ChatSurfaceUnification 2026-09-15-14:41:
  `taskView="chat"` belongs to the main keep-alive tree only while THIS shell is the resolved primary Chat host:
  the mobile drawer, or (FN-419) the `sidebar` navigation placement where Chat is an ordinary main page like Notes.
  A dock-hosted shell still excludes Chat so a restored route or breakpoint transition cannot mount a second primary
  Chat behind the registry-backed window. The drawer WRAPPER stays strictly `mobileDrawerEnabled`: sidebar placement
  mounts Chat as a page, never inside a drawer.
  */
  const chatPageHostEnabled = mobileDrawerEnabled || chatPageHost === "sidebar-page";
  const selectedKeepAliveId: KeepAliveMainViewId | null = isKeepAliveMainViewId(taskView)
    ? taskView === "chat" && !chatPageHostEnabled ? null : taskView
    : taskView === "task-detail" && mainPanelDetailTask === null
      ? "board"
      : null;
  const earlyHidden = viewMode !== "project" || showBackendConnectionErrorPage;
  const [keepAliveViews, setKeepAliveViews] = useState<{ projectKey: string; ids: KeepAliveMainViewId[] }>(
    () => ({ projectKey, ids: [] }),
  );
  const storedKeepAliveIds = keepAliveViews.projectKey === projectKey ? keepAliveViews.ids : [];
  const previousIds = !chatPageHostEnabled && storedKeepAliveIds.includes("chat")
    ? storedKeepAliveIds.filter((id) => id !== "chat")
    : storedKeepAliveIds;
  const requiredKeepAliveIds = [
    ...(mobileDrawerEnabled ? ["board" as const] : []),
    ...(selectedKeepAliveId ? [selectedKeepAliveId] : []),
  ];
  const mountedKeepAliveIds = !earlyHidden
    ? requiredKeepAliveIds.reduce<KeepAliveMainViewId[]>(
        (ids, id) => ids.includes(id) ? ids : [...ids, id],
        previousIds,
      )
    : previousIds;
  if (keepAliveViews.projectKey !== projectKey || mountedKeepAliveIds !== keepAliveViews.ids) {
    setKeepAliveViews({ projectKey, ids: mountedKeepAliveIds });
  }

  /*
  FNXC:MainViewKeepAlive 2026-08-30-19:05:
  The overview and backend-error pages must deactivate retained views as well as hide them.
  Fold that early-hide condition into activeId here, rather than passing a second visibility input,
  so a hidden Board cannot retain the shared header slot and hidden Chat cannot mark messages read.

  FNXC:ChatSurfaceUnification 2026-09-14-12:57:
  Keep the mobile-drawer wrapper mounted across an early error so Chat state and DOM identity survive,
  but explicitly deactivate its Board background. A live drawer needs Board beneath it; an overview
  or connection error must instead release Board's shared header without reparenting retained Chat.
  */
  const activeKeepAliveId = earlyHidden ? null : selectedKeepAliveId;
  const closeMobileDrawer = () => {
    if (taskView === "task-detail") {
      closeTaskDetailMainPanel();
      return;
    }
    if (taskView === "settings") {
      modalManager.closeSettings();
      void refreshAppSettings();
    }
    handleChangeTaskView("board");
  };
  const mobileDrawerTitle = resolveMobileDrawerTitle(taskView, pluginDashboardViews);
  const mainViewKeepAlive = (
    <MainViewKeepAlive
      activeId={activeKeepAliveId}
      mountedIds={mountedKeepAliveIds}
      projectKey={projectKey}
      mainContentProps={props}
      mobileDrawer={mobileDrawerEnabled ? {
        activeId: modalManager.detailTask ? null : taskView === "list" || taskView === "chat" ? taskView : null,
        backgroundActive: !earlyHidden,
        title: mobileDrawerTitle,
        onClose: closeMobileDrawer,
      } : undefined}
    />
  );

  const renderSwitchView = () => {
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

  /*
  FNXC:Settings 2026-06-22-00:00:
  Settings renders ahead of the overview branch so the header gear opens the embedded Settings view even when no project is selected (viewMode === "overview"), matching the prior modal which opened regardless of view mode.

  FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
  Embedded Settings closes must refresh App-scoped settings before returning to the board. The openTasksInRightSidebar routing hook reads project settings through useAppSettings, so saving the Appearance toggle needs the same refresh path as the modal settings close to make board-card routing change immediately without a reload.
  */
  if (taskView === "settings") {
    const closeSettingsView = () => {
      modalManager.closeSettings();
      handleChangeTaskView("board");
      void refreshAppSettings();
    };
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <_SettingsView
            onClose={closeSettingsView}
            addToast={addToast}
            initialSection={modalManager.settingsInitialSection}
            projectId={currentProject?.id}
            themeMode={themeMode}
            colorTheme={colorTheme}
            uiStyle={uiStyle}
            onUiStyleChange={setUiStyle}
            onThemeModeChange={setThemeMode}
            onColorThemeChange={setColorTheme}
            dashboardFontScalePct={dashboardFontScalePct}
            shadcnCustomColors={shadcnCustomColors}
            resolvedThemeMode={resolvedThemeMode}
            onDashboardFontScaleChange={setDashboardFontScalePct}
            onShadcnCustomColorsChange={setShadcnCustomColors}
            chatMessageLayout={chatMessageLayout}
            onChatMessageLayoutChange={setChatMessageLayoutImmediate}
            openTasksInRightSidebar={openTasksInRightSidebar}
            onOpenTasksInRightSidebarChange={setOpenTasksInRightSidebarImmediate}
            openMobileTasksInPopup={openMobileTasksInPopup}
            onOpenMobileTasksInPopupChange={setOpenMobileTasksInPopupImmediate}
            showCostBadgeOnCards={showCostBadgeOnCards}
            onShowCostBadgeOnCardsChange={setShowCostBadgeOnCardsImmediate}
            taskDetailChatFirst={taskDetailChatFirst}
            onTaskDetailChatFirstChange={setTaskDetailChatFirstImmediate}
            onMobileNavPrimaryItemsChange={setMobileNavPrimaryItemsImmediate}
            onReopenOnboarding={reopenOnboardingWithNav}
            onOpenApprovals={() => handleChangeTaskView("mailbox")}
            /* FNXC:WorkflowEditorEmbedding 2026-09-15-05:29: FN-407 — the embedded Settings referral navigates to the Workflows view, exactly like the modal one. */
            onOpenWorkflowSettings={() => {
              closeSettingsView();
              modalManager.setWorkflowViewParams({ panel: "settings" });
              handleChangeTaskView("workflows");
            }}
          />
        </Suspense>
      </PageErrorBoundary>
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
  /*
  FNXC:TodoPluginEnablement 2026-08-03-16:00:
  Static bundled registrations make plugin chunks importable, not enabled. Only the project-scoped
  dashboard-views response may mount a plugin view, so a persisted legacy view cannot revive a
  disabled plugin and issue requests to an unavailable plugin API.
  */
  const enabledPluginView = resolvedPluginTaskView === null
    ? undefined
    : pluginDashboardViews.find(
      (entry) => resolvedPluginTaskView === `plugin:${entry.pluginId}:${entry.view.viewId}`,
    );

  // Project view
  if (resolvedPluginTaskView && enabledPluginView) {
    const pluginTasks = isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks;
    const isDependencyGraphView = resolvedPluginTaskView === "plugin:fusion-plugin-dependency-graph:graph";
    /*
    FNXC:GraphWorkflowSwitcher 2026-06-23-22:04:
    The dependency Graph is plugin-hosted, so App scopes the normal `tasks` array before it enters PluginDashboardViewHost instead of teaching the graph plugin about workflow metadata. This preserves the plugin context contract while matching Board/List workflow assignment fallback: `taskWorkflowIds[task.id] ?? defaultWorkflowId` must equal the selected header workflow.
    */
    const pluginContextTasks = isDependencyGraphView
      ? filterTasksByGraphWorkflowSelection(pluginTasks, currentProject?.id, graphWorkflowSelection)
      : pluginTasks;
    /*
    FNXC:GraphTaskPopout 2026-06-25-12:00:
    Dependency-graph task opens must share the movable, resizable FloatingWindow pop-out used by Board/List pop-out and artifact cards. Keep non-graph plugin views on the fixed task-detail modal so plugin contracts outside the Graph view do not change.
    */
    const openPluginTaskDetail = (task: Task | TaskDetail, initialTab?: DetailTaskTab) => {
      if (isDependencyGraphView) {
        popOutTaskDetail(task);
        return;
      }
      openDetailTask(task, initialTab);
    };
    return (
      <PageErrorBoundary>
        {isDependencyGraphView ? (
          <GraphWorkflowSwitcherSlot
            projectId={currentProject?.id}
            onWorkflowSelectionChange={setGraphWorkflowSelection}
          />
        ) : null}
        <PluginDashboardViewHost
          taskView={resolvedPluginTaskView as `plugin:${string}:${string}`}
          /*
          FNXC:StandardizedPluginViews 2026-09-13-16:30:
          Every enabled primary plugin destination is framed by the same host-owned ViewHeader and bounded ViewLayout. Resolution still comes exclusively from the existing project-scoped manifest list: this adds neither routes nor a registration for Reports.
          */
          layout={{
            title: enabledPluginView.view.label,
            icon: getPluginNavIcon(enabledPluginView.view.icon),
            contentOwnsScroll: isDependencyGraphView,
          }}
          context={{
            projectId: currentProject?.id,
            tasks: pluginContextTasks,
            /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: the same per-task trait map `renderTaskCard`
               below already uses. A plugin view that draws its OWN card (the dependency graph imports
               `TaskCard` directly) is a third producer that neither #3025 fix could reach, because this
               context exposed nothing about the board's vocabulary. */
            columnFlagsByTaskId,
            workflowSteps,
            subscribePluginEvents,
            openTaskDetail: openPluginTaskDetail,
            openFile: openFileInBrowser,
            beginNativeStructureDrag: attachNativeStructureRefToDrag,
            /* FNXC:NearDuplicateDetection 2026-08-23-04:53: Plugin-rendered cards share the duplicate tag contract, so forward the board update seam and keep the mark-as-read control available on this host. */
            renderTaskCard: (task: Task | TaskDetail) => (
              <TaskCard
                task={task}
                /* Plugin-rendered cards resolved NO traits before this: every role helper inside the
                   card fell back to the legacy id for any view using `renderTaskCard`. */
                taskColumnFlags={columnFlagsByTaskId?.get(task.id)}
                projectId={currentProject?.id}
                onOpenDetail={openPluginTaskDetail}
                onOpenChatWithPrefill={onOpenChatWithPrefill}
                addToast={addToast}
                onUpdateTask={updateTask}
                prAuthAvailable={prAuthAvailable}
                autoMergeEnabled={autoMerge}
                nearDuplicateCanonicalInactive={typeof task.sourceMetadata?.nearDuplicateOf === "string"
                  ? (() => {
                    /* FNXC:WorkflowResolvedColumns 2026-07-30-01:10: the canonical's own flags, from
                       the per-task map this component already threads to its other children. */
                    const canonical = pluginContextTasks.find((candidate) => candidate.id === task.sourceMetadata?.nearDuplicateOf);
                    return isNearDuplicateCanonicalInactive(canonical, canonical ? columnFlagsByTaskId?.get(canonical.id) : undefined);
                  })()
                  : undefined}
              />
            ),
            addToast,
            openPlanningMode: openPlanningWithInitialPlanWithNav,
            onTaskCreated: (task) => ingestCreatedTasks([task]),
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

  /*
  FNXC:SnippetsDestination 2026-09-14-04:12:
  Snippets is its own destination beside Skills, gated by the same feature flag: both are chat/skill authoring tools
  and neither should appear when that capability is off.
  */
  if (taskView === "snippets") {
    if (!settingsLoaded || !skillsEnabled) {
      return null;
    }
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <SnippetsView onClose={() => handleChangeTaskView("board")} />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  if (taskView === "chat") {
    /*
    FNXC:MainViewKeepAlive 2026-08-30-19:05:
    Embedded Chat yields ownership to the retained host, keyed by project there so project changes
    still reset conversations while ordinary navigation only hides the live instance.
    */
    return null;
  }

  if (taskView === "mailbox") {
    return (
      <PageErrorBoundary>
        <MailboxView
          projectId={currentProject?.id}
          addToast={addToast}
          /*
          FNXC:ArtifactRegistry 2026-07-12-00:00: Artifact-registration mail notifications open their producing task through the shared task-detail fetch path so the mailbox does not invent a separate deep-link scheme.

          FNXC:ArtifactRegistry 2026-07-13-00:00: Mailbox artifact "View task" opens the producing task in the shared movable/resizable popped-out task-detail FloatingWindow (`popOutTaskDetail`) instead of the docked `openDetailTask` modal, so the modal has full resize/move parity.
          */
          onOpenTask={(taskId) => {
            void fetchTaskDetail(taskId, currentProject?.id)
              .then((task) => popOutTaskDetail(task))
              .catch(() => addToast?.("Failed to open task", "error"));
          }}
          /*
          FNXC:MailboxRelatedWork 2026-07-20-09:30:
          FN-8428 planning-clarification messages must resume the exact session and make the
          Planning surface visible. Opening only the modal-manager state would leave the mailbox
          selected, hiding the session the operator needs to answer.
          */
          onOpenPlanningSession={(sessionId) => {
            modalManager.openPlanningWithSession(sessionId);
            handleChangeTaskView("planning");
          }}
          onUnreadCountChange={setMailboxUnreadCount}
          onOpenNativeStructure={onOpenNativeStructure}
          nativeStructureCandidates={nativeStructureCandidates}
          composePrefill={mailComposerPrefill ?? undefined}
        />
      </PageErrorBoundary>
    );
  }


  if (taskView === "missions") {
    return (
      <PageErrorBoundary>
        {/*
        FNXC:MissionWorkflows 2026-06-25-00:00:
        Missions intentionally shares Planning's header workflow-selection surface because feature and slice triage create tasks. Keep the selected workflow local to this project view and thread only the resolved id into mission task creation.

        FNXC:WorkflowAggregation 2026-07-01-00:00:
        The All workflows row is view-only context for Missions; mission task creation receives `null` default behavior instead of the aggregate sentinel.
        */}
        <HeaderWorkflowSwitcherSlot
          projectId={currentProject?.id}
          onWorkflowSelectionChange={(selection) => setMissionWorkflowId(selection && !selection.isAllWorkflowsSelected ? selection.selectedWorkflow.id : null)}
        />
        {/*
        FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
        Key Missions by project. MissionManager refetches its list on projectId change, but its
        nested always-mounted MissionInterviewModal (and the interviewTarget-driven
        MilestoneSliceInterviewModal) did not reset: their resume/connect effects re-fired on
        the new projectId and reconnected the PREVIOUS project's interview session under the
        new project, and close persisted the goal draft under the new project's
        kb-mission-last-goal key. The remount unmounts both modals (stream cleanup runs) and
        clears showInterviewModal/interviewTarget with fresh state.
        */}
        <MissionManager
          key={currentProject?.id ?? "all-projects"}
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
          workflowId={missionWorkflowId}
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
            focusAgent={agentAnchor}
          />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  if (taskView === "notes") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          {/* FNXC:DesktopRightDock 2026-09-11-22:51: The standard Notes page must replace any retained compact-dock guard after a desktop-to-tablet transition. Its live dirty-state closure remains authoritative when the draft becomes dirty only after the transition. */}
          <NotesView projectId={currentProject?.id} addToast={addToast} controller={notesController} registerGuard={registerNotesGuard} />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  if (taskView === "whiteboard") {
    if (!settingsLoaded || !whiteboardEnabled) return null;
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <WhiteboardView projectId={currentProject?.id} addToast={addToast} />
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
            onOpenSettings={(section) => openSettingsWithNav(section as SectionId)}
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
            onOpenSettings={(section) => openSettingsWithNav(section as SectionId)}
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

  if (taskView === "ideation") {
    if (!settingsLoaded || !ideationEnabled) {
      return null;
    }
    return (
      <PageErrorBoundary>
        <IdeationPanel projectId={currentProject?.id} />
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
          <SecretsView addToast={addToast} projectId={currentProject?.id} />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  /*
  FNXC:HistoryModalSurface 2026-09-15-04:29:
  FN-403: `patchnode` is no longer a main-content destination. History is a modal surface owned by
  useModalManager and rendered exactly once by AppModals, so this switch deliberately has no History branch;
  App coerces any residual `patchnode` view request into opening that modal.
  */

  if (taskView === "goalsView") {
    if (!settingsLoaded || !goalsEnabled) {
      return null;
    }
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <GoalsView anchorGoalId={goalAnchorId} projectId={currentProject?.id} onNavigateToMission={handleOpenMission} />
        </Suspense>
      </PageErrorBoundary>
    );
  }
  if (taskView === "command-center") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <CommandCenter
            projectId={currentProject?.id}
            colorTheme={colorTheme}
            uiStyle={uiStyle}
            onUiStyleChange={setUiStyle}
            themeMode={themeMode}
            shadcnCustomColors={shadcnCustomColors}
            resolvedThemeMode={resolvedThemeMode}
            onColorThemeChange={setColorTheme}
            onThemeModeChange={setThemeMode}
            onShadcnCustomColorsChange={setShadcnCustomColors}
            addToast={addToast}
            nodesEnabled={nodesEnabled}
            onChangeView={handleChangeTaskView}
            onOpenAgent={(agentId) => {
              setAgentAnchor?.({ agentId, requestId: nextAgentAnchorRequestId() });
              handleChangeTaskView("agents");
            }}
            onOpenTask={(taskId) => {
              void fetchTaskDetail(taskId, currentProject?.id)
                .then((task) => openDetailTask(task as TaskDetail))
                .catch(() => addToast?.("Failed to open task", "error"));
            }}
          />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  if (taskView === "planning") {
    /*
    FNXC:Navigation 2026-06-21-00:00:
    FN-6886 renders Planning Mode as a top-level main-content destination. Sidebar navigation opens an empty planning view, while Board, Todos, inline create, and resume entry points carry their initial plan/workflow/session state through modalManager.

    FNXC:PlanningKeepAlive 2026-07-22-12:30:
    The planning subtree no longer renders from this switch. App.tsx mounts <PlanningKeepAlive> as a kept-alive sibling of MainContent inside .project-content (after Planning's first open), so navigating away hides it instead of unmounting the interview. This branch returns null so the switch contributes nothing while the keep-alive layer is the visible view.
    Project-switch remount and one-shot initialPlan consumption (main's ProjectSwitchModalReset / PlanningMode notes) live on PlanningKeepAlive + modalManager.clearPlanningInitialPlan, not here.
    */
    return null;
  }

  /*
  FNXC:Navigation 2026-09-15-05:29:
  Workflows, Import Tasks (GitHub import), and Automations are left-sidebar destinations that render embedded in the main content area instead of as modal overlays. Closing returns to the board.
  FN-407: Workflows is now the ONLY presentation of the workflow editor — AppModals no longer mounts a modal copy — so every entry point converges here. Import Tasks and Automations still have a modal twin for the mobile overflow path.
  */
  if (taskView === "workflows") {
    return (
      <WorkflowsMainView
        View={_WorkflowEditorView}
        addToast={addToast}
        projectId={currentProject?.id}
        initialPanel={modalManager.workflowViewPanel}
        initialWorkflowId={modalManager.workflowViewWorkflowId}
        onClose={() => handleChangeTaskView("board")}
        onClearParams={modalManager.clearWorkflowViewParams}
      />
    );
  }

  if (taskView === "import-tasks") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <_ImportTasksView
            isOpen={true}
            onClose={() => handleChangeTaskView("board")}
            onImport={handleGitHubImport}
            onPlanningMode={openPlanningWithInitialPlanWithNav}
            onOpenChatWithPrefill={onOpenChatWithPrefill}
            tasks={tasks}
            projectId={currentProject?.id}
            presentation="embedded"
          />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  if (taskView === "automations") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <_AutomationsView
            onClose={() => handleChangeTaskView("board")}
            addToast={addToast}
            projectId={currentProject?.id}
            presentation="embedded"
          />
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
          <DevServerView tasks={tasks} addToast={addToast} projectId={currentProject?.id} columnFlagsByTaskId={columnFlagsByTaskId} />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  /*
  FNXC:Navigation 2026-06-22-00:00:
  Board-opened task detail renders as a full main-content view that replaces the board. A Back-to-board button sits above an embedded TaskDetailContent (same props ListView passes to its split-detail pane). The live task is preferred from `tasks` by id so the detail updates on revalidation; the stored snapshot is the fallback. If neither resolves (snapshot cleared), fall back to the board so the panel is never blank.

  FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
  Both Board render sites use App's setting-aware board-open handler. That keeps this switch presentational while ensuring only Board card clicks can route into the right dock; deep-tab, list, plugin, and modal task-open paths continue to call their existing handlers.
  */
  if (taskView === "task-detail") {
    const boardTask = mainPanelDetailTask
      ? tasks.find((candidate) => candidate.id === mainPanelDetailTask.id)
      : undefined;
    const liveDetailTask = mainPanelDetailTask
      ? (boardTask ? mergeTaskSnapshot(mainPanelDetailTask, boardTask) : mainPanelDetailTask)
      : null;
    if (!liveDetailTask) {
      /*
      FNXC:MainViewKeepAlive 2026-08-30-19:05:
      Empty task detail returns to the already-retained Board rather than mounting a second Board.
      selectedKeepAliveId treats this fallback as Board ownership before this switch executes.
      */
      return null;
    }
    return (
      <PageErrorBoundary>
        {/*
        FNXC:MobileDrawerMotion 2026-09-12-20:37:
        Standard mobile Task Detail owns its bottom-edge transition here. With the mobile shell, the shared
        drawer shell is the sole animated surface, preventing nested content from moving twice;
        dismissal and navigation callbacks remain synchronous and unchanged.
        */}
        <MainPanelTaskDetailHost
              task={liveDetailTask}
              projectId={currentProject?.id}
              tasks={tasks}
              globalPaused={globalPaused}
              initialTab={mainPanelDetailInitialTab}
              /*
              FNXC:TaskDetailHostOwnership 2026-09-13-16:30:
              MainContent remains the navigation owner while canonical Task Detail chrome chooses ChevronLeft on phone and Close on desktop/tablet. The outer drawer contributes only its handle, never a second return control.
              */
              onNavigateToBoard={closeTaskDetailMainPanel}
              presentation={mobileDrawerEnabled ? "drawer" : "panel"}
              mobileTransition={isMobile && !mobileDrawerEnabled}
              /* FNXC:FloatingWindow 2026-06-22-21:10: Popping out from the board's full-panel detail also returns the main panel to the board, so the board (not the emptied detail) sits behind the floating window. */
              onPopOut={(task) => { popOutTaskDetail(task); closeTaskDetailMainPanel(); }}
              onOpenDetail={(value, initialTab) => openTaskDetailInMainPanel(value, initialTab ?? "chat")}
              onDeleteTask={deleteTask}
              onRestoreRevertTask={restoreTaskRevert}
              onMergeTask={mergeTask}
              onRetryTask={retryTask}
              onOpenChatWithPrefill={onOpenChatWithPrefill}
              onPauseTask={pauseTask}
              onUnpauseTask={unpauseTask}
            onResetTask={resetTask}
              onDuplicateTask={duplicateTask}
              /* FNXC:Navigation 2026-06-22-09:00: MainPanelTaskDetailHost routes destructive and explicit exits through the same Board navigation owner. */
              onRefinementCreated={(task) => ingestCreatedTasks([task])}
              onTaskUpdated={(updatedTask) => {
                setMainPanelDetailTask((previous) => {
                  if (!previous || (updatedTask.id !== undefined && updatedTask.id !== previous.id)) return previous;
                  return applyLocalTaskPatch(previous, { ...updatedTask, id: previous.id });
                });
              }}
              addToast={addToast}
              prAuthAvailable={prAuthAvailable}
              autoMergeEnabled={autoMerge}
              taskDetailChatFirst={taskDetailChatFirst}
            />
      </PageErrorBoundary>
    );
  }

  if (taskView === "board") {
    /*
    FNXC:MainViewKeepAlive 2026-08-30-19:05:
    The canonical Board route yields ownership to MainViewKeepAlive. Its capacity banner remains
    a sibling inside that host, so hidden Board state cannot leave standalone visible chrome.
    */
    return null;
  }

  // List remains the fallback for disabled destinations that do not own a dedicated switch branch.
  if (taskView === "list") {
    /*
    FNXC:MainViewKeepAlive 2026-08-30-19:05:
    The canonical List route yields ownership to the retained host. Non-list fallback routes still
    render this switch-owned ListView, so a disabled feature cannot create a duplicate retained list.
    */
    return null;
  }
  return <MainContentListView {...props} />;
  };

  const switchView = renderSwitchView();
  const switchUsesMobileDrawer = mobileDrawerEnabled
    && taskView !== "board"
    && taskView !== "list"
    && taskView !== "chat"
    && taskView !== "planning"
    && switchView !== null;

  return (
    <>
      {mainViewKeepAlive}
      {switchUsesMobileDrawer ? (
        <MainContentDrawer
          taskView={taskView}
          open={!modalManager.detailTask}
          title={mobileDrawerTitle}
          onClose={closeMobileDrawer}
        >
          {switchView}
        </MainContentDrawer>
      ) : switchView}
    </>
  );
}
