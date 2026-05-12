import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";
import { GraphTaskNode } from "../GraphTaskNode";
import { useGraphInteraction } from "../useGraphInteraction";

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail }: { task: Task; onOpenDetail: (task: Task) => void }) => (
    <button data-testid={`task-${task.id}`} onClick={() => onOpenDetail(task)}>
      {task.id} {task.column === "in-progress" ? "Executing" : "Idle"}
    </button>
  ),
}));

function createTask(id: string, column: Task["column"] = "todo", dependencies: string[] = []): Task {
  return {
    id,
    description: id,
    column,
    dependencies,
    steps: [{ name: "one", status: "in-progress" }],
    currentStep: 0,
    status: column === "in-progress" ? "executing" : "queued",
    log: [],
  } as Task;
}

function parseTransform(transform: string) {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`Unexpected transform: ${transform}`);
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    scale: Number(match[3]),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }) as DOMRect,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dependency graph interactions", () => {
  it("supports pan and zoom via interaction hook", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.onPointerDown(1, { x: 10, y: 10 });
      result.current.onPointerMove(1, { x: 110, y: 60 }, 800, 600);
      result.current.zoomIn();
    });

    expect(result.current.pan).toEqual({ x: 100, y: 50 });
    expect(result.current.zoom).toBeGreaterThan(1);
  });

  it("keeps single-pointer moves as pan-only without zoom changes", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.onPointerDown(1, { x: 10, y: 10 });
      result.current.onPointerMove(1, { x: 40, y: 30 }, 800, 600);
    });

    expect(result.current.pan).toEqual({ x: 30, y: 20 });
    expect(result.current.zoom).toBe(1);
  });

  it("fit-to-graph computes bounds from actual node positions", () => {
    const { result } = renderHook(() => useGraphInteraction());
    const positions = new Map([
      ["A", { x: 0, y: 0 }],
      ["B", { x: 1000, y: 400 }],
    ]);

    act(() => {
      result.current.fitToGraph(positions, 800, 600, { nodeWidth: 200, nodeHeight: 100, xGap: 40, yGap: 40 });
    });

    expect(result.current.zoom).toBeCloseTo(0.6, 3);
    expect(result.current.pan.x).toBeCloseTo(40, 3);
    expect(result.current.pan.y).toBeCloseTo(150, 3);
  });

  it("wheel pan updates pan by negated delta", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.onWheelPan(50, 30, 800, 600);
    });

    expect(result.current.pan).toEqual({ x: -50, y: -30 });
  });

  it("wheel pan does not change zoom", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.onWheelPan(50, 30, 800, 600);
    });

    expect(result.current.zoom).toBe(1);
  });

  it("wheel pan is clamped by graph bounds", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.setGraphBounds({ minX: 0, minY: 0, maxX: 2000, maxY: 1500 });
      result.current.onWheelPan(99999, 99999, 800, 600);
    });

    expect(result.current.pan.x).toBe(800 - 2000);
    expect(result.current.pan.y).toBe(600 - 1500);
  });

  it("double-clicking a node opens task detail", () => {
    const onOpenDetail = vi.fn();
    render(<DependencyGraph tasks={[createTask("A", "in-progress")]} onOpenDetail={onOpenDetail} />);

    fireEvent.doubleClick(screen.getByTestId("graph-task-node-A"));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "A" }));
    expect(screen.getAllByText(/Executing/).length).toBeGreaterThan(0);
  });

  it("dragging a node updates its position", () => {
    const onNodePositionChange = vi.fn();

    render(
      <GraphTaskNode
        task={createTask("A")}
        position={{ x: 0, y: 0 }}
        scale={1}
        isSelected={true}
        isHighlighted={false}
        isDimmed={false}
        onNodePositionChange={onNodePositionChange}
        onNodeDragStateChange={vi.fn()}
        projectId="p1"
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        onUpdateTask={vi.fn()}
        onArchiveTask={vi.fn()}
        onUnarchiveTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onRetryTask={vi.fn()}
        onOpenDetailWithTab={vi.fn()}
        onMoveTask={vi.fn()}
        onOpenMission={vi.fn()}
        taskStuckTimeoutMs={1_000}
        lastFetchTimeMs={Date.now()}
        workflowStepNameLookup={new Map()}
      />,
    );

    const node = screen.getByTestId("graph-task-node-A");
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 25, clientY: 30, isPrimary: true });

    expect(onNodePositionChange).toHaveBeenCalled();
  });

  it("highlights upstream/downstream chain on hover", () => {
    render(
      <DependencyGraph
        tasks={[createTask("A"), createTask("B", "todo", ["A"]), createTask("C", "todo", ["B"]), createTask("D")]}
        onOpenDetail={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-C"));
    expect(screen.getByTestId("graph-task-node-A").className).toContain("graph-task-node--highlighted");
    expect(screen.getByTestId("graph-task-node-D").className).toContain("graph-task-node--dimmed");
  });

  it("keeps far graph content reachable after zoom-in pan", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.setGraphBounds({ minX: 0, minY: 0, maxX: 2600, maxY: 1400 });
      result.current.onWheelZoom(-120, { x: 400, y: 300 }, 800, 600);
      result.current.onPointerDown(1, { x: 350, y: 250 });
      result.current.onPointerMove(1, { x: -1200, y: 250 }, 800, 600);
      result.current.onPointerUp(1);
    });

    const minPanX = 800 - 2600 * result.current.zoom;
    expect(result.current.pan.x).toBeGreaterThanOrEqual(minPanX);
    expect(result.current.pan.x).toBeLessThanOrEqual(0);
  });

  it("uses wheel pan without modifiers and keeps modifier wheel zoom", () => {
    render(<DependencyGraph tasks={[createTask("A"), createTask("B", "todo", ["A"])]} onOpenDetail={vi.fn()} />);

    const graph = screen.getByTestId("dependency-graph");
    const viewport = graph.querySelector(".dependency-graph__viewport");
    const canvas = graph.querySelector(".graph-canvas-transform") as HTMLElement | null;
    if (!viewport || !canvas) throw new Error("missing graph viewport or canvas");

    const initial = parseTransform(canvas.style.transform);

    fireEvent.wheel(viewport, { deltaX: 50, deltaY: 30, clientX: 300, clientY: 250 });

    const afterPan = parseTransform(canvas.style.transform);
    expect(afterPan.x !== initial.x || afterPan.y !== initial.y).toBe(true);
    expect(afterPan.scale).toBeCloseTo(initial.scale, 5);

    fireEvent.wheel(viewport, { deltaY: -120, ctrlKey: true, clientX: 300, clientY: 250 });

    const afterZoom = parseTransform(canvas.style.transform);
    expect(afterZoom.scale).toBeGreaterThan(afterPan.scale);
  });
});
