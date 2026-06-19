import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileWorkflowGraphView } from "../MobileWorkflowGraphView";
import type { MobileWorkflowNodeSummary } from "../workflow-mobile-graph";

const rows: MobileWorkflowNodeSummary[] = [
  {
    id: "start",
    label: "Start",
    kind: "start",
    summary: "",
    editable: false,
    outgoing: [{ id: "e1", source: "start", target: "prompt", targetLabel: "Prompt", label: "success" }],
    children: [],
  },
  {
    id: "prompt",
    label: "Prompt",
    kind: "prompt",
    summary: "Draft prompt",
    editable: true,
    outgoing: [],
    children: [],
  },
  {
    id: "loop",
    label: "Review loop",
    kind: "loop",
    summary: "3x",
    editable: true,
    outgoing: [],
    children: [
      {
        id: "loop::child-a",
        label: "Loop step A",
        kind: "prompt",
        summary: "Not configured",
        editable: true,
        parentId: "loop",
        templateLocalId: "child-a",
        outgoing: [],
        children: [],
      },
      {
        id: "loop::child-b",
        label: "Loop step B",
        kind: "script",
        summary: "Not configured",
        editable: true,
        parentId: "loop",
        templateLocalId: "child-b",
        outgoing: [],
        children: [],
      },
    ],
  },
  {
    id: "end",
    label: "End",
    kind: "end",
    summary: "",
    editable: false,
    outgoing: [],
    children: [],
  },
];

describe("MobileWorkflowGraphView", () => {
  it("renders graph rows and selects nodes and edges", () => {
    const onSelectNode = vi.fn();
    const onSelectEdge = vi.fn();
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
      />,
    );

    fireEvent.click(within(screen.getByTestId("mobile-wf-node-start")).getByRole("button", { name: /start/i }));
    expect(onSelectNode).toHaveBeenCalledWith("start");

    fireEvent.click(screen.getByTestId("mobile-wf-edge-e1"));
    expect(onSelectEdge).toHaveBeenCalledWith("e1");
  });

  it("expands grouped template children", () => {
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId="loop"
        selectedEdgeId={null}
        onSelectNode={() => {}}
        onSelectEdge={() => {}}
      />,
    );

    expect(screen.getByTestId("mobile-wf-node-loop::child-a")).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("mobile-wf-node-loop")).getByRole("button", { name: /collapse/i }));
    expect(screen.queryByTestId("mobile-wf-node-loop::child-a")).not.toBeInTheDocument();
  });

  it("exposes move controls for editable sibling rows and calls the move callback", () => {
    const onMoveNode = vi.fn();
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={() => {}}
        onSelectEdge={() => {}}
        canReorder
        onMoveNode={onMoveNode}
      />,
    );

    expect(screen.queryByTestId("mobile-wf-node-move-up-start")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-wf-node-move-up-prompt")).toBeDisabled();
    fireEvent.click(screen.getByTestId("mobile-wf-node-move-down-prompt"));
    expect(onMoveNode).toHaveBeenCalledWith("prompt", "down");

    fireEvent.click(screen.getByTestId("mobile-wf-node-move-up-loop"));
    expect(onMoveNode).toHaveBeenCalledWith("loop", "up");
    expect(screen.getByTestId("mobile-wf-node-move-down-loop")).toBeDisabled();
    expect(screen.queryByTestId("mobile-wf-node-move-down-end")).not.toBeInTheDocument();
  });

  it("hides move controls for read-only built-ins without empty action shells", () => {
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={() => {}}
        onSelectEdge={() => {}}
        canReorder={false}
        onMoveNode={() => {}}
      />,
    );

    expect(screen.queryByTestId(/mobile-wf-node-move-/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId("mobile-wf-node-prompt")).queryByRole("button", { name: /move/i })).not.toBeInTheDocument();
  });

  it("renders template-child move controls with child-level boundaries", () => {
    const onMoveNode = vi.fn();
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={() => {}}
        onSelectEdge={() => {}}
        canReorder
        onMoveNode={onMoveNode}
      />,
    );

    expect(screen.getByTestId("mobile-wf-node-move-up-loop::child-a")).toBeDisabled();
    fireEvent.click(screen.getByTestId("mobile-wf-node-move-down-loop::child-a"));
    expect(onMoveNode).toHaveBeenCalledWith("loop::child-a", "down");
    fireEvent.click(screen.getByTestId("mobile-wf-node-move-up-loop::child-b"));
    expect(onMoveNode).toHaveBeenCalledWith("loop::child-b", "up");
    expect(screen.getByTestId("mobile-wf-node-move-down-loop::child-b")).toBeDisabled();
  });

  it("proves the simple editor reorder symptom is gone through callback controls", () => {
    const onMoveNode = vi.fn();
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={() => {}}
        onSelectEdge={() => {}}
        canReorder
        onMoveNode={onMoveNode}
      />,
    );

    const movePromptDown = within(screen.getByTestId("mobile-wf-node-prompt")).getByRole("button", { name: "Move down" });
    fireEvent.click(movePromptDown);

    expect(onMoveNode).toHaveBeenCalledWith("prompt", "down");
  });
});
