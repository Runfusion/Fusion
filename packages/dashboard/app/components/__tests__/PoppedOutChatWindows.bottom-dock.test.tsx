import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  DashboardWindowManagerProvider,
  useDashboardWindowBottomDockReservation,
  useDashboardWindowLandmark,
} from "../../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../FloatingWindow";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

/*
FNXC:ChatWindows 2026-09-16-18:31:
FN-469 acceptance for "je devrais aussi avoir cette possibilité d'ancrage en bas pour les chats". A detached
conversation gains the bottom band purely from the SHARED window contract — no chat-owned panel, no extra prop — so
these regressions drive real pointer gestures on the real `PoppedOutChatWindows` host and assert the applied
rectangle, the retained mode, and the release.

FNXC:FloatingWindowSnap 2026-09-17-04:51:
FN-487 symptom acceptance: the original defect is that this exact gesture left `.dashboard-project-stack` with the same
usable height as before, so the band covered the lower half of the board. The docked band must now reserve
`window.innerHeight - rect.top` while docked and release it on undock. The terminal is the negative control: it swaps
its floating window for its own in-flow `below` host, so it must leave no residual reservation behind.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;

vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession }: { initialDirectSession: { id: string } }) => (
    <div className="chat-view chat-view--floating"><div className="view-header">{initialDirectSession.id}</div></div>
  ),
}));

function domRect(value: { left: number; top: number; right: number; bottom: number; width: number; height: number }): DOMRect {
  return { ...value, x: value.left, y: value.top, toJSON: () => ({}) } as DOMRect;
}

/** Stands in for `.dashboard-project-stack`: it renders exactly the height the shell would reserve. */
function Stack() {
  const reserved = useDashboardWindowBottomDockReservation();
  return <output data-testid="reservation">{reserved}</output>;
}

function reservation(): number {
  return Number(screen.getByTestId("reservation").textContent);
}

function Landmarks() {
  const headerRef = useDashboardWindowLandmark("header");
  const footerRef = useDashboardWindowLandmark("footer");
  return (
    <>
      <header ref={headerRef} data-landmark="header" />
      <footer ref={footerRef} data-landmark="footer" />
    </>
  );
}

const entry = {
  projectId: "project-a",
  session: {
    id: "session-1",
    agentId: "agent-1",
    title: "Session one",
    status: "active" as const,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  },
  focusNonce: 1,
};

function rectOf(panel: HTMLElement) {
  return {
    left: Number.parseFloat(panel.style.left),
    top: Number.parseFloat(panel.style.top),
    width: Number.parseFloat(panel.style.width),
    height: Number.parseFloat(panel.style.height),
  };
}

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function renderChatWindow() {
  const view = render(
    <DashboardWindowManagerProvider>
      <Landmarks />
      <Stack />
      <PoppedOutChatWindows
        entries={[entry]}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />
    </DashboardWindowManagerProvider>,
  );
  const panel = screen.getByTestId("floating-window-chat-window-project-a-session-1");
  return { ...view, panel };
}

/** The chat window is headerless and delegates dragging to its own view header. */
function handleOf(panel: HTMLElement) {
  return panel.querySelector(".chat-view--floating .view-header") as HTMLElement;
}

function drag(panel: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, pointerId: number, options?: { hold?: boolean }) {
  const handle = handleOf(panel);
  prepareCapture(panel);
  fireEvent.pointerDown(handle, { pointerId, pointerType: "mouse", button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(handle, { pointerId, pointerType: "mouse", clientX: to.x, clientY: to.y });
  if (options?.hold) return;
  fireEvent.pointerUp(handle, { pointerId, pointerType: "mouse", clientX: to.x, clientY: to.y });
}

describe("detached conversation bottom dock", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT, width: window.innerWidth, height: HEADER_HEIGHT });
      if (name === "footer") return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: FOOTER_HEIGHT });
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /* (q) Dragging the conversation onto the bottom wall previews then applies the full-width band. */
  it("previews and applies the shared bottom band when dragged onto the bottom wall", async () => {
    const { panel } = renderChatWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));

    // Travel well past the wall: the position clamp pins the panel's bottom edge exactly onto it.
    drag(panel, { x: 600, y: 300 }, { x: 600, y: 300 + window.innerHeight }, 41, { hold: true });
    expect(screen.getByTestId("floating-window-snap-preview-chat-window-project-a-session-1").dataset.snapZone).toBe("bottom");

    fireEvent.pointerUp(handleOf(panel), { pointerId: 41, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });

    const workAreaHeight = window.innerHeight - HEADER_HEIGHT - FOOTER_HEIGHT;
    expect(panel.dataset.snapMode).toBe("bottom");
    expect(panel).toHaveClass("floating-window--snapped");
    expect(panel).toHaveClass("floating-window--snap-bottom");
    expect(rectOf(panel)).toEqual({
      left: 0,
      top: HEADER_HEIGHT + workAreaHeight / 2,
      width: window.innerWidth,
      height: workAreaHeight / 2,
    });
  });

  /*
  (g) FN-487 symptom acceptance on the production host: while docked, the shell reserves the band's full height —
  the board columns therefore recompose above it instead of being covered — and the space returns on undock.
  */
  it("reserves the band's height in the shell while docked and releases it on undock", async () => {
    const { panel } = renderChatWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));
    expect(reservation()).toBe(0);

    drag(panel, { x: 600, y: 300 }, { x: 600, y: 300 + window.innerHeight }, 45);
    expect(panel.dataset.snapMode).toBe("bottom");
    expect(reservation()).toBe(window.innerHeight - rectOf(panel).top);

    drag(panel, { x: 600, y: 600 }, { x: 700, y: 360 }, 46);
    expect(panel.dataset.snapMode).toBe("floating");
    expect(reservation()).toBe(0);
  });

  /*
  (m) Negative control for the terminal: it converts the bottom gesture into its own in-flow `below` presentation and
  drops its floating window, so `.terminal-below-host` stays the only consumer and no residual band is published.
  */
  it("leaves no residual reservation when a window swaps its dock for an in-flow presentation", async () => {
    function TerminalLikeHost() {
      const [pinnedBelow, setPinnedBelow] = useState(false);
      if (pinnedBelow) return <div data-testid="terminal-below-host">below</div>;
      return (
        <FloatingWindow
          windowKey="terminal-like"
          title="Terminal"
          onClose={() => {}}
          defaultSize={{ width: 600, height: 400 }}
          minSize={{ width: 320, height: 200 }}
          onDragGestureEnd={(info) => { if (info.snapMode === "bottom") setPinnedBelow(true); }}
        >
          body
        </FloatingWindow>
      );
    }

    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <Stack />
        <TerminalLikeHost />
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-terminal-like");
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));

    const handle = screen.getByTestId("floating-window-drag-handle-terminal-like");
    prepareCapture(handle);
    fireEvent.pointerDown(handle, { pointerId: 47, pointerType: "mouse", button: 0, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 47, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });
    fireEvent.pointerUp(handle, { pointerId: 47, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });

    expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-window-terminal-like")).not.toBeInTheDocument();
    expect(reservation()).toBe(0);
  });

  /*
  (r) Release: a drag past the click threshold in ANY direction frees the window, restores the rectangle it had
  before the FIRST dock (bottom → left → release must not restore the column), and re-anchors it under the pointer.
  */
  it("releases the bottom band in any direction and restores the pre-dock rectangle", async () => {
    const { panel } = renderChatWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));
    const floating = rectOf(panel);

    drag(panel, { x: 600, y: 300 }, { x: 600, y: 300 + window.innerHeight }, 42);
    expect(panel.dataset.snapMode).toBe("bottom");

    /*
    FNXC:FloatingWindowSnap 2026-09-17-07:21:
    FN-493 keeps this step's intent verbatim — the same continuous gesture releases the band and travels on to the
    LEFT WALL — and it is now also the production proof that the FN-469 undock artifact is disarmed on its bottom
    component ALONE. The undock re-anchors the panel with its bottom edge clamped back onto the wall, so without
    that narrowing this gesture would land on a bottom-left QUARTER the operator never aimed at; the column is
    what it must still produce.
    */
    // One continuous gesture: it first releases the band, then travels on to the left wall.
    drag(panel, { x: 600, y: 600 }, { x: 2, y: 400 }, 43);
    expect(panel.dataset.snapMode).toBe("left");
    expect(panel).not.toHaveClass("floating-window--snap-bottom-left");

    // Releasing the column restores the rectangle captured before the FIRST dock, not the band or the column.
    drag(panel, { x: 200, y: 400 }, { x: 700, y: 380 }, 44);
    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
    // The released window follows the pointer rather than jumping back to its old place.
    const released = rectOf(panel);
    expect(700).toBeGreaterThanOrEqual(released.left);
    expect(700).toBeLessThanOrEqual(released.left + released.width);
  });

  /*
  (i) FN-493 symptom acceptance on the production conversation host: "si j'en mets dans chaque angle ça me fait une
  grille 2x2". Four detached conversations, four real pointer gestures, four distinct corners — the RENDERED
  rectangles must tile the live work area exactly: no gap, no overlap, union equal to the area.
  */
  it("tiles the work area as a 2x2 grid when four conversations are dropped in the four corners", async () => {
    const sessions = ["session-1", "session-2", "session-3", "session-4"];
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <Stack />
        <PoppedOutChatWindows
          entries={sessions.map((id, index) => ({
            ...entry,
            session: { ...entry.session, id, title: `Session ${index + 1}` },
            focusNonce: index + 1,
          }))}
          projectId="project-a"
          addToast={vi.fn()}
          onClose={vi.fn()}
          onOpenSessionInNewWindow={vi.fn()}
        />
      </DashboardWindowManagerProvider>,
    );
    const panels = sessions.map((id) => screen.getByTestId(`floating-window-chat-window-project-a-${id}`));
    await waitFor(() => expect(rectOf(panels[3]).width).toBeGreaterThan(0));

    const corners = [
      { mode: "top-left", to: { x: -400, y: -400 } },
      { mode: "top-right", to: { x: 1680, y: -400 } },
      { mode: "bottom-left", to: { x: -400, y: 1200 } },
      { mode: "bottom-right", to: { x: 1680, y: 1200 } },
    ] as const;
    corners.forEach((corner, index) => {
      drag(panels[index], { x: 600, y: 400 }, corner.to, 60 + index);
      expect(panels[index].dataset.snapMode).toBe(corner.mode);
      expect(panels[index]).toHaveClass(`floating-window--snap-${corner.mode}`);
    });

    const workAreaHeight = window.innerHeight - HEADER_HEIGHT - FOOTER_HEIGHT;
    const half = { width: window.innerWidth / 2, height: workAreaHeight / 2 };
    const rects = panels.map(rectOf);
    expect(rects).toEqual([
      { left: 0, top: HEADER_HEIGHT, ...half },
      { left: half.width, top: HEADER_HEIGHT, ...half },
      { left: 0, top: HEADER_HEIGHT + half.height, ...half },
      { left: half.width, top: HEADER_HEIGHT + half.height, ...half },
    ]);
    // Exact tiling: the four quarters sum to the work area and their union spans it corner to corner.
    expect(rects.reduce((sum, r) => sum + r.width * r.height, 0)).toBe(window.innerWidth * workAreaHeight);
    expect(Math.min(...rects.map((r) => r.left))).toBe(0);
    expect(Math.min(...rects.map((r) => r.top))).toBe(HEADER_HEIGHT);
    expect(Math.max(...rects.map((r) => r.left + r.width))).toBe(window.innerWidth);
    expect(Math.max(...rects.map((r) => r.top + r.height))).toBe(HEADER_HEIGHT + workAreaHeight);
    // No overlap: every pair is separated on at least one axis.
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const overlapX = Math.min(rects[a].left + rects[a].width, rects[b].left + rects[b].width) - Math.max(rects[a].left, rects[b].left);
        const overlapY = Math.min(rects[a].top + rects[a].height, rects[b].top + rects[b].height) - Math.max(rects[a].top, rects[b].top);
        expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(0);
      }
    }
    // A full-width band is never published by a half-width quarter, so the shell reserves nothing.
    expect(reservation()).toBe(0);
  });
});
