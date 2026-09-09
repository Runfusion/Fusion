/*
FNXC:TaskDetailFooterActions 2026-09-05-23:27:
FN-300 places oversight levels, the advisor toggle, and overseer controls in the shared footer Actions menu at every viewport. These tests keep the mobile and desktop contracts aligned: one menu, labeled state, unchanged mutation handlers, no inactive control shells, and Attach file as the first focused action.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PlannerOverseerRuntimeSnapshot } from "@fusion/core";
import {
  makeTask,
  makeUpdatedTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
  findTaskDetailActionByTestId,
  openTaskDetailActionsMenu,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const MOBILE_WIDTH = 375;
const DESKTOP_WIDTH = 1024;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

async function expectOversightHeadingState(state: "on" | "off") {
  const heading = await findTaskDetailActionByTestId("detail-actions-oversight-heading");
  await waitFor(() => expect(heading).toHaveTextContent(`Oversight: ${state}`));
  return heading;
}

const activeSnapshot: PlannerOverseerRuntimeSnapshot = {
  state: "watching",
  oversightLevel: "autonomous",
  watchedStage: "executor",
  signal: "progressing",
  attemptCount: 1,
  attemptLimit: 3,
  pendingConfirmation: false,
  observedAt: 1_700_000_000_000,
  reason: "Task is actively executing in-progress work",
  lastAction: "inject_guidance",
};

describe("TaskDetailModal oversight controls — mobile overflow menu", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    setViewportWidth(MOBILE_WIDTH);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
  });

  afterEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("labels the Oversight group on from the project advisor default while oversight is off", async () => {
    const api = await import("../../api");
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      sessionAdvisorEnabledByDefault: true,
    } as any);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "WF-8263-mobile-project-default",
      workflows: [{ id: "WF-8263-mobile-project-default", name: "Mobile project default workflow", columns: [] } as any],
      taskWorkflowIds: { "FN-8263-mobile-project-default": "WF-8263-mobile-project-default" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: {},
      effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: false },
      defaults: {},
    });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-8263-mobile-project-default", column: "todo", plannerOversightLevel: undefined, sessionAdvisorEnabled: undefined })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await expectOversightHeadingState("on");
    expect((await screen.findByTestId("detail-session-advisor-toggle"))).toHaveAttribute("aria-pressed", "true");
  });

  it("repaints the Oversight heading and advisor item after disabling a workflow-enabled advisor", async () => {
    const api = await import("../../api");
    let currentTask = makeTask({
      id: "FN-8247-mobile",
      column: "in-progress",
      plannerOversightLevel: "off",
      sessionAdvisorEnabled: undefined,
    });
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      sessionAdvisorEnabledByDefault: false,
    } as any);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "WF-advisor-mobile",
      workflows: [{ id: "WF-advisor-mobile", name: "Advisor workflow", columns: [] } as any],
      taskWorkflowIds: { [currentTask.id]: "WF-advisor-mobile" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: {},
      effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: true },
      defaults: {},
    });
    vi.mocked(api.updateTask).mockImplementation(async (_id, patch) => {
      currentTask = makeUpdatedTask(currentTask, patch);
      return currentTask as any;
    });

    let rerenderModal: (nextTask: typeof currentTask) => void;
    const renderModal = (nextTask: typeof currentTask) => (
      <TaskDetailModal
        task={nextTask}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)}
        addToast={noop}
      />
    );
    const rendered = render(renderModal(currentTask));
    rerenderModal = (nextTask) => rendered.rerender(renderModal(nextTask));

    await expectOversightHeadingState("on");
    const toggle = await screen.findByTestId("detail-session-advisor-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(currentTask.id, { sessionAdvisorEnabled: false }, undefined));
    await expectOversightHeadingState("off");
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("renders one footer Actions trigger with the labeled Oversight group", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-200", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    const menu = await openTaskDetailActionsMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await findTaskDetailActionByTestId("detail-actions-oversight-heading")).toHaveTextContent("Oversight: on");
    expect(menu.querySelectorAll('[data-testid="detail-actions-oversight-heading"]')).toHaveLength(1);
    expect(screen.getByTestId("detail-overseer-nudge")).toBeInTheDocument();
    expect(screen.getByTestId("detail-overseer-stop")).toBeInTheDocument();
    expect(screen.getByTestId("detail-overseer-explain")).toBeInTheDocument();
  });

  it("shows level choices without leftover control shells when oversight is off and the overseer is inactive", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-201", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // A task override keeps the Oversight group and level choices reachable, while
    // nudge/stop/explain remain absent for the ordinary off-and-inactive state.
    await openTaskDetailActionsMenu();

    await findTaskDetailActionByTestId("detail-oversight-level-__inherit__");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });

  it("omits the Oversight group while workflow policy is unresolved and no task override exists", async () => {
    const api = await import("../../api");
    // A workflow badge id forces the async workflow-oversight-effective-level
    // lookup path (see `workflowIdForOversight` in TaskDetailModal.tsx) instead
    // of the synchronous `!workflowIdForOversight` fast-resolve, so
    // `workflowOversightResolved` stays false until the fetch below settles.
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "WF-mobile-test",
      workflows: [{ id: "WF-mobile-test", name: "Mobile Test Workflow", columns: [] } as any],
      taskWorkflowIds: { "FN-212": "WF-mobile-test" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockImplementation(() => new Promise(() => {}));

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-212", column: "todo", plannerOversightLevel: undefined })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // Keep the footer menu open so this absence assertion proves the group is withheld,
    // rather than passing vacuously because all menu content is closed.
    await openTaskDetailActionsMenu();
    await waitFor(() => {
      expect(screen.queryByTestId("detail-actions-oversight-heading")).not.toBeInTheDocument();
    });
  });

  it("opening Actions exposes level choices and honors nudge/stop/explain enablement rules", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-202", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Actions" });
    const menu = await openTaskDetailActionsMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    expect(menu).toBeInTheDocument();

    expect(await findTaskDetailActionByTestId("detail-oversight-level-autonomous")).toHaveAttribute("aria-pressed", "true");

    const nudgeBtn = screen.getByTestId("detail-overseer-nudge");
    expect(nudgeBtn).not.toBeDisabled();
    const stopBtn = screen.getByTestId("detail-overseer-stop");
    expect(stopBtn).toBeInTheDocument();
    const explainBtn = screen.getByTestId("detail-overseer-explain");
    expect(explainBtn).not.toBeDisabled();
  });

  it("nudge is disabled inside the menu when the overseer has no active observation", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-203", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("stop is absent from the menu when oversight is already off", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-204", column: "in-progress", plannerOversightLevel: "off" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    await findTaskDetailActionByTestId("detail-oversight-level-__inherit__");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });

  it("selecting a level item writes the override via handleOversightLevelChange", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-205", plannerOversightLevel: "steer" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-205", column: "in-progress", plannerOversightLevel: "observe" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-steer"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-205", { plannerOversightLevel: "steer" }, undefined);
    });
  });

  it("nudge from the menu calls nudgeOverseer and closes the menu", async () => {
    const api = await import("../../api");
    vi.mocked(api.nudgeOverseer).mockResolvedValueOnce({ applied: true, reason: "nudged", task: makeTask({ id: "FN-206" }) as any });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-206", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Actions" });
    await openTaskDetailActionsMenu();

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    fireEvent.click(nudgeBtn);

    await waitFor(() => {
      expect(api.nudgeOverseer).toHaveBeenCalledWith("FN-206", undefined);
    });
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("explain from the menu opens the explain panel and renders the active snapshot", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: activeSnapshot });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-207", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("executor");
    expect(panel).toHaveTextContent("Task is actively executing in-progress work");
  });

  it("explain from the menu shows the inactive empty-state when the overseer is inactive", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: null });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-208", column: "in-progress", plannerOversightLevel: "observe", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("not currently watching");
  });

  it("stop from the menu calls stopOverseer after confirmation", async () => {
    const api = await import("../../api");
    vi.mocked(api.stopOverseer).mockResolvedValueOnce({ applied: true, reason: "stopped", task: makeTask({ id: "FN-209", plannerOversightLevel: "off" }) as any });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-209", column: "in-progress", plannerOversightLevel: "steer" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const stopBtn = await screen.findByTestId("detail-overseer-stop");
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
      expect(api.stopOverseer).toHaveBeenCalledWith("FN-209", undefined);
    });
  });

  it("Escape closes the menu without closing Task Detail", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-210", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Actions" });
    await openTaskDetailActionsMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  /*
  FNXC:TaskDetailFooterActions 2026-09-05-23:27:
  The unified Actions menu contains only menu items and notes, so opening it focuses the first enabled quick action (Attach file) without invoking a native picker. Keep that keyboard contract identical at mobile and desktop widths, including when oversight is off.
  */
  it.each([["mobile", MOBILE_WIDTH], ["desktop", DESKTOP_WIDTH]] as const)("auto-focuses Attach file as the first menu item at %s width", async (_viewport, width) => {
    setViewportWidth(width);
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-213", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const attach = await screen.findByTestId("detail-inline-attach");
    const oversightLevel = await screen.findByTestId("detail-oversight-level-__inherit__");
    await screen.findByTestId("detail-overseer-nudge");

    await waitFor(() => expect(document.activeElement).toBe(attach));
    expect(document.activeElement).not.toBe(oversightLevel);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it.each([["mobile", MOBILE_WIDTH], ["desktop", DESKTOP_WIDTH]] as const)("still focuses Attach file when oversight is off at %s width", async (_viewport, width) => {
    setViewportWidth(width);
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-214", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const attach = await screen.findByTestId("detail-inline-attach");
    const oversightLevel = await screen.findByTestId("detail-oversight-level-__inherit__");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();

    await waitFor(() => expect(document.activeElement).toBe(attach));
    expect(document.activeElement).not.toBe(oversightLevel);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("the footer Actions menu renders identically at a desktop viewport", async () => {
    setViewportWidth(DESKTOP_WIDTH);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-215", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // FNXC:TaskDetailFooterActions 2026-09-05-23:27: The same footer Actions menu stays closed by default and exposes the same oversight items at desktop and mobile widths.
    const trigger = await screen.findByRole("button", { name: "Actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await openTaskDetailActionsMenu();
    expect(await findTaskDetailActionByTestId("detail-oversight-level-__inherit__")).toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    setViewportWidth(MOBILE_WIDTH);
  });

  it("click-outside closes the menu", async () => {
    render(
      <>
        <TaskDetailModal
          task={makeTask({ id: "FN-211", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />
        <div data-testid="outside-target" />
      </>,
    );

    await openTaskDetailActionsMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside-target"));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});
