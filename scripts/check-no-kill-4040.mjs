#!/usr/bin/env node
// Repo-wide guard: no code (especially tests) may kill processes on the live
// Fusion dashboard port(s) or bind a server to them. Default reserved port is
// 4040 (the documented default); additional ports may be supplied via the
// FUSION_RESERVED_PORTS env var (comma-separated) so the guard tracks whatever
// port the dashboard is actually configured to use. Use --port 0 or another
// free port. Add `port-4040-allowlist` anywhere in a file's contents to mark
// it as documentation that may legitimately discuss the rule.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWLIST_MARKER = "port-4040-allowlist";

function parsePortList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
}

// The documented default live port is 4040. Additional reserved ports may be
// supplied via FUSION_RESERVED_PORTS (comma-separated) so the guard tracks
// whichever port the dashboard is actually configured to use.
const RESERVED_PORTS = [...new Set([4040, ...parsePortList(process.env.FUSION_RESERVED_PORTS)])];

function buildPatterns(ports) {
  return ports.flatMap((port) => {
    const p = String(port);
    return [
      new RegExp(`\\b(kill|pkill|killall|fuser)\\b[^\\n]*\\b${p}\\b`),
      new RegExp(`\\blsof\\b[^\\n]*\\b${p}\\b`),
      new RegExp(`\\b${p}\\b[^\\n]*\\b(kill|pkill|killall|fuser)\\b`),
      new RegExp(`\\.listen\\s*\\(\\s*${p}\\b`),
    ];
  });
}

export const PATTERNS = buildPatterns(RESERVED_PORTS);

const SCAN_ROOTS = ["packages", "scripts", "plugins"];

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
    .filter((path) => /\.(m?[jt]sx?|cjs|mjs|sh|json|md|mdx|txt)$/.test(path));
}

export function scanFileContent(content, filePath) {
  if (content.includes(ALLOWLIST_MARKER)) return [];
  const matches = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.test(line)) {
        matches.push({ filePath, lineNumber: i + 1, line });
        break;
      }
    }
  }
  return matches;
}

export function scanTrackedFiles(files = listTrackedTargets()) {
  const matches = [];
  for (const filePath of files) {
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    matches.push(...scanFileContent(content, filePath));
  }
  return matches;
}

export function formatFailureMessage(matches) {
  const lines = matches.map(
    ({ filePath, lineNumber, line }) => `${filePath}:${lineNumber}: ${line.trim()}`,
  );
  return [
    `[check-no-kill-4040] found code that may kill or bind reserved Fusion port(s): ${RESERVED_PORTS.join(", ")}.`,
    "These are the live dashboard ports. Use `--port 0` or another free port.",
    "If this match is documentation (e.g. agent prompts), add a `port-4040-allowlist` marker comment to the file.",
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
