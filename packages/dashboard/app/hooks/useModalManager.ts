import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail } from "@fusion/core";
import type { SectionId } from "../components/SettingsModal";
import type { ToastType } from "./useToast";

export type DetailTaskTab =
  | "chat"
  | "definition"
  | "logs"
  | "changes"
  | "comments"
  | "model"
  | "workflow"
  | "pr"
  | "retries";

export type DetailTaskOrigin = "list-mobile";

interface UseModalManagerOptions {
  projectId?: string;
  planningSessions: Array<{ id: string }>;
}

/**
 * State and handler contract for App-level modal/overlay orchestration.
 */
export interface ModalManager {
  // State
  newTaskModalOpen: boolean;
  newTaskInitialDescription: string | null;
  isPlanningOpen: boolean;
  planningInitialPlan: string | null;
  planningResumeSessionId: string | undefined;
  isSubtaskOpen: boolean;
  subtaskInitialDescription: string | null;
  subtaskResumeSessionId: string | undefined;
  // Can be Task (optimistic open) or TaskDetail (full data with prompt)
  detailTask: (Task | TaskDetail) | null;
  detailTaskInitialTab: DetailTaskTab;
  detailTaskOrigin: DetailTaskOrigin | null;
  groupModalGroupId: string | null;
  settingsOpen: boolean;
  settingsInitialSection: SectionId | undefined;
  schedulesOpen: boolean;
  githubImportOpen: boolean;
  usageOpen: boolean;
  usageAnchorRect: DOMRect | null;
  terminalOpen: boolean;
  terminalInitialCommand: string | undefined;
  terminalInitialCommandGeneration: number;
  filesOpen: boolean;
  todosOpen: boolean;
  fileBrowserWorkspace: string;
  fileBrowserInitialFile: string | null;
  activityLogOpen: boolean;
  gitManagerOpen: boolean;
  workflowEditorOpen: boolean;
  /** When the workflow editor opens, which internal panel to pre-select (U9 redirect stubs). */
  workflowEditorInitialPanel?: "settings";
  /** When the workflow editor opens, which modal action to start. */
  workflowEditorInitialAction?: "create";
  /** When the workflow editor opens for editing, which workflow id to pre-select. */
  workflowEditorInitialWorkflowId?: string;
  agentsOpen: boolean;
  scriptsOpen: boolean;
  setupWizardOpen: boolean;
  modelOnboardingOpen: boolean;
  anyModalOpen: boolean;

  // Handlers
  openNewTask: () => void;
  openNewTaskWithDescription: (description: string) => void;
  closeNewTask: () => void;

  openPlanning: () => void;
  openPlanningWithInitialPlan: (initialPlan: string) => void;
  resumePlanning: () => void;
  openPlanningWithSession: (sessionId: string) => void;
  closePlanning: () => void;

  openSubtaskBreakdown: (description: string) => void;
  openSubtaskWithSession: (sessionId: string) => void;
  closeSubtask: () => void;

  openDetailTask: (
    task: Task | TaskDetail,
    initialTab?: DetailTaskTab,
    options?: { origin?: DetailTaskOrigin },
  ) => void;
  openDetailWithChangesTab: (task: Task | TaskDetail) => void;
  updateDetailTask: (updated: Partial<TaskDetail>) => void;
  closeDetailTask: () => void;

  openGroupModal: (groupId: string) => void;
  closeGroupModal: () => void;

  openSettings: (section?: SectionId) => void;
  closeSettings: () => void;

  openSchedules: () => void;
  closeSchedules: () => void;

  openGitHubImport: () => void;
  closeGitHubImport: () => void;

  openUsage: (anchorRect?: DOMRect | null) => void;
  closeUsage: () => void;

  toggleTerminal: () => void;
  closeTerminal: () => void;

  openFiles: (workspace?: string, initialFile?: string | null) => void;
  closeFiles: () => void;
  openTodos: () => void;
  closeTodos: () => void;
  setFileWorkspace: (workspace: string) => void;

  openActivityLog: () => void;
  closeActivityLog: () => void;

  openGitManager: () => void;
  closeGitManager: () => void;

  openWorkflowEditor: (initialPanelOrAction?: "settings" | "create", initialWorkflowId?: string) => void;
  closeWorkflowEditor: () => void;

  openAgents: () => void;
  closeAgents: () => void;

  openScripts: () => void;
  closeScripts: () => void;
  runScript: (name: string, command: string) => Promise<void>;

  openSetupWizard: () => void;
  closeSetupWizard: () => void;

  openModelOnboarding: () => void;
  closeModelOnboarding: () => void;

  onPlanningTaskCreated: (task: Task, addToast: (message: string, type?: ToastType) => void) => void;
  onPlanningTasksCreated: (tasks: Task[], addToast: (message: string, type?: ToastType) => void) => void;
  onSubtaskTasksCreated: (tasks: Task[], addToast: (message: string, type?: ToastType) => void) => void;
}

/**
 * Centralized modal manager for dashboard App-level UI state.
 *
 * Encapsulates all modal open/close booleans, related resume/initial payloads,
 * and cross-modal transitions (for example, script runner -> terminal handoff).
 */
export function useModalManager(options: UseModalManagerOptions): ModalManager {
  const { t } = useTranslation("app");
  const { planningSessions } = options;

  const [newTaskModalOpen, setNewTaskModalOpen] = useState(false);
  const [newTaskInitialDescription, setNewTaskInitialDescription] = useState<string | null>(null);
  const [isPlanningOpen, setIsPlanningOpen] = useState(false);
  const [planningInitialPlan, setPlanningInitialPlan] = useState<string | null>(null);
  const [planningResumeSessionId, setPlanningResumeSessionId] = useState<string | undefined>(undefined);
  const [isSubtaskOpen, setIsSubtaskOpen] = useState(false);
  const [subtaskInitialDescription, setSubtaskInitialDescription] = useState<string | null>(null);
  const [subtaskResumeSessionId, setSubtaskResumeSessionId] = useState<string | undefined>(undefined);
  // Can be Task (optimistic open) or TaskDetail (full data with prompt)
  const [detailTask, setDetailTask] = useState<(Task | TaskDetail) | null>(null);
  /**
   * FNXC:TaskDetailTabs 2026-06-17-00:00:
   * FN-6532 makes Chat the default task-detail view whenever a task opens without an explicit tab request.
   */
  const [detailTaskInitialTab, setDetailTaskInitialTab] = useState<DetailTaskTab>("chat");
  const [detailTaskOrigin, setDetailTaskOrigin] = useState<DetailTaskOrigin | null>(null);
  const [groupModalGroupId, setGroupModalGroupId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [githubImportOpen, setGitHubImportOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageAnchorRect, setUsageAnchorRect] = useState<DOMRect | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalInitialCommand, setTerminalInitialCommand] = useState<string | undefined>(undefined);
  const [terminalInitialCommandGeneration, setTerminalInitialCommandGeneration] = useState(0);
  const [filesOpen, setFilesOpen] = useState(false);
  const [todosOpen, setTodosOpen] = useState(false);
  const [fileBrowserWorkspace, setFileBrowserWorkspace] = useState("project");
  const [fileBrowserInitialFile, setFileBrowserInitialFile] = useState<string | null>(null);
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [gitManagerOpen, setGitManagerOpen] = useState(false);
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false);
  const [workflowEditorInitialPanel, setWorkflowEditorInitialPanel] = useState<"settings" | undefined>(undefined);
  const [workflowEditorInitialAction, setWorkflowEditorInitialAction] = useState<"create" | undefined>(undefined);
  const [workflowEditorInitialWorkflowId, setWorkflowEditorInitialWorkflowId] = useState<string | undefined>(undefined);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [modelOnboardingOpen, setModelOnboardingOpen] = useState(false);

  const anyModalOpen = Boolean(
    detailTask ||
      groupModalGroupId ||
      settingsOpen ||
      newTaskModalOpen ||
      isPlanningOpen ||
      isSubtaskOpen ||
      terminalOpen ||
      filesOpen ||
      todosOpen ||
      activityLogOpen ||
      gitManagerOpen ||
      workflowEditorOpen ||
      scriptsOpen ||
      agentsOpen ||
      usageOpen ||
      schedulesOpen ||
      githubImportOpen ||
      setupWizardOpen ||
      modelOnboardingOpen,
  );

  const openNewTask = useCallback(() => {
    setNewTaskInitialDescription(null);
    setNewTaskModalOpen(true);
  }, []);
  const openNewTaskWithDescription = useCallback((description: string) => {
    setNewTaskInitialDescription(description);
    setNewTaskModalOpen(true);
  }, []);
  const closeNewTask = useCallback(() => {
    setNewTaskModalOpen(false);
    setNewTaskInitialDescription(null);
  }, []);

  const openPlanning = useCallback(() => setIsPlanningOpen(true), []);
  const openPlanningWithInitialPlan = useCallback((initialPlan: string) => {
    setPlanningInitialPlan(initialPlan);
    setIsPlanningOpen(true);
  }, []);
  const resumePlanning = useCallback(() => {
    const session = planningSessions[0];
    if (!session) return;
    setPlanningResumeSessionId(session.id);
    setIsPlanningOpen(true);
  }, [planningSessions]);
  const openPlanningWithSession = useCallback((sessionId: string) => {
    setPlanningResumeSessionId(sessionId);
    setIsPlanningOpen(true);
  }, []);
  const closePlanning = useCallback(() => {
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
    setPlanningResumeSessionId(undefined);
  }, []);

  const openSubtaskBreakdown = useCallback((description: string) => {
    setSubtaskInitialDescription(description);
    setIsSubtaskOpen(true);
  }, []);
  const openSubtaskWithSession = useCallback((sessionId: string) => {
    setSubtaskResumeSessionId(sessionId);
    setIsSubtaskOpen(true);
  }, []);
  const closeSubtask = useCallback(() => {
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
    setSubtaskResumeSessionId(undefined);
  }, []);

  /**
   * FNXC:TaskDetailTabs 2026-06-17-00:00:
   * Open-detail callers that omit initialTab should land on Chat; explicit tab requests preserve caller intent.
   */
  const openDetailTask = useCallback((
    task: Task | TaskDetail,
    initialTab: DetailTaskTab = "chat",
    options?: { origin?: DetailTaskOrigin },
  ) => {
    setDetailTask(task);
    setDetailTaskInitialTab(initialTab);
    setDetailTaskOrigin(options?.origin ?? null);
  }, []);
  const openDetailWithChangesTab = useCallback((task: Task | TaskDetail) => {
    setDetailTask(task);
    setDetailTaskInitialTab("changes");
    setDetailTaskOrigin(null);
  }, []);
  const updateDetailTask = useCallback((updated: Partial<TaskDetail>) => {
    setDetailTask((prev) => {
      if (!prev) return prev;
      if (updated.id !== undefined && updated.id !== prev.id) {
        return prev;
      }
      return { ...prev, ...updated };
    });
  }, []);
  const closeDetailTask = useCallback(() => {
    setDetailTask(null);
    setDetailTaskOrigin(null);
  }, []);

  const openGroupModal = useCallback((groupId: string) => {
    setGroupModalGroupId(groupId);
  }, []);
  const closeGroupModal = useCallback(() => {
    setGroupModalGroupId(null);
  }, []);

  const openSettings = useCallback((section?: SectionId) => {
    setSettingsInitialSection(section);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsInitialSection(undefined);
  }, []);

  const openSchedules = useCallback(() => setSchedulesOpen(true), []);
  const closeSchedules = useCallback(() => setSchedulesOpen(false), []);

  const openGitHubImport = useCallback(() => setGitHubImportOpen(true), []);
  const closeGitHubImport = useCallback(() => setGitHubImportOpen(false), []);

  const openUsage = useCallback((anchorRect?: DOMRect | null) => {
    setUsageAnchorRect(anchorRect ?? null);
    setUsageOpen(true);
  }, []);
  const closeUsage = useCallback(() => {
    setUsageOpen(false);
    setUsageAnchorRect(null);
  }, []);

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => !prev);
  }, []);
  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
    setTerminalInitialCommand(undefined);
  }, []);

  const openFiles = useCallback((workspace?: string, initialFile?: string | null) => {
    if (typeof workspace === "string" && workspace) {
      setFileBrowserWorkspace(workspace);
    }
    if (typeof initialFile === "string" || initialFile === null) {
      setFileBrowserInitialFile(initialFile);
    } else {
      setFileBrowserInitialFile(null);
    }
    setFilesOpen(true);
  }, []);
  const closeFiles = useCallback(() => {
    setFilesOpen(false);
    setFileBrowserInitialFile(null);
  }, []);
  const openTodos = useCallback(() => setTodosOpen(true), []);
  const closeTodos = useCallback(() => setTodosOpen(false), []);
  const setFileWorkspace = useCallback((workspace: string) => {
    if (typeof workspace === "string" && workspace) {
      setFileBrowserWorkspace(workspace);
    }
  }, []);

  const openActivityLog = useCallback(() => setActivityLogOpen(true), []);
  const closeActivityLog = useCallback(() => setActivityLogOpen(false), []);

  const openGitManager = useCallback(() => setGitManagerOpen(true), []);
  const closeGitManager = useCallback(() => setGitManagerOpen(false), []);

  const openWorkflowEditor = useCallback((initialPanelOrAction?: "settings" | "create", initialWorkflowId?: string) => {
    const isSettingsOpen = initialPanelOrAction === "settings";
    const isCreateOpen = initialPanelOrAction === "create";
    setWorkflowEditorInitialPanel(isSettingsOpen ? "settings" : undefined);
    setWorkflowEditorInitialAction(isCreateOpen ? "create" : undefined);
    setWorkflowEditorInitialWorkflowId(!isSettingsOpen && !isCreateOpen ? initialWorkflowId : undefined);
    setWorkflowEditorOpen(true);
  }, []);
  const closeWorkflowEditor = useCallback(() => {
    setWorkflowEditorOpen(false);
    setWorkflowEditorInitialPanel(undefined);
    setWorkflowEditorInitialAction(undefined);
    setWorkflowEditorInitialWorkflowId(undefined);
  }, []);

  const openAgents = useCallback(() => setAgentsOpen(true), []);
  const closeAgents = useCallback(() => setAgentsOpen(false), []);

  const openScripts = useCallback(() => setScriptsOpen(true), []);
  const closeScripts = useCallback(() => setScriptsOpen(false), []);
  const runScript = useCallback(async (_name: string, command: string) => {
    setScriptsOpen(false);
    setTerminalInitialCommand(command);
    setTerminalInitialCommandGeneration((generation) => generation + 1);
    setTerminalOpen(true);
  }, []);

  const openSetupWizard = useCallback(() => setSetupWizardOpen(true), []);
  const closeSetupWizard = useCallback(() => setSetupWizardOpen(false), []);

  const openModelOnboarding = useCallback(() => setModelOnboardingOpen(true), []);
  const closeModelOnboarding = useCallback(() => setModelOnboardingOpen(false), []);

  const onPlanningTaskCreated = useCallback((task: Task, addToast: (message: string, type?: ToastType) => void) => {
    addToast(t("modalManager.createdFromPlanning", "Created {{id}} from planning mode", { id: task.id }), "success");
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, [t]);

  const onPlanningTasksCreated = useCallback((tasks: Task[], addToast: (message: string, type?: ToastType) => void) => {
    const ids = tasks.map((task) => task.id).join(", ");
    addToast(t("modalManager.createdMultipleFromPlanning", "Created {{ids}} from planning mode", { ids }), "success");
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, [t]);

  const onSubtaskTasksCreated = useCallback((tasks: Task[], addToast: (message: string, type?: ToastType) => void) => {
    const ids = tasks.map((task) => task.id).join(", ");
    addToast(t("modalManager.createdFromSubtask", "Created {{ids}} from subtask breakdown", { ids }), "success");
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
  }, [t]);

  return {
    newTaskModalOpen,
    newTaskInitialDescription,
    isPlanningOpen,
    planningInitialPlan,
    planningResumeSessionId,
    isSubtaskOpen,
    subtaskInitialDescription,
    subtaskResumeSessionId,
    detailTask,
    detailTaskInitialTab,
    detailTaskOrigin,
    groupModalGroupId,
    settingsOpen,
    settingsInitialSection,
    schedulesOpen,
    githubImportOpen,
    usageOpen,
    usageAnchorRect,
    terminalOpen,
    terminalInitialCommand,
    terminalInitialCommandGeneration,
    filesOpen,
    todosOpen,
    fileBrowserWorkspace,
    fileBrowserInitialFile,
    activityLogOpen,
    gitManagerOpen,
    workflowEditorOpen,
    workflowEditorInitialPanel,
    workflowEditorInitialAction,
    workflowEditorInitialWorkflowId,
    agentsOpen,
    scriptsOpen,
    setupWizardOpen,
    modelOnboardingOpen,
    anyModalOpen,
    openNewTask,
    openNewTaskWithDescription,
    closeNewTask,
    openPlanning,
    openPlanningWithInitialPlan,
    resumePlanning,
    openPlanningWithSession,
    closePlanning,
    openSubtaskBreakdown,
    openSubtaskWithSession,
    closeSubtask,
    openDetailTask,
    openDetailWithChangesTab,
    updateDetailTask,
    closeDetailTask,
    openGroupModal,
    closeGroupModal,
    openSettings,
    closeSettings,
    openSchedules,
    closeSchedules,
    openGitHubImport,
    closeGitHubImport,
    openUsage,
    closeUsage,
    toggleTerminal,
    closeTerminal,
    openFiles,
    closeFiles,
    openTodos,
    closeTodos,
    setFileWorkspace,
    openActivityLog,
    closeActivityLog,
    openGitManager,
    closeGitManager,
    openWorkflowEditor,
    closeWorkflowEditor,
    openAgents,
    closeAgents,
    openScripts,
    closeScripts,
    runScript,
    openSetupWizard,
    closeSetupWizard,
    openModelOnboarding,
    closeModelOnboarding,
    onPlanningTaskCreated,
    onPlanningTasksCreated,
    onSubtaskTasksCreated,
  };
}
