import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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
      nodes: Array<{ id: string; type?: string; selected?: boolean; data: Record<string, unknown> }>;
      edges: Array<{ id: string; selected?: boolean; data?: Record<string, unknown> }>;
      nodeTypes: Record<string, React.ComponentType<{ data: Record<string, unknown> }>>;
      onConnect: (connection: { source: string; target: string }) => void;
      onSelectionChange: (selection: { nodes: unknown[]; edges: unknown[] }) => void;
    }) => {
      const previousNodeCount = React.useRef(nodes.length);
      const modelSelectionListener = React.useRef(nodes.length === 0);
      const [selectionNotificationsActive, setSelectionNotificationsActive] = React.useState(false);
      React.useEffect(() => {
        if (modelSelectionListener.current && nodes.length > previousNodeCount.current) setSelectionNotificationsActive(true);
        previousNodeCount.current = nodes.length;
      }, [nodes.length]);
      const selectedNodes = nodes.filter((node) => node.selected);
      const selectedEdges = edges.filter((edge) => edge.selected);
      React.useEffect(() => {
        if (selectionNotificationsActive) onSelectionChange({ nodes: selectedNodes, edges: selectedEdges });
      }, [nodes, edges, onSelectionChange, selectionNotificationsActive]);
      return <div data-testid="react-flow">
        {nodes.map((node) => {
          const Component = node.type ? nodeTypes[node.type] : undefined;
          return <div key={node.id}>
            <button type="button" aria-label={`Select node ${node.id}`} aria-pressed={node.selected} onClick={() => onSelectionChange({ nodes: [node], edges: [] })} />
            {Component ? <Component data={node.data} /> : null}
          </div>;
        })}
        {edges.map((edge) => <button key={edge.id} type="button" aria-label={`Select edge ${edge.id}`} aria-pressed={edge.selected} onClick={() => onSelectionChange({ nodes: [], edges: [edge] })} />)}
        <button type="button" aria-label="Repeat projected selection" onClick={() => onSelectionChange({ nodes: selectedNodes, edges: selectedEdges })} />
        <button type="button" aria-label="Clear selection" onClick={() => onSelectionChange({ nodes: [], edges: [] })} />
        <button type="button" aria-label="Connect source to second target" onClick={() => onConnect({ source: "source", target: "target-two" })} />
      </div>;
    },
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

function ControlledCanvas({ initial, onPublish }: { initial: WhiteboardDocument; onPublish: (document: WhiteboardDocument) => void }) {
  const [document, setDocument] = useState(initial);
  return <WhiteboardCanvas document={document} onChange={(next) => { onPublish(next); setDocument(next); }} />;
}

function renderControlledCanvas(width: number, initial: WhiteboardDocument) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const onPublish = vi.fn();
  render(<ControlledCanvas initial={initial} onPublish={onPublish} />);
  return { onPublish, latest: () => onPublish.mock.calls.at(-1)?.[0] as WhiteboardDocument | undefined };
}

function renderCanvas(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  let latest = initialDocument();
  const onChange = vi.fn((document: WhiteboardDocument) => { latest = document; });
  render(<WhiteboardCanvas document={latest} onChange={onChange} />);
  return { onChange, latest: () => latest };
}

describe("WhiteboardCanvas", () => {
  it("adds one Idea through a controlled parent while selection notifications settle", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { onPublish } = renderControlledCanvas(1280, { version: 1, frames: [], texts: [], relations: [] });

    fireEvent.click(screen.getByRole("button", { name: "Idea" }));

    expect(onPublish).toHaveBeenCalledOnce();
    const published = onPublish.mock.calls[0]![0] as WhiteboardDocument;
    expect(published.texts).toHaveLength(1);
    expect(published.texts[0]).toMatchObject({ role: "idea" });
    expect(screen.getByLabelText(`Select node ${published.texts[0]!.id}`)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Text")).toHaveValue(published.texts[0]!.text);
    fireEvent.click(screen.getByRole("button", { name: "Repeat projected selection" }));
    expect(onPublish).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Text")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Editable idea" } });
    expect(onPublish).toHaveBeenCalledTimes(2);
    expect((onPublish.mock.calls[1]![0] as WhiteboardDocument).texts[0]?.text).toBe("Editable idea");
    expect(screen.getByTestId("react-flow")).toBeInTheDocument();
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/maximum update depth/i);
    consoleError.mockRestore();
  });

  it("adds every inspector text role exactly once on a populated mobile board", () => {
    const view = renderControlledCanvas(390, initialDocument());
    const roles = ["idea", "title", "body", "ui-label", "ui-control-placeholder"] as const;

    for (const role of roles) {
      const before = view.latest()?.texts.length ?? initialDocument().texts.length;
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".whiteboard-role-grid button"))
        .find((candidate) => candidate.textContent === role);
      expect(button).toBeDefined();
      fireEvent.click(button!);
      const latest = view.latest()!;
      expect(latest.texts).toHaveLength(before + 1);
      expect(latest.texts.at(-1)?.role).toBe(role);
      expect(view.onPublish).toHaveBeenCalledTimes(roles.indexOf(role) + 1);
    }

    const latest = view.latest()!;
    const added = latest.texts.at(-1)!;
    fireEvent.click(screen.getByLabelText(`Select node ${added.id}`));
    expect(view.onPublish).toHaveBeenCalledTimes(roles.length);
    fireEvent.change(screen.getByLabelText(`Edit text ${added.id}`), { target: { value: "Still responsive" } });
    expect(view.latest()?.texts.at(-1)?.text).toBe("Still responsive");
    expect(view.onPublish).toHaveBeenCalledTimes(roles.length + 1);
  });

  it.each([1280, 390])("keeps both text-add surfaces labeled and non-empty at %ipx", (width) => {
    renderCanvas(width);
    expect(screen.getByRole("button", { name: "Idea" })).toBeInTheDocument();
    const roleButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".whiteboard-role-grid button"));
    expect(roleButtons.map((button) => button.textContent)).toEqual(["idea", "title", "body", "ui-label", "ui-control-placeholder"]);
    expect(roleButtons.every((button) => Boolean(button.textContent?.trim()))).toBe(true);
  });

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
    expect(screen.getByLabelText(`Select edge ${newBranch.id}`)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByLabelText("Select node junction:relation"));
    expect(screen.getByLabelText("Select node junction:relation")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Select edge trunk:relation")).toHaveAttribute("aria-pressed", "true");
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
