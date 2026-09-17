import React, { useState } from "react";
import type { Task } from "@fusion/core";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import "./styles.css";
import "./components/TaskDetailModal.css";
import "./components/FloatingWindow.css";
import "./native-ui.css";
import "./ui-style-tokens.css";
import { FloatingWindow } from "./components/FloatingWindow";
import { App } from "./App";
import { TaskDetailContent, TaskDetailModal } from "./components/TaskDetailModal";
import { AppTaskPopoutWindow } from "./components/TaskDetailHostBoundaries";
import { AppModals } from "./components/AppModals";
import { MainContent } from "./components/dashboard/MainContent";
import { ListView } from "./components/ListView";
import { useRightDockController } from "./components/useRightDockController";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { NewTaskModal } from "./components/NewTaskModal";
import { AgentListModal } from "./components/AgentListModal";
import { SetupWizardModal } from "./components/SetupWizardModal";
import { SettingsModal } from "./components/SettingsModal";
import { ConfirmDialogProvider } from "./hooks/useConfirm";

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "new-task";
const titleMode = params.get("titleMode") ?? "overflow";
const boardCardClickSurface = surface === "board-card-click-app";
const preserveDesktopHostDuringViewportProbe = params.get("preserveDesktopHost") === "true";
if (preserveDesktopHostDuringViewportProbe) {
  /*
  FNXC:TaskDetailTitleRemoval 2026-09-13-11:59:
  List split, right dock, and pop-out are desktop-only navigation owners, but their mounted shared header still needs real narrow-viewport CSS coverage. Freeze only JavaScript host admission after desktop mount so CDP can resize the actual viewport without routing away; CSS media and container queries continue to use the resized viewport.
  */
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 1200 });
  const nativeMatchMedia = window.matchMedia.bind(window);
  const stableMediaMatches = new Map<string, boolean>();
  window.matchMedia = (query: string): MediaQueryList => {
    if (!stableMediaMatches.has(query)) stableMediaMatches.set(query, nativeMatchMedia(query).matches);
    const initial = nativeMatchMedia(query);
    return {
      matches: stableMediaMatches.get(query) ?? false,
      media: initial.media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    };
  };
  /*
  FNXC:TaskDetailChatGeometry 2026-09-13-13:09:
  Desktop-only production hosts also observe their containers before routing responsively. Freeze fixture observer admission after its first real delivery so narrow CSS can be measured on the mounted List split/right-dock/pop-out owner; this observer is host scaffolding and is independent of the removed title clamp.
  */
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class StableHostResizeObserver implements ResizeObserver {
    private readonly observer: ResizeObserver;
    constructor(callback: ResizeObserverCallback) {
      let delivered = false;
      this.observer = new NativeResizeObserver((entries, observer) => {
        if (delivered) return;
        delivered = true;
        callback(entries, observer);
      });
    }
    observe(target: Element, options?: ResizeObserverOptions) { this.observer.observe(target, options); }
    unobserve(target: Element) { this.observer.unobserve(target); }
    disconnect() { this.observer.disconnect(); }
  };
}
/*
FNXC:TaskDetailChatGeometry 2026-09-11-18:16:
The browser fixture drives the real Task Detail hosts through both chat surfaces and deterministic empty, loading, populated, and streaming-shaped responses. This lets Chromium prove that the transcript owns overflow while the in-flow composer remains at the usable body edge with or without a contextual footer.
*/
const chatKind = params.get("chatKind") === "planner" ? "planner" : "activity";
const chatState = params.get("chatState") ?? "empty";
const showContextualFooter = params.get("footer") === "true";
const structuredTaskDetail = params.get("structured") === "true";
/*
FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
FN-442 replaced the boolean Chat-first opt-in with a three-value project choice, and made the floating task window the
unconditional board/list route. The fixture states its intent directly: drive the planner Chat surface by selecting the
`chat` landing tab, and the Activity surface with the historical `activity` default.
*/
const taskDetailDefaultTab = chatKind === "planner" ? ("chat" as const) : ("activity" as const);
const taskDetailInitialTab = chatKind === "planner" ? ("planner-chat" as const) : ("chat" as const);
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
  if (chatState === "loading" && (pathname.endsWith(`/tasks/${fixtureTask.id}/logs`) || (pathname === "/api/chat/sessions" && url.includes("lookup=resume")))) {
    return await new Promise<Response>(() => undefined);
  }
  const activityEntries = chatState === "empty" || chatKind !== "activity" ? [] : Array.from({ length: chatState === "populated" ? 120 : 8 }, (_, index) => ({
    type: "text",
    text: `${chatState === "streaming" ? "Streaming output" : "Recorded output"} ${index + 1} ${"fills the production transcript. ".repeat(6)}`,
    timestamp: new Date(Date.UTC(2026, 8, 11, 12, index)).toISOString(),
    role: "executor",
  }));
  const plannerSession = {
    id: "chat-fn-349",
    agentId: `task-planner:${fixtureTask.id}`,
    title: "Task Detail geometry",
    status: "active",
    projectId: "fixture",
    modelProvider: "mock",
    modelId: "scripted",
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:01:00.000Z",
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
  };
  const plannerMessages = chatState === "empty" || chatKind !== "planner" ? [] : Array.from({ length: chatState === "populated" ? 120 : 4 }, (_, index) => ({
    id: chatState === "streaming" && index === 3 ? "streaming-assistant" : `planner-message-${index}`,
    sessionId: plannerSession.id,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${chatState === "streaming" ? "Streaming plan" : "Persisted plan"} ${index + 1} ${"fills the production transcript. ".repeat(6)}`,
    thinkingOutput: null,
    metadata: null,
    createdAt: new Date(Date.UTC(2026, 8, 11, 13, index)).toISOString(),
  }));
  const payload = pathname.endsWith(`/tasks/${fixtureTask.id}/logs`)
    ? activityEntries
    : pathname === "/api/chat/sessions" && url.includes("lookup=resume")
      ? { sessions: chatState === "empty" ? [] : [plannerSession] }
      : pathname === `/api/chat/sessions/${plannerSession.id}/messages`
        ? { messages: plannerMessages }
        : pathname === `/api/chat/sessions/${plannerSession.id}`
          ? { session: plannerSession }
        : url.includes("/projects/across-nodes")
    ? [{ id: "fixture", name: "Fixture", path: "/fixture", status: "active" }]
    : url.includes("/tasks/board-workflows")
      ? { flagEnabled: true, defaultWorkflowId: "fixture-workflow", taskWorkflowIds: { [fixtureTask.id]: "fixture-workflow" }, workflows: [{ id: "fixture-workflow", name: "Fixture", columns: boardCardClickSurface ? [
        /*
        FNXC:BoardNavigation 2026-08-21-18:57:
        FN-115's production-App Chromium fixture needs measured horizontal overflow at desktop and
        tablet widths, so it supplies enough canonical workflow columns to exercise Board panning.
        */
        { id: "todo", name: "Todo", flags: { hold: true } },
        { id: "in-progress", name: "In progress", flags: {} },
        { id: "in-review", name: "In review", flags: {} },
        { id: "verify", name: "Verify", flags: {} },
        { id: "done", name: "Done", flags: {} },
      ] : [{ id: "todo", name: "Todo", flags: { hold: true } }, { id: "in-progress", name: "In progress", flags: {} }, { id: "in-review", name: "In review", flags: {} }] }] }
      : pathname === "/api/tasks/page"
        ? { tasks: [fixtureTask], total: 1, hasMore: false, nextCursor: null }
        : pathname === "/api/tasks/done"
          ? { tasks: [], total: 0, hasMore: false, nextCursor: null }
      : url.includes(`/tasks/${fixtureTask.id}/prompt`)
        ? { id: fixtureTask.id, prompt: fixtureTask.prompt }
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
          : pathname === "/api/settings/scopes" ? { global: { experimentalFeatures: {} }, project: {} }
          : pathname === "/api/settings/global" ? { experimentalFeatures: {} }
          : url.includes("/settings") ? { taskDetailDefaultTab, experimentalFeatures: {} }
            : url.includes("/agents") || url.includes("/nodes") ? []
              : [];
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};

const fixtureTitle = titleMode === "fit"
  ? "Fitting browser title"
  : titleMode === "description" ? undefined : titleMode === "id" ? "" : "A long editable browser task title that must remain absent from shared header chrome ".repeat(3);
const fixtureDescription = titleMode === "description" ? "A browser description without a title remains primary Definition content. ".repeat(3) : titleMode === "id" ? "" : "Fixture description";
/*
FNXC:TaskDetailStructure 2026-09-12-23:26:
La fixture Chromium des vrais hôtes contient une description, un PROMPT.md, des étapes de statuts variés et un Feed avec résultat et agent réel afin que les captures Définition, plan et Activity prouvent la hiérarchie livrée plutôt qu’une coquille vide.
*/
/*
FNXC:TaskDetailDefinition 2026-09-14-20:45:
FN-391: the `fit` matrix row is the one that produces the operator-facing screenshots, so it must
carry REAL Definition content — steps for the collapsed progress disclosure and a plan containing
`What This Delivers` for the product-outcome section. Capturing an empty shell would prove the
section order and nothing about what those sections actually render.
*/
const hasDefinitionContent = structuredTaskDetail || titleMode === "fit";
const fixturePlan = "# Task: FN-TITLE-FLICKER - Delivery plan\n\n## What This Delivers\n\n- Operators see progress, description, and the expected outcome in one glance.\n- The complete plan stays one click away behind Read plan.\n\n## Mission\n\nKeep the task detail structure readable in every host.\n\n## Verification\n\n- Inspect Definition\n- Open the full plan\n- Review Activity\n";
const fixtureTask = {
  id: titleMode === "id" ? "FN-8806" : "FN-TITLE-FLICKER",
  title: fixtureTitle,
  description: fixtureDescription,
  column: showContextualFooter ? "in-review" : "todo",
  status: "pending",
  prompt: hasDefinitionContent ? fixturePlan : "",
  steps: hasDefinitionContent ? [
    { id: 1, name: "Inspect every task detail host", status: "done" },
    { id: 2, name: "Open the full planning document", status: "in-progress" },
    { id: 3, name: "Verify responsive activity logs", status: "pending" },
  ] : [],
  log: structuredTaskDetail ? [
    { timestamp: "2026-09-12T22:30:00.000Z", action: "Started visual verification", outcome: "Desktop definition rendered", runContext: { agentId: "agent-executor" } },
    { timestamp: "2026-09-12T22:35:00.000Z", action: "Opened the complete plan" },
    { timestamp: "2026-09-12T22:40:00.000Z", action: "Checked Activity hierarchy", outcome: "Feed remains readable on mobile" },
  ] : [],
  attachments: [],
  dependencies: [],
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
} as unknown as Task;
const fixtureColumnFlagsByTaskId = new Map([[fixtureTask.id, { hold: true }]]);

/*
FNXC:TaskDetailTitleRemoval 2026-09-13-11:59:
The App pop-out browser route hydrates the same project and task caches used after a discarded session, so its board card exists on first render and the matrix can open the real title-free pop-out path without timing retries.
*/
if (surface === "task-detail-title-app-floating" || surface === "board-card-click-app") {
  const savedAt = Date.now();
  localStorage.setItem("kb-dashboard-projects-cache", JSON.stringify({ savedAt, data: [{ id: "fixture", name: "Fixture", path: "/fixture", status: "active" }] }));
  localStorage.setItem("kb-dashboard-current-project-cache", JSON.stringify({ savedAt, data: "fixture" }));
  localStorage.setItem("kb-dashboard-tasks-cache:fixture", JSON.stringify({ savedAt, data: [fixtureTask] }));
}

/*
FNXC:TaskDetailChatGeometry 2026-09-17-00:48:
The real-host browser matrix supplies its selected chat kind through the fixture query. Pass that
landing-tab contract to every TaskDetailModal owner so Chromium measures Activity and Planner
content rather than silently retaining the Definition default after the Task Detail rebuild.
*/
const detailProps = {
  task: fixtureTask,
  initialTab: taskDetailInitialTab,
  onDeleteTask: async () => fixtureTask,
  onMergeTask: async () => ({ success: true } as never),
  onOpenDetail: () => undefined,
  addToast: () => undefined,
};

/*
FNXC:TaskDetailTitleRemoval 2026-09-13-11:59:
The Chromium fixture renders production TaskDetailModal and embedded TaskDetailContent paths, not lookalikes, so browser checks can reject any surviving title heading or click target while preserving real Definition and edit behavior.
*/
const noop = () => undefined;
const asyncTask = async () => fixtureTask;
const asyncMerge = async () => ({ success: true } as never);

/*
FNXC:TaskDetailTitleRemoval 2026-09-13-11:59:
The browser regression enters each production owner rather than wrapping TaskDetailContent in fixture-only geometry. These minimal adapters retain AppModals, MainContent, ListView, the right-dock controller, the mobile drawer, and task FloatingWindow paths.
*/
function TaskDetailTitleModalHarness() {
  const modalManager = {
    detailTask: fixtureTask,
    detailTaskOrigin: "board",
    closeDetailTask: noop,
    updateDetailTask: noop,
    openNewTaskWithDescription: noop,
    setWorkflowViewParams: noop,
    clearWorkflowViewParams: noop,
  };
  return <div data-testid="title-host-modal"><NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop, promoteNav: noop }}><AppModals projectId="fixture" tasks={[fixtureTask]} projects={[]} currentProject={null} addToast={noop} toasts={[]} removeToast={noop} modalManager={modalManager as never} projectActions={{} as never} taskHandlers={{} as never} taskOperations={{ moveTask: asyncTask, deleteTask: asyncTask, mergeTask: asyncMerge, retryTask: asyncTask, pauseTask: asyncTask, unpauseTask: asyncTask, resetTask: asyncTask, duplicateTask: asyncTask }} deepLink={{ handleDetailClose: noop }} settings={{ prAuthAvailable: false, autoMerge: true, showCostBadgeOnCards: false, taskDetailDefaultTab, chatMessageLayout: "bubbles", navigationPlacement: "footer" as const, rightSidebarEnabled: false, themeMode: "system", colorTheme: "default", dashboardFontScalePct: 100, shadcnCustomColors: {}, resolvedThemeMode: "light", setThemeMode: noop, setColorTheme: noop, uiStyle: "classic" as const, setUiStyle: noop, setDashboardFontScalePct: noop, setShadcnCustomColors: noop, setChatMessageLayoutImmediate: noop, setNavigationPlacementImmediate: noop, setRightSidebarEnabledImmediate: noop, setShowCostBadgeOnCardsImmediate: noop, setTaskDetailDefaultTabImmediate: noop, setMobileNavPrimaryItemsImmediate: noop, setMobileNavMenuSwipeGestureImmediate: noop }} /></NavigationHistoryProvider></div>;
}

function TaskDetailTitleMainPanelHarness() {
  return <div data-testid="title-host-main-panel" className="fn-8806-constrained-title-host" style={{ height: "100vh", minHeight: 0, overflow: "hidden" }}><MainContent {...{ taskView: "task-detail", mainPanelDetailTask: fixtureTask, tasks: [fixtureTask], currentProject: null, addToast: noop, moveTask: asyncTask, deleteTask: asyncTask, mergeTask: asyncMerge, retryTask: asyncTask, pauseTask: asyncTask, unpauseTask: asyncTask, resetTask: asyncTask, duplicateTask: asyncTask, closeTaskDetailMainPanel: noop, setMainPanelDetailTask: noop, openTaskDetailInMainPanel: noop, popOutTaskDetail: noop, modalManager: { openNewTaskWithDescription: noop }, globalPaused: false, prAuthAvailable: false, autoMerge: true, taskDetailDefaultTab } as unknown as React.ComponentProps<typeof MainContent>} /></div>;
}

/*
FNXC:TaskDetailHeaderActions 2026-09-17-01:27:
The browser fixture must follow the embedded main-panel action through App's canonical pop-out window boundary. Keeping the source Task Detail host and resulting FloatingWindow together catches a missing or misrouted overflow entry without recreating either surface as a lookalike.
*/
function TaskDetailPopOutOverflowHarness() {
  const [mainPanelTask, setMainPanelTask] = useState<Task | null>(fixtureTask);
  const [poppedOutTask, setPoppedOutTask] = useState<Task | null>(null);
  return <div data-testid="title-host-pop-out-overflow" className="fn-8806-constrained-title-host" style={{ height: "100vh", minHeight: 0, overflow: "hidden" }}>
    <MainContent {...{ taskView: "task-detail", mainPanelDetailTask: mainPanelTask, tasks: [fixtureTask], currentProject: null, addToast: noop, moveTask: asyncTask, deleteTask: asyncTask, mergeTask: asyncMerge, retryTask: asyncTask, pauseTask: asyncTask, unpauseTask: asyncTask, resetTask: asyncTask, duplicateTask: asyncTask, closeTaskDetailMainPanel: () => setMainPanelTask(null), setMainPanelDetailTask: setMainPanelTask, openTaskDetailInMainPanel: noop, popOutTaskDetail: setPoppedOutTask, modalManager: { openNewTaskWithDescription: noop }, globalPaused: false, prAuthAvailable: false, autoMerge: true, taskDetailDefaultTab } as unknown as React.ComponentProps<typeof MainContent>} />
    {poppedOutTask && <AppTaskPopoutWindow {...detailProps} task={poppedOutTask} onRemoveWindow={() => setPoppedOutTask(null)} />}
  </div>;
}

/*
FNXC:TaskDetailPresentation 2026-09-17-00:21:
FN-442 routes List selection through its real pop-out callback. The fixture retains that production path and renders the resulting TaskDetailModal instead of preserving the retired embedded detail pane.
*/
function TaskDetailTitleListHarness() {
  const [poppedOutTask, setPoppedOutTask] = useState<Task | null>(null);
  return <div data-testid="title-host-list" style={{ height: "100vh", minHeight: 0, overflow: "hidden" }}>
    <ListView {...{ tasks: [fixtureTask], projectId: "fixture", onMoveTask: asyncTask, onDeleteTask: asyncTask, onMergeTask: asyncMerge, addToast: noop, onOpenDetail: noop, onPopOut: setPoppedOutTask, onNewTask: noop, onQuickCreate: noop, availableModels: [], autoMerge: true, taskDetailDefaultTab, columnFlagsByTaskId: fixtureColumnFlagsByTaskId } as unknown as React.ComponentProps<typeof ListView>} />
    {poppedOutTask && <TaskDetailModal {...detailProps} task={poppedOutTask} onClose={() => setPoppedOutTask(null)} />}
  </div>;
}

function TaskDetailTitleDockHarness() {
  localStorage.setItem("fusion:right-dock-open", "true");
  localStorage.setItem("fusion:right-dock-view", "tasks");
  const dock = useRightDockController({ active: true, projectId: "fixture", tasks: [fixtureTask], addToast: noop, settingsLoaded: true, researchReadinessVersion: 0, workflowSteps: [], subscribePluginEvents: () => noop, openDetailTask: noop, openFileInBrowser: noop, onDeleteTask: asyncTask, onMergeTask: asyncMerge, openSettings: noop, onSendSelectionToTask: noop, onCreateTaskFromInsight: noop, onNavigateToMission: noop, onTaskCreated: noop, prAuthAvailable: false, autoMerge: true, taskDetailDefaultTab, visibilityOptions: {}, footerVisible: false, columnFlagsByTaskId: fixtureColumnFlagsByTaskId });
  React.useEffect(() => { dock.openTaskInDock(fixtureTask); }, []);
  return <div data-testid="title-host-dock" className="fn-8806-constrained-title-host" style={{ height: "100vh", minHeight: 0, overflow: "hidden" }}>{dock.dock}</div>;
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

/*
FNXC:TaskDetailTitleRemoval 2026-09-15-00:20:
The browser matrix mounts Task Detail's real mobile-drawer branch directly so its title-free shared header and stable dialog name are measured alongside the five desktop-owned production hosts.
*/
function TaskDetailTitleMobileDrawerHarness() {
  return <TaskDetailModal {...detailProps} mobileDrawer onClose={noop} />;
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
    suspendGeometryPersistenceOnMobile
  >
    <div className="fn-8612-generic-drag-handle">{t("fixture.genericWindowHeader", "Generic window header")}</div>
    <div>{t("fixture.genericFloatingWindowBody", "Generic floating window body")}</div>
  </FloatingWindow>;
}

function Fixture() {
  const appOwnsShell = surface === "task-detail-title-app-floating" || surface === "board-card-click-app";
  const content = appOwnsShell ? <TaskDetailTitleAppFloatingHarness /> : surface === "task-detail-pop-out-overflow" ? <TaskDetailPopOutOverflowHarness /> : surface === "settings-official" ? <SettingsModal onClose={() => undefined} addToast={() => undefined} initialSection="experimental" /> : surface === "agent-list-modal" ? <AgentListModal isOpen onClose={() => undefined} addToast={() => undefined} /> : surface === "setup-wizard-modal" ? <SetupWizardModal onProjectRegistered={() => undefined} onClose={() => undefined} /> : surface === "floating-window" ? <FloatingWindowHarness /> : surface === "floating-window-headerless" ? <HeaderlessFloatingWindowHarness /> : surface === "floating-window-generic" ? <GenericFloatingWindowHarness /> : surface === "task-detail-title-modal" ? <TaskDetailTitleModalHarness /> : surface === "task-detail-title-main-panel" ? <TaskDetailTitleMainPanelHarness /> : surface === "task-detail-title-list" ? <TaskDetailTitleListHarness /> : surface === "task-detail-title-dock" ? <TaskDetailTitleDockHarness /> : surface === "task-detail-title-native-drawer" ? <TaskDetailTitleMobileDrawerHarness /> : surface === "task-detail-title-embedded" ? <TaskDetailTitleEmbeddedHarness /> : surface === "task-detail" ? <TaskDetailResizeHarness /> : <NewTaskModal
    isOpen
    tasks={[]}
    onClose={() => undefined}
    onCreateTask={async () => ({ id: "FN-E2E" }) as never}
    addToast={() => undefined}
  />;
  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  There is no presentation perimeter to enable any more, so every surface mounts through the same
  provider stack. The former `?alpha=true` fixture parameter is gone with the provider it toggled.
  */
  return <I18nextProvider i18n={i18n}>
    <ConfirmDialogProvider skipConfirmations>{content}</ConfirmDialogProvider>
  </I18nextProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
