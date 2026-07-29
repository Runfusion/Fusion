/*
FNXC:WorkflowLifecycleColumns 2026-07-29-16:30 (caller-omission ratchet):

A DEFECT CLASS THE COLUMN-LITERAL CENSUS CANNOT SEE.

The conversion pattern is: give a guard an optional lifecycle-role parameter that
defaults to the legacy id, then thread the resolved role in at every caller. The guard
becomes correct. The bug moves to the CALL SITE — and the offending call site contains
no literal at all. It is defined by what it OMITS, so a census of legacy literals looks
straight past it.

This has now happened twice, both times AFTER the pattern was known:

  #2470 review   getStalePausedTodoSignal gained `holdColumn`; both hydration sites
                 omitted it. Badge silent on a renamed board. Fixed.
  this program   getStalePausedReviewSignal / getInReviewStalledSignal take
                 `reviewColumn`; SIX sites in the SAME FILE omitted it, after the
                 sibling role had been fixed next door.

Twice is a pattern, so this makes it mechanical: every production caller of a
role-parameterised guard must pass the role, or be registered below with a reason.

WHY THE ALLOWLIST IS NOT AN ESCAPE HATCH. Registering a site requires stating WHY in
this file, which is a code-review-visible act. An empty-by-default rule with no way to
record a deliberate exception gets deleted the first time someone hits a legitimate
one; a rule that demands a written reason survives.
*/
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");

/** Guards that take an optional lifecycle role defaulting to a legacy column id. */
const ROLE_PARAMETERISED: ReadonlyArray<{ fn: string; param: string }> = [
  { fn: "getStalePausedTodoSignal", param: "holdColumn" },
  { fn: "getStalePausedReviewSignal", param: "reviewColumn" },
  { fn: "getInReviewStalledSignal", param: "reviewColumn" },
  { fn: "computeBlockerFanoutMap", param: "holdColumn" },
];

/**
 * Call sites that deliberately do not pass the role. Each needs a reason, and the
 * reason is the point of the entry.
 */
const REGISTERED_OMISSIONS: ReadonlyArray<{ file: string; fn: string; why: string }> = [
  {
    file: "packages/core/src/task-priority.ts",
    fn: "computeBlockerFanoutMap",
    why:
      "STRUCTURAL, not an oversight: `holdColumn` is a SINGLE board-wide value, but the " +
      "fanout map is computed across ALL tasks, which on a multi-workflow board span " +
      "different hold columns. One value cannot be right for that board, so threading any " +
      "single resolved column here would trade a wrong-for-renamed-boards default for a " +
      "wrong-for-mixed-boards value. The option needs to become per-task before this call " +
      "site can be correct. Note this caller DOES thread `terminalColumns`, so the omission " +
      "is one option of two — the same shape as the reads.ts defect.",
  },
  {
    file: "packages/engine/src/scheduler.ts",
    fn: "computeBlockerFanoutMap",
    why:
      "Same structural limit as task-priority.ts. Consequence is worth stating: " +
      "`emitHighOverlapFanoutWarnings` gates on `overlapBlockedTodoCount >= THRESHOLD`, and " +
      "with the hold column defaulted the count is 0 on a renamed board — so the warning " +
      "never fires. A guard that never fires does not fail a test.",
  },
];

function productionSources(): string[] {
  return execFileSync("git", ["ls-files", "packages/*/src/**/*.ts", "packages/*/src/*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(f));
}

interface CallSite {
  file: string;
  line: number;
  fn: string;
  param: string;
  passes: boolean;
}

function auditCallers(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of productionSources()) {
    let lines: string[];
    try {
      lines = readFileSync(resolve(REPO_ROOT, file), "utf8").split("\n");
    } catch {
      // FAIL CLOSED: a source we cannot read is a source we did not audit.
      sites.push({ file, line: 0, fn: "UNREADABLE", param: "-", passes: false });
      continue;
    }
    for (const { fn, param } of ROLE_PARAMETERISED) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.includes(`${fn}(`)) continue;
        if (new RegExp(`export (?:async )?function ${fn}\\b`).test(line)) continue; // the definition
        // The options object may span lines; look at the call's window.
        const window = lines.slice(i, i + 12).join("\n");
        sites.push({ file, line: i + 1, fn, param, passes: window.includes(param) });
      }
    }
  }
  return sites;
}

describe("role-parameter caller audit", () => {
  it("every caller of a role-parameterised guard passes the role, or is registered with a reason", () => {
    const omitting = auditCallers().filter((s) => !s.passes);
    const unregistered = omitting.filter(
      (s) => !REGISTERED_OMISSIONS.some((r) => r.file === s.file && r.fn === s.fn),
    );

    expect(
      unregistered.map((s) => `${s.file}:${s.line} ${s.fn} omits ${s.param}`),
      "A caller takes the LEGACY DEFAULT for a lifecycle role.\n\n" +
        "The guard itself is correct — the bug is here, at the call site, and it is invisible to\n" +
        "a legacy-literal census because this line contains no literal at all. That is exactly how\n" +
        "the stale-paused badges stayed silent on renamed boards through two separate fixes.\n\n" +
        "Pass the resolved role, or add an entry to REGISTERED_OMISSIONS explaining why the\n" +
        "legacy default is correct here.\n",
    ).toEqual([]);
  });

  it("every registered omission still exists — the list cannot rot", () => {
    /* An allowlist that outlives its entries silently grants exceptions to code that no
       longer needs them, and is the usual way a ratchet decays into decoration. */
    const omitting = auditCallers().filter((s) => !s.passes);
    for (const reg of REGISTERED_OMISSIONS) {
      expect(
        omitting.some((s) => s.file === reg.file && s.fn === reg.fn),
        `REGISTERED_OMISSIONS entry is stale — ${reg.fn} in ${reg.file} now passes the role, so delete the entry`,
      ).toBe(true);
    }
  });

  it("audits at least the known role-parameterised guards, so an empty scan cannot pass", () => {
    /* If the scan silently found nothing — a bad glob, a renamed export — the first case
       would pass vacuously. Anchor it on a call site that must always exist. */
    const sites = auditCallers();
    expect(sites.length).toBeGreaterThan(5);
    expect(sites.some((s) => s.fn === "getStalePausedTodoSignal" && s.passes)).toBe(true);
  });
});
