/*
FNXC:TaskDetailFooterActions 2026-09-05-23:27:
FN-300 moves task-level oversight choices and controls into the existing footer Actions menu on every viewport. This suite preserves the effective-policy states, enablement rules, persistence handlers, selected-state semantics, and absence of inactive control shells without relying on the removed toolbar trigger or nested popover.
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

/*
FNXC:TaskDetailFooterActions 2026-09-05-23:27:
Oversight assertions open the shared footer menu first because its flat items are intentionally absent from the closed DOM. Actions close that menu before invoking their existing handler, so tests reopen it before checking a resulting selected or disabled state.
*/
async function openOversightMenu() {
  return openTaskDetailActionsMenu();
}

async function expectOversightHeadingState(state: "on" | "off") {
  const heading = await findTaskDetailActionByTestId("detail-actions-oversight-heading");
  await waitFor(() => expect(heading).toHaveTextContent(`Oversight: ${state}`));
  return heading;
}

/*
FNXC:PlannerOversight 2026-08-09-08:59:
FN-8894 repairs these mutation fixtures because frozen `makeTask` clocks made simulated `updateTask`
responses violate TaskStore's always-advancing update clock. `mergeTaskSnapshot` correctly rejected the
populated advisor field from that equal-clock response, leaving the visible Oversight state stale; mutation
mocks in this suite must advance the clock so they model a real server response.
*/
describe("TaskDetailModal oversight controls", () => {
  it("names the combined oversight state in the footer Actions group heading", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-8194", column: "in-progress", plannerOversightLevel: "observe" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const heading = await findTaskDetailActionByTestId("detail-actions-oversight-heading");
    expect(heading).toHaveRole("note");
    expect(heading).toHaveTextContent("Oversight: on");
    expect(heading).not.toHaveAttribute("aria-haspopup");
  });

  it("uses the workflow legacy advisor tier for the shared detail trigger and toggle", async () => {
    const api = await import("../../api");
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      sessionAdvisorEnabledByDefault: false,
    } as any);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "WF-advisor",
      workflows: [{ id: "WF-advisor", name: "Advisor workflow", columns: [] } as any],
      taskWorkflowIds: { "FN-8247-workflow": "WF-advisor" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: {},
      effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: true },
      defaults: {},
    });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-8247-workflow", column: "in-progress", plannerOversightLevel: "off", sessionAdvisorEnabled: undefined })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const heading = await findTaskDetailActionByTestId("detail-actions-oversight-heading");
    await waitFor(() => expect(heading).toHaveTextContent("Oversight: on"));
    const toggle = await screen.findByTestId("detail-session-advisor-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("lights the trigger from the project advisor default while oversight is off", async () => {
    const api = await import("../../api");
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      sessionAdvisorEnabledByDefault: true,
    } as any);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "WF-8263-project-default",
      workflows: [{ id: "WF-8263-project-default", name: "Project default workflow", columns: [] } as any],
      taskWorkflowIds: { "FN-8263-project-default": "WF-8263-project-default" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: {},
      effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: false },
      defaults: {},
    });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-8263-project-default", column: "todo", plannerOversightLevel: undefined, sessionAdvisorEnabled: undefined })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const heading = await findTaskDetailActionByTestId("detail-actions-oversight-heading");
    await waitFor(() => expect(heading).toHaveTextContent("Oversight: on"));
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the advisor eye visible while workflow oversight is pending and repaints it off", async () => {
    const api = await import("../../api");
    let currentTask = makeTask({
      id: "FN-8263-pending-advisor",
      column: "todo",
      plannerOversightLevel: undefined,
      sessionAdvisorEnabled: undefined,
    });
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      sessionAdvisorEnabledByDefault: true,
    } as any);
    /*
    FNXC:PlannerOversight 2026-07-23-22:20:
    FN-8476 made the board-workflows lookup re-run whenever the task prop identity
    changes (it derives move metadata from the payload), so the onTaskUpdated
    rerender below refetches. A once-mock would leave the refetch on the
    flagEnabled:false default and silently drop the workflow tier mid-test —
    keep the payload persistent for every call in this test.
    */
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "WF-8263-pending-advisor",
      workflows: [{ id: "WF-8263-pending-advisor", name: "Pending advisor workflow", columns: [] } as any],
      taskWorkflowIds: { [currentTask.id]: "WF-8263-pending-advisor" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockImplementationOnce(() => new Promise(() => {}));
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
    expect(screen.queryByTestId("detail-oversight-level-__inherit__")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-oversight-controls-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
    expect(screen.queryByText("Interventions")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("detail-session-advisor-toggle"));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(currentTask.id, { sessionAdvisorEnabled: false }, undefined));
    await expectOversightHeadingState("off");
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("gives an explicit false override precedence and repaints when it is toggled on", async () => {
    const api = await import("../../api");
    let currentTask = makeTask({
      id: "FN-8247-explicit-off",
      column: "in-progress",
      plannerOversightLevel: "off",
      sessionAdvisorEnabled: false,
    });
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      sessionAdvisorEnabledByDefault: false,
    } as any);
    // FNXC:PlannerOversight 2026-07-23-22:20: persistent mock — FN-8476 refetches
    // board workflows on each task-prop identity change (see pending-advisor test).
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "WF-advisor-explicit-off",
      workflows: [{ id: "WF-advisor-explicit-off", name: "Advisor workflow", columns: [] } as any],
      taskWorkflowIds: { [currentTask.id]: "WF-advisor-explicit-off" },
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

    await expectOversightHeadingState("off");
    const toggle = await screen.findByTestId("detail-session-advisor-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(currentTask.id, { sessionAdvisorEnabled: null }, undefined));
    await expectOversightHeadingState("on");
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("updates the Oversight heading for level and session-advisor predicate changes", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    let currentTask = makeTask({
      id: "FN-8233",
      column: "in-progress",
      plannerOversightLevel: "observe",
      sessionAdvisorEnabled: false,
    });
    mockUpdate.mockImplementation(async (_id, patch) => {
      currentTask = makeUpdatedTask(currentTask, patch);
      return currentTask as any;
    });

    let rerenderModal: (task: typeof currentTask) => void;
    const renderModal = (task: typeof currentTask) => (
      <TaskDetailModal
        task={task}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)}
        addToast={noop}
      />
    );
    const rendered = render(renderModal(currentTask));
    rerenderModal = (updatedTask) => rendered.rerender(renderModal(updatedTask));

    await expectOversightHeadingState("on");

    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-off"));
    await expectOversightHeadingState("off");

    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-observe"));
    await expectOversightHeadingState("on");

    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-off"));
    await expectOversightHeadingState("off");

    fireEvent.click(await findTaskDetailActionByTestId("detail-session-advisor-toggle"));
    await expectOversightHeadingState("on");

    fireEvent.click(await findTaskDetailActionByTestId("detail-session-advisor-toggle"));
    await expectOversightHeadingState("off");
  });

  it("retains a populated advisor override for an equal-clock mutation, then repaints for a newer response", async () => {
    const api = await import("../../api");
    let currentTask = makeTask({ id: "FN-8894-equal-clock", column: "in-progress", plannerOversightLevel: "off", sessionAdvisorEnabled: false });
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {}, sessionAdvisorEnabledByDefault: false } as any);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "WF-8894-equal-clock", workflows: [{ id: "WF-8894-equal-clock", name: "Equal-clock workflow", columns: [] } as any], taskWorkflowIds: { [currentTask.id]: "WF-8894-equal-clock" } });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: true }, defaults: {} });
    let updateCount = 0;
    vi.mocked(api.updateTask).mockImplementation(async (_id, patch) => {
      updateCount += 1;
      currentTask = updateCount === 1
        ? makeTask({ ...currentTask, ...patch, updatedAt: currentTask.updatedAt })
        : makeUpdatedTask(currentTask, patch);
      return currentTask as any;
    });

    let rerenderModal: (nextTask: typeof currentTask) => void;
    const renderModal = (nextTask: typeof currentTask) => <TaskDetailModal task={nextTask} onClose={noop} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)} addToast={noop} />;
    const rendered = render(renderModal(currentTask));
    rerenderModal = (nextTask) => rendered.rerender(renderModal(nextTask));

    await expectOversightHeadingState("off");
    fireEvent.click(await findTaskDetailActionByTestId("detail-session-advisor-toggle"));
    await expectOversightHeadingState("off");
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("detail-session-advisor-toggle"));
    await expectOversightHeadingState("on");
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("fills an absent advisor override from an equal-clock mutation response", async () => {
    const api = await import("../../api");
    let currentTask = makeTask({ id: "FN-8894-absent-clock", column: "in-progress", plannerOversightLevel: "off", sessionAdvisorEnabled: undefined });
    vi.mocked(api.fetchSettings).mockResolvedValueOnce({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {}, sessionAdvisorEnabledByDefault: false } as any);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "WF-8894-absent-clock", workflows: [{ id: "WF-8894-absent-clock", name: "Absent-clock workflow", columns: [] } as any], taskWorkflowIds: { [currentTask.id]: "WF-8894-absent-clock" } });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: true }, defaults: {} });
    vi.mocked(api.updateTask).mockImplementation(async (_id, patch) => {
      currentTask = makeTask({ ...currentTask, ...patch, updatedAt: currentTask.updatedAt });
      return currentTask as any;
    });

    let rerenderModal: (nextTask: typeof currentTask) => void;
    const renderModal = (nextTask: typeof currentTask) => <TaskDetailModal task={nextTask} onClose={noop} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)} addToast={noop} />;
    const rendered = render(renderModal(currentTask));
    rerenderModal = (nextTask) => rendered.rerender(renderModal(nextTask));

    await expectOversightHeadingState("on");
    fireEvent.click(await findTaskDetailActionByTestId("detail-session-advisor-toggle"));
    await expectOversightHeadingState("off");
    expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
  });

  it("level items reflect a per-task override and write the override on change", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-100", plannerOversightLevel: "steer" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-100", column: "in-progress", plannerOversightLevel: "observe" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    expect(await findTaskDetailActionByTestId("detail-oversight-level-observe")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-steer"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-100", { plannerOversightLevel: "steer" }, undefined);
    });
  });

  it("clearing the override writes a null-clear back to the inherited default", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-101" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-101", column: "in-progress", plannerOversightLevel: "steer" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-__inherit__"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-101", { plannerOversightLevel: null }, undefined);
    });
  });

  it("nudge is enabled and calls nudgeOverseer when the overseer is actively watching", async () => {
    const api = await import("../../api");
    vi.mocked(api.nudgeOverseer).mockResolvedValueOnce({ applied: true, reason: "nudged", task: makeTask({ id: "FN-102" }) as any });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-102", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).not.toBeDisabled();
    fireEvent.click(nudgeBtn);

    await waitFor(() => {
      expect(api.nudgeOverseer).toHaveBeenCalledWith("FN-102", undefined);
    });
  });

  it("nudge is disabled when the overseer has no active observation", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-103", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("shows a visible group label and an in-DOM disabled-reason helper (not just a hover title) when Nudge is unavailable (FN-7546, reworded copy FN-7582)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-111", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const label = await screen.findByTestId("detail-oversight-controls-label");
    expect(label).toHaveTextContent("Overseer controls");

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();

    // FN-7582: the old copy ("Nudge unavailable: overseer is not actively
    // watching this task") read as a fault report. The reworded copy must
    // frame the no-observation state as periodic/benign instead.
    const reason = await screen.findByTestId("detail-overseer-nudge-disabled-reason");
    expect(reason).not.toHaveTextContent("not actively watching this task");
    expect(reason).toHaveTextContent("Nudge becomes available once the overseer is observing this task's current stage");
  });

  it("desktop: shows the periodic-observation copy (not the old alarming phrase) for an in-progress task with no plannerOverseerState (FN-7582)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-116", column: "in-progress", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();

    const reason = await screen.findByTestId("detail-overseer-nudge-disabled-reason");
    expect(reason).not.toHaveTextContent("not actively watching this task");
    expect(reason).toHaveTextContent("Nudge becomes available once the overseer is observing this task's current stage");
  });

  it("desktop: shows the human-control-suppressed copy (not the periodic-observation copy) when the task is user-paused (FN-7582)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-117", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot, userPaused: true })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();

    const reason = await screen.findByTestId("detail-overseer-nudge-disabled-reason");
    expect(reason).toHaveTextContent("Nudge is paused while this task is under manual control.");
    expect(reason).not.toHaveTextContent("Nudge becomes available once the overseer is observing this task's current stage");
  });

  it("does not show the disabled-reason helper when Nudge is enabled", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-112", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).not.toBeDisabled();
    expect(screen.queryByTestId("detail-overseer-nudge-disabled-reason")).not.toBeInTheDocument();
  });

  it("nudge is disabled while the task is user-paused", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-104", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot, userPaused: true })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("nudge is disabled when the task is done", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-105", column: "done", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("stop calls stopOverseer after confirmation", async () => {
    const api = await import("../../api");
    vi.mocked(api.stopOverseer).mockResolvedValueOnce({ applied: true, reason: "stopped", task: makeTask({ id: "FN-106", plannerOversightLevel: "off" }) as any });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-106", column: "in-progress", plannerOversightLevel: "steer" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const stopBtn = await screen.findByTestId("detail-overseer-stop");
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
      expect(api.stopOverseer).toHaveBeenCalledWith("FN-106", undefined);
    });
  });

  it("stop is hidden when oversight is already off", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-107", column: "in-progress", plannerOversightLevel: "off" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    await findTaskDetailActionByTestId("detail-oversight-level-__inherit__");
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
  });

  it("explain renders watched stage/reason/action/attempt-count from overseer state", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: activeSnapshot });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-108", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("executor");
    expect(panel).toHaveTextContent("Task is actively executing in-progress work");
    expect(panel).toHaveTextContent("inject_guidance");
    expect(panel).toHaveTextContent("1");
    expect(panel).toHaveTextContent("3");
  });

  it("explain shows the inactive empty-state (no empty shell) when the overseer is inactive", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: null });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-109", column: "in-progress", plannerOversightLevel: "observe", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("not currently watching");
  });

  it("Explain is never disabled while the overseer is inactive and always opens the read-only panel (FN-7546)", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: null });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-113", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    // Read-only Explain must never be disabled purely because the overseer
    // isn't actively watching — that inactive state is exactly what the
    // panel's empty-state message communicates.
    expect(explainBtn).not.toBeDisabled();

    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("not currently watching");
  });

  it("renders no oversight-control leftover shell when oversight is off and the overseer is inactive (default case)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-110", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // Level choices remain in the opened menu so an operator can opt in to oversight, but
    // nudge/stop/explain must not render an always-on empty shell for the
    // common off+inactive default.
    await openOversightMenu();
    await findTaskDetailActionByTestId("detail-oversight-level-__inherit__");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });
});

/*
FNXC:PlannerOversight 2026-07-05-00:00:
FN-7600 regression coverage: the modal previously read `overseerSnapshot` from
the raw `task` prop, which loses the snapshot whenever the modal is opened via
`fetchTaskDetail` (dependency chips, Documents view, logs) because those call
sites pass a slim `Task` (no `prompt` key) that never carries
`plannerOverseerState` — only the full-detail fetch response does. These
tests reproduce that exact path: a slim task prop with NO snapshot, plus a
mocked `fetchTaskDetail` resolving a full TaskDetail WITH an active snapshot,
and assert Nudge enables (helper absent) once the fetched detail lands —
inside the shared footer Actions menu at both desktop and narrow viewport widths.
*/
describe("TaskDetailModal oversight controls — snapshot delivered via fetched full detail (FN-7600)", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  function makeSlimTaskWithoutSnapshot(overrides: Record<string, unknown> = {}) {
    // Omit `prompt`/`log`/`steps` so the modal treats this as a slim `Task`
    // (not a `TaskDetail`) and triggers the `fetchTaskDetail` fetch-on-open
    // path instead of using the prop directly as `fullDetail`.
    const { prompt: _prompt, log: _log, steps: _steps, plannerOverseerState: _snap, ...task } = makeTask({
      id: "FN-220",
      column: "in-progress",
      plannerOversightLevel: "autonomous",
      ...overrides,
    });
    return task;
  }

  it("desktop: enables Nudge and hides the disabled-reason helper once the fetched full detail carries an active snapshot", async () => {
    const api = await import("../../api");
    vi.mocked(api.fetchTaskDetail).mockResolvedValueOnce(makeTask({
      id: "FN-220",
      column: "in-progress",
      plannerOversightLevel: "autonomous",
      plannerOverseerState: activeSnapshot,
    }));

    render(
      <TaskDetailModal
        task={makeSlimTaskWithoutSnapshot() as any}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    await waitFor(() => {
      expect(nudgeBtn).not.toBeDisabled();
    });
    expect(screen.queryByTestId("detail-overseer-nudge-disabled-reason")).not.toBeInTheDocument();
  });

  it("desktop: still shows the periodic-observation copy while the fetched full detail carries no snapshot", async () => {
    const api = await import("../../api");
    vi.mocked(api.fetchTaskDetail).mockResolvedValueOnce(makeTask({
      id: "FN-221",
      column: "in-progress",
      plannerOversightLevel: "autonomous",
    }));

    render(
      <TaskDetailModal
        task={makeSlimTaskWithoutSnapshot({ id: "FN-221" }) as any}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
    const reason = await screen.findByTestId("detail-overseer-nudge-disabled-reason");
    expect(reason).toHaveTextContent("Nudge becomes available once the overseer is observing this task's current stage");
  });

  it("mobile: enables Nudge and hides its disabled note once full detail carries an active snapshot", async () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });

    const api = await import("../../api");
    vi.mocked(api.fetchTaskDetail).mockResolvedValueOnce(makeTask({
      id: "FN-222",
      column: "in-progress",
      plannerOversightLevel: "autonomous",
      plannerOverseerState: activeSnapshot,
    }));

    render(
      <TaskDetailModal
        task={makeSlimTaskWithoutSnapshot({ id: "FN-222" }) as any}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openTaskDetailActionsMenu();

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    await waitFor(() => {
      expect(nudgeBtn).not.toBeDisabled();
    });
    expect(screen.queryByTestId("detail-overseer-nudge-disabled-reason")).not.toBeInTheDocument();
  });
});

/*
FNXC:TaskDetailFooterActions 2026-09-05-23:27:
The footer Actions menu is the universal oversight surface. Keep a narrow-width regression lane so the same flat menu items, handlers, and inactive-state omissions remain usable without reviving viewport-specific branches or nested popovers.
*/
describe("TaskDetailModal oversight controls — narrow-viewport footer Actions regression", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
    // Exercise the shared footer menu under the mobile breakpoint without selecting a separate JS branch.
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  // Reuses the shared `openOversightMenu()` helper defined at file scope.

  it("renders level choices in the footer menu and writes on change", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.fn().mockResolvedValue(makeTask({ id: "FN-201", plannerOversightLevel: "steer" }));
    vi.mocked(api.updateTask).mockImplementation(mockUpdate as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-201", column: "todo", plannerOversightLevel: "observe" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();

    expect(await findTaskDetailActionByTestId("detail-oversight-level-observe")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(await findTaskDetailActionByTestId("detail-oversight-level-steer"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-201", { plannerOversightLevel: "steer" }, undefined);
    });
  });

  it("renders enabled nudge/stop/explain items at a narrow viewport when the overseer is actively watching", async () => {
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

    await openOversightMenu();

    expect(await screen.findByTestId("detail-overseer-nudge")).not.toBeDisabled();
    expect(await screen.findByTestId("detail-overseer-stop")).toBeTruthy();
    expect(await screen.findByTestId("detail-overseer-explain")).toBeTruthy();
  });

  it("shows the periodic-observation copy in the footer menu at a narrow viewport", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-216", column: "in-progress", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();

    const reason = await screen.findByTestId("detail-overseer-nudge-disabled-reason");
    expect(reason).not.toHaveTextContent("not actively watching this task");
    expect(reason).toHaveTextContent("Nudge becomes available once the overseer is observing this task's current stage");
  });

  it("renders no oversight-control leftover shell at a narrow viewport for the off+inactive default case", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-203", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // Level choices remain available so an operator can opt in to oversight, but the menu must not carry an empty
    // nudge/stop/explain shell for the common off+inactive default.
    await openOversightMenu();

    await findTaskDetailActionByTestId("detail-oversight-level-__inherit__");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });
});

/*
FNXC:PlannerOversight 2026-07-04-19:00:
FN-7571 coverage: the FN-7519 Intervention Timeline moved from an inline
mount in the oversight cluster into the Activity view dropdown as a fourth
"Interventions" segment, gated on the same oversight-active expression the
inline mount used. These assertions cover: (a) no inline mount remains,
(b) the dropdown option appears/renders the timeline when oversight is
active, (c) the option is absent and nothing mounts when oversight is off,
and (d) selecting Interventions then losing oversight falls back to Live
with no blank panel.

FNXC:TaskDetailFooterActions 2026-09-05-23:27:
These tests use the Oversight heading inside the opened footer Actions menu as their policy-resolution sync point. Intervention Timeline remains owned by the Activity dropdown and never moves into the footer menu.
*/
describe("Intervention Timeline relocation into the Activity dropdown (FN-7571)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
  });

    function openActivityViewMenu() {
      const existingMenu = screen.queryByRole("menu", { name: "Activity views" });
      if (!existingMenu) {
        fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      }
      return screen.getByRole("menu", { name: "Activity views" });
    }

    it("never renders the timeline inline in the oversight cluster", async () => {
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

      await findTaskDetailActionByTestId("detail-actions-oversight-heading");
      expect(screen.queryByTestId("planner-intervention-timeline")).not.toBeInTheDocument();
    });

    it("exposes an Interventions option in the Activity dropdown and renders the timeline when oversight is active", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-211", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await findTaskDetailActionByTestId("detail-actions-oversight-heading");
      openActivityViewMenu();
      const option = screen.getByRole("menuitem", { name: "Interventions" });
      fireEvent.click(option);

      expect(await screen.findByTestId("planner-intervention-timeline")).toBeInTheDocument();
    });

    it("omits the Interventions option and mounts nothing when oversight is off", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-212", column: "in-progress", plannerOversightLevel: "off" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await findTaskDetailActionByTestId("detail-actions-oversight-heading");
      openActivityViewMenu();
      expect(screen.queryByRole("menuitem", { name: "Interventions" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("planner-intervention-timeline")).not.toBeInTheDocument();
    });

    it("falls back to Live with no blank panel if oversight turns off after Interventions was selected", async () => {
      const { rerender } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-213", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await findTaskDetailActionByTestId("detail-actions-oversight-heading");
      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Interventions" }));
      expect(await screen.findByTestId("planner-intervention-timeline")).toBeInTheDocument();

      rerender(
        <TaskDetailModal
          task={makeTask({ id: "FN-213", column: "in-progress", plannerOversightLevel: "off" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(screen.queryByTestId("planner-intervention-timeline")).not.toBeInTheDocument();
      });
      openActivityViewMenu();
      expect(screen.getByRole("menuitem", { name: "Live" })).toHaveAttribute("aria-current", "true");
    });

    it("gives the Interventions Activity container the full-width modifier while Feed keeps the toggle-reserving container (FN-7581)", async () => {
      // FNXC:PlannerOversight 2026-07-05-00:00: FN-7581 regression — the Interventions
      // segment's `.detail-activity` container must carry `detail-activity--interventions`
      // so it stops reserving `padding-inline-end` for the `.activity-expand-toggle--overlay`
      // button it never renders (the FN-7519 timeline was inset from the right edge on
      // mobile as a result). Feed (the only other segment sharing the raw `.detail-activity`
      // wrapper and rendering that overlay toggle) must NOT carry the modifier since it still
      // needs the reserved padding to keep the toggle from covering its content. (Live mounts
      // its own overlay toggle inside TaskChatTab and never wraps in `.detail-activity` at all.)
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

      await findTaskDetailActionByTestId("detail-actions-oversight-heading");

      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Feed" }));

      const feedContainer = (await screen.findByText("Feed")).closest(".detail-activity");
      expect(feedContainer).not.toBeNull();
      expect(feedContainer).not.toHaveClass("detail-activity--interventions");

      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Interventions" }));

      const interventionsContainer = (await screen.findByTestId("planner-intervention-timeline")).closest(".detail-activity");
      expect(interventionsContainer).not.toBeNull();
      expect(interventionsContainer).toHaveClass("detail-activity--interventions");
    });

    it("still renders the empty state inside the Activity segment when there are no interventions", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-214", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await findTaskDetailActionByTestId("detail-actions-oversight-heading");
      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Interventions" }));

      expect(await screen.findByTestId("planner-intervention-timeline-empty")).toBeInTheDocument();
    });
  });

