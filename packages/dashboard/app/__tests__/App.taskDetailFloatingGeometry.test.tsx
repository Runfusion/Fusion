import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { TASK_DETAIL_FLOATING_GEOMETRY_KEY } from "../App";
import { FloatingWindow } from "../components/FloatingWindow";

function renderTaskDetailPopup(taskId: string) {
  return render(
    <FloatingWindow
      windowKey={`task-detail-${taskId}`}
      title={taskId}
      onClose={() => {}}
      hideHeader
      dragHandleSelector=".task-detail-content--embedded > .modal-header"
      className="floating-window--task-detail"
      persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY}
      layer="task-detail"
    >
      <div className="task-detail-content--embedded">
        <div className="modal-header">{taskId}</div>
        <div>Task detail body</div>
      </div>
    </FloatingWindow>
  );
}

describe("task-detail FloatingWindow geometry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses one stable task-detail persistence key across different task window identities", () => {
    expect(TASK_DETAIL_FLOATING_GEOMETRY_KEY).toBe("floating-window:task-detail");
  });

  it("restores the saved task popup size and position when a different task opens", () => {
    localStorage.setItem(
      TASK_DETAIL_FLOATING_GEOMETRY_KEY,
      JSON.stringify({
        size: { width: 684, height: 512 },
        position: { x: 144, y: 88 },
      }),
    );

    const first = renderTaskDetailPopup("FN-7459-A");
    const firstPanel = screen.getByTestId("floating-window-task-detail-FN-7459-A");
    expect(firstPanel.style.width).toBe("684px");
    expect(firstPanel.style.height).toBe("512px");
    expect(firstPanel.style.left).toBe("144px");
    expect(firstPanel.style.top).toBe("88px");

    first.unmount();
    renderTaskDetailPopup("FN-7459-B");

    const secondPanel = screen.getByTestId("floating-window-task-detail-FN-7459-B");
    expect(secondPanel.style.width).toBe("684px");
    expect(secondPanel.style.height).toBe("512px");
    expect(secondPanel.style.left).toBe("144px");
    expect(secondPanel.style.top).toBe("88px");
    expect(secondPanel).toHaveClass("floating-window--task-detail");
  });

  it("raises multiple task-detail popups within the board layer below utility windows", () => {
    render(
      <>
        <FloatingWindow
          windowKey="task-detail-FN-7493-A"
          title="FN-7493-A"
          onClose={() => {}}
          className="floating-window--task-detail"
          persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY}
          layer="task-detail"
        >
          <div>task a body</div>
        </FloatingWindow>
        <FloatingWindow
          windowKey="task-detail-FN-7493-B"
          title="FN-7493-B"
          onClose={() => {}}
          className="floating-window--task-detail"
          persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY}
          layer="task-detail"
        >
          <div>task b body</div>
        </FloatingWindow>
        <FloatingWindow windowKey="utility-FN-7493" title="Utility" onClose={() => {}}>
          <div>utility body</div>
        </FloatingWindow>
      </>,
    );

    const firstTask = screen.getByTestId("floating-window-task-detail-FN-7493-A");
    const secondTask = screen.getByTestId("floating-window-task-detail-FN-7493-B");
    const utility = screen.getByTestId("floating-window-utility-FN-7493");

    expect(Number(secondTask.style.zIndex)).toBeGreaterThan(Number(firstTask.style.zIndex));
    expect(Number(secondTask.style.zIndex)).toBeLessThan(Number(utility.style.zIndex));
  });

  it("keeps task-detail geometry and layer isolated from non-task FloatingWindow keys", () => {
    localStorage.setItem(
      TASK_DETAIL_FLOATING_GEOMETRY_KEY,
      JSON.stringify({
        size: { width: 650, height: 490 },
        position: { x: 118, y: 76 },
      }),
    );
    localStorage.setItem(
      "floating-window:mission-interview",
      JSON.stringify({
        size: { width: 540, height: 420 },
        position: { x: 210, y: 120 },
      }),
    );

    render(
      <>
        <FloatingWindow
          windowKey="task-detail-FN-7459"
          title="FN-7459"
          onClose={() => {}}
          className="floating-window--task-detail"
          persistGeometryKey={TASK_DETAIL_FLOATING_GEOMETRY_KEY}
          layer="task-detail"
        >
          <div>task detail body</div>
        </FloatingWindow>
        <FloatingWindow
          windowKey="mission"
          title="Mission"
          onClose={() => {}}
          persistGeometryKey="floating-window:mission-interview"
        >
          <div>mission body</div>
        </FloatingWindow>
      </>
    );

    const taskPanel = screen.getByTestId("floating-window-task-detail-FN-7459");
    const taskOverlay = screen.getByTestId("floating-window-overlay-task-detail-FN-7459");
    expect(taskPanel.style.width).toBe("650px");
    expect(taskPanel.style.height).toBe("490px");
    expect(taskPanel.style.left).toBe("118px");
    expect(taskPanel.style.top).toBe("76px");

    const missionPanel = screen.getByTestId("floating-window-mission");
    const missionOverlay = screen.getByTestId("floating-window-overlay-mission");
    expect(Number(taskPanel.style.zIndex)).toBeLessThan(Number(missionPanel.style.zIndex));
    expect(Number(taskOverlay.style.zIndex)).toBeLessThan(Number(missionOverlay.style.zIndex));
    expect(missionPanel.style.width).toBe("540px");
    expect(missionPanel.style.height).toBe("420px");
    expect(missionPanel.style.left).toBe("210px");
    expect(missionPanel.style.top).toBe("120px");
  });
});
