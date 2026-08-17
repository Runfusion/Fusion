#!/usr/bin/env node
/*
FNXC:TestQuarantine 2026-07-12-00:00:
The flaky-test deletion ratchet had no visibility tool for entries approaching the `quarantinedAt + 14d` deletion deadline.
This report surfaces near-deadline quarantines so maintainers can make deliberate rescue-or-expire decisions while preserving the policy's report-only default; `--strict` is the opt-in enforcement path.

FNXC:QuarantineLockstep 2026-08-17-11:10:
A ledger row and its Vitest exclusion are one quarantine decision. Scan only comment-free `exclude:` array literals so stale FNXC prose and dashboard include shards cannot turn a disposition check into a false failure; strict mode rejects either half pointing at a missing test file.
*/

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_QUARANTINE_PATH, DELETION_CLOCK_DAYS } from "./test-velocity-baseline.mjs";

const MS_PER_DAY = 86_400_000;
const DEFAULT_WARN_WITHIN_DAYS = 5;
const REASON_MAX_LENGTH = 140;

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

function toDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ageDays(quarantinedAt, now) {
  const quarantinedAtDate = toDate(quarantinedAt);
  if (!quarantinedAtDate) return null;
  return Math.floor((now.getTime() - quarantinedAtDate.getTime()) / MS_PER_DAY);
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeWarnWithinDays(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--warn-within must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

function truncateReason(reason) {
  const normalized = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= REASON_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

function summarizeRows(rows) {
  return rows.reduce(
    (summary, row) => {
      summary[row.status] += 1;
      summary.total += 1;
      return summary;
    },
    { total: 0, expired: 0, near: 0, healthy: 0, unknown: 0 },
  );
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function extractBalancedArray(source, openingBracket) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openingBracket; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(openingBracket, index + 1);
    }
  }
  return null;
}

function extractConcreteExcludes(source) {
  const commentFree = stripComments(source);
  const excludes = [];
  const excludePattern = /\bexclude\s*:/g;
  let match;
  while ((match = excludePattern.exec(commentFree))) {
    let index = match.index + match[0].length;
    while (/\s/.test(commentFree[index] ?? "")) index += 1;
    if (commentFree[index] !== "[") continue;
    const array = extractBalancedArray(commentFree, index);
    if (array == null) continue;
    const strings = /"((?:\\.|[^"\\])*)"/g;
    let stringMatch;
    while ((stringMatch = strings.exec(array))) {
      const value = JSON.parse(`"${stringMatch[1]}"`);
      if (/\.test\.tsx?$/.test(value) && !/[*?{}]/.test(value)) excludes.push(value);
    }
    excludePattern.lastIndex = index + array.length;
  }
  return excludes;
}

function discoverPackageConfigs(rootDir) {
  const packagesRoot = path.join(rootDir, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "vitest.config.ts"))
    .filter((config) => existsSync(path.join(rootDir, config)));
}

function normalizeConfigPath(rootDir, config) {
  return path.isAbsolute(config) ? config : path.join(rootDir, config);
}

/**
 * Checks the two directions of the quarantine decision without evaluating Vitest configuration.
 * `packageConfigs` accepts root-relative or absolute config paths to keep fixture tests narrow.
 */
export function findLockstepViolations({ rootDir, ledger, packageConfigs = discoverPackageConfigs(rootDir) }) {
  const configExcludes = new Map();
  for (const config of packageConfigs) {
    const configPath = normalizeConfigPath(rootDir, config);
    if (!existsSync(configPath)) continue;
    const relativeConfig = path.relative(rootDir, configPath);
    configExcludes.set(relativeConfig, extractConcreteExcludes(readFileSync(configPath, "utf8")));
  }

  const violations = [];
  for (const entry of Array.isArray(ledger?.entries) ? ledger.entries : []) {
    const file = String(entry?.file ?? "");
    const filePath = path.join(rootDir, file);
    if (!existsSync(filePath)) {
      violations.push({ kind: "missing-file", file, detail: "ledger entry names no file on disk" });
      continue;
    }

    const packageMatch = /^packages\/([^/]+)\/(.+)$/.exec(file);
    const config = packageMatch ? path.join("packages", packageMatch[1], "vitest.config.ts") : null;
    if (config == null || !configExcludes.has(config)) {
      violations.push({ kind: "unmapped-entry", file, config: config ?? undefined, detail: "ledger file has no package Vitest config" });
      continue;
    }

    const packageRelativeFile = packageMatch[2];
    if (!configExcludes.get(config).includes(packageRelativeFile)) {
      violations.push({ kind: "missing-exclude", file, config, detail: "ledger file is absent from the package exclude array" });
    }
  }

  for (const [config, excludes] of configExcludes) {
    for (const excludedFile of excludes) {
      const packageRoot = path.dirname(config);
      if (!existsSync(path.join(rootDir, packageRoot, excludedFile))) {
        violations.push({ kind: "dangling-exclude", file: path.join(packageRoot, excludedFile), config, detail: "exclude array names no file on disk" });
      }
    }
  }
  return violations;
}

export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return { entries: [] };
  const json = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (json?.entries != null && !Array.isArray(json.entries)) {
    throw new Error(`quarantine ledger ${ledgerPath} must have an "entries" array`);
  }
  return json ?? { entries: [] };
}

export function computeDeadlines(json, { now = new Date(), warnWithinDays = DEFAULT_WARN_WITHIN_DAYS } = {}) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const rows = entries.map((entry, index) => {
    const quarantinedAtDate = toDate(entry?.quarantinedAt);
    const age = ageDays(entry?.quarantinedAt, now);
    const daysRemaining = age == null ? null : DELETION_CLOCK_DAYS - age;
    const deadlineDate = quarantinedAtDate == null ? null : new Date(quarantinedAtDate.getTime() + DELETION_CLOCK_DAYS * MS_PER_DAY);
    let status = "unknown";
    if (daysRemaining != null) status = daysRemaining <= 0 ? "expired" : daysRemaining <= warnWithinDays ? "near" : "healthy";
    return { index, file: entry?.file ?? "unknown", reason: entry?.reason ?? "", quarantinedAt: entry?.quarantinedAt ?? null, ageDays: age, daysRemaining, deadline: deadlineDate == null ? null : formatIsoDate(deadlineDate), status };
  });
  return rows.sort((a, b) => {
    if (a.deadline == null && b.deadline == null) return a.index - b.index;
    if (a.deadline == null) return 1;
    if (b.deadline == null) return -1;
    return a.deadline.localeCompare(b.deadline) || a.file.localeCompare(b.file) || a.index - b.index;
  });
}

export function renderReport(rows, { warnWithinDays = DEFAULT_WARN_WITHIN_DAYS, violations = [] } = {}) {
  const summary = summarizeRows(rows);
  const lines = [
    "Quarantine ledger deadline report",
    `Deletion clock: quarantinedAt + ${DELETION_CLOCK_DAYS} days; near-deadline window: ${warnWithinDays} days`,
    `Summary: total=${summary.total} expired=${summary.expired} near=${summary.near} healthy=${summary.healthy} unknown=${summary.unknown} lockstep=${violations.length}`,
  ];
  if (rows.length === 0) lines.push("Ledger is empty; nothing quarantined.");
  else {
    lines.push("Entries (soonest deadline first):");
    for (const row of rows) {
      const timing = row.status === "expired" ? `EXPIRED (${Math.abs(row.daysRemaining)} day${Math.abs(row.daysRemaining) === 1 ? "" : "s"} overdue)` : row.daysRemaining == null ? "deadline unknown" : `${row.daysRemaining} day${row.daysRemaining === 1 ? "" : "s"} remaining`;
      lines.push(`- [${row.status}] ${row.file} — ${timing}; deadline=${row.deadline ?? "unknown"}; reason=${truncateReason(row.reason) || "no reason recorded"}`);
    }
  }
  if (violations.length > 0) {
    lines.push("Lockstep violations:");
    for (const violation of violations) lines.push(`- [${violation.kind}] ${violation.file}${violation.config ? ` (${violation.config})` : ""}: ${violation.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = { warnWithinDays: DEFAULT_WARN_WITHIN_DAYS, json: false, strict: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--warn-within=")) args.warnWithinDays = normalizeWarnWithinDays(arg.slice("--warn-within=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2), { rootDir = repoRoot, stdout = process.stdout, stderr = process.stderr, now = new Date(), ledgerPath = path.join(rootDir, DEFAULT_QUARANTINE_PATH) } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (error) { stderr.write(`${error.message}\n`); return 1; }
  if (args.help) { stdout.write("Usage: node scripts/check-quarantine-ledger.mjs [--warn-within=<days>] [--json] [--strict]\n"); return 0; }
  let ledger;
  try { ledger = readLedger(ledgerPath); } catch (error) { stderr.write(`Failed to read quarantine ledger: ${error.message}\n`); return 1; }
  const rows = computeDeadlines(ledger, { now, warnWithinDays: args.warnWithinDays });
  const violations = findLockstepViolations({ rootDir, ledger });
  const summary = { ...summarizeRows(rows), lockstep: violations.length };
  if (args.json) stdout.write(`${JSON.stringify({ summary, rows, lockstep: violations }, null, 2)}\n`);
  else stdout.write(renderReport(rows, { warnWithinDays: args.warnWithinDays, violations }));
  return args.strict && (summary.expired > 0 || summary.near > 0 || violations.length > 0) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
