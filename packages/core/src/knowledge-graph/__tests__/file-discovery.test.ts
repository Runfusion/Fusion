import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_EXCLUDED_DIRECTORIES, DEFAULT_MARKDOWN_ROOTS, DEFAULT_SOURCE_ROOTS, discoverFiles } from "../file-discovery.js";

describe("knowledge graph file discovery", () => {
  it("covers every required repository source surface without generated paths", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    expect(DEFAULT_SOURCE_ROOTS).toContain("packages/dashboard/app");
    expect(DEFAULT_MARKDOWN_ROOTS).toEqual(expect.arrayContaining(["docs", "AGENTS.md", "CONCEPTS.md"]));
    const paths = await discoverFiles(root);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringMatching(/^packages\/dashboard\/app\/.+\.(ts|tsx)$/),
      expect.stringMatching(/^packages\/core\/src\/.+\.ts$/),
      expect.stringMatching(/^packages\/engine\/src\/.+\.ts$/),
      expect.stringMatching(/^packages\/cli\/src\/.+\.ts$/),
      "scripts/check-fnxc-future-dates.mjs",
      "AGENTS.md",
      "CONCEPTS.md",
    ]));
    expect(paths.some(path => path.startsWith("docs/") && path.endsWith(".md"))).toBe(true);
    expect(paths.some(path => path.endsWith(".d.ts"))).toBe(false);
    for (const directory of DEFAULT_EXCLUDED_DIRECTORIES) expect(paths.some(path => path.split("/").includes(directory))).toBe(false);
  });
});
