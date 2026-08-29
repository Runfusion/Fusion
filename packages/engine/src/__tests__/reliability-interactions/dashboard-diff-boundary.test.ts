import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_PATTERNS = [
  /from\s+["']@fusion\/dashboard["']/g,
  /import\s*\(\s*["']@fusion\/dashboard["']\s*\)/g,
  /from\s+["'][^"']*packages\/dashboard\//g,
  /import\s*\(\s*["'][^"']*packages\/dashboard\//g,
  /from\s+["'][^"']*(register-session-diff-routes|resolve-diff-base|diff-counts)(\.js)?["']/g,
  /import\s*\(\s*["'][^"']*(register-session-diff-routes|resolve-diff-base|diff-counts)(\.js)?["']\s*\)/g,
];

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".tsx")) continue;
    if (/\.test\.tsx?$/.test(fullPath)) continue;
    files.push(fullPath);
  }

  return files;
}

function findForbiddenImports(content: string): string[] {
  const hits: string[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      hits.push(pattern.source);
    }
    pattern.lastIndex = 0;
  }
  return hits;
}

describe("FN-4754 reliability boundary: engine source must not import dashboard diff display modules", () => {
  it("keeps engine runtime sources free of dashboard diff/display imports", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const engineSrcDir = join(testDir, "..", "..");
    const files = collectTsFiles(engineSrcDir);

    const offenders: string[] = [];
    for (const filePath of files) {
      const content = readFileSync(filePath, "utf8");
      const matches = findForbiddenImports(content);
      if (matches.length > 0) {
        offenders.push(`${relative(engineSrcDir, filePath)} => ${matches.join(", ")}`);
      }
    }

    expect(offenders, `Forbidden engine→dashboard imports found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("positive control: matcher detects forbidden imports", () => {
    const sample = `import x from "@fusion/dashboard";\nconst y = await import("../../packages/dashboard/src/routes/diff-counts.js");`;
    const matches = findForbiddenImports(sample);
    expect(matches.length).toBeGreaterThan(0);
  });
});
