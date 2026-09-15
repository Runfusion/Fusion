import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { DashboardWindowManagerProvider } from "../context/DashboardWindowManagerContext";
import { FLOATING_WINDOW_STANDARD_HEIGHT_RATIO, FloatingWindow } from "../components/FloatingWindow";

/*
FNXC:TaskWindowIdentity 2026-09-14-21:10:
FN-394 deleted the shared `floating-window:task-detail` geometry key together with every durable window
rectangle. Two task windows no longer inherit one another's size or place, a reopened task restarts at
the standard task size, and task windows now share ONE stack with every other window type instead of
sitting in a permanently lower band.

FNXC:TaskWindowIdentity 2026-09-15-13:41:
FN-418 caps the standard OPENING height at a proportion of the live work area, so the expected height is
derived from that contract instead of the host's declared 620px literal. The identity invariant is unchanged:
two task windows still open at the same standard rectangle and the legacy record is still ignored.
*/

const LEGACY_TASK_DETAIL_GEOMETRY_KEY = "floating-window:task-detail";
const TASK_DEFAULT_HEIGHT = 620;

/** Opening height under the FN-418 proportional cap. No landmarks here, so the work area is the viewport. */
function openingHeight(): number {
  return Math.min(TASK_DEFAULT_HEIGHT, Math.round(window.innerHeight * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO));
}

function taskWindow(taskId: string) {
  return (
    <FloatingWindow
      windowKey={`task-detail-${taskId}`}
      title={taskId}
      onClose={() => {}}
      hideHeader
      dragHandleSelector=".task-detail-content--embedded > .modal-header"
      className="floating-window--task-detail"
      defaultSize={{ width: 820, height: TASK_DEFAULT_HEIGHT }}
      layer="task-detail"
    >
      <div className="task-detail-content--embedded">
        <div className="modal-header">{taskId}</div>
        <div>Task detail body</div>
      </div>
    </FloatingWindow>
  );
}

function renderTaskDetailPopup(taskId: string) {
  return render(
    <DashboardWindowManagerProvider>
      {taskWindow(taskId)}
    </DashboardWindowManagerProvider>,
  );
}

describe("task-detail FloatingWindow geometry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens each task window at the standard task size, ignoring the legacy shared record", () => {
    const legacy = JSON.stringify({ size: { width: 684, height: 512 }, position: { x: 144, y: 88 } });
    localStorage.setItem(LEGACY_TASK_DETAIL_GEOMETRY_KEY, legacy);

    const first = renderTaskDetailPopup("FN-7459-A");
    const firstPanel = screen.getByTestId("floating-window-task-detail-FN-7459-A");
    expect(firstPanel.style.width).toBe("820px");
    expect(firstPanel.style.height).toBe(`${openingHeight()}px`);

    first.unmount();
    renderTaskDetailPopup("FN-7459-B");

    const secondPanel = screen.getByTestId("floating-window-task-detail-FN-7459-B");
    expect(secondPanel.style.width).toBe("820px");
    expect(secondPanel.style.height).toBe(`${openingHeight()}px`);
    expect(secondPanel).toHaveClass("floating-window--task-detail");
    // The legacy record is neither used nor rewritten; FN-394 performs no purge.
    expect(localStorage.getItem(LEGACY_TASK_DETAIL_GEOMETRY_KEY)).toBe(legacy);
  });

  it("puts the most recently opened window on top whether it is a task window or a utility window", () => {
    render(
      <DashboardWindowManagerProvider>
        {taskWindow("FN-7493-A")}
        {taskWindow("FN-7493-B")}
        <FloatingWindow windowKey="utility-FN-7493" title="Utility" onClose={() => {}}>
          <div>utility body</div>
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    const firstTask = screen.getByTestId("floating-window-task-detail-FN-7493-A");
    const secondTask = screen.getByTestId("floating-window-task-detail-FN-7493-B");
    const utility = screen.getByTestId("floating-window-utility-FN-7493");

    expect(Number(secondTask.style.zIndex)).toBeGreaterThan(Number(firstTask.style.zIndex));
    expect(Number(utility.style.zIndex)).toBeGreaterThan(Number(secondTask.style.zIndex));
  });

  it("keeps two simultaneous task windows independent of each other and of other window types", () => {
    localStorage.setItem(LEGACY_TASK_DETAIL_GEOMETRY_KEY, JSON.stringify({ size: { width: 650, height: 490 }, position: { x: 118, y: 76 } }));
    localStorage.setItem("floating-window:sample-secondary", JSON.stringify({ size: { width: 540, height: 420 }, position: { x: 210, y: 120 } }));

    render(
      <DashboardWindowManagerProvider>
        {taskWindow("FN-7459")}
        <FloatingWindow windowKey="mission" title="Mission" onClose={() => {}} defaultSize={{ width: 700, height: 520 }}>
          <div>mission body</div>
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    const taskPanel = screen.getByTestId("floating-window-task-detail-FN-7459");
    const missionPanel = screen.getByTestId("floating-window-mission");
    expect(taskPanel.style.width).toBe("820px");
    expect(missionPanel.style.width).toBe("700px");
    // Each window owns its own placement inside the shared pristine cohort.
    expect(missionPanel.style.left).not.toBe(taskPanel.style.left);
    expect(Number(missionPanel.style.zIndex)).toBeGreaterThan(Number(taskPanel.style.zIndex));
  });
});
