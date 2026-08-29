#!/usr/bin/env node
/*
FNXC:DashboardBrowserSafeCore 2026-07-16-12:00:
Dashboard browser code must value-import only confirmed browser-safe @fusion/core leaves.
The package-root Vite alias resolves to types.ts, while relative core/src imports bypass that
alias and can pull Node-only dependencies such as node:crypto into the client bundle.
Keep the dated allowlist limited to leaves whose transitive dependencies were reviewed.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_PATH = "scripts/lib/dashboard-browser-safe-core-modules.json";
export const DASHBOARD_APP_ROOT = "packages/dashboard/app";

function listTrackedTargets() {
  const result = spawnSync("git", ["ls-files", "--", DASHBOARD_APP_ROOT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout.split("\n").map((filePath) => filePath.trim()).filter((filePath) => {
    return /\.tsx?$/.test(filePath) && !/(?:^|\/)__tests__\/|\.test\.[^/]+$/.test(filePath);
  });
}

function loadAllowlist(path = ALLOWLIST_PATH) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(parsed.modules)) throw new Error(`${path} must contain a modules array`);
  return validateAllowlist(parsed.modules);
}

export function validateAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} allowlist must be an array`);
  return new Set(entries.map((entry, index) => {
    const prefix = `${ALLOWLIST_PATH} modules[${index}]`;
    if (!entry || typeof entry.module !== "string" || !entry.module.trim()) throw new Error(`${prefix} must include a non-empty module`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`${prefix} must include a non-empty reason`);
    if (typeof entry.verifiedAt !== "string" || Number.isNaN(Date.parse(entry.verifiedAt))) throw new Error(`${prefix} must include an ISO-8601 verifiedAt date`);
    return entry.module;
  }));
}

/** Blank comments and strings while retaining offsets, so source-text mentions cannot resemble imports. */
function codeMask(source) {
  const out = source.split("");
  const blank = (start, end) => { for (let index = start; index < end; index++) if (out[index] !== "\n" && out[index] !== "\r") out[index] = " "; };
  for (let index = 0; index < source.length;) {
    if (source.startsWith("//", index)) {
      const close = source.indexOf("\n", index + 2);
      blank(index, close < 0 ? source.length : close);
      index = close < 0 ? source.length : close;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }
    if (["'", '"', "`"].includes(source[index])) {
      const quote = source[index];
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === quote) { end++; break; }
        end++;
      }
      blank(index, end);
      index = end;
      continue;
    }
    index++;
  }
  return out.join("");
}

function moduleFromSpecifier(specifier) {
  const relative = /(?:^|\/)core\/src\/([^/?#]+)$/.exec(specifier);
  if (relative) return relative[1].replace(/\.(?:[cm]?[jt]sx?)$/, "");
  const subpath = /^@fusion\/core\/([^/?#]+)$/.exec(specifier);
  return subpath?.[1] ?? null;
}

/*
FNXC:DashboardBrowserSafeCore 2026-07-16-12:30:
The browser-safety boundary applies to dynamic value imports too. In particular, Vite's @vite-ignore comment and an untagged template literal do not make a core/src store import type-only or browser-safe.
*/
function dynamicSpecifierAt(content, start) {
  const match = /^import\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(["'`])([^"'`$]+)\1\s*\)/.exec(content.slice(start));
  return match?.[2] ?? null;
}

function isTypeOnly(kind, typeKeyword, clause) {
  if (typeKeyword) return true;
  if (kind === "export" && /^type\b/.test(clause.trim())) return true;
  const trimmed = clause.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const specifiers = trimmed.slice(1, -1).split(",").map((specifier) => specifier.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s+/.test(specifier));
}

function lineAt(content, index) {
  const lineNumber = content.slice(0, index).split("\n").length;
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", index);
  return { lineNumber, line: content.slice(start, end < 0 ? content.length : end).trim() };
}

function normalizeAllowlist(allowlist) {
  if (allowlist instanceof Set) return allowlist;
  if (Array.isArray(allowlist)) return new Set(allowlist);
  if (allowlist && Array.isArray(allowlist.modules)) return validateAllowlist(allowlist.modules);
  return loadAllowlist();
}

export function scanFileContent(content, filePath, { allowlist } = {}) {
  const safeModules = normalizeAllowlist(allowlist);
  const mask = codeMask(content);
  const matches = [];
  const keywordPattern = /\b(import|export)\b/g;
  for (let keywordMatch; (keywordMatch = keywordPattern.exec(content));) {
    const kind = keywordMatch[1];
    if (mask.slice(keywordMatch.index, keywordMatch.index + kind.length) !== kind) continue;
    const statement = content.slice(keywordMatch.index);
    const fromMatch = /^(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+(["'])([^"']+)\4/.exec(statement);
    const sideEffectMatch = /^import\s+(["'])([^"']+)\1/.exec(statement);
    const typeKeyword = fromMatch?.[2];
    const clause = fromMatch?.[3] ?? "";
    const specifier = fromMatch?.[5] ?? sideEffectMatch?.[2] ?? dynamicSpecifierAt(content, keywordMatch.index);
    if (!specifier) continue;
    const module = moduleFromSpecifier(specifier);
    if (!module || safeModules.has(module) || isTypeOnly(kind, typeKeyword, clause)) continue;
    const { lineNumber, line } = lineAt(content, keywordMatch.index);
    matches.push({ type: "node-only-core-import", filePath, lineNumber, line, specifier, module });
  }
  return matches;
}

export function scanTrackedFiles(files = listTrackedTargets(), { allowlist, readFile = readFileSync } = {}) {
  const matches = [];
  for (const filePath of files) {
    let content;
    try { content = readFile(filePath, "utf8"); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    matches.push(...scanFileContent(content, filePath, { allowlist }));
  }
  return matches;
}

export function formatFailureMessage(matches) {
  return [
    "[check-no-node-only-core-imports-in-dashboard] found a dashboard browser value import outside the browser-safe core allowlist.",
    "Dashboard browser code may value-import only reviewed core leaves; use near-duplicate-canonical.ts instead of near-duplicate.ts.",
    `After verifying transitive dependencies contain no Node-only modules, add a dated entry to ${ALLOWLIST_PATH}.`,
    ...matches.map(({ filePath, lineNumber, line }) => `${filePath}:${lineNumber}: import: ${line}`),
  ].join("\n");
}

export function main() {
  const matches = scanTrackedFiles();
  if (!matches.length) return 0;
  console.error(formatFailureMessage(matches));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
