import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ loadArtifacts: vi.fn(), buildKnowledgeGraph: vi.fn() }));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  loadArtifacts: core.loadArtifacts,
  buildKnowledgeGraph: core.buildKnowledgeGraph,
}));

import { KnowledgeGraphError, shortestPath, type KnowledgeGraph } from "@fusion/core";
import {
  __resetKnowledgeGraphCacheForTests,
  findBoundedShortestPath,
  loadProjectKnowledgeGraph,
  rebuildProjectKnowledgeGraph,
} from "../knowledge-graph-access.js";

const node = (id: string) => ({ id, kind: "file" as const, name: id, owner: "file" as const, ownerPath: id, source: { path: id, line: 1, column: 1 }, attributes: {} });
const edge = (id: string, from: string, to: string) => ({ id, kind: "contains" as const, from, to, provenance: "extracted" as const, owner: "file" as const, ownerPath: from, source: { path: from, line: 1, column: 1 }, attributes: {} });
function graph(ids: string[], links: Array<[string, string]>): KnowledgeGraph { return { schemaVersion: 1, nodes: ids.map(node), edges: links.map(([from, to], index) => edge(`e-${index}`, from, to)) }; }

let graphDir = "";
beforeEach(async () => {
  __resetKnowledgeGraphCacheForTests();
  vi.clearAllMocks();
  graphDir = await mkdtemp(join(tmpdir(), "fusion-kg-access-"));
  await writeFile(join(graphDir, "manifest.json"), "first");
});
afterEach(async () => { await rm(graphDir, { recursive: true, force: true }); });

describe("knowledge graph artifact access", () => {
  it("reuses unchanged artifacts, reloads a changed manifest, and returns missing artifacts", async () => {
    const first = { ok: true as const, graph: graph(["a"], []), manifest: {} as never };
    const second = { ok: true as const, graph: graph(["b"], []), manifest: {} as never };
    core.loadArtifacts.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue({ ok: false, recoveryReason: "missing-artifact" });

    expect(await loadProjectKnowledgeGraph(graphDir)).toBe(first);
    expect(await loadProjectKnowledgeGraph(graphDir)).toBe(first);
    expect(core.loadArtifacts).toHaveBeenCalledTimes(1);
    await writeFile(join(graphDir, "manifest.json"), "manifest with a different size");
    expect(await loadProjectKnowledgeGraph(graphDir)).toBe(second);
    expect(core.loadArtifacts).toHaveBeenCalledTimes(2);

    const missingDir = join(graphDir, "missing");
    await expect(loadProjectKnowledgeGraph(missingDir)).resolves.toEqual({ ok: false, recoveryReason: "missing-artifact" });
  });

  it("deduplicates concurrent rebuilds and invalidates the cached entry", async () => {
    const cached = { ok: true as const, graph: graph(["cached"], []), manifest: {} as never };
    const reloaded = { ok: true as const, graph: graph(["reloaded"], []), manifest: {} as never };
    core.loadArtifacts.mockResolvedValueOnce(cached).mockResolvedValueOnce(reloaded);
    await loadProjectKnowledgeGraph(graphDir);
    let finishBuild: ((value: any) => void) | undefined;
    core.buildKnowledgeGraph.mockImplementation(() => new Promise((resolve) => { finishBuild = resolve; }));
    const store = { getRootDir: () => graphDir, getSettings: async () => ({ knowledgeGraphDir: "." }) };
    const first = rebuildProjectKnowledgeGraph(store as never, { force: true });
    const second = rebuildProjectKnowledgeGraph(store as never, { force: true });
    await vi.waitFor(() => expect(core.buildKnowledgeGraph).toHaveBeenCalledTimes(1));
    finishBuild?.({ changed: true, graph: graph(["built"], []), stats: { parsedFiles: 1 } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ changed: true, nodes: 1, edges: 0 }),
      expect.objectContaining({ changed: true, nodes: 1, edges: 0 }),
    ]);
    await loadProjectKnowledgeGraph(graphDir);
    expect(core.loadArtifacts).toHaveBeenCalledTimes(2);
  });
});

describe("findBoundedShortestPath", () => {
  it("keeps exhaustive negatives distinct from bounded searches and matches core hop count", () => {
    const connected = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const found = findBoundedShortestPath(connected, "a", "c", { maxHops: 2 });
    expect(found).toMatchObject({ outcome: "found", hops: 2, truncated: false });
    expect(found.outcome === "found" && found.path.edges.length).toBe(shortestPath(connected, "a", "c")?.edges.length);
    expect(findBoundedShortestPath(connected, "a", "c", { maxHops: 1 })).toMatchObject({ outcome: "limit-reached", limit: "max-hops", truncated: true });
    expect(findBoundedShortestPath(graph(["a", "b"], []), "a", "b")).toMatchObject({ outcome: "not-found", truncated: false });
  });

  it("returns zero-hop self paths, fences expansion, and rejects unknown ids", () => {
    const fan = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    expect(findBoundedShortestPath(fan, "a", "a")).toMatchObject({ outcome: "found", hops: 0, path: { edges: [] } });
    expect(findBoundedShortestPath(fan, "a", "c", { maxExpansions: 1 })).toMatchObject({ outcome: "limit-reached", limit: "max-expansions" });
    expect(() => findBoundedShortestPath(fan, "missing", "a")).toThrow(KnowledgeGraphError);
  });
});
