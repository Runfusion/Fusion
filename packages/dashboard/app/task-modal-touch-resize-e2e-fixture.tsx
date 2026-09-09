import React, { useState } from "react";
import type { Task } from "@fusion/core";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import "./styles.css";
import "./components/TaskDetailModal.css";
import "./components/FloatingWindow.css";
import { FloatingWindow } from "./components/FloatingWindow";
import { App } from "./App";
import { TaskDetailContent } from "./components/TaskDetailModal";
import { AppModals } from "./components/AppModals";
import { MainContent } from "./components/dashboard/MainContent";
import { ListView } from "./components/ListView";
import { useRightDockController } from "./components/useRightDockController";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { NewTaskModal } from "./components/NewTaskModal";
import { AgentListModal } from "./components/AgentListModal";
import { SetupWizardModal } from "./components/SetupWizardModal";
import { ConfirmDialogProvider } from "./hooks/useConfirm";

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "new-task";
const titleMode = params.get("titleMode") ?? "overflow";
const boardCardClickSurface = surface === "board-card-click-app";
if (params.has("reset")) localStorage.clear();

/*
FNXC:ModalTouchGeometry 2026-07-26-20:08:
Task Detail now uses FloatingWindow geometry in production. Seed its shared size-and-position payload
only for resize gestures that need headroom; density assertions continue to use the default geometry.
*/
const detailSize = params.get("detailSize");
if (detailSize) {
  const [width, height] = detailSize.split("x").map(Number);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    localStorage.setItem("floating-window:task-detail", JSON.stringify({ size: { width, height }, position: { x: 64, y: 64 } }));
  }
}

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { app: {} } },
  interpolation: { escapeValue: false },
});

/*
FNXC:ModalTouchGeometry 2026-07-27-09:15:
The FN-8607 evidence surfaces mount the migrated production modals, not lookalike harnesses.
The wizard deliberately uses its standalone default first step; `includeAgentStep={false}` would instead
render the parent onboarding flow's Step 3 of 5 project sub-flow and misrepresent the required capture.
Their minimal API payloads keep first render deterministic so the CDP assertions prove FloatingWindow
geometry before each committed screenshot is captured.
*/
window.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  const pathname = new URL(url, window.location.href).pathname;
  const payload = url.includes("/projects/across-nodes")
    ? [{ id: "fixture", name: "Fixture", path: "/fixture", status: "active" }]
    : url.includes("/tasks/board-workflows")
      ? { flagEnabled: true, defaultWorkflowId: "fixture-workflow", taskWorkflowIds: { [fixtureTask.id]: "fixture-workflow" }, workflows: [{ id: "fixture-workflow", name: "Fixture", columns: boardCardClickSurface ? [
        /*
        FNXC:BoardNavigation 2026-08-21-18:57:
        FN-115's production-App Chromium fixture needs measured horizontal overflow at desktop and
        tablet widths, so it supplies enough canonical workflow columns to exercise Board panning.
        */
        { id: "todo", name: "Todo", flags: {} },
        { id: "in-progress", name: "In progress", flags: {} },
        { id: "in-review", name: "In review", flags: {} },
        { id: "verify", name: "Verify", flags: {} },
        { id: "done", name: "Done", flags: {} },
      ] : [{ id: "todo", name: "Todo", flags: {} }, { id: "in-progress", name: "In progress", flags: {} }, { id: "in-review", name: "In review", flags: {} }] }] }
      : url.includes(`/tasks/${fixtureTask.id}/prompt`)
        ? { id: fixtureTask.id, prompt: "" }
        : pathname === `/api/tasks/${fixtureTask.id}`
          ? fixtureTask
          : pathname === "/api/tasks"
            ? [fixtureTask]
          /*
    FNXC:WorkspaceRepos 2026-08-23-23:58:
    New Task fetches the workspace repository set on open; without this entry the stub's `[]` default answered it and the modal stored a non-array, so every surface here rendered an empty page.
    */
    : url.includes("/git/workspace-repos")
      ? { repos: [] }
    : url.includes("/insights")
            ? { insights: [], count: 0 }
            : url.includes("/evals")
              ? { results: [] }
              : url.includes("/missions")
                ? []
                : url.includes("/goals")
                  ? { goals: [] }
        : url.includes("/models")
          ? { models: [], favoriteProviders: [], favoriteModels: [] }
          : url.includes("/settings") ? { taskPopupsBoardListOnly: false, openMobileTasksInPopup: params.get("openMobileTasksInPopup") === "true" }
            : url.includes("/agents") || url.includes("/nodes") ? []
              : [];
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};

const fixtureTitle = titleMode === "fit"
  ? "Fitting browser title"
  : titleMode === "threshold"
    ? "A threshold title whose real host width crosses the two line clamp"
    : titleMode === "description" ? undefined : titleMode === "id" ? "" : "A browser measured task title that crosses the two line clamp threshold without changing the operator selected expanded state ".repeat(3);
const fixtureDescription = titleMode === "description" ? "A browser measured description fallback that crosses the two line clamp threshold without changing the operator selected expanded state ".repeat(3) : titleMode === "id" ? "" : "Fixture description";
const fixtureTask = {
  id: titleMode === "id" ? "FN-8806" : "FN-TITLE-FLICKER",
  title: fixtureTitle,
  description: fixtureDescription,
  column: "todo",
  status: "pending",
  prompt: "",
  steps: [],
  attachments: [],
  dependencies: [],
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
} as unknown as Task;
const fixtureColumnFlagsByTaskId = new Map([[fixtureTask.id, { hold: true }]]);

/*
FNXC:TaskDetailTitle 2026-08-05-18:48:
The App pop-out browser route hydrates the same project and task caches used after a discarded
session, so its board card exists on App's first render. This removes timing retries from the
fixture while App still revalidates the stable mocked API data through its production hooks.
*/
if (surface === "task-detail-title-app-floating" || surface === "board-card-click-app") {
  const savedAt = Date.now();
  localStorage.setItem("kb-dashboard-projects-cache", JSON.stringify({ savedAt, data: [{ id: "fixture", name: "Fixture", path: "/fixture", status: "active" }] }));
  localStorage.setItem("kb-dashboard-current-project-cache", JSON.stringify({ savedAt, data: "fixture" }));
  localStorage.setItem("kb-dashboard-tasks-cache:fixture", JSON.stringify({ savedAt, data: [fixtureTask] }));
}

const detailProps = {
  task: fixtureTask,
  initialTab: "definition" as const,
  onDeleteTask: async () => fixtureTask,
  onMergeTask: async () => ({ success: true } as never),
  onOpenDetail: () => undefined,
  addToast: () => undefined,
};

/*
FNXC:TaskDetailTitle 2026-08-05-17:54:
The Chromium fixture renders the production TaskDetailModal and embedded TaskDetailContent paths,
not a title lookalike, so browser geometry can expose control-driven clamp feedback that jsdom does
not calculate. The adapters keep API data inert while preserving the real heading, observer, and
accessible control contract.
*/
const noop = () => undefined;
const asyncTask = async () => fixtureTask;
const asyncMerge = async () => ({ success: true } as never);

/*
FNXC:TaskDetailTitle 2026-08-05-19:01:
The browser regression must enter each production owner rather than wrapping TaskDetailContent in
fixture-only geometry. These minimal adapters provide inert dependencies but retain AppModals,
MainContent, ListView, the right-dock controller, and the task FloatingWindow render paths.
*/
function TaskDetailTitleModalHarness() {
  const modalManager = {
    detailTask: fixtureTask,
    detailTaskOrigin: "board",
    closeDetailTask: noop,
    updateDetailTask: noop,
    openNewTaskWithDescription: noop,
    openWorkflowEditor: noop,
  };
  return <div data-testid="title-host-modal"><NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop }}><AppModals projectId="fixture" tasks={[fixtureTask]} projects={[]} currentProject={null} addToast={noop} toasts={[]} removeToast={noop} modalManager={modalManager as never} projectActions={{} as never} taskHandlers={{} as never} taskOperations={{ moveTask: asyncTask, deleteTask: asyncTask, mergeTask: asyncMerge, retryTask: asyncTask, pauseTask: asyncTask, unpauseTask: asyncTask, resetTask: asyncTask, duplicateTask: asyncTask }} deepLink={{ handleDetailClose: noop }} settings={{ prAuthAvailable: false, autoMerge: true, openTasksInRightSidebar: false, openMobileTasksInPopup: false, taskPopupsBoardListOnly: true, showCostBadgeOnCards: false, taskDetailChatFirst: false, chatMessageLayout: "bubbles", themeMode: "system", colorTheme: "default", dashboardFontScalePct: 100, shadcnCustomColors: {}, resolvedThemeMode: "light", setThemeMode: noop, setColorTheme: noop, setDashboardFontScalePct: noop, setShadcnCustomColors: noop, setQuickChatButtonModeImmediate: noop, setChatMessageLayoutImmediate: noop, setOpenTasksInRightSidebarImmediate: noop, setOpenMobileTasksInPopupImmediate: noop, setTaskPopupsBoardListOnlyImmediate: noop, setShowCostBadgeOnCardsImmediate: noop, setTaskDetailChatFirstImmediate: noop, setMobileNavPrimaryItemsImmediate: noop }} /></NavigationHistoryProvider></div>;
}

function TaskDetailTitleMainPanelHarness() {
  return <div data-testid="title-host-main-panel" className="fn-8806-constrained-title-host"><MainContent {...{ taskView: "task-detail", mainPanelDetailTask: fixtureTask, tasks: [fixtureTask], currentProject: null, addToast: noop, moveTask: asyncTask, deleteTask: asyncTask, mergeTask: asyncMerge, retryTask: asyncTask, pauseTask: asyncTask, unpauseTask: asyncTask, resetTask: asyncTask, duplicateTask: asyncTask, closeTaskDetailMainPanel: noop, setMainPanelDetailTask: noop, openTaskDetailInMainPanel: noop, popOutTaskDetail: noop, modalManager: { openNewTaskWithDescription: noop }, globalPaused: false, prAuthAvailable: false, autoMerge: true, taskDetailChatFirst: false } as unknown as React.ComponentProps<typeof MainContent>} /></div>;
}

function TaskDetailTitleListHarness() {
  localStorage.setItem("kb:fixture:kb-dashboard-list-selected-task", fixtureTask.id);
  return <div data-testid="title-host-list"><ListView {...{ tasks: [fixtureTask], projectId: "fixture", onMoveTask: asyncTask, onDeleteTask: asyncTask, onMergeTask: asyncMerge, addToast: noop, onOpenDetail: noop, onNewTask: noop, onQuickCreate: noop, availableModels: [], autoMerge: true, columnFlagsByTaskId: fixtureColumnFlagsByTaskId } as unknown as React.ComponentProps<typeof ListView>} /></div>;
}

function TaskDetailTitleDockHarness() {
  localStorage.setItem("fusion:right-dock-open", "true");
  localStorage.setItem("fusion:right-dock-view", "tasks");
  const dock = useRightDockController({ active: true, projectId: "fixture", tasks: [fixtureTask], addToast: noop, settingsLoaded: true, researchReadinessVersion: 0, workflowSteps: [], subscribePluginEvents: () => noop, openDetailTask: noop, openTaskPopup: noop, openMobileTasksInPopup: false, openFileInBrowser: noop, onDeleteTask: asyncTask, onMergeTask: asyncMerge, openSettings: noop, onSendSelectionToTask: noop, onCreateTaskFromInsight: noop, onNavigateToMission: noop, onTaskCreated: noop, prAuthAvailable: false, autoMerge: true, taskDetailChatFirst: false, visibilityOptions: {}, footerVisible: false, columnFlagsByTaskId: fixtureColumnFlagsByTaskId });
  React.useEffect(() => { dock.openTaskInDock(fixtureTask); }, []);
  return <div data-testid="title-host-dock" className="fn-8806-constrained-title-host">{dock.dock}</div>;
}

function TaskDetailTitleFloatingHarness() {
  return <div data-testid="title-host-floating"><FloatingWindow windowKey="fn-8806-task-floating" title={fixtureTask.id} onClose={noop} hideHeader dragHandleSelector=".task-detail-content--embedded > .modal-header" className="floating-window--task-detail" defaultSize={{ width: 560, height: 480 }} minSize={{ width: 320, height: 240 }} layer="task-detail"><TaskDetailContent {...detailProps} embedded onRequestClose={noop} /></FloatingWindow></div>;
}

/*
FNXC:TaskDetailTitle 2026-08-05-18:34:
The floating-title browser route renders App itself, then opens the task through its board-detail
Pop out control. This retains App's live-row selection, origin-view identity, visibility gate, and
usePoppedOutTasks persistence instead of treating a hand-composed FloatingWindow as host coverage.
*/
function TaskDetailTitleAppFloatingHarness() {
  return <App />;
}

function TaskDetailTitleEmbeddedHarness() {
  return <div data-testid="title-host-embedded" className="fn-8806-constrained-title-host" style={{ width: "24rem", height: "36rem" }}><TaskDetailContent {...detailProps} embedded /></div>;
}

function TaskDetailResizeHarness() {
  const { t } = useTranslation("app");
  return <FloatingWindow
    windowKey="task-detail-fixture"
    title={t("fixture.taskDetail", "Task detail")}
    onClose={() => undefined}
    hideHeader
    dragHandleSelector=".task-detail-content--embedded > .modal-header"
    className="floating-window--task-detail"
    defaultSize={{ width: 560, height: 480 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="floating-window:task-detail"
    suspendGeometryPersistenceOnMobile
    layer="task-detail"
    testId="task-detail-modal-overlay"
  >
    <div className="task-detail-content task-detail-content--embedded">
      <div className="modal-header">{t("fixture.taskDetail", "Task detail")}</div>
      <div className="modal-body">{t("fixture.taskDetailBody", "Task detail body")}</div>
    </div>
  </FloatingWindow>;
}

function FloatingWindowHarness() {
  const { t } = useTranslation("app");
  return <FloatingWindow
    windowKey="fn-8605-floating"
    title={t("fixture.floatingTaskDetail", "Floating task detail")}
    onClose={() => undefined}
    className="floating-window--task-detail"
    defaultSize={{ width: 560, height: 480 }}
    defaultPosition={{ x: 80, y: 80 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="fusion:fn-8605-floating"
    suspendGeometryPersistenceOnMobile
  >
    <div>{t("fixture.floatingTaskDetailBody", "Floating task detail body")}</div>
  </FloatingWindow>;
}

function HeaderlessFloatingWindowHarness() {
  const { t } = useTranslation("app");
  const [actionCount, setActionCount] = useState(0);
  return <FloatingWindow
    windowKey="fn-8605-headerless-floating"
    title="Headerless floating task detail"
    onClose={() => undefined}
    hideHeader
    dragHandleSelector=".fn-8605-delegated-drag-handle"
    className="floating-window--task-detail"
    defaultSize={{ width: 560, height: 480 }}
    defaultPosition={{ x: 80, y: 80 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="fusion:fn-8605-headerless-floating"
    suspendGeometryPersistenceOnMobile
  >
    <div className="fn-8605-delegated-drag-handle">{t("fixture.headerlessTaskDetail", "Headerless task detail")}
      <button type="button" data-testid="fn-8605-header-action" onClick={() => setActionCount((count) => count + 1)}>{t("fixture.headerAction", "Header action")}</button>
      <output data-testid="fn-8605-header-action-count">{actionCount}</output>
    </div>
    <div>{t("fixture.floatingTaskDetailBody", "Floating task detail body")}</div>
  </FloatingWindow>;
}

/*
FNXC:ModalTouchGeometry 2026-07-26-15:30:
This intentionally classless headerless window is the browser control for every non-task
FloatingWindow consumer. It must retain the shared 44px layout target while task detail moves
its target out of flow.
*/
function GenericFloatingWindowHarness() {
  const { t } = useTranslation("app");
  return <FloatingWindow
    windowKey="fn-8612-generic-floating"
    title={t("fixture.genericFloatingWindow", "Generic floating window")}
    onClose={() => undefined}
    hideHeader
    dragHandleSelector=".fn-8612-generic-drag-handle"
    defaultSize={{ width: 560, height: 480 }}
    defaultPosition={{ x: 80, y: 80 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="fusion:fn-8612-generic-floating"
    suspendGeometryPersistenceOnMobile
  >
    <div className="fn-8612-generic-drag-handle">{t("fixture.genericWindowHeader", "Generic window header")}</div>
    <div>{t("fixture.genericFloatingWindowBody", "Generic floating window body")}</div>
  </FloatingWindow>;
}

function Fixture() {
  return <I18nextProvider i18n={i18n}>
    <ConfirmDialogProvider skipConfirmations>
      {surface === "task-detail-title-app-floating" || surface === "board-card-click-app" ? <TaskDetailTitleAppFloatingHarness /> : surface === "agent-list-modal" ? <AgentListModal isOpen onClose={() => undefined} addToast={() => undefined} /> : surface === "setup-wizard-modal" ? <SetupWizardModal onProjectRegistered={() => undefined} onClose={() => undefined} /> : surface === "floating-window" ? <FloatingWindowHarness /> : surface === "floating-window-headerless" ? <HeaderlessFloatingWindowHarness /> : surface === "floating-window-generic" ? <GenericFloatingWindowHarness /> : surface === "task-detail-title-modal" ? <TaskDetailTitleModalHarness /> : surface === "task-detail-title-main-panel" ? <TaskDetailTitleMainPanelHarness /> : surface === "task-detail-title-list" ? <TaskDetailTitleListHarness /> : surface === "task-detail-title-dock" ? <TaskDetailTitleDockHarness /> : surface === "task-detail-title-floating" ? <TaskDetailTitleFloatingHarness /> : surface === "task-detail-title-embedded" ? <TaskDetailTitleEmbeddedHarness /> : surface === "task-detail" ? <TaskDetailResizeHarness /> : <NewTaskModal
        isOpen
        tasks={[]}
        onClose={() => undefined}
        onCreateTask={async () => ({ id: "FN-E2E" }) as never}
        addToast={() => undefined}
      />}
    </ConfirmDialogProvider>
  </I18nextProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
