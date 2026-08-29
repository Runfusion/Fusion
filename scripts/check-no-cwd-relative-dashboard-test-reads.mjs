#!/usr/bin/env node
/*
FNXC:DashboardTests 2026-07-26-06:15:
Dashboard app tests must read source through module-relative resolution. A bare app path or process.cwd()-anchored read makes root-launched Vitest crash during import, so this merge guard rejects the coupling before it returns.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_TEST_PATH = /^packages\/dashboard\/app\/.+__tests__\/.+\.test\.[cm]?[jt]sx?$/;
const FILE_READ = /(?:\b\w+\.)?(?:readFileSync|readFile|existsSync)\s*\(([\s\S]{0,240}?)(?:\)|,)/g;
const CWD_REFERENCE = /\bprocess\.cwd\s*\(/;
const BARE_PATH = /^\s*["'](?:\.{1,2}\/|app\/)/;

function listTrackedTests() {
  const result = spawnSync("git", ["ls-files", "--", "packages/dashboard/app"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return result.stdout.split("\n").filter((path) => APP_TEST_PATH.test(path));
}

export function scanFileContent(content, filePath) {
  const matches = [];
  for (const match of content.matchAll(FILE_READ)) {
    const argument = match[1];
    if (!CWD_REFERENCE.test(argument) && !BARE_PATH.test(argument)) continue;
    const lineNumber = content.slice(0, match.index).split(/\r?\n/).length;
    matches.push({ filePath, lineNumber, line: content.split(/\r?\n/)[lineNumber - 1] });
  }
  return matches;
}

export function main() {
  const matches = listTrackedTests().flatMap((filePath) => scanFileContent(readFileSync(filePath, "utf8"), filePath));
  if (matches.length === 0) return 0;
  console.error(["[check-no-cwd-relative-dashboard-test-reads] use app/test/cssFixture helpers for dashboard source reads.", ...matches.map((match) => `${match.filePath}:${match.lineNumber}: ${match.line.trim()}`)].join("\n"));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
