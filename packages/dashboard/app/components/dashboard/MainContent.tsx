/*
FNXC:MainContent 2026-06-24-00:00:
MainContent is the presentational switch for the dashboard's main content area, extracted verbatim from AppInner's renderMainContent(). It is a pure switch on taskView/viewMode returning the existing <PageErrorBoundary>/<Suspense> subtrees unchanged. The lazy view chunks (and their leading-underscore inventory convention) stay declared in App.tsx per the docs guard and are threaded in as props; the eager ChatView.css import remains in App.tsx so the styles bundle into the main CSS file.
*/
import { Suspense, useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import { Board } from "../Board";
import { TaskCard } from "../TaskCard";
import { ListView } from "../ListView";
import { TaskDetailContent } from "../TaskDetailModal";
import { ProjectOverview } from "../ProjectOverview";
import { MissionManager } from "../MissionManager";
import { MailboxView } from "../MailboxView";
import { PageErrorBoundary } from "../ErrorBoundary";
import { BackendConnectionErrorPage } from "../BackendConnectionErrorPage";
import { CapacityRiskBanner } from "../CapacityRiskBanner";
import { PlanningModeModal } from "../PlanningModeModal";
import { PlanningWorkflowSwitcherSlot } from "../PlanningWorkflowSwitcherSlot";
import { HeaderWorkflowSwitcherSlot } from "../HeaderWorkflowSwitcherSlot";
import { GraphWorkflowSwitcherSlot, filterTasksByGraphWorkflowSelection } from "../GraphWorkflowSwitcherSlot";
import { PluginDashboardViewHost } from "../../plugins/PluginDashboardViewHost";
import { isPluginViewId } from "../../plugins/pluginViewRegistry";
import { isNearDuplicateCanonicalInactive } from "../../../../core/src/near-duplicate-canonical";
import { fetchTaskDetail } from "../../api";
import type { DetailTaskTab } from "../../hooks/useModalManager";
import type { SectionId } from "../SettingsModal";
import type { MainContentProps } from "./types";

export function MainContent({
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
  popOutTaskDetail,
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
}: MainContentProps) {
  const [missionWorkflowId, setMissionWorkflowId] = useState<string | null>(null);
  const [planningHeaderWorkflowId, setPlanningHeaderWorkflowId] = useState<string | null>(null);

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

  // Project view
  if (resolvedPluginTaskView) {
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
            workflowSteps,
            subscribePluginEvents,
            openTaskDetail: openPluginTaskDetail,
            openFile: openFileInBrowser,
            renderTaskCard: (task: Task | TaskDetail) => (
              <TaskCard
                task={task}
                projectId={currentProject?.id}
                onOpenDetail={openPluginTaskDetail}
                addToast={addToast}
                disableDrag={true}
                prAuthAvailable={prAuthAvailable}
                autoMergeEnabled={autoMerge}
                nearDuplicateCanonicalInactive={typeof task.sourceMetadata?.nearDuplicateOf === "string"
                  ? isNearDuplicateCanonicalInactive(pluginContextTasks.find((candidate) => candidate.id === task.sourceMetadata?.nearDuplicateOf))
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
            onPopOut={() => setQuickChatOpen(true)}
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
          /*
          FNXC:ArtifactRegistry 2026-07-12-00:00: Artifact-registration mail notifications open their producing task through the shared task-detail fetch path so the mailbox does not invent a separate deep-link scheme.

          FNXC:ArtifactRegistry 2026-07-13-00:00: Mailbox artifact "View task" opens the producing task in the shared movable/resizable popped-out task-detail FloatingWindow (`popOutTaskDetail`), matching DocumentsView's artifact-task path instead of the docked `openDetailTask` modal, so the modal has full resize/move parity.
          */
          onOpenTask={(taskId) => {
            void fetchTaskDetail(taskId, currentProject?.id)
              .then((task) => popOutTaskDetail(task))
              .catch(() => addToast?.("Failed to open task", "error"));
          }}
          onUnreadCountChange={setMailboxUnreadCount}
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
            onOpenArtifactTaskDetail={popOutTaskDetail}
            onSendSelectionToTask={modalManager.openNewTaskWithDescription}
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
          <GoalsView anchorGoalId={goalAnchorId} projectId={currentProject?.id} onNavigateToMission={handleOpenMission} />
        </Suspense>
      </PageErrorBoundary>
    );
  }
  if (taskView === "todos") {
    // FNXC:Todos 2026-06-21-09:21: Todos render as a docked right-content view, not a modal overlay, per FN-6829 so all dashboard navigation surfaces share the same taskView routing model.
    if (!settingsLoaded || !todosEnabled) return null;
    return (
      <PageErrorBoundary>
        <Suspense fallback={null}>
          <TodoView projectId={currentProject?.id} addToast={addToast} onPlanningMode={openPlanningWithInitialPlanWithNav} onTaskCreated={(task) => ingestCreatedTasks([task])} />
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
          />
        </Suspense>
      </PageErrorBoundary>
    );
  }

  if (taskView === "planning") {
    /*
    FNXC:Navigation 2026-06-21-00:00:
    FN-6886 renders Planning Mode as a top-level main-content destination. Sidebar navigation opens an empty planning view, while Board, Todos, inline create, and resume entry points carry their initial plan/workflow/session state through modalManager.
    */
    const closePlanningView = () => {
      modalManager.closePlanning();
      handleChangeTaskView("board");
    };
    return (
      <PageErrorBoundary>
        {/*
        FNXC:Navigation 2026-06-22-00:00:
        Planning shows the same board WorkflowSwitcher in the same Header workflow slot as Board/List (portaled by PlanningWorkflowSwitcherSlot), so workflow selection is reachable from the left-sidebar Planning destination.

        FNXC:WorkflowAggregation 2026-07-01-00:00:
        The Planning header selector may choose All workflows for aggregate browsing, but embedded PlanningModeModal receives a real workflow id from the header or `null` default behavior; explicit modalManager workflow entry points still win.
        */}
        <PlanningWorkflowSwitcherSlot
          projectId={currentProject?.id}
          onOpenWorkflowEditor={openWorkflowEditorWithNav}
          onWorkflowSelectionChange={(selection) => setPlanningHeaderWorkflowId(selection && !selection.isAllWorkflowsSelected ? selection.selectedWorkflow.id : null)}
        />
        <PlanningModeModal
          isOpen={true}
          onClose={closePlanningView}
          onTaskCreated={handlePlanningTaskCreated}
          onTasksCreated={handlePlanningTasksCreated}
          tasks={tasks}
          initialPlan={modalManager.planningInitialPlan ?? undefined}
          projectId={currentProject?.id}
          workflowId={modalManager.planningWorkflowId ?? planningHeaderWorkflowId}
          resumeSessionId={modalManager.planningResumeSessionId}
          presentation="embedded"
        />
      </PageErrorBoundary>
    );
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
          <DevServerView tasks={tasks} addToast={addToast} projectId={currentProject?.id} />
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
    const liveDetailTask = mainPanelDetailTask
      ? (tasks.find((candidate) => candidate.id === mainPanelDetailTask.id) ?? mainPanelDetailTask)
      : null;
    if (!liveDetailTask) {
      return (
        <PageErrorBoundary>
          <Board
            tasks={filteredBoardTasks}
            projectId={currentProject?.id}
            maxConcurrent={maxConcurrent}
            showWorktreeGrouping={showWorktreeGrouping}
            onMoveTask={moveTask}
            onPauseTask={pauseTask}
            onOpenDetail={openBoardTaskDetail}
            onOpenRefine={(task) => openDetailTask(task, undefined, { initialAction: "refine" })}
            onOpenGroupModal={openGroupModalWithNav}
            addToast={addToast}
            onQuickCreate={handleBoardQuickCreate}
            onNewTask={openNewTaskWithNav}
            onPlanningMode={openPlanningWithInitialPlanWithNav}
            onSubtaskBreakdown={subtaskBreakdownEnabled ? openSubtaskBreakdownWithNav : undefined}
            autoMerge={autoMerge}
            mergeStrategy={mergeStrategy}
            onToggleAutoMerge={toggleAutoMerge}
            planAutoApproveEnabled={planAutoApproveEnabled}
            onTogglePlanAutoApprove={togglePlanAutoApprove}
            globalPaused={globalPaused}
            onUpdateTask={updateTask}
            onRetryTask={retryTask}
            onUnpauseTask={unpauseTask}
            onResetTask={resetTask}
            onDuplicateTask={duplicateTask}
            onMergeTask={mergeTask}
            onArchiveTask={archiveTask}
            onUnarchiveTask={unarchiveTask}
            onRevertTask={revertTask}
            onDeleteTask={deleteTask}
            onArchiveAllDone={archiveAllDone}
            onLoadArchivedTasks={loadArchivedTasks}
            onLoadMoreArchivedTasks={loadMoreArchivedTasks}
            archivedHasMore={archivedHasMore}
            archivedLoadingMore={archivedLoadingMore}
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
            workflowColumnsEnabled
            settingsLoaded={settingsLoaded}
            workflowControlsInHeader={sidebarActive || isMobile}
          />
        </PageErrorBoundary>
      );
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
              embedded
              initialTab={mainPanelDetailInitialTab}
              /*
              FNXC:TaskDetail 2026-06-22-18:40:
              Board-card detail (full main panel) renders its "Back to board" affordance inside TaskDetailContent's gray header (far right, across from the task id) instead of a separate back-row above the content. The prop only renders the header back button when both embedded and onBackToBoard are present, so ListView split-pane and modal usages stay unaffected.
              */
              onBackToBoard={closeTaskDetailMainPanel}
              /* FNXC:FloatingWindow 2026-06-22-21:10: Popping out from the board's full-panel detail also returns the main panel to the board, so the board (not the emptied detail) sits behind the floating window. */
              onPopOut={(task) => { popOutTaskDetail(task); closeTaskDetailMainPanel(); }}
              onOpenDetail={(value) => openTaskDetailInMainPanel(value, "chat")}
              onMoveTask={moveTask}
              onDeleteTask={deleteTask}
              onMergeTask={mergeTask}
              onRetryTask={retryTask}
              onResetTask={resetTask}
              onDuplicateTask={duplicateTask}
              /*
              FNXC:Navigation 2026-06-22-09:00:
              The full-panel task-detail must dismiss back to the board when a destructive/terminal action (delete/merge/archive/retry/reset/duplicate) fires, mirroring the modal path. Without onRequestClose the panel kept showing a ghost of the just-acted-on task.
              */
              onRequestClose={closeTaskDetailMainPanel}
              onTaskUpdated={(updatedTask) => {
                setMainPanelDetailTask((previous) => {
                  if (!previous || previous.id !== updatedTask.id) return previous;
                  return { ...previous, ...updatedTask };
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
    return (
      <PageErrorBoundary>
        {capacityRiskBannerEnabled && !capacityRiskDismissed ? (
          <CapacityRiskBanner signal={capacityRiskSignal} onDismiss={handleDismissCapacityRisk} />
        ) : null}
        <Board
          tasks={filteredBoardTasks}
          projectId={currentProject?.id}
          maxConcurrent={maxConcurrent}
          showWorktreeGrouping={showWorktreeGrouping}
          onMoveTask={moveTask}
          onPauseTask={pauseTask}
          onOpenDetail={openBoardTaskDetail}
          onOpenRefine={(task) => openDetailTask(task, undefined, { initialAction: "refine" })}
          onOpenGroupModal={openGroupModalWithNav}
          addToast={addToast}
          onQuickCreate={handleBoardQuickCreate}
          onNewTask={openNewTaskWithNav}
          onPlanningMode={openPlanningWithInitialPlanWithNav}
          onSubtaskBreakdown={subtaskBreakdownEnabled ? openSubtaskBreakdownWithNav : undefined}
          autoMerge={autoMerge}
          mergeStrategy={mergeStrategy}
          onToggleAutoMerge={toggleAutoMerge}
          planAutoApproveEnabled={planAutoApproveEnabled}
          onTogglePlanAutoApprove={togglePlanAutoApprove}
          globalPaused={globalPaused}
          onUpdateTask={updateTask}
          onRetryTask={retryTask}
          onUnpauseTask={unpauseTask}
          onResetTask={resetTask}
          onDuplicateTask={duplicateTask}
          onMergeTask={mergeTask}
          onArchiveTask={archiveTask}
          onUnarchiveTask={unarchiveTask}
          onRevertTask={revertTask}
          onDeleteTask={deleteTask}
          onArchiveAllDone={archiveAllDone}
          onLoadArchivedTasks={loadArchivedTasks}
          onLoadMoreArchivedTasks={loadMoreArchivedTasks}
          archivedHasMore={archivedHasMore}
          archivedLoadingMore={archivedLoadingMore}
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
          workflowColumnsEnabled
          settingsLoaded={settingsLoaded}
          workflowControlsInHeader={sidebarActive || isMobile}
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
        onRevertTask={revertTask}
        onMergeTask={mergeTask}
        onResetTask={resetTask}
        onDuplicateTask={duplicateTask}
        onOpenDetail={(task, options) => openDetailTask(task, undefined, options)}
        onPopOut={popOutTaskDetail}
        addToast={addToast}
        globalPaused={globalPaused}
        onNewTask={openNewTaskWithNav}
        onQuickCreate={handleBoardQuickCreate}
        onPlanningMode={openPlanningWithInitialPlanWithNav}
        onSubtaskBreakdown={subtaskBreakdownEnabled ? openSubtaskBreakdownWithNav : undefined}
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
        openMobileTasksInPopup={openMobileTasksInPopup}
        taskDetailChatFirst={taskDetailChatFirst}
        mergeStrategy={mergeStrategy}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onCreateWorkflow={openCreateWorkflowWithNav}
        workflowColumnsEnabled
        settingsLoaded={settingsLoaded}
        workflowControlsInHeader={sidebarActive || isMobile}
      />
    </PageErrorBoundary>
  );
}
