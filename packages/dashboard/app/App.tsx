import { useState, useCallback, useEffect } from "react";
import type { TaskDetail, TaskCreateInput, Task, ThemeMode, ProjectInfo } from "@fusion/core";
import { fetchConfig, fetchSettings, fetchAuthStatus, updateSettings, fetchModels, fetchTaskDetail } from "./api";
import type { ModelInfo } from "./api";
import { Header } from "./components/Header";
import { Board } from "./components/Board";
import { ListView } from "./components/ListView";
import { ProjectOverview } from "./components/ProjectOverview";
import { SetupWizardModal } from "./components/SetupWizardModal";
import { TaskDetailModal } from "./components/TaskDetailModal";
import { TerminalModal } from "./components/TerminalModal";
import { FileBrowserModal } from "./components/FileBrowserModal";
import { SettingsModal } from "./components/SettingsModal";
import { PlanningModeModal } from "./components/PlanningModeModal";
import { SubtaskBreakdownModal } from "./components/SubtaskBreakdownModal";
import type { SectionId } from "./components/SettingsModal";
import { ToastContainer } from "./components/ToastContainer";
import { GitHubImportModal } from "./components/GitHubImportModal";
import { GitManagerModal } from "./components/GitManagerModal";
import { UsageIndicator } from "./components/UsageIndicator";
import { NewTaskModal } from "./components/NewTaskModal";
import { ScheduledTasksModal } from "./components/ScheduledTasksModal";
import { ActivityLogModal } from "./components/ActivityLogModal";
import { WorkflowStepManager } from "./components/WorkflowStepManager";
import { AgentListModal } from "./components/AgentListModal";
import { AgentsView } from "./components/AgentsView";
import { ScriptsModal } from "./components/ScriptsModal";
import { useTasks } from "./hooks/useTasks";
import { useProjects } from "./hooks/useProjects";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { ToastProvider, useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";

function AppInner() {
  const [newTaskModalOpen, setNewTaskModalOpen] = useState(false);
  const [isPlanningOpen, setIsPlanningOpen] = useState(false);
  const [planningInitialPlan, setPlanningInitialPlan] = useState<string | null>(null);
  const [isSubtaskOpen, setIsSubtaskOpen] = useState(false);
  const [subtaskInitialDescription, setSubtaskInitialDescription] = useState<string | null>(null);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [githubImportOpen, setGitHubImportOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileBrowserWorkspace, setFileBrowserWorkspace] = useState("project");
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [gitManagerOpen, setGitManagerOpen] = useState(false);
  const [workflowStepsOpen, setWorkflowStepsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [terminalInitialCommand, setTerminalInitialCommand] = useState<string | undefined>(undefined);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [rootDir, setRootDir] = useState<string>(".");
  const [autoMerge, setAutoMerge] = useState(true);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [enginePaused, setEnginePaused] = useState(false);
  
  // Multi-project state
  const { projects, loading: projectsLoading, register, update: updateProject, unregister: unregisterProject } = useProjects();
  const { currentProject, setCurrentProject, clearCurrentProject, loading: currentProjectLoading } = useCurrentProject(projects);
  
  // View state: "overview" for all projects, "project" for single project task view
  const [viewMode, setViewMode] = useState<"overview" | "project">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("kb-dashboard-view-mode");
      if (saved === "overview" || saved === "project") {
        return saved;
      }
    }
    return "overview";
  });
  
  // Task view state (only meaningful when viewMode="project")
  const [taskView, setTaskView] = useState<"board" | "list" | "agents">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("kb-dashboard-task-view");
      if (saved === "list" || saved === "board" || saved === "agents") {
        return saved;
      }
    }
    return "board";
  });
  
  const [searchQuery, setSearchQuery] = useState("");
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  
  // Setup wizard state
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  
  // Tasks hook with project context
  const { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, updateTask, duplicateTask, archiveTask, unarchiveTask, archiveAllDone } = useTasks(
    currentProject ? { projectId: currentProject.id } : undefined
  );

  // Theme management
  const { themeMode, colorTheme, setThemeMode, setColorTheme } = useTheme();

  // Auto-open setup wizard on first run (no projects)
  useEffect(() => {
    if (!projectsLoading && projects.length === 0 && !setupWizardOpen) {
      // Delay slightly to allow initial render
      const timer = setTimeout(() => {
        setSetupWizardOpen(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [projectsLoading, projects.length, setupWizardOpen]);

  // Persist view mode
  useEffect(() => {
    localStorage.setItem("kb-dashboard-view-mode", viewMode);
  }, [viewMode]);

  // Persist task view
  useEffect(() => {
    localStorage.setItem("kb-dashboard-task-view", taskView);
  }, [taskView]);

  // Theme toggle handler: cycles Dark → Light → System → Dark
  const handleToggleTheme = useCallback(() => {
    const cycle: ThemeMode[] = ["dark", "light", "system"];
    const currentIndex = cycle.indexOf(themeMode);
    const nextMode = cycle[(currentIndex + 1) % cycle.length];
    setThemeMode(nextMode);
  }, [themeMode, setThemeMode]);

  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        setMaxConcurrent(cfg.maxConcurrent);
        setRootDir(cfg.rootDir);
      })
      .catch(() => {/* keep default */});
    fetchSettings()
      .then((s) => {
        setAutoMerge(!!s.autoMerge);
        setGlobalPaused(!!s.globalPause);
        setEnginePaused(!!s.enginePaused);
        setGithubTokenConfigured(!!s.githubTokenConfigured);
      })
      .catch(() => {/* keep default */});
    fetchAuthStatus()
      .then(({ providers }) => {
        if (providers.length > 0 && providers.every((p) => !p.authenticated)) {
          setSettingsOpen(true);
          setSettingsInitialSection("authentication");
        }
      })
      .catch(() => {/* fail silently — do not auto-open */});
  }, []);

  // Fetch available models
  useEffect(() => {
    fetchModels()
      .then((models) => setAvailableModels(models))
      .catch(() => {/* keep empty array on failure */});
  }, []);
  const { toasts, addToast, removeToast } = useToast();

  // Handle deep link to task on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get("task");
    if (!taskId) return;

    // Clean URL immediately without reloading
    const url = new URL(window.location.href);
    url.searchParams.delete("task");
    window.history.replaceState({}, "", url.toString());

    // Load and open the task directly
    fetchTaskDetail(taskId)
      .then((task) => {
        handleDetailOpen(task);
      })
      .catch(() => {
        addToast(`Task ${taskId} not found`, "error");
      });
  }, []);

  // Project selection handlers
  const handleSelectProject = useCallback((project: ProjectInfo) => {
    setCurrentProject(project);
    setViewMode("project");
  }, [setCurrentProject]);

  const handleViewAllProjects = useCallback(() => {
    clearCurrentProject();
    setViewMode("overview");
  }, [clearCurrentProject]);

  const handleAddProject = useCallback(() => {
    setSetupWizardOpen(true);
  }, []);

  const handlePauseProject = useCallback(async (project: ProjectInfo) => {
    try {
      await updateProject(project.id, { status: "paused" });
      addToast(`Project ${project.name} paused`, "success");
    } catch {
      addToast(`Failed to pause project ${project.name}`, "error");
    }
  }, [updateProject, addToast]);

  const handleResumeProject = useCallback(async (project: ProjectInfo) => {
    try {
      await updateProject(project.id, { status: "active" });
      addToast(`Project ${project.name} resumed`, "success");
    } catch {
      addToast(`Failed to resume project ${project.name}`, "error");
    }
  }, [updateProject, addToast]);

  const handleRemoveProject = useCallback(async (project: ProjectInfo) => {
    try {
      await unregisterProject(project.id);
      addToast(`Project ${project.name} removed`, "success");
      // If we removed the current project, go back to overview
      if (currentProject?.id === project.id) {
        clearCurrentProject();
        setViewMode("overview");
      }
    } catch {
      addToast(`Failed to remove project ${project.name}`, "error");
    }
  }, [unregisterProject, currentProject, clearCurrentProject, addToast]);

  const handleNewTaskOpen = useCallback(() => setNewTaskModalOpen(true), []);
  const handleNewTaskClose = useCallback(() => setNewTaskModalOpen(false), []);

  const handleBoardQuickCreate = useCallback(
    async (input: TaskCreateInput): Promise<void> => {
      await createTask({ ...input, column: "triage" });
    },
    [createTask],
  );

  const handleModalCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, column: "triage" });
      return task;
    },
    [createTask],
  );

  // Planning mode handlers
  const handlePlanningOpen = useCallback(() => setIsPlanningOpen(true), []);
  const handlePlanningClose = useCallback(() => {
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, []);
  const handlePlanningTaskCreated = useCallback((task: Task) => {
    addToast(`Created ${task.id} from planning mode`, "success");
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, [addToast]);

  // Handle planning mode from new task dialog
  const handleNewTaskPlanningMode = useCallback((initialPlan: string) => {
    setPlanningInitialPlan(initialPlan);
    setIsPlanningOpen(true);
  }, []);

  // Handle subtask breakdown from inline/quick create
  const handleSubtaskBreakdown = useCallback((description: string) => {
    setSubtaskInitialDescription(description);
    setIsSubtaskOpen(true);
  }, []);

  const handleSubtaskClose = useCallback(() => {
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
  }, []);

  const handleSubtaskTasksCreated = useCallback((createdTasks: Task[]) => {
    const ids = createdTasks.map((task) => task.id).join(", ");
    addToast(`Created ${ids} from subtask breakdown`, "success");
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
  }, [addToast]);

  // Usage indicator handlers
  const handleOpenUsage = useCallback(() => setUsageOpen(true), []);
  const handleCloseUsage = useCallback(() => setUsageOpen(false), []);

  // Schedules modal handlers
  const handleOpenSchedules = useCallback(() => setSchedulesOpen(true), []);
  const handleCloseSchedules = useCallback(() => setSchedulesOpen(false), []);

  const handleToggleAutoMerge = useCallback(async () => {
    const next = !autoMerge;
    setAutoMerge(next);
    try {
      await updateSettings({ autoMerge: next });
    } catch {
      setAutoMerge(!next); // revert on failure
    }
  }, [autoMerge]);

  const handleToggleGlobalPause = useCallback(async () => {
    const next = !globalPaused;
    setGlobalPaused(next);
    try {
      await updateSettings({ globalPause: next });
    } catch {
      setGlobalPaused(!next); // revert on failure
    }
  }, [globalPaused]);

  const handleToggleEnginePause = useCallback(async () => {
    const next = !enginePaused;
    setEnginePaused(next);
    try {
      await updateSettings({ enginePaused: next });
    } catch {
      setEnginePaused(!next); // revert on failure
    }
  }, [enginePaused]);

  const handleDetailOpen = useCallback((task: TaskDetail) => {
    setDetailTask(task);
  }, []);

  const handleDetailClose = useCallback(() => setDetailTask(null), []);

  const handleGitHubImport = useCallback((task: Task) => {
    addToast(`Imported ${task.id} from GitHub`, "success");
  }, [addToast]);

  const handleToggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => !prev);
  }, []);

  const handleOpenFiles = useCallback(() => {
    setFilesOpen(true);
  }, []);

  const handleOpenFilesForTask = useCallback((taskId: string) => {
    setFileBrowserWorkspace(taskId);
    setFilesOpen(true);
  }, []);

  const handleWorkspaceChange = useCallback((workspace: string) => {
    setFileBrowserWorkspace(workspace);
  }, []);

  // Activity log handlers
  const handleOpenActivityLog = useCallback(() => setActivityLogOpen(true), []);
  const handleCloseActivityLog = useCallback(() => setActivityLogOpen(false), []);

  // Git Manager handlers
  const handleOpenGitManager = useCallback(() => setGitManagerOpen(true), []);
  const handleCloseGitManager = useCallback(() => setGitManagerOpen(false), []);

  // Agent handlers
  const handleOpenAgents = useCallback(() => setAgentsOpen(true), []);
  const handleCloseAgents = useCallback(() => setAgentsOpen(false), []);

  // Scripts handlers
  const handleOpenScripts = useCallback(() => setScriptsOpen(true), []);
  const handleCloseScripts = useCallback(() => setScriptsOpen(false), []);

  const handleRunScript = useCallback((name: string, command: string) => {
    setTerminalInitialCommand(command);
    setScriptsOpen(false);
    setTerminalOpen(true);
    addToast(`Running script: ${name}`, "success");
  }, [addToast]);

  const handleTerminalClose = useCallback(() => {
    setTerminalOpen(false);
    setTerminalInitialCommand(undefined);
  }, []);

  // Setup wizard complete handler
  const handleSetupComplete = useCallback((project: ProjectInfo) => {
    setSetupWizardOpen(false);
    setCurrentProject(project);
    setViewMode("project");
    addToast(`Project ${project.name} added successfully`, "success");
  }, [setCurrentProject, addToast]);

  // Determine which view to render
  const renderMainContent = () => {
    if (viewMode === "overview") {
      return (
        <ProjectOverview
          projects={projects}
          loading={projectsLoading}
          onSelectProject={handleSelectProject}
          onAddProject={handleAddProject}
          onPauseProject={handlePauseProject}
          onResumeProject={handleResumeProject}
          onRemoveProject={handleRemoveProject}
          onViewAllProjects={handleViewAllProjects}
        />
      );
    }

    // Project task view
    if (taskView === "agents") {
      return <AgentsView addToast={addToast} />;
    }

    if (taskView === "board") {
      return (
        <Board
          tasks={tasks}
          maxConcurrent={maxConcurrent}
          onMoveTask={moveTask}
          onOpenDetail={handleDetailOpen}
          addToast={addToast}
          onQuickCreate={handleBoardQuickCreate}
          onNewTask={handleNewTaskOpen}
          onPlanningMode={handleNewTaskPlanningMode}
          onSubtaskBreakdown={handleSubtaskBreakdown}
          autoMerge={autoMerge}
          onToggleAutoMerge={handleToggleAutoMerge}
          globalPaused={globalPaused}
          onUpdateTask={updateTask}
          onArchiveTask={archiveTask}
          onUnarchiveTask={unarchiveTask}
          onArchiveAllDone={archiveAllDone}
          searchQuery={searchQuery}
          availableModels={availableModels}
          onOpenFilesForTask={handleOpenFilesForTask}
          projectId={currentProject?.id}
          projectName={currentProject?.name}
        />
      );
    }

    // List view
    return (
      <ListView
        tasks={tasks}
        onMoveTask={moveTask}
        onOpenDetail={handleDetailOpen}
        addToast={addToast}
        globalPaused={globalPaused}
        onNewTask={handleNewTaskOpen}
        onQuickCreate={handleBoardQuickCreate}
        onPlanningMode={handleNewTaskPlanningMode}
        onSubtaskBreakdown={handleSubtaskBreakdown}
        availableModels={availableModels}
        projectId={currentProject?.id}
        projectName={currentProject?.name}
      />
    );
  };

  return (
    <>
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenGitHubImport={() => setGitHubImportOpen(true)}
        onOpenPlanning={handlePlanningOpen}
        onOpenUsage={handleOpenUsage}
        onOpenActivityLog={handleOpenActivityLog}
        onOpenSchedules={handleOpenSchedules}
        onOpenGitManager={handleOpenGitManager}
        onOpenWorkflowSteps={() => setWorkflowStepsOpen(true)}
        onOpenAgents={handleOpenAgents}
        onOpenScripts={handleOpenScripts}
        onToggleTerminal={handleToggleTerminal}
        onOpenFiles={handleOpenFiles}
        filesOpen={filesOpen}
        globalPaused={globalPaused}
        enginePaused={enginePaused}
        onToggleGlobalPause={handleToggleGlobalPause}
        onToggleEnginePause={handleToggleEnginePause}
        view={taskView}
        onChangeView={setTaskView}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        projects={projects}
        currentProject={currentProject}
        onSelectProject={handleSelectProject}
        onViewAllProjects={handleViewAllProjects}
      />
      {renderMainContent()}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          tasks={tasks}
          onClose={handleDetailClose}
          onOpenDetail={handleDetailOpen}
          onMoveTask={moveTask}
          onDeleteTask={deleteTask}
          onMergeTask={mergeTask}
          onRetryTask={retryTask}
          onDuplicateTask={duplicateTask}
          addToast={addToast}
          githubTokenConfigured={githubTokenConfigured}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            setSettingsInitialSection(undefined);
          }}
          addToast={addToast}
          initialSection={settingsInitialSection}
          themeMode={themeMode}
          colorTheme={colorTheme}
          onThemeModeChange={setThemeMode}
          onColorThemeChange={setColorTheme}
        />
      )}
      <GitHubImportModal
        isOpen={githubImportOpen}
        onClose={() => setGitHubImportOpen(false)}
        onImport={handleGitHubImport}
        tasks={tasks}
      />
      <PlanningModeModal
        isOpen={isPlanningOpen}
        onClose={handlePlanningClose}
        onTaskCreated={handlePlanningTaskCreated}
        tasks={tasks}
        initialPlan={planningInitialPlan ?? undefined}
      />
      <SubtaskBreakdownModal
        isOpen={isSubtaskOpen}
        onClose={handleSubtaskClose}
        initialDescription={subtaskInitialDescription ?? ""}
        onTasksCreated={handleSubtaskTasksCreated}
      />
      <TerminalModal
        isOpen={terminalOpen}
        onClose={handleTerminalClose}
        initialCommand={terminalInitialCommand}
      />
      <ScriptsModal
        isOpen={scriptsOpen}
        onClose={handleCloseScripts}
        addToast={addToast}
        onRunScript={handleRunScript}
      />
      {filesOpen && (
        <FileBrowserModal
          initialWorkspace={fileBrowserWorkspace}
          isOpen={true}
          onClose={() => setFilesOpen(false)}
          onWorkspaceChange={handleWorkspaceChange}
        />
      )}
      <UsageIndicator
        isOpen={usageOpen}
        onClose={handleCloseUsage}
      />
      {schedulesOpen && (
        <ScheduledTasksModal
          onClose={handleCloseSchedules}
          addToast={addToast}
        />
      )}
      <NewTaskModal
        isOpen={newTaskModalOpen}
        onClose={handleNewTaskClose}
        tasks={tasks}
        onCreateTask={handleModalCreate}
        addToast={addToast}
        onPlanningMode={handleNewTaskPlanningMode}
        onSubtaskBreakdown={handleSubtaskBreakdown}
      />
      <ActivityLogModal
        isOpen={activityLogOpen}
        onClose={handleCloseActivityLog}
        tasks={tasks}
        onOpenTaskDetail={(taskId) => {
          const task = tasks.find((t) => t.id === taskId);
          if (task) {
            handleDetailOpen(task as TaskDetail);
          }
        }}
      />
      <GitManagerModal
        isOpen={gitManagerOpen}
        onClose={handleCloseGitManager}
        tasks={tasks}
        addToast={addToast}
      />
      <WorkflowStepManager
        isOpen={workflowStepsOpen}
        onClose={() => setWorkflowStepsOpen(false)}
        addToast={addToast}
      />
      <AgentListModal
        isOpen={agentsOpen}
        onClose={handleCloseAgents}
        addToast={addToast}
      />
      <SetupWizardModal
        isOpen={setupWizardOpen}
        onClose={() => setSetupWizardOpen(false)}
        onComplete={handleSetupComplete}
        onRegisterProject={register}
      />
      <ToastContainer toasts={toasts} onRemove={removeToast} />
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
