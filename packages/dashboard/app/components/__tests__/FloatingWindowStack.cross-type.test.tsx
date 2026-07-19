import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FloatingWindow } from "../FloatingWindow";
import { RightDockExpandModal } from "../RightDockExpandModal";
import { currentFloatingZ, currentTaskDetailFloatingZ, nextFloatingZ, nextTaskDetailFloatingZ } from "../floatingWindowStack";

/*
FNXC:FloatingWindow 2026-06-22-21:30:
Cross-type shared-stack contract. Utility floating modal types (utility FloatingWindow, the right-dock pop-out, the floating terminal, the floating New Task dialog) draw their z-index from the SINGLE module-level utility counter so tapping ANY utility raises it above ALL other utilities REGARDLESS of type. RightDockExpandModal stands in for the three non-FloatingWindow floating modals (terminal + New Task wire the identical claim-on-mount + bring-to-front-on-pointerdown pattern; they are heavier to mount in JSDOM and assert the same inline-zIndex contract).

FNXC:TaskPopupLayer 2026-07-17-15:55:
Quick Chat opts into the task-detail counter so task popups and Chat interleave by interaction.
Unrelated utility windows remain excluded and keep their independent, higher utility stack.
*/

const renderProps = { addToast: () => {}, projectId: "project-1" } as const;

describe("floatingWindowStack (cross-type)", () => {
  it("hands out strictly increasing z values for separate utility and task-detail bands", () => {
    const utilityA = nextFloatingZ();
    const utilityB = nextFloatingZ();
    const taskA = nextTaskDetailFloatingZ();
    const taskB = nextTaskDetailFloatingZ();

    expect(utilityB).toBeGreaterThan(utilityA);
    expect(currentFloatingZ()).toBe(utilityB);
    expect(taskB).toBeGreaterThan(taskA);
    expect(currentTaskDetailFloatingZ()).toBe(taskB);
    expect(utilityA).toBeGreaterThan(taskB);
  });

  it("tapping a utility FloatingWindow raises it above a right-dock pop-out opened after it (and vice versa)", () => {
    render(
      <>
        <FloatingWindow windowKey="fw" title="FW" onClose={() => {}}>
          <div>fw body</div>
        </FloatingWindow>
        <RightDockExpandModal viewKey="files" renderProps={renderProps} onClose={() => {}} />
      </>,
    );

    const fwPanel = screen.getByTestId("floating-window-fw");
    const dockPanel = screen
      .getByTestId("right-dock-expand-modal")
      .querySelector(".right-dock-expand-modal--floating") as HTMLElement;

    // Both carry an inline z-index from the shared stack.
    expect(fwPanel.style.zIndex).not.toBe("");
    expect(dockPanel.style.zIndex).not.toBe("");

    // The dock pop-out mounted last → it starts on top of the FloatingWindow, proving one shared stack.
    expect(Number(dockPanel.style.zIndex)).toBeGreaterThan(Number(fwPanel.style.zIndex));

    // Tapping the older FloatingWindow raises it above the dock pop-out — across the type boundary.
    fireEvent.pointerDown(fwPanel);
    expect(Number(fwPanel.style.zIndex)).toBeGreaterThan(Number(dockPanel.style.zIndex));

    // Tapping the dock pop-out raises it back above the FloatingWindow.
    fireEvent.pointerDown(dockPanel);
    expect(Number(dockPanel.style.zIndex)).toBeGreaterThan(Number(fwPanel.style.zIndex));
  });

  it("interleaves Quick Chat with one or multiple task popups while utility windows stay higher", () => {
    render(
      <>
        <FloatingWindow windowKey="chat-modal" title="Chat" onClose={() => {}} layer="task-detail" className="floating-window--chat">
          <div>chat body</div>
        </FloatingWindow>
        <FloatingWindow windowKey="task-a" title="Task A" onClose={() => {}} layer="task-detail" className="floating-window--task-detail">
          <div>task a body</div>
        </FloatingWindow>
        <FloatingWindow windowKey="task-b" title="Task B" onClose={() => {}} layer="task-detail" className="floating-window--task-detail">
          <div>task b body</div>
        </FloatingWindow>
        <RightDockExpandModal viewKey="files" renderProps={renderProps} onClose={() => {}} />
      </>,
    );

    const chatPanel = screen.getByTestId("floating-window-chat-modal");
    const taskA = screen.getByTestId("floating-window-task-a");
    const taskB = screen.getByTestId("floating-window-task-b");
    const dockPanel = screen
      .getByTestId("right-dock-expand-modal")
      .querySelector(".right-dock-expand-modal--floating") as HTMLElement;

    // Later task mounts above Chat; utility surfaces still retain their higher independent band.
    expect(Number(taskB.style.zIndex)).toBeGreaterThan(Number(chatPanel.style.zIndex));
    expect(Number(dockPanel.style.zIndex)).toBeGreaterThan(Number(taskB.style.zIndex));

    // Task and Chat both claim the same peer counter in either interaction direction.
    fireEvent.pointerDown(chatPanel);
    expect(Number(chatPanel.style.zIndex)).toBeGreaterThan(Number(taskB.style.zIndex));
    fireEvent.focus(taskA);
    expect(Number(taskA.style.zIndex)).toBeGreaterThan(Number(chatPanel.style.zIndex));
    fireEvent.focus(chatPanel);
    expect(Number(chatPanel.style.zIndex)).toBeGreaterThan(Number(taskA.style.zIndex));
    expect(Number(chatPanel.style.zIndex)).toBeLessThan(Number(dockPanel.style.zIndex));
  });
});
