import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewport = vi.hoisted(() => ({ tabletTouch: false }));

vi.mock("../../hooks/useViewportMode", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/useViewportMode")>("../../hooks/useViewportMode");
  return {
    ...actual,
    useViewportMode: () => viewport.tabletTouch ? "tablet" : "desktop",
    isTabletTouchViewport: () => viewport.tabletTouch,
  };
});

import { FloatingWindow } from "../FloatingWindow";

const directions = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
const floatingWindowCss = readFileSync(resolve(__dirname, "../FloatingWindow.css"), "utf8");

function renderWindow(key = "touch-geometry") {
  return render(
    <FloatingWindow
      windowKey={key}
      title="Tablet window"
      onClose={() => {}}
      defaultSize={{ width: 320, height: 240 }}
      defaultPosition={{ x: 80, y: 90 }}
      minSize={{ width: 240, height: 180 }}
      persistGeometryKey={`fusion:${key}`}
    >
      <div>content</div>
    </FloatingWindow>,
  );
}

describe("FloatingWindow tablet touch geometry", () => {
  beforeEach(() => {
    localStorage.clear();
    viewport.tabletTouch = false;
  });

  afterEach(() => {
    document.body.style.userSelect = "";
  });

  it("adds the shared hit-target contract to the eight handles and drag handle only for tablet touch", () => {
    const { rerender } = renderWindow();
    const panel = screen.getByTestId("floating-window-touch-geometry");
    expect(panel).not.toHaveClass("floating-window--touch-geometry");
    expect(document.querySelectorAll("[data-resize-hit-target='true']")).toHaveLength(0);

    viewport.tabletTouch = true;
    rerender(
      <FloatingWindow windowKey="touch-geometry" title="Tablet window" onClose={() => {}} defaultSize={{ width: 320, height: 240 }} defaultPosition={{ x: 80, y: 90 }} minSize={{ width: 240, height: 180 }}>
        <div>content</div>
      </FloatingWindow>,
    );

    expect(screen.getByTestId("floating-window-touch-geometry")).toHaveClass("floating-window--touch-geometry");
    for (const direction of directions) {
      expect(screen.getByTestId(`floating-window-resize-${direction}`)).toHaveAttribute("data-resize-hit-target", "true");
    }
    expect(screen.getByTestId("floating-window-drag-handle-touch-geometry")).toHaveAttribute("data-resize-hit-target", "true");
  });

  it("keeps generic delegated headers at the shared 44px layout target while task detail uses an out-of-flow target", () => {
    const genericRule = floatingWindowCss.match(/\.floating-window--touch-geometry \.floating-window__delegated-drag-handle\s*\{[^}]*\}/s)?.[0] ?? "";
    const taskRule = floatingWindowCss.match(/\.floating-window--task-detail\.floating-window--touch-geometry \.floating-window__delegated-drag-handle\s*\{[^}]*\}/s)?.[0] ?? "";
    const taskTargetRule = floatingWindowCss.match(/\.floating-window--task-detail\.floating-window--touch-geometry \.floating-window__delegated-drag-handle::before\s*\{[^}]*\}/s)?.[0] ?? "";

    expect(genericRule).toContain("min-block-size: var(--modal-resize-touch-target);");
    expect(taskRule).toContain("min-block-size: 0;");
    expect(taskTargetRule).toContain("block-size: var(--modal-resize-touch-target);");
    expect(taskTargetRule).toContain("position: absolute;");
  });

  it("applies the touch contract and drag gesture to a headerless delegated handle", () => {
    viewport.tabletTouch = true;
    render(
      <FloatingWindow
        windowKey="delegated-touch"
        title="Headerless window"
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".delegated-drag-handle"
        defaultSize={{ width: 320, height: 240 }}
        defaultPosition={{ x: 80, y: 90 }}
      >
        <div className="delegated-drag-handle">Task detail header</div>
      </FloatingWindow>,
    );

    const panel = screen.getByTestId("floating-window-delegated-touch");
    const handle = screen.getByText("Task detail header");
    Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(handle, "releasePointerCapture", { configurable: true, value: vi.fn() });

    expect(handle).toHaveAttribute("data-resize-hit-target", "true");
    expect(handle).toHaveClass("floating-window__delegated-drag-handle");
    fireEvent.pointerDown(handle, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerType: "touch", pointerId: 1, clientX: 132, clientY: 124 });
    fireEvent.pointerUp(handle, { pointerType: "touch", pointerId: 1, clientX: 132, clientY: 124 });

    expect(panel.style.left).toBe("112px");
    expect(panel.style.top).toBe("114px");
  });

  it("filters another finger and commits a captured touch resize with clamped geometry", () => {
    viewport.tabletTouch = true;
    renderWindow("resize");
    const panel = screen.getByTestId("floating-window-resize");
    const handle = screen.getByTestId("floating-window-resize-se");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: setPointerCapture });
    Object.defineProperty(handle, "releasePointerCapture", { configurable: true, value: releasePointerCapture });

    fireEvent.pointerDown(handle, { pointerType: "touch", pointerId: 1, clientX: 400, clientY: 330 });
    fireEvent.pointerMove(handle, { pointerType: "touch", pointerId: 2, clientX: 650, clientY: 600 });
    expect(panel.style.width).toBe("320px");
    fireEvent.pointerMove(handle, { pointerType: "touch", pointerId: 1, clientX: 440, clientY: 370 });
    fireEvent.pointerUp(handle, { pointerType: "touch", pointerId: 1, clientX: 440, clientY: 370 });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(panel.style.width).toBe("360px");
    expect(panel.style.height).toBe("280px");
    expect(JSON.parse(localStorage.getItem("fusion:resize") ?? "{}")).toMatchObject({ size: { width: 360, height: 280 } });
  });

  it("tears down a cancelled touch drag without retaining selection suppression", () => {
    viewport.tabletTouch = true;
    const { unmount } = renderWindow("cancel");
    const header = screen.getByTestId("floating-window-drag-handle-cancel");
    Object.defineProperty(header, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(header, "releasePointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(header, { pointerType: "touch", pointerId: 1, clientX: 120, clientY: 120 });
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.pointerCancel(header, { pointerType: "touch", pointerId: 1, clientX: 120, clientY: 120 });
    expect(document.body.style.userSelect).toBe("");

    fireEvent.pointerDown(header, { pointerType: "touch", pointerId: 2, clientX: 120, clientY: 120 });
    expect(document.body.style.userSelect).toBe("none");
    unmount();
    expect(document.body.style.userSelect).toBe("");
  });
});
