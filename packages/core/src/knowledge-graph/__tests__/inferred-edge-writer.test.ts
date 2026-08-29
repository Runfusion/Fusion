import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { addInferredEdges, type InferredEdgeProposal } from "../inferred-edge-writer.js";
import { loadArtifacts, writeArtifacts } from "../graph-store.js";
import type { GraphManifest, KnowledgeGraph } from "../graph-types.js";

const dirs: string[] = [];
const source = { path: "src/a.ts", line: 2, column: 1 };
const docSource = { path: "docs/a.md", line: 2, column: 1 };
const graph: KnowledgeGraph = {
  schemaVersion: 2,
  nodes: [
    { id: "file:src/a.ts", kind: "file", name: "a", owner: "file", ownerPath: "src/a.ts", source: { path: "src/a.ts", line: 1, column: 1 }, attributes: { ext: ".ts", syntheticSource: "true" } },
    { id: "file:docs/a.md", kind: "file", name: "a", owner: "file", ownerPath: "docs/a.md", source: { path: "docs/a.md", line: 1, column: 1 }, attributes: { ext: ".md", syntheticSource: "true" } },
    { id: "doc:docs/a.md#one~0", kind: "doc-concept", name: "one", owner: "file", ownerPath: "docs/a.md", source: docSource, attributes: {} },
    { id: "doc:docs/a.md#two~1", kind: "doc-concept", name: "two", owner: "file", ownerPath: "docs/a.md", source: docSource, attributes: {} },
    { id: "rationale:src/a.ts#Area@2026-08-11-10:56~0", kind: "rationale", name: "Area", owner: "file", ownerPath: "src/a.ts", source, attributes: {} },
    { id: "symbol:src/a.ts#a", kind: "symbol", name: "a", owner: "file", ownerPath: "src/a.ts", source, attributes: { symbolKind: "function", declarationCount: "1" } },
  ],
  edges: [],
};
const manifest: GraphManifest = { schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) }, "docs/a.md": { hash: "b".repeat(64) } } };

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kg-inferred-"));
  dirs.push(dir);
  await writeArtifacts(dir, graph, manifest);
  return dir;
}

afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("addInferredEdges", () => {
  it("anchors valid LLM proposals and always stamps them inferred", async () => {
    const dir = await fixture();
    const proposal = {
      kind: "relates-to",
      from: "doc:docs/a.md#one~0",
      to: "doc:docs/a.md#two~1",
      attributes: { rationale: "shared-use" },
      provenance: "extracted",
      source: { path: "forged.ts", line: 99, column: 99 },
    } as unknown as InferredEdgeProposal;

    expect(await addInferredEdges(dir, [proposal])).toEqual({ added: 1, deduped: 0, droppedUnresolved: 0 });
    const loaded = await loadArtifacts(dir);
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect(loaded.graph.edges).toEqual([expect.objectContaining({
      id: "relates-to|doc:docs/a.md#one~0|doc:docs/a.md#two~1",
      provenance: "inferred",
      ownerPath: "docs/a.md",
      source: docSource,
      attributes: { rationale: "shared-use" },
    })]);
  });

  it("skips duplicate and hallucinated proposals without changing graph evidence", async () => {
    const dir = await fixture();
    const proposal: InferredEdgeProposal = { kind: "relates-to", from: "doc:docs/a.md#one~0", to: "doc:docs/a.md#two~1" };
    expect(await addInferredEdges(dir, [proposal, proposal, { ...proposal, to: "symbol:missing#x" }])).toEqual({ added: 1, deduped: 1, droppedUnresolved: 1 });
    expect((await loadArtifacts(dir)).ok).toBe(true);
  });

  it("rejects valid-looking edge kinds when endpoint families are not semantic", async () => {
    const dir = await fixture();
    expect(await addInferredEdges(dir, [
      { kind: "relates-to", from: "symbol:src/a.ts#a", to: "file:src/a.ts" },
      { kind: "rationale-supports", from: "doc:docs/a.md#one~0", to: "symbol:src/a.ts#a" },
    ])).toEqual({ added: 0, deduped: 0, droppedUnresolved: 2 });
  });
});
