import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FloatingWindow } from "../FloatingWindow";
import { RightDockExpandModal } from "../RightDockExpandModal";
import { nextFloatingZ, currentFloatingZ } from "../floatingWindowStack";

/*
FNXC:FloatingWindow 2026-06-22-21:30:
Cross-type shared-stack contract. Every floating modal type (FloatingWindow, the right-dock pop-out, the floating terminal, the floating New Task dialog) must draw its z-index from the SINGLE module-level `floatingWindowStack` counter so tapping ANY of them raises it above ALL the others REGARDLESS of type. Before this, each type owned a private counter and tapping the terminal could not raise it above a popped-out FloatingWindow. This suite proves two different component types interleave in one monotonic stack and that tapping the older one raises it above the newer one across the type boundary. RightDockExpandModal stands in for the three non-FloatingWindow floating modals (terminal + New Task wire the identical claim-on-mount + bring-to-front-on-pointerdown pattern; they are heavier to mount in JSDOM and assert the same inline-zIndex contract).
*/

const renderProps = { addToast: () => {}, projectId: "project-1" } as const;

describe("floatingWindowStack (cross-type)", () => {
  it("hands out a strictly increasing, shared z to every claimant", () => {
    const a = nextFloatingZ();
    const b = nextFloatingZ();
    expect(b).toBeGreaterThan(a);
    expect(currentFloatingZ()).toBe(b);
  });

  it("tapping a FloatingWindow raises it above a right-dock pop-out opened after it (and vice versa)", () => {
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
});
