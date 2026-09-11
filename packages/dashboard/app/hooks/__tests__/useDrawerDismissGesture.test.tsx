import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDrawerDismissGesture } from "../useDrawerDismissGesture";

function Harness({ enabled = true, onDismiss = vi.fn() }: { enabled?: boolean; onDismiss?: () => void }) {
  const [open, setOpen] = useState(true);
  const panelRef = useRef<HTMLElement | null>(null);
  const handleProps = useDrawerDismissGesture({ enabled, open, panelRef, onDismiss });
  return (
    <>
      <button onClick={() => setOpen(false)}>external close</button>
      <section ref={panelRef} data-testid="panel" style={{ display: open ? undefined : "none" }}>
        <button data-testid="handle" {...handleProps}>handle</button>
        <div data-testid="body">body</div>
      </section>
    </>
  );
}

function start(handle: Element, y = 10, pointerId = 1, timeStamp = 10) {
  fireEvent.pointerDown(handle, { pointerId, clientY: y, button: 0, isPrimary: true, timeStamp });
}

async function flushFrame() {
  await act(async () => { vi.advanceTimersByTime(17); });
}

describe("useDrawerDismissGesture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  it("ferme une fois après un drag long et nettoie avant le callback", async () => {
    const onDismiss = vi.fn(() => expect(screen.getByTestId("panel")).not.toHaveStyle({ transform: expect.anything() }));
    render(<Harness onDismiss={onDismiss} />);
    const handle = screen.getByTestId("handle");
    const panel = screen.getByTestId("panel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
    start(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 130, timeStamp: 210 });
    await flushFrame();
    expect(panel.style.transform).toContain("120px");
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130, timeStamp: 310 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(panel.style.transform).toBe("");
  });

  it("accepte un flick court rapide", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const handle = screen.getByTestId("handle");
    vi.spyOn(screen.getByTestId("panel"), "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
    start(handle, 10, 1, 10);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 50, timeStamp: 30 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 50, timeStamp: 40 });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each(["sous le seuil", "montant", "horizontal"])("revient à zéro pour un mouvement %s", async (kind) => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const handle = screen.getByTestId("handle");
    const panel = screen.getByTestId("panel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
    start(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: kind === "montant" ? 0 : 20, clientX: kind === "horizontal" ? 200 : 0, timeStamp: 110 });
    await flushFrame();
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 20, timeStamp: 1010 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe("");
  });

  it("ignore le corps et un pointer concurrent", async () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const handle = screen.getByTestId("handle");
    fireEvent.pointerDown(screen.getByTestId("body"), { pointerId: 1, clientY: 10, button: 0, isPrimary: true });
    fireEvent.pointerMove(screen.getByTestId("body"), { pointerId: 1, clientY: 300 });
    start(handle, 10, 1);
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 10, button: 0, isPrimary: true });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 300 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 300 });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it.each(["cancel", "lost"])("nettoie sans fermer sur %s", async (kind) => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const handle = screen.getByTestId("handle");
    start(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
    await flushFrame();
    if (kind === "cancel") fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 200 });
    else fireEvent.lostPointerCapture(handle, { pointerId: 1, clientY: 200 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel").style.transform).toBe("");
  });

  it("nettoie lors d'une fermeture externe, désactivation et démontage", async () => {
    const { rerender, unmount } = render(<Harness />);
    const handle = screen.getByTestId("handle");
    start(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
    await flushFrame();
    fireEvent.click(screen.getByText("external close"));
    expect(screen.getByTestId("panel").style.transform).toBe("");
    rerender(<Harness enabled={false} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
