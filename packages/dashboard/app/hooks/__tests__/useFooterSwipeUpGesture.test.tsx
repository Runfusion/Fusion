/**
 * FN-511 — Geste « glisser le pied de page vers le haut pour ouvrir le MENU de navigation ».
 *
 * L'opérateur demande une option mobile qui masque le bouton hamburger et ouvre la liste des destinations par ce geste ;
 * le Chat, devenu une destination ordinaire des cinq créneaux configurables, n'est plus la destination du geste.
 * Ces cas pilotent de VRAIS événements `touchstart`/`touchmove`/`touchend`/`touchcancel` en jsdom et couvrent
 * l'énumération de surfaces du plan : geste abouti, flick rapide, geste descendant, horizontal, trop court et lent,
 * multi-touch, annulation, désactivation, démontage, suppression du clic fantôme, et classification pure.
 */

import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FOOTER_SWIPE_INTENT_THRESHOLD,
  FOOTER_SWIPE_MIN_DISTANCE,
  FOOTER_SWIPE_VELOCITY_THRESHOLD,
  resolveFooterSwipeUpIntent,
  shouldTriggerFooterSwipeUp,
  useFooterSwipeUpGesture,
} from "../useFooterSwipeUpGesture";

function Harness({ enabled = true, onTrigger = vi.fn(), onTabClick = vi.fn() }: { enabled?: boolean; onTrigger?: () => void; onTabClick?: () => void }) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  useFooterSwipeUpGesture({ enabled, surfaceRef, onTrigger });
  return (
    <nav ref={surfaceRef} data-testid="pill">
      <button type="button" data-testid="tab" onClick={onTabClick}>tab</button>
    </nav>
  );
}

/* Helper de dispatch tactile repris de `useDrawerDismissGesture.test.tsx`. */
function dispatchTouch(
  target: EventTarget,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  points: { x: number; y: number; identifier?: number }[],
  timeStamp = 0,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touches = points.map(({ x, y, identifier = 7 }) => ({ identifier, clientX: x, clientY: y, target }) as Touch);
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : touches },
    changedTouches: { value: touches },
    timeStamp: { value: timeStamp },
  });
  target.dispatchEvent(event);
  return event;
}

function swipe(surface: Element, { from, to, duration = 200, end = "touchend" as "touchend" | "touchcancel" }: { from: number; to: number; duration?: number; end?: "touchend" | "touchcancel" }, x = { from: 0, to: 0 }) {
  dispatchTouch(surface, "touchstart", [{ x: x.from, y: from }], 0);
  dispatchTouch(document, "touchmove", [{ x: x.to, y: to }], duration);
  dispatchTouch(document, end, [{ x: x.to, y: to }], duration);
}

describe("useFooterSwipeUpGesture", () => {
  // (a) glissement ascendant long → une seule ouverture.
  it("déclenche exactement une fois après un glissement ascendant long", () => {
    const onTrigger = vi.fn();
    render(<Harness onTrigger={onTrigger} />);
    swipe(screen.getByTestId("pill"), { from: 300, to: 300 - FOOTER_SWIPE_MIN_DISTANCE - 20, duration: 400 });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  // (b) flick court mais rapide → déclenchement par la vitesse.
  it("déclenche un flick court mais rapide via le seuil de vitesse", () => {
    const onTrigger = vi.fn();
    render(<Harness onTrigger={onTrigger} />);
    swipe(screen.getByTestId("pill"), { from: 300, to: 280, duration: 20 });
    expect(20 / 20).toBeGreaterThanOrEqual(FOOTER_SWIPE_VELOCITY_THRESHOLD);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  // (c) directions et gestes inertes.
  it.each([
    ["descendant", { from: 300, to: 380, duration: 300 }, { from: 0, to: 0 }],
    ["horizontal", { from: 300, to: 292, duration: 300 }, { from: 0, to: 120 }],
    ["trop court et trop lent", { from: 300, to: 280, duration: 2000 }, { from: 0, to: 0 }],
  ] as const)("ne déclenche pas pour un glissement %s", (_label, gesture, x) => {
    const onTrigger = vi.fn();
    render(<Harness onTrigger={onTrigger} />);
    swipe(screen.getByTestId("pill"), gesture, x);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("ignore un geste à deux doigts", () => {
    const onTrigger = vi.fn();
    render(<Harness onTrigger={onTrigger} />);
    const pill = screen.getByTestId("pill");
    dispatchTouch(pill, "touchstart", [{ x: 0, y: 300, identifier: 7 }, { x: 40, y: 300, identifier: 8 }], 0);
    dispatchTouch(document, "touchmove", [{ x: 0, y: 200, identifier: 7 }], 200);
    dispatchTouch(document, "touchend", [{ x: 0, y: 200, identifier: 7 }], 200);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("annule le geste quand un second doigt apparaît en cours de route", () => {
    const onTrigger = vi.fn();
    render(<Harness onTrigger={onTrigger} />);
    const pill = screen.getByTestId("pill");
    dispatchTouch(pill, "touchstart", [{ x: 0, y: 300 }], 0);
    dispatchTouch(document, "touchmove", [{ x: 0, y: 240, identifier: 7 }, { x: 50, y: 240, identifier: 8 }], 100);
    dispatchTouch(document, "touchend", [{ x: 0, y: 200, identifier: 7 }], 200);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  // (d) touchcancel ne déclenche pas et nettoie.
  it("ne déclenche pas sur touchcancel et nettoie l'état", () => {
    const onTrigger = vi.fn();
    render(<Harness onTrigger={onTrigger} />);
    const pill = screen.getByTestId("pill");
    swipe(pill, { from: 300, to: 200, duration: 200, end: "touchcancel" });
    expect(onTrigger).not.toHaveBeenCalled();
    /* Aucun état résiduel : un `touchend` orphelin après annulation reste inerte. */
    dispatchTouch(document, "touchend", [{ x: 0, y: 200 }], 300);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  // (e) désactivé → aucun listener, donc aucun déclenchement même sur un geste parfait.
  it("n'installe aucun listener quand il est désactivé", () => {
    const onTrigger = vi.fn();
    const addSpy = vi.spyOn(document, "addEventListener");
    render(<Harness enabled={false} onTrigger={onTrigger} />);
    swipe(screen.getByTestId("pill"), { from: 300, to: 200, duration: 200 });
    expect(onTrigger).not.toHaveBeenCalled();
    expect(addSpy.mock.calls.filter(([type]) => type === "touchmove")).toHaveLength(0);
    addSpy.mockRestore();
  });

  // (f) le démontage retire les listeners document.
  it("retire les listeners document au démontage", () => {
    const onTrigger = vi.fn();
    const { unmount } = render(<Harness onTrigger={onTrigger} />);
    const pill = screen.getByTestId("pill");
    dispatchTouch(pill, "touchstart", [{ x: 0, y: 300 }], 0);
    unmount();
    expect(() => {
      dispatchTouch(document, "touchmove", [{ x: 0, y: 200 }], 100);
      dispatchTouch(document, "touchend", [{ x: 0, y: 200 }], 200);
    }).not.toThrow();
    expect(onTrigger).not.toHaveBeenCalled();
  });

  /*
   * (g) suppression du clic fantôme : après un geste réclamé, l'onglet sous le doigt ne navigue pas ; un tap simple
   * (sans mouvement) reste un clic normal.
   */
  it("neutralise exactement un clic après un geste réclamé et laisse passer un tap simple", () => {
    const onTrigger = vi.fn();
    const onTabClick = vi.fn();
    render(<Harness onTrigger={onTrigger} onTabClick={onTabClick} />);
    const pill = screen.getByTestId("pill");
    const tab = screen.getByTestId("tab");

    swipe(pill, { from: 300, to: 200, duration: 200 });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    fireEvent.click(tab);
    expect(onTabClick).not.toHaveBeenCalled();

    /* Le suppresseur est consommé : le clic suivant passe. */
    fireEvent.click(tab);
    expect(onTabClick).toHaveBeenCalledTimes(1);

    /* Un tap sans mouvement ne réclame rien et laisse passer son clic. */
    dispatchTouch(pill, "touchstart", [{ x: 0, y: 300 }], 0);
    dispatchTouch(document, "touchend", [{ x: 0, y: 300 }], 40);
    fireEvent.click(tab);
    expect(onTabClick).toHaveBeenCalledTimes(2);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("ne laisse aucun style en ligne sur la surface", () => {
    render(<Harness />);
    const pill = screen.getByTestId("pill");
    swipe(pill, { from: 300, to: 200, duration: 200 });
    expect(pill.getAttribute("style")).toBeNull();
  });
});

// (h) classification pure, testable sans DOM.
describe("resolveFooterSwipeUpIntent", () => {
  it.each([
    [{ deltaX: 0, deltaY: -2 }, "pending"],
    [{ deltaX: 0, deltaY: 2 }, "pending"],
    [{ deltaX: 0, deltaY: -FOOTER_SWIPE_INTENT_THRESHOLD }, "claimed"],
    [{ deltaX: 0, deltaY: -40 }, "claimed"],
    [{ deltaX: 0, deltaY: 40 }, "rejected"],
    [{ deltaX: 40, deltaY: -10 }, "rejected"],
    [{ deltaX: -40, deltaY: -10 }, "rejected"],
    [{ deltaX: 10, deltaY: -60 }, "claimed"],
  ] as const)("classifie %j comme %s", (input, expected) => {
    expect(resolveFooterSwipeUpIntent(input)).toBe(expected);
  });

  it("ne déclenche que sur une distance suffisante ou un flick rapide", () => {
    expect(shouldTriggerFooterSwipeUp({ deltaY: -FOOTER_SWIPE_MIN_DISTANCE, elapsedMs: 5000 })).toBe(true);
    expect(shouldTriggerFooterSwipeUp({ deltaY: -20, elapsedMs: 20 })).toBe(true);
    expect(shouldTriggerFooterSwipeUp({ deltaY: -20, elapsedMs: 5000 })).toBe(false);
    expect(shouldTriggerFooterSwipeUp({ deltaY: 80, elapsedMs: 100 })).toBe(false);
    expect(shouldTriggerFooterSwipeUp({ deltaY: 0, elapsedMs: 100 })).toBe(false);
  });
});
