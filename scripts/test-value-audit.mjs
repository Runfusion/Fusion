#!/usr/bin/env node
/*
FNXC:TestInfrastructure 2026-06-25-00:00:
Test Value Audit. Builds a heuristic "value score" for every test file under
  - packages/(asterisk)/src/(asterisk)(asterisk)/__tests__/(asterisk)(asterisk)
  - packages/dashboard/app/(asterisk)(asterisk)/__tests__/(asterisk)(asterisk)
from git history, joins it with per-file durations (scripts/test-timings.json), and ranks
the SLOW + LOW-VALUE files first as deletion candidates. Emits docs/test-value-audit.json
(machine artifact) and docs/test-value-audit.md (human report). This is an EVIDENCE BASE
for a human/follow-up deletion decision — the script never deletes tests.

Requirement context: AGENTS.md "Do Not Add Slow Tests" (FN-5048) + the quarantine deletion
ratchet. We need to know which slow tests are also low-signal so they can be cut without
losing real regression coverage.

HEURISTIC, not ground truth. Caveats live in the generated report's Methodology section.

Usage:
  node scripts/test-value-audit.mjs            # full run, writes artifacts, prints top 15
  node scripts/test-value-audit.mjs --top 30   # change how many rows are printed/written to md
  node scripts/test-value-audit.mjs --json-only # skip markdown
*/

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { classifyCommit, scoreFile, WEIGHTS, NEGATIVE_KEYWORDS } from "./lib/test-value-audit-lib.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const TOP_N = Number(arg("--top", 40)) || 40;
const JSON_ONLY = process.argv.includes("--json-only");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

// --- Target test files -------------------------------------------------------
// Globs (POSIX-style, repo-relative) for the two audited surfaces.
function isTargetTestFile(path) {
  if (!/\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path)) return false;
  if (!path.includes("/__tests__/")) return false;
  if (/^packages\/[^/]+\/src\//.test(path)) return true;
  if (path.startsWith("packages/dashboard/app/")) return true;
  return false;
}

function packageRootOf(path) {
  const m = path.match(/^(packages\/[^/]+)\//);
  return m ? m[1] : null;
}

// A non-test source file in the same package (used for "test + source changed together").
function isSourceFileInPackage(path, pkgRoot) {
  if (!pkgRoot || !path.startsWith(pkgRoot + "/")) return false;
  if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path)) return false;
  if (/\.(test|spec)\./.test(path)) return false;
  if (path.includes("/__tests__/")) return false;
  if (path.includes("/__test-utils__/") || path.includes("/__mocks__/")) return false;
  return true;
}

// --- Timings -----------------------------------------------------------------
function loadTimings() {
  const p = resolve(repoRoot, "scripts/test-timings.json");
  const map = new Map();
  if (!existsSync(p)) return map;
  const data = JSON.parse(readFileSync(p, "utf8"));
  for (const pkg of Object.values(data.packages ?? {})) {
    for (const [file, ms] of Object.entries(pkg.files ?? {})) {
      // Keep the max if a path appears twice across packages.
      map.set(file, Math.max(map.get(file) ?? 0, Number(ms) || 0));
    }
  }
  return map;
}

// --- Quarantine ledger (current + historical) --------------------------------
function loadQuarantinePaths() {
  const set = new Set();
  const ledger = "scripts/lib/test-quarantine.json";
  try {
    const current = JSON.parse(readFileSync(resolve(repoRoot, ledger), "utf8"));
    for (const e of current.entries ?? []) if (e.file) set.add(e.file);
  } catch {
    /* ledger may not exist */
  }
  // Historical entries: scan every past revision of the ledger for "file": "<path>".
  try {
    const blob = git(["log", "-p", "--format=", "--", ledger]);
    for (const m of blob.matchAll(/"file"\s*:\s*"([^"]+)"/g)) set.add(m[1]);
  } catch {
    /* no history */
  }
  return set;
}

// --- Whole-history parse -----------------------------------------------------
// One git invocation yields every commit's subject/body/time + name-status file list.
// Field sep \x1f, body terminator \x02, commit start \x01.
function loadHistory() {
  const SEP = "\x1f";
  const BODY_END = "\x02";
  const COMMIT_START = "\x01";
  const raw = git([
    "log",
    "--no-color",
    "--name-status",
    `--format=${COMMIT_START}%H${SEP}%ct${SEP}%s${SEP}%b${BODY_END}`,
  ]);

  const commits = [];
  // newPath -> oldPath rename map (last writer wins; good enough for linear chains).
  const renameMap = new Map();
  // path -> array of commit indices that touched it (as add/modify/rename target).
  const byPath = new Map();

  const chunks = raw.split(COMMIT_START);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const bodyEnd = chunk.indexOf(BODY_END);
    if (bodyEnd === -1) continue;
    const head = chunk.slice(0, bodyEnd);
    const [sha, ct, subject, ...bodyParts] = head.split(SEP);
    const body = bodyParts.join(SEP);
    const nameStatusBlock = chunk.slice(bodyEnd + 1);

    const files = [];
    for (const line of nameStatusBlock.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const cols = t.split("\t");
      const statusRaw = cols[0];
      if (!statusRaw) continue;
      const status = statusRaw[0]; // A/M/D/R/C/T
      if ((status === "R" || status === "C") && cols.length >= 3) {
        const oldPath = cols[1];
        const newPath = cols[2];
        files.push({ status, path: newPath, oldPath });
        renameMap.set(newPath, oldPath);
      } else if (cols.length >= 2) {
        files.push({ status, path: cols[1] });
      }
    }

    const idx = commits.length;
    commits.push({
      sha,
      time: Number(ct) * 1000,
      subject: subject ?? "",
      body: body ?? "",
      files,
    });
    for (const f of files) {
      if (f.status === "D") continue;
      if (!byPath.has(f.path)) byPath.set(f.path, []);
      byPath.get(f.path).push(idx);
    }
  }

  return { commits, renameMap, byPath };
}

// Follow renames backward to collect every historical path this file lived at.
function historicalPaths(currentPath, renameMap) {
  const paths = new Set([currentPath]);
  let p = currentPath;
  let guard = 0;
  while (renameMap.has(p) && guard < 100) {
    p = renameMap.get(p);
    if (paths.has(p)) break;
    paths.add(p);
    guard += 1;
  }
  return paths;
}

function countTestCases(absPath) {
  try {
    const src = readFileSync(absPath, "utf8");
    let n = 0;
    for (const line of src.split("\n")) {
      if (/^\s*(it|test)\s*(\.\w+)?\s*\(/.test(line)) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

function fmtMs(ms) {
  if (ms == null) return "n/a";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// --- Main --------------------------------------------------------------------
function main() {
  const started = Date.now();
  const timings = loadTimings();
  const quarantinePaths = loadQuarantinePaths();
  const { commits, renameMap, byPath } = loadHistory();

  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const testFiles = tracked.filter(isTargetTestFile).sort();

  const rows = [];
  for (const file of testFiles) {
    const pkgRoot = packageRootOf(file) ?? "packages/dashboard";
    const paths = historicalPaths(file, renameMap);

    // Gather candidate commit indices across all historical paths, dedup.
    const idxSet = new Set();
    for (const p of paths) for (const i of byPath.get(p) ?? []) idxSet.add(i);

    const classified = [];
    const evidence = [];
    for (const i of [...idxSet].sort((a, b) => b - a)) {
      const c = commits[i];
      const fileEntry = c.files.find((f) => paths.has(f.path) && f.status !== "D");
      if (!fileEntry) continue;
      const status = fileEntry.status;
      const touchedSource = c.files.some(
        (f) => f.status !== "D" && isSourceFileInPackage(f.path, pkgRoot),
      );
      const cls = classifyCommit({ subject: c.subject, body: c.body, status, touchedSource });
      classified.push(cls);
      evidence.push({
        sha: c.sha.slice(0, 9),
        time: c.time,
        subject: c.subject,
        status,
        touchedSource,
        category: cls.category,
        weight: cls.weight,
        signals: cls.signals,
      });
    }

    const durationMs = timings.has(file) ? timings.get(file) : null;
    const testCount = countTestCases(resolve(repoRoot, file));
    const quarantined = [...paths].some((p) => quarantinePaths.has(p));

    const score = scoreFile({ commits: classified, durationMs, testCount, quarantined });

    const times = evidence.map((e) => e.time).filter(Boolean);
    const firstSeen = times.length ? Math.min(...times) : null;
    const lastSeen = times.length ? Math.max(...times) : null;
    const ageDays = firstSeen ? Math.round((Date.now() - firstSeen) / 86_400_000) : null;

    rows.push({
      file,
      package: pkgRoot,
      ...score,
      ageDays,
      lastTouched: lastSeen ? new Date(lastSeen).toISOString().slice(0, 10) : null,
      evidence: evidence.slice(0, 6), // most-recent commits as the "why"
    });
  }

  // Rank: slow + low-value first.
  rows.sort((a, b) => b.deletionPriority - a.deletionPriority || a.valueScore - b.valueScore);

  const summary = {
    total: rows.length,
    deleteCandidates: rows.filter((r) => r.recommendation === "delete").length,
    reviewCandidates: rows.filter((r) => r.recommendation === "review").length,
    keep: rows.filter((r) => r.recommendation === "keep").length,
    safeDeletes: rows.filter((r) => r.safeDelete).length,
    withTiming: rows.filter((r) => r.durationMs != null).length,
    quarantined: rows.filter((r) => r.quarantined).length,
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    heuristic: true,
    note: "HEURISTIC, not ground truth. Do not auto-delete from this file. See docs/test-value-audit.md methodology + caveats.",
    weights: WEIGHTS,
    negativeKeywords: NEGATIVE_KEYWORDS,
    timingsCapturedFrom: "scripts/test-timings.json",
    summary,
    rows,
  };

  const jsonPath = resolve(repoRoot, "docs/test-value-audit.json");
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n");

  if (!JSON_ONLY) writeMarkdown(rows, summary);

  // Console: top 15 rows.
  const top = rows.slice(0, 15);
  const tbl = top.map((r, i) => ({
    "#": i + 1,
    file: r.file.replace(/^packages\//, "").length > 58 ? "…" + r.file.slice(-57) : r.file.replace(/^packages\//, ""),
    tests: r.testCount,
    dur: fmtMs(r.durationMs),
    score: r.valueScore,
    rec: r.recommendation,
  }));
  console.log(`\nTest Value Audit — ${rows.length} files analyzed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(
    `delete=${summary.deleteCandidates} review=${summary.reviewCandidates} keep=${summary.keep} ` +
      `safeDelete=${summary.safeDeletes} withTiming=${summary.withTiming}\n`,
  );
  console.log("Top 15 deletion candidates (slow + low value first):");
  console.table(tbl);
  console.log(`\nArtifacts:\n  ${relative(repoRoot, jsonPath)}`);
  if (!JSON_ONLY) console.log(`  docs/test-value-audit.md`);
}

function recEmoji(rec) {
  return rec === "delete" ? "delete" : rec === "review" ? "review" : "keep";
}

function writeMarkdown(rows, summary) {
  const top = rows.slice(0, TOP_N);
  const L = [];
  L.push("# Test Value Audit");
  L.push("");
  L.push(`> Generated by \`scripts/test-value-audit.mjs\` on ${new Date().toISOString()}.`);
  L.push(">");
  L.push("> **This is a HEURISTIC, not ground truth.** It is an evidence base for a human");
  L.push("> deletion decision. The script does **not** delete any tests. See Methodology + Caveats.");
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`- Files analyzed: **${summary.total}**`);
  L.push(`- With timing data: **${summary.withTiming}**`);
  L.push(`- \`delete\` candidates (valueScore ≤ 0 or quarantined): **${summary.deleteCandidates}**`);
  L.push(`- \`review\` candidates (0 < valueScore ≤ 3): **${summary.reviewCandidates}**`);
  L.push(`- \`keep\` (valueScore > 3): **${summary.keep}**`);
  L.push(`- "Safe delete" under the deletion-ratchet (zero positive evidence + churn/quarantine): **${summary.safeDeletes}**`);
  L.push(`- In quarantine ledger (current or historical): **${summary.quarantined}**`);
  L.push("");
  L.push("## Methodology");
  L.push("");
  L.push("For every audited test file we run a single whole-history `git log --name-status`");
  L.push("pass and classify each commit that touched the file (renames followed backward):");
  L.push("");
  L.push("**Positive signal** (encoded/caught a real bug):");
  L.push("- `fix(...)`/`fix:` subject **with** a sibling source change in the same package (+3)");
  L.push("- `fix(...)`/`fix:` subject alone (+2)");
  L.push("- `## Symptom Verification` regression marker in the commit body (+3, FN-5893)");
  L.push("- test file first **added** together with source (+2), or added alone (+1)");
  L.push("- a plain test+source co-change modify (+1.5)");
  L.push("");
  L.push("**Negative signal** (low value / churn):");
  L.push("- subject/body mentions " + NEGATIVE_KEYWORDS.map((k) => `\`${k}\``).join(", ") + " (−3)");
  L.push("- a modify that touched **only** the test file, no source (−1)");
  L.push("- appears in `scripts/lib/test-quarantine.json` history (−5)");
  L.push("");
  L.push("The per-file **valueScore** is the sum of commit weights (plus the quarantine penalty).");
  L.push("**deletionPriority** = `durationMs / (1 + max(0, valueScore))` with a small boost for");
  L.push("net-negative files — so the ranking surfaces **slow AND low-value** files first");
  L.push("(most CI time saved per unit of lost signal). Recommendation: `delete` (≤0), `review`");
  L.push("(≤3), else `keep`.");
  L.push("");
  L.push("## Caveats (read before deleting anything)");
  L.push("");
  L.push("- **Heuristic, not truth.** A quiet, never-modified test can still be load-bearing;");
  L.push("  a high-churn test can still be valuable. Use this to *prioritize human review*.");
  L.push("- **`git log --follow` / rename limits.** Renames are followed only through linear");
  L.push("  `R`/`C` name-status chains; squash-merges collapse multi-commit history into one");
  L.push("  subject, so per-commit signal is lost for squashed work (this repo defaults to");
  L.push("  squash merges — a major reason to treat scores as lower bounds on value).");
  L.push("- **Subjects lie.** `fix(...)` is trusted as a positive even if the test was unrelated;");
  L.push("  conversely a real bug fixed under a `feat(...)`/`FN-` subject without source co-change");
  L.push("  may be undercounted.");
  L.push("- **Timing is a snapshot** from `scripts/test-timings.json`; files with no entry show");
  L.push("  `n/a` duration and get deletionPriority 0 (cost unknown, not necessarily cheap).");
  L.push("- **Not a green light.** Deleting a gate test still requires the gate-eviction process");
  L.push("  (AGENTS.md). \"Safe delete\" only flags files that meet the ratchet's churn/quarantine bar.");
  L.push("");
  L.push(`## Top ${top.length} deletion candidates`);
  L.push("");
  L.push("| # | File | Tests | Duration | Value | Priority | Rec | Why (recent commits) |");
  L.push("|---|------|------:|---------:|------:|---------:|-----|----------------------|");
  top.forEach((r, i) => {
    const why = r.evidence
      .slice(0, 3)
      .map((e) => {
        const subj = (e.subject || "").replace(/\|/g, "\\|").slice(0, 48);
        return `\`${e.sha}\` ${subj} _(${e.signals.join(",") || "neutral"})_`;
      })
      .join("<br>");
    const flags = [];
    if (r.quarantined) flags.push("quarantined");
    if (r.safeDelete) flags.push("safe-delete");
    const rec = recEmoji(r.recommendation) + (flags.length ? ` (${flags.join(", ")})` : "");
    L.push(
      `| ${i + 1} | \`${r.file}\` | ${r.testCount} | ${fmtMs(r.durationMs)} | ${r.valueScore} | ${r.deletionPriority} | ${rec} | ${why || "_no git evidence_"} |`,
    );
  });
  L.push("");
  L.push("### One-line recommendations");
  L.push("");
  top.forEach((r, i) => {
    let rationale;
    if (r.recommendation === "delete") {
      rationale = r.quarantined
        ? "in quarantine ledger — delete per ratchet once expiry passes"
        : r.positiveCount === 0
          ? "no positive (bug-encoding) signal in history; pure churn — strong delete candidate"
          : "net-negative value (churn outweighs signal) — delete candidate";
    } else if (r.recommendation === "review") {
      rationale = "thin positive signal; confirm it asserts a real invariant before trimming";
    } else {
      rationale = "carries real bug-fix / source-coupled signal — keep";
    }
    if (r.durationMs != null && r.durationMs >= 1000 && r.recommendation !== "keep") {
      rationale += ` (slow: ${fmtMs(r.durationMs)} — high CI time payoff)`;
    }
    L.push(`${i + 1}. \`${r.file}\` — **${r.recommendation}**: ${rationale}`);
  });
  L.push("");

  writeFileSync(resolve(repoRoot, "docs/test-value-audit.md"), L.join("\n") + "\n");
}

main();
