#!/usr/bin/env node
/*
FNXC:CI 2026-06-21-00:04:
New source files must not be born as god-files. This guard caps new files under
packages/scripts/plugins at MAX_LINES (2000) lines to keep the codebase
splittable and reviewable. The 106 files already over the cap can't be
refactored in one PR, so they are grandfathered through a ratchet baseline
(line-count-baseline.json): each is pinned to its current count and may shrink
but never grow, applying steady downward pressure without blocking unrelated
work. Generated/lock/locale/.d.ts files are out of scope so the guard only
governs hand-written source.

FNXC:CI 2026-06-21-00:30:
FN-6849 re-ratcheted 26 grandfathered ceilings to current counts after organic
feature and test growth, while also tightening three entries that had already
shrunk. Large-file reduction remains the intended long-term direction, but that
work belongs in dedicated follow-up refactors rather than a pretest-unblock
maintenance change.

FNXC:CI 2026-06-21-12:35:
FN-6871 corrects the stale premise that line-count drift blocks `pnpm test`: FN-5048 removed this guard from pretest, so it now runs only through the opt-in `check:line-count` audit. Eleven grandfathered files were re-ratcheted to current counts after small organic feature/test growth; broad shrink/refactor work for these god-files remains the long-term direction and belongs in dedicated follow-up tasks.

FNXC:CI 2026-06-21-23:53:
FN-6917 re-confirms the `pnpm test`-blocking premise is stale because FN-5048 left this guard opt-in under `check:line-count` only. Twenty files were re-ratcheted after organic feature/test growth; `TerminalModal.tsx` was grandfathered after crossing the hard cap as a long-existing file, with focused split follow-up FN-6918. Wholesale god-file shrink/refactor remains the long-term direction and stays deferred to dedicated follow-ups.

FNXC:CI 2026-06-25-00:00:
FN-7013 re-confirms the `pnpm test`-blocking premise is stale: FN-5048 removed this guard from pretest and left it opt-in under `check:line-count` only. Sixty-one current violations were re-ratcheted after organic feature/test growth and eight stale baseline entries were tightened or pruned. `AgentLogViewer.test.tsx` and `merger-ai.ts` were temporarily grandfathered after crossing the hard cap as long-existing files, with focused split follow-ups FN-7028 and FN-7029. Wholesale god-file shrink/refactor remains the long-term direction and stays deferred to dedicated follow-ups.

FNXC:CI 2026-06-25-17:44:
FN-7035 split the two new hard-cap crossers (`ChatView.core.test.tsx` and `notifier.test.ts`) into focused sibling suites rather than grandfathering them. Six existing grandfathered entries were re-ratcheted to current counts after organic test and feature growth; `store.ts` and `types.ts` drift was left out of scope for a follow-up. Wholesale god-file shrink remains long-term deferred work for dedicated refactors.

FNXC:CI 2026-06-25-22:08:
FN-7046 repaired the deferred `store.ts`/`types.ts` line-count drift by re-ratcheting only those two baseline ceilings after organic Code Review workflow-step and MCP configuration growth. Wholesale god-file shrink remains long-term deferred work for dedicated refactors, and unrelated line-count violations must not be bundled into this scoped repair.

FNXC:CI 2026-06-25-23:10:
FN-7050 repaired the `routes.ts`/`executor.ts` line-count drift by re-ratcheting only those two baseline ceilings after organic execution-lane model growth. Wholesale god-file shrink remains long-term deferred work for dedicated refactors, and this repair intentionally excludes FN-7046's `store.ts`/`types.ts` entries and FN-7044's `areas.test.tsx` split.
*/
// Repo-wide guard: hand-written source files may not exceed a hard line-count
// cap (MAX_LINES). This stops the next god-file from being born while leaving
// today's known offenders to be refactored down over time.
//
// Existing oversized files are grandfathered via scripts/line-count-baseline.json,
// which records each file's current line count as its personal ceiling. The
// baseline is a RATCHET: a grandfathered file may shrink (or stay put) but may
// never grow past its recorded count, and once it drops to the cap it is removed
// from the baseline and can never regress. New files get no grandfathering and
// must stay at or under MAX_LINES.
//
// Generated, vendored, and data files are out of scope: only source extensions
// under SCAN_ROOTS are scanned, and *.d.ts is excluded. Lockfiles, CHANGELOG,
// locale JSON, and snapshots never match because of the extension filter.
//
// Run `node scripts/check-file-line-count.mjs --update` to rewrite the baseline
// after an intentional, reviewed change to the set of oversized files.
//
// FNXC:TestInfrastructure 2026-06-21-10:00:
// Line-count drift remains visible through the explicit check:line-count audit,
// but it must not block `pnpm test` from reaching the real test runner. The test
// preflight owns fast safety checks; broad god-file cleanup is tracked separately
// so unrelated task completion is not stuck before tests start.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

export const MAX_LINES = 2000;

const SCAN_ROOTS = ["packages", "scripts", "plugins"];
const SOURCE_EXT = /\.(m?[jt]sx?|cjs)$/;
const DECLARATION_EXT = /\.d\.ts$/;

const BASELINE_PATH = fileURLToPath(new URL("./line-count-baseline.json", import.meta.url));

export function loadBaseline(path = BASELINE_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function listTrackedSources() {
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
    .filter((path) => SOURCE_EXT.test(path) && !DECLARATION_EXT.test(path));
}

export function countLines(content) {
  if (content === "") return 0;
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutTrailingNewline.split(/\r?\n/).length;
}

// Returns { violations, staleBaseline } for the given file→lineCount map.
// `violations` are hard failures; `staleBaseline` lists baseline entries that
// could be tightened (file shrank to/under the cap, or no longer exists).
export function evaluate(counts, baseline = loadBaseline()) {
  const violations = [];
  for (const [filePath, lines] of Object.entries(counts)) {
    const ceiling = filePath in baseline ? baseline[filePath] : MAX_LINES;
    if (lines > ceiling) {
      violations.push({
        filePath,
        lines,
        ceiling,
        grandfathered: filePath in baseline,
      });
    }
  }

  const staleBaseline = [];
  for (const [filePath, recorded] of Object.entries(baseline)) {
    if (!(filePath in counts)) {
      staleBaseline.push({ filePath, reason: "deleted" });
    } else if (counts[filePath] <= MAX_LINES) {
      staleBaseline.push({ filePath, reason: "under-cap", lines: counts[filePath] });
    } else if (counts[filePath] < recorded) {
      staleBaseline.push({ filePath, reason: "shrank", lines: counts[filePath], recorded });
    }
  }

  return { violations, staleBaseline };
}

export function collectCounts(files = listTrackedSources()) {
  const counts = {};
  for (const filePath of files) {
    // A tracked file that can't be read must fail the guard, not be skipped:
    // silently continuing would let an unreadable file evade the cap (false pass).
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`[check-file-line-count] failed to read tracked file ${filePath}: ${error.message}`);
    }
    counts[filePath] = countLines(content);
  }
  return counts;
}

export function formatFailureMessage(violations) {
  const lines = violations.map(({ filePath, lines: n, ceiling, grandfathered }) =>
    grandfathered
      ? `${filePath}: ${n} lines (grandfathered ceiling ${ceiling} — this file grew and must shrink, not expand)`
      : `${filePath}: ${n} lines (cap ${ceiling})`,
  );
  return [
    `[check-file-line-count] ${violations.length} file(s) exceed the line-count guardrail:`,
    "",
    ...lines,
    "",
    `New source files must stay at or under ${MAX_LINES} lines. Split the file into`,
    "focused modules. Grandfathered files (in scripts/line-count-baseline.json) may",
    "shrink but never grow; refactor them down rather than raising their ceiling.",
    "If a larger file is genuinely justified, update the baseline with",
    "`node scripts/check-file-line-count.mjs --update` in a reviewed change.",
  ].join("\n");
}

function buildBaseline(counts) {
  const baseline = {};
  for (const filePath of Object.keys(counts).sort()) {
    if (counts[filePath] > MAX_LINES) baseline[filePath] = counts[filePath];
  }
  return baseline;
}

export function main(argv = process.argv.slice(2)) {
  const counts = collectCounts();

  if (argv.includes("--update")) {
    const baseline = buildBaseline(counts);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.error(
      `[check-file-line-count] baseline rewritten: ${Object.keys(baseline).length} file(s) over ${MAX_LINES} lines.`,
    );
    return 0;
  }

  const { violations, staleBaseline } = evaluate(counts);

  // Any stale entry — shrunk, dropped under the cap, or deleted — means the
  // baseline can ratchet down. Deleted-only entries must trigger this note too,
  // otherwise removed files sit in the baseline forever with no prompt to prune.
  if (staleBaseline.length > 0) {
    console.error(
      `[check-file-line-count] note: ${staleBaseline.length} baseline entr(ies) can be tightened ` +
        "(files shrank, dropped under the cap, or were deleted). Run with --update to ratchet the baseline down.",
    );
  }

  if (violations.length === 0) return 0;
  console.error(formatFailureMessage(violations));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
