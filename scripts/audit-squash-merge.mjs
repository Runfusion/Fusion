#!/usr/bin/env node
// Audit a squash merge for silently overwritten work.
//
// Usage:
//   node scripts/audit-squash-merge.mjs <squash-sha> [--lookback=30]
//
// What it checks:
//   1. Duplicate-cherry-pick risk — commits on the branch whose subject lines
//      match commits already on main between the branch base and the squash
//      parent. When auto-resolve runs against duplicates, it tends to pick
//      one side line-by-line and silently drop refinements from the other.
//   2. Touched-file overlap — for each file the squash modifies, lists
//      recent main commits that touched the same file. These deserve a
//      human eyeball: did the squash preserve their net contribution?
//
// This is a heuristic, not a proof. Output is a punch list — the calling
// agent is expected to review each flagged item itself (diff the matching
// main commit against HEAD, confirm its net contribution survived) and
// restore anything silently dropped. No human handoff required; the audit
// is only "clean" once the agent has reviewed every item or reapplied any
// losses as a follow-up commit on the same branch.
//
// Example:
//   node scripts/audit-squash-merge.mjs 7c1a1c36c

import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const squashSha = args.find((a) => !a.startsWith("--"));
const lookback = Number(
  (args.find((a) => a.startsWith("--lookback=")) || "--lookback=30").split("=")[1],
);

if (!squashSha) {
  console.error("Usage: audit-squash-merge.mjs <squash-sha> [--lookback=N]");
  process.exit(2);
}

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

const parent = sh(`git rev-parse ${squashSha}^`);
const subject = sh(`git log -1 --format=%s ${squashSha}`);
const branchSubjects = sh(`git log -1 --format=%b ${squashSha}`)
  .split("\n")
  .map((l) => l.replace(/^- /, "").trim())
  .filter(Boolean);

console.log(`Auditing squash: ${squashSha} — ${subject}`);
console.log(`Parent (main before squash): ${parent}`);
console.log(`Lookback window on main: ${lookback} commits\n`);

// --- 1. Duplicate-cherry-pick detection ---
const recentMainSubjects = sh(
  `git log --format=%s ${parent}~${lookback}..${parent}`,
).split("\n");

const dupes = branchSubjects.filter((s) => recentMainSubjects.includes(s));

console.log("=== Duplicate-cherry-pick risk ===");
if (dupes.length === 0) {
  console.log("(none — no branch commit subjects match recent main commits)\n");
} else {
  console.log("WARN: branch contains commits whose subjects match recent main commits.");
  console.log("Auto-resolve may have picked the older side, dropping refinements.");
  console.log("Action: diff each main commit below against HEAD and confirm its");
  console.log("net contribution survived. Restore anything dropped as a follow-up.\n");
  for (const s of dupes) {
    console.log(`  - ${s}`);
  }
  console.log();
}

// --- 2. Touched-file overlap ---
const touched = sh(`git diff --name-only ${parent} ${squashSha}`)
  .split("\n")
  .filter(Boolean);

console.log(`=== Touched-file overlap (${touched.length} files in squash) ===`);
const overlaps = [];
for (const file of touched) {
  const recent = sh(
    `git log --format=%h~%s ${parent}~${lookback}..${parent} -- ${JSON.stringify(file)}`,
  )
    .split("\n")
    .filter(Boolean);
  if (recent.length > 0) {
    overlaps.push({ file, recent });
  }
}

if (overlaps.length === 0) {
  console.log("(none — squash touches files no recent main commit touched)\n");
} else {
  console.log("Files the squash touched that also have recent main activity.");
  console.log("Action: for each commit below, verify its changes still appear");
  console.log("in HEAD. Reapply any silently dropped changes on the same branch.\n");
  for (const { file, recent } of overlaps) {
    console.log(`  ${file}`);
    for (const entry of recent) {
      const [sha, ...subj] = entry.split("~");
      console.log(`    - ${sha}  ${subj.join("~")}`);
    }
  }
  console.log();
}

const issues = dupes.length + overlaps.length;
console.log(`Audit complete. ${issues} item(s) for the calling agent to review.`);
process.exit(issues === 0 ? 0 : 1);
