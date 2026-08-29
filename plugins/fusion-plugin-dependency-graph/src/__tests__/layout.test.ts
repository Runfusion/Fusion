import { describe, expect, it } from "vitest";
import type { GraphData } from "../types";
import { computeAutoLayout } from "../layout";

function graph(nodeIds: string[], edges: Array<{ source: string; target: string }> = []): GraphData {
  return {
    nodes: nodeIds.map((id) => ({ task: { id } as never })),
    edges,
  };
}

describe("computeAutoLayout", () => {
  it("returns empty map for empty graph", () => {
    expect(computeAutoLayout({ nodes: [], edges: [] }).size).toBe(0);
  });

  it("positions single node", () => {
    const positions = computeAutoLayout(graph(["A"]));
    expect(positions.has("A")).toBe(true);
  });

  it("places linear chain in increasing depth", () => {
    const positions = computeAutoLayout(graph(["A", "B", "C"], [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ]));

    expect((positions.get("C")?.y ?? 0)).toBeLessThan(positions.get("B")?.y ?? 0);
    expect((positions.get("B")?.y ?? 0)).toBeLessThan(positions.get("A")?.y ?? 0);
  });

  it("spreads wide layer horizontally", () => {
    const positions = computeAutoLayout(graph(["A", "B", "C"]));
    const xs = [positions.get("A")?.x, positions.get("B")?.x, positions.get("C")?.x].filter((x): x is number => x !== undefined);
    expect(new Set(xs).size).toBe(3);
  });

  it("handles diamond dependencies", () => {
    const positions = computeAutoLayout(graph(["A", "B", "C", "D"], [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "B", target: "D" },
      { source: "C", target: "D" },
    ]));

    expect((positions.get("D")?.y ?? 0)).toBeLessThan(positions.get("B")?.y ?? 0);
    expect((positions.get("D")?.y ?? 0)).toBeLessThan(positions.get("C")?.y ?? 0);
    expect((positions.get("B")?.y ?? 0)).toBeLessThan(positions.get("A")?.y ?? 0);
    expect((positions.get("C")?.y ?? 0)).toBeLessThan(positions.get("A")?.y ?? 0);
  });

  it("handles cycles without crashing", () => {
    const positions = computeAutoLayout(graph(["A", "B"], [
      { source: "A", target: "B" },
      { source: "B", target: "A" },
    ]));

    expect(positions.size).toBe(2);
  });

  it("respects custom spacing options", () => {
    const positions = computeAutoLayout(graph(["A", "B"]), {
      nodeWidth: 200,
      nodeHeight: 120,
      horizontalGap: 100,
      verticalGap: 20,
    });
    expect(Math.abs((positions.get("A")?.x ?? 0) - (positions.get("B")?.x ?? 0))).toBe(300);
  });

  describe("vertical orientation with measured heights", () => {
    it("adds cumulative row offsets from measured layer heights", () => {
      const verticalGap = 80;
      const nodeHeight = 100;
      const positions = computeAutoLayout(
        graph(["A", "B", "C"], [
          { source: "A", target: "B" },
          { source: "B", target: "C" },
        ]),
        {
          orientation: "vertical",
          nodeHeight,
          verticalGap,
          measuredHeights: new Map([["C", 300]]),
        },
      );

      const aY = positions.get("A")?.y ?? 0;
      const bY = positions.get("B")?.y ?? 0;
      const cY = positions.get("C")?.y ?? 0;
      expect(bY).toBeGreaterThanOrEqual(cY + 300 + verticalGap);
      expect(aY).toBeGreaterThanOrEqual(bY + nodeHeight + verticalGap);
    });

    it("uses per-layer max measured heights for wide layers", () => {
      const verticalGap = 80;
      const nodeHeight = 100;
      const positions = computeAutoLayout(
        graph(["A", "B", "C", "D"], [
          { source: "C", target: "A" },
          { source: "D", target: "A" },
        ]),
        {
          orientation: "vertical",
          nodeHeight,
          verticalGap,
          measuredHeights: new Map([
            ["A", 140],
            ["B", 220],
          ]),
        },
      );

      expect(positions.get("A")?.y).toBe(0);
      expect(positions.get("B")?.y).toBe(0);
      const expectedDepthOneY = 220 + verticalGap;
      expect(positions.get("C")?.y).toBe(expectedDepthOneY);
      expect(positions.get("D")?.y).toBe(expectedDepthOneY);
    });

    it.each([
      { nodeHeight: 100, verticalGap: 80 },
      { nodeHeight: 140, verticalGap: 24 },
    ])("matches fixed-height behavior when no measurements exist (%o)", ({ nodeHeight, verticalGap }) => {
      const graphData = graph(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ]);
      const withoutHeights = computeAutoLayout(graphData, { orientation: "vertical", nodeHeight, verticalGap });
      const emptyHeights = computeAutoLayout(graphData, {
        orientation: "vertical",
        nodeHeight,
        verticalGap,
        measuredHeights: new Map(),
      });

      expect(Array.from(withoutHeights.entries())).toEqual(Array.from(emptyHeights.entries()));
    });
  });

  describe("horizontal orientation with measured heights", () => {
    it("uses measured heights as the stacking stride for each preceding node", () => {
      const nodeHeight = 100;
      const verticalGap = 80;
      const measuredHeights = new Map<string, number>([
        ["A", 200],
        ["B", 300],
      ]);
      const positions = computeAutoLayout(graph(["A", "B", "C"]), {
        orientation: "horizontal",
        nodeHeight,
        verticalGap,
        measuredHeights,
      });

      const ordered = ["A", "B", "C"].map((id) => ({
        id,
        y: positions.get(id)?.y ?? 0,
        height: measuredHeights.get(id) ?? nodeHeight,
      }));

      expect(ordered[1].y - ordered[0].y).toBe(ordered[0].height + verticalGap);
      expect(ordered[2].y - ordered[1].y).toBe(ordered[1].height + verticalGap);
      expect(ordered[0].y + ordered[0].height + verticalGap).toBe(ordered[1].y);
      expect(ordered[1].y + ordered[1].height + verticalGap).toBe(ordered[2].y);
    });

    it("keeps adjacent card gaps exactly equal to verticalGap when all nodes are measured", () => {
      const nodeHeight = 100;
      const verticalGap = 64;
      const measuredHeights = new Map<string, number>([
        ["A", 180],
        ["B", 220],
        ["C", 260],
      ]);
      const positions = computeAutoLayout(graph(["A", "B", "C"]), {
        orientation: "horizontal",
        nodeHeight,
        verticalGap,
        measuredHeights,
      });

      const ordered = ["A", "B", "C"].map((id) => ({
        y: positions.get(id)?.y ?? 0,
        height: measuredHeights.get(id) ?? nodeHeight,
      }));

      expect(ordered[1].y - (ordered[0].y + ordered[0].height)).toBe(verticalGap);
      expect(ordered[2].y - (ordered[1].y + ordered[1].height)).toBe(verticalGap);
    });

    it.each([
      { nodeHeight: 100, verticalGap: 80 },
      { nodeHeight: 140, verticalGap: 24 },
    ])("matches fixed-stride behavior when no measurements exist (%o)", ({ nodeHeight, verticalGap }) => {
      const graphData = graph(["A", "B", "C"]);
      const withoutHeights = computeAutoLayout(graphData, {
        orientation: "horizontal",
        nodeHeight,
        verticalGap,
      });
      const emptyHeights = computeAutoLayout(graphData, {
        orientation: "horizontal",
        nodeHeight,
        verticalGap,
        measuredHeights: new Map(),
      });

      expect(Array.from(withoutHeights.entries())).toEqual(Array.from(emptyHeights.entries()));
    });
  });

  describe("horizontal orientation", () => {
    it("places linear chain in increasing depth along x", () => {
      const positions = computeAutoLayout(
        graph(["A", "B", "C"], [
          { source: "A", target: "B" },
          { source: "B", target: "C" },
        ]),
        { orientation: "horizontal" },
      );

      expect((positions.get("C")?.x ?? 0)).toBeLessThan(positions.get("B")?.x ?? 0);
      expect((positions.get("B")?.x ?? 0)).toBeLessThan(positions.get("A")?.x ?? 0);
      expect(positions.get("A")?.y).toBe(positions.get("B")?.y);
      expect(positions.get("B")?.y).toBe(positions.get("C")?.y);
    });

    it("spreads wide layer vertically", () => {
      const positions = computeAutoLayout(graph(["A", "B", "C"]), { orientation: "horizontal" });
      const ys = [positions.get("A")?.y, positions.get("B")?.y, positions.get("C")?.y].filter((y): y is number => y !== undefined);
      const xs = [positions.get("A")?.x, positions.get("B")?.x, positions.get("C")?.x].filter((x): x is number => x !== undefined);

      expect(new Set(ys).size).toBe(3);
      expect(new Set(xs).size).toBe(1);
    });

    it("handles diamond dependencies mirrored onto x", () => {
      const positions = computeAutoLayout(
        graph(["A", "B", "C", "D"], [
          { source: "A", target: "B" },
          { source: "A", target: "C" },
          { source: "B", target: "D" },
          { source: "C", target: "D" },
        ]),
        { orientation: "horizontal" },
      );

      expect((positions.get("D")?.x ?? 0)).toBeLessThan(positions.get("B")?.x ?? 0);
      expect((positions.get("D")?.x ?? 0)).toBeLessThan(positions.get("C")?.x ?? 0);
      expect((positions.get("B")?.x ?? 0)).toBeLessThan(positions.get("A")?.x ?? 0);
      expect((positions.get("C")?.x ?? 0)).toBeLessThan(positions.get("A")?.x ?? 0);
    });

    it("handles cycles without crashing", () => {
      const positions = computeAutoLayout(
        graph(["A", "B"], [
          { source: "A", target: "B" },
          { source: "B", target: "A" },
        ]),
        { orientation: "horizontal" },
      );

      expect(positions.size).toBe(2);
    });
  });
});
