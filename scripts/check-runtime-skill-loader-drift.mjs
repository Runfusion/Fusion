#!/usr/bin/env node
/*
FNXC:RuntimeSkillLoaderDrift 2026-08-11-12:05:
The Claude and Grok runtime skill loaders are hand-maintained clones. FN-8986 had to apply the
Darwin-only computer-use gate to both copies, and FN-8989 chose gate-enforced duplication instead
of consolidation: import.meta.url candidate discovery and createRequire origin are layout-sensitive
across source, tsc dist, and published dist/plugins layouts.

This deliberately narrow ratchet canonicalizes only Claude/claude to Grok/grok and requires exact
equality. It keeps one-sided staging edits visible while preserving each loader at its own
module-relative location.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const CLAUDE_PATH = fileURLToPath(new URL("../plugins/fusion-plugin-claude-runtime/src/skill-loader.ts", import.meta.url));
const GROK_PATH = fileURLToPath(new URL("../plugins/fusion-plugin-grok-runtime/src/skill-loader.ts", import.meta.url));
const MINIMUM_LINES = 100;
const MAX_REMAINING_DIFFERENCES = 8;

/** Apply the only intentional Claude-to-Grok substitutions. */
export function canonicalizeClaudeSource(source) {
  return source.replace(/Claude/g, "Grok").replace(/claude/g, "grok");
}

/** Count line-level differences, retaining enough detail for an actionable failure. */
export function findLineDifferences(expected, actual, limit = MAX_REMAINING_DIFFERENCES) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const differences = [];
  const total = Math.max(expectedLines.length, actualLines.length);
  let count = 0;

  for (let index = 0; index < total; index += 1) {
    if (expectedLines[index] === actualLines[index]) continue;
    count += 1;
    if (differences.length < limit) {
      differences.push({
        line: index + 1,
        expected: expectedLines[index] ?? "<end of file>",
        actual: actualLines[index] ?? "<end of file>",
      });
    }
  }

  return { count, differences };
}

function readLoader(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    console.error(`[check-runtime-skill-loader-drift] refusing to report success: unable to read ${label} loader at ${path}: ${error.code ?? error.message}`);
    return null;
  }
}

function hasMinimumContent(source) {
  return source.trim().length > 0 && source.split("\n").length >= MINIMUM_LINES;
}

/** Validate the runtime loaders with optional paths for isolated fixture coverage. */
export function main(argv = process.argv.slice(2), { claudePath = CLAUDE_PATH, grokPath = GROK_PATH } = {}) {
  if (argv.length > 0) {
    console.error("[check-runtime-skill-loader-drift] refusing to report success: this validator accepts no arguments.");
    return 1;
  }

  const claudeSource = readLoader(claudePath, "Claude");
  const grokSource = readLoader(grokPath, "Grok");
  if (claudeSource === null || grokSource === null) return 1;

  if (!hasMinimumContent(claudeSource) || !hasMinimumContent(grokSource)) {
    console.error(`[check-runtime-skill-loader-drift] refusing to report success: both loaders must be non-empty and contain at least ${MINIMUM_LINES} lines (${claudePath}, ${grokPath}).`);
    return 1;
  }

  if (/Grok|grok/.test(claudeSource)) {
    console.error(`[check-runtime-skill-loader-drift] refusing to report success: Claude loader ${claudePath} contains a raw Grok/grok token.`);
    return 1;
  }

  const canonicalClaude = canonicalizeClaudeSource(claudeSource);
  if (canonicalClaude === claudeSource) {
    console.error(`[check-runtime-skill-loader-drift] refusing to report success: canonicalization made zero Claude/claude substitutions in ${claudePath}.`);
    return 1;
  }

  if (!claudeSource.includes("stageClaudeSessionSkills") || !grokSource.includes("stageGrokSessionSkills")) {
    console.error(`[check-runtime-skill-loader-drift] refusing to report success: expected sentinel exports stageClaudeSessionSkills and stageGrokSessionSkills are required.`);
    return 1;
  }

  const { count, differences } = findLineDifferences(canonicalClaude, grokSource);
  if (count > 0) {
    const first = differences[0];
    console.error("\n[check-runtime-skill-loader-drift] runtime skill loaders differ after canonicalization:");
    console.error(`  first difference: line ${first.line}`);
    console.error(`  canonical Claude: ${first.expected}`);
    console.error(`  Grok:             ${first.actual}`);
    for (const difference of differences.slice(1)) {
      console.error(`  also differs at line ${difference.line}: canonical Claude=${difference.expected} | Grok=${difference.actual}`);
    }
    if (count > differences.length) console.error(`  ... and ${count - differences.length} additional differing line(s).`);
    console.error(`\nUpdate ${claudePath} and ${grokPath} so the two loaders remain a clean Claude↔Grok rename-diff (FN-8989 Option C).\n`);
    return 1;
  }

  console.log(`[check-runtime-skill-loader-drift] Claude and Grok loaders match as a clean rename-diff (${claudeSource.split("\n").length} lines).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
