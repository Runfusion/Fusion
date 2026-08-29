import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail }: { task: Task; onOpenDetail: (task: Task) => void }) => (
    <button data-testid={`task-${task.id}`} onClick={() => onOpenDetail(task)}>{task.id}</button>
  ),
}));

vi.mock("../useGraphInteraction", () => ({
  useGraphInteraction: () => ({
    transform: "translate(0px, 0px) scale(1)",
    zoom: 1,
    transitioning: false,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetView: vi.fn(),
    fitToGraph: vi.fn(),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onWheelZoom: vi.fn(),
    handleKeyDown: vi.fn(),
    setGraphBounds: vi.fn(),
  }),
}));

function createTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    description: id,
    column: "todo",
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

function setViewportDimensions(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function expectEdgePaintsViaResolvableStyle(edge: SVGElement, expectedStroke = "var(--border)", expectedStrokeWidth = "var(--btn-border-width)") {
  expect(edge.getAttribute("stroke")).not.toBe(expectedStroke);
  expect(edge.getAttribute("stroke-width")).not.toBe(expectedStrokeWidth);
  expect(edge.getAttribute("strokeWidth")).not.toBe(expectedStrokeWidth);
  expect(edge.style.stroke).toBe(expectedStroke);
  expect(edge.style.strokeWidth).toBe(expectedStrokeWidth);
}

afterEach(() => {
  cleanup();
  setViewportDimensions(1024, 768);
});

describe("DependencyGraph highlighting", () => {
  const tasks = [createTask("A"), createTask("B", ["A"]), createTask("C", ["B"]), createTask("D")];

  it("highlights chain on hover and returns to neutral on mouse leave", () => {
    render(<DependencyGraph tasks={tasks} onOpenDetail={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-C"));
    expect(screen.getByTestId("graph-task-node-A").className).toContain("graph-task-node--highlighted");
    expect(screen.getByTestId("graph-task-node-B").className).toContain("graph-task-node--highlighted");
    expect(screen.getByTestId("graph-task-node-C").className).toContain("graph-task-node--highlighted");
    expect(screen.getByTestId("graph-task-node-D").className).toContain("graph-task-node--dimmed");

    fireEvent.mouseLeave(screen.getByTestId("graph-task-node-C"));
    expect(screen.getByTestId("graph-task-node-A").className).not.toContain("graph-task-node--highlighted");
    expect(screen.getByTestId("graph-task-node-D").className).not.toContain("graph-task-node--dimmed");
  });

  it("keeps selection until toggled or pane clicked", () => {
    render(<DependencyGraph tasks={tasks} onOpenDetail={vi.fn()} />);

    fireEvent.click(screen.getByTestId("graph-task-node-B"));
    expect(screen.getByTestId("graph-task-node-A").className).toContain("graph-task-node--highlighted");

    fireEvent.click(screen.getByTestId("graph-task-node-B"));
    expect(screen.getByTestId("graph-task-node-A").className).not.toContain("graph-task-node--highlighted");

    fireEvent.click(screen.getByTestId("graph-task-node-B"));
    fireEvent.click(document.querySelector(".dependency-graph__viewport") as Element);
    expect(screen.getByTestId("graph-task-node-B").className).not.toContain("graph-task-node--highlighted");
  });

  it("hover overrides selection and reverts when hover leaves", () => {
    render(<DependencyGraph tasks={tasks} onOpenDetail={vi.fn()} />);

    fireEvent.click(screen.getByTestId("graph-task-node-B"));
    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-D"));
    expect(screen.getByTestId("graph-task-node-D").className).toContain("graph-task-node--highlighted");
    expect(screen.getByTestId("graph-task-node-A").className).toContain("graph-task-node--dimmed");

    fireEvent.mouseLeave(screen.getByTestId("graph-task-node-D"));
    expect(screen.getByTestId("graph-task-node-A").className).toContain("graph-task-node--highlighted");
  });

  it("applies edge dimming/highlighting and preserves double-click-to-detail", () => {
    const onOpenDetail = vi.fn();
    render(<DependencyGraph tasks={tasks} onOpenDetail={onOpenDetail} />);

    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-C"));
    const edges = screen.getAllByTestId("dependency-edge");
    const edgeAB = edges.find((edge) => edge.getAttribute("data-edge-id") === "B->A");
    const edgeCB = edges.find((edge) => edge.getAttribute("data-edge-id") === "C->B");

    expect(edgeAB).toBeDefined();
    expect(edgeAB?.className.baseVal || edgeAB?.className).toContain("graph-edge--highlighted");
    expectEdgePaintsViaResolvableStyle(edgeAB as SVGElement, "var(--todo)", "var(--space-xs)");
    expect(edgeCB).toBeDefined();
    expect(edgeCB?.className.baseVal || edgeCB?.className).toContain("graph-edge--highlighted");
    expectEdgePaintsViaResolvableStyle(edgeCB as SVGElement, "var(--todo)", "var(--space-xs)");

    fireEvent.doubleClick(screen.getByTestId("graph-task-node-C"));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "C" }));
  });

  it.each([
    ["vertical desktop", 1200, 800],
    ["horizontal mobile", 390, 844],
  ] as const)("renders dependency chain edges with resolvable stroke in %s orientation", (_label, width, height) => {
    setViewportDimensions(width, height);
    render(<DependencyGraph tasks={tasks} onOpenDetail={vi.fn()} />);

    const edges = screen.getAllByTestId("dependency-edge");
    expect(edges.map((edge) => edge.getAttribute("data-edge-id")).sort()).toEqual(["B->A", "C->B"]);
    for (const edge of edges) {
      expectEdgePaintsViaResolvableStyle(edge);
    }
  });

  it("does not render an edge when a dependency target is filtered out", () => {
    const doneDependency = { ...createTask("Done"), column: "done" as const };
    render(<DependencyGraph tasks={[createTask("Visible", ["Done"]), doneDependency]} onOpenDetail={vi.fn()} />);

    expect(screen.queryAllByTestId("dependency-edge")).toHaveLength(0);
  });

  it("highlights only isolated node with no dependencies", () => {
    render(<DependencyGraph tasks={[createTask("X")]} onOpenDetail={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-X"));
    expect(screen.getByTestId("graph-task-node-X").className).toContain("graph-task-node--highlighted");
  });
});
