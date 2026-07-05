/*
FNXC:PlannerOversight 2026-07-04-19:00:
FN-7545 coverage for the mobile collapse of the FN-7517 oversight action
controls into a single overflow menu (`detail-oversight-menu-trigger`). The
suite forces the narrow-viewport branch by setting `window.innerWidth` below
the `TaskDetailModal.tsx` `OVERSIGHT_MENU_MOBILE_BREAKPOINT` (768) BEFORE
render, since the component reads `window.innerWidth` on mount via a resize
listener (mirroring `DocumentsView`'s local `isMobile` pattern) rather than a
CSS media query. Every action inside the menu reuses the SAME handlers and
enablement gates as the desktop suite
(`TaskDetailModal.oversight-controls.test.tsx`) — this file only asserts the
collapsed-menu affordance, not new guard logic.
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

const MOBILE_WIDTH = 375;
const DESKTOP_WIDTH = 1024;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
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

  it("renders a single overflow trigger (no inline action buttons) when oversight actions are available", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-200", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Actions are not directly in the DOM until the menu opens.
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });

  it("the overflow menu shows only the level select (no leftover action shells) when oversight is explicitly off and the overseer is inactive", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-201", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The trigger still appears (an explicit per-task override exists so the
    // level control must stay reachable to opt back IN to oversight), but
    // opening it must show ONLY the level select — no nudge/stop/explain
    // leftover shells, mirroring the desktop suite's equivalent assertion.
    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);

    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });

  it("renders NO overflow-menu trigger when there is no per-task override and the workflow tier has not resolved a level yet", async () => {
    const api = await import("../../api");
    // A workflow badge id forces the async workflow-oversight-effective-level
    // lookup path (see `workflowIdForOversight` in TaskDetailModal.tsx) instead
    // of the synchronous `!workflowIdForOversight` fast-resolve, so
    // `workflowOversightResolved` stays false until the fetch below settles.
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "WF-mobile-test",
      workflows: [{ id: "WF-mobile-test", name: "Mobile Test Workflow" } as any],
      taskWorkflowIds: { "FN-212": "WF-mobile-test" },
    });
    vi.mocked(api.fetchWorkflowSettingValues).mockImplementation(() => new Promise(() => {}));

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-212", column: "todo", plannerOversightLevel: undefined })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // Give pending microtasks/effects a chance to flush; the trigger must not
    // appear while the workflow tier is still unresolved and no override exists.
    await waitFor(() => {
      expect(screen.queryByTestId("detail-oversight-menu-trigger")).not.toBeInTheDocument();
    });
  });

  it("opening the menu exposes the level select and honors nudge/stop/explain enablement rules", async () => {
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

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    const select = await screen.findByTestId("detail-oversight-level-select");
    expect((select as HTMLSelectElement).value).toBe("autonomous");

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
    expect(nudgeBtn).toBeDisabled();
  });

  it("stop is absent from the menu when oversight is already off", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-204", column: "in-progress", plannerOversightLevel: "off" })}
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

    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });

  it("selecting a level from the collapsed select writes the override via handleOversightLevelChange", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-205", plannerOversightLevel: "steer" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-205", column: "in-progress", plannerOversightLevel: "observe" })}
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

    const select = await screen.findByTestId("detail-oversight-level-select");
    fireEvent.change(select, { target: { value: "steer" } });

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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);

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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);

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
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);

    const stopBtn = await screen.findByTestId("detail-overseer-stop");
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
      expect(api.stopOverseer).toHaveBeenCalledWith("FN-209", undefined);
    });
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
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

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  /*
  FNXC:PlannerOversight 2026-07-04-00:00:
  FN-7562 regression coverage — the menu-open auto-focus effect used to
  select `.detail-oversight-menu-item` generically, which matched the native
  `<select>` FIRST (it carries that class too) and focused it. Focusing a
  native `<select>` programmatically surfaces its OS option picker, which
  rendered as a second menu overlapping the custom `role="menu"` popover.
  These tests assert the fixed invariant: auto-focus lands on an actionable
  button menuitem (never the select), and only one `role="menu"` surface is
  ever present, across both the active-overseer state and the oversight-off
  (level-only) state.
  */
  it("auto-focuses the first button menuitem (never the native select) when nudge/stop/explain are available", async () => {
    render(
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

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);

    const select = await screen.findByTestId("detail-oversight-level-select");
    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");

    await waitFor(() => {
      expect(document.activeElement).toBe(nudgeBtn);
    });
    expect(document.activeElement).not.toBe(select);

    // Exactly one menu surface renders — the custom popover — and the native
    // select stays a closed control (jsdom/browsers do not spawn a second
    // top-level popup unless the element is actually focused).
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("does not fall back to focusing the native select when oversight is off and only the level control renders", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-214", column: "todo", plannerOversightLevel: "off" })}
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

    const select = await screen.findByTestId("detail-oversight-level-select");
    // No button menuitem exists in this state (nudge/stop/explain are all
    // absent), so the auto-focus effect must not fall back to the select.
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(document.activeElement).not.toBe(select);
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("desktop inline oversight select is unaffected by the mobile auto-focus fix", async () => {
    setViewportWidth(DESKTOP_WIDTH);

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

    // Desktop renders the inline native select directly (no overflow trigger,
    // no custom popover) — confirm that surface is untouched by this fix.
    expect(screen.queryByTestId("detail-oversight-menu-trigger")).not.toBeInTheDocument();
    const select = await screen.findByTestId("detail-oversight-level-select");
    expect(select).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    setViewportWidth(MOBILE_WIDTH);
  });

  it("click-outside closes the menu", async () => {
    render(
      <>
        <TaskDetailModal
          task={makeTask({ id: "FN-211", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />
        <div data-testid="outside-target" />
      </>,
    );

    const trigger = await screen.findByTestId("detail-oversight-menu-trigger");
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside-target"));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});
