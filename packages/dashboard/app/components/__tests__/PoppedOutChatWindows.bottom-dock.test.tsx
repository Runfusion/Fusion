import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

/*
FNXC:ChatWindows 2026-09-16-18:31:
FN-469 acceptance for "je devrais aussi avoir cette possibilité d'ancrage en bas pour les chats". A detached
conversation gains the bottom band purely from the SHARED window contract — no chat-owned panel, no extra prop — so
these regressions drive real pointer gestures on the real `PoppedOutChatWindows` host and assert the applied
rectangle, the retained mode, and the release.
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
  (r) Release: a drag past the click threshold in ANY direction frees the window, restores the rectangle it had
  before the FIRST dock (bottom → left → release must not restore the column), and re-anchors it under the pointer.
  */
  it("releases the bottom band in any direction and restores the pre-dock rectangle", async () => {
    const { panel } = renderChatWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));
    const floating = rectOf(panel);

    drag(panel, { x: 600, y: 300 }, { x: 600, y: 300 + window.innerHeight }, 42);
    expect(panel.dataset.snapMode).toBe("bottom");

    // One continuous gesture: it first releases the band, then travels on to the left wall.
    drag(panel, { x: 600, y: 600 }, { x: 2, y: 400 }, 43);
    expect(panel.dataset.snapMode).toBe("left");

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
});
