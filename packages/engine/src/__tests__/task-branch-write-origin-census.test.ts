import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface BranchWriteViolation {
  relativePath: string;
  call: "updateTask" | "updateTaskAtomic" | "createTask";
  line: number;
  text: string;
}

interface BranchWriteAllowlistEntry {
  relativePath: string;
  line: number;
  reason: string;
}

const BRANCH_WRITE_ALLOWLIST: BranchWriteAllowlistEntry[] = [];

function consumeBalanced(source: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function maskUnsafeConditionalOrigins(callText: string, branchExpressions: string[]): string {
  const chars = [...callText];
  for (let cursor = 0; cursor < callText.length; cursor += 1) {
    const spread = callText.indexOf("...(", cursor);
    if (spread < 0) break;
    const open = spread + 3;
    const close = consumeBalanced(callText, open);
    const segment = callText.slice(spread, close + 1);
    const compactSegment = segment.replace(/\s+/g, "");
    const conditionTracksBranchValue = branchExpressions.some((expression) => (
      expression.length > 0 && compactSegment.includes(expression.replace(/\s+/g, ""))
    ));
    if (
      segment.includes("?")
      && /\bbranchWriteOrigin\s*:/.test(segment)
      && !/\bbranch\s*:/.test(segment)
      && !conditionTracksBranchValue
    ) {
      for (let index = spread; index <= close; index += 1) chars[index] = " ";
    }
    cursor = close;
  }
  return chars.join("");
}

/**
 * Finds literal branch-bearing task mutations that do not carry matching provenance.
 * Variable-built patches are intentionally outside this source scanner and are covered by
 * provenance-enforcing store doubles in the reclaim and merger lifecycle suites.
 */
export function findUnprovenancedBranchWrites(source: string, relativePath: string): BranchWriteViolation[] {
  const violations: BranchWriteViolation[] = [];
  const matcher = /\.(updateTaskAtomic|updateTask|createTask)\s*\(/g;
  for (const match of source.matchAll(matcher)) {
    const call = match[1] as BranchWriteViolation["call"];
    const matchIndex = match.index ?? 0;
    const open = source.indexOf("(", matchIndex);
    const close = consumeBalanced(source, open);
    const text = source.slice(matchIndex, close + 1);
    const branchWrites = [...text.matchAll(/\bbranch\s*:\s*([^,}\n]+)/g)];
    if (branchWrites.length === 0) continue;
    if (branchWrites.every((entry) => entry[1].trim() === "undefined")) continue;
    const safeText = maskUnsafeConditionalOrigins(text, branchWrites.map((entry) => entry[1].trim()));
    if (/\bbranchWriteOrigin\s*:/.test(safeText)) continue;
    violations.push({
      relativePath,
      call,
      line: source.slice(0, matchIndex).split("\n").length,
      text: text.replace(/\s+/g, " ").slice(0, 240),
    });
  }
  return violations;
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      const relativePath = relative(resolve(process.cwd(), "../.."), path).replaceAll("\\", "/");
      if (entry === "dist" || entry === "node_modules" || entry === "__tests__") continue;
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      if ([
        "packages/core/src/task-store/task-update.ts",
        "packages/core/src/task-store/task-creation.ts",
        "packages/core/src/store.ts",
      ].includes(relativePath)) continue;
      files.push(path);
    }
  };
  visit(root);
  return files;
}

describe("production task branch-write provenance census", () => {
  it("identifies defective and accepted call-site shapes", () => {
    const defectiveSelfHealing = `await this.store.updateTask(task.id, { worktree: livePath, branch: task.branch, paused: false });`;
    const defectiveMerger = `await store.updateTask(taskId, { branch: branchDeleted ? null : task.branch, ...(branchDeleted ? { branchWriteOrigin: "engine" } : {}) });`;
    const derived = `await store.updateTask(task.id, { branch: task.branch, branchWriteOrigin: classify(task) ? "operator" : "engine" });`;
    const clear = `await store.updateTask(task.id, { branch: null, branchWriteOrigin: "engine" });`;
    const absent = `await store.updateTask(task.id, { worktree: "/tmp/worktree" });`;
    const worktreeRepoint = `await store.updateTask(task.id, { worktree: relocatedPath });`;
    const undefinedBranch = `await store.updateTask(task.id, { branch: undefined });`;
    const coupledConditional = `await store.updateTask(task.id, { ...(deleted ? { branch: null, branchWriteOrigin: "engine" } : {}) });`;

    expect(findUnprovenancedBranchWrites(defectiveSelfHealing, "self-healing.ts")).toHaveLength(1);
    expect(findUnprovenancedBranchWrites(defectiveMerger, "merger.ts")).toHaveLength(1);
    for (const accepted of [derived, clear, absent, worktreeRepoint, undefinedBranch, coupledConditional]) {
      expect(findUnprovenancedBranchWrites(accepted, "accepted.ts"), accepted).toEqual([]);
    }
  });

  it("keeps production literal branch writes on the explicit provenance contract", () => {
    for (const entry of BRANCH_WRITE_ALLOWLIST) {
      expect(entry.reason.trim(), `${entry.relativePath}:${entry.line} requires an allowlist reason`).not.toBe("");
    }
    const repositoryRoot = resolve(process.cwd(), "../..");
    const roots = [
      resolve(repositoryRoot, "packages/engine/src"),
      resolve(repositoryRoot, "packages/core/src"),
      resolve(repositoryRoot, "packages/dashboard/src"),
      resolve(repositoryRoot, "packages/cli/src"),
    ];
    const violations = roots.flatMap((root) => productionTypeScriptFiles(root).flatMap((path) => {
      const relativePath = relative(repositoryRoot, path).replaceAll("\\", "/");
      return findUnprovenancedBranchWrites(readFileSync(path, "utf-8"), relativePath);
    })).filter((violation) => !BRANCH_WRITE_ALLOWLIST.some((allowed) => (
      allowed.relativePath === violation.relativePath && allowed.line === violation.line
    )));

    expect(JSON.stringify(violations, null, 2)).toBe("[]");
  });
});
