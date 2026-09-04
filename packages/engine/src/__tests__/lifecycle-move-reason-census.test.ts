import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = join(process.cwd(), "src");

function productionTypescriptFiles(dir = ENGINE_SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...productionTypescriptFiles(path));
    else if (entry.endsWith(".ts")) files.push(path);
  }
  return files;
}

function directMoveWindows(source: string): string[] {
  const windows: string[] = [];
  let cursor = 0;
  while ((cursor = source.indexOf(".moveTask(", cursor)) >= 0) {
    const start = cursor;
    let index = cursor + ".moveTask".length;
    let depth = 0;
    let quote: "'" | '"' | "`" | undefined;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const char = source[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    windows.push(source.slice(start, index));
    cursor = index;
  }
  return windows;
}

const BACKWARD_TARGET_PATTERN = /resolve(?:ContainedBackwardTargetForTask|ReboundTargetForTask|ReboundColumnFor)|resolveMergerLifecycleColumn[\s\S]*?"rebound"|\b(?:reboundColumn|reboundTarget|requeueTarget|retryTarget|replanColumn)\b/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("engine lifecycle move reason census", () => {
  it("pins the production move authority inventory", () => {
    const count = productionTypescriptFiles()
      .map((file) => readFileSync(file, "utf8"))
      .flatMap(directMoveWindows)
      .length;

    expect(count).toBe(57);
  });

  it("requires direct backward-target moves to carry a registered reason", () => {
    const violations: string[] = [];
    for (const file of productionTypescriptFiles()) {
      const source = readFileSync(file, "utf8");
      directMoveWindows(source).forEach((window, index) => {
        if (!BACKWARD_TARGET_PATTERN.test(window)) return;
        if (!/moveSource:\s*"(?:engine|scheduler)"/.test(window)) return;
        if (window.includes("lifecycleReason:") || window.includes("moveTaskWithLifecycleReason(")) return;
        violations.push(`${relative(ENGINE_SRC, file)}#${index + 1}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it("keeps review-capable recovery families off the hold-first resolver", () => {
    const reviewCapableFamilies = [
      "auto-recovery-handlers/contamination.ts",
      "recovery/foreign-only-contamination.ts",
      "healing/restart-recovery-coordinator.ts",
      "project-engine.ts",
      "merge/merger-ai.ts",
      "merger.ts",
    ];
    const violations = reviewCapableFamilies.filter((file) => {
      const source = stripComments(readFileSync(join(ENGINE_SRC, file), "utf8"));
      return /resolveReboundTargetForTask|resolveReboundTarget\(ir\)/.test(source);
    });

    expect(violations).toEqual([]);
  });
});
