/*
FNXC:PlannerOversight 2026-07-04-17:00:
FN-7517 coverage for the task-detail planner-overseer controls: the quick
oversight-level-change select, the manual nudge/stop/explain buttons, and
their enablement/leftover-shell rules (Surface Enumeration).
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("TaskDetailModal oversight controls", () => {
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

    // The quick level-change select still renders (it's always editable so an
    // operator can opt IN to oversight), but nudge/stop/explain must not
    // render an always-on empty shell for the common off+inactive default.
    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });
});

/*
 * FNXC:PlannerOversight 2026-07-04-20:30 (FN-7558):
 * FN-7521's original mobile suite asserted the oversight quick-controls
 * cluster rendered its FLAT inline testids at a narrow `window.innerWidth`,
 * matching the pre-FN-7545 DOM (CSS-only `@media (max-width: 768px)` wrap,
 * no conditional mount). FN-7545 then collapsed that cluster's action
 * controls (level select / nudge / stop / explain) into a mobile overflow
 * menu: at `window.innerWidth <= OVERSIGHT_MENU_MOBILE_BREAKPOINT` (768) the
 * mount-time `updateOversightMenuMobile()` effect flips `isOversightMenuMobile`
 * to true, so those controls now render INSIDE a closed `detail-oversight-menu`
 * behind a `detail-oversight-menu-trigger` button instead of inline — the old
 * flat queries no longer find them. This suite is corrected to drive the real
 * FN-7545 mobile affordance: open the trigger, then query the menu items. It
 * still asserts the same invariants FN-7521 required — select-writes-on-change,
 * enabled nudge/stop/explain when the overseer is active, and no leftover
 * empty-menu shell for the off+inactive default — just through the shipped
 * mobile surface. The desktop branch (first `describe` above) is unchanged.
 */
describe("TaskDetailModal oversight controls — mobile breakpoint (FN-7521, FN-7545 overflow menu)", () => {
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
    // Setting innerWidth before render is sufficient: TaskDetailModal's mount
    // effect calls `updateOversightMenuMobile()` once on mount, reading
    // `window.innerWidth` synchronously, which flips `isOversightMenuMobile`
    // before the first paint the tests observe.
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  async function openOversightMenu() {
    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);
    return trigger;
  }

  it("still renders the quick level-change select behind the mobile overflow menu and writes on change", async () => {
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

  it("still renders enabled nudge/stop/explain controls behind the mobile overflow menu when the overseer is actively watching", async () => {
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

  it("still shows the reworded periodic-observation copy (not the old alarming phrase) behind the mobile overflow menu (FN-7582)", async () => {
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

  it("still renders no oversight-control leftover shell behind the mobile overflow menu for the off+inactive default case", async () => {
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
with no blank panel. Runs at the default (desktop) breakpoint, matching the
first describe block's setup rather than the FN-7521/FN-7545 mobile one.
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

      await screen.findByTestId("detail-overseer-nudge");
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

      await screen.findByTestId("detail-overseer-nudge");
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

      await screen.findByTestId("detail-oversight-level-select");
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

      await screen.findByTestId("detail-overseer-nudge");
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

      await screen.findByTestId("detail-overseer-nudge");

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

      await screen.findByTestId("detail-overseer-nudge");
      openActivityViewMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Interventions" }));

      expect(await screen.findByTestId("planner-intervention-timeline-empty")).toBeInTheDocument();
    });
  });

