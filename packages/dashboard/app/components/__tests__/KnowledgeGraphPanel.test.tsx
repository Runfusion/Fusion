import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgeGraphPanel } from "../KnowledgeGraphPanel";

const useKnowledgeGraph = vi.fn();
vi.mock("../../hooks/useKnowledgeGraph.js", () => ({ useKnowledgeGraph: (...args: unknown[]) => useKnowledgeGraph(...args) }));
const selectNode = vi.fn();
const setFilters = vi.fn();
const setNeighborOptions = vi.fn();
const setPathInput = vi.fn();

const node = { id: "symbol:src/a.ts#run", kind: "symbol" as const, name: "run", owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 4, column: 1 }, attributes: {} };
const edge = { id: "e-1", kind: "contains" as const, from: "file:src/a.ts", to: node.id, provenance: "extracted" as const, owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} };
function graph(overrides: Record<string, unknown> = {}) { return { status: { available: true, nodeCount: 2, edgeCount: 1, graphDir: ".fusion-knowledge/graph", nodeKindCounts: { symbol: 1 }, edgeKindCounts: { contains: 1 }, provenanceCounts: { extracted: 1, inferred: 0 }, fnxcAreas: ["Memory"], pathLimits: { defaultMaxHops: 6, maxHops: 10, maxExpansions: 20000 } }, filters: { limit: 50, offset: 0 }, setFilters, nodes: { nodes: [node], total: 1, limit: 50, offset: 0 }, loading: false, selectedId: node.id, detail: { node, outgoing: [edge], incoming: [edge], outgoingTotal: 1, incomingTotal: 1 }, selectNode, neighborOptions: { direction: "both", depth: 1, edgeKinds: [] }, setNeighborOptions, neighborResults: { neighbors: [{ node, distance: 1, edges: [edge] }], total: 1 }, refreshNeighbors: vi.fn(), pathInput: { fromId: "file:src/a.ts", toId: node.id, maxHops: 2 }, setPathInput, pathResult: null, findPath: vi.fn(), rebuild: vi.fn(), rebuilding: false, refreshStatus: vi.fn(), error: null, clearFilters: vi.fn(), ...overrides }; }

describe("KnowledgeGraphPanel", () => {
  it("renders status, complete filters, detail provenance, and drills through endpoints", async () => {
    useKnowledgeGraph.mockReturnValue(graph());
    render(<KnowledgeGraphPanel addToast={vi.fn()} />);
    expect(screen.getByText("2 nodes · 1 edges")).toBeInTheDocument();
    const symbolKind = screen.getByLabelText("Symbol kind");
    expect(symbolKind).toBeInTheDocument();
    expect(Array.from((symbolKind as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      "", "function", "class", "interface", "type-alias", "enum", "variable", "namespace", "alias",
    ]);
    expect(screen.getByLabelText("Owner")).toBeInTheDocument();
    expect(screen.getByLabelText("Result limit")).toBeInTheDocument();
    expect(screen.getAllByText("extracted").length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole("button", { name: node.id })[0]);
    expect(selectNode).toHaveBeenCalledWith(node.id);
  });

  it("distinguishes unavailable graph, empty search, and all path outcomes", () => {
    useKnowledgeGraph.mockReturnValue(graph({ status: { ...graph().status, available: false, recoveryReason: "missing-artifact" } }));
    const { rerender } = render(<KnowledgeGraphPanel addToast={vi.fn()} />);
    expect(screen.getByTestId("knowledge-graph-no-graph")).toHaveTextContent("missing-artifact");
    useKnowledgeGraph.mockReturnValue(graph({ status: null, error: "Request failed" }));
    rerender(<KnowledgeGraphPanel addToast={vi.fn()} />);
    expect(screen.getByTestId("knowledge-graph-error")).toHaveTextContent("Request failed");
    useKnowledgeGraph.mockReturnValue(graph({ nodes: { nodes: [], total: 0, limit: 50, offset: 0 } }));
    rerender(<KnowledgeGraphPanel addToast={vi.fn()} />);
    expect(screen.getByTestId("knowledge-graph-no-results")).toBeInTheDocument();
    for (const [result, id] of [[{ outcome: "found", path: { nodes: [node], edges: [] }, hops: 0, maxHops: 2, expansions: 1, truncated: false }, "knowledge-graph-path-found"], [{ outcome: "not-found", path: null, maxHops: 2, expansions: 2, truncated: false }, "knowledge-graph-path-not-found"], [{ outcome: "limit-reached", path: null, maxHops: 2, expansions: 2, truncated: true, limit: "max-hops" }, "knowledge-graph-path-limit-reached"]] as const) {
      useKnowledgeGraph.mockReturnValue(graph({ pathResult: result }));
      rerender(<KnowledgeGraphPanel addToast={vi.fn()} />);
      expect(screen.getByTestId(id)).toBeInTheDocument();
      if (id === "knowledge-graph-path-found") expect(screen.getByTestId(id)).toHaveTextContent("0 hops");
    }
    useKnowledgeGraph.mockReturnValue(graph({ error: "Unknown graph node" })); rerender(<KnowledgeGraphPanel addToast={vi.fn()} />); expect(screen.getByTestId("knowledge-graph-path-error")).toHaveTextContent("Unknown graph node");
  });
});
