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

function expectEdgePaintsViaResolvableStyle(edge: SVGElement, expectedStroke: string, expectedStrokeWidth: string) {
  expect(edge.getAttribute("stroke")).not.toBe(expectedStroke);
  expect(edge.getAttribute("stroke-width")).not.toBe(expectedStrokeWidth);
  expect(edge.getAttribute("strokeWidth")).not.toBe(expectedStrokeWidth);
  expect(edge.style.stroke).toBe(expectedStroke);
  expect(edge.style.strokeWidth).toBe(expectedStrokeWidth);
}

describe("GraphEdges", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders single edge", () => {
    renderEdges([{ source: "A", target: "B" }]);
    const edge = screen.getAllByTestId("dependency-edge")[0];
    expect(edge.getAttribute("opacity")).toBeNull();
    expectEdgePaintsViaResolvableStyle(edge, "var(--border)", "var(--btn-border-width)");
  });

  it("renders no edge paths when there are zero edges", () => {
    renderEdges([]);
    expect(screen.queryAllByTestId("dependency-edge")).toHaveLength(0);
  });

  it("renders arrowhead fill through resolvable style instead of a presentation attribute", () => {
    const { container } = renderEdges([{ source: "A", target: "B" }]);
    const arrowheadPath = container.querySelector("#dependency-graph-arrowhead path") as SVGPathElement | null;

    expect(arrowheadPath).not.toBeNull();
    expect(arrowheadPath?.getAttribute("fill")).not.toBe("var(--border)");
    expect(arrowheadPath?.style.fill).toBe("var(--border)");
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

    expect(highlighted).toBeDefined();
    expect(highlighted?.style.opacity).toBe("1");
    expectEdgePaintsViaResolvableStyle(highlighted as SVGElement, "var(--todo)", "var(--space-xs)");
    expect(highlighted?.getAttribute("class") ?? "").toContain("graph-edge--highlighted");
    expect(dimmed).toBeDefined();
    expect(dimmed?.style.opacity).toBe("0.15");
    expectEdgePaintsViaResolvableStyle(dimmed as SVGElement, "var(--border)", "var(--btn-border-width)");
    expect(dimmed?.getAttribute("class") ?? "").toContain("graph-edge--dimmed");
  });
});
