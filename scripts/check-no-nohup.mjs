#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const token = ["no", "hup"].join("");
const tokenPattern = new RegExp(`\\b${token}\\b`);
const allowlistMarker = "process-supervisor-allowlist";

function listTrackedTargets() {
  const result = spawnSync("git", ["ls-files", "--", "packages", "scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "git ls-files failed");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function scanFileContent(content, filePath) {
  const matches = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!tokenPattern.test(line) || line.includes(allowlistMarker)) {
      continue;
    }
    matches.push({ filePath, lineNumber: index + 1, line });
  }
  return matches;
}

export function scanTrackedFiles(files = listTrackedTargets(), readFile = readFileSync) {
  const matches = [];
  for (const filePath of files) {
    let content;
    try {
      content = readFile(filePath, "utf8");
    } catch (error) {
      /*
      FNXC:MergeGateSourceScan 2026-07-14-01:41:
      Git continues listing an unstaged deletion as tracked, so source guards may skip ENOENT while the deletion awaits commit. Permission, I/O, and other read failures must still fail the gate rather than silently omitting tracked source from enforcement.
      */
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    matches.push(...scanFileContent(content, filePath));
  }
  return matches;
}

export function formatFailureMessage(matches) {
  const lines = matches.map(({ filePath, lineNumber, line }) => `${filePath}:${lineNumber}: ${line.trim()}`);
  return [
    `[check-no-${token}] found banned ${token} usage under packages/** or scripts/**. Use superviseSpawn(...) instead.`,
    ...lines,
  ].join("\n");
}

export function main() {
  const matches = scanTrackedFiles();
  if (matches.length === 0) {
    return 0;
  }

  console.error(formatFailureMessage(matches));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
