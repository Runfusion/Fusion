import { describe, expect, it, vi } from "vitest";
import { extractFile } from "../extract-file.js";
import { extractTypeScript } from "../extract-typescript.js";

describe("per-file extractor composition", () => {
  it("owns exactly one file node and combines TypeScript and FNXC output", () => {
    const result = extractFile({ relPath: "src/a.ts", content: "/* FNXC:Area 2026-01-01-00:00: rationale */ export const a = 1;" });
    expect(result.nodes.filter(node => node.kind === "file")).toHaveLength(1);
    expect(result.nodes.map(node => node.kind)).toEqual(expect.arrayContaining(["symbol", "rationale"]));
    expect(result.edges.every(edge => edge.owner === "file" && edge.ownerPath === "src/a.ts" && edge.provenance === "extracted")).toBe(true);
    expect(result.edges.some(edge => edge.kind === "imports" || edge.kind === "re-exports")).toBe(false);
  });

  it("threads a test-only TypeScript extractor without changing output", () => {
    const input = { relPath: "src/a.ts", content: "export const a = 1;" };
    const spy = vi.fn(extractTypeScript);
    expect(extractFile(input, { typescript: spy })).toEqual(extractFile(input));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
