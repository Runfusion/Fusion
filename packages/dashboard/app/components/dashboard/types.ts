/**
 * Props for MainContent — the presentational switch that renders the dashboard's
 * main content area based on taskView/viewMode. Extracted verbatim from
 * AppInner's renderMainContent(); every field is an AppInner-scoped value that
 * the switch closes over. The lazy view chunks stay declared in App.tsx (per the
 * inventory guard) and are threaded here as props; other helpers, types, and
 * components are imported directly by MainContent.tsx.
 */
import type { Dispatch, LazyExoticComponent, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type {
  CapacityRiskSignal,
  ColorTheme,
  ColumnId,
  GithubIssueAction,
  MergeResult,
  Task,
  TaskCreateInput,
  TaskDetail,
  ThemeMode,
  WorkflowStep,
} from "@fusion/core";
import type {
  AiSessionSummary,
  DashboardHealthResponse,
  ModelInfo,
  NodeInfo,
  ProjectInfo,
  ProjectInfoWithSource,
  RevertTaskOptions,
  RevertTaskResult,
} from "../../api";
import type { FusionShellApi } from "../../types/native-shell";
import type { DetailTaskOpenOptions, DetailTaskTab, ModalManager } from "../../hooks/useModalManager";
import type { PluginTaskView, TaskView, ViewMode } from "../../hooks/useViewState";
import type { ToastType } from "../../hooks/useToast";
import type { QuickChatButtonMode } from "../../hooks/useAppSettings";
import type { UseRemoteNodeDataResult } from "../../hooks/useRemoteNodeData";
import type { SectionId } from "../SettingsModal";
import type { CliActionId } from "../SessionNotificationBanner";
import type { ApprovalBannerCandidate } from "../../utils/appLifecycle";
import type { GraphWorkflowSelection } from "../GraphWorkflowSwitcherSlot";
// The lazy view components are value exports; importing them as values lets us
// spell their types via `typeof` so MainContent's JSX gets full prop checking.
import { SettingsView } from "../SettingsModal";
import { AgentsView } from "../AgentsView";
import { ChatView } from "../ChatView";
import { CommandCenter } from "../command-center/CommandCenter";
import { DevServerView } from "../DevServerView";
import { DocumentsView } from "../DocumentsView";
import { EvalsView } from "../EvalsView";
import { GitHubImportModal } from "../GitHubImportModal";
import { GoalsView } from "../GoalsView";
import { InsightsView } from "../InsightsView";
import { MemoryView } from "../MemoryView";
import { PullRequestView } from "../PullRequestView";
import { ResearchView } from "../ResearchView";
import { ScheduledTasksModal } from "../ScheduledTasksModal";
import { SecretsView } from "../SecretsView";
import { SkillsView } from "../SkillsView";
import { TodoView } from "../TodoView";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";

export interface MainContentProps {
  showBackendConnectionErrorPage: boolean;
  projectsError: string | null;
  t: TFunction;
  retryingProjects: boolean;
  handleRetryProjects: () => Promise<void>;
  shellApi: FusionShellApi | null;
  taskView: TaskView;
  modalManager: ModalManager;
  handleChangeTaskView: (newView: TaskView) => void;
  refreshAppSettings: () => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
  currentProject: ProjectInfo | null;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  colorTheme: ColorTheme;
  setColorTheme: (theme: ColorTheme) => void;
  dashboardFontScalePct: number;
  setDashboardFontScalePct: (scalePct: number) => void;
  shadcnCustomColors: Record<string, string>;
  setShadcnCustomColors: (colors: Record<string, string>) => void;
  resolvedThemeMode: "dark" | "light";
  setQuickChatButtonModeImmediate: (mode: QuickChatButtonMode) => void;
  reopenOnboardingWithNav: () => void;
  viewMode: ViewMode;
  projects: ProjectInfoWithSource[];
  projectsLoading: boolean;
  handleSelectProject: (project: ProjectInfo) => void;
  handleAddProject: () => void;
  handlePauseProject: (project: ProjectInfo) => Promise<void>;
  handleResumeProject: (project: ProjectInfo) => Promise<void>;
  handleRemoveProject: (project: ProjectInfo) => Promise<void>;
  nodes: NodeInfo[];
  graphPluginTaskView: PluginTaskView | null;
  graphWorkflowSelection: GraphWorkflowSelection | null;
  setGraphWorkflowSelection: Dispatch<SetStateAction<GraphWorkflowSelection | null>>;
  isRemote: boolean;
  remoteData: UseRemoteNodeDataResult;
  tasks: Task[];
  workflowSteps: WorkflowStep[];
  subscribePluginEvents: (
    pluginId: string,
    onEvent: (e: { event: string; payload: unknown }) => void,
  ) => () => void;
  openDetailTask: (
    task: Task | TaskDetail,
    initialTab?: DetailTaskTab,
    options?: DetailTaskOpenOptions,
  ) => void;
  openFileInBrowser: (path: string, opts?: { workspace?: string; line?: number; col?: number }) => void;
  prAuthAvailable: boolean;
  autoMerge: boolean;
  mergeStrategy: string;
  planAutoApproveEnabled: boolean;
  settingsLoaded: boolean;
  openMobileTasksInPopup: boolean;
  taskDetailChatFirst: boolean;
  skillsEnabled: boolean;
  experimentalFeatures: Record<string, boolean>;
  setQuickChatOpen: Dispatch<SetStateAction<boolean>>;
  setMailboxUnreadCount: (count: number) => void;
  setMissionTargetId: Dispatch<SetStateAction<string | undefined>>;
  setMissionResumeSessionId: Dispatch<SetStateAction<string | undefined>>;
  setMilestoneSliceResumeSessionId: Dispatch<SetStateAction<string | undefined>>;
  missionResumeSessionId: string | undefined;
  missionTargetId: string | undefined;
  milestoneSliceResumeSessionId: string | undefined;
  setGoalAnchorId: Dispatch<SetStateAction<string | undefined>>;
  goalAnchorId: string | undefined;
  agentsEnabled: boolean;
  agentOnboardingEnabled: boolean;
  handleOpenTaskLogs: (taskId: string) => Promise<void>;
  popOutTaskDetail: (task: Task | TaskDetail) => void;
  selectedPrId: string | undefined;
  insightsEnabled: boolean;
  handleInsightTaskCreate: (input: { insightId: string; title: string; description: string }) => Promise<void>;
  researchEnabled: boolean;
  openSettingsWithNav: (section?: SectionId) => void;
  researchReadinessVersion: number;
  evalsEnabled: boolean;
  memoryEnabled: boolean;
  goalsEnabled: boolean;
  handleOpenMission: (missionId: string) => void;
  todosEnabled: boolean;
  openPlanningWithInitialPlanWithNav: (initialPlan: string, workflowId?: string | null) => void;
  ingestCreatedTasks: (tasks: Task[]) => void;
  nodesEnabled: boolean;
  openWorkflowEditorWithNav: (workflowId?: string) => void;
  handlePlanningTaskCreated: (task: Task) => void;
  handlePlanningTasksCreated: (tasks: Task[]) => void;
  handleGitHubImport: (task: Task) => void;
  devServerEnabled: boolean;
  mainPanelDetailTask: Task | TaskDetail | null;
  filteredBoardTasks: Task[];
  maxConcurrent: number;
  showWorktreeGrouping: boolean;
  moveTask: (
    id: string,
    column: ColumnId,
    optionsOrPosition?: { preserveProgress?: boolean } | number,
  ) => Promise<Task>;
  pauseTask: (id: string) => Promise<Task>;
  openBoardTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  openTaskDetailInMainPanel: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  openGroupModalWithNav: (groupId: string) => void;
  handleBoardQuickCreate: (input: TaskCreateInput) => Promise<Task>;
  openNewTaskWithNav: () => void;
  subtaskBreakdownEnabled: boolean;
  openSubtaskBreakdownWithNav: (description: string, workflowId?: string | null) => void;
  toggleAutoMerge: () => Promise<void>;
  togglePlanAutoApprove: () => Promise<void>;
  globalPaused: boolean;
  updateTask: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean },
  ) => Promise<Task>;
  retryTask: (id: string) => Promise<Task>;
  archiveTask: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  unarchiveTask: (id: string) => Promise<Task>;
  /*
  FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
  Threaded alongside archiveTask/unarchiveTask; never mutates the source
  task's column as a side effect (see route + client contract comments).
  */
  revertTask: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  deleteTask: (
    id: string,
    options?: {
      removeDependencyReferences?: boolean;
      removeLineageReferences?: boolean;
      githubIssueAction?: GithubIssueAction;
      allowResurrection?: boolean;
    },
  ) => Promise<Task>;
  archiveAllDone: () => Promise<Task[]>;
  loadArchivedTasks: () => Promise<void>;
  /** FNXC:ArchivePagination 2026-07-08-00:00: FN-7659 — fetch the next 100-item page of archived tasks (newest-first). */
  loadMoreArchivedTasks: () => Promise<void>;
  /** Whether another page of archived tasks is available beyond what is currently loaded. */
  archivedHasMore: boolean;
  /** True while a "Show more" archived page fetch is in flight. */
  archivedLoadingMore: boolean;
  searchQuery: string;
  availableModels: ModelInfo[];
  favoriteProviders: string[];
  favoriteModels: string[];
  handleOpenDetailWithTab: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  handleToggleFavorite: (provider: string) => Promise<void>;
  handleToggleModelFavorite: (modelId: string) => Promise<void>;
  taskStuckTimeoutMs: number | undefined;
  staleHighFanoutBlockerAgeThresholdMs: number;
  lastFetchTimeMs: number | undefined;
  openCreateWorkflowWithNav: () => void;
  sidebarActive: boolean;
  isMobile: boolean;
  mainPanelDetailInitialTab: DetailTaskTab | undefined;
  closeTaskDetailMainPanel: () => void;
  setMainPanelDetailTask: Dispatch<SetStateAction<Task | TaskDetail | null>>;
  mergeTask: (id: string) => Promise<MergeResult>;
  resetTask: (id: string) => Promise<Task>;
  duplicateTask: (id: string) => Promise<Task>;
  unpauseTask: (id: string) => Promise<Task>;
  capacityRiskBannerEnabled: boolean;
  capacityRiskDismissed: boolean;
  capacityRiskSignal: CapacityRiskSignal;
  handleDismissCapacityRisk: () => void;
  // App-level lazy view chunks (declared in App.tsx, threaded in as props).
  AgentsView: LazyExoticComponent<typeof AgentsView>;
  ChatView: LazyExoticComponent<typeof ChatView>;
  CommandCenter: LazyExoticComponent<typeof CommandCenter>;
  DevServerView: LazyExoticComponent<typeof DevServerView>;
  DocumentsView: LazyExoticComponent<typeof DocumentsView>;
  EvalsView: LazyExoticComponent<typeof EvalsView>;
  GoalsView: LazyExoticComponent<typeof GoalsView>;
  InsightsView: LazyExoticComponent<typeof InsightsView>;
  MemoryView: LazyExoticComponent<typeof MemoryView>;
  PullRequestView: LazyExoticComponent<typeof PullRequestView>;
  ResearchView: LazyExoticComponent<typeof ResearchView>;
  SecretsView: LazyExoticComponent<typeof SecretsView>;
  SkillsView: LazyExoticComponent<typeof SkillsView>;
  TodoView: LazyExoticComponent<typeof TodoView>;
  _AutomationsView: LazyExoticComponent<typeof ScheduledTasksModal>;
  _ImportTasksView: LazyExoticComponent<typeof GitHubImportModal>;
  _SettingsView: LazyExoticComponent<typeof SettingsView>;
  _WorkflowEditorView: LazyExoticComponent<typeof WorkflowNodeEditor>;
}

/**
 * Props for DashboardBanners — the conditional banner cluster rendered above
 * the dashboard-project-shell, extracted verbatim from AppInner's main return
 * JSX. Every field is an AppInner-scoped value the cluster closes over; the
 * banner components are imported directly by DashboardBanners.tsx.
 */
export interface DashboardBannersProps {
  viewMode: ViewMode;
  currentProject: ProjectInfo | null;
  authTokenRecoveryOpen: boolean;
  isTestMode: boolean;
  dashboardHealth: DashboardHealthResponse | null;
  setDashboardHealth: Dispatch<SetStateAction<DashboardHealthResponse | null>>;
  taskView: TaskView;
  modalManager: ModalManager;
  sessionBannersHidden: boolean;
  sessionsNeedingInput: AiSessionSummary[];
  handleOpenBackgroundSession: (session: AiSessionSummary) => void;
  handleDismissNeedingInputSession: () => void;
  handleDismissAllNeedingInputSessions: () => void;
  handleCliAction: (session: AiSessionSummary, action: CliActionId) => Promise<void>;
  getCliActionDisabledReasonForBanner: (session: AiSessionSummary, action: CliActionId) => string | null;
  openSettingsWithNav: (section?: SectionId) => void;
  showOnboardingResumeCard: boolean;
  showPostOnboardingRecommendations: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  currentVersion: string | null;
  updateBannerDismissed: boolean;
  dismissUpdateBanner: () => void;
  refreshDbCorruptionHealth: () => Promise<void>;
  dbCorruptionRefreshing: boolean;
  dbCorruptionRefreshError: string | null;
  setupReadinessLoading: boolean;
  hasWarnings: boolean;
  setupWarningDismissed: boolean;
  handleDismissSetupWarning: () => void;
  hasAiProvider: boolean;
  hasGithub: boolean;
  showGithubSetupWarning: boolean;
  approvalBannerCandidate: ApprovalBannerCandidate | null;
  dismissApproval: (candidate: ApprovalBannerCandidate) => void;
  mailboxPendingApprovalCount: number;
  handleTaskViewChange: (newView: TaskView) => void;
  showGitHubStarPrompt: boolean;
  gitHubStarPromptShown: boolean;
  markGitHubStarPromptShown: () => void;
  setShowGitHubStarPrompt: Dispatch<SetStateAction<boolean>>;
}
