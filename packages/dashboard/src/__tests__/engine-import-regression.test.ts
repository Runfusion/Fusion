import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DYNAMIC_ENGINE_IMPORT_PATTERN = /await\s+import\((\/\*.*?\*\/\s*)?"@fusion\/engine"\)/g;

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === "__tests__") {
        continue;
      }
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".tsx")) {
      continue;
    }
    if (/\.test\.tsx?$/.test(fullPath)) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

describe("FN-3049 regression: runtime engine imports stay bundler-safe", () => {
  it("blocks dynamic await import('@fusion/engine') in dashboard/cli runtime source", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const dashboardSrcDir = join(testDir, "..");
    const cliSrcDir = join(testDir, "..", "..", "..", "cli", "src");
    const filesToAudit = [...collectTsFiles(dashboardSrcDir), ...collectTsFiles(cliSrcDir)];

    const offenders: string[] = [];
    for (const filePath of filesToAudit) {
      const content = readFileSync(filePath, "utf8");
      if (DYNAMIC_ENGINE_IMPORT_PATTERN.test(content)) {
        offenders.push(relative(dashboardSrcDir, filePath));
      }
      DYNAMIC_ENGINE_IMPORT_PATTERN.lastIndex = 0;
    }

    expect(offenders).toEqual([]);
  });
});
