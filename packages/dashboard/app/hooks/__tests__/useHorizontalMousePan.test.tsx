import { useState } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHorizontalMousePan } from "../useHorizontalMousePan";

function PanHarness({
  enabled = true,
  canStartFrom = () => true,
  onClick = vi.fn(),
}: {
  enabled?: boolean;
  canStartFrom?: (target: EventTarget | null) => boolean;
  onClick?: () => void;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const { isPanning, ...bindings } = useHorizontalMousePan(element, { enabled, canStartFrom });
  return (
    <div
      ref={setElement}
      data-testid="scroller"
      data-panning={String(isPanning)}
      onClick={onClick}
      {...bindings}
    >
      <button type="button" data-testid="button">Tab</button>
      <span data-testid="surface">Surface</span>
    </div>
  );
}

function renderHarness(props: Parameters<typeof PanHarness>[0] = {}) {
  const view = render(<PanHarness {...props} />);
  const scroller = view.getByTestId("scroller");
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 600 },
    setPointerCapture: { configurable: true, value: vi.fn() },
  });
  return { ...view, scroller };
}

function down(target: HTMLElement, x = 100, y = 50, pointerId = 1, pointerType = "mouse", button = 0) {
  fireEvent.pointerDown(target, { clientX: x, clientY: y, pointerId, pointerType, button });
}

function move(target: HTMLElement, x: number, y = 50, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerMove(target, { clientX: x, clientY: y, pointerId, pointerType });
}

function up(target: HTMLElement, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerUp(target, { pointerId, pointerType, button: 0 });
}

describe("useHorizontalMousePan", () => {
  it("fait défiler dans les deux directions après une intention horizontale dominante", () => {
    const { scroller, getByTestId } = renderHarness();
    const surface = getByTestId("surface");
    scroller.scrollLeft = 100;

    down(surface);
    move(surface, 140);
    expect(scroller.scrollLeft).toBe(60);
    expect(scroller).toHaveAttribute("data-panning", "true");
    up(surface);

    scroller.scrollLeft = 100;
    down(surface, 100, 50, 2);
    move(surface, 70, 50, 2);
    expect(scroller.scrollLeft).toBe(130);
  });

  it("préserve le clic stationnaire, le seuil et les mouvements verticaux", () => {
    const onClick = vi.fn();
    const { scroller, getByTestId } = renderHarness({ onClick });
    const button = getByTestId("button");
    scroller.scrollLeft = 100;

    down(button);
    move(button, 103);
    move(button, 104, 110);
    up(button);
    fireEvent.click(button);

    expect(scroller.scrollLeft).toBe(100);
    expect(scroller).toHaveAttribute("data-panning", "false");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("supprime exactement le clic de compatibilité qui suit un vrai pan", () => {
    const onClick = vi.fn();
    const { scroller, getByTestId } = renderHarness({ onClick });
    const button = getByTestId("button");
    scroller.scrollLeft = 100;

    down(button);
    move(button, 140);
    up(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("reste inerte sans overflow ou quand le consommateur refuse la cible", () => {
    const canStartFrom = vi.fn((target) => target instanceof Element && !target.closest("button"));
    const { scroller, getByTestId } = renderHarness({ canStartFrom });
    scroller.scrollLeft = 100;

    down(getByTestId("button"));
    move(getByTestId("button"), 40);
    up(getByTestId("button"));
    expect(scroller.scrollLeft).toBe(100);

    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 200 });
    down(getByTestId("surface"), 100, 50, 2);
    move(getByTestId("surface"), 40, 50, 2);
    expect(scroller.scrollLeft).toBe(100);
    expect(canStartFrom).toHaveBeenCalled();
  });

  it("ignore touch, pen, bouton secondaire et mode désactivé quelle que soit la largeur", () => {
    const { scroller, getByTestId, rerender } = renderHarness();
    const surface = getByTestId("surface");
    scroller.scrollLeft = 100;

    for (const [pointerType, pointerId] of [["touch", 1], ["pen", 2]] as const) {
      down(surface, 100, 50, pointerId, pointerType);
      move(surface, 40, 50, pointerId, pointerType);
      up(surface, pointerId, pointerType);
    }
    down(surface, 100, 50, 3, "mouse", 2);
    move(surface, 40, 50, 3);
    rerender(<PanHarness enabled={false} />);
    down(getByTestId("surface"), 100, 50, 4);
    move(getByTestId("surface"), 40, 50, 4);

    expect(scroller.scrollLeft).toBe(100);
    expect(scroller).toHaveAttribute("data-panning", "false");
  });

  it("rend immédiatement la main si la capture est absente ou refusée", () => {
    const onClick = vi.fn();
    const { scroller, getByTestId } = renderHarness({ onClick });
    const surface = getByTestId("surface");
    scroller.scrollLeft = 100;

    Object.defineProperty(scroller, "setPointerCapture", { configurable: true, value: undefined });
    down(surface);
    move(surface, 40);
    up(surface);
    fireEvent.click(surface);

    Object.defineProperty(scroller, "setPointerCapture", {
      configurable: true,
      value: vi.fn(() => { throw new DOMException("capture refused"); }),
    });
    down(surface, 100, 50, 2);
    move(surface, 40, 50, 2);
    up(surface, 2);
    fireEvent.click(surface);

    expect(scroller.scrollLeft).toBe(100);
    expect(scroller).toHaveAttribute("data-panning", "false");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("clôture exclusivement le pointeur actif et refuse un concurrent", () => {
    const { scroller, getByTestId } = renderHarness();
    const surface = getByTestId("surface");
    const setPointerCapture = vi.fn();
    Object.defineProperty(scroller, "setPointerCapture", { configurable: true, value: setPointerCapture });
    scroller.scrollLeft = 100;

    down(surface, 100, 50, 1);
    down(surface, 100, 50, 2);
    move(surface, 40, 50, 2);
    up(surface, 2);
    expect(scroller.scrollLeft).toBe(100);

    move(surface, 40, 50, 1);
    expect(scroller.scrollLeft).toBe(160);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("libère de façon idempotente sur up, cancel, perte de capture et démontage", () => {
    const { scroller, getByTestId, unmount } = renderHarness();
    const surface = getByTestId("surface");
    const releasePointerCapture = vi.fn();
    Object.defineProperties(scroller, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    down(surface);
    move(surface, 140);
    up(surface);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);

    down(surface, 100, 50, 2);
    move(surface, 140, 50, 2);
    fireEvent.pointerCancel(surface, { pointerId: 2 });
    expect(scroller).toHaveAttribute("data-panning", "false");

    down(surface, 100, 50, 3);
    move(surface, 140, 50, 3);
    fireEvent.lostPointerCapture(surface, { pointerId: 3 });
    expect(scroller).toHaveAttribute("data-panning", "false");

    down(surface, 100, 50, 4);
    move(surface, 140, 50, 4);
    unmount();
    expect(releasePointerCapture).toHaveBeenCalledWith(4);
  });
});
