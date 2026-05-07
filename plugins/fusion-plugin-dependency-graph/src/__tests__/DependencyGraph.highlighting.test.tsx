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

afterEach(() => {
  cleanup();
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

  it("applies edge dimming/highlighting and preserves click-to-detail", () => {
    const onOpenDetail = vi.fn();
    render(<DependencyGraph tasks={tasks} onOpenDetail={onOpenDetail} />);

    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-C"));
    const edges = screen.getAllByTestId("dependency-edge");
    const edgeAB = edges.find((edge) => edge.getAttribute("data-edge-id") === "B->A");
    const edgeCB = edges.find((edge) => edge.getAttribute("data-edge-id") === "C->B");

    expect(edgeAB?.className.baseVal || edgeAB?.className).toContain("graph-edge--highlighted");
    expect(edgeCB?.className.baseVal || edgeCB?.className).toContain("graph-edge--highlighted");

    fireEvent.click(screen.getByTestId("task-C"));
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "C" }));
  });

  it("highlights only isolated node with no dependencies", () => {
    render(<DependencyGraph tasks={[createTask("X")]} onOpenDetail={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId("graph-task-node-X"));
    expect(screen.getByTestId("graph-task-node-X").className).toContain("graph-task-node--highlighted");
  });
});
