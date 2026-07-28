/*
FNXC:EngineDiagnostics 2026-08-01-11:12:
FN-8603 keeps dashboard-server diagnostics on @fusion/core's shared logger so
routine output is debug-gated and no dashboard-local console sink can drift.
*/
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logSeverityManifest } from "../../../engine/src/__tests__/log-severity-manifest.js";

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("dashboard-server diagnostic source contract", () => {
  it("pins each dashboard demotion to one debug call site, not any louder severity", () => {
    for (const entry of logSeverityManifest.filter((entry) => entry.pkg === "dashboard")) {
      const source = readFileSync(join(__dirname, "..", entry.file), "utf8");
      const matchingLines = source.split("\n").filter((line) => line.includes(entry.anchor));
      expect(matchingLines, `${entry.file}: ${entry.anchor}`).toHaveLength(1);
      const [line] = matchingLines;
      expect(line).toContain(`.${entry.severity}(`);
      expect(line).not.toMatch(/\.(log|warn|error)\(|console\.(log|warn|error)\(/);
    }
  });

  it("has no bare production console diagnostics", () => {
    for (const file of sourceFiles(join(__dirname, ".."))) {
      expect(withoutComments(readFileSync(file, "utf8")), file).not.toMatch(/console\.(log|warn|error)\(/);
    }
  });

  it("never imports createLogger from engine or a cross-package relative path", () => {
    for (const file of sourceFiles(join(__dirname, ".."))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/import\s*\{[^}]*\bcreateLogger\b[^}]*\}\s*from\s*["']@fusion\/engine["']/);
      expect(source, file).not.toMatch(/import\s*\{[^}]*\bcreateLogger\b[^}]*\}\s*from\s*["'][^"']*(?:\.\.\/){2,}[^"']*["']/);
    }
  });
});
