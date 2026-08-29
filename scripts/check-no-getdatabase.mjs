#!/usr/bin/env node
/*
FNXC:PostgresOnlyDataAccess 2026-07-16-10:00:
Production plugin, dashboard, engine, and core access must use PostgreSQL through
AsyncDataLayer, after a Quality route reached SQLite in backend mode and crashed.
This scanner bans executable getDatabase() calls. Exceptions live only in the dated,
invocation-pinned JSON allowlist keyed by file+line+snippet: no file-level,
identical-line, or inline-marker bypass exists. Template ${...} expressions remain
executable and are scanned while literal template text is ignored.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_PATH = "scripts/lib/getdatabase-allowlist.json";
export const SCAN_ROOTS = ["plugins", "packages/dashboard", "packages/engine", "packages/core"];

function listTrackedTargets() {
  const result = spawnSync("git", ["ls-files", "--", ...SCAN_ROOTS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function validateAllowlistEntries(entries) {
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} must contain an entries array`);
  return entries.map((entry, index) => {
    const prefix = `${ALLOWLIST_PATH} entries[${index}]`;
    if (!entry || typeof entry.file !== "string" || !entry.file.trim()) throw new Error(`${prefix} must include a non-empty file`);
    if (!Number.isInteger(entry.line) || entry.line < 1) throw new Error(`${prefix} must include a 1-based integer line`);
    if (typeof entry.snippet !== "string" || !entry.snippet.trim()) throw new Error(`${prefix} must include a non-empty snippet`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`${prefix} must include a non-empty reason`);
    if (typeof entry.allowlistedAt !== "string" || Number.isNaN(Date.parse(entry.allowlistedAt))) throw new Error(`${prefix} must include an ISO-8601 allowlistedAt date`);
    return entry;
  });
}

function loadAllowlistEntries(path = ALLOWLIST_PATH) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  return validateAllowlistEntries(parsed.entries);
}

/** Replace non-code with spaces while retaining line/column offsets. */
function codeMask(source) {
  const out = source.split("");
  const blank = (start, end) => { for (let i = start; i < end; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " "; };
  const scan = (start, end, templateExpression = false) => {
    for (let i = start; i < end;) {
      if (source.startsWith("//", i)) { const close = source.indexOf("\n", i + 2); blank(i, close < 0 ? end : close); i = close < 0 ? end : close; continue; }
      if (source.startsWith("/*", i)) { const close = source.indexOf("*/", i + 2); const until = close < 0 ? end : close + 2; blank(i, until); i = until; continue; }
      const quote = source[i];
      if (quote === "'" || quote === '"') {
        let j = i + 1;
        while (j < end) { if (source[j] === "\\") { j += 2; continue; } if (source[j] === quote) { j++; break; } j++; }
        blank(i, j); i = j; continue;
      }
      if (quote === "`") {
        let j = i + 1; blank(i, i + 1);
        while (j < end) {
          if (source[j] === "\\") { blank(j, Math.min(j + 2, end)); j += 2; continue; }
          if (source[j] === "`") { blank(j, j + 1); j++; break; }
          if (source[j] === "$" && source[j + 1] === "{") {
            blank(j, j + 2); let depth = 1; const exprStart = j + 2; j += 2;
            while (j < end && depth) { if (source[j] === "{") depth++; else if (source[j] === "}") depth--; j++; }
            const exprEnd = depth === 0 ? j - 1 : end;
            scan(exprStart, exprEnd, true); if (depth === 0) blank(j - 1, j); continue;
          }
          blank(j, j + 1); j++;
        }
        i = j;
        continue;
      }
      i++;
    }
  };
  scan(0, source.length);
  return out.join("");
}

function closingParen(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function isDeclaration(mask, index, openParen) {
  const before = mask.slice(Math.max(0, index - 100), index);
  if (/\.\s*$/.test(before)) return false;
  const close = closingParen(mask, openParen);
  if (close < 0) return false;
  const after = mask.slice(close + 1, Math.min(mask.length, close + 240));
  const precedingDeclarationToken = /\b(?:function|public|private|protected|static|async|abstract|readonly|declare)\s*$/.test(before);
  const signature = /^\s*(?:\??\s*)?(?::[^\n{;=]+)?\s*(?:\{|;)/.test(after);
  return precedingDeclarationToken || signature;
}

function lineAt(content, index) {
  const lineNumber = content.slice(0, index).split("\n").length;
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", index);
  return { lineNumber, line: content.slice(start, end < 0 ? content.length : end) };
}

export function scanFileContent(content, filePath, options = {}) {
  const entries = validateAllowlistEntries(options.allowlistEntries ?? []);
  const mask = codeMask(content);
  const matches = [];
  const pinned = new Set();
  const pattern = /\bgetDatabase\s*\(/g;
  for (let found; (found = pattern.exec(mask));) {
    const openParen = mask.indexOf("(", found.index);
    if (isDeclaration(mask, found.index, openParen)) continue;
    const { lineNumber, line } = lineAt(content, found.index);
    const exact = entries.find((entry) => entry.file === filePath && entry.line === lineNumber && entry.snippet === line.trim());
    if (exact) { pinned.add(exact); continue; }
    matches.push({ type: "invocation", filePath, lineNumber, line });
  }
  for (const entry of entries) {
    if (entry.file === filePath && !pinned.has(entry)) matches.push({ type: "stale-allowlist", filePath, lineNumber: entry.line, line: entry.snippet });
  }
  return matches;
}

export function scanTrackedFiles(files = listTrackedTargets(), options = {}) {
  const entries = validateAllowlistEntries(options.allowlistEntries ?? loadAllowlistEntries(options.allowlistPath));
  const readFile = options.readFile ?? readFileSync;
  const matches = [];
  const seen = new Set(files);
  for (const entry of entries) if (!seen.has(entry.file)) matches.push({ type: "stale-allowlist", filePath: entry.file, lineNumber: entry.line, line: entry.snippet });
  for (const filePath of files) {
    let content;
    try { content = readFile(filePath, "utf8"); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    matches.push(...scanFileContent(content, filePath, { allowlistEntries: entries }));
  }
  return matches;
}

export function formatFailureMessage(matches) {
  return [
    "[check-no-getdatabase] found non-PostgreSQL durable-data access or a stale exemption.",
    "Use ctx.taskStore.getAsyncLayer() with an async store; see docs/PLUGIN_AUTHORING.md.",
    `Legitimate transitional exemptions must be invocation-pinned in ${ALLOWLIST_PATH} by file+line+snippet (all three required).`,
    ...matches.map(({ type, filePath, lineNumber, line }) => `${type}: ${filePath}:${lineNumber}: ${line.trim()}`),
  ].join("\n");
}

export function main() {
  const matches = scanTrackedFiles();
  if (!matches.length) return 0;
  console.error(formatFailureMessage(matches));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
