import "../../alpha-ui.css";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  makeTask,
  mockConfirm,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { AlphaProvider } from "../../context/AlphaContext";
import { approvePlan, fetchBoardWorkflows, fetchTaskDetail, fetchWorkflowResults, refineTask, rejectPlan } from "../../api";
import { readAppFile } from "../../test/cssFixture";
import { TaskDetailContent } from "../TaskDetailModal";
import {
  AppModalTaskDetailHost,
  AppTaskPopoutWindows,
  useAppMainPanelTaskDetailState,
  useAppPoppedOutTaskState,
} from "../TaskDetailHostBoundaries";
import {
  AppMainPanelTaskDetailComposition,
  type AppMainPanelTaskDetailMainContentProps,
} from "../dashboard/MainContent";
import { ListView } from "../ListView";
import { useRightDockController, type RightDockControllerInput } from "../useRightDockController";
import type { NavEntry } from "../../hooks/useNavigationHistory";
import type { TaskView } from "../../hooks/useViewState";
import { scopedKey } from "../../utils/projectStorage";

setupTaskDetailModalHooks();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const sharedProps = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function DetailFixture({ enabled, title = "Alpha task" }: { enabled: boolean; title?: string }) {
  return (
    <AlphaProvider enabled={enabled}>
      <TaskDetailContent {...sharedProps} embedded task={makeTask({ title })} />
    </AlphaProvider>
  );
}

const hostTask = makeTask({ id: "FN-HOST-STATE", title: "State-owned task detail" });
const asyncHostTask = async () => hostTask;

function MainContentStateHost() {
  const [taskView, setTaskView] = useState<TaskView>("board");
  const [navEntries, setNavEntries] = useState<NavEntry[]>([]);
  const [restoreCount, setRestoreCount] = useState(0);
  const detail = useAppMainPanelTaskDetailState({
    taskView,
    changeTaskView: setTaskView,
    captureBoardScroll: noop,
    requestBoardScrollRestore: () => setRestoreCount((count) => count + 1),
    pushNav: (entry) => setNavEntries((entries) => [...entries, entry]),
    removeNav: (callback) => setNavEntries((entries) => entries.filter((entry) => (entry.type === "view" ? entry.revert : entry.close) !== callback)),
  });
  const props = {
    taskView,
    mainPanelDetailTask: detail.task,
    setMainPanelDetailTask: detail.setTask,
    tasks: [hostTask],
    filteredBoardTasks: [hostTask],
    currentProject: { id: "host-project" },
    modalManager: {},
    globalPaused: false,
    t: (_key: string, fallback?: string) => fallback ?? _key,
    popOutTaskDetail: noop,
    moveTask: asyncHostTask,
    deleteTask: asyncHostTask,
    mergeTask: async () => ({ merged: false }),
    retryTask: asyncHostTask,
    pauseTask: asyncHostTask,
    unpauseTask: asyncHostTask,
    resetTask: asyncHostTask,
    duplicateTask: asyncHostTask,
    addToast: noop,
  } as unknown as AppMainPanelTaskDetailMainContentProps;

  return <>
    <button type="button" onClick={() => detail.open(hostTask, "plan")}>Open main detail</button>
    <output data-testid="main-route">{taskView}</output>
    <output data-testid="main-snapshot">{detail.task?.id ?? "empty"}</output>
    <output data-testid="main-tab">{detail.initialTab ?? "implicit"}</output>
    <output data-testid="main-nav-count">{navEntries.length}</output>
    <output data-testid="main-restore-count">{restoreCount}</output>
    <AppMainPanelTaskDetailComposition
      state={detail}
      mainContentProps={props}
    />
  </>;
}

function ListViewStateHost() {
  return (
    <ListView
      tasks={[hostTask]}
      projectId="host-project"
      onMoveTask={asyncHostTask}
      onRetryTask={asyncHostTask}
      onDeleteTask={asyncHostTask}
      onMergeTask={async () => ({ merged: false })}
      onResetTask={asyncHostTask}
      onDuplicateTask={asyncHostTask}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
      globalPaused={false}
    />
  );
}

function RightDockStateHost() {
  const input = {
    active: true,
    projectId: "host-project",
    addToast: noop,
    settingsLoaded: true,
    researchReadinessVersion: 0,
    tasks: [hostTask],
    columnFlagsByTaskId: new Map(),
    workflowSteps: [],
    subscribePluginEvents: () => noop,
    openDetailTask: noopOpenDetail,
    openTaskPopup: noopOpenDetail,
    openMobileTasksInPopup: false,
    openFileInBrowser: noop,
    onMoveTask: asyncHostTask,
    onDeleteTask: asyncHostTask,
    onMergeTask: async () => ({ merged: false }),
    openSettings: noop,
    footerVisible: true,
    visibilityOptions: { experimentalFeatures: {} },
  } as unknown as RightDockControllerInput;
  const controller = useRightDockController(input);
  return <><button type="button" onClick={() => controller.openTaskInDock(hostTask)}>Open dock task</button>{controller.dock}</>;
}

function AppPopoutStateHost() {
  const [navEntries, setNavEntries] = useState<NavEntry[]>([]);
  const popouts = useAppPoppedOutTaskState({
    taskView: "board",
    isMobile: true,
    pushNav: (entry) => setNavEntries((entries) => [...entries, entry]),
    removeNav: (callback) => setNavEntries((entries) => entries.filter((entry) => (entry.type === "view" ? entry.revert : entry.close) !== callback)),
  });
  return (
    <>
      <button type="button" onClick={() => popouts.open(hostTask, "plan")}>Open pop-out task</button>
      <output data-testid="popout-count">{popouts.entries.length}</output>
      <output data-testid="popout-nav-count">{navEntries.length}</output>
      <AppTaskPopoutWindows
        entries={popouts.entries}
        liveTasks={[hostTask]}
        isVisible={() => true}
        onCloseTask={popouts.close}
        persistGeometryKey="floating-window:task-detail"
        windowProps={sharedProps}
      />
    </>
  );
}

describe("homemade Alpha Task Detail", () => {
  it("keeps the stable Task Detail DOM outside Alpha and owns one surface inside Alpha", () => {
    const view = render(<DetailFixture enabled={false} />);
    expect(document.querySelector("[data-alpha-surface='true']")).toBeNull();
    expect(document.querySelector("[data-task-detail-surface='true']")).not.toHaveAttribute("data-alpha-ui");

    view.rerender(<DetailFixture enabled />);
    expect(document.querySelectorAll(".task-detail-alpha-boundary[data-alpha-surface='true']")).toHaveLength(1);
    expect(document.querySelectorAll("[data-task-detail-surface='true']")).toHaveLength(1);
    expect(document.querySelector("[data-task-detail-surface='true']")).toHaveAttribute("data-alpha-ui", "surface");
  });

  it("retains selected tabs, edit text, focus, and callbacks across live rerenders", async () => {
    const user = userEvent.setup();
    const onPopOut = vi.fn();
    const view = render(
      <AlphaProvider enabled>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ title: "Initial title", column: "todo" })} onPopOut={onPopOut} />
      </AlphaProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    const title = screen.getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Modern task");
    expect(title).toHaveFocus();

    view.rerender(
      <AlphaProvider enabled>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ title: "Initial title", column: "todo", status: "planning", log: [{ timestamp: "2026-01-01T00:00:01Z", action: "Live update" }] })} onPopOut={onPopOut} />
      </AlphaProvider>,
    );

    expect(screen.getByLabelText("Title")).toHaveValue("Modern task");
    expect(screen.getByLabelText("Title")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Pop out" }));
    expect(onPopOut).toHaveBeenCalledTimes(1);
  });

  it("keeps every production host on the canonical shared Task Detail implementation", () => {
    const hostContracts = [
      ["components/AppModals.tsx", "<AppModalTaskDetailHost"],
      ["components/dashboard/MainContent.tsx", "<MainPanelTaskDetailHost"],
      ["components/ListView.tsx", "<ListSplitTaskDetailHost"],
      ["components/useRightDockController.tsx", "<RightDockTaskDetailHost"],
      ["App.tsx", "<AppTaskPopoutWindows"],
    ] as const;
    for (const [file, contract] of hostContracts) {
      expect(readAppFile(file), file).toContain(contract);
    }
    const canonical = readAppFile("components/TaskDetailModal.tsx");
    expect(canonical).toContain("<AlphaMobileDrawer");
    expect(canonical.match(/<AlphaBoundary preserveDisabledDom/g)).toHaveLength(1);
    expect(canonical.match(/data-task-detail-surface=/g)).toHaveLength(1);
  });

  it.each(["modal", "drawer"] as const)("runs the AppModals %s dismissal cleanup through its production host", async (presentation) => {
    const removeNavigation = vi.fn();
    const closeDetail = vi.fn();
    const cleanupDeepLink = vi.fn();
    const closed = vi.fn();
    render(
      <AlphaProvider enabled>
        <AppModalTaskDetailHost
          {...sharedProps}
          task={makeTask({ id: `FN-HOST-${presentation}` })}
          alphaMobileDrawer={presentation === "drawer"}
          onRemoveNavigation={removeNavigation}
          onCloseDetail={closeDetail}
          onCleanupDeepLink={cleanupDeepLink}
          onClosed={closed}
        />
      </AlphaProvider>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(removeNavigation).toHaveBeenCalledTimes(1);
    expect(closeDetail).toHaveBeenCalledTimes(1);
    expect(cleanupDeepLink).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-task-detail-surface='true']")).toHaveLength(1);
  });

  it("runs MainContent Back through App's production snapshot and navigation owner", async () => {
    const user = userEvent.setup();
    render(<AlphaProvider enabled><MainContentStateHost /></AlphaProvider>);

    await user.click(screen.getByRole("button", { name: "Open main detail" }));
    expect(screen.getByTestId("main-route")).toHaveTextContent("task-detail");
    expect(screen.getByTestId("main-snapshot")).toHaveTextContent(hostTask.id);
    expect(screen.getByTestId("main-tab")).toHaveTextContent("plan");
    expect(screen.getByTestId("main-nav-count")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "Back to board" }));
    expect(screen.getByTestId("main-route")).toHaveTextContent("board");
    expect(screen.getByTestId("main-snapshot")).toHaveTextContent("empty");
    expect(screen.getByTestId("main-tab")).toHaveTextContent("chat");
    expect(screen.getByTestId("main-nav-count")).toHaveTextContent("0");
    expect(screen.getByTestId("main-restore-count")).toHaveTextContent("1");
    expect(document.querySelector("[data-task-detail-surface='true']")).toBeNull();
  });

  it("clears ListView's real persisted split selection after Close", async () => {
    const user = userEvent.setup();
    const previousWidth = window.innerWidth;
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: noop,
        removeListener: noop,
        addEventListener: noop,
        removeEventListener: noop,
        dispatchEvent: () => false,
      }),
    });
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: "triage", name: "Planning", flags: { intake: true } },
          { id: "todo", name: "Todo", flags: { hold: true } },
          { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
          { id: "in-review", name: "In review", flags: { review: true } },
          { id: "done", name: "Done", flags: { complete: true } },
        ],
      }],
      taskWorkflowIds: { [hostTask.id]: "builtin:coding" },
    });
    localStorage.setItem(scopedKey("kb-dashboard-list-selected-task", "host-project"), hostTask.id);
    render(<AlphaProvider enabled><ListViewStateHost /></AlphaProvider>);

    const splitDetail = await screen.findByTestId("list-split-detail-content");
    expect(within(splitDetail).getAllByText(hostTask.id).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Select a task to view details")).toBeInTheDocument();
    expect(localStorage.getItem(scopedKey("kb-dashboard-list-selected-task", "host-project"))).toBeNull();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  });

  it("removes the detail snapshot owned by useRightDockController after Close", async () => {
    const user = userEvent.setup();
    render(<AlphaProvider enabled><RightDockStateHost /></AlphaProvider>);

    await user.click(screen.getByRole("button", { name: "Open dock task" }));
    expect(await screen.findByText(hostTask.id)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector("[data-task-detail-surface='true']")).toBeNull();
  });

  it("runs FloatingWindow Close through App's production pop-out and navigation owner", async () => {
    const user = userEvent.setup();
    render(<AlphaProvider enabled><AppPopoutStateHost /></AlphaProvider>);

    await user.click(screen.getByRole("button", { name: "Open pop-out task" }));
    expect(screen.getByTestId("popout-count")).toHaveTextContent("1");
    expect(screen.getByTestId("popout-nav-count")).toHaveTextContent("1");
    expect(document.querySelectorAll(".floating-window--task-detail")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("popout-count")).toHaveTextContent("0");
    expect(screen.getByTestId("popout-nav-count")).toHaveTextContent("0");
    expect(document.querySelector(".floating-window--task-detail")).toBeNull();
    expect(document.querySelector("[data-task-detail-surface='true']")).toBeNull();
  });

  it.each([false, true])("preserves Delete, Duplicate, and Bypass callbacks with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    vi.mocked(fetchTaskDetail).mockReturnValue(new Promise(() => {}) as never);
    const onDeleteTask = vi.fn(async () => makeTask());
    const onDuplicateTask = vi.fn(async () => makeTask({ id: "FN-COPY" }));
    const onBypassReview = vi.fn(async () => makeTask({ id: "FN-ACTIONS", column: "in-review" }));
    const onTaskUpdated = vi.fn();
    const onRequestClose = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Operator accepted the risk");
    const failedReview = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge" as const,
      reviewKind: "code" as const,
      status: "failed" as const,
    };
    vi.mocked(fetchWorkflowResults).mockResolvedValue([failedReview] as never);
    const renderActionHost = (withFailedReview = false) => render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-ACTIONS", column: "in-review", workflowStepResults: withFailedReview ? [failedReview] : [] })}
          columnFlagsByTaskId={new Map([["FN-ACTIONS", { humanReview: true }]])}
          onDeleteTask={onDeleteTask}
          onDuplicateTask={onDuplicateTask}
          onBypassReview={onBypassReview}
          onTaskUpdated={onTaskUpdated}
          onRequestClose={onRequestClose}
        />
      </AlphaProvider>,
    );
    const chooseAction = async (name: string) => {
      await user.click(screen.getByRole("button", { name: "Actions" }));
      await user.click(within(await screen.findByRole("menu", { name: "Task actions" })).getByRole("menuitem", { name }));
    };

    let host = renderActionHost();
    await chooseAction("Duplicate");
    await waitFor(() => expect(onDuplicateTask).toHaveBeenCalledWith("FN-ACTIONS", undefined));
    host.unmount();

    host = renderActionHost(true);
    await chooseAction("Bypass failed review");
    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-ACTIONS", "Operator accepted the risk"));
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-ACTIONS" }));
    host.unmount();

    renderActionHost();
    await chooseAction("Delete");
    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith("FN-ACTIONS", { allowResurrection: false }));
    expect(onRequestClose).toHaveBeenCalledTimes(2);
    expect(mockConfirm).toHaveBeenCalled();
    vi.mocked(fetchWorkflowResults).mockResolvedValue([]);
    prompt.mockRestore();
  });

  it.each([false, true])("preserves lifecycle action guards and callbacks with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn(async () => makeTask());
    const onRevertTask = vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as never);
    const onReviseTask = vi.fn();
    const view = render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ column: "done", branch: "fusion/fn-099", completedAt: "2026-01-02T00:00:00Z", mergeDetails: { commitSha: "abc123" } as never })}
          onDeleteTask={onDeleteTask}
          onRevertTask={onRevertTask}
          onReviseTask={onReviseTask}
        />
      </AlphaProvider>,
    );

    const revert = screen.getByRole("button", { name: "Revert this task's changes" });
    if (enabled) expect(revert).toHaveAttribute("data-alpha-ui", "button");
    else expect(revert).not.toHaveAttribute("data-alpha-ui");
    await user.click(revert);
    expect(onRevertTask).toHaveBeenCalledTimes(1);

    view.rerender(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ column: "done", sourceMetadata: { revertedAt: "2026-01-02T00:00:00Z" } as never })}
          onDeleteTask={onDeleteTask}
          onRevertTask={onRevertTask}
          onReviseTask={onReviseTask}
        />
      </AlphaProvider>,
    );
    expect(screen.queryByRole("button", { name: "Revert this task's changes" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Revise" }));
    expect(onReviseTask).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves WIP pause and retry actions with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    const onPauseTask = vi.fn(async () => makeTask({ column: "in-progress", paused: true }));
    const onRetryTask = vi.fn(async () => makeTask({ column: "in-progress" }));
    const onTaskUpdated = vi.fn();

    render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-WIP", column: "in-progress", assignedAgent: "executor" })}
          onPauseTask={onPauseTask}
          onRetryTask={onRetryTask}
          onTaskUpdated={onTaskUpdated}
        />
      </AlphaProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    let actions = await screen.findByRole("menu", { name: "Task actions" });
    await user.click(within(actions).getByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(onPauseTask).toHaveBeenCalledWith("FN-WIP"));
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));

    await user.click(screen.getByRole("button", { name: "Actions" }));
    actions = await screen.findByRole("menu", { name: "Task actions" });
    await user.click(within(actions).getByRole("menuitem", { name: "Retry" }));
    await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-WIP"));
  });

  it.each([false, true])("keeps approval guards and review action disabled state with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    vi.mocked(approvePlan).mockReset();
    vi.mocked(rejectPlan).mockReset();
    vi.mocked(approvePlan).mockResolvedValue({} as never);
    vi.mocked(rejectPlan).mockResolvedValue({} as never);

    const approvalView = render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-APPROVAL", column: "todo", status: "awaiting-approval", prompt: "# Reviewed plan" })}
        />
      </AlphaProvider>,
    );
    const approve = screen.getByTestId("detail-plan-approval-footer-approve");
    const reject = screen.getByTestId("detail-plan-approval-footer-reject");
    expect(approve).toBeEnabled();
    expect(reject).toBeEnabled();
    await user.click(approve);
    await user.click(reject);
    await waitFor(() => {
      expect(approvePlan).toHaveBeenCalledWith("FN-APPROVAL", undefined);
      expect(rejectPlan).toHaveBeenCalledWith("FN-APPROVAL", undefined);
    });
    approvalView.unmount();

    const onMergeTask = vi.fn(async () => ({ merged: true }) as never);
    const reviewView = render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ id: "FN-REVIEW", column: "in-review" })} onMergeTask={onMergeTask} />
      </AlphaProvider>,
    );
    const merge = screen.getByRole("button", { name: "Merge & Close" });
    expect(merge).toBeEnabled();
    await user.click(merge);
    await waitFor(() => expect(onMergeTask).toHaveBeenCalledWith("FN-REVIEW"));

    reviewView.rerender(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ id: "FN-REVIEW", column: "in-review", status: "merging-pr" })} onMergeTask={onMergeTask} />
      </AlphaProvider>,
    );
    expect(screen.getByRole("button", { name: "Merging PR…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Merge & Close" })).toBeNull();
  });

  it.each([false, true])("disables every Approve and Reject control while a plan request is pending with Alpha=%s", async (enabled) => {
    const approval = deferred<Record<string, never>>();
    vi.mocked(approvePlan).mockReset().mockReturnValue(approval.promise as never);
    vi.mocked(rejectPlan).mockReset().mockResolvedValue({} as never);

    render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-PENDING-APPROVAL", column: "todo", status: "awaiting-approval", prompt: "# Pending plan" })}
        />
      </AlphaProvider>,
    );

    fireEvent.click(screen.getByTestId("detail-plan-approval-footer-approve"));
    await waitFor(() => expect(approvePlan).toHaveBeenCalledTimes(1));
    for (const id of [
      "detail-plan-approval-banner-approve",
      "detail-plan-approval-banner-reject",
      "detail-plan-approval-footer-approve",
      "detail-plan-approval-footer-reject",
    ]) {
      expect(screen.getByTestId(id), id).toBeDisabled();
    }
    fireEvent.click(screen.getByTestId("detail-plan-approval-banner-reject"));
    expect(rejectPlan).not.toHaveBeenCalled();

    approval.resolve({});
    await waitFor(() => expect(screen.getByTestId("detail-plan-approval-footer-approve")).toBeEnabled());
  });

  it("uses adaptive controls for edit fields and keeps a single accessible Refine dialog", async () => {
    const user = userEvent.setup();
    const editView = render(
      <AlphaProvider enabled>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ column: "todo" })} />
      </AlphaProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Edit task" }));
    expect(screen.getByLabelText("Title")).toHaveAttribute("data-alpha-ui", "input");
    const alphaSelects = document.querySelectorAll<HTMLSelectElement>("select[data-alpha-ui='select']");
    expect(alphaSelects.length).toBeGreaterThan(0);
    expect(alphaSelects[0]).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    editView.unmount();

    // Review owns Refine while the editable hold task above proves TaskForm's adaptive branch.
    render(
      <AlphaProvider enabled>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ id: "FN-REVIEW", column: "in-review" })} />
      </AlphaProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const actions = await screen.findByRole("menu", { name: "Task actions" });
    await user.click(within(actions).getByRole("menuitem", { name: "Refine" }));
    expect(await screen.findAllByRole("dialog", { name: "Refine" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Refine" })).toBeNull();
  });

  it.each([false, true])("submits one Refine dialog and publishes its child with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    const onRefinementCreated = vi.fn();
    const onRequestClose = vi.fn();
    const child = makeTask({ id: "FN-CHILD", column: "todo" });
    vi.mocked(refineTask).mockReset();
    vi.mocked(refineTask).mockResolvedValue(child);

    render(
      <AlphaProvider enabled={enabled}>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-REVIEW", column: "in-review" })}
          onRefinementCreated={onRefinementCreated}
          onRequestClose={onRequestClose}
        />
      </AlphaProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(within(await screen.findByRole("menu", { name: "Task actions" })).getByRole("menuitem", { name: "Refine" }));
    const dialog = await screen.findByRole("dialog", { name: "Refine" });
    await user.type(within(dialog).getByPlaceholderText("Enter your feedback here..."), "Clarify the delivery evidence");
    await user.click(within(dialog).getByRole("button", { name: "Create Refinement Task" }));

    await waitFor(() => expect(refineTask).toHaveBeenCalledWith("FN-REVIEW", "Clarify the delivery evidence", undefined));
    expect(onRefinementCreated).toHaveBeenCalledWith(child);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("dialog", { name: "Refine" })).toHaveLength(1);
  });

  it("keeps optional metadata empty, deduplicates dependencies, and preserves the selected tab through hydration", async () => {
    const user = userEvent.setup();
    const view = render(
      <AlphaProvider enabled>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ title: "A very long mobile-first title ".repeat(12) })} />
      </AlphaProvider>,
    );
    expect(document.querySelector(".detail-meta-grid:empty")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Plan" }));

    view.rerender(
      <AlphaProvider enabled>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({
            title: "A very long mobile-first title ".repeat(12),
            description: "Long content ".repeat(80),
            dependencies: ["FN-100", "FN-100"],
            log: [{ timestamp: "2026-01-01T00:00:00Z", action: "Hydrated" }],
          })}
        />
      </AlphaProvider>,
    );
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");

    view.unmount();
    render(
      <AlphaProvider enabled>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ dependencies: ["FN-100", "FN-100"] })} />
      </AlphaProvider>,
    );
    await user.click(screen.getByRole("button", { name: /^Dependencies/ }));
    expect(screen.getAllByRole("link", { name: /FN-100/ })).toHaveLength(1);
  });

  it("renders the Activity menu as one palette-inheriting homemade Alpha portal", async () => {
    const user = userEvent.setup();
    document.documentElement.dataset.theme = "dark";
    render(<DetailFixture enabled />);

    await user.click(screen.getByRole("button", { name: "Activity" }));
    const menu = await screen.findByRole("menu", { name: "Activity views" });
    expect(menu.closest("[data-alpha-portal='true']")).not.toBeNull();
    expect(screen.getAllByRole("menuitem", { name: "Feed" })).toHaveLength(1);
    await user.click(screen.getByRole("menuitem", { name: "Feed" }));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Activity views" })).toBeNull());
    document.documentElement.removeAttribute("data-theme");
  });
});
