import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
describe("knowledge graph bundle contract",()=>{it("keeps TypeScript runtime-resolvable rather than inlining it",async()=>{const root=resolve(import.meta.dirname,"../..");const cli=JSON.parse(await readFile(resolve(root,"package.json"),"utf8"));const core=JSON.parse(await readFile(resolve(root,"../core/package.json"),"utf8"));const tsup=await readFile(resolve(root,"tsup.config.ts"),"utf8");expect(cli.dependencies.typescript).toBeDefined();expect(core.dependencies.typescript).toBeDefined();expect(tsup).toContain('"typescript"');});});
