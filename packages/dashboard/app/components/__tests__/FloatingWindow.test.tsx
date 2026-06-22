import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FloatingWindow } from "../FloatingWindow";

const floatingWindowCss = readFileSync("app/components/FloatingWindow.css", "utf8");

/*
FNXC:FloatingWindow 2026-06-22-20:45:
Contract tests for the reusable non-blocking floating window:
- the overlay is click-through (pointer-events:none) so the page and other windows behind it stay interactive,
- the panel re-enables pointer events and carries a header drag handle + resize handles,
- focus-to-front raises this window's z-index above any previously-opened window,
- close removes the window (onClose fires).
JSDOM has no real layout/pointer-capture, so drag math is asserted in the RightDockExpandModal pattern's own suite; here we assert the structural + stacking contract that makes multiple coexisting windows non-blocking.
*/

describe("FloatingWindow", () => {
  it("renders a non-blocking, click-through transparent overlay with a pointer-events:auto panel", () => {
    render(
      <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}}>
        <div>alpha body</div>
      </FloatingWindow>
    );
    const overlay = screen.getByTestId("floating-window-overlay-alpha");
    // styles.css is not loaded here, so assert via the class contract the CSS attaches pointer-events:none to.
    expect(overlay.className).toContain("floating-window-overlay");
    const panel = screen.getByTestId("floating-window-alpha");
    expect(panel.className).toContain("floating-window");
    // Panel is positioned/stacked via inline style.
    expect(panel.style.position === "" || panel.style.left).toBeDefined();
    expect(panel.style.zIndex).not.toBe("");
  });

  it("exposes a header drag handle and resize handles", () => {
    render(
      <FloatingWindow windowKey="beta" title="Beta" onClose={() => {}}>
        <div>beta body</div>
      </FloatingWindow>
    );
    expect(screen.getByTestId("floating-window-drag-handle-beta")).toBeTruthy();
    // 8 edge/corner resize handles.
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(screen.getByTestId(`floating-window-resize-${dir}`)).toBeTruthy();
    }
  });

  it("can hide generic chrome and delegate dragging to a child header", () => {
    render(
      <FloatingWindow
        windowKey="task"
        title="KB-001"
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".task-detail-content--embedded > .modal-header"
      >
        <div className="task-detail-content--embedded">
          <div className="modal-header">KB-001</div>
          <div>task body</div>
        </div>
      </FloatingWindow>
    );

    expect(screen.queryByTestId("floating-window-drag-handle-task")).toBeNull();
    expect(screen.getByTestId("floating-window-task")).toHaveClass("floating-window--headerless");
    expect(screen.getByText("KB-001")).toBeInTheDocument();
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(screen.getByTestId(`floating-window-resize-${dir}`)).toBeTruthy();
    }
  });

  it("focus-to-front: interacting with an older window raises its z-index above the newest", () => {
    render(
      <>
        <FloatingWindow windowKey="first" title="First" onClose={() => {}}>
          <div>first</div>
        </FloatingWindow>
        <FloatingWindow windowKey="second" title="Second" onClose={() => {}}>
          <div>second</div>
        </FloatingWindow>
      </>
    );
    const first = screen.getByTestId("floating-window-first");
    const second = screen.getByTestId("floating-window-second");
    // Second mounted last → starts on top.
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex));
    // Clicking the first panel raises it above the second.
    fireEvent.pointerDown(first);
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex));
  });

  it("close button removes the window via onClose", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="gamma" title="Gamma" onClose={onClose}>
        <div>gamma body</div>
      </FloatingWindow>
    );
    fireEvent.click(screen.getByTestId("floating-window-close-gamma"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("multiple windows coexist independently (each renders its own panel)", () => {
    render(
      <>
        <FloatingWindow windowKey="w1" title="W1" onClose={() => {}}>
          <div>one</div>
        </FloatingWindow>
        <FloatingWindow windowKey="w2" title="W2" onClose={() => {}}>
          <div>two</div>
        </FloatingWindow>
        <FloatingWindow windowKey="w3" title="W3" onClose={() => {}}>
          <div>three</div>
        </FloatingWindow>
      </>
    );
    expect(screen.getByTestId("floating-window-w1")).toBeTruthy();
    expect(screen.getByTestId("floating-window-w2")).toBeTruthy();
    expect(screen.getByTestId("floating-window-w3")).toBeTruthy();
  });

  it("restores persisted geometry and clamps it on screen", () => {
    localStorage.setItem(
      "floating-window:test",
      JSON.stringify({
        size: { width: 700, height: 500 },
        position: { x: 9999, y: -200 },
      }),
    );

    render(
      <FloatingWindow
        windowKey="persisted"
        title="Persisted"
        onClose={() => {}}
        persistGeometryKey="floating-window:test"
        minSize={{ width: 360, height: 280 }}
      >
        <div>persisted body</div>
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-persisted");
    expect(panel.style.width).toBe("700px");
    expect(panel.style.height).toBe("500px");
    expect(panel.style.top).toBe("16px");
    expect(Number.parseFloat(panel.style.left)).toBeLessThan(window.innerWidth);
  });

  it("makes only the mobile chat floating window full-screen", () => {
    const mobileBlock = floatingWindowCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.floating-window--chat \.chat-view\s*\{[\s\S]*?\n\}/)?.[0];

    expect(mobileBlock).toContain(".floating-window--chat");
    expect(mobileBlock).toContain("width: 100vw !important;");
    expect(mobileBlock).toContain("height: 100dvh !important;");
    expect(mobileBlock).toContain(".floating-window--chat .floating-window__resize-handle");
    expect(floatingWindowCss).not.toMatch(/@media\s*\(min-width:\s*769px\)[\s\S]*\.floating-window--chat[\s\S]*100dvh/);
  });
});
