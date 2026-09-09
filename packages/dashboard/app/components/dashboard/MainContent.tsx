/*
FNXC:MainContent 2026-06-24-00:00:
MainContent is the dashboard main-content router extracted from AppInner's render path. Its hook-free switch still owns every ordinary destination, while Board, List, and Chat yield to MainViewKeepAlive so visited project views preserve local state without remaining active behind another route. The lazy view chunks (and their leading-underscore inventory convention) stay declared in App.tsx per the docs guard and are threaded in as props; the eager ChatView.css import remains in App.tsx so the styles bundle into the main CSS file.
*/
import { Suspense, useCallback, useEffect, useState } from "react";
import type { NativeStructurePreviewResult, NativeStructureRef, Task, TaskDetail } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { ListView } from "../ListView";
import { TaskDetailContent } from "../TaskDetailModal";
import { applyLocalTaskPatch, mergeTaskSnapshot } from "../../hooks/useTasks";
import { ProjectOverview } from "../ProjectOverview";
import { MissionManager } from "../MissionManager";
import { MailboxView } from "../MailboxView";
import { RecommendationsView } from "../RecommendationsView";
import { IdeationPanel } from "../command-center/IdeationPanel";
import type { NativeStructureCandidate } from "../MessageComposer";
import { PageErrorBoundary } from "../ErrorBoundary";
import { BackendConnectionErrorPage } from "../BackendConnectionErrorPage";
import { HeaderWorkflowSwitcherSlot } from "../HeaderWorkflowSwitcherSlot";
import { GraphWorkflowSwitcherSlot, filterTasksByGraphWorkflowSelection } from "../GraphWorkflowSwitcherSlot";
import { PluginDashboardViewHost } from "../../plugins/PluginDashboardViewHost";
import { getPluginViewId, isPluginViewId } from "../../plugins/pluginViewRegistry";
import { isNearDuplicateCanonicalInactive } from "../../../../core/src/duplicates/near-duplicate-canonical";
import { fetchMission, fetchMissions, fetchInsights, fetchTaskDetail, listEvals } from "../../api";
import { attachNativeStructureRefToDrag } from "../../utils/nativeStructureDrag";
import type { DetailTaskTab } from "../../hooks/useModalManager";
import type { SectionId } from "../SettingsModal";
import type { MainContentProps } from "./types";
import { MainViewKeepAlive, isKeepAliveMainViewId, type KeepAliveMainViewId } from "./MainViewKeepAlive";

/*
FNXC:CommandCenterAgentActivity 2026-08-10-01:54:
A monotonic request id makes repeated clicks for the same agent observable to AgentsView. Date.now() can collide in one millisecond and under frozen timers, silently losing the focus request.
*/
let agentAnchorRequestSeq = 0;
export function nextAgentAnchorRequestId(): number { return ++agentAnchorRequestSeq; }

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
  setChatMessageLayoutImmediate,
  setOpenTasksInRightSidebarImmediate,
  setOpenMobileTasksInPopupImmediate,
  setTaskPopupsBoardListOnlyImmediate,
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
  mergeStrategy,
  settingsLoaded,
  openTasksInRightSidebar,
  openMobileTasksInPopup,
  taskPopupsBoardListOnly,
  showCostBadgeOnCards,
  taskDetailChatFirst,
  chatMessageLayout,
  skillsEnabled,
  mailComposerPrefill,
  onOpenChatWithPrefill,
  setMailboxUnreadCount,
  recommendationUnreadCount,
  artifactUnreadCount,
  onMarkCategorySeen,
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
  memoryEnabled,
  goalsEnabled,
  handleOpenMission,
  openPlanningWithInitialPlanWithNav,
  ingestCreatedTasks,
  nodesEnabled,
  openWorkflowEditorWithNav,
  handleGitHubImport,
  devServerEnabled,
  mainPanelDetailTask,
  moveTask,
  pauseTask,
  openTaskDetailInMainPanel,
  handleBoardQuickCreate,
  openNewTaskWithNav,
  globalPaused,
  updateTask,
  retryTask,
  revertTask,
  deleteTask,
  searchQuery,
  availableModels,
  favoriteProviders,
  favoriteModels,
  handleToggleFavorite,
  handleToggleModelFavorite,
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
  AgentsView,
  CommandCenter,
  DevServerView,
  DocumentsView,
  EvalsView,
  GoalsView,
  PatchnodeView,
  InsightsView,
  MemoryView,
  PullRequestView,
  ResearchView,
  SecretsView,
  SkillsView,
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
  const selectedKeepAliveId: KeepAliveMainViewId | null = isKeepAliveMainViewId(taskView)
    ? taskView
    : taskView === "task-detail" && mainPanelDetailTask === null
      ? "board"
      : null;
  const earlyHidden = viewMode !== "project" || showBackendConnectionErrorPage;
  const [keepAliveViews, setKeepAliveViews] = useState<{ projectKey: string; ids: KeepAliveMainViewId[] }>(
    () => ({ projectKey, ids: [] }),
  );
  const previousIds = keepAliveViews.projectKey === projectKey ? keepAliveViews.ids : [];
  const mountedKeepAliveIds = !earlyHidden && selectedKeepAliveId && !previousIds.includes(selectedKeepAliveId)
    ? [...previousIds, selectedKeepAliveId]
    : previousIds;
  if (keepAliveViews.projectKey !== projectKey || mountedKeepAliveIds !== keepAliveViews.ids) {
    setKeepAliveViews({ projectKey, ids: mountedKeepAliveIds });
  }

  /*
  FNXC:MainViewKeepAlive 2026-08-30-19:05:
  The overview and backend-error pages must deactivate retained views as well as hide them.
  Fold that early-hide condition into activeId here, rather than passing a second visibility input,
  so a hidden Board cannot retain the shared header slot and hidden Chat cannot mark messages read.
  */
  const activeKeepAliveId = earlyHidden ? null : selectedKeepAliveId;
  const mainViewKeepAlive = (
    <MainViewKeepAlive
      activeId={activeKeepAliveId}
      mountedIds={mountedKeepAliveIds}
      projectKey={projectKey}
      mainContentProps={props}
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
            onThemeModeChange={setThemeMode}
            onColorThemeChange={setColorTheme}
            dashboardFontScalePct={dashboardFontScalePct}
            shadcnCustomColors={shadcnCustomColors}
            resolvedThemeMode={resolvedThemeMode}
            onDashboardFontScaleChange={setDashboardFontScalePct}
            onShadcnCustomColorsChange={setShadcnCustomColors}
            onQuickChatButtonModeChange={setQuickChatButtonModeImmediate}
            chatMessageLayout={chatMessageLayout}
            onChatMessageLayoutChange={setChatMessageLayoutImmediate}
            openTasksInRightSidebar={openTasksInRightSidebar}
            onOpenTasksInRightSidebarChange={setOpenTasksInRightSidebarImmediate}
            openMobileTasksInPopup={openMobileTasksInPopup}
            onOpenMobileTasksInPopupChange={setOpenMobileTasksInPopupImmediate}
            taskPopupsBoardListOnly={taskPopupsBoardListOnly}
            onTaskPopupsBoardListOnlyChange={setTaskPopupsBoardListOnlyImmediate}
            showCostBadgeOnCards={showCostBadgeOnCards}
            onShowCostBadgeOnCardsChange={setShowCostBadgeOnCardsImmediate}
            taskDetailChatFirst={taskDetailChatFirst}
            onTaskDetailChatFirstChange={setTaskDetailChatFirstImmediate}
            onMobileNavPrimaryItemsChange={setMobileNavPrimaryItemsImmediate}
            onReopenOnboarding={reopenOnboardingWithNav}
            onOpenApprovals={() => handleChangeTaskView("mailbox")}
            onOpenWorkflowSettings={() => {
              closeSettingsView();
              modalManager.openWorkflowEditor("settings");
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
  const isEnabledPluginTaskView = resolvedPluginTaskView !== null && pluginDashboardViews.some(
    (entry) => resolvedPluginTaskView === `plugin:${entry.pluginId}:${entry.view.viewId}`,
  );

  // Project view
  if (resolvedPluginTaskView && isEnabledPluginTaskView) {
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
            onOpenWorkflowEditor={openWorkflowEditorWithNav}
            onCreateWorkflow={openCreateWorkflowWithNav}
            onWorkflowSelectionChange={setGraphWorkflowSelection}
          />
        ) : null}
        <PluginDashboardViewHost
          taskView={resolvedPluginTaskView as `plugin:${string}:${string}`}
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

          FNXC:ArtifactRegistry 2026-07-13-00:00: Mailbox artifact "View task" opens the producing task in the shared movable/resizable popped-out task-detail FloatingWindow (`popOutTaskDetail`), matching DocumentsView's artifact-task path instead of the docked `openDetailTask` modal, so the modal has full resize/move parity.
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


  if (taskView === "recommendations") {
    return (
      <PageErrorBoundary>
        <RecommendationsView
          projectId={currentProject?.id}
          addToast={addToast}
          unreadCount={recommendationUnreadCount}
          onSeen={() => void onMarkCategorySeen("recommendation")}
          onOpenTask={(taskId) => {
            void fetchTaskDetail(taskId, currentProject?.id)
              .then((task) => popOutTaskDetail(task))
              .catch(() => addToast?.("Failed to open task", "error"));
          }}
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
          onOpenWorkflowEditor={openWorkflowEditorWithNav}
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

  if (taskView === "documents") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <DocumentsView
            projectId={currentProject?.id}
            columnFlagsByTaskId={columnFlagsByTaskId}
            addToast={addToast}
            onOpenDetail={openDetailTask}
            onOpenArtifactTaskDetail={popOutTaskDetail}
            onSendSelectionToTask={modalManager.openNewTaskWithDescription}
            artifactUnreadCount={artifactUnreadCount}
            onSeen={() => void onMarkCategorySeen("artifact")}
          />
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

  if (taskView === "patchnode") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <PatchnodeView
            projectId={currentProject?.id}
            onOpenTaskDetail={(taskId) => fetchTaskDetail(taskId, currentProject?.id)
              .then((task) => openDetailTask(task as TaskDetail))
              .catch(() => undefined)}
          />
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
  FNXC:Navigation 2026-06-22-00:00:
  Workflows, Import Tasks (GitHub import), and Automations are left-sidebar destinations that render embedded in the main content area instead of as modal overlays. Closing returns to the board. The same components still mount as modals in AppModals for the mobile overflow path.
  */
  if (taskView === "workflows") {
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <_WorkflowEditorView
            isOpen={true}
            onClose={() => handleChangeTaskView("board")}
            addToast={addToast}
            projectId={currentProject?.id}
            presentation="embedded"
          />
        </Suspense>
      </PageErrorBoundary>
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
        FNXC:TaskDetailSwipeBack 2026-07-05-12:30:
        FN-7587 — presentation-only predictive-back polish layered on top of the unchanged
        FN-7583/FN-7586 dismissal routing (popstate / fusion:native-back / useNavigationHistory
        stack). The `--mobile-transition` modifier only adds a CSS enter animation gated to the
        existing `isMobile` prop; it never defers or reorders when onRequestClose/onBackToBoard
        fire, and honors prefers-reduced-motion (see styles.css).
        */}
        <div className={`task-detail-main-panel${isMobile ? " task-detail-main-panel--mobile-transition" : ""}`}>
          <div className="task-detail-main-panel-body">
            <TaskDetailContent
              task={liveDetailTask}
              projectId={currentProject?.id}
              tasks={tasks}
              globalPaused={globalPaused}
              embedded
              initialTab={mainPanelDetailInitialTab}
              /*
              FNXC:TaskDetail 2026-06-22-18:40:
              Board-card detail (full main panel) renders its "Back to board" affordance inside TaskDetailContent's gray header (far right, across from the task id) instead of a separate back-row above the content. The prop only renders the header back button when both embedded and onBackToBoard are present, so ListView split-pane and modal usages stay unaffected.
              */
              onBackToBoard={closeTaskDetailMainPanel}
              /* FNXC:FloatingWindow 2026-06-22-21:10: Popping out from the board's full-panel detail also returns the main panel to the board, so the board (not the emptied detail) sits behind the floating window. */
              onPopOut={(task) => { popOutTaskDetail(task); closeTaskDetailMainPanel(); }}
              onOpenDetail={(value, initialTab) => openTaskDetailInMainPanel(value, initialTab ?? "chat")}
              onDeleteTask={deleteTask}
              onReviseTask={(task) => modalManager.openNewTaskWithDescription(task.description)}
              onMergeTask={mergeTask}
              onRetryTask={retryTask}
              onOpenChatWithPrefill={onOpenChatWithPrefill}
              onPauseTask={pauseTask}
              onUnpauseTask={unpauseTask}
            onResetTask={resetTask}
              onDuplicateTask={duplicateTask}
              /*
              FNXC:Navigation 2026-06-22-09:00:
              The full-panel task-detail must dismiss back to the board when a destructive/terminal action (delete/merge/retry/reset/duplicate) fires, mirroring the modal path. Without onRequestClose the panel kept showing a ghost of the just-acted-on task.
              */
              onRequestClose={closeTaskDetailMainPanel}
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
          </div>
        </div>
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
  return (
    <PageErrorBoundary>
      <ListView
        tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
        projectId={currentProject?.id}
        onMoveTask={moveTask}
        onRetryTask={retryTask}
        onOpenChatWithPrefill={onOpenChatWithPrefill}
        onDeleteTask={deleteTask}
        onReviseTask={(task) => modalManager.openNewTaskWithDescription(task.description)}
        onPauseTask={pauseTask}
        onUnpauseTask={unpauseTask}
        onRevertTask={revertTask}
        onMergeTask={mergeTask}
            onResetTask={resetTask}
        onDuplicateTask={duplicateTask}
        onRefinementCreated={(task) => ingestCreatedTasks([task])}
        onOpenDetail={(task, options) => openDetailTask(task, undefined, options)}
        onPopOut={popOutTaskDetail}
        addToast={addToast}
        globalPaused={globalPaused}
        onNewTask={openNewTaskWithNav}
        onQuickCreate={handleBoardQuickCreate}
        onPlanningMode={openPlanningWithInitialPlanWithNav}
        availableModels={availableModels}
        favoriteProviders={favoriteProviders}
        favoriteModels={favoriteModels}
        onToggleFavorite={handleToggleFavorite}
        onToggleModelFavorite={handleToggleModelFavorite}
        searchQuery={searchQuery}
        lastFetchTimeMs={lastFetchTimeMs}
        prAuthAvailable={prAuthAvailable}
        autoMerge={autoMerge}
        openMobileTasksInPopup={openMobileTasksInPopup}
        taskDetailChatFirst={taskDetailChatFirst}
        mergeStrategy={mergeStrategy}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onCreateWorkflow={openCreateWorkflowWithNav}
        workflowControlsInHeader={sidebarActive || isMobile}
      />
    </PageErrorBoundary>
  );
  };

  return (
    <>
      {mainViewKeepAlive}
      {renderSwitchView()}
    </>
  );
}
