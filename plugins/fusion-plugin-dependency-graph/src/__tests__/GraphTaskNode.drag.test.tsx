import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import type { Task } from "@fusion/core";
import { GraphTaskNode } from "../GraphTaskNode";

function task(id = "FN-1"): Task {
  return { id, description: id, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [] } as Task;
}

function props(overrides: Partial<React.ComponentProps<typeof GraphTaskNode>> = {}): React.ComponentProps<typeof GraphTaskNode> {
  return {
    task: task(),
    projectId: "p1",
    position: { x: 0, y: 0 },
    scale: 1,
    isHighlighted: false,
    isDimmed: false,
    onNodePositionChange: vi.fn(),
    onNodeDragStateChange: vi.fn(),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onUpdateTask: vi.fn(),
    onArchiveTask: vi.fn(),
    onUnarchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onRetryTask: vi.fn(),
    onOpenDetailWithTab: vi.fn(),
    onMoveTask: vi.fn(),
    onOpenMission: vi.fn(),
    taskStuckTimeoutMs: 1000,
    lastFetchTimeMs: Date.now(),
    workflowStepNameLookup: new Map<string, string>(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("GraphTaskNode drag", () => {
  it("applies dragging class only after threshold move", () => {
    const onNodePositionChange = vi.fn();
    render(<GraphTaskNode {...props({ onNodePositionChange })} />);
    const node = screen.getByTestId("graph-task-node-FN-1");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 12, clientY: 12, isPrimary: true });
    expect(node.className).not.toContain("graph-node--dragging");

    fireEvent.pointerMove(node, { pointerId: 1, clientX: 20, clientY: 20, isPrimary: true });
    expect(node.className).toContain("graph-node--dragging");
    expect(onNodePositionChange).toHaveBeenCalled();

    fireEvent.pointerUp(node, { pointerId: 1, clientX: 20, clientY: 20, isPrimary: true });
    expect(node.className).not.toContain("graph-node--dragging");
  });

  it("composes highlight and dragging classes", () => {
    render(<GraphTaskNode {...props({ isHighlighted: true })} />);
    const node = screen.getByTestId("graph-task-node-FN-1");
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 0, clientY: 0, isPrimary: true });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true });

    expect(node.className).toContain("graph-task-node--highlighted");
    expect(node.className).toContain("graph-node--dragging");
  });
});
