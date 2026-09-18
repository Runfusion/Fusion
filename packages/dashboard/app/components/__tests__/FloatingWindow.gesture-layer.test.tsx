import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingWindow } from "../FloatingWindow";
import { currentFloatingZ, FUSION_MAX_Z_FLOOR } from "../floatingWindowStack";

afterEach(cleanup);

/** The live ceiling every transient surface derives from: `calc(var(--fusion-max-z) + N)`. */
const ceiling = () => Math.max(currentFloatingZ(), FUSION_MAX_Z_FLOOR);
/** Top of the transient tool-panel band (`.dashboard-tool-popover`). */
const transientPanelLayer = () => ceiling() + 3;

function renderWindow(windowKey: string) {
  const view = render(
    <FloatingWindow
      windowKey={windowKey}
      title="FN-523"
      onClose={() => {}}
      defaultSize={{ width: 320, height: 240 }}
      defaultPosition={{ x: 80, y: 90 }}
    >
      <div>Contenu</div>
    </FloatingWindow>,
  );
  const overlay = screen.getByTestId(`floating-window-overlay-${windowKey}`);
  return { ...view, overlay };
}

function captureable(element: HTMLElement) {
  Object.defineProperty(element, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "releasePointerCapture", { configurable: true, value: vi.fn() });
  return element;
}

const renderedZ = (overlay: HTMLElement) => Number.parseInt(overlay.style.zIndex, 10);

/*
 * FN-523, second operator requirement: "la modale qu'on drag devrait forcément avoir un z-index supérieur à la popover
 * puisque c'est le dernier élément sélectionné". A transient panel derives its layer from the LIVE ceiling, which the
 * window counter can never exceed, so the window claims a strictly higher layer for the DURATION OF THE GESTURE ONLY.
 */
describe("FloatingWindow — couche revendiquée pendant un geste", () => {
  it("passe au-dessus de la bande transitoire au pointerdown sur le bandeau, et redescend au pointerup", () => {
    const { overlay } = renderWindow("gesture-drag");
    const header = captureable(screen.getByTestId("floating-window-drag-handle-gesture-drag"));

    expect(renderedZ(overlay)).toBeLessThan(transientPanelLayer());

    fireEvent.pointerDown(header, { pointerId: 11, clientX: 120, clientY: 100 });
    expect(renderedZ(overlay)).toBeGreaterThan(transientPanelLayer());

    fireEvent.pointerUp(header, { pointerId: 11, clientX: 120, clientY: 100 });
    expect(renderedZ(overlay)).toBeLessThan(transientPanelLayer());
  });

  it("fait de même au démarrage d'un redimensionnement", () => {
    const { overlay } = renderWindow("gesture-resize");
    const handle = captureable(screen.getByTestId("floating-window-resize-e"));

    fireEvent.pointerDown(handle, { pointerId: 12, clientX: 400, clientY: 180 });
    expect(renderedZ(overlay)).toBeGreaterThan(transientPanelLayer());

    fireEvent.pointerUp(handle, { pointerId: 12, clientX: 420, clientY: 180 });
    expect(renderedZ(overlay)).toBeLessThan(transientPanelLayer());
  });

  it("relâche l'élévation sur pointercancel", () => {
    const { overlay } = renderWindow("gesture-cancel");
    const header = captureable(screen.getByTestId("floating-window-drag-handle-gesture-cancel"));

    fireEvent.pointerDown(header, { pointerId: 13, clientX: 120, clientY: 100 });
    expect(renderedZ(overlay)).toBeGreaterThan(transientPanelLayer());

    fireEvent.pointerCancel(header, { pointerId: 13 });
    expect(renderedZ(overlay)).toBeLessThan(transientPanelLayer());
  });

  it("un démontage pendant le geste ne laisse ni écouteur ni élévation derrière lui", () => {
    const { overlay, unmount } = renderWindow("gesture-unmount");
    const header = screen.getByTestId("floating-window-drag-handle-gesture-unmount");
    Object.defineProperty(header, "setPointerCapture", { configurable: true, value: vi.fn() });
    const releasePointerCapture = vi.fn();
    Object.defineProperty(header, "releasePointerCapture", { configurable: true, value: releasePointerCapture });
    const removeEventListener = vi.spyOn(header, "removeEventListener");

    fireEvent.pointerDown(header, { pointerId: 14, clientX: 120, clientY: 100 });
    expect(renderedZ(overlay)).toBeGreaterThan(transientPanelLayer());

    unmount();

    expect(releasePointerCapture).toHaveBeenCalledWith(14);
    expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]),
    );
    expect(document.querySelector('[data-testid="floating-window-overlay-gesture-unmount"]')).toBeNull();
    removeEventListener.mockRestore();
  });

  /*
   * The elevation is a RENDER-ONLY claim: publishing it into `--fusion-max-z` would make the transient band chase it
   * on every gesture, forever. It must not move the shared ceiling nor the shared counter either.
   */
  it("ne publie jamais l'élévation dans --fusion-max-z ni dans le compteur partagé", () => {
    const { overlay } = renderWindow("gesture-ceiling");
    const header = captureable(screen.getByTestId("floating-window-drag-handle-gesture-ceiling"));
    const ceilingBefore = document.documentElement.style.getPropertyValue("--fusion-max-z");
    const counterBefore = currentFloatingZ();

    fireEvent.pointerDown(header, { pointerId: 15, clientX: 120, clientY: 100 });

    expect(renderedZ(overlay)).toBeGreaterThan(transientPanelLayer());
    expect(document.documentElement.style.getPropertyValue("--fusion-max-z")).toBe(ceilingBefore);
    expect(currentFloatingZ()).toBe(counterBefore);

    fireEvent.pointerUp(header, { pointerId: 15, clientX: 120, clientY: 100 });
  });
});
