import { useState, type ReactNode } from "react";
import type { Task } from "@fusion/core";
import { Header } from "../components/Header";
import { MainContent } from "../components/dashboard/MainContent";
import { ChatView } from "../components/ChatView";
import type { MainContentProps } from "../components/dashboard/types";
import type { TaskView } from "../hooks/useViewState";

/*
FNXC:BoardNavigation 2026-09-18-02:12:
FN-522 — « quand je passe d'une vue comme Planning ou Missions au Board, mon board n'apparaît pas comme je l'ai
laissé, comme s'il était poussé par le header des éléments des autres vues ». Le retour est une transition entre
PLUSIEURS hôtes réels (`Header`, le routage de `MainContent`, les vues conservées de `MainViewKeepAlive`) partageant
un seul `.project-content`. Un shell recopié ne prouverait rien : ce harnais monte donc les vrais hôtes dans la
vraie chaîne `.dashboard-project-stack` → `.dashboard-project-shell` → `.project-content`, et laisse le propriétaire
de route (ici l'état local, comme `useViewState` dans App) être la seule autorité de navigation.

Partagé entre la régression jsdom (propriétaires DOM, identité, offsets contrôlés) et la fixture navigateur
(géométrie réellement mesurée), afin que les deux preuves portent sur la même composition.
*/

export const BOARD_RETURN_WORKFLOW = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In Progress", flags: {} },
    { id: "in-review", name: "In Review", flags: { review: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

/*
FNXC:WorkflowControls 2026-09-18-02:12:
FN-407 supprime légitimement tout sélecteur quand une seule option existe. Deux workflows sont donc requis pour que
les assertions de propriété du slot portent sur un contrôle qui peut exister.
*/
export const BOARD_RETURN_SECONDARY_WORKFLOW = { ...BOARD_RETURN_WORKFLOW, id: "builtin:research", name: "Research" };

const noop = () => undefined;
const asyncNoop = async () => undefined;

export function boardReturnTask(id: string, column = "todo"): Task {
  const timestamp = "2026-09-18T00:00:00.000Z";
  return {
    id,
    title: `Tâche ${id} avec un titre volontairement long pour remplir la colonne`,
    description: "",
    column,
    status: "pending",
    prompt: "",
    steps: [],
    attachments: [],
    dependencies: [],
    log: [],
    currentStep: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    columnMovedAt: timestamp,
  } as unknown as Task;
}

export const BOARD_RETURN_TASKS: Task[] = [
  boardReturnTask("FN-001", "triage"),
  boardReturnTask("FN-002", "todo"),
  boardReturnTask("FN-003", "todo"),
  boardReturnTask("FN-004", "in-progress"),
  boardReturnTask("FN-005", "in-review"),
  boardReturnTask("FN-006", "done"),
];

/**
 * Vi-free MainContentProps factory so the jsdom regression and the browser fixture drive the SAME
 * production switch. Callers override only what their scenario really varies.
 */
export function buildBoardReturnMainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  const tasks = (overrides.tasks as Task[] | undefined) ?? BOARD_RETURN_TASKS;
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: asyncNoop,
    shellApi: null,
    taskView: "board",
    modalManager: {
      closeSettings: noop,
      closePlanning: noop,
      openNewTaskWithDescription: noop,
      planningEntryGeneration: 0,
      detailTask: null,
      anyModalOpen: false,
    } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: noop,
    openHistory: noop,
    refreshAppSettings: asyncNoop,
    addToast: noop,
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    ChatView: ChatView as unknown as MainContentProps["ChatView"],
    viewMode: "project",
    tasks,
    filteredBoardTasks: tasks,
    workflowSteps: [],
    remoteData: { tasks: [] } as unknown as MainContentProps["remoteData"],
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as unknown as MainContentProps["capacityRiskSignal"],
    maxConcurrent: 2,
    maxWorktrees: 4,
    showWorktreeGrouping: false,
    moveTask: asyncNoop,
    boostTask: asyncNoop,
    pauseTask: asyncNoop,
    openBoardTaskDetail: noop,
    openTaskDetailInMainPanel: noop,
    openGroupModalWithNav: noop,
    handleBoardQuickCreate: asyncNoop,
    openNewTaskWithNav: noop,
    openPlanningWithInitialPlanWithNav: noop,
    toggleAutoMerge: asyncNoop,
    togglePlanAutoApprove: asyncNoop,
    autoMerge: true,
    planAutoApproveEnabled: false,
    mergeStrategy: "direct",
    globalPaused: false,
    updateTask: asyncNoop,
    retryTask: asyncNoop,
    unpauseTask: asyncNoop,
    resetTask: asyncNoop,
    duplicateTask: asyncNoop,
    mergeTask: asyncNoop,
    revertTask: asyncNoop,
    restoreTaskRevert: asyncNoop,
    deleteTask: asyncNoop,
    searchQuery: "",
    availableModels: [],
    favoriteProviders: [],
    favoriteModels: [],
    handleOpenDetailWithTab: noop,
    handleToggleFavorite: asyncNoop,
    handleToggleModelFavorite: asyncNoop,
    staleHighFanoutBlockerAgeThresholdMs: 0,
    handleOpenMission: noop,
    lastFetchTimeMs: undefined,
    prAuthAvailable: false,
    sidebarActive: false,
    isMobile: false,
    isRemote: false,
    experimentalFeatures: {},
    ingestCreatedTasks: noop,
    openDetailTask: noop,
    popOutTaskDetail: noop,
    onOpenChatWithPrefill: noop,
    closeTaskDetailMainPanel: noop,
    setMainPanelDetailTask: noop,
    handleDismissCapacityRisk: noop,
    mainPanelDetailTask: null,
    pluginDashboardViews: [],
    ...overrides,
  } as unknown as MainContentProps;
}

export interface BoardViewReturnHarnessProps {
  initialView?: TaskView;
  isMobile?: boolean;
  /** Sibling rendered inside `.project-content`, as App renders the kept-alive Planning host. */
  planningSibling?: (active: boolean) => ReactNode;
  mainContentOverrides?: Partial<MainContentProps>;
  /** Observes every route change the harness performs (route-owner audit). */
  onViewChange?: (view: TaskView) => void;
}

/**
 * Real Header + real MainContent routing + the kept-alive Planning sibling inside the production
 * shell chain. Navigation is driven through `data-testid="board-return-nav-<view>"` controls so a
 * test never reaches inside a component to fake a route.
 */
export function BoardViewReturnHarness({
  initialView = "board",
  isMobile = false,
  planningSibling,
  mainContentOverrides,
  onViewChange,
}: BoardViewReturnHarnessProps) {
  const [taskView, setTaskView] = useState<TaskView>(initialView);
  const changeView = (next: TaskView) => {
    setTaskView(next);
    onViewChange?.(next);
  };

  return (
    <div className="dashboard-project-stack" data-testid="dashboard-project-stack">
      {/*
      FNXC:WorkflowControls 2026-09-18-02:12:
      `leftSidebarNavActive` / `mobileNavEnabled` reproduisent le shell officiel : c'est la seule configuration où
      `#header-workflow-slot` existe réellement (FN-439/FN-481). Sans eux le harnais mesurerait en permanence le
      repli en ligne, c'est-à-dire l'état défectueux, et ne prouverait rien.
      */}
      <Header
        view={taskView}
        onChangeView={changeView}
        leftSidebarNavActive={!isMobile}
        mobileNavEnabled={isMobile}
        boardBackgroundActive={isMobile && taskView !== "board"}
      />
      <nav aria-label="Harness navigation">
        {(["board", "planning", "missions", "list"] as TaskView[]).map((view) => (
          <button key={view} type="button" data-testid={`board-return-nav-${view}`} onClick={() => changeView(view)}>
            {view}
          </button>
        ))}
      </nav>
      <div className="dashboard-project-shell" data-testid="dashboard-project-shell">
        <div className="project-content" data-testid="project-content">
          <MainContent
            {...buildBoardReturnMainContentProps({
              taskView,
              isMobile,
              handleChangeTaskView: changeView,
              ...mainContentOverrides,
            })}
          />
          {planningSibling?.(taskView === "planning")}
        </div>
      </div>
    </div>
  );
}
