import { describe, expect, it } from "vitest";
import { deserializeArtifacts, serializeGraph, serializeManifest } from "../graph-serialization.js";
import type { GraphManifest, KnowledgeGraph } from "../graph-types.js";

const graph: KnowledgeGraph = {
  schemaVersion: 2,
  nodes: [{ id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: { syntheticSource: "true", ext: ".ts" } }],
  edges: [{ id: "contains|file:src/a.ts|symbol:src/a.ts#a", kind: "contains", from: "file:src/a.ts", to: "symbol:src/a.ts#a", provenance: "extracted", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 2, column: 1 }, attributes: {} }],
};
const manifest: GraphManifest = { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64), importRefs: [{ kind: "imports", specifier: "./b", candidates: ["src/b.ts", "src/b.tsx"], line: 1, column: 1, typeOnly: false }] } } };

describe("knowledge graph serialization", () => {
  it("emits schemaVersion first and preserves ordered import candidates", () => {
    const bytes = serializeGraph(graph);
    const manifestBytes = serializeManifest(manifest);
    expect(bytes.nodes).toMatch(/^\{\n  "schemaVersion"/);
    expect(bytes.edges).toMatch(/^\{\n  "schemaVersion"/);
    expect(manifestBytes).toMatch(/^\{\n  "schemaVersion"/);
    expect(deserializeArtifacts(bytes.nodes, bytes.edges, manifestBytes)).toEqual({ ok: true, graph, manifest });
    expect(manifestBytes.indexOf("src/b.ts")).toBeLessThan(manifestBytes.indexOf("src/b.tsx"));
  });

  it("returns validation results rather than throwing for broken or stale artifacts", () => {
    const bytes = serializeGraph(graph);
    expect(deserializeArtifacts("{", bytes.edges, serializeManifest(manifest))).toEqual({ ok: false, reason: "invalid-artifact" });
    expect(bytes.edges).toContain('"id": "contains|file:src/a.ts|symbol:src/a.ts#a"');
    expect(deserializeArtifacts(bytes.nodes.replace("\"schemaVersion\": 2", "\"schemaVersion\": 3"), bytes.edges, serializeManifest(manifest))).toEqual({ ok: false, reason: "version-mismatch" });
  });

  it("rejects extra keys and impossible import candidate shapes instead of retaining foreign artifact state", () => {
    const bytes = serializeGraph(graph);
    const payload = () => ({
      nodes: JSON.parse(bytes.nodes) as { nodes: Array<Record<string, unknown>> },
      edges: JSON.parse(bytes.edges) as { edges: Array<Record<string, unknown>> },
      manifest: JSON.parse(serializeManifest(manifest)) as { files: Record<string, Record<string, unknown>> },
    });
    const cases = [
      (value: ReturnType<typeof payload>) => { value.nodes.nodes[0]!.foreign = true; },
      (value: ReturnType<typeof payload>) => { value.edges.edges[0]!.foreign = true; },
      (value: ReturnType<typeof payload>) => { (value.nodes.nodes[0]!.source as Record<string, unknown>).foreign = true; },
      (value: ReturnType<typeof payload>) => { (value.edges.edges[0]!.source as Record<string, unknown>).foreign = true; },
      (value: ReturnType<typeof payload>) => { value.manifest.files["src/a.ts"]!.foreign = true; },
      (value: ReturnType<typeof payload>) => { ((value.manifest.files["src/a.ts"]!.importRefs as Array<Record<string, unknown>>)[0]!).foreign = true; },
      (value: ReturnType<typeof payload>) => { ((value.manifest.files["src/a.ts"]!.importRefs as Array<Record<string, unknown>>)[0]!).candidates = []; },
      (value: ReturnType<typeof payload>) => { ((value.manifest.files["src/a.ts"]!.importRefs as Array<Record<string, unknown>>)[0]!).candidates = ["src/b.ts", "src/b.ts"]; },
    ];
    for (const tamper of cases) {
      const value = payload();
      tamper(value);
      expect(deserializeArtifacts(JSON.stringify(value.nodes), JSON.stringify(value.edges), JSON.stringify(value.manifest))).toEqual({ ok: false, reason: "invalid-artifact" });
    }
  });

  it("accepts complete manifest entries with and without optional import references", () => {
    const bytes = serializeGraph(graph);
    const withoutRefs: GraphManifest = { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } };
    expect(deserializeArtifacts(bytes.nodes, bytes.edges, serializeManifest(manifest))).toMatchObject({ ok: true });
    expect(deserializeArtifacts(bytes.nodes, bytes.edges, serializeManifest(withoutRefs))).toMatchObject({ ok: true });
  });
});
