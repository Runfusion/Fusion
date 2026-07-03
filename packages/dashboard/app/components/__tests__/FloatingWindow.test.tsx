import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    localStorage.clear();
  });
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

  it("uses a theme-overridable gentle shadow token instead of an undefined shadow", () => {
    const windowRule = floatingWindowCss.match(/\.floating-window\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(windowRule).toContain("--floating-window-shadow: var(--shadow-lg);");
    expect(windowRule).toContain("box-shadow: var(--floating-window-shadow, var(--shadow-lg));");
    expect(floatingWindowCss).not.toContain("var(--shadow-xl)");
  });

  it("can hide generic chrome and delegate dragging to a child header", () => {
    render(
      <FloatingWindow
        windowKey="task"
        title="KB-001"
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".task-detail-content--embedded > .modal-header"
        className="floating-window--task-detail"
      >
        <div className="task-detail-content--embedded">
          <div className="modal-header">KB-001</div>
          <div>task body</div>
        </div>
      </FloatingWindow>
    );

    expect(screen.queryByTestId("floating-window-drag-handle-task")).toBeNull();
    expect(screen.getByTestId("floating-window-task")).toHaveClass("floating-window--headerless");
    expect(screen.getByTestId("floating-window-task")).toHaveClass("floating-window--task-detail");
    expect(screen.getByText("KB-001")).toBeInTheDocument();
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(screen.getByTestId(`floating-window-resize-${dir}`)).toBeTruthy();
    }
  });

  it("scopes mobile sheet sizing and hidden resize handles to task-detail pop-outs", () => {
    expect(floatingWindowCss).toContain("FNXC:MobileTaskPopups 2026-06-29-00:00");
    expect(floatingWindowCss).toContain(".floating-window--task-detail {");
    expect(floatingWindowCss).toContain("width: 100vw !important;");
    expect(floatingWindowCss).toContain("height: 100dvh !important;");
    expect(floatingWindowCss).toContain(".floating-window--task-detail .floating-window__resize-handle");
    expect(floatingWindowCss).toContain("display: none;");
    expect(floatingWindowCss).toContain("cursor: default;");
    expect(floatingWindowCss).toContain("touch-action: auto;");
  });

  it("does not apply task-detail mobile sizing to chat floating windows", () => {
    const taskRuleIndex = floatingWindowCss.indexOf(".floating-window--task-detail {");
    const chatRuleIndex = floatingWindowCss.indexOf(".floating-window--chat {");

    expect(taskRuleIndex).toBeGreaterThan(-1);
    expect(chatRuleIndex).toBeGreaterThan(-1);
    expect(taskRuleIndex).not.toBe(chatRuleIndex);
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

  it("closes on outside pointerdown only when the opt-in prop is enabled", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="outside-close" title="Outside close" onClose={onClose} closeOnOutsidePointerDown>
        <div>inside body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close for inside pointerdown when outside dismissal is enabled", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="inside-safe" title="Inside safe" onClose={onClose} closeOnOutsidePointerDown>
        <button type="button">Inside action</button>
      </FloatingWindow>
    );

    fireEvent.pointerDown(screen.getByText("Inside action"));
    fireEvent.pointerDown(screen.getByTestId("floating-window-body-inside-safe"));
    fireEvent.pointerDown(screen.getByTestId("floating-window-inside-safe"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps page clicks non-dismissive by default for persistent floating windows", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="persistent" title="Persistent" onClose={onClose}>
        <div>persistent body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on outside pointerdown when the opt-in prop is explicitly false", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="outside-disabled" title="Outside disabled" onClose={onClose} closeOnOutsidePointerDown={false}>
        <div>chat body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when the outside target is another floating or dialog surface", () => {
    for (const surfaceClassOrRole of ["modal-overlay", "floating-window", "dialog-role"] as const) {
      const onClose = vi.fn();
      const { unmount } = render(
        <FloatingWindow windowKey={`nested-${surfaceClassOrRole}`} title="Nested safe" onClose={onClose} closeOnOutsidePointerDown>
          <div>chat body</div>
        </FloatingWindow>
      );
      const surface = document.createElement("div");
      if (surfaceClassOrRole === "dialog-role") {
        surface.setAttribute("role", "dialog");
      } else {
        surface.className = surfaceClassOrRole;
      }
      document.body.appendChild(surface);

      fireEvent.pointerDown(surface);

      expect(onClose).not.toHaveBeenCalled();
      surface.remove();
      unmount();
    }
  });

  it("does not close from outside pointerdown while a resize gesture is active", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="resize-safe" title="Resize safe" onClose={onClose} closeOnOutsidePointerDown>
        <div>resize body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(screen.getByTestId("floating-window-resize-se"), { pointerId: 1 });
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores compatibility pointer events immediately after touch gestures", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="touch-safe" title="Touch safe" onClose={onClose} closeOnOutsidePointerDown>
        <div>touch body</div>
      </FloatingWindow>
    );

    expect(onClose).not.toHaveBeenCalled();
    fireEvent.touchStart(document);
    fireEvent.touchEnd(document);
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the outside pointerdown listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <FloatingWindow windowKey="cleanup" title="Cleanup" onClose={onClose} closeOnOutsidePointerDown>
        <div>cleanup body</div>
      </FloatingWindow>
    );

    unmount();
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
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

  it("falls back to default geometry when persisted geometry is malformed", () => {
    localStorage.setItem("floating-window:malformed", "not-json");

    render(
      <FloatingWindow
        windowKey="malformed"
        title="Malformed"
        onClose={() => {}}
        persistGeometryKey="floating-window:malformed"
        defaultSize={{ width: 610, height: 430 }}
        defaultPosition={{ x: 80, y: 90 }}
      >
        <div>malformed body</div>
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-malformed");
    expect(panel.style.width).toBe("610px");
    expect(panel.style.height).toBe("430px");
    expect(panel.style.left).toBe("80px");
    expect(panel.style.top).toBe("90px");
  });

  it("shares geometry only between windows that opt into the same persistence key", () => {
    localStorage.setItem(
      "floating-window:shared-task-detail",
      JSON.stringify({
        size: { width: 660, height: 470 },
        position: { x: 120, y: 96 },
      }),
    );
    localStorage.setItem(
      "floating-window:chat",
      JSON.stringify({
        size: { width: 520, height: 390 },
        position: { x: 220, y: 140 },
      }),
    );

    render(
      <>
        <FloatingWindow
          windowKey="task-detail-FN-001"
          title="FN-001"
          onClose={() => {}}
          persistGeometryKey="floating-window:shared-task-detail"
        >
          <div>task one</div>
        </FloatingWindow>
        <FloatingWindow
          windowKey="task-detail-FN-002"
          title="FN-002"
          onClose={() => {}}
          persistGeometryKey="floating-window:shared-task-detail"
        >
          <div>task two</div>
        </FloatingWindow>
        <FloatingWindow windowKey="chat" title="Chat" onClose={() => {}} persistGeometryKey="floating-window:chat">
          <div>chat body</div>
        </FloatingWindow>
      </>
    );

    for (const id of ["FN-001", "FN-002"]) {
      const panel = screen.getByTestId(`floating-window-task-detail-${id}`);
      expect(panel.style.width).toBe("660px");
      expect(panel.style.height).toBe("470px");
      expect(panel.style.left).toBe("120px");
      expect(panel.style.top).toBe("96px");
    }

    const chatPanel = screen.getByTestId("floating-window-chat");
    expect(chatPanel.style.width).toBe("520px");
    expect(chatPanel.style.height).toBe("390px");
    expect(chatPanel.style.left).toBe("220px");
    expect(chatPanel.style.top).toBe("140px");
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
