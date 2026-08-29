// @vitest-environment node
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { KnowledgeGraphError } from "@fusion/core";

const access = vi.hoisted(() => ({ load: vi.fn(), resolve: vi.fn(), rebuild: vi.fn(), path: vi.fn() }));
vi.mock("../../knowledge-graph-access.js", () => ({
  loadProjectKnowledgeGraph: access.load, resolveProjectGraphDir: access.resolve, rebuildProjectKnowledgeGraph: access.rebuild, findBoundedShortestPath: access.path,
  KNOWLEDGE_GRAPH_PATH_DEFAULT_HOPS: 6, KNOWLEDGE_GRAPH_PATH_MAX_HOPS: 10, KNOWLEDGE_GRAPH_PATH_MAX_EXPANSIONS: 20_000,
}));
import { registerKnowledgeRoutes } from "../register-knowledge-routes.js";

const source = { path: "src/a.ts", line: 1, column: 1 };
const nodes = [
  { id: "file:src/a.ts", kind: "file", name: "a.ts", owner: "file", ownerPath: "src/a.ts", source, attributes: {} },
  { id: "symbol:src/a.ts#run", kind: "symbol", name: "run", owner: "file", ownerPath: "src/a.ts", source, attributes: { symbolKind: "function", fnxcArea: "Memory" } },
  { id: "module:src", kind: "module", name: "src", owner: "derived", ownerPath: "src", source, attributes: {} },
];
const edges = [
  { id: "edge-in", kind: "contains", from: "file:src/a.ts", to: "symbol:src/a.ts#run", provenance: "extracted", owner: "file", ownerPath: "src/a.ts", source, attributes: {} },
  { id: "edge-out", kind: "imports", from: "symbol:src/a.ts#run", to: "module:src", provenance: "inferred", owner: "derived", ownerPath: "src", source, attributes: {} },
];
const graph = { schemaVersion: 1, nodes, edges };
function app() {
  const router = express.Router();
  registerKnowledgeRoutes({ router, getScopedStore: vi.fn(async () => ({ getRootDir: () => "/project", getSettings: async () => ({}) })), rethrowAsApiError: (error: unknown) => { throw error; } } as never);
  const result = express(); result.use(express.json()); result.use("/api", router);
  result.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message }));
  return result;
}
beforeEach(() => { vi.clearAllMocks(); access.resolve.mockResolvedValue("/project/.fusion-knowledge/graph"); access.load.mockResolvedValue({ ok: true, graph }); });

describe("knowledge graph routes", () => {
  it("reports missing graph availability and applies all bounded search validation", async () => {
    const server = app();
    access.load.mockResolvedValueOnce({ ok: false, recoveryReason: "missing-artifact" });
    expect((await performRequest(server, "GET", "/api/knowledge/graph/status")).body).toMatchObject({ available: false, recoveryReason: "missing-artifact", pathLimits: { maxHops: 10 } });
    const search = await performRequest(server, "GET", "/api/knowledge/graph/nodes?limit=999&kinds=symbol&pathPrefix=src&idPrefix=symbol%3A&namePattern=run&fnxcArea=Memory&symbolKind=function&owner=file");
    expect(search.body).toMatchObject({ total: 1, limit: 200 });
    for (const invalid of ["kinds=nope", "owner=nope", "symbolKind=nope", "namePattern=%5B"]) expect((await performRequest(server, "GET", `/api/knowledge/graph/nodes?${invalid}`)).status).toBe(400);
  });

  it("returns capped node detail and validates bounded neighbor traversal", async () => {
    const server = app();
    const detail = await performRequest(server, "GET", "/api/knowledge/graph/node?id=symbol%3Asrc%2Fa.ts%23run");
    expect(detail.status).toBe(200); expect(detail.body).toMatchObject({ node: { id: "symbol:src/a.ts#run" }, incomingTotal: 1, outgoingTotal: 1 });
    expect((await performRequest(server, "GET", "/api/knowledge/graph/node?id=missing")).status).toBe(404);
    const neighbors = await performRequest(server, "GET", "/api/knowledge/graph/neighbors?nodeId=symbol%3Asrc%2Fa.ts%23run&direction=both&edgeKinds=imports&depth=99&limit=1");
    expect(neighbors.status).toBe(200); expect((neighbors.body as any).neighbors).toHaveLength(1);
    expect((await performRequest(server, "GET", "/api/knowledge/graph/neighbors?nodeId=file%3Asrc%2Fa.ts&direction=sideways")).status).toBe(400);
    expect((await performRequest(server, "GET", "/api/knowledge/graph/neighbors?nodeId=missing")).status).toBe(404);
  });

  it("passes all bounded path outcomes and parameter normalization through unchanged", async () => {
    const server = app();
    access.path.mockReturnValueOnce({ outcome: "found", path: { nodes: [nodes[0]], edges: [] }, hops: 0, maxHops: 10, expansions: 1, truncated: false });
    const found = await performRequest(server, "GET", "/api/knowledge/graph/path?fromId=a&toId=b&maxHops=99");
    expect(found.body).toMatchObject({ outcome: "found", hops: 0 }); expect(access.path).toHaveBeenLastCalledWith(graph, "a", "b", { maxHops: 10 });
    access.path.mockReturnValueOnce({ outcome: "not-found", path: null, maxHops: 6, expansions: 2, truncated: false });
    expect((await performRequest(server, "GET", "/api/knowledge/graph/path?fromId=a&toId=b&maxHops=wat")).body).toMatchObject({ outcome: "not-found", truncated: false });
    expect(access.path).toHaveBeenLastCalledWith(graph, "a", "b", { maxHops: 6 });
    access.path.mockReturnValueOnce({ outcome: "limit-reached", path: null, maxHops: 2, expansions: 2, truncated: true, limit: "max-hops" });
    expect((await performRequest(server, "GET", "/api/knowledge/graph/path?fromId=a&toId=b&maxHops=2")).body).toMatchObject({ outcome: "limit-reached", truncated: true, limit: "max-hops" });
    access.path.mockImplementationOnce(() => { throw new KnowledgeGraphError("Unknown graph node"); });
    expect((await performRequest(server, "GET", "/api/knowledge/graph/path?fromId=missing&toId=b")).status).toBe(404);
  });

  it("uses the explicit build path once and returns its stats", async () => {
    access.rebuild.mockResolvedValue({ changed: true, nodes: 3, edges: 2, stats: { parsedFiles: 2 } });
    const response = await performRequest(app(), "POST", "/api/knowledge/graph/build", JSON.stringify({ force: true }), { "content-type": "application/json" });
    expect(response.body).toMatchObject({ changed: true, nodes: 3, edges: 2 });
    expect(access.rebuild).toHaveBeenCalledTimes(1); expect(access.rebuild.mock.calls[0]?.[1]).toEqual({ force: true });
  });
});
