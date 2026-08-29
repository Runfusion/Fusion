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

import { tsImport } from "tsx/esm/api";

const args = process.argv.slice(2);
const squashSha = args.find((a) => !a.startsWith("--"));
const lookback = Number(
  (args.find((a) => a.startsWith("--lookback=")) || "--lookback=30").split("=")[1],
);

if (!squashSha) {
  console.error("Usage: audit-squash-merge.mjs <squash-sha> [--lookback=N]");
  process.exit(2);
}

const moduleUrl = new globalThis.URL("../packages/engine/src/merger-squash-audit.ts", import.meta.url).href;
const { auditSquashMerge, formatSquashAuditReport } = await tsImport(moduleUrl, import.meta.url);

try {
  const findings = await auditSquashMerge({
    rootDir: process.cwd(),
    squashSha,
    lookback,
  });
  console.log(formatSquashAuditReport(findings));
  process.exit(findings.clean ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
