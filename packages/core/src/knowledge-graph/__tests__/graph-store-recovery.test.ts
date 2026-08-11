import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadArtifacts, writeArtifacts } from "../graph-store.js";
import type { GraphManifest, KnowledgeGraph } from "../graph-types.js";
const dirs:string[]=[]; const graph:KnowledgeGraph={schemaVersion:2,nodes:[],edges:[]}; const manifest:GraphManifest={schemaVersion:2,extractorVersion:1,files:{}};
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
describe("knowledge graph artifact recovery",()=>{
  it("treats missing and corrupt artifact sets as full rebuild candidates",async()=>{const dir=await mkdtemp(join(tmpdir(),"kg-store-"));dirs.push(dir);expect(await loadArtifacts(dir)).toMatchObject({ok:false,recoveryReason:"missing-artifact"});await writeArtifacts(dir,graph,manifest);await writeFile(join(dir,"nodes.json"),"{");expect(await loadArtifacts(dir)).toMatchObject({ok:false,recoveryReason:"invalid-artifact"});});
  it("rejects structurally corrupted graph and manifest records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-store-"));
    dirs.push(dir);
    await writeArtifacts(dir, graph, manifest);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "not-a-hash", importRefs: [{ kind: "imports" }] } } }));
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "invalid-artifact" });
    await writeArtifacts(dir, { schemaVersion: 2, nodes: [{ id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} }], edges: [] }, { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } });
    await writeFile(join(dir, "nodes.json"), JSON.stringify({ schemaVersion: 2, nodes: [{ id: "file:src/a.ts", kind: "not-a-kind", name: "a" }] }));
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "invalid-artifact" });
    await writeFile(join(dir, "nodes.json"), JSON.stringify({ nodes: [] }));
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "invalid-artifact" });
  });
  it("rejects a retained edge whose file owner is absent from the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-store-"));
    dirs.push(dir);
    const graphWithEdge: KnowledgeGraph = {
      schemaVersion: 2,
      nodes: [
        { id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
        { id: "symbol:src/a.ts#a", kind: "symbol", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
      ],
      edges: [{ id: "contains|file:src/a.ts|symbol:src/a.ts#a", kind: "contains", from: "file:src/a.ts", to: "symbol:src/a.ts#a", provenance: "extracted", owner: "file", ownerPath: "src/missing.ts", source: { path: "src/missing.ts", line: 1, column: 1 }, attributes: {} }],
    };
    await writeArtifacts(dir, graphWithEdge, { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } });
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });
  });
  it("rejects duplicate or malformed persisted roots rather than trusting a partial graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-store-"));
    dirs.push(dir);
    await writeArtifacts(dir, graph, manifest);
    await writeFile(join(dir, "nodes.json"), JSON.stringify({ schemaVersion: 2, nodes: [], unexpected: true }));
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "invalid-artifact" });
    await writeArtifacts(dir, { schemaVersion: 2, nodes: [
      { id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
      { id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
    ], edges: [] }, { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } });
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });
    await writeArtifacts(dir, { schemaVersion: 2, nodes: [
      { id: "file:rogue", kind: "file", name: "rogue", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
      { id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
    ], edges: [] }, { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } });
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 2, extractorVersion: 1, files: { "./src/a.ts": { hash: "a".repeat(64) } } }));
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "invalid-artifact" });
  });
  it("rejects malformed non-file identities instead of reusing a corrupt no-op artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-store-"));
    dirs.push(dir);
    await writeArtifacts(dir, { schemaVersion: 2, nodes: [
      { id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} },
      { id: "symbol:src/other.ts#a", kind: "symbol", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/other.ts", line: 1, column: 1 }, attributes: { symbolKind: "variable" } },
    ], edges: [{ id: "corrupt", kind: "contains", from: "file:src/a.ts", to: "symbol:src/other.ts#a", provenance: "extracted", owner: "file", ownerPath: "src/a.ts", source: { path: "src/other.ts", line: 1, column: 1 }, attributes: {} }] }, { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } });
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });
  });
  it("rejects invalid ownership classes and duplicate edge identities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-store-"));
    dirs.push(dir);
    const file = { id: "file:src/a.ts", kind: "file" as const, name: "a", owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {} };
    const derivedSymbol = { id: "symbol:src/a.ts#a", kind: "symbol" as const, name: "a", owner: "derived" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: { symbolKind: "variable" } };
    const validManifest = { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } };
    await writeArtifacts(dir, { schemaVersion: 2, nodes: [file, derivedSymbol], edges: [] }, validManifest);
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });

    const edge = { id: "contains|file:src/a.ts|file:src/a.ts", kind: "contains" as const, from: file.id, to: file.id, provenance: "extracted" as const, owner: "file" as const, ownerPath: "src/a.ts", source: file.source, attributes: {} };
    await writeArtifacts(dir, { schemaVersion: 2, nodes: [file], edges: [edge, { ...edge }] }, validManifest);
    expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });
  });
  it("rejects forged synthetic anchors and synthetic markers on parsed facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-store-"));
    dirs.push(dir);
    const file = { id: "file:src/a.ts", kind: "file" as const, name: "a", owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: { ext: ".ts", syntheticSource: "true" } };
    const module = { id: "module:src", kind: "module" as const, name: "src", owner: "derived" as const, ownerPath: "src", source: { path: "src", line: 1, column: 1 }, attributes: { directFileCount: "1", barrel: "false", syntheticSource: "true" } };
    const symbol = { id: "symbol:src/a.ts#a", kind: "symbol" as const, name: "a", owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 2, column: 1 }, attributes: { symbolKind: "variable", declarationCount: "1" } };
    const moduleEdge = { id: "contains|module:src|file:src/a.ts", kind: "contains" as const, from: module.id, to: file.id, provenance: "extracted" as const, owner: "derived" as const, ownerPath: "src", source: module.source, attributes: { syntheticSource: "true" } };
    const parentHeading = { id: "doc:src/a.ts#parent~0", kind: "doc-concept" as const, name: "parent", owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 3, column: 1 }, attributes: { headingLevel: "1" } };
    const childHeading = { id: "doc:src/a.ts#child~0", kind: "doc-concept" as const, name: "child", owner: "file" as const, ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 4, column: 1 }, attributes: { headingLevel: "2" } };
    const headingEdge = { id: "contains|doc:src/a.ts#parent~0|doc:src/a.ts#child~0", kind: "contains" as const, from: parentHeading.id, to: childHeading.id, provenance: "extracted" as const, owner: "file" as const, ownerPath: "src/a.ts", source: childHeading.source, attributes: {} };
    const validGraph = { schemaVersion: 2, nodes: [file, module, symbol, parentHeading, childHeading], edges: [moduleEdge, headingEdge] };
    const validManifest = { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } };
    await writeArtifacts(dir, validGraph, validManifest);
    expect(await loadArtifacts(dir)).toMatchObject({ ok: true });

    const invalidGraphs = [
      { ...validGraph, nodes: [{ ...file, source: { ...file.source, line: 2 } }, module, symbol] },
      { ...validGraph, nodes: [{ ...file, attributes: { ext: ".ts" } }, module, symbol] },
      { ...validGraph, nodes: [file, { ...module, attributes: { directFileCount: "1", barrel: "false" } }, symbol] },
      { ...validGraph, nodes: [file, module, { ...symbol, attributes: { ...symbol.attributes, syntheticSource: "true" } }] },
      { ...validGraph, edges: [{ ...moduleEdge, source: { path: "src/a.ts", line: 1, column: 1 } }] },
    ];
    for (const invalidGraph of invalidGraphs) {
      await writeArtifacts(dir, invalidGraph, validManifest);
      expect(await loadArtifacts(dir)).toMatchObject({ ok: false, recoveryReason: "inconsistent-artifact" });
    }
  });
  it("does not rewrite identical bytes",async()=>{const dir=await mkdtemp(join(tmpdir(),"kg-store-"));dirs.push(dir);expect((await writeArtifacts(dir,graph,manifest)).changed).toBe(true);expect((await writeArtifacts(dir,graph,manifest)).changed).toBe(false);});
});
