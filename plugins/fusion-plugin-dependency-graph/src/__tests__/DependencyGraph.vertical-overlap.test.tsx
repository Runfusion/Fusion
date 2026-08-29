import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";

const observedElements: Element[] = [];
let resizeObserverCallback: ResizeObserverCallback | null = null;

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task }: { task: Task }) => <div data-testid={`task-${task.id}`}>{task.id}</div>,
}));

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe(element: Element) {
    observedElements.push(element);
  }

  disconnect() {}
}

function createTask(id: string, dependencies: string[] = []): Task {
  return { id, description: id, column: "todo", dependencies, steps: [], currentStep: 0, log: [] } as Task;
}

function setNodeHeight(taskId: string, height: number): void {
  const node = screen.getByTestId(`graph-task-node-${taskId}`) as HTMLDivElement;
  Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => height });
}

function triggerResize(): void {
  if (!resizeObserverCallback) return;
  const entries = observedElements.map(
    (target) => ({ target, contentRect: { width: 0, height: (target as HTMLDivElement).offsetHeight } }) as ResizeObserverEntry,
  );
  resizeObserverCallback(entries, {} as ResizeObserver);
}

describe("DependencyGraph FN-4549 vertical overlap", () => {
  beforeEach(() => {
    observedElements.length = 0;
    resizeObserverCallback = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as typeof ResizeObserver);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1400);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("keeps vertically stacked cards from overlapping after measured heights are applied", async () => {
    render(
      <DependencyGraph
        tasks={[createTask("A", ["B"]), createTask("B", ["C"]), createTask("C")]}
      />,
    );

    setNodeHeight("A", 180);
    setNodeHeight("B", 240);
    setNodeHeight("C", 320);
    triggerResize();

    await waitFor(() => {
      const nodeA = screen.getByTestId("graph-task-node-A") as HTMLDivElement;
      const nodeB = screen.getByTestId("graph-task-node-B") as HTMLDivElement;
      const nodeC = screen.getByTestId("graph-task-node-C") as HTMLDivElement;

      const topA = Number.parseFloat(nodeA.style.top);
      const topB = Number.parseFloat(nodeB.style.top);
      const topC = Number.parseFloat(nodeC.style.top);

      expect(Number.isFinite(topA)).toBe(true);
      expect(topB).toBeGreaterThan(topC);
      expect(topA).toBeGreaterThan(topB);
      expect(topB).toBeGreaterThanOrEqual(topC + 320);
      expect(topA).toBeGreaterThanOrEqual(topB + 240);
    });
  });
});
