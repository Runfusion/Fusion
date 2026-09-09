/*
FNXC:HistoryToolNaming 2026-09-04-09:35:
FN-293 rejects the retired History-tool names across active source and operator documentation while preserving frozen release history. This guard excludes itself because it assembles the forbidden names for structural checks, and `packages/cli/CHANGELOG.md` stays outside the scanned roots because published history is immutable.
*/
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../..");
const scannedRoots = [
  "packages/core/src",
  "packages/engine/src",
  "packages/cli/src",
  "packages/dashboard/src",
  "packages/dashboard/app",
  "plugins",
  "docs",
] as const;
const scannedExtensions = new Set([".ts", ".tsx", ".mjs", ".md"]);
const skippedDirectories = new Set(["node_modules", "dist", "coverage"]);
const thisFile = resolve(__filename);
const retiredNames = [
  ["fn", "patchnode", "read"].join("_"),
  ["create", "Patchnode", "ReadTool"].join(""),
  ["patchnode", "ReadParams"].join(""),
] as const;

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) ? [] : listSourceFiles(join(directory, entry.name));
    }
    const file = join(directory, entry.name);
    return entry.isFile() && scannedExtensions.has(extname(entry.name)) && resolve(file) !== thisFile ? [file] : [];
  });
}

describe("History tool naming residue", () => {
  it("rejects retired tool-contract names from active source and documentation", () => {
    const offenders = scannedRoots.flatMap((root) => listSourceFiles(resolve(repoRoot, root))).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return retiredNames.filter((name) => source.includes(name)).map((name) => `${relative(repoRoot, file)}: ${name}`);
    });

    expect(offenders, `Retired History tool names found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps the renamed tool contract present", () => {
    const agentTools = readFileSync(resolve(repoRoot, "packages/engine/src/agent-tools.ts"), "utf8");
    expect(agentTools).toContain("fn_history_read");
  });
});
