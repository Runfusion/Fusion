import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, SVGProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DevServerLogViewer } from "../DevServerLogViewer";
import type { DevServerLogEntry } from "../../hooks/useDevServerLogs";

vi.mock("lucide-react", () => ({
  Maximize2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-maximize" {...props} />,
  Minimize2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-minimize" {...props} />,
  Loader2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-loader" {...props} />,
  Search: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-search" {...props} />,
  ChevronDown: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-chevrondown" {...props} />,
}));

/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 — le journal du serveur de développement décidait du suivi par la seule géométrie (50 px) et son
MutationObserver rappelait `scrollToBottom` à chaque croissance. Un petit geste ne libérait donc pas le lecteur.
*/

function createEntry(overrides: Partial<DevServerLogEntry>): DevServerLogEntry {
  return { id: 1, text: "line", stream: "stdout", timestamp: "2026-09-14T20:00:00Z", ...overrides };
}

function renderViewer(overrides: Partial<ComponentProps<typeof DevServerLogViewer>> = {}) {
  return render(
    <DevServerLogViewer
      entries={[]}
      loading={false}
      loadingMore={false}
      hasMore={false}
      total={0}
      onLoadMore={vi.fn()}
      isRunning
      {...overrides}
    />,
  );
}

function findScrollContainer(): HTMLElement {
  return screen.getByTestId("devserver-log-content");
}

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

const firstEntries = [createEntry({ id: 1, text: "line 1" })];
const grownEntries = [createEntry({ id: 1, text: "line 1" }), createEntry({ id: 2, text: "line 2" })];

describe("FN-398 DevServerLogViewer — a manual gesture always wins over tail following", () => {
  it("stops following after a 30px wheel-up, so a new line no longer moves the viewport", () => {
    const view = renderViewer({ entries: firstEntries, total: 1 });
    const container = findScrollContainer();
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);
    act(() => { fireEvent.scroll(container); });

    geometry.grow(400);
    view.rerender(
      <DevServerLogViewer entries={grownEntries} loading={false} loadingMore={false} hasMore={false} total={2} onLoadMore={vi.fn()} isRunning />,
    );

    expect(geometry.scrollTop).toBe(770);
  });

  /*
  FNXC:StickyBottomScroll 2026-09-14-21:29:
  FN-398 — `useDevServerLogs` passe par un état de chargement sans entrée : le conteneur de défilement est
  démonté puis recréé avec un nœud DOM neuf. Le propriétaire doit se rattacher à ce nœud tardif.
  */
  it("subscribes to a container that only mounts after the loading state clears", () => {
    const view = renderViewer({ entries: [], loading: true, total: 0 });
    expect(screen.queryByTestId("devserver-log-content")).toBeNull();

    view.rerender(
      <DevServerLogViewer entries={firstEntries} loading={false} loadingMore={false} hasMore={false} total={1} onLoadMore={vi.fn()} isRunning />,
    );
    const container = findScrollContainer();
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);
    act(() => { fireEvent.scroll(container); });

    geometry.grow(400);
    view.rerender(
      <DevServerLogViewer entries={grownEntries} loading={false} loadingMore={false} hasMore={false} total={2} onLoadMore={vi.fn()} isRunning />,
    );

    expect(geometry.scrollTop).toBe(770);
  });

  it("rearms following through the jump-to-bottom control", () => {
    const view = renderViewer({ entries: firstEntries, total: 1 });
    const container = findScrollContainer();
    const geometry = installGeometry(container);

    wheelUp(container);
    geometry.setScrollTop(770);
    act(() => { fireEvent.scroll(container); });

    const jumpButton = screen.getByTestId("icon-chevrondown").closest("button");
    expect(jumpButton).not.toBeNull();
    act(() => { fireEvent.click(jumpButton!); });

    geometry.grow(400);
    view.rerender(
      <DevServerLogViewer entries={grownEntries} loading={false} loadingMore={false} hasMore={false} total={2} onLoadMore={vi.fn()} isRunning />,
    );

    expect(geometry.scrollTop).toBe(geometry.scrollHeight - 200);
  });
});
