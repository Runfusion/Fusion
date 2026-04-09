import { useCallback, useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import { fetchAgents, fetchUnreadCount, type Agent } from "../api";
import type { SectionId } from "../components/SettingsModal";
import type { ToastType } from "./useToast";

export type DetailTaskTab =
  | "definition"
  | "logs"
  | "changes"
  | "commits"
  | "comments"
  | "model"
  | "workflow";

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
  isPlanningOpen: boolean;
  planningInitialPlan: string | null;
  planningResumeSessionId: string | undefined;
  isSubtaskOpen: boolean;
  subtaskInitialDescription: string | null;
  subtaskResumeSessionId: string | undefined;
  // Can be Task (optimistic open) or TaskDetail (full data with prompt)
  detailTask: (Task | TaskDetail) | null;
  detailTaskInitialTab: DetailTaskTab;
  settingsOpen: boolean;
  settingsInitialSection: SectionId | undefined;
  schedulesOpen: boolean;
  githubImportOpen: boolean;
  usageOpen: boolean;
  terminalOpen: boolean;
  terminalInitialCommand: string | undefined;
  filesOpen: boolean;
  fileBrowserWorkspace: string;
  activityLogOpen: boolean;
  mailboxOpen: boolean;
  mailboxUnreadCount: number;
  mailboxAgents: Agent[];
  gitManagerOpen: boolean;
  workflowStepsOpen: boolean;
  agentsOpen: boolean;
  scriptsOpen: boolean;
  setupWizardOpen: boolean;
  modelOnboardingOpen: boolean;
  anyModalOpen: boolean;

  // Handlers
  openNewTask: () => void;
  closeNewTask: () => void;

  openPlanning: () => void;
  openPlanningWithInitialPlan: (initialPlan: string) => void;
  resumePlanning: () => void;
  openPlanningWithSession: (sessionId: string) => void;
  closePlanning: () => void;

  openSubtaskBreakdown: (description: string) => void;
  openSubtaskWithSession: (sessionId: string) => void;
  closeSubtask: () => void;

  openDetailTask: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  openDetailWithChangesTab: (task: Task | TaskDetail) => void;
  updateDetailTask: (updated: Partial<TaskDetail>) => void;
  closeDetailTask: () => void;

  openSettings: (section?: SectionId) => void;
  closeSettings: () => void;

  openSchedules: () => void;
  closeSchedules: () => void;

  openGitHubImport: () => void;
  closeGitHubImport: () => void;

  openUsage: () => void;
  closeUsage: () => void;

  toggleTerminal: () => void;
  closeTerminal: () => void;

  openFiles: () => void;
  closeFiles: () => void;
  setFileWorkspace: (workspace: string) => void;

  openActivityLog: () => void;
  closeActivityLog: () => void;

  openMailbox: () => void;
  closeMailbox: () => void;

  openGitManager: () => void;
  closeGitManager: () => void;

  openWorkflowSteps: () => void;
  closeWorkflowSteps: () => void;

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
  const { projectId, planningSessions } = options;

  const [newTaskModalOpen, setNewTaskModalOpen] = useState(false);
  const [isPlanningOpen, setIsPlanningOpen] = useState(false);
  const [planningInitialPlan, setPlanningInitialPlan] = useState<string | null>(null);
  const [planningResumeSessionId, setPlanningResumeSessionId] = useState<string | undefined>(undefined);
  const [isSubtaskOpen, setIsSubtaskOpen] = useState(false);
  const [subtaskInitialDescription, setSubtaskInitialDescription] = useState<string | null>(null);
  const [subtaskResumeSessionId, setSubtaskResumeSessionId] = useState<string | undefined>(undefined);
  // Can be Task (optimistic open) or TaskDetail (full data with prompt)
  const [detailTask, setDetailTask] = useState<(Task | TaskDetail) | null>(null);
  const [detailTaskInitialTab, setDetailTaskInitialTab] = useState<DetailTaskTab>("definition");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [githubImportOpen, setGitHubImportOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalInitialCommand, setTerminalInitialCommand] = useState<string | undefined>(undefined);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileBrowserWorkspace, setFileBrowserWorkspace] = useState("project");
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [mailboxOpen, setMailboxOpen] = useState(false);
  const [mailboxUnreadCount, setMailboxUnreadCount] = useState(0);
  const [mailboxAgents, setMailboxAgents] = useState<Agent[]>([]);
  const [gitManagerOpen, setGitManagerOpen] = useState(false);
  const [workflowStepsOpen, setWorkflowStepsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [modelOnboardingOpen, setModelOnboardingOpen] = useState(false);

  const anyModalOpen = Boolean(
    detailTask ||
      settingsOpen ||
      newTaskModalOpen ||
      isPlanningOpen ||
      isSubtaskOpen ||
      terminalOpen ||
      filesOpen ||
      activityLogOpen ||
      mailboxOpen ||
      gitManagerOpen ||
      workflowStepsOpen ||
      scriptsOpen ||
      agentsOpen ||
      usageOpen ||
      schedulesOpen ||
      githubImportOpen ||
      setupWizardOpen ||
      modelOnboardingOpen,
  );

  const openNewTask = useCallback(() => setNewTaskModalOpen(true), []);
  const closeNewTask = useCallback(() => setNewTaskModalOpen(false), []);

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

  const openDetailTask = useCallback((task: Task | TaskDetail, initialTab: DetailTaskTab = "definition") => {
    setDetailTask(task);
    setDetailTaskInitialTab(initialTab);
  }, []);
  const openDetailWithChangesTab = useCallback((task: Task | TaskDetail) => {
    setDetailTask(task);
    setDetailTaskInitialTab("changes");
  }, []);
  const updateDetailTask = useCallback((updated: Partial<TaskDetail>) => {
    setDetailTask((prev) => (prev ? { ...prev, ...updated } : prev));
  }, []);
  const closeDetailTask = useCallback(() => {
    setDetailTask(null);
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

  const openUsage = useCallback(() => setUsageOpen(true), []);
  const closeUsage = useCallback(() => setUsageOpen(false), []);

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => !prev);
  }, []);
  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
    setTerminalInitialCommand(undefined);
  }, []);

  const openFiles = useCallback(() => setFilesOpen(true), []);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const setFileWorkspace = useCallback((workspace: string) => {
    setFileBrowserWorkspace(workspace);
  }, []);

  const openActivityLog = useCallback(() => setActivityLogOpen(true), []);
  const closeActivityLog = useCallback(() => setActivityLogOpen(false), []);

  const openMailbox = useCallback(() => {
    setMailboxOpen(true);

    fetchUnreadCount(projectId)
      .then((data) => {
        setMailboxUnreadCount(data.unreadCount);
      })
      .catch(() => {});

    fetchAgents(undefined, projectId)
      .then((agents) => {
        setMailboxAgents(agents);
      })
      .catch(() => {});
  }, [projectId]);
  const closeMailbox = useCallback(() => setMailboxOpen(false), []);

  const openGitManager = useCallback(() => setGitManagerOpen(true), []);
  const closeGitManager = useCallback(() => setGitManagerOpen(false), []);

  const openWorkflowSteps = useCallback(() => setWorkflowStepsOpen(true), []);
  const closeWorkflowSteps = useCallback(() => setWorkflowStepsOpen(false), []);

  const openAgents = useCallback(() => setAgentsOpen(true), []);
  const closeAgents = useCallback(() => setAgentsOpen(false), []);

  const openScripts = useCallback(() => setScriptsOpen(true), []);
  const closeScripts = useCallback(() => setScriptsOpen(false), []);
  const runScript = useCallback(async (_name: string, command: string) => {
    setScriptsOpen(false);
    setTerminalInitialCommand(command);
    setTerminalOpen(true);
  }, []);

  const openSetupWizard = useCallback(() => setSetupWizardOpen(true), []);
  const closeSetupWizard = useCallback(() => setSetupWizardOpen(false), []);

  const openModelOnboarding = useCallback(() => setModelOnboardingOpen(true), []);
  const closeModelOnboarding = useCallback(() => setModelOnboardingOpen(false), []);

  const onPlanningTaskCreated = useCallback((task: Task, addToast: (message: string, type?: ToastType) => void) => {
    addToast(`Created ${task.id} from planning mode`, "success");
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, []);

  const onPlanningTasksCreated = useCallback((tasks: Task[], addToast: (message: string, type?: ToastType) => void) => {
    const ids = tasks.map((task) => task.id).join(", ");
    addToast(`Created ${ids} from planning mode`, "success");
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, []);

  const onSubtaskTasksCreated = useCallback((tasks: Task[], addToast: (message: string, type?: ToastType) => void) => {
    const ids = tasks.map((task) => task.id).join(", ");
    addToast(`Created ${ids} from subtask breakdown`, "success");
    setIsSubtaskOpen(false);
    setSubtaskInitialDescription(null);
  }, []);

  return {
    newTaskModalOpen,
    isPlanningOpen,
    planningInitialPlan,
    planningResumeSessionId,
    isSubtaskOpen,
    subtaskInitialDescription,
    subtaskResumeSessionId,
    detailTask,
    detailTaskInitialTab,
    settingsOpen,
    settingsInitialSection,
    schedulesOpen,
    githubImportOpen,
    usageOpen,
    terminalOpen,
    terminalInitialCommand,
    filesOpen,
    fileBrowserWorkspace,
    activityLogOpen,
    mailboxOpen,
    mailboxUnreadCount,
    mailboxAgents,
    gitManagerOpen,
    workflowStepsOpen,
    agentsOpen,
    scriptsOpen,
    setupWizardOpen,
    modelOnboardingOpen,
    anyModalOpen,
    openNewTask,
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
    setFileWorkspace,
    openActivityLog,
    closeActivityLog,
    openMailbox,
    closeMailbox,
    openGitManager,
    closeGitManager,
    openWorkflowSteps,
    closeWorkflowSteps,
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
