import { useState, useCallback, useEffect, useMemo } from "react";
import type { TaskDetail } from "@fusion/core";
import { Header, useViewportMode } from "./components/Header";
import { Board } from "./components/Board";
import { ListView } from "./components/ListView";
import { ProjectOverview } from "./components/ProjectOverview";
import { AgentsView } from "./components/AgentsView";
import { MissionManager } from "./components/MissionManager";
import { NodesView } from "./components/NodesView";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import { AppModals } from "./components/AppModals";
import { DashboardLoader, type DashboardLoaderStage } from "./components/DashboardLoader";
import { ExecutorStatusBar } from "./components/ExecutorStatusBar";
import { SessionNotificationBanner } from "./components/SessionNotificationBanner";
import { MobileNavBar } from "./components/MobileNavBar";
import { QuickChatFAB } from "./components/QuickChatFAB";
import { ToastContainer } from "./components/ToastContainer";
import { useBackgroundSessions } from "./hooks/useBackgroundSessions";
import { useTasks } from "./hooks/useTasks";
import { useProjects } from "./hooks/useProjects";
import { useNodes } from "./hooks/useNodes";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { ToastProvider, useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";
import { useModalManager } from "./hooks/useModalManager";
import { useAppSettings } from "./hooks/useAppSettings";
import { useDeepLink } from "./hooks/useDeepLink";
import { useFavorites } from "./hooks/useFavorites";
import { useAuthOnboarding } from "./hooks/useAuthOnboarding";
import { useViewState, type TaskView } from "./hooks/useViewState";
import { useProjectActions } from "./hooks/useProjectActions";
import { useTaskHandlers } from "./hooks/useTaskHandlers";
import type { AiSessionSummary } from "./api";

function AppInner() {
  const { toasts, addToast, removeToast } = useToast();
  const isElectron = typeof window !== "undefined" && Boolean((window as Window & { electronAPI?: unknown }).electronAPI);
  
  // Project management hooks - MUST be called before any conditional logic
  const { projects, loading: projectsLoading, error: projectsError, refresh: refreshProjects, register: registerProject, update: updateProjectHook, unregister: unregisterProjectHook } = useProjects();
  const { nodes } = useNodes();
  const { currentProject, setCurrentProject, clearCurrentProject, loading: currentProjectLoading } = useCurrentProject(projects);
  
  // Tasks hook with project context
  const { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, updateTask, duplicateTask, archiveTask, unarchiveTask, archiveAllDone } = useTasks(
    currentProject ? { projectId: currentProject.id } : undefined
  );

  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  const loadingStage = useMemo<DashboardLoaderStage>(() => {
    if (projectsLoading) return "projects";
    if (currentProjectLoading) return "project";
    return "tasks";
  }, [projectsLoading, currentProjectLoading]);

  useEffect(() => {
    if (initialLoadComplete) {
      return;
    }

    if (projectsLoading || currentProjectLoading) {
      return;
    }

    const settleTimer = window.setTimeout(() => {
      setInitialLoadComplete(true);
    }, 200);

    return () => {
      window.clearTimeout(settleTimer);
    };
  }, [initialLoadComplete, projectsLoading, currentProjectLoading]);

  // Theme management
  const { themeMode, colorTheme, setThemeMode, setColorTheme } = useTheme();

  // Background AI sessions
  const { sessions: bgSessions, generating: bgGenerating, needsInput: bgNeedsInput, planningSessions: bgPlanningSessions, dismissSession: bgDismiss } = useBackgroundSessions(currentProject?.id);
  const sessionsNeedingInput = bgSessions.filter((session) => session.status === "awaiting_input");

  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";

  // Modal state/handlers extracted to a dedicated manager hook.
  const modalManager = useModalManager({
    projectId: currentProject?.id,
    planningSessions: bgPlanningSessions,
  });

  // Nodes management is an overlay view (not a modal), so it stays local to App.
  const [nodesOpen, setNodesOpen] = useState(false);
  const [missionResumeSessionId, setMissionResumeSessionId] = useState<string | undefined>(undefined);
  const [missionTargetId, setMissionTargetId] = useState<string | undefined>(undefined);

  // Settings state
  const {
    maxConcurrent,
    rootDir,
    autoMerge,
    globalPaused,
    enginePaused,
    taskStuckTimeoutMs,
    githubTokenConfigured,
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
  } = useAppSettings(currentProject?.id);
  const [searchQuery, setSearchQuery] = useState("");
  const {
    availableModels,
    favoriteProviders,
    favoriteModels,
    toggleFavoriteProvider,
    toggleFavoriteModel,
  } = useFavorites();

  const { viewMode, setViewMode, taskView, handleChangeTaskView, handleToggleTheme } = useViewState({
    projectsLoading,
    currentProjectLoading,
    currentProject,
    projectsLength: projects.length,
    setupWizardOpen: modalManager.setupWizardOpen,
    openSetupWizard: modalManager.openSetupWizard,
    themeMode,
    setThemeMode,
  });

  const handleTaskViewChange = useCallback((newView: TaskView) => {
    if (newView === "missions") {
      setMissionResumeSessionId(undefined);
      setMissionTargetId(undefined);
    }
    handleChangeTaskView(newView);
  }, [handleChangeTaskView]);

  // Auth and onboarding bootstrap logic extracted to a dedicated hook.
  useAuthOnboarding({
    projectId: currentProject?.id,
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
    onPlanningTaskCreated: modalManager.onPlanningTaskCreated,
    onPlanningTasksCreated: modalManager.onPlanningTasksCreated,
    onSubtaskTasksCreated: modalManager.onSubtaskTasksCreated,
    addToast,
  });

  const handleOpenDetailWithTab = useCallback((task: TaskDetail, initialTab: "changes") => {
    if (initialTab === "changes") {
      modalManager.openDetailWithChangesTab(task);
      return;
    }
    modalManager.openDetailTask(task, initialTab);
  }, [modalManager]);

  const handleOpenNodes = useCallback(() => {
    setNodesOpen((prev) => !prev);
  }, []);

  const handleOpenMissionsView = useCallback(() => {
    setMissionTargetId(undefined);
    setMissionResumeSessionId(undefined);
    handleChangeTaskView("missions");
  }, [handleChangeTaskView]);

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
      handleChangeTaskView("missions");
    }
  }, [handleChangeTaskView, modalManager]);

  const handleDismissAllNeedingInputSessions = useCallback(() => {
    for (const session of sessionsNeedingInput) {
      bgDismiss(session.id);
    }
  }, [bgDismiss, sessionsNeedingInput]);

  // Render main content based on view mode
  const renderMainContent = () => {
    if (nodesOpen) {
      return (
        <div className="nodes-management-overlay">
          <div className="nodes-management-overlay__header">
            <button className="btn btn-sm" onClick={() => setNodesOpen(false)}>Close Nodes</button>
          </div>
          <PageErrorBoundary>
            <NodesView addToast={addToast} />
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
    if (taskView === "missions") {
      return (
        <PageErrorBoundary>
          <MissionManager
            isInline={true}
            isOpen={true}
            onClose={() => {
              setMissionTargetId(undefined);
              setMissionResumeSessionId(undefined);
              handleChangeTaskView("board");
            }}
            addToast={addToast}
            projectId={currentProject?.id}
            onSelectTask={(taskId) => {
              const task = tasks.find((t) => t.id === taskId);
              if (task) modalManager.openDetailTask(task as TaskDetail);
            }}
            availableTasks={tasks.map((t) => ({ id: t.id, title: t.title }))}
            resumeSessionId={missionResumeSessionId}
            targetMissionId={missionTargetId}
          />
        </PageErrorBoundary>
      );
    }

    if (taskView === "agents") {
      return (
        <PageErrorBoundary>
          <AgentsView addToast={addToast} projectId={currentProject?.id} />
        </PageErrorBoundary>
      );
    }

    if (taskView === "board") {
      return (
        <PageErrorBoundary>
          <Board
            tasks={tasks}
            projectId={currentProject?.id}
            maxConcurrent={maxConcurrent}
            onMoveTask={moveTask}
            onOpenDetail={modalManager.openDetailTask}
            addToast={addToast}
            onQuickCreate={handleBoardQuickCreate}
            onNewTask={modalManager.openNewTask}
            onPlanningMode={modalManager.openPlanningWithInitialPlan}
            onSubtaskBreakdown={modalManager.openSubtaskBreakdown}
            autoMerge={autoMerge}
            onToggleAutoMerge={toggleAutoMerge}
            globalPaused={globalPaused}
            onUpdateTask={updateTask}
            onArchiveTask={archiveTask}
            onUnarchiveTask={unarchiveTask}
            onArchiveAllDone={archiveAllDone}
            searchQuery={searchQuery}
            availableModels={availableModels}
            onOpenDetailWithTab={handleOpenDetailWithTab}
            favoriteProviders={favoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={handleToggleFavorite}
            onToggleModelFavorite={handleToggleModelFavorite}
            taskStuckTimeoutMs={taskStuckTimeoutMs}
            onOpenMission={handleOpenMission}
          />
        </PageErrorBoundary>
      );
    }

    // List view
    return (
      <PageErrorBoundary>
        <ListView
          tasks={tasks}
          projectId={currentProject?.id}
          onMoveTask={moveTask}
          onOpenDetail={modalManager.openDetailTask}
          addToast={addToast}
          globalPaused={globalPaused}
          onNewTask={modalManager.openNewTask}
          onQuickCreate={handleBoardQuickCreate}
          onPlanningMode={modalManager.openPlanningWithInitialPlan}
          onSubtaskBreakdown={modalManager.openSubtaskBreakdown}
          availableModels={availableModels}
          favoriteProviders={favoriteProviders}
          favoriteModels={favoriteModels}
          onToggleFavorite={handleToggleFavorite}
          onToggleModelFavorite={handleToggleModelFavorite}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
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

  return (
    <>
      <Header
        isElectron={isElectron}
        onOpenSettings={handleOpenSettings}
        onOpenGitHubImport={modalManager.openGitHubImport}
        onOpenPlanning={modalManager.openPlanning}
        onResumePlanning={modalManager.resumePlanning}
        activePlanningSessionCount={bgPlanningSessions.length}
        onOpenUsage={modalManager.openUsage}
        onOpenActivityLog={modalManager.openActivityLog}
        onOpenMailbox={modalManager.openMailbox}
        mailboxUnreadCount={modalManager.mailboxUnreadCount}
        onOpenSchedules={modalManager.openSchedules}
        onOpenGitManager={modalManager.openGitManager}
        onOpenNodes={handleOpenNodes}
        onOpenWorkflowSteps={modalManager.openWorkflowSteps}
        onOpenScripts={modalManager.openScripts}
        onRunScript={modalManager.runScript}
        onToggleTerminal={modalManager.toggleTerminal}
        onOpenFiles={modalManager.openFiles}
        filesOpen={modalManager.filesOpen}
        globalPaused={globalPaused}
        enginePaused={enginePaused}
        onToggleGlobalPause={toggleGlobalPause}
        onToggleEnginePause={toggleEnginePause}
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        projects={projects}
        currentProject={currentProject}
        onSelectProject={handleSelectProject}
        onViewAllProjects={handleViewAllProjects}
        projectId={currentProject?.id}
        mobileNavEnabled={isMobile}
      />
      {viewMode === "project" && currentProject && !nodesOpen && (
        <SessionNotificationBanner
          sessions={sessionsNeedingInput}
          onResumeSession={handleOpenBackgroundSession}
          onDismissSession={bgDismiss}
          onDismissAll={handleDismissAllNeedingInputSessions}
        />
      )}
      <div
        className={`project-content${viewMode === "project" && currentProject ? " project-content--with-footer" : ""}${isMobile ? " project-content--with-mobile-nav" : ""}`}
      >
        {renderMainContent()}
      </div>
      {viewMode === "project" && currentProject && !nodesOpen && (
        <ExecutorStatusBar
          tasks={tasks}
          projectId={currentProject.id}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          backgroundSessions={bgSessions}
          backgroundGenerating={bgGenerating}
          backgroundNeedsInput={bgNeedsInput}
          onOpenBackgroundSession={handleOpenBackgroundSession}
          onDismissBackgroundSession={bgDismiss}
        />
      )}
      <MobileNavBar
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : () => {}}
        footerVisible={viewMode === "project" && !!currentProject}
        modalOpen={modalManager.anyModalOpen}
        onOpenSettings={handleOpenSettings}
        onOpenActivityLog={modalManager.openActivityLog}
        onOpenMailbox={modalManager.openMailbox}
        mailboxUnreadCount={modalManager.mailboxUnreadCount}
        onOpenGitManager={modalManager.openGitManager}
        onOpenWorkflowSteps={modalManager.openWorkflowSteps}
        onOpenSchedules={modalManager.openSchedules}
        onOpenScripts={modalManager.openScripts}
        onToggleTerminal={modalManager.toggleTerminal}
        onOpenFiles={modalManager.openFiles}
        onOpenGitHubImport={modalManager.openGitHubImport}
        onOpenPlanning={modalManager.openPlanning}
        onResumePlanning={modalManager.resumePlanning}
        activePlanningSessionCount={bgPlanningSessions.length}
        onOpenUsage={modalManager.openUsage}
        onViewAllProjects={handleViewAllProjects}
        onRunScript={modalManager.runScript}
        projectId={currentProject?.id}
      />
      {viewMode === "project" && currentProject && (
        <QuickChatFAB projectId={currentProject.id} addToast={addToast} />
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
        projectActions={{ handleSetupComplete, handleModelOnboardingComplete }}
        taskHandlers={{
          handleModalCreate,
          handlePlanningTaskCreated,
          handlePlanningTasksCreated,
          handleSubtaskTasksCreated,
          handleGitHubImport,
        }}
        taskOperations={{ moveTask, deleteTask, mergeTask, retryTask, duplicateTask }}
        deepLink={{ handleDetailClose }}
        settings={{ githubTokenConfigured, themeMode, colorTheme, setThemeMode, setColorTheme }}
      />
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
