import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "../graph-builder.js";

const roots: string[] = [];
const discovery = { sourceRoots: ["src"], markdownRoots: [] };
async function bytes(root: string): Promise<string[]> {
  const dir = join(root, ".fusion-knowledge/graph");
  return Promise.all(["nodes.json", "edges.json", "manifest.json"].map(file => readFile(join(dir, file), "utf8")));
}
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kg-equivalence-"));
  roots.push(root);
  await mkdir(join(root, "src", "m"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "import { b } from './b'; import { value } from './m'; export const a = b + value;");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;");
  await writeFile(join(root, "src", "m", "index.ts"), "export const value = 1;");
  return root;
}
async function equalFull(root: string): Promise<void> {
  const incremental = await bytes(root);
  await buildKnowledgeGraph({ projectRoot: root, discovery, force: true });
  expect(await bytes(root)).toEqual(incremental);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("incremental/full graph equivalence", () => {
  it("matches a forced full rebuild across edit, add, delete, restore, and rename", async () => {
    const root = await fixture();
    await buildKnowledgeGraph({ projectRoot: root, discovery });
    await writeFile(join(root, "src", "b.ts"), "export const b = 2;");
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await writeFile(join(root, "src", "m.ts"), "export const value = 2;");
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await rm(join(root, "src", "b.ts"));
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await writeFile(join(root, "src", "b.ts"), "export const b = 3;");
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await rename(join(root, "src", "b.ts"), join(root, "src", "c.ts"));
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await writeFile(join(root, "src", "a.ts"), "export const duplicate = 1; export const duplicate = 2;");
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await writeFile(join(root, "src", "a.ts"), "export const duplicate = 1;");
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
    await writeFile(join(root, "src", "a.ts"), "import { value } from './m'; export const a = value;");
    await buildKnowledgeGraph({ projectRoot: root, discovery });
    await writeFile(join(root, "src", "m.ts"), "export const value = 3;");
    await buildKnowledgeGraph({ projectRoot: root, discovery }); await equalFull(root);
  });

  it("fully rebuilds every recovery-matrix corruption with clean-build bytes", async () => {
    const root = await fixture();
    const dir = join(root, ".fusion-knowledge/graph");
    const corruptions: Array<[string, string]> = [
      ["manifest.json", "{"],
      ["nodes.json", "{"],
      ["edges.json", JSON.stringify({ schemaVersion: 999, edges: [] })],
      ["manifest.json", JSON.stringify({ schemaVersion: 2, extractorVersion: 1, files: { "src/a.ts": { hash: "a".repeat(64) } } })],
    ];
    for (const [file, content] of corruptions) {
      await buildKnowledgeGraph({ projectRoot: root, discovery, force: true });
      await writeFile(join(dir, file), content);
      const recovered = await buildKnowledgeGraph({ projectRoot: root, discovery });
      expect(recovered.stats.parsedFiles).toBe(3);
      expect(recovered.stats.recoveryReason).toMatch(/invalid-artifact|version-mismatch|inconsistent-artifact/);
      await equalFull(root);
    }
    await buildKnowledgeGraph({ projectRoot: root, discovery, force: true });
    await rm(join(dir, "manifest.json"));
    const missing = await buildKnowledgeGraph({ projectRoot: root, discovery });
    expect(missing.stats).toMatchObject({ parsedFiles: 3, recoveryReason: "missing-artifact" });
    await equalFull(root);
  });
});
