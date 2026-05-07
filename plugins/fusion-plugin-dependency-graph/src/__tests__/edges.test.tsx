import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GraphEdges } from "../edges";
import type { GraphEdge } from "../types";

function renderEdges(edges: GraphEdge[], highlightedEdgeIds?: Set<string>) {
  const positions = new Map([
    ["A", { x: 0, y: 0 }],
    ["B", { x: 320, y: 180 }],
    ["C", { x: 640, y: 180 }],
  ]);

  return render(
    <GraphEdges
      edges={edges}
      positions={positions}
      highlightedEdgeIds={highlightedEdgeIds}
    />,
  );
}

describe("GraphEdges", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders single edge", () => {
    renderEdges([{ source: "A", target: "B" }]);
    const edge = screen.getAllByTestId("dependency-edge")[0];
    expect(edge.getAttribute("opacity")).toBe("1");
    expect(edge.getAttribute("stroke")).toBe("var(--border)");
  });

  it("renders multiple edges", () => {
    renderEdges([
      { source: "A", target: "B" },
      { source: "A", target: "C" },
    ]);
    expect(screen.getAllByTestId("dependency-edge")).toHaveLength(2);
  });

  it("supports edges with same source", () => {
    renderEdges([
      { source: "A", target: "B" },
      { source: "A", target: "C" },
    ]);
    expect(screen.getAllByTestId("dependency-edge")).toHaveLength(2);
  });

  it("supports edges with same target", () => {
    renderEdges([
      { source: "B", target: "A" },
      { source: "C", target: "A" },
    ]);
    expect(screen.getAllByTestId("dependency-edge")).toHaveLength(2);
  });

  it("dims non-highlighted edges when highlight set provided", () => {
    renderEdges(
      [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
      ],
      new Set(["A->B"]),
    );

    const all = screen.getAllByTestId("dependency-edge");
    const highlighted = all.find((edge) => edge.getAttribute("data-edge-id") === "A->B");
    const dimmed = all.find((edge) => edge.getAttribute("data-edge-id") === "A->C");

    expect(highlighted?.getAttribute("opacity")).toBe("1");
    expect(highlighted?.getAttribute("class") ?? "").toContain("graph-edge--highlighted");
    expect(dimmed?.getAttribute("opacity")).toBe("0.15");
    expect(dimmed?.getAttribute("class") ?? "").toContain("graph-edge--dimmed");
  });
});
