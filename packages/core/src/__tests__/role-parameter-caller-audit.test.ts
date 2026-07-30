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
/*
FNXC:RoleParameterAudit 2026-07-31-09:40 (PR #2588 review — greptile):
REGISTRATIONS ARE KEYED BY COUNT, not just by file+fn. Matching on file and function
alone let every LATER omission of that function in the same file inherit an existing
reason — so a second, unreviewed call site could be added to a registered file and
the audit would stay green.

Keyed by line number would be the obvious fix and the wrong one: it churns on every
edit above the call and would make this file a merge-conflict magnet. `sites` records
how many omitting call sites the reason was written for, so ADDING one fails while
moving one does not.
*/
const REGISTERED_OMISSIONS: ReadonlyArray<{ file: string; fn: string; sites: number; why: string }> = [
  {
    file: "packages/core/src/task-priority.ts",
    fn: "computeBlockerFanoutMap",
    sites: 1,
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
    sites: 1,
    why:
      "Same structural limit as task-priority.ts. Consequence is worth stating: " +
      "`emitHighOverlapFanoutWarnings` gates on `overlapBlockedTodoCount >= THRESHOLD`, and " +
      "with the hold column defaulted the count is 0 on a renamed board — so the warning " +
      "never fires. A guard that never fires does not fail a test.",
  },
  /*
  The three below were INVISIBLE to this audit until its pathspec was widened in this
  PR — they sit in the dashboard app tree, one directory outside the old glob. They
  are registered rather than fixed because the fix is the same structural one
  task-priority.ts is waiting on, and stating that is more useful than three copies
  of the same paragraph.
  */
  {
    file: "packages/dashboard/app/hooks/useBlockerFanout.ts",
    fn: "computeBlockerFanoutMap",
    sites: 1,
    why:
      "The dashboard wrapper takes only `tasks`, so it has no column vocabulary to pass. " +
      "Fixing it properly means threading the per-task `classify` option (the core API " +
      "already accepts it and it is the only correct choice on a multi-workflow board) from " +
      "the callers that DO hold column flags. Consequence while it waits: on a renamed " +
      "board `isTodo` is false for every card, so blocker fan-out counts read 0 and the " +
      "high-fanout affordances never appear.",
  },
  {
    file: "packages/dashboard/app/components/ExecutorStatusBar.tsx",
    fn: "computeBlockerFanoutMap",
    sites: 1,
    why:
      "Calls the dashboard wrapper above, so it inherits that wrapper's limitation rather " +
      "than having one of its own. Registered separately so widening the wrapper does not " +
      "silently absolve this site — it has to be re-checked when the wrapper gains the option.",
  },
  {
    file: "packages/dashboard/app/components/TaskDetailModal.tsx",
    fn: "computeBlockerFanoutMap",
    sites: 1,
    why:
      "Same inheritance as ExecutorStatusBar. Worth noting this surface has column flags " +
      "available nearby (`currentColumnFlags`), so it is the most likely FIRST site to be " +
      "fixed once the wrapper accepts `classify`.",
  },
];

function productionSources(): string[] {
  /*
  FNXC:RoleParameterAudit 2026-07-31-09:15 (PR #2588 review — greptile):
  THE PATHSPEC OMITTED THE DASHBOARD, which is where the audit's own motivating
  defect lives. A "packages, any package, src" glob misses the dashboard's `app`
  tree, and a .ts-only glob misses every .tsx component — so an audit written
  because "the stale-paused badges stayed silent on renamed boards" could not see
  the badge code.

  Verified concretely, not assumed: `dashboard/app/hooks/useBlockerFanout.ts` calls
  `computeBlockerFanoutMap` passing only `staleHighFanoutAgeThresholdMs`, so
  `holdColumn` takes its "todo" default and the fanout misclassifies every renamed
  board. The audit reported zero unregistered omissions while that call sat one
  directory outside its glob.

  Same blind spot, same two directions, as the census pathspec fixed in #2557.

  (Glob strings kept out of this note on purpose: one of them contains the
  block-comment terminator and truncates the comment silently. That has now bitten
  three files in this program.)
  */
  return execFileSync("git", [
    "ls-files",
    "packages/*/src/**/*.ts", "packages/*/src/*.ts",
    "packages/*/src/**/*.tsx", "packages/*/src/*.tsx",
    "packages/*/app/**/*.ts", "packages/*/app/*.ts",
    "packages/*/app/**/*.tsx", "packages/*/app/*.tsx",
  ], {
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
      const matching = omitting.filter((s) => s.file === reg.file && s.fn === reg.fn);
      expect(
        matching.length > 0,
        `REGISTERED_OMISSIONS entry is stale — ${reg.fn} in ${reg.file} now passes the role, so delete the entry`,
      ).toBe(true);
      /*
      FNXC:RoleParameterAudit 2026-07-31-09:45 (PR #2588 review — greptile):
      The COUNT is checked, not just the existence. Without this a registered file
      absorbs every later omission of the same function: someone adds a second
      unreviewed call site, it matches an existing file+fn entry, and the audit stays
      green on a site nobody looked at. Adding one now fails; moving one does not,
      which is why this counts rather than pinning line numbers.
      */
      expect(
        matching.length,
        `REGISTERED_OMISSIONS entry for ${reg.fn} in ${reg.file} covers ${reg.sites} call site(s), `
        + `but ${matching.length} now omit the role — a NEW omission cannot inherit an existing `
        + `reason. Review the new site, then update \`sites\` if the reason genuinely covers it.`,
      ).toBe(reg.sites);
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
