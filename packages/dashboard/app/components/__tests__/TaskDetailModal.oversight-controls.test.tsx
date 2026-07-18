/*
FNXC:PlannerOversight 2026-07-04-17:00:
FN-7517 coverage for the task-detail planner-overseer controls: the quick
oversight-level-change select, the manual nudge/stop/explain buttons, and
their enablement/leftover-shell rules (Surface Enumeration).

FNXC:PlannerOversight 2026-07-05-00:00:
FN-7604 — the desktop inline cluster was removed; ALL oversight controls
(including at the historically "desktop" 1024px-ish jsdom default width) now
render only behind the `detail-oversight-menu-trigger` overflow menu, the
same surface the mobile suite below already exercised. This describe block's
tests are retargeted to open the trigger via the shared `openOversightMenu()`
helper before querying level-select/nudge/stop/explain, mirroring the
pre-existing FN-7545/FN-7558 mobile pattern exactly — there is no longer a
separate desktop-only assertion path.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PlannerOverseerRuntimeSnapshot } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
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
FNXC:PlannerOversight 2026-07-05-00:00:
FN-7604 — shared open-the-overflow-menu helper reused across every describe
block in this file (the pattern the FN-7521/FN-7545 mobile-only describe
block already used). Since the dropdown is now the universal surface at
every viewport, every test that needs to observe the level select or the
nudge/stop/explain buttons must click the trigger first.
*/
async function openOversightMenu() {
  const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
  fireEvent.click(trigger);
  return trigger;
}

describe("TaskDetailModal oversight controls", () => {
  it("uses the Eye icon for the labeled oversight overflow trigger", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-8194", column: "in-progress", plannerOversightLevel: "observe" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    expect(trigger).toHaveClass("btn", "btn-icon", "btn-sm");
    expect(trigger).toHaveAccessibleName("Oversight actions");
    expect(trigger).toHaveAttribute("title", "Oversight actions");
    expect(trigger).not.toHaveTextContent("Oversight");
    expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
    expect(trigger.querySelector('[data-testid="more-vertical-icon"]')).not.toBeInTheDocument();
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
      workflows: [{ id: "WF-advisor", name: "Advisor workflow" } as any],
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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
    });
    await openOversightMenu();
    const toggle = await screen.findByTestId("detail-session-advisor-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
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
      workflows: [{ id: "WF-8263-project-default", name: "Project default workflow" } as any],
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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
    });
    await openOversightMenu();
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
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "WF-8263-pending-advisor",
      workflows: [{ id: "WF-8263-pending-advisor", name: "Pending advisor workflow" } as any],
      taskWorkflowIds: { [currentTask.id]: "WF-8263-pending-advisor" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(api.updateTask).mockImplementation(async (_id, patch) => {
      currentTask = makeTask({ ...currentTask, ...patch });
      return currentTask as any;
    });

    let rerenderModal: (nextTask: typeof currentTask) => void;
    const renderModal = (nextTask: typeof currentTask) => (
      <TaskDetailModal
        task={nextTask}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)}
        addToast={noop}
      />
    );
    const rendered = render(renderModal(currentTask));
    rerenderModal = (nextTask) => rendered.rerender(renderModal(nextTask));

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("detail-oversight-level-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-oversight-controls-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
    expect(screen.queryByText("Interventions")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("detail-session-advisor-toggle"));
    await waitFor(() => {
      expect(api.updateTask).toHaveBeenCalledWith(currentTask.id, { sessionAdvisorEnabled: false }, undefined);
      expect(screen.getByTestId("detail-oversight-menu-trigger")).toBeInTheDocument();
      expect(screen.getByTestId("detail-oversight-menu-trigger").querySelector('[data-testid="eye-off-icon"]')).toBeInTheDocument();
      expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "false");
    });
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
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "WF-advisor-explicit-off",
      workflows: [{ id: "WF-advisor-explicit-off", name: "Advisor workflow" } as any],
      taskWorkflowIds: { [currentTask.id]: "WF-advisor-explicit-off" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: {},
      effective: { plannerOversightLevel: "off", plannerOverseerAdvisorEnabled: true },
      defaults: {},
    });
    vi.mocked(api.updateTask).mockImplementation(async (_id, patch) => {
      currentTask = makeTask({ ...currentTask, ...patch });
      return currentTask as any;
    });

    let rerenderModal: (nextTask: typeof currentTask) => void;
    const renderModal = (nextTask: typeof currentTask) => (
      <TaskDetailModal
        task={nextTask}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)}
        addToast={noop}
      />
    );
    const rendered = render(renderModal(currentTask));
    rerenderModal = (nextTask) => rendered.rerender(renderModal(nextTask));

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-off-icon"]')).toBeInTheDocument();
    });
    await openOversightMenu();
    const toggle = await screen.findByTestId("detail-session-advisor-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(api.updateTask).toHaveBeenCalledWith(currentTask.id, { sessionAdvisorEnabled: null }, undefined);
      expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
      expect(screen.getByTestId("detail-session-advisor-toggle")).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("updates the trigger icon for oversight-level and session-advisor predicate changes", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    let currentTask = makeTask({
      id: "FN-8233",
      column: "in-progress",
      plannerOversightLevel: "observe",
      sessionAdvisorEnabled: false,
    });
    mockUpdate.mockImplementation(async (_id, patch) => {
      currentTask = makeTask({ ...currentTask, ...patch });
      return currentTask as any;
    });

    let rerenderModal: (task: typeof currentTask) => void;
    const renderModal = (task: typeof currentTask) => (
      <TaskDetailModal
        task={task}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={(updatedTask) => rerenderModal(updatedTask as typeof currentTask)}
        addToast={noop}
      />
    );
    const rendered = render(renderModal(currentTask));
    rerenderModal = (updatedTask) => rendered.rerender(renderModal(updatedTask));

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();

    await openOversightMenu();
    const select = await screen.findByTestId("detail-oversight-level-select");
    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-off-icon"]')).toBeInTheDocument();
    });

    fireEvent.change(select, { target: { value: "observe" } });
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
    });

    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-off-icon"]')).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId("detail-session-advisor-toggle"));
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-icon"]')).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId("detail-session-advisor-toggle"));
    await waitFor(() => {
      expect(trigger.querySelector('[data-testid="eye-off-icon"]')).toBeInTheDocument();
    });
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

  it("quick level select reflects a per-task override and writes the override on change", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-100", plannerOversightLevel: "steer" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-100", column: "in-progress", plannerOversightLevel: "observe" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const select = await screen.findByTestId("detail-oversight-level-select");
    expect((select as HTMLSelectElement).value).toBe("observe");

    fireEvent.change(select, { target: { value: "steer" } });

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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    const select = await screen.findByTestId("detail-oversight-level-select");
    fireEvent.change(select, { target: { value: "__inherit__" } });

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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
    expect(nudgeBtn).toHaveAttribute("title", expect.stringContaining("Nudge becomes available once the overseer is observing this task's current stage"));
  });

  it("desktop: shows the periodic-observation copy (not the old alarming phrase) for an in-progress task with no plannerOverseerState (FN-7582)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-116", column: "in-progress", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onMoveTask={noopMove}
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
    expect(nudgeBtn).toHaveAttribute("title", expect.stringContaining("Nudge becomes available once the overseer is observing this task's current stage"));
  });

  it("desktop: shows the human-control-suppressed copy (not the periodic-observation copy) when the task is user-paused (FN-7582)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-117", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot, userPaused: true })}
        onClose={noop}
        onMoveTask={noopMove}
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
    expect(nudgeBtn).toHaveAttribute("title", expect.stringContaining("Nudge is paused while this task is under manual control."));
  });

  it("does not show the disabled-reason helper when Nudge is enabled", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-112", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();
    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
  });

  it("explain renders watched stage/reason/action/attempt-count from overseer state", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: activeSnapshot });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-108", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The quick level-change select still renders inside the opened menu
    // (it's always editable so an operator can opt IN to oversight), but
    // nudge/stop/explain must not render an always-on empty shell for the
    // common off+inactive default.
    await openOversightMenu();
    await screen.findByTestId("detail-oversight-level-select");
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
behind the (now universal, FN-7604) overflow-menu trigger at both a
"desktop" and a narrow-viewport width, exercised via the shared
`openOversightMenu()` helper.
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
        onMoveTask={noopMove}
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
        onMoveTask={noopMove}
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

  it("mobile: enables Nudge and hides the disabled-reason helper behind the overflow menu once the fetched full detail carries an active snapshot", async () => {
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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    await waitFor(() => {
      expect(nudgeBtn).not.toBeDisabled();
    });
    expect(screen.queryByTestId("detail-overseer-nudge-disabled-reason")).not.toBeInTheDocument();
  });
});

/*
 * FNXC:PlannerOversight 2026-07-04-20:30 (FN-7558):
 * FN-7521's original mobile suite asserted the oversight quick-controls
 * cluster rendered its FLAT inline testids at a narrow `window.innerWidth`,
 * matching the pre-FN-7545 DOM (CSS-only `@media (max-width: 768px)` wrap,
 * no conditional mount). FN-7545 then collapsed that cluster's action
 * controls (level select / nudge / stop / explain) into a mobile overflow
 * menu behind a `detail-oversight-menu-trigger` button instead of inline —
 * the old flat queries no longer find them. This suite drives the real
 * FN-7545 overflow-menu affordance: open the trigger, then query the menu
 * items.
 *
 * FNXC:PlannerOversight 2026-07-05-00:00 (FN-7604):
 * The overflow menu this suite exercises is now the UNIVERSAL surface at
 * every viewport, not a mobile-only branch — the desktop describe block
 * above drives the exact same menu via the shared `openOversightMenu()`
 * helper. Forcing `window.innerWidth = 375` here no longer selects a
 * different code path; it is kept purely as a documented regression guard
 * that the popover still renders/behaves correctly at a narrow width (e.g.
 * `.detail-oversight-menu { right: 0 }` positioning), not because a second
 * branch exists to select between.
 */
describe("TaskDetailModal oversight controls — narrow-viewport regression guard (FN-7521, FN-7545/FN-7604 universal overflow menu)", () => {
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
    // Force a narrow viewport as a regression guard for the popover's mobile
    // positioning/rendering; the overflow menu itself is the universal
    // surface at every width post-FN-7604, so this no longer selects a
    // separate branch.
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  // Reuses the shared `openOversightMenu()` helper defined at file scope.

  it("still renders the quick level-change select behind the overflow menu and writes on change", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.fn().mockResolvedValue(makeTask({ id: "FN-201", plannerOversightLevel: "steer" }));
    vi.mocked(api.updateTask).mockImplementation(mockUpdate as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-201", column: "todo", plannerOversightLevel: "observe" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await openOversightMenu();

    const select = await screen.findByTestId("detail-oversight-level-select");
    expect((select as HTMLSelectElement).value).toBe("observe");
    fireEvent.change(select, { target: { value: "steer" } });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-201", { plannerOversightLevel: "steer" }, undefined);
    });
  });

  it("still renders enabled nudge/stop/explain controls behind the overflow menu at a narrow viewport when the overseer is actively watching", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-202", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
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

  it("still shows the reworded periodic-observation copy (not the old alarming phrase) behind the overflow menu at a narrow viewport (FN-7582)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-216", column: "in-progress", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onMoveTask={noopMove}
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

  it("still renders no oversight-control leftover shell behind the overflow menu at a narrow viewport for the off+inactive default case", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-203", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The overflow-menu trigger itself always renders (an operator must still
    // be able to opt IN to oversight), but the menu must not carry an empty
    // nudge/stop/explain shell for the common off+inactive default.
    await openOversightMenu();

    await screen.findByTestId("detail-oversight-level-select");
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

FNXC:PlannerOversight 2026-07-05-00:00:
FN-7604 — these tests previously used `detail-overseer-nudge`/
`detail-oversight-level-select` as a "wait for the oversight cluster to
mount" sync point. Since ALL oversight controls now render only inside the
closed-by-default overflow menu, that sync point no longer mounts without
first opening the trigger. Retargeted to sync on `detail-oversight-menu-trigger`
instead (the now-universal mount point) — the Intervention-Timeline-specific
assertions (open Activity dropdown → click "Interventions" → assert
`planner-intervention-timeline`) are otherwise unchanged.
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await screen.findByTestId("detail-oversight-menu-trigger");
      expect(screen.queryByTestId("planner-intervention-timeline")).not.toBeInTheDocument();
    });

    it("exposes an Interventions option in the Activity dropdown and renders the timeline when oversight is active", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-211", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await screen.findByTestId("detail-oversight-menu-trigger");
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await screen.findByTestId("detail-oversight-menu-trigger");
      openActivityViewMenu();
      expect(screen.queryByRole("menuitem", { name: "Interventions" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("planner-intervention-timeline")).not.toBeInTheDocument();
    });

    it("falls back to Live with no blank panel if oversight turns off after Interventions was selected", async () => {
      const { rerender } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-213", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await screen.findByTestId("detail-oversight-menu-trigger");
      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Interventions" }));
      expect(await screen.findByTestId("planner-intervention-timeline")).toBeInTheDocument();

      rerender(
        <TaskDetailModal
          task={makeTask({ id: "FN-213", column: "in-progress", plannerOversightLevel: "off" })}
          onClose={noop}
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await screen.findByTestId("detail-oversight-menu-trigger");

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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await screen.findByTestId("detail-oversight-menu-trigger");
      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Interventions" }));

      expect(await screen.findByTestId("planner-intervention-timeline-empty")).toBeInTheDocument();
    });
  });

