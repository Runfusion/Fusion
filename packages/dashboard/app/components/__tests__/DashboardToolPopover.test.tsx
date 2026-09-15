import { useState } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardToolPopover } from "../DashboardToolPopover";

afterEach(cleanup);

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return { x: 0, y: 0, top: 40, bottom: 60, left: 900, right: 960, width: 60, height: 20, toJSON: () => ({}), ...overrides } as DOMRect;
}

/*
 * FN-426: Activity and Notes moved out of the right dock into header-anchored panels, so this shared shell has to hold
 * the properties that make a panel a usable replacement for a docked tool: it mounts nothing while closed, stays
 * inside the viewport at every width, owns a bounded scroll, and returns focus to its trigger on dismissal.
 */
describe("DashboardToolPopover", () => {
  it("mounts no body while closed", () => {
    const body = vi.fn(() => <div data-testid="panel-body" />);
    render(<DashboardToolPopover open={false} onClose={vi.fn()} anchorRect={rect()} id="p" ariaLabel="Panel">{body()}</DashboardToolPopover>);
    expect(screen.queryByTestId("panel-body")).not.toBeInTheDocument();
  });

  it("anchors under its trigger, bounds its height, and exposes a dialog role", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="activity-panel" testId="tool-popover" ariaLabel="Activity Log"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-label", "Activity Log");
    expect(panel).toHaveAttribute("id", "activity-panel");
    // Right edge aligns with the trigger; top sits just below it; height is bounded by the viewport.
    expect(panel.style.top).toBe("68px");
    expect(panel.style.left).toBe("540px");
    expect(panel.style.maxHeight).toBe("724px");
  });

  it("keeps the panel inside a narrow viewport instead of overflowing it", () => {
    window.innerWidth = 390;
    window.innerHeight = 640;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ right: 380 })} id="p" testId="tool-popover" ariaLabel="Panel" width={520}><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(Number.parseInt(panel.style.width, 10)).toBeLessThanOrEqual(390 - 16);
    expect(Number.parseInt(panel.style.left, 10)).toBeGreaterThanOrEqual(8);
  });

  it("re-anchors when the window is resized", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel"><div /></DashboardToolPopover>);
    const before = screen.getByTestId("tool-popover").style.left;

    act(() => {
      window.innerWidth = 600;
      window.innerHeight = 500;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByTestId("tool-popover").style.left).not.toBe(before);
    expect(Number.parseInt(screen.getByTestId("tool-popover").style.maxHeight, 10)).toBeLessThanOrEqual(500);
  });

  it("closes on Escape and on the dismiss backdrop, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>Open</button>
          <DashboardToolPopover open={open} onClose={() => setOpen(false)} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
            <button type="button" data-testid="inside">Inside</button>
          </DashboardToolPopover>
        </>
      );
    }
    render(<Host />);

    await user.click(screen.getByTestId("trigger"));
    expect(screen.getByTestId("tool-popover")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("tool-popover")).not.toBeInTheDocument();
    expect(screen.getByTestId("trigger")).toHaveFocus();

    await user.click(screen.getByTestId("trigger"));
    await user.click(screen.getByTestId("tool-popover-backdrop"));
    expect(screen.queryByTestId("tool-popover")).not.toBeInTheDocument();
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });

  /*
   * A child that portals itself elsewhere (a native select popup, a nested menu) must stay usable: only a click that
   * actually lands on the dismiss backdrop closes the panel.
   */
  it("keeps a portalled child usable without dismissing the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const clicked = vi.fn();
    render(
      <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
        {createPortal(<button type="button" data-testid="portal-child" onClick={clicked}>Child</button>, document.body)}
      </DashboardToolPopover>,
    );

    await user.click(screen.getByTestId("portal-child"));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
