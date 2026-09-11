import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDrawerDismissGesture } from "../useDrawerDismissGesture";

function Harness({ enabled = true, onDismiss = vi.fn() }: { enabled?: boolean; onDismiss?: () => void }) {
  const [open, setOpen] = useState(true);
  const panelRef = useRef<HTMLElement | null>(null);
  const surfaceProps = useDrawerDismissGesture({ enabled, open, panelRef, onDismiss });
  return (
    <>
      <button onClick={() => setOpen(false)}>external close</button>
      <section ref={panelRef} data-testid="panel" style={{ display: open ? undefined : "none" }} {...surfaceProps}>
        <div data-testid="handle" className="alpha-mobile-drawer__handle-target">handle</div>
        <div data-testid="shell"><div data-testid="scroller"><div data-testid="body">body</div></div></div>
        <button data-testid="control">control</button>
        <div className="xterm" data-testid="xterm">terminal</div>
      </section>
    </>
  );
}

function start(target: Element, y = 10, pointerId = 1, timeStamp = 10, x = 0) {
  fireEvent.pointerDown(target, { pointerId, clientX: x, clientY: y, button: 0, isPrimary: true, timeStamp });
}

function move(target: Element, y: number, pointerId = 1, timeStamp = 210, x = 0) {
  fireEvent.pointerMove(target, { pointerId, clientX: x, clientY: y, timeStamp });
}

async function flushFrame() {
  await act(async () => { vi.advanceTimersByTime(17); });
}

function dispatchTouch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, y: number, identifier = 7): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touch = { identifier, clientX: x, clientY: y, target } as Touch;
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [touch] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
  return event;
}

describe("useDrawerDismissGesture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  it.each(["handle", "body"])("ferme une fois après un drag long depuis %s et nettoie avant le callback", async (surface) => {
    const onDismiss = vi.fn(() => expect(screen.getByTestId("panel").style.transform).toBe(""));
    render(<Harness onDismiss={onDismiss} />);
    const target = screen.getByTestId(surface);
    const panel = screen.getByTestId("panel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
    start(target);
    move(target, 130);
    await flushFrame();
    expect(panel.style.transform).toContain("120px");
    fireEvent.pointerUp(target, { pointerId: 1, clientY: 130, timeStamp: 310 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(panel.style.overscrollBehavior).toBe("");
  });

  it("réclame un drag tactile descendant via un listener non passif avant tout pointercancel", async () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const body = screen.getByTestId("body");
    const panel = screen.getByTestId("panel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);

    dispatchTouch(body, "touchstart", 0, 10);
    const ambiguousMove = dispatchTouch(document, "touchmove", 0, 14);
    expect(ambiguousMove.defaultPrevented).toBe(false);
    const claimedMove = dispatchTouch(document, "touchmove", 0, 130);
    expect(claimedMove.defaultPrevented).toBe(true);
    fireEvent.pointerCancel(panel, { pointerId: 7, pointerType: "touch" });
    await flushFrame();
    expect(panel.style.transform).toContain("120px");

    dispatchTouch(document, "touchend", 0, 130);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(panel.style.transform).toBe("");
    expect(panel.style.overscrollBehavior).toBe("");
  });

  it("laisse le touchmove natif au scroller tactile initialement scrollé", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 12;
    dispatchTouch(screen.getByTestId("body"), "touchstart", 0, 10);
    scroller.scrollTop = 0;
    const moveEvent = dispatchTouch(document, "touchmove", 0, 130);
    dispatchTouch(document, "touchend", 0, 130);
    expect(moveEvent.defaultPrevented).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel").style.transform).toBe("");
  });

  it("accepte un flick court rapide depuis un corps au bord haut", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const body = screen.getByTestId("body");
    vi.spyOn(screen.getByTestId("panel"), "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
    start(body, 10, 1, 10);
    move(body, 50, 1, 30);
    fireEvent.pointerUp(body, { pointerId: 1, clientY: 50, timeStamp: 40 });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("laisse tout le geste au scroller qui était déjà au-dessus de zéro", async () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 12;
    const body = screen.getByTestId("body");
    start(body);
    scroller.scrollTop = 0;
    move(body, 200);
    await flushFrame();
    fireEvent.pointerUp(body, { pointerId: 1, clientY: 200 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel").style.transform).toBe("");
  });

  it.each([
    ["tap", 10, 0],
    ["montant", 0, 0],
    ["horizontal", 30, 200],
  ])("ne réclame pas un mouvement %s", async (_kind, y, x) => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const body = screen.getByTestId("body");
    start(body);
    move(body, y, 1, 110, x);
    await flushFrame();
    fireEvent.pointerUp(body, { pointerId: 1, clientY: y, clientX: x, timeStamp: 1010 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel").style.transform).toBe("");
  });

  it.each(["control", "xterm"])("préserve les interactions %s", (targetId) => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const target = screen.getByTestId(targetId);
    start(target);
    move(target, 300);
    fireEvent.pointerUp(target, { pointerId: 1, clientY: 300 });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("garde un seul propriétaire de pointer", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const body = screen.getByTestId("body");
    start(body, 10, 1);
    start(body, 10, 2);
    move(body, 300, 2);
    fireEvent.pointerUp(body, { pointerId: 2, clientY: 300 });
    expect(onDismiss).not.toHaveBeenCalled();
    move(body, 200, 1);
    fireEvent.pointerUp(body, { pointerId: 1, clientY: 200 });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "lost"])("nettoie sans fermer sur %s", async (kind) => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const body = screen.getByTestId("body");
    start(body);
    move(body, 200);
    await flushFrame();
    if (kind === "cancel") fireEvent.pointerCancel(body, { pointerId: 1, clientY: 200 });
    else fireEvent.lostPointerCapture(screen.getByTestId("panel"), { pointerId: 1, clientY: 200 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel").style.transform).toBe("");
  });

  it("nettoie lors d'une fermeture externe, désactivation et démontage", async () => {
    const { rerender, unmount } = render(<Harness />);
    const body = screen.getByTestId("body");
    start(body);
    move(body, 200);
    await flushFrame();
    fireEvent.click(screen.getByText("external close"));
    expect(screen.getByTestId("panel").style.transform).toBe("");
    rerender(<Harness enabled={false} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
