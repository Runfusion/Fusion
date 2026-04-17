import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "dist" ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      files.push(...listSourceFiles(path));
      continue;
    }

    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }

    files.push(path);
  }

  return files;
}

describe("architecture hot-path contracts", () => {
  it("keeps production listTasks() callers explicit about payload shape", () => {
    const sourceRoots = [
      "packages/cli/src",
      "packages/dashboard/app",
      "packages/dashboard/src",
      "packages/engine/src",
    ];
    const bareListTaskCalls: string[] = [];

    const bareListTasksPattern = /\.\s*listTasks\(\)/;

    for (const root of sourceRoots) {
      for (const file of listSourceFiles(join(workspaceRoot, root))) {
        const content = readFileSync(file, "utf-8");
        if (!bareListTasksPattern.test(content)) {
          continue;
        }

        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (bareListTasksPattern.test(line)) {
            bareListTaskCalls.push(`${relative(workspaceRoot, file)}:${index + 1}`);
          }
        });
      }
    }

    expect(bareListTaskCalls).toEqual([]);
  });
});
