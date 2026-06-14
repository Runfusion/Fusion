#!/usr/bin/env node
/*
FNXC:TestHygiene 2026-06-14-03:15:
Repo policy forbids hiding slow or flaky Vitest suites with file-level or suite-level timeout bumps.
This guard blocks new `testTimeout` and `hookTimeout` appeasement in tracked test files, while a dated allowlist records temporary legacy exemptions that must link to the owning cleanup or quarantine work.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_PATH = "scripts/lib/test-timeout-appeasement-allowlist.json";
const SCAN_ROOTS = ["packages", "plugins"];
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const VITEST_CONFIG_PATTERN = /(?:^|\/)vitest\.config\.[mc]?[jt]s$/;
const TIMEOUT_PROPERTY_PATTERN = /\b(?:testTimeout|hookTimeout)\s*:/;

function isTestFile(filePath) {
  return TEST_FILE_PATTERN.test(filePath) && !VITEST_CONFIG_PATTERN.test(filePath);
}

function listTrackedTargets() {
  const result = spawnSync("git", ["ls-files", "--", ...SCAN_ROOTS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "git ls-files failed");
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isTestFile);
}

function loadAllowlistEntries(allowlistPath = ALLOWLIST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${allowlistPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${allowlistPath} must contain an entries array`);
  }

  return parsed.entries;
}

function buildAllowlistedFiles(entries) {
  const files = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.file !== "string" || entry.file.trim() === "") {
      throw new Error(`${ALLOWLIST_PATH} entries[${index}] must include a non-empty file`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(`${ALLOWLIST_PATH} entries[${index}] for ${entry.file} must include a non-empty reason`);
    }
    files.add(entry.file);
  }
  return files;
}

export function scanFileContent(content, filePath, options = {}) {
  if (!isTestFile(filePath)) return [];

  const allowlistedFiles = options.allowlistedFiles ?? buildAllowlistedFiles(options.allowlistEntries ?? []);
  if (allowlistedFiles.has(filePath)) return [];

  const matches = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (TIMEOUT_PROPERTY_PATTERN.test(line)) {
      matches.push({ filePath, lineNumber: index + 1, line });
    }
  }
  return matches;
}

export function scanTrackedFiles(files = listTrackedTargets(), options = {}) {
  const allowlistedFiles = options.allowlistedFiles ?? buildAllowlistedFiles(options.allowlistEntries ?? loadAllowlistEntries());
  const matches = [];
  for (const filePath of files) {
    if (!isTestFile(filePath) || allowlistedFiles.has(filePath)) continue;
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    matches.push(...scanFileContent(content, filePath, { allowlistedFiles }));
  }
  return matches;
}

export function formatFailureMessage(matches) {
  const lines = matches.map(
    ({ filePath, lineNumber, line }) => `${filePath}:${lineNumber}: ${line.trim()}`,
  );
  return [
    "[check-no-test-timeout-appeasement] found Vitest timeout appeasement in tracked test files.",
    "Do not raise per-file/suite timeouts to mask slow/flaky tests — quarantine via `scripts/lib/test-quarantine.json` or narrow the seam; see AGENTS.md 'Do Not Add Slow Tests'.",
    `For legitimately exempt legacy cases, add a dated rationale to ${ALLOWLIST_PATH}; exemptions are temporary and should point at the owning cleanup task.`,
    ...lines,
  ].join("\n");
}

export function main() {
  const matches = scanTrackedFiles();
  if (matches.length === 0) return 0;
  console.error(formatFailureMessage(matches));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
