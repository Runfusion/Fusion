import { useState, useCallback, useEffect, useMemo } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import { Header, useViewportMode } from "./components/Header";
import { Board } from "./components/Board";
import { ListView } from "./components/ListView";
import { ProjectOverview } from "./components/ProjectOverview";
import { AgentsView } from "./components/AgentsView";
import { DocumentsView } from "./components/DocumentsView";
import { InsightsView } from "./components/InsightsView";
import { MissionManager } from "./components/MissionManager";
import { NodesView } from "./components/NodesView";
import { ChatView } from "./components/ChatView";
import { RoadmapsView } from "./components/RoadmapsView";
import { SkillsView } from "./components/SkillsView";
import { MailboxView } from "./components/MailboxView";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import { AppModals } from "./components/AppModals";
import { DashboardLoader, type DashboardLoaderStage } from "./components/DashboardLoader";
import { ExecutorStatusBar } from "./components/ExecutorStatusBar";
import { SessionNotificationBanner } from "./components/SessionNotificationBanner";
import { OnboardingResumeCard } from "./components/OnboardingResumeCard";
import { isOnboardingResumable } from "./components/model-onboarding-state";
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
import { useRemoteNodeData } from "./hooks/useRemoteNodeData";
import { useRemoteNodeEvents } from "./hooks/useRemoteNodeEvents";
import { NodeProvider, useNodeContext } from "./context/NodeContext";
import type { AiSessionSummary } from "./api";
import { fetchAiSession, fetchUnreadCount } from "./api";

function AppInner() {
  const { toasts, addToast, removeToast } = useToast();
  const isElectron = typeof window !== "undefined" && Boolean((window as Window & { electronAPI?: unknown }).electronAPI);
  
  // Project management hooks - MUST be called before any conditional logic
  const { projects, loading: projectsLoading, error: projectsError, refresh: refreshProjects, register: registerProject, update: updateProjectHook, unregister: unregisterProjectHook } = useProjects();
  const { nodes } = useNodes();
  const { currentProject, setCurrentProject, clearCurrentProject, loading: currentProjectLoading } = useCurrentProject(projects);
  
  // Node context for local/remote node switching
  const { currentNode, currentNodeId, isRemote, setCurrentNode, clearCurrentNode } = useNodeContext();
  
  // Sync node context with useNodes() results - fall back to local if selected node is missing
  useEffect(() => {
    if (currentNodeId && nodes.length > 0) {
      const nodeExists = nodes.some((n) => n.id === currentNodeId);
      if (!nodeExists) {
        // Selected node was deleted or unregistered - fall back to local
        clearCurrentNode();
      }
    }
  }, [currentNodeId, nodes, clearCurrentNode]);
  
  // Search query state - must be defined before useTasks
  const [searchQuery, setSearchQuery] = useState("");
  
  // Remote node data and events when in remote mode (pass searchQuery for server-side filtering)
  const remoteData = useRemoteNodeData(currentNodeId, { projectId: currentProject?.id, searchQuery: searchQuery || undefined });
  const remoteEvents = useRemoteNodeEvents(currentNodeId);
  
  // Use remote data when in remote mode, local data otherwise
  const effectiveProjects = isRemote && remoteData.projects.length > 0 ? remoteData.projects : projects;
  const effectiveTasks = isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : [];
  
  // Tasks hook with project context and search query
  const { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, updateTask, duplicateTask, archiveTask, unarchiveTask, archiveAllDone, loadArchivedTasks, lastFetchTimeMs } = useTasks(
    currentProject ? { projectId: currentProject.id, searchQuery: searchQuery || undefined } : { searchQuery: searchQuery || undefined }
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
  const sessionsNeedingInput = bgSessions.filter(
    (session) => session.status === "awaiting_input" || session.status === "error"
  );

  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";

  // Modal state/handlers extracted to a dedicated manager hook.
  const modalManager = useModalManager({
    projectId: currentProject?.id,
    planningSessions: bgPlanningSessions,
  });

  // App-level mailbox unread count state (used for header badge)
  const [mailboxUnreadCount, setMailboxUnreadCount] = useState(0);

  // Initial fetch of mailbox unread count
  useEffect(() => {
    fetchUnreadCount(currentProject?.id)
      .then((data: { unreadCount: number }) => {
        setMailboxUnreadCount(data.unreadCount);
      })
      .catch(() => {});
  }, [currentProject?.id]);

  // Nodes management is an overlay view (not a modal), so it stays local to App.
  const [nodesOpen, setNodesOpen] = useState(false);
  const [missionResumeSessionId, setMissionResumeSessionId] = useState<string | undefined>(undefined);
  const [missionTargetId, setMissionTargetId] = useState<string | undefined>(undefined);
  const [milestoneSliceResumeSessionId, setMilestoneSliceResumeSessionId] = useState<string | undefined>(undefined);
  const [quickChatOpen, setQuickChatOpen] = useState(false);

  // Settings state
  const {
    maxConcurrent,
    rootDir,
    autoMerge,
    globalPaused,
    enginePaused,
    taskStuckTimeoutMs,
    showQuickChatFAB,
    githubTokenConfigured,
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
    refresh: refreshAppSettings,
  } = useAppSettings(currentProject?.id);
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
      setMilestoneSliceResumeSessionId(undefined);
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

  const handleOpenDetailWithTab = useCallback((task: Task | TaskDetail, initialTab: "changes") => {
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
          <PageErrorBoundary>
            <NodesView addToast={addToast} onClose={() => setNodesOpen(false)} />
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
    if (taskView === "skills") {
      return (
        <PageErrorBoundary>
          <SkillsView
            addToast={addToast}
            projectId={currentProject?.id}
            onClose={() => handleChangeTaskView("board")}
          />
        </PageErrorBoundary>
      );
    }

    if (taskView === "chat") {
      return (
        <PageErrorBoundary>
          <ChatView addToast={addToast} projectId={currentProject?.id} />
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
      return (
        <PageErrorBoundary>
          <RoadmapsView addToast={addToast} projectId={currentProject?.id} />
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
              if (task) modalManager.openDetailTask(task as TaskDetail);
            }}
            availableTasks={tasks.map((t) => ({ id: t.id, title: t.title }))}
            resumeSessionId={missionResumeSessionId}
            targetMissionId={missionTargetId}
            milestoneSliceResumeSessionId={milestoneSliceResumeSessionId}
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

    if (taskView === "documents") {
      return (
        <PageErrorBoundary>
          <DocumentsView
            projectId={currentProject?.id}
            addToast={addToast}
            onOpenDetail={modalManager.openDetailTask}
          />
        </PageErrorBoundary>
      );
    }

    if (taskView === "insights") {
      return (
        <PageErrorBoundary>
          <InsightsView
            projectId={currentProject?.id}
            addToast={addToast}
            onClose={() => handleChangeTaskView("board")}
          />
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
          searchQuery={searchQuery}
          lastFetchTimeMs={lastFetchTimeMs}
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
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        mailboxUnreadCount={mailboxUnreadCount}
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
      />
      {viewMode === "project" && currentProject && !nodesOpen && taskView !== "missions" && !modalManager.isPlanningOpen && (
        <SessionNotificationBanner
          sessions={sessionsNeedingInput}
          onResumeSession={handleOpenBackgroundSession}
          onDismissSession={bgDismiss}
          onDismissAll={handleDismissAllNeedingInputSessions}
        />
      )}
      {viewMode === "project" && currentProject && !modalManager.modelOnboardingOpen && isOnboardingResumable() && (
        <OnboardingResumeCard onResume={modalManager.openModelOnboarding} />
      )}
      <div
        className={`project-content${viewMode === "project" && currentProject ? " project-content--with-footer" : ""}${isMobile ? " project-content--with-mobile-nav" : ""}`}
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
        />
      )}
      <MobileNavBar
        view={taskView}
        onChangeView={viewMode === "project" && currentProject ? handleTaskViewChange : () => {}}
        footerVisible={viewMode === "project" && !!currentProject}
        modalOpen={modalManager.anyModalOpen}
        onOpenSettings={handleOpenSettings}
        onOpenActivityLog={modalManager.openActivityLog}
        onOpenMailbox={() => handleTaskViewChange("mailbox")}
        mailboxUnreadCount={mailboxUnreadCount}
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
        onOpenQuickChat={() => setQuickChatOpen(true)}
        projectId={currentProject?.id}
      />
      {viewMode === "project" && currentProject && taskView !== "chat" && taskView !== "mailbox" && taskView !== "insights" && (
        <QuickChatFAB
          projectId={currentProject.id}
          addToast={addToast}
          showFAB={showQuickChatFAB}
          open={quickChatOpen}
          onOpenChange={setQuickChatOpen}
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
        onSettingsClose={() => {
          modalManager.closeSettings();
          void refreshAppSettings();
        }}
        onReopenOnboarding={() => {
          modalManager.closeSettings();
          modalManager.openModelOnboarding();
        }}
      />
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <NodeProvider>
        <AppInner />
      </NodeProvider>
    </ToastProvider>
  );
}
