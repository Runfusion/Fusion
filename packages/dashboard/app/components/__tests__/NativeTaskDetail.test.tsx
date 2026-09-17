import "../../native-ui.css";
import "../../ui-style-tokens.css";
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
    <>
      <TaskDetailContent {...sharedProps} embedded task={makeTask({ title })} />
    </>
  );
}

const hostTask = makeTask({ id: "FN-HOST-STATE", title: "State-owned task detail" });
const asyncHostTask = async () => hostTask;

function MainContentStateHost({ mobileAlpha = false }: { mobileAlpha?: boolean }) {
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
    viewMode: "project",
    isMobile: mobileAlpha,
    experimentalFeatures: {},
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
        windowProps={sharedProps}
      />
    </>
  );
}

describe("native Task Detail", () => {
  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  The perimeter wrapper element is gone, so the single-root guard now targets Task Detail's own surface
  marker, which stays unique across every host and rerender.
  */
  it("keeps exactly one Task Detail surface root across rerenders", () => {
    const view = render(<DetailFixture enabled={false} />);
    expect(document.querySelectorAll("[data-task-detail-surface='true']")).toHaveLength(1);
    expect(document.querySelector("[data-task-detail-surface='true']")).toHaveAttribute("data-ui", "surface");

    view.rerender(<DetailFixture enabled />);
    expect(document.querySelectorAll("[data-task-detail-surface='true']")).toHaveLength(1);
    expect(document.querySelector("[data-task-detail-surface='true']")).toHaveAttribute("data-ui", "surface");
  });

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442: the embedded (main-panel / right-dock) host renders the same tab bar as the overlay, so the three-value project
  choice must move the landing tab and the head order here too — the tab strip is built once in TaskDetailModal and shared
  by every host.
  */
  it.each([
    ["activity" as const, "Activity", ["Activity", "Chat", "Plan"]],
    ["chat" as const, "Chat", ["Chat", "Activity", "Plan"]],
    ["definition" as const, "Plan", ["Plan", "Activity", "Chat"]],
  ])("lands the embedded host on %s and leads its tab bar with it", (setting, landingTabLabel, headOrder) => {
    const view = render(
      <TaskDetailContent {...sharedProps} embedded taskDetailDefaultTab={setting} task={makeTask({ id: "FN-DEFAULT-TAB", column: "in-progress" as never })} />,
    );

    const labels = Array.from(document.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab")).map((tab) => (tab.textContent ?? "").trim());
    expect(labels.slice(0, 3)).toEqual(headOrder);
    expect(screen.getByRole("button", { name: landingTabLabel })).toHaveClass("detail-tab-active");
    view.unmount();
  });

  it("retains selected tabs, edit text, focus, and callbacks across live rerenders", async () => {
    const user = userEvent.setup();
    const onPopOut = vi.fn();
    const view = render(
      <>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ title: "Initial title", column: "ideas" as any })} onPopOut={onPopOut} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByTestId("task-detail-header-action-edit"));
    /*
    FNXC:TaskDescriptionEditing 2026-09-14-19:30:
    FN-391 removed the title field; the description is the text field whose draft and focus must
    survive a live rerender. The card is rendered in manual intake so the description is editable.
    */
    const description = screen.getByLabelText("Description");
    await user.clear(description);
    await user.type(description, "Modern description");
    expect(description).toHaveFocus();

    view.rerender(
      <>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ title: "Initial title", column: "ideas" as any, status: "planning", log: [{ timestamp: "2026-01-01T00:00:01Z", action: "Live update" }] })} onPopOut={onPopOut} />
      </>,
    );

    expect(screen.getByLabelText("Description")).toHaveValue("Modern description");
    expect(screen.getByLabelText("Description")).toHaveFocus();
    expect(screen.queryByLabelText("Title")).toBeNull();
    /*
    FNXC:TaskDetailHeaderActions 2026-09-16-18:07 (FN-470):
    Pop out is the last entry of the single header overflow, and edit mode keeps only the close control in the
    header, so the draft is dismissed before the overflow is reachable again.
    */
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByTestId("task-detail-pop-out"));
    expect(onPopOut).toHaveBeenCalledTimes(1);
  });

  it("keeps every production host on the canonical shared Task Detail implementation", () => {
    // FN-382: List no longer hosts task detail; a row delegates to whichever layer its host owns.
    const hostContracts = [
      ["components/AppModals.tsx", "<AppModalTaskDetailHost"],
      ["components/dashboard/MainContent.tsx", "<MainPanelTaskDetailHost"],
      ["components/useRightDockController.tsx", "<RightDockTaskDetailHost"],
      ["App.tsx", "<AppTaskPopoutWindows"],
    ] as const;
    for (const [file, contract] of hostContracts) {
      expect(readAppFile(file), file).toContain(contract);
    }
    const canonical = readAppFile("components/TaskDetailModal.tsx");
    expect(canonical).toContain("<MobileDrawer");
    /*
    FNXC:NativeUiPresentation 2026-09-15-00:20:
    The perimeter wrapper is gone, so the single-root guard it carried now applies to Task Detail's own
    surface marker, which remains the one canonical detail root across all six hosts.
    */
    expect(canonical.match(/data-task-detail-surface=/g)).toHaveLength(1);
  });

  it.each(["modal", "drawer"] as const)("runs the AppModals %s dismissal cleanup through its production host", async (presentation) => {
    const removeNavigation = vi.fn();
    const closeDetail = vi.fn();
    const cleanupDeepLink = vi.fn();
    const closed = vi.fn();
    render(
      <>
        <AppModalTaskDetailHost
          {...sharedProps}
          task={makeTask({ id: `FN-HOST-${presentation}` })}
          mobileDrawer={presentation === "drawer"}
          onRemoveNavigation={removeNavigation}
          onCloseDetail={closeDetail}
          onCleanupDeepLink={cleanupDeepLink}
          onClosed={closed}
        />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(removeNavigation).toHaveBeenCalledTimes(1);
    expect(closeDetail).toHaveBeenCalledTimes(1);
    expect(cleanupDeepLink).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-task-detail-surface='true']")).toHaveLength(1);
  });

  it("conserve la sortie canonique du panneau desktop et restaure son état", async () => {
    const user = userEvent.setup();
    render(<><MainContentStateHost /></>);

    await user.click(screen.getByRole("button", { name: "Open main detail" }));
    expect(screen.getByTestId("main-route")).toHaveTextContent("task-detail");
    expect(screen.getByTestId("main-snapshot")).toHaveTextContent(hostTask.id);
    expect(screen.getByTestId("main-tab")).toHaveTextContent("plan");
    expect(screen.getByTestId("main-nav-count")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("main-route")).toHaveTextContent("board");
    expect(screen.getByTestId("main-snapshot")).toHaveTextContent("empty");
    expect(screen.getByTestId("main-tab")).toHaveTextContent("chat");
    expect(screen.getByTestId("main-nav-count")).toHaveTextContent("0");
    expect(screen.getByTestId("main-restore-count")).toHaveTextContent("1");
    expect(document.querySelector("[data-task-detail-surface='true']")).toBeNull();
  });

  it("retire Back to board du drawer mobile et restaure Board par sa fermeture unique", async () => {
    const user = userEvent.setup();
    render(<><MainContentStateHost mobileAlpha /></>);

    await user.click(screen.getByRole("button", { name: "Open main detail" }));
    const drawer = screen.getByRole("dialog", { name: "Task detail" });
    expect(drawer.querySelector("[data-task-detail-surface='true']")).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Back to board" })).toBeNull();
    expect(within(drawer).queryByText("Back to board")).toBeNull();
    expect(drawer.querySelector(".task-detail-header-back-btn")).toBeNull();
    expect(within(drawer).getAllByRole("button", { name: "Close" })).toHaveLength(1);

    await user.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("main-route")).toHaveTextContent("board");
    expect(screen.getByTestId("main-snapshot")).toHaveTextContent("empty");
    expect(screen.getByTestId("main-tab")).toHaveTextContent("chat");
    expect(screen.getByTestId("main-nav-count")).toHaveTextContent("0");
    expect(screen.getByTestId("main-restore-count")).toHaveTextContent("1");
    expect(screen.queryByRole("dialog", { name: "Task detail" })).toBeNull();
  });

  /* FN-382: List no longer owns a split selection to clear — a row delegates to the host's own detail layer. */

  it("removes the detail snapshot owned by useRightDockController after Close", async () => {
    const user = userEvent.setup();
    render(<><RightDockStateHost /></>);

    await user.click(screen.getByRole("button", { name: "Open dock task" }));
    expect(await screen.findByText(hostTask.id)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector("[data-task-detail-surface='true']")).toBeNull();
  });

  it("runs FloatingWindow Close through App's production pop-out and navigation owner", async () => {
    const user = userEvent.setup();
    render(<><AppPopoutStateHost /></>);

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
      <>
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
      </>,
    );
    // FNXC:TaskDetailHeaderActions 2026-09-16-18:07 (FN-470): every action, Duplicate and Delete included, is reached through the overflow.
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
    /* FN-416 case (c): a reverted task offers Restore revert in place of Revert and the removed Revise action. */
    const onRestoreRevertTask = vi.fn(async () => ({ mode: "git", clean: true, restoreCommitSha: "restore-sha" }) as never);
    const view = render(
      <>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ column: "done", branch: "fusion/fn-099", completedAt: "2026-01-02T00:00:00Z", mergeDetails: { commitSha: "abc123" } as never })}
          onDeleteTask={onDeleteTask}
          onRevertTask={onRevertTask}
          onRestoreRevertTask={onRestoreRevertTask}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    const revert = within(await screen.findByRole("menu", { name: "Task actions" })).getByRole("menuitem", { name: "Revert" });
    await user.click(revert);
    expect(onRevertTask).toHaveBeenCalledTimes(1);

    view.rerender(
      <>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ column: "done", sourceMetadata: { revertedAt: "2026-01-02T00:00:00Z" } as never })}
          onDeleteTask={onDeleteTask}
          onRevertTask={onRevertTask}
          onRestoreRevertTask={onRestoreRevertTask}
        />
      </>,
    );
    expect(screen.queryByRole("button", { name: "Revert this task's changes" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const revertedMenu = await screen.findByRole("menu", { name: "Task actions" });
    expect(within(revertedMenu).queryByRole("menuitem", { name: "Revise" })).toBeNull();
    expect(within(revertedMenu).queryByRole("menuitem", { name: "Revert" })).toBeNull();
    await user.click(within(revertedMenu).getByRole("menuitem", { name: "Restore revert" }));
    expect(onRestoreRevertTask).toHaveBeenCalledWith("FN-099", { mode: "auto" });
  });

  it.each([false, true])("preserves WIP pause and retry actions with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    const onPauseTask = vi.fn(async () => makeTask({ column: "in-progress", paused: true }));
    const onRetryTask = vi.fn(async () => makeTask({ column: "in-progress" }));
    const onTaskUpdated = vi.fn();

    render(
      <>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-WIP", column: "in-progress", assignedAgent: "executor" })}
          onPauseTask={onPauseTask}
          onRetryTask={onRetryTask}
          onTaskUpdated={onTaskUpdated}
        />
      </>,
    );

    // FNXC:TaskDetailHeaderActions 2026-09-16-18:07 (FN-470): Pause and Retry are reached through the single header overflow.
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByTestId("task-detail-header-action-pause"));
    await waitFor(() => expect(onPauseTask).toHaveBeenCalledWith("FN-WIP"));
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByTestId("task-detail-header-action-retry"));
    await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-WIP"));
  });

  it.each([false, true])("keeps approval guards and review action disabled state with Alpha=%s", async (enabled) => {
    const user = userEvent.setup();
    vi.mocked(approvePlan).mockReset();
    vi.mocked(rejectPlan).mockReset();
    vi.mocked(approvePlan).mockResolvedValue({} as never);
    vi.mocked(rejectPlan).mockResolvedValue({} as never);
    const approvalTask = makeTask({ id: "FN-APPROVAL", column: "todo", status: "awaiting-approval", prompt: "# Reviewed plan" });
    vi.mocked(fetchTaskDetail).mockResolvedValue(approvalTask);

    const approvalView = render(
      <>
        <TaskDetailContent
          {...sharedProps}
          embedded
          initialTab="definition"
          task={approvalTask}
        />
      </>,
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
      <>
        <TaskDetailContent {...sharedProps} embedded initialTab="review" task={makeTask({ id: "FN-REVIEW", column: "in-review" })} onMergeTask={onMergeTask} />
      </>,
    );
    const merge = screen.getByRole("button", { name: "Merge & Close" });
    expect(merge).toBeEnabled();
    await user.click(merge);
    await waitFor(() => expect(onMergeTask).toHaveBeenCalledWith("FN-REVIEW"));

    reviewView.rerender(
      <>
        <TaskDetailContent {...sharedProps} embedded initialTab="review" task={makeTask({ id: "FN-REVIEW", column: "in-review", status: "merging-pr" })} onMergeTask={onMergeTask} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Merging PR…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Merge & Close" })).toBeNull();
  });

  it.each([false, true])("disables every Approve and Reject control while a plan request is pending with Alpha=%s", async (enabled) => {
    const approval = deferred<Record<string, never>>();
    vi.mocked(approvePlan).mockReset().mockReturnValue(approval.promise as never);
    vi.mocked(rejectPlan).mockReset().mockResolvedValue({} as never);
    const approvalTask = makeTask({ id: "FN-PENDING-APPROVAL", column: "todo", status: "awaiting-approval", prompt: "# Pending plan" });
    vi.mocked(fetchTaskDetail).mockResolvedValue(approvalTask);

    render(
      <>
        <TaskDetailContent
          {...sharedProps}
          embedded
          initialTab="definition"
          task={approvalTask}
        />
      </>,
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
      <>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ column: "todo" })} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByTestId("task-detail-header-action-edit"));
    // FNXC:TaskDescriptionEditing 2026-09-14-19:30: FN-391 — the description textarea is the adaptive text control now that the title field is gone.
    expect(screen.getByLabelText("Description")).toHaveAttribute("data-ui", "textarea");
    const alphaSelects = document.querySelectorAll<HTMLSelectElement>("select[data-ui='select']");
    expect(alphaSelects.length).toBeGreaterThan(0);
    expect(alphaSelects[0]).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    editView.unmount();

    // Review owns Refine while the editable hold task above proves TaskForm's adaptive branch.
    render(
      <>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ id: "FN-REVIEW", column: "in-review" })} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const actions = await screen.findByRole("menu", { name: "Task actions" });
    await user.click(within(actions).getByRole("menuitem", { name: "Refine" }));
    expect(await screen.findAllByRole("dialog", { name: "Refine" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Refine" })).toBeNull();
  });

  /*
  FNXC:TaskDetailPresentation 2026-09-15-00:20:
  There is no perimeter to parameterise any more, so this runs once. It also records the current truth after
  Refine became a standalone dialog: submitting publishes the child and closes ONLY the refine dialog, while
  the task detail it was opened from stays open.
  */
  it("submits one Refine dialog, publishes its child and closes only that dialog", async () => {
    const user = userEvent.setup();
    const onRefinementCreated = vi.fn();
    const onRequestClose = vi.fn();
    const child = makeTask({ id: "FN-CHILD", column: "todo" });
    vi.mocked(refineTask).mockReset();
    vi.mocked(refineTask).mockResolvedValue(child);

    render(
      <>
        <TaskDetailContent
          {...sharedProps}
          embedded
          task={makeTask({ id: "FN-REVIEW", column: "in-review" })}
          onRefinementCreated={onRefinementCreated}
          onRequestClose={onRequestClose}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(within(await screen.findByRole("menu", { name: "Task actions" })).getByRole("menuitem", { name: "Refine" }));
    const dialog = await screen.findByRole("dialog", { name: "Refine" });
    await user.type(within(dialog).getByPlaceholderText("Enter your feedback here..."), "Clarify the delivery evidence");
    await user.click(within(dialog).getByRole("button", { name: "Create Refinement Task" }));

    await waitFor(() => expect(refineTask).toHaveBeenCalledWith("FN-REVIEW", "Clarify the delivery evidence", undefined));
    expect(onRefinementCreated).toHaveBeenCalledWith(child);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Refine" })).toBeNull());
    // The detail host is not dismissed by a refinement; only the dialog closes.
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Actions" })).toBeInTheDocument();
  });

  it("keeps optional metadata empty, deduplicates dependencies, and preserves the selected tab through hydration", async () => {
    const user = userEvent.setup();
    const view = render(
      <>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ title: "A very long mobile-first title ".repeat(12) })} />
      </>,
    );
    expect(document.querySelector(".detail-meta-grid:empty")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Plan" }));

    view.rerender(
      <>
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
      </>,
    );
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");

    view.unmount();
    render(
      <>
        <TaskDetailContent {...sharedProps} embedded task={makeTask({ dependencies: ["FN-100", "FN-100"] })} />
      </>,
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
    expect(menu.closest("[data-ui-portal='true']")).not.toBeNull();
    expect(screen.getAllByRole("menuitem", { name: "Feed" })).toHaveLength(1);
    await user.click(screen.getByRole("menuitem", { name: "Feed" }));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Activity views" })).toBeNull());
    document.documentElement.removeAttribute("data-theme");
  });
});
