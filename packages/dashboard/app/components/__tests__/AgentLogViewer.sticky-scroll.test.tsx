import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLogViewer } from "../AgentLogViewer";
import { makeEntry, getScrollContainer } from "./AgentLogViewer.test-helpers";

vi.mock("lucide-react", () => ({
  Maximize2: () => null,
  Minimize2: () => null,
  Loader2: () => null,
  Cpu: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));

/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 — le journal d'agent décidait du suivi par la seule géométrie (50 px). Un geste de molette de 30 px restait
dans cette fenêtre, ne relâchait rien, et `followTail` (ResizeObserver + MutationObserver) réécrivait `scrollTop` en
bas : le lecteur était raccroché à l'ancre. L'intention gagne désormais, et le seuil ne sert qu'au réengagement.
*/

interface LogGeometry {
  readonly scrollTop: number;
  setScrollTop(value: number): void;
  grow(byPx: number): void;
  readonly scrollHeight: number;
}

function installGeometry(container: HTMLElement, { scrollHeight = 1000, clientHeight = 200 } = {}): LogGeometry {
  let height = scrollHeight;
  let top = height - clientHeight;
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(Number(value), height - clientHeight)); },
    },
  });
  return {
    get scrollTop() { return top; },
    get scrollHeight() { return height; },
    setScrollTop(value: number) { top = value; },
    grow(byPx: number) { height += byPx; },
  };
}

function wheelUp(element: HTMLElement, deltaY = -30) {
  const event = new Event("wheel", { bubbles: true });
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "target", { value: element });
  act(() => { element.dispatchEvent(event); });
}

const firstEntry = makeEntry({ text: "first output" });
const secondEntry = makeEntry({ text: "second output", timestamp: "2026-01-01T00:00:01Z" });

describe("FN-398 AgentLogViewer — a manual gesture always wins over tail following", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stops following after a 30px wheel-up, so an appended entry no longer moves the viewport", () => {
    const view = render(<AgentLogViewer entries={[firstEntry]} loading={false} />);
    const container = getScrollContainer(view.container);
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);
    act(() => { fireEvent.scroll(container); });

    geometry.grow(400);
    view.rerender(<AgentLogViewer entries={[firstEntry, secondEntry]} loading={false} />);

    expect(geometry.scrollTop).toBe(770);
  });

  /*
  FNXC:StickyBottomScroll 2026-09-14-21:29:
  FN-398 — un journal d'agent en direct commence VIDE : le conteneur de défilement n'existe pas au premier
  rendu. Le propriétaire doit détecter son arrivée tardive, sinon aucun écouteur n'est attaché et le lecteur
  ne peut plus jamais quitter la queue.
  */
  it("subscribes to a container that only mounts after the first entry arrives", () => {
    const view = render(<AgentLogViewer entries={[]} loading />);
    expect(view.container.querySelector(".agent-log-viewer-scroll")).toBeNull();

    view.rerender(<AgentLogViewer entries={[firstEntry]} loading={false} />);
    const container = getScrollContainer(view.container);
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);
    act(() => { fireEvent.scroll(container); });

    geometry.grow(400);
    view.rerender(<AgentLogViewer entries={[firstEntry, secondEntry]} loading={false} />);

    expect(geometry.scrollTop).toBe(770);
  });

  it("honours the gesture when growth lands before the scroll event is delivered", () => {
    const view = render(<AgentLogViewer entries={[firstEntry]} loading={false} />);
    const container = getScrollContainer(view.container);
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);

    geometry.grow(400);
    view.rerender(<AgentLogViewer entries={[firstEntry, secondEntry]} loading={false} />);

    expect(geometry.scrollTop).toBe(770);
  });

  it("rearms following once the reader returns to the bottom", () => {
    const view = render(<AgentLogViewer entries={[firstEntry]} loading={false} />);
    const container = getScrollContainer(view.container);
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);
    act(() => { fireEvent.scroll(container); });

    geometry.setScrollTop(800);
    act(() => { fireEvent.scroll(container); });

    geometry.grow(400);
    view.rerender(<AgentLogViewer entries={[firstEntry, secondEntry]} loading={false} />);

    expect(geometry.scrollTop).toBe(geometry.scrollHeight - 200);
  });

  it("does not detach a gesture on a log that cannot scroll", () => {
    const view = render(<AgentLogViewer entries={[firstEntry]} loading={false} />);
    const container = getScrollContainer(view.container);
    const geometry = installGeometry(container, { scrollHeight: 200, clientHeight: 200 });
    geometry.setScrollTop(0);

    wheelUp(container);

    geometry.grow(600);
    view.rerender(<AgentLogViewer entries={[firstEntry, secondEntry]} loading={false} />);

    expect(geometry.scrollTop).toBeGreaterThan(0);
  });
});
