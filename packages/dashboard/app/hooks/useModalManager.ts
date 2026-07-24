import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail } from "@fusion/core";
import type { SectionId } from "../components/SettingsModal";
import type { ToastType } from "./useToast";
import { removeScopedItem } from "../utils/projectStorage";

/*
FNXC:TaskDetailActivity 2026-06-30-22:15:
Keep `chat` as the public initial-tab id for the renamed Activity task-detail tab so existing dashboard callers and deep links remain compatible until the future planner Chat tab ships under its own contract. Legacy `logs` callers are also preserved by TaskDetailModal, which opens Activity → Feed instead of rendering a top-level Logs tab.
*/
export type DetailTaskTab =
  | "summary"
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
export type DetailTaskInitialAction = "refine";

export interface DetailTaskOpenOptions {
  origin?: DetailTaskOrigin;
  initialAction?: DetailTaskInitialAction;
}

export interface DetailTaskInitialActionRequest {
  action: DetailTaskInitialAction;
  requestId: number;
}

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
  newTaskInitialWorkflowId: string | null | undefined;
  isPlanningOpen: boolean;
  planningInitialPlan: string | null;
  planningResumeSessionId: string | undefined;
  planningWorkflowId: string | null | undefined;
  isSubtaskOpen: boolean;
  subtaskInitialDescription: string | null;
  subtaskResumeSessionId: string | undefined;
  subtaskWorkflowId: string | null | undefined;
  // Can be Task (optimistic open) or TaskDetail (full data with prompt)
  detailTask: (Task | TaskDetail) | null;
  detailTaskInitialTab: DetailTaskTab | undefined;
  detailTaskInitialAction: DetailTaskInitialActionRequest | null;
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
  openNewTask: (workflowId?: string | null) => void;
  openNewTaskWithDescription: (description: string) => void;
  closeNewTask: () => void;

  openPlanning: () => void;
  openPlanningWithInitialPlan: (initialPlan: string, workflowId?: string | null) => void;
  resumePlanning: () => void;
  openPlanningWithSession: (sessionId: string) => void;
  /**
  FNXC:PlanningModals 2026-07-23-00:00:
  One-shot consumption of the seeded initial plan. Embedded Planning calls this the moment its
  auto-start fires; the payload must not survive that start, because Planning unmounts on
  main-content navigation and a still-set planningInitialPlan re-auto-started a duplicate
  planning session on every navigate-back remount.
  */
  clearPlanningInitialPlan: () => void;
  closePlanning: () => void;

  openSubtaskBreakdown: (description: string, workflowId?: string | null) => void;
  openSubtaskWithSession: (sessionId: string) => void;
  closeSubtask: () => void;

  openDetailTask: (
    task: Task | TaskDetail,
    initialTab?: DetailTaskTab,
    options?: DetailTaskOpenOptions,
  ) => void;
  openDetailWithChangesTab: (task: Task | TaskDetail) => void;
  updateDetailTask: (updated: Partial<TaskDetail>) => void;
  closeDetailTask: () => void;

  openGroupModal: (groupId: string) => void;
  closeGroupModal: () => void;

  openSettings: (section?: SectionId) => void;
  /*
  FNXC:Settings 2026-06-22-00:00:
  Sets the Settings initial/active section WITHOUT opening the modal overlay. Used by the embedded main-content Settings view so header/sidebar/deep-link entry points can carry a requested section while navigating to taskView === "settings" instead of mounting the dialog.
  */
  setSettingsSection: (section?: SectionId) => void;
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

  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Switching the active project must dismiss modals that show the previous project's data
  (task detail, group, new task, subtask breakdown, GitHub import, files, git manager,
  activity log, workflow editor, scripts, terminal) and drop pending planning payloads so
  Planning does not reopen the old project's plan. Cross-project modals (settings,
  schedules, usage, agents, setup wizard, model onboarding) stay open.
  */
  closeProjectScopedModals: () => void;

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
  const [newTaskInitialWorkflowId, setNewTaskInitialWorkflowId] = useState<string | null | undefined>(undefined);
  const [isPlanningOpen, setIsPlanningOpen] = useState(false);
  const [planningInitialPlan, setPlanningInitialPlan] = useState<string | null>(null);
  const [planningResumeSessionId, setPlanningResumeSessionId] = useState<string | undefined>(undefined);
  const [planningWorkflowId, setPlanningWorkflowId] = useState<string | null | undefined>(undefined);
  const [isSubtaskOpen, setIsSubtaskOpen] = useState(false);
  const [subtaskInitialDescription, setSubtaskInitialDescription] = useState<string | null>(null);
  const [subtaskResumeSessionId, setSubtaskResumeSessionId] = useState<string | undefined>(undefined);
  const [subtaskWorkflowId, setSubtaskWorkflowId] = useState<string | null | undefined>(undefined);
  // Can be Task (optimistic open) or TaskDetail (full data with prompt)
  const [detailTask, setDetailTask] = useState<(Task | TaskDetail) | null>(null);
  /**
   * FNXC:TaskDetailTabs 2026-06-17-00:00:
   * FN-6532 makes Chat the default task-detail view whenever a task opens without an explicit tab request.
   *
   * FNXC:TaskDetailSummaryTab 2026-06-27-00:00:
   * Store omitted task-detail tabs as `undefined` so done tasks can resolve the implicit landing tab to Summary without stealing explicit Chat requests.
   */
  const [detailTaskInitialTab, setDetailTaskInitialTab] = useState<DetailTaskTab | undefined>(undefined);
  /*
  FNXC:DoneTaskRefine 2026-07-01-00:00:
  Done-task card/list context menus must open the existing Task Detail refinement modal after right-click or long-press. Store refinement as a one-shot action request with a monotonically increasing id so selecting Refine again for an already-open task reopens the composer without duplicating API/form logic outside TaskDetailContent.
  */
  const [detailTaskInitialAction, setDetailTaskInitialAction] = useState<DetailTaskInitialActionRequest | null>(null);
  const detailTaskInitialActionRequestIdRef = useRef(0);
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
      /*
      FNXC:Navigation 2026-06-21-00:00:
      FN-6886 reuses Planning Mode state only as docked-view payload storage, so it must not make the app behave as though a blocking modal overlay is open.
      */
      isSubtaskOpen ||
      terminalOpen ||
      filesOpen ||
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

  const openNewTask = useCallback((workflowId?: string | null) => {
    setNewTaskInitialDescription(null);
    setNewTaskInitialWorkflowId(workflowId);
    setNewTaskModalOpen(true);
  }, []);
  const openNewTaskWithDescription = useCallback((description: string) => {
    setNewTaskInitialDescription(description);
    setNewTaskInitialWorkflowId(undefined);
    setNewTaskModalOpen(true);
  }, []);
  const closeNewTask = useCallback(() => {
    setNewTaskModalOpen(false);
    setNewTaskInitialDescription(null);
    setNewTaskInitialWorkflowId(undefined);
  }, []);

  const openPlanning = useCallback(() => {
    // FNXC:PlanningModals 2026-06-20-20:10:
    // A fresh planning open must clear any resume-session id / initial plan left
    // by a prior resumePlanning/openPlanningWith* flow; otherwise the modal reopens
    // into the stale session or pre-fills an old plan instead of starting blank.
    setPlanningResumeSessionId(undefined);
    setPlanningInitialPlan(null);
    setPlanningWorkflowId(undefined);
    setIsPlanningOpen(true);
  }, []);
  const openPlanningWithInitialPlan = useCallback((initialPlan: string, workflowId?: string | null) => {
    // FNXC:PlanningModals 2026-06-20-20:10: clear a stale resume-session id so the
    // supplied initial plan is honored rather than being overridden by an old session.
    setPlanningResumeSessionId(undefined);
    setPlanningInitialPlan(initialPlan);
    setPlanningWorkflowId(workflowId);
    setIsPlanningOpen(true);
  }, []);
  const resumePlanning = useCallback(() => {
    const session = planningSessions[0];
    if (!session) return;
    setPlanningWorkflowId(undefined);
    setPlanningResumeSessionId(session.id);
    setIsPlanningOpen(true);
  }, [planningSessions]);
  const openPlanningWithSession = useCallback((sessionId: string) => {
    setPlanningWorkflowId(undefined);
    setPlanningResumeSessionId(sessionId);
    setIsPlanningOpen(true);
  }, []);
  const clearPlanningInitialPlan = useCallback(() => {
    setPlanningInitialPlan(null);
  }, []);
  const closePlanning = useCallback(() => {
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
    setPlanningResumeSessionId(undefined);
    setPlanningWorkflowId(undefined);
  }, []);

  const openSubtaskBreakdown = useCallback((description: string, workflowId?: string | null) => {
    // FNXC:PlanningModals 2026-06-20-20:10: clear a stale subtask resume-session id
    // so a new breakdown starts fresh rather than reopening a prior session.
    setSubtaskResumeSessionId(undefined);
    setSubtaskInitialDescription(description);
    setSubtaskWorkflowId(workflowId);
    setIsSubtaskOpen(true);
  }, []);
  const openSubtaskWithSession = useCallback((sessionId: string) => {
    setSubtaskWorkflowId(undefined);
    setSubtaskResumeSessionId(sessionId);
    setIsSubtaskOpen(true);
  }, []);
  const closeSubtask = useCallback(() => {
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
    setSubtaskResumeSessionId(undefined);
    setSubtaskWorkflowId(undefined);
  }, []);

  /**
   * FNXC:TaskDetailTabs 2026-06-17-00:00:
   * Open-detail callers that omit initialTab should land on the task-detail default; explicit tab requests preserve caller intent.
   */
  const openDetailTask = useCallback((
    task: Task | TaskDetail,
    initialTab?: DetailTaskTab,
    options?: DetailTaskOpenOptions,
  ) => {
    setDetailTask(task);
    setDetailTaskInitialTab(initialTab);
    setDetailTaskInitialAction(options?.initialAction ? { action: options.initialAction, requestId: detailTaskInitialActionRequestIdRef.current += 1 } : null);
    setDetailTaskOrigin(options?.origin ?? null);
  }, []);
  const openDetailWithChangesTab = useCallback((task: Task | TaskDetail) => {
    setDetailTask(task);
    setDetailTaskInitialTab("changes");
    setDetailTaskInitialAction(null);
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
    setDetailTaskInitialAction(null);
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
  const setSettingsSection = useCallback((section?: SectionId) => {
    setSettingsInitialSection(section);
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

  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Project swap left the previous project's modals open (a task-detail modal for project A
  kept rendering over project B's board) and kept planning resume/initial-plan payloads,
  so the docked Planning view re-entered project A's session. Close every project-scoped
  modal and clear their payloads in one transition; deliberately leave settings,
  schedules, usage, agents, setup wizard, and model onboarding alone — they are not
  project-scoped surfaces.
  */
  const closeProjectScopedModals = useCallback(() => {
    setDetailTask(null);
    setDetailTaskInitialTab(undefined);
    setDetailTaskInitialAction(null);
    setDetailTaskOrigin(null);
    setGroupModalGroupId(null);
    setNewTaskModalOpen(false);
    setNewTaskInitialDescription(null);
    setNewTaskInitialWorkflowId(undefined);
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
    setSubtaskResumeSessionId(undefined);
    setSubtaskWorkflowId(undefined);
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
    setPlanningResumeSessionId(undefined);
    setPlanningWorkflowId(undefined);
    setGitHubImportOpen(false);
    setFilesOpen(false);
    setFileBrowserInitialFile(null);
    setActivityLogOpen(false);
    setGitManagerOpen(false);
    setWorkflowEditorOpen(false);
    setWorkflowEditorInitialPanel(undefined);
    setWorkflowEditorInitialAction(undefined);
    setWorkflowEditorInitialWorkflowId(undefined);
    setScriptsOpen(false);
    setTerminalOpen(false);
    setTerminalInitialCommand(undefined);
  }, []);

  const clearQuickAddPlanningDrafts = useCallback(() => {
    /*
    FNXC:QuickAddPlanningPreserve 2026-06-22-00:00:
    Planning completion, not planning exit, is the only modal-manager transition that clears preserved quick-add drafts. Use the active project id so scoped drafts are removed from the correct workspace.
    */
    removeScopedItem("kb-quick-entry-text", options.projectId);
    removeScopedItem("kb-inline-create-text", options.projectId);
  }, [options.projectId]);

  const onPlanningTaskCreated = useCallback((task: Task, addToast: (message: string, type?: ToastType) => void) => {
    addToast(t("modalManager.createdFromPlanning", "Created {{id}} from planning mode", { id: task.id }), "success");
    clearQuickAddPlanningDrafts();
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, [clearQuickAddPlanningDrafts, t]);

  const onPlanningTasksCreated = useCallback((tasks: Task[], addToast: (message: string, type?: ToastType) => void) => {
    const ids = tasks.map((task) => task.id).join(", ");
    addToast(t("modalManager.createdMultipleFromPlanning", "Created {{ids}} from planning mode", { ids }), "success");
    clearQuickAddPlanningDrafts();
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, [clearQuickAddPlanningDrafts, t]);

  const onSubtaskTasksCreated = useCallback((tasks: Task[], addToast: (message: string, type?: ToastType) => void) => {
    const ids = tasks.map((task) => task.id).join(", ");
    addToast(t("modalManager.createdFromSubtask", "Created {{ids}} from subtask breakdown", { ids }), "success");
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
  }, [t]);

  return {
    newTaskModalOpen,
    newTaskInitialDescription,
    newTaskInitialWorkflowId,
    isPlanningOpen,
    planningInitialPlan,
    planningResumeSessionId,
    planningWorkflowId,
    isSubtaskOpen,
    subtaskInitialDescription,
    subtaskResumeSessionId,
    subtaskWorkflowId,
    detailTask,
    detailTaskInitialTab,
    detailTaskInitialAction,
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
    clearPlanningInitialPlan,
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
    setSettingsSection,
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
    closeProjectScopedModals,
    onPlanningTaskCreated,
    onPlanningTasksCreated,
    onSubtaskTasksCreated,
  };
}
