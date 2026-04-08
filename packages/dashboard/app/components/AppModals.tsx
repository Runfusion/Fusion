import type { ProjectInfo } from "../api";
import type { ColorTheme, Column, MergeResult, Task, TaskCreateInput, TaskDetail, ThemeMode } from "@fusion/core";
import type { UseProjectActionsResult } from "../hooks/useProjectActions";
import type { ModalManager } from "../hooks/useModalManager";
import type { UseTaskHandlersResult } from "../hooks/useTaskHandlers";
import type { Toast, ToastType } from "../hooks/useToast";
import { TaskDetailModal } from "./TaskDetailModal";
import { SettingsModal } from "./SettingsModal";
import { GitHubImportModal } from "./GitHubImportModal";
import { PlanningModeModal } from "./PlanningModeModal";
import { SubtaskBreakdownModal } from "./SubtaskBreakdownModal";
import { TerminalModal } from "./TerminalModal";
import { ScriptsModal } from "./ScriptsModal";
import { FileBrowserModal } from "./FileBrowserModal";
import { UsageIndicator } from "./UsageIndicator";
import { ScheduledTasksModal } from "./ScheduledTasksModal";
import { NewTaskModal } from "./NewTaskModal";
import { ActivityLogModal } from "./ActivityLogModal";
import { GitManagerModal } from "./GitManagerModal";
import { WorkflowStepManager } from "./WorkflowStepManager";
import { MissionManager } from "./MissionManager";
import { AgentListModal } from "./AgentListModal";
import { MailboxModal } from "./MailboxModal";
import { SetupWizardModal } from "./SetupWizardModal";
import { ModelOnboardingModal } from "./ModelOnboardingModal";
import { ToastContainer } from "./ToastContainer";

interface AppModalsProps {
  projectId?: string;
  tasks: Task[];
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  addToast: (message: string, type?: ToastType) => void;
  toasts: Toast[];
  removeToast: (id: number) => void;
  modalManager: ModalManager;
  projectActions: Pick<UseProjectActionsResult, "handleSetupComplete" | "handleModelOnboardingComplete">;
  taskHandlers: Pick<UseTaskHandlersResult, "handleModalCreate" | "handlePlanningTaskCreated" | "handlePlanningTasksCreated" | "handleSubtaskTasksCreated" | "handleGitHubImport">;
  taskOperations: {
    moveTask: (taskId: string, column: Column, position?: number) => Promise<Task>;
    deleteTask: (taskId: string) => Promise<Task>;
    mergeTask: (taskId: string) => Promise<MergeResult>;
    retryTask: (taskId: string) => Promise<Task>;
    duplicateTask: (taskId: string) => Promise<Task>;
  };
  deepLink: {
    handleDetailClose: () => void;
  };
  settings: {
    githubTokenConfigured: boolean;
    themeMode: ThemeMode;
    colorTheme: ColorTheme;
    setThemeMode: (mode: ThemeMode) => void;
    setColorTheme: (theme: ColorTheme) => void;
  };
}

export function AppModals({
  projectId,
  tasks,
  projects,
  currentProject,
  addToast,
  toasts,
  removeToast,
  modalManager,
  projectActions,
  taskHandlers,
  taskOperations,
  deepLink,
  settings,
}: AppModalsProps) {
  return (
    <>
      {modalManager.detailTask && (
        <TaskDetailModal
          task={modalManager.detailTask}
          projectId={projectId}
          tasks={tasks}
          onClose={deepLink.handleDetailClose}
          onOpenDetail={modalManager.openDetailTask}
          onMoveTask={taskOperations.moveTask}
          onDeleteTask={taskOperations.deleteTask}
          onMergeTask={taskOperations.mergeTask}
          onRetryTask={taskOperations.retryTask}
          onDuplicateTask={taskOperations.duplicateTask}
          onTaskUpdated={modalManager.updateDetailTask}
          addToast={addToast}
          githubTokenConfigured={settings.githubTokenConfigured}
          initialTab={modalManager.detailTaskInitialTab}
        />
      )}

      {modalManager.settingsOpen && (
        <SettingsModal
          onClose={modalManager.closeSettings}
          addToast={addToast}
          initialSection={modalManager.settingsInitialSection}
          projectId={projectId}
          themeMode={settings.themeMode}
          colorTheme={settings.colorTheme}
          onThemeModeChange={settings.setThemeMode}
          onColorThemeChange={settings.setColorTheme}
        />
      )}

      <GitHubImportModal
        isOpen={modalManager.githubImportOpen}
        onClose={modalManager.closeGitHubImport}
        onImport={taskHandlers.handleGitHubImport}
        tasks={tasks}
      />

      <PlanningModeModal
        isOpen={modalManager.isPlanningOpen}
        onClose={modalManager.closePlanning}
        onTaskCreated={taskHandlers.handlePlanningTaskCreated}
        onTasksCreated={taskHandlers.handlePlanningTasksCreated}
        tasks={tasks}
        initialPlan={modalManager.planningInitialPlan ?? undefined}
        projectId={projectId}
        resumeSessionId={modalManager.planningResumeSessionId}
      />

      <SubtaskBreakdownModal
        isOpen={modalManager.isSubtaskOpen}
        onClose={modalManager.closeSubtask}
        initialDescription={modalManager.subtaskInitialDescription ?? ""}
        onTasksCreated={taskHandlers.handleSubtaskTasksCreated}
        projectId={projectId}
        resumeSessionId={modalManager.subtaskResumeSessionId}
      />

      <TerminalModal
        isOpen={modalManager.terminalOpen}
        onClose={modalManager.closeTerminal}
        initialCommand={modalManager.terminalInitialCommand}
        projectId={projectId}
      />

      <ScriptsModal
        isOpen={modalManager.scriptsOpen}
        onClose={modalManager.closeScripts}
        addToast={addToast}
        onRunScript={modalManager.runScript}
        projectId={projectId}
      />

      {modalManager.filesOpen && (
        <FileBrowserModal
          initialWorkspace={modalManager.fileBrowserWorkspace}
          isOpen={true}
          onClose={modalManager.closeFiles}
          onWorkspaceChange={modalManager.setFileWorkspace}
        />
      )}

      <UsageIndicator
        isOpen={modalManager.usageOpen}
        onClose={modalManager.closeUsage}
        projectId={projectId}
      />

      {modalManager.schedulesOpen && (
        <ScheduledTasksModal
          onClose={modalManager.closeSchedules}
          addToast={addToast}
        />
      )}

      <NewTaskModal
        isOpen={modalManager.newTaskModalOpen}
        onClose={modalManager.closeNewTask}
        tasks={tasks}
        onCreateTask={taskHandlers.handleModalCreate}
        addToast={addToast}
        projectId={projectId}
        onPlanningMode={modalManager.openPlanningWithInitialPlan}
        onSubtaskBreakdown={modalManager.openSubtaskBreakdown}
      />

      <ActivityLogModal
        isOpen={modalManager.activityLogOpen}
        onClose={modalManager.closeActivityLog}
        tasks={tasks}
        projectId={projectId}
        projects={projects}
        currentProject={currentProject}
        onOpenTaskDetail={(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task) {
            modalManager.openDetailTask(task as TaskDetail);
          }
        }}
      />

      <GitManagerModal
        isOpen={modalManager.gitManagerOpen}
        onClose={modalManager.closeGitManager}
        tasks={tasks}
        addToast={addToast}
      />

      <WorkflowStepManager
        isOpen={modalManager.workflowStepsOpen}
        onClose={modalManager.closeWorkflowSteps}
        addToast={addToast}
        projectId={projectId}
      />

      <MissionManager
        isOpen={modalManager.missionsOpen}
        onClose={modalManager.closeMissions}
        addToast={addToast}
        projectId={projectId}
        resumeSessionId={modalManager.missionResumeSessionId}
        targetMissionId={modalManager.missionTargetId}
        availableTasks={tasks.map((task) => ({ id: task.id, title: task.title }))}
        onSelectTask={(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task) {
            modalManager.openDetailTask(task as TaskDetail);
          }
        }}
      />

      <AgentListModal
        isOpen={modalManager.agentsOpen}
        onClose={modalManager.closeAgents}
        addToast={addToast}
        projectId={projectId}
      />

      <MailboxModal
        isOpen={modalManager.mailboxOpen}
        onClose={modalManager.closeMailbox}
        projectId={projectId}
        addToast={addToast}
        agents={modalManager.mailboxAgents}
      />

      {modalManager.setupWizardOpen && (
        <SetupWizardModal
          onProjectRegistered={projectActions.handleSetupComplete}
          onClose={modalManager.closeSetupWizard}
        />
      )}

      {modalManager.modelOnboardingOpen && (
        <ModelOnboardingModal
          onComplete={projectActions.handleModelOnboardingComplete}
          addToast={addToast}
        />
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </>
  );
}
