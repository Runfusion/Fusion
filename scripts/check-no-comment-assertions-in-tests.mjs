#!/usr/bin/env node
/*
FNXC:TestHygiene 2026-08-23-23:50:
TESTS ASSERT BEHAVIOR, NEVER COMMENT TEXT. A test that pins an `FNXC:` block, a date stamp, or any
comment prose from a source/CSS file guards documentation instead of behavior — and this repo's own
convention tells authors to keep those comments updated as requirements change, so the two rules
fight and the test loses in the worst possible way.

Measured 2026-08-23: a commit legitimately rewrote `runTaskMerge` and dropped its FNXC block;
`grok-runtime-bootstrap.test.ts` went red because it asserted that comment existed, and the "fix"
was to RE-ADD THE COMMENT to the product file. A comment returned to the shipped source not because
it documented anything true, but to appease a test. Four more such assertions existed across the
dashboard's CSS tests, each sitting beside a real assertion and adding nothing.

Scope is deliberately narrow. This bans asserting PROSE. Guards that scan source for CODE CONSTRUCTS
or call-site allowlists — engine-no-blocking-shellout, vi-mock specifier resolution, durable-write
and emit-surface inventories, legacy tombstones — are a different category, are mandated elsewhere
in AGENTS.md, and are untouched here.

If a pinned comment was standing in for a real invariant, assert the invariant: the rendered style,
the observable outcome, the absent construct. If nothing behavioral is behind it, delete the line.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCAN_ROOTS = ["packages", "plugins"];
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
/*
An assertion matcher applied to a string carrying an FNXC stamp.

DELIBERATELY NARROW: an earlier draft also flagged `/*` and `*​/` as comment delimiters and produced
24 false positives and zero true ones - every hit was a path glob or a legitimate pattern
assertion, which a regex cannot tell apart from comment prose. Comment prose is not reliably distinguishable from
data by regex, so this check enforces the one unambiguous, observed case and the standing rule in
AGENTS.md covers the rest for human and agent reviewers.
*/
const ASSERTION_PATTERN =
  /\.(?:toContain|toMatch|toContainEqual|toHaveTextContent)\s*\(\s*[`"'][^`"']*FNXC:/;

function isTestFile(filePath) {
  return TEST_FILE_PATTERN.test(filePath);
}

function listTrackedTestFiles() {
  const result = spawnSync("git", ["ls-files", "--", ...SCAN_ROOTS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout.split("\n").map((line) => line.trim()).filter(isTestFile);
}

export function scanTrackedFiles(files = listTrackedTestFiles()) {
  const matches = [];
  for (const filePath of files) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("FNXC:")) continue;
    source.split("\n").forEach((line, index) => {
      if (ASSERTION_PATTERN.test(line)) {
        matches.push({ filePath, lineNumber: index + 1, line });
      }
    });
  }
  return matches;
}

export function formatFailureMessage(matches) {
  return [
    "[check-no-comment-assertions-in-tests] a test asserts COMMENT TEXT instead of behavior.",
    "Comments are documentation: AGENTS.md asks authors to keep FNXC blocks current, so pinning one guarantees a future false failure —",
    "and the tempting 'fix' is to re-add a comment to product source purely to satisfy the test (observed 2026-08-23).",
    "Assert the behavior instead — the rendered style, the observable outcome, the absent code construct — or delete the assertion if nothing behavioral is behind it.",
    "Code-construct and call-site-allowlist guards are a different category and are not affected by this check.",
    ...matches.map(({ filePath, lineNumber, line }) => `${filePath}:${lineNumber}: ${line.trim()}`),
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
