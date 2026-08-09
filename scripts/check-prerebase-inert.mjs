#!/usr/bin/env node
/*
FNXC:MergerUnification 2026-08-09-12:20:
Master-plan U0 makes runAiMerge the only production merge path. This tracked-file
validator protects the retained-but-inert prerebase surface from a new live caller.
Its exact self-exclusion is necessary because its regex literals are executable code;
no other script is excluded.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { maskSource } from "./lib/source-projection.mjs";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const SELF_EXCLUDED_PATHS = Object.freeze(["scripts/check-prerebase-inert.mjs", "scripts/lib/source-projection.mjs"]);
export const EXEMPT_PATHS = Object.freeze(["packages/engine/src/merger.ts", "packages/engine/src/index.ts"]);
const EXCLUDED_SEGMENTS = new Set(["node_modules", "dist", ".git", ".fusion", ".worktrees", ".next", ".turbo", "coverage", "screenshots", "docs", "__tests__", "__mocks__", "__fixtures__", "__snapshots__", "fixtures", "e2e"]);
const EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const EXCLUDED_FILE = /(?:\.(?:test|spec)\.[^.]+$|\.d\.ts$|(?:^|\.)vitest(?:\.|$)|(?:^|\.)[^/]*config\.[^.]+$)/;
const PREBASE_IDS = /\b(?:decideAutoPrerebase|probeDivergence|runAutoPrerebase)\b/;
const LEGACY = /\baiMergeTask\b/;
const SPECIFIER = String.raw`(?:[^"'\\]|\\.)*merger-auto-prerebase(?:\.js|\.ts)?`;
const MODULE_BINDING = new RegExp(String.raw`(?:\bimport\s+(?:[^"';]*?\s+from\s*)?|\bexport\s+(?:[^"';]*?\s+from\s*)?|\bimport\s*\(|\brequire\s*\()\s*(["'])${SPECIFIER}\1`, "g");
const QUOTED_ACCESS = /(?:\[\s*|\b(?:Reflect\.get|Object\.getOwnPropertyDescriptor)\s*\([^,]+,\s*)(["'])aiMergeTask\1\s*(?:\]|\))/g;

export function isCorpusPath(path) {
  const segments = path.split("/");
  if (SELF_EXCLUDED_PATHS.includes(path) || segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  const name = segments.at(-1) ?? "";
  return EXTENSION.test(name) && !EXCLUDED_FILE.test(name);
}
export function partitionCorpus(paths) {
  return { exempt: paths.filter((path) => EXEMPT_PATHS.includes(path)), general: paths.filter((path) => !EXEMPT_PATHS.includes(path)) };
}
export function detectLegacyBindings(code) {
  const rules = [];
  if (/\b(?:import|export)\s*\{[^}]*\baiMergeTask\b[^}]*\}/s.test(code)) rules.push("aiMergeTask binding");
  if (/\{[^}]*\baiMergeTask\b(?:\s*:\s*[A-Za-z_$][\w$]*)?[^}]*\}\s*=/s.test(code)) rules.push("aiMergeTask destructuring");
  if (/(?:\.|\?\.)\s*aiMergeTask\b/.test(code)) rules.push("aiMergeTask member access");
  if (/\baiMergeTask\s*(?:<[^;<>()]*>)?\s*\(/s.test(code)) rules.push("aiMergeTask call");
  if (LEGACY.test(code)) rules.push("aiMergeTask binding");
  return [...new Set(rules)];
}
export function detectQuotedAccess(specifierProjection) {
  const codeProjection = maskSource(specifierProjection, { blankStrings: true });
  QUOTED_ACCESS.lastIndex = 0;
  // FNXC:MergerUnification 2026-08-09-12:20: Specifier projection retains
  // strings, so also require the access opener at this offset to survive in
  // code. This keeps scanner data strings from masquerading as an access.
  for (let match; (match = QUOTED_ACCESS.exec(specifierProjection));) {
    const codeAtMatch = codeProjection.slice(match.index);
    if (/^(?:\[|Reflect\.get\b|Object\.getOwnPropertyDescriptor\b)/.test(codeAtMatch)) return ["quoted aiMergeTask identifier"];
  }
  return [];
}
export function detectsPrerebaseSpecifier(specifierProjection) {
  const codeProjection = maskSource(specifierProjection, { blankStrings: true });
  MODULE_BINDING.lastIndex = 0;
  // The retained-string projection alone cannot distinguish an import-shaped
  // data string from real syntax. At the same offset, the binding keyword must
  // survive the code-only projection.
  for (let match; (match = MODULE_BINDING.exec(specifierProjection));) {
    if (/^(?:import|export|require)\b/.test(codeProjection.slice(match.index))) return true;
  }
  return false;
}
function occurrences(code) { return [...code.matchAll(/\baiMergeTask\b/g)]; }
export function checkExemption(path, code, specifier, source = code) {
  // FNXC:MergerUnification 2026-08-09-12:20: The historical merger source has
  // regex syntax predating the lightweight projection. Count comment-free code
  // occurrences here rather than granting either exempt file a whole-file pass.
  const commentFree = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, " "));
  const found = occurrences(commentFree);
  if (path === "packages/engine/src/merger.ts") {
    if (found.length !== 1) return `${path}: per-occurrence exemption expected exactly one code occurrence`;
    const at = found[0].index;
    return /export\s+(?:async\s+)?function\s+aiMergeTask\s*(?:<[^>]*>)?\s*\(/.test(commentFree.slice(Math.max(0, at - 40), at + 160))
      ? null : `${path}: per-occurrence exemption expected declaration-shaped occurrence on code-only projection`;
  }
  if (path === "packages/engine/src/index.ts") {
    if (found.length !== 1) return `${path}: per-occurrence exemption expected exactly one code occurrence`;
    const at = found[0].index;
    const window = specifier.slice(Math.max(0, at - 80), at + 240);
    return /export\s*\{[\s\S]*\baiMergeTask\b[\s\S]*\}\s*from\s*["'][^"']*\/merger\.js["']/.test(window)
      ? null : `${path}: per-occurrence exemption re-export shape mismatch (specifier-preserving projection)`;
  }
  return `${path}: unknown exemption path`;
}
export function listAllTrackedFiles(root = repoRoot) {
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout.split("\n").filter(Boolean);
}
export function listTrackedFiles(root = repoRoot) { return listAllTrackedFiles(root).filter(isCorpusPath); }
/** Compute the required source-root set difference; generic segments must not hide source. */
export function protectedCorpusHoles(allPaths = listAllTrackedFiles(), corpus = listTrackedFiles()) {
  const protectedPath = /^(?:packages\/[^/]+\/src\/|packages\/dashboard\/app\/|plugins\/[^/]+\/src\/)/;
  const scanned = new Set(corpus);
  return allPaths.filter((path) => protectedPath.test(path) && isCorpusPath(path) && !scanned.has(path));
}
export function checkDocs(root = repoRoot) {
  const content = readFileSync(resolve(root, "docs/settings-reference.md"), "utf8");
  return ["prerebaseAutoEnabled", "prerebaseHotFiles", "prerebaseDivergenceThreshold"].flatMap((setting) => {
    const row = content.split("\n").find((line) => line.startsWith(`| \`${setting}\` |`));
    if (!row) return [`docs contract: missing ${setting} row`];
    const failures = [];
    if (row.includes("Stage 1/2")) failures.push("stale Stage 1/2 wording");
    if (!row.includes("**Legacy and inert (master-plan U0)**")) failures.push("missing inert marker");
    if (!row.includes("runAiMerge")) failures.push("missing runAiMerge");
    return failures.map((failure) => `docs contract: ${setting}: ${failure}`);
  });
}
export function scanSources(paths = listTrackedFiles(), root = repoRoot) {
  const failures = [], identifierPaths = new Set(), specifierPaths = new Set();
  const holes = protectedCorpusHoles(undefined, paths);
  if (holes.length) failures.push(`corpus no-hole: excluded protected sources ${holes.join(", ")}`);
  const { exempt, general } = partitionCorpus(paths);
  if (exempt.length !== EXEMPT_PATHS.length || new Set([...exempt, ...general]).size !== paths.length) failures.push("layer routing: exempt/general corpus partition mismatch");
  for (const path of paths) {
    const source = readFileSync(resolve(root, path), "utf8");
    const hasToken = /decideAutoPrerebase|probeDivergence|runAutoPrerebase|aiMergeTask|merger-auto-prerebase/.test(source);
    const mustCheckExemption = EXEMPT_PATHS.includes(path);
    if (!hasToken && !mustCheckExemption) continue;
    const code = maskSource(source, { blankStrings: true });
    const specifier = maskSource(source, { blankStrings: false });
    if (PREBASE_IDS.test(code)) identifierPaths.add(path);
    if (detectsPrerebaseSpecifier(specifier)) specifierPaths.add(path);
    if (mustCheckExemption) {
      const failure = checkExemption(path, code, specifier, source); if (failure) failures.push(failure);
    } else {
      for (const rule of detectLegacyBindings(code)) failures.push(`${path}: ${rule}`);
      for (const rule of detectQuotedAccess(specifier)) failures.push(`${path}: ${rule}`);
    }
  }
  const expectedIds = ["packages/engine/src/merge/merger-auto-prerebase.ts", "packages/engine/src/merger.ts"];
  const expectedSpecifiers = ["packages/engine/src/merger.ts"];
  if (JSON.stringify([...identifierPaths].sort()) !== JSON.stringify(expectedIds)) failures.push(`identifier reachability: expected ${expectedIds.join(", ")}, got ${[...identifierPaths].sort().join(", ")}`);
  if (JSON.stringify([...specifierPaths].sort()) !== JSON.stringify(expectedSpecifiers)) failures.push(`module specifier: expected ${expectedSpecifiers.join(", ")}, got ${[...specifierPaths].sort().join(", ")}`);
  return failures;
}
export function formatFailureMessage(matches) {
  return ["[check-prerebase-inert] retained legacy prerebase contract violated.", "Re-wiring prerebase or aiMergeTask by identifier, import, alias, or package path requires updating docs/settings-reference.md, AGENTS.md item 10, and docs/architecture.md.", ...matches].join("\n");
}
export function main() { const failures = [...checkDocs(), ...scanSources()]; if (!failures.length) return 0; console.error(formatFailureMessage(failures)); return 1; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
