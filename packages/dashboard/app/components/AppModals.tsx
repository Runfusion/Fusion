import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import type { ProjectInfo } from "../api";
import type { ColorTheme, Column, MergeResult, Task, TaskCreateInput, ThemeMode, GithubIssueAction } from "@fusion/core";
import type { UseProjectActionsResult } from "../hooks/useProjectActions";
import type { ModalManager } from "../hooks/useModalManager";
import type { UseTaskHandlersResult } from "../hooks/useTaskHandlers";
import type { Toast, ToastType } from "../hooks/useToast";
import { ModalErrorBoundary } from "./ErrorBoundary";
import { TaskDetailModal } from "./TaskDetailModal";
import { GitHubImportModal } from "./GitHubImportModal";
import { SubtaskBreakdownModal } from "./SubtaskBreakdownModal";
import { ScriptsModal } from "./ScriptsModal";
import { FileBrowserModal } from "./FileBrowserModal";
import { UsageIndicator } from "./UsageIndicator";
import { ScheduledTasksModal } from "./ScheduledTasksModal";
import { NewTaskModal } from "./NewTaskModal";
import { ActivityLogModal } from "./ActivityLogModal";
import { GitManagerModal } from "./GitManagerModal";
import { AgentListModal } from "./AgentListModal";
import { ModelOnboardingModal } from "./ModelOnboardingModal";
import { ToastContainer } from "./ToastContainer";
import { GroupTaskModal } from "./GroupTaskModal";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";

const SetupWizardModal = lazy(() => import("./SetupWizardModal").then((m) => ({ default: m.SetupWizardModal })));
const SettingsModal = lazy(() => import("./SettingsModal").then((m) => ({ default: m.SettingsModal })));
const WorkflowNodeEditor = lazy(() => import("./WorkflowNodeEditor").then((m) => ({ default: m.WorkflowNodeEditor })));

function prefetchSettingsModal() {
  const idle: (cb: () => void, opts?: { timeout?: number }) => number =
    (typeof window !== "undefined" &&
      (window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      }).requestIdleCallback) ||
    ((cb: () => void) => globalThis.setTimeout(cb, 200) as unknown as number);

  idle(() => {
    void import("./SettingsModal");
  }, { timeout: 1_500 });
}

interface AppModalsProps {
  projectId?: string;
  tasks: Task[];
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  addToast: (message: string, type?: ToastType) => void;
  toasts: Toast[];
  removeToast: (id: number) => void;
  modalManager: ModalManager;
  projectActions: Pick<UseProjectActionsResult, "handleAddProject" | "handleSetupComplete" | "handleModelOnboardingComplete">;
  taskHandlers: Pick<UseTaskHandlersResult, "handleModalCreate" | "handlePlanningTaskCreated" | "handlePlanningTasksCreated" | "handleSubtaskTasksCreated" | "handleGitHubImport">;
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
  taskOperations: {
    moveTask: (taskId: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
    deleteTask: (taskId: string, options?: {
      removeDependencyReferences?: boolean;
      removeLineageReferences?: boolean;
      githubIssueAction?: GithubIssueAction;
      allowResurrection?: boolean;
    }) => Promise<Task>;
    mergeTask: (taskId: string) => Promise<MergeResult>;
    archiveTask: (taskId: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
    retryTask: (taskId: string) => Promise<Task>;
    resetTask: (taskId: string) => Promise<Task>;
    duplicateTask: (taskId: string) => Promise<Task>;
  };
  deepLink: {
    handleDetailClose: () => void;
  };
  settings: {
    prAuthAvailable: boolean;
    autoMerge: boolean;
    taskDetailChatFirst: boolean;
    themeMode: ThemeMode;
    colorTheme: ColorTheme;
    dashboardFontScalePct: number;
    shadcnCustomColors: Record<string, string>;
    resolvedThemeMode: "dark" | "light";
    setThemeMode: (mode: ThemeMode) => void;
    setColorTheme: (theme: ColorTheme) => void;
    setDashboardFontScalePct: (scalePct: number) => void;
    setShadcnCustomColors: (colors: Record<string, string>) => void;
    setQuickChatButtonModeImmediate: (mode: "floating" | "footer" | "off") => void;
  };
  /** Optional override for the settings modal close handler. When provided, this is called instead of modalManager.closeSettings. */
  onSettingsClose?: () => void;
  /** Optional callback to reopen the onboarding guide from Settings. Closes Settings and opens ModelOnboardingModal. */
  onReopenOnboarding?: () => void;
  /** Optional callback to open mailbox approvals from Settings. */
  onOpenApprovals?: (approvalId?: string) => void;
  /** Enables planning-style agent onboarding entry points inside setup. */
  agentOnboardingEnabled?: boolean;
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
  onPlanningMode,
  onSubtaskBreakdown,
  taskOperations,
  deepLink,
  settings,
  onSettingsClose,
  onReopenOnboarding,
  onOpenApprovals,
  agentOnboardingEnabled = false,
}: AppModalsProps) {
  const { pushNav, removeNav } = useNavigationHistoryContext();
  const [firstCreatedTask, setFirstCreatedTask] = useState<Task | null>(null);
  const detailNavCloseRef = useRef<(() => void) | null>(null);
  const detailTask = modalManager.detailTask
    ? (() => {
        const liveTask = tasks.find((task) => task.id === modalManager.detailTask?.id);
        if (!liveTask) {
          return modalManager.detailTask;
        }

        if ("prompt" in modalManager.detailTask) {
          return {
            ...modalManager.detailTask,
            ...liveTask,
            prompt: modalManager.detailTask.prompt,
            log: modalManager.detailTask.log,
          };
        }

        return liveTask;
      })()
    : null;

  // Use the override handler if provided, otherwise fall back to modalManager.closeSettings
  const handleSettingsClose = onSettingsClose ?? modalManager.closeSettings;

  /*
  FNXC:TaskDetailBack 2026-06-25-00:00:
  Modal task detail uses the same idempotent close path for explicit Close and browser/Android Back so deep-link URL cleanup is not skipped during popstate. Each open records the pushed history callback because nested task-detail links can create multiple detail entries with otherwise identical close behavior.

  FNXC:TaskDetailSwipeBack 2026-06-29-14:20:
  Mobile swipe-back (`popstate`) for modal task detail must step back through nested task-detail opens before dismissing the modal. The latest pushed callback restores the previous task/tab/origin snapshot when one exists, and explicit close falls back to the original first-open callback (`modalManager.closeDetailTask`) so programmatic closes still consume the matching history entry.
  */
  const closeDetailFromHistory = useCallback(() => {
    modalManager.closeDetailTask();
    deepLink.handleDetailClose();
    detailNavCloseRef.current = null;
  }, [deepLink, modalManager]);

  const closeDetailWithNav = useCallback(() => {
    removeNav(detailNavCloseRef.current ?? modalManager.closeDetailTask);
    closeDetailFromHistory();
  }, [closeDetailFromHistory, modalManager, removeNav]);

  const closeGroupWithNav = useCallback(() => {
    removeNav(modalManager.closeGroupModal);
    modalManager.closeGroupModal();
  }, [modalManager.closeGroupModal, removeNav]);

  const closeSettingsWithNav = useCallback(() => {
    removeNav(handleSettingsClose);
    handleSettingsClose();
  }, [handleSettingsClose, removeNav]);

  const closeGitHubImportWithNav = useCallback(() => {
    removeNav(modalManager.closeGitHubImport);
    modalManager.closeGitHubImport();
  }, [modalManager.closeGitHubImport, removeNav]);

  const closeSubtaskWithNav = useCallback(() => {
    removeNav(modalManager.closeSubtask);
    modalManager.closeSubtask();
  }, [modalManager.closeSubtask, removeNav]);

  const closeScriptsWithNav = useCallback(() => {
    removeNav(modalManager.closeScripts);
    modalManager.closeScripts();
  }, [modalManager.closeScripts, removeNav]);

  const closeFilesWithNav = useCallback(() => {
    removeNav(modalManager.closeFiles);
    modalManager.closeFiles();
  }, [modalManager.closeFiles, removeNav]);

  const closeUsageWithNav = useCallback(() => {
    removeNav(modalManager.closeUsage);
    modalManager.closeUsage();
  }, [modalManager.closeUsage, removeNav]);

  const closeSchedulesWithNav = useCallback(() => {
    removeNav(modalManager.closeSchedules);
    modalManager.closeSchedules();
  }, [modalManager.closeSchedules, removeNav]);

  const closeNewTaskWithNav = useCallback(() => {
    removeNav(modalManager.closeNewTask);
    modalManager.closeNewTask();
  }, [modalManager.closeNewTask, removeNav]);

  const closeActivityLogWithNav = useCallback(() => {
    removeNav(modalManager.closeActivityLog);
    modalManager.closeActivityLog();
  }, [modalManager.closeActivityLog, removeNav]);

  const closeGitManagerWithNav = useCallback(() => {
    removeNav(modalManager.closeGitManager);
    modalManager.closeGitManager();
  }, [modalManager.closeGitManager, removeNav]);

  const closeWorkflowEditorWithNav = useCallback(() => {
    removeNav(modalManager.closeWorkflowEditor);
    modalManager.closeWorkflowEditor();
  }, [modalManager.closeWorkflowEditor, removeNav]);

  const closeAgentsWithNav = useCallback(() => {
    removeNav(modalManager.closeAgents);
    modalManager.closeAgents();
  }, [modalManager.closeAgents, removeNav]);

  const closeSetupWizardWithNav = useCallback(() => {
    removeNav(modalManager.closeSetupWizard);
    modalManager.closeSetupWizard();
  }, [modalManager.closeSetupWizard, removeNav]);

  const handleOpenNewTask = useCallback(() => {
    modalManager.openNewTask();
  }, [modalManager]);

  const handleOpenGitHubImport = useCallback(() => {
    modalManager.openGitHubImport();
  }, [modalManager]);

  const openDetailTaskWithNav = useCallback(
    (
      task: Parameters<typeof modalManager.openDetailTask>[0],
      tab?: Parameters<typeof modalManager.openDetailTask>[1],
      options?: Parameters<typeof modalManager.openDetailTask>[2],
    ) => {
      const previousDetailTask = modalManager.detailTask;
      const previousDetailTab = modalManager.detailTaskInitialTab;
      const previousDetailOrigin = modalManager.detailTaskOrigin;
      const previousDetailAction = modalManager.detailTaskInitialAction;
      const previousNavClose = detailNavCloseRef.current;

      modalManager.openDetailTask(task, tab, options);
      const closeFromHistory = () => {
        if (detailNavCloseRef.current === closeFromHistory) {
          detailNavCloseRef.current = previousNavClose;
        }
        if (previousDetailTask) {
          modalManager.openDetailTask(
            previousDetailTask,
            previousDetailTab,
            previousDetailOrigin || previousDetailAction
              ? { origin: previousDetailOrigin ?? undefined, initialAction: previousDetailAction?.action }
              : undefined,
          );
          return;
        }
        modalManager.closeDetailTask();
        deepLink.handleDetailClose();
      };
      detailNavCloseRef.current = closeFromHistory;
      pushNav({ type: "modal", close: closeFromHistory });
    },
    [deepLink, modalManager, pushNav],
  );

  const openGroupModalWithNav = useCallback((groupId: string) => {
    modalManager.openGroupModal(groupId);
    pushNav({ type: "modal", close: modalManager.closeGroupModal });
  }, [modalManager, pushNav]);

  const handleOnboardingViewTask = useCallback((task: Task) => {
    setFirstCreatedTask(null);
    modalManager.closeModelOnboarding();
    openDetailTaskWithNav(task);
  }, [modalManager, openDetailTaskWithNav]);

  const handleModalCreateWithOnboardingTracking = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await taskHandlers.handleModalCreate(input);
      if (modalManager.modelOnboardingOpen) {
        setFirstCreatedTask(task);
      }
      return task;
    },
    [taskHandlers.handleModalCreate, modalManager.modelOnboardingOpen],
  );

  useEffect(() => {
    if (!modalManager.modelOnboardingOpen && firstCreatedTask) {
      setFirstCreatedTask(null);
    }
  }, [modalManager.modelOnboardingOpen, firstCreatedTask]);

  useEffect(() => {
    prefetchSettingsModal();
  }, []);

  return (
    <>
      {detailTask && (
        <ModalErrorBoundary>
          <TaskDetailModal
            task={detailTask}
            projectId={projectId}
            tasks={tasks}
            onClose={closeDetailWithNav}
            onOpenDetail={openDetailTaskWithNav}
            mobileHeaderMode={modalManager.detailTaskOrigin === "list-mobile" ? "back" : "close"}
            onMoveTask={taskOperations.moveTask}
            onDeleteTask={taskOperations.deleteTask}
            onMergeTask={taskOperations.mergeTask}
            onArchiveTask={taskOperations.archiveTask}
            onRetryTask={taskOperations.retryTask}
            onResetTask={taskOperations.resetTask}
            onDuplicateTask={taskOperations.duplicateTask}
            onTaskUpdated={modalManager.updateDetailTask}
            addToast={addToast}
            prAuthAvailable={settings.prAuthAvailable}
            autoMergeEnabled={settings.autoMerge}
            taskDetailChatFirst={settings.taskDetailChatFirst}
            onOpenWorkflowEditor={() => modalManager.openWorkflowEditor()}
            initialTab={modalManager.detailTaskInitialTab}
            initialAction={modalManager.detailTaskInitialAction}
          />
        </ModalErrorBoundary>
      )}

      {modalManager.groupModalGroupId && (
        <ModalErrorBoundary>
          <GroupTaskModal
            isOpen={Boolean(modalManager.groupModalGroupId)}
            onClose={closeGroupWithNav}
            groupId={modalManager.groupModalGroupId}
            projectId={projectId}
            onOpenMemberTask={(taskId) => {
              const memberTask = tasks.find((task) => task.id === taskId);
              if (memberTask) {
                openDetailTaskWithNav(memberTask);
              }
            }}
          />
        </ModalErrorBoundary>
      )}

      {modalManager.settingsOpen && (
        <ModalErrorBoundary>
          <Suspense fallback={null}>
            <SettingsModal
              onClose={closeSettingsWithNav}
              addToast={addToast}
              initialSection={modalManager.settingsInitialSection}
              projectId={projectId}
              themeMode={settings.themeMode}
              colorTheme={settings.colorTheme}
              onThemeModeChange={settings.setThemeMode}
              onColorThemeChange={settings.setColorTheme}
              dashboardFontScalePct={settings.dashboardFontScalePct}
              shadcnCustomColors={settings.shadcnCustomColors}
              resolvedThemeMode={settings.resolvedThemeMode}
              onDashboardFontScaleChange={settings.setDashboardFontScalePct}
              onShadcnCustomColorsChange={settings.setShadcnCustomColors}
              onQuickChatButtonModeChange={settings.setQuickChatButtonModeImmediate}
              onReopenOnboarding={onReopenOnboarding}
              onOpenApprovals={onOpenApprovals}
              onOpenWorkflowSettings={() => {
                closeSettingsWithNav();
                modalManager.openWorkflowEditor("settings");
              }}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      <GitHubImportModal
        isOpen={modalManager.githubImportOpen}
        onClose={closeGitHubImportWithNav}
        onImport={taskHandlers.handleGitHubImport}
        tasks={tasks}
        projectId={projectId}
      />

      <ModalErrorBoundary>
        <SubtaskBreakdownModal
          isOpen={modalManager.isSubtaskOpen}
          onClose={closeSubtaskWithNav}
          initialDescription={modalManager.subtaskInitialDescription ?? ""}
          onTasksCreated={taskHandlers.handleSubtaskTasksCreated}
          projectId={projectId}
          workflowId={modalManager.subtaskWorkflowId}
          resumeSessionId={modalManager.subtaskResumeSessionId}
          onOpenGroupModal={openGroupModalWithNav}
        />
      </ModalErrorBoundary>

      <ScriptsModal
        isOpen={modalManager.scriptsOpen}
        onClose={closeScriptsWithNav}
        addToast={addToast}
        onRunScript={modalManager.runScript}
        projectId={projectId}
      />

      {modalManager.filesOpen && (
        <FileBrowserModal
          initialWorkspace={modalManager.fileBrowserWorkspace}
          initialFile={modalManager.fileBrowserInitialFile}
          isOpen={true}
          onClose={closeFilesWithNav}
          onWorkspaceChange={modalManager.setFileWorkspace}
          projectId={projectId}
          onSendSelectionToTask={modalManager.openNewTaskWithDescription}
        />
      )}

      <UsageIndicator
        isOpen={modalManager.usageOpen}
        onClose={closeUsageWithNav}
        projectId={projectId}
        anchorRect={modalManager.usageAnchorRect}
      />

      {modalManager.schedulesOpen && (
        <ScheduledTasksModal
          onClose={closeSchedulesWithNav}
          addToast={addToast}
          projectId={projectId}
        />
      )}

      <ModalErrorBoundary>
        <NewTaskModal
          isOpen={modalManager.newTaskModalOpen}
          onClose={closeNewTaskWithNav}
          tasks={tasks}
          onCreateTask={handleModalCreateWithOnboardingTracking}
          addToast={addToast}
          projectId={projectId}
          initialDescription={modalManager.newTaskInitialDescription ?? ""}
          onPlanningMode={onPlanningMode}
          onSubtaskBreakdown={onSubtaskBreakdown}
        />
      </ModalErrorBoundary>

      <ActivityLogModal
        isOpen={modalManager.activityLogOpen}
        onClose={closeActivityLogWithNav}
        tasks={tasks}
        projectId={projectId}
        projects={projects}
        currentProject={currentProject}
        onOpenTaskDetail={(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task) {
            openDetailTaskWithNav(task);
          }
        }}
      />

      <ModalErrorBoundary>
        <GitManagerModal
          isOpen={modalManager.gitManagerOpen}
          onClose={closeGitManagerWithNav}
          tasks={tasks}
          addToast={addToast}
          projectId={projectId}
        />
      </ModalErrorBoundary>

      {modalManager.workflowEditorOpen && (
        <ModalErrorBoundary>
          <Suspense fallback={null}>
            <WorkflowNodeEditor
              isOpen={modalManager.workflowEditorOpen}
              onClose={closeWorkflowEditorWithNav}
              addToast={addToast}
              projectId={projectId}
              initialPanel={modalManager.workflowEditorInitialPanel}
              initialAction={modalManager.workflowEditorInitialAction}
              initialWorkflowId={modalManager.workflowEditorInitialWorkflowId}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      <AgentListModal
        isOpen={modalManager.agentsOpen}
        onClose={closeAgentsWithNav}
        addToast={addToast}
        projectId={projectId}
      />

      {modalManager.setupWizardOpen && (
        <Suspense fallback={null}>
          <SetupWizardModal
            onProjectRegistered={projectActions.handleSetupComplete}
            onClose={closeSetupWizardWithNav}
            agentOnboardingEnabled={agentOnboardingEnabled}
            includeAgentStep={!modalManager.modelOnboardingOpen}
          />
        </Suspense>
      )}

      {/* FNXC:Onboarding 2026-06-22-05:06: Brand-new onboarding owns AI/GitHub first, then opens the project setup wizard only as the Project step sub-flow. Hide model onboarding while that project wizard is mounted so users never see both flows at once. */}
      {modalManager.modelOnboardingOpen && !modalManager.setupWizardOpen && (
        <ModelOnboardingModal
          onComplete={projectActions.handleModelOnboardingComplete}
          addToast={addToast}
          projectId={projectId ?? ""}
          onOpenSetupWizard={projectActions.handleAddProject}
          onOpenNewTask={handleOpenNewTask}
          onOpenGitHubImport={handleOpenGitHubImport}
          firstCreatedTask={firstCreatedTask}
          onViewTask={handleOnboardingViewTask}
          agentOnboardingEnabled={agentOnboardingEnabled}
        />
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </>
  );
}
