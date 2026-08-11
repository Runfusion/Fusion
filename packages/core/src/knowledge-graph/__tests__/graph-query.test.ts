import { describe, expect, it } from "vitest";
import { neighbors, queryNodes, shortestPath } from "../graph-query.js";
import type { KnowledgeGraph } from "../graph-types.js";
const graph: KnowledgeGraph = { schemaVersion: 2, nodes: ["a", "b", "c"].map(id => ({id,kind:"file",name:id,owner:"file",ownerPath:id,source:{path:id,line:1,column:1},attributes:{}})), edges: ["a-b", "b-c"].map((id,index) => ({id,kind:"contains" as const,from:index ? "b" : "a",to:index ? "c" : "b",provenance:"extracted" as const,owner:"file" as const,ownerPath:"a",source:{path:"a",line:1,column:1},attributes:{}})) };
describe("knowledge graph queries", () => {
  it("filters, traverses, and exposes edge provenance", () => {
    expect(queryNodes(graph, { idPrefix: "b" }).map(node => node.id)).toEqual(["b"]);
    expect(neighbors(graph, "a", { depth: 2 }).map(result => result.node.id)).toEqual(["b", "c"]);
    expect(neighbors(graph, "a", { direction: "both", depth: 2 })[0]!.edges[0]!.provenance).toBe("extracted");
    expect(shortestPath(graph, "a", "c")?.nodes.map(node => node.id)).toEqual(["a", "b", "c"]);
    expect(() => shortestPath(graph, "a", "missing")).toThrow();
  });
});
