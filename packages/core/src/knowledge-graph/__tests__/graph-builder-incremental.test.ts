import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKnowledgeGraph } from "../graph-builder.js";
import { extractFile as realExtractFile } from "../extract-file.js";
import { extractTypeScript as realTypeScript } from "../extract-typescript.js";
const roots:string[]=[];
const discovery = { sourceRoots: ["src"], markdownRoots: [] };
async function fixture(){ const root=await mkdtemp(join(tmpdir(), "kg-fixture-")); roots.push(root); await mkdir(join(root,"src")); await writeFile(join(root,"src","a.ts"),"import { b } from './b'; export const a = b;"); await writeFile(join(root,"src","b.ts"),"export const b = 1;"); return root; }
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
describe("incremental graph builder", () => {
  it("writes deterministic artifacts and only reparses changed files", async () => {
    const root=await fixture(), dir=join(root,".fusion-knowledge/graph");
    await buildKnowledgeGraph({projectRoot:root,graphDir:dir,discovery});
    const before=await Promise.all(["nodes.json","edges.json","manifest.json"].map(file=>readFile(join(dir,file),"utf8")));
    const typeScript=vi.fn(realTypeScript), extract=vi.fn(realExtractFile);
    const noChange=await buildKnowledgeGraph({projectRoot:root,graphDir:dir,extractFile:extract,deps:{typescript:typeScript},discovery});
    expect(noChange.changed).toBe(false); expect(extract).not.toHaveBeenCalled();
    await writeFile(join(root,"src","b.ts"),"export const b = 2;");
    const changed=await buildKnowledgeGraph({projectRoot:root,graphDir:dir,extractFile:extract,deps:{typescript:typeScript},discovery});
    expect(changed.stats).toMatchObject({parsedFiles:1,reusedFiles:1}); expect(extract).toHaveBeenCalledTimes(1); expect(typeScript).toHaveBeenCalledTimes(1);
    await writeFile(join(root,"src","b.ts"),"export const b = 1;");
    await buildKnowledgeGraph({projectRoot:root,graphDir:dir,discovery});
    const after=await Promise.all(["nodes.json","edges.json","manifest.json"].map(file=>readFile(join(dir,file),"utf8")));
    expect(after).toEqual(before);
  });
  it("uses the tracked graph directory when callers omit graphDir", async () => {
    const root=await fixture();
    await buildKnowledgeGraph({projectRoot:root,discovery});
    await expect(readFile(join(root,".fusion-knowledge/graph/nodes.json"),"utf8")).resolves.toContain("file:src/a.ts");
  });
  it("prunes deleted files and dangling import edges without reparsing importers", async () => {
    const root=await fixture(), dir=join(root,".fusion-knowledge/graph"); await buildKnowledgeGraph({projectRoot:root,graphDir:dir,discovery});
    await rm(join(root,"src","b.ts")); const extract=vi.fn(realExtractFile); const result=await buildKnowledgeGraph({projectRoot:root,graphDir:dir,extractFile:extract,discovery});
    expect(extract).not.toHaveBeenCalled(); expect(result.graph.nodes.some(node=>node.id==="file:src/b.ts")).toBe(false); expect(result.graph.edges.some(edge=>edge.kind==="imports")).toBe(false);
  });
  it("rebuilds rather than reusing a cache with forged synthetic file provenance", async () => {
    const root = await fixture(), dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    const nodesPath = join(dir, "nodes.json");
    const artifact = JSON.parse(await readFile(nodesPath, "utf8")) as { nodes: Array<{ id: string; source: { line: number } }> };
    artifact.nodes.find(node => node.id === "file:src/a.ts")!.source.line = 2;
    await writeFile(nodesPath, `${JSON.stringify(artifact)}\n`);

    const extract = vi.fn(realExtractFile);
    const result = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, extractFile: extract, discovery });
    expect(result.stats.recoveryReason).toBe("inconsistent-artifact");
    expect(extract).toHaveBeenCalledTimes(2);
    expect(result.graph.nodes.find(node => node.id === "file:src/a.ts")?.source).toMatchObject({ line: 1, column: 1 });
  });
});
