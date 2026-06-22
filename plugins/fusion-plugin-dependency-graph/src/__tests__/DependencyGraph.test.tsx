import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import type { NodePositions } from "../utils/graphPositionStorage";
import { DependencyGraph } from "../DependencyGraph";

const fitToGraph = vi.fn();
const zoomIn = vi.fn();
const zoomOut = vi.fn();
const resetView = vi.fn();
const handleKeyDown = vi.fn();
const onPointerDown = vi.fn();
const onPointerMove = vi.fn();
const onPointerUp = vi.fn();
const setGraphBounds = vi.fn();
const clearSavedPositions = vi.fn();
let mockSavedPositions: NodePositions | null = null;
let resizeObserverCallbacks: ResizeObserverCallback[] = [];
let cssStyleElement: HTMLStyleElement | null = null;

const dependencyGraphCss = readFileSync("src/DependencyGraph.css", "utf8");

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail, disableDrag }: { task: Task; onOpenDetail: (task: Task) => void; disableDrag?: boolean }) => (
    <button data-testid={`task-${task.id}`} draggable={!disableDrag} onClick={() => onOpenDetail(task)}>{task.id}</button>
  ),
}));

vi.mock("../useGraphInteraction", () => ({
  useGraphInteraction: () => ({
    transform: "translate(0px, 0px) scale(1)",
    zoom: 1,
    transitioning: false,
    zoomIn,
    zoomOut,
    resetView,
    fitToGraph,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheelZoom: vi.fn(),
    handleKeyDown,
    setGraphBounds,
  }),
}));

vi.mock("../hooks/useGraphPositions", () => ({
  useGraphPositions: () => ({
    savedPositions: mockSavedPositions,
    persistPositions: vi.fn(),
    clearSavedPositions,
  }),
}));

function createTask(id: string, column: Task["column"], dependencies: string[] = []): Task {
  return { id, description: id, column, dependencies, steps: [], currentStep: 0, log: [] } as Task;
}

function setViewportSize(width: number, height: number): void {
  const viewport = document.querySelector(".dependency-graph__viewport") as HTMLDivElement | null;
  if (!viewport) throw new Error("missing viewport");
  Object.defineProperty(viewport, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(viewport, "clientHeight", { value: height, configurable: true });
  resizeObserverCallbacks.forEach((callback) => {
    callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

function readNodePosition(taskId: string): { left: number; top: number } {
  const node = screen.getByTestId(`graph-task-node-${taskId}`) as HTMLElement;
  return {
    left: Number.parseFloat(node.style.left),
    top: Number.parseFloat(node.style.top),
  };
}

function renderInProjectContent(tasks: Task[], width = "100%"): HTMLElement {
  const { container } = render(
    <div className="project-content" style={{ display: "flex", width }}>
      <DependencyGraph tasks={tasks} onOpenTaskDetail={vi.fn()} />
    </div>,
  );
  const graph = container.querySelector(".dependency-graph") as HTMLElement | null;
  if (!graph) throw new Error("missing dependency graph");
  return graph;
}

function expectGraphToFillFlexParent(graph: HTMLElement): void {
  const style = getComputedStyle(graph);
  expect(style.flexGrow).toBe("1");
  expect(style.flexShrink).toBe("1");
  expect(style.flexBasis).toBe("auto");
  expect(style.minWidth).toBe("0px");
  expect(style.boxSizing).toBe("border-box");
}

describe("DependencyGraph", () => {
  beforeEach(() => {
    fitToGraph.mockReset();
    zoomIn.mockReset();
    zoomOut.mockReset();
    resetView.mockReset();
    handleKeyDown.mockReset();
    onPointerDown.mockReset();
    onPointerMove.mockReset();
    onPointerUp.mockReset();
    setGraphBounds.mockReset();
    clearSavedPositions.mockReset();
    mockSavedPositions = null;
    resizeObserverCallbacks = [];
    cssStyleElement = document.createElement("style");
    cssStyleElement.textContent = dependencyGraphCss;
    document.head.appendChild(cssStyleElement);

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallbacks.push(callback);
        }

        observe() {}

        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cssStyleElement?.remove();
    cssStyleElement = null;
    cleanup();
  });

  it("renders empty state for empty list", () => {
    render(<DependencyGraph tasks={[]} onOpenTaskDetail={vi.fn()} />);
    expect(screen.getByText(/No active tasks/i)).toBeTruthy();
  });

  it.each([
    { label: "empty desktop-width surface", tasks: [], width: "100%", expectedNodeIds: [] },
    { label: "empty mobile-width surface", tasks: [], width: "375px", expectedNodeIds: [] },
    {
      label: "populated desktop-width surface",
      tasks: [createTask("A", "todo"), createTask("B", "todo", ["A"])],
      width: "100%",
      expectedNodeIds: ["A", "B"],
    },
    {
      label: "populated mobile-width surface",
      tasks: [createTask("A", "todo"), createTask("B", "todo", ["A"])],
      width: "375px",
      expectedNodeIds: ["A", "B"],
    },
  ])("fills its flex parent in the $label", ({ tasks, width, expectedNodeIds }) => {
    const graph = renderInProjectContent(tasks, width);

    if (expectedNodeIds.length === 0) {
      expect(screen.getByText(/No active tasks/i)).toBeTruthy();
    } else {
      for (const nodeId of expectedNodeIds) {
        expect(screen.getByTestId(`graph-task-node-${nodeId}`)).toBeTruthy();
      }
    }
    expectGraphToFillFlexParent(graph);
  });

  it("renders only triage/todo/in-progress/in-review nodes from mixed columns", () => {
    render(
      <DependencyGraph
        tasks={[
          createTask("A", "triage"),
          createTask("B", "todo"),
          createTask("C", "in-progress"),
          createTask("D", "in-review"),
          createTask("E", "done"),
          createTask("F", "archived"),
        ]}
        onOpenTaskDetail={vi.fn()}
      />,
    );

    expect(screen.getByTestId("graph-task-node-A")).toBeTruthy();
    expect(screen.getByTestId("graph-task-node-B")).toBeTruthy();
    expect(screen.getByTestId("graph-task-node-C")).toBeTruthy();
    expect(screen.getByTestId("graph-task-node-D")).toBeTruthy();
    expect(screen.queryByTestId("graph-task-node-E")).toBeNull();
    expect(screen.queryByTestId("graph-task-node-F")).toBeNull();
  });

  it("auto-fits on initial load with active tasks", async () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    // FNXC:Graph 2026-06-23-00:10: auto-fit only fires once the viewport is measured
    // (width/height > 0); a 0-sized fit would mis-center, so the guard waits for layout.
    setViewportSize(1200, 800);
    await waitFor(() => expect(fitToGraph).toHaveBeenCalled());
    expect(setGraphBounds).toHaveBeenCalled();
  });

  // FNXC:Graph 2026-06-23-02:45: the component can mount at 0×0 (hidden behind a tab / before the
  // container is laid out) and only later report a real size via ResizeObserver. The first real paint
  // must center WITHOUT any user click/drag. This guards the zero-size-at-mount → RO-driven fit path.
  it("does not fit while the viewport is zero-sized, then fits once ResizeObserver reports a real size", async () => {
    render(<DependencyGraph tasks={[createTask("A", "todo"), createTask("B", "todo", ["A"])]} onOpenTaskDetail={vi.fn()} />);

    // Mount-time measured size is 0×0 (jsdom default). A 0-sized fit would mis-center, so none fires.
    setViewportSize(0, 0);
    await Promise.resolve();
    expect(fitToGraph).not.toHaveBeenCalled();

    // Hidden→visible transition: ResizeObserver now reports a real non-zero size → fit must run.
    setViewportSize(1200, 800);
    await waitFor(() => expect(fitToGraph).toHaveBeenCalled());

    // FNXC:Graph 2026-06-23-02:45: fit must run on the normalized (origin-shifted) positions and the
    // real measured size so clampPan clamps against the committed normalized bounds — never the 0-box.
    const [fittedPositions, fittedWidth, fittedHeight] = fitToGraph.mock.calls.at(-1)!;
    expect(fittedWidth).toBe(1200);
    expect(fittedHeight).toBe(800);
    const minLeft = Math.min(...Array.from((fittedPositions as Map<string, { x: number; y: number }>).values()).map((p) => p.x));
    const minTop = Math.min(...Array.from((fittedPositions as Map<string, { x: number; y: number }>).values()).map((p) => p.y));
    expect(minLeft).toBe(0);
    expect(minTop).toBe(0);
    expect(setGraphBounds).toHaveBeenCalled();
  });

  it("auto-fits saved/manual positions into the viewport after layout settles", async () => {
    mockSavedPositions = { A: { x: 10, y: 10 }, B: { x: 300, y: 10 } };
    render(<DependencyGraph tasks={[createTask("A", "todo"), createTask("B", "todo", ["A"])]} projectId="p1" onOpenTaskDetail={vi.fn()} />);

    setViewportSize(1200, 800);
    await waitFor(() => expect(fitToGraph).toHaveBeenCalled());
    const [fittedPositions, fittedWidth, fittedHeight] = fitToGraph.mock.calls.at(-1)!;
    expect(fittedWidth).toBe(1200);
    expect(fittedHeight).toBe(800);
    expect((fittedPositions as Map<string, { x: number; y: number }>).get("A")).toEqual({ x: 0, y: 0 });
    expect((fittedPositions as Map<string, { x: number; y: number }>).get("B")).toEqual({ x: 290, y: 0 });
  });

  it("forwards keyboard events to interaction hook", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    const viewport = document.querySelector(".dependency-graph__viewport");
    if (!viewport) throw new Error("missing viewport");
    fireEvent.keyDown(viewport, { key: "=", ctrlKey: true });
    expect(handleKeyDown).toHaveBeenCalled();
  });

  it("sets viewport tabIndex for keyboard focus", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    const viewport = document.querySelector(".dependency-graph__viewport");
    expect(viewport?.getAttribute("tabindex")).toBe("0");
  });

  it("renders toolbar controls", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fit to graph" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset view" })).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("fit-to-graph button triggers fitToGraph", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fit to graph" }));
    expect(fitToGraph).toHaveBeenCalled();
  });

  it("single-clicking a node selects it without opening detail", () => {
    const onOpenDetail = vi.fn();
    render(<DependencyGraph tasks={[createTask("A", "in-progress")]} onOpenDetail={onOpenDetail} />);
    const node = screen.getByTestId("graph-task-node-A");

    fireEvent.click(node);

    expect(node.className).toContain("graph-node--draggable");
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("double-clicking a node opens detail", () => {
    const onOpenDetail = vi.fn();
    render(<DependencyGraph tasks={[createTask("A", "in-progress")]} onOpenDetail={onOpenDetail} />);

    fireEvent.doubleClick(screen.getByTestId("graph-task-node-A"));

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "A" }));
  });

  it("double-click falls back to onOpenTaskDetail when onOpenDetail is not provided", () => {
    const onOpenTaskDetail = vi.fn();
    render(<DependencyGraph tasks={[createTask("A", "in-progress")]} onOpenTaskDetail={onOpenTaskDetail} />);

    fireEvent.doubleClick(screen.getByTestId("graph-task-node-A"));

    expect(onOpenTaskDetail).toHaveBeenCalledWith("A");
  });

  it("requires selection before node drag class is enabled", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    const node = screen.getByTestId("graph-task-node-A");

    expect(node.className).not.toContain("graph-node--draggable");
    fireEvent.click(node);
    expect(node.className).toContain("graph-node--draggable");
  });

  it("allows pane panning from an unselected node surface", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    const node = screen.getByTestId("graph-task-node-A");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 30, clientY: 20, isPrimary: true });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 30, clientY: 20, isPrimary: true });

    expect(onPointerDown).toHaveBeenCalled();
    expect(onPointerMove).toHaveBeenCalled();
    expect(onPointerUp).toHaveBeenCalled();
  });

  it("uses vertical-depth auto-layout in wide viewports and flips to horizontal-depth in tall viewports", async () => {
    render(
      <DependencyGraph
        tasks={[createTask("A", "todo", ["B"]), createTask("B", "todo", ["C"]), createTask("C", "todo")]}
        onOpenTaskDetail={vi.fn()}
      />,
    );

    setViewportSize(1400, 900);

    await waitFor(() => {
      const wideA = readNodePosition("A");
      const wideB = readNodePosition("B");
      const wideC = readNodePosition("C");
      expect(wideC.top).toBeLessThan(wideB.top);
      expect(wideB.top).toBeLessThan(wideA.top);
      expect(wideA.left).toBe(wideB.left);
      expect(wideB.left).toBe(wideC.left);
    });

    setViewportSize(400, 900);

    await waitFor(() => {
      const tallA = readNodePosition("A");
      const tallB = readNodePosition("B");
      const tallC = readNodePosition("C");
      expect(tallC.left).toBeLessThan(tallB.left);
      expect(tallB.left).toBeLessThan(tallA.left);
      expect(tallA.top).toBe(tallB.top);
      expect(tallB.top).toBe(tallC.top);
    });
  });

  it("preserves saved node positions across viewport orientation changes", async () => {
    mockSavedPositions = {
      A: { x: 500, y: 200 },
      B: { x: 100, y: 100 },
    };

    render(<DependencyGraph tasks={[createTask("A", "todo", ["B"]), createTask("B", "todo")]} projectId="project-1" onOpenTaskDetail={vi.fn()} />);

    setViewportSize(400, 900);
    await waitFor(() => {
      expect(readNodePosition("B")).toEqual({ left: 0, top: 0 });
      expect(readNodePosition("A")).toEqual({ left: 400, top: 100 });
    });

    setViewportSize(1400, 900);
    await waitFor(() => {
      expect(readNodePosition("B")).toEqual({ left: 0, top: 0 });
      expect(readNodePosition("A")).toEqual({ left: 400, top: 100 });
    });
  });
});
