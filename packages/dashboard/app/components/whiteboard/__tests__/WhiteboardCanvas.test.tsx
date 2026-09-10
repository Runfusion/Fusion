import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WhiteboardDocument } from "@fusion/core";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlow: ({ nodes, edges, nodeTypes, onConnect, onSelectionChange }: {
      nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>;
      edges: Array<{ id: string; data?: Record<string, unknown> }>;
      nodeTypes: Record<string, React.ComponentType<{ data: Record<string, unknown> }>>;
      onConnect: (connection: { source: string; target: string }) => void;
      onSelectionChange: (selection: { nodes: unknown[]; edges: unknown[] }) => void;
    }) => <div data-testid="react-flow">
      {nodes.map((node) => {
        const Component = node.type ? nodeTypes[node.type] : undefined;
        return <div key={node.id}>
          <button type="button" aria-label={`Select node ${node.id}`} onClick={() => onSelectionChange({ nodes: [node], edges: [] })} />
          {Component ? <Component data={node.data} /> : null}
        </div>;
      })}
      {edges.map((edge) => <button key={edge.id} type="button" aria-label={`Select edge ${edge.id}`} onClick={() => onSelectionChange({ nodes: [], edges: [edge] })} />)}
      <button type="button" aria-label="Connect source to second target" onClick={() => onConnect({ source: "source", target: "target-two" })} />
    </div>,
  };
});

import { WhiteboardCanvas } from "../WhiteboardCanvas";

const initialDocument = (): WhiteboardDocument => ({
  version: 1,
  frames: [{ id: "frame", type: "screen", x: 20, y: 20, width: 320, height: 220, title: "Screen" }],
  texts: [
    { id: "source", role: "title", text: "Decision", x: 20, y: 20 },
    { id: "target-one", role: "body", text: "First", x: 500, y: 20 },
    { id: "target-two", role: "body", text: "Second", x: 500, y: 180 },
  ],
  relations: [{ id: "relation", sourceId: "source", branches: [{ id: "branch-one", targetId: "target-one" }] }],
});

function renderCanvas(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  let latest = initialDocument();
  const onChange = vi.fn((document: WhiteboardDocument) => { latest = document; });
  render(<WhiteboardCanvas document={latest} onChange={onChange} />);
  return { onChange, latest: () => latest };
}

describe("WhiteboardCanvas", () => {
  it("construit et annote une relation multi-cibles depuis le vrai canvas desktop", () => {
    const view = renderCanvas(1280);
    fireEvent.change(screen.getByLabelText("Edit text source"), { target: { value: "Updated decision" } });
    expect(view.latest().texts.find((text) => text.id === "source")?.text).toBe("Updated decision");

    fireEvent.click(screen.getByLabelText("Select edge branch-one"));
    fireEvent.click(screen.getByRole("button", { name: "Add branch" }));
    expect(screen.getByRole("status")).toHaveTextContent("Connect the relation source");
    fireEvent.click(screen.getByRole("button", { name: "Connect source to second target" }));

    const relation = view.latest().relations[0]!;
    expect(relation.branches).toHaveLength(2);
    expect(relation.junction).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    const newBranch = relation.branches[1]!;
    fireEvent.click(screen.getByLabelText(`Select edge ${newBranch.id}`));
    fireEvent.change(screen.getByLabelText("Relation annotation"), { target: { value: "Choice" } });
    fireEvent.click(screen.getByRole("button", { name: "Oui" }));
    expect(view.latest().relations[0]).toMatchObject({ annotation: "Choice", branches: [{}, { id: newBranch.id, annotation: "Oui" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove annotation" }));
    expect(view.latest().relations[0]!.branches[1]!.annotation).toBeUndefined();
  });

  it("redimensionne un cadre et rattache un texte dans le vrai canvas mobile", () => {
    const view = renderCanvas(390);
    fireEvent.click(screen.getByLabelText("Select node frame"));
    fireEvent.change(screen.getByLabelText("Frame width"), { target: { value: "480" } });
    expect(view.latest().frames[0]!.width).toBe(480);

    fireEvent.click(screen.getByLabelText("Select node target-two"));
    fireEvent.change(screen.getByLabelText("Frame"), { target: { value: "frame" } });
    const attached = view.latest().texts.find((text) => text.id === "target-two")!;
    expect(attached.frameId).toBe("frame");
    expect(attached.x).toBe(480);
    fireEvent.change(screen.getByLabelText("Frame"), { target: { value: "" } });
    expect(view.latest().texts.find((text) => text.id === "target-two")?.frameId).toBeUndefined();
  });
});
