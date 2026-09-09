/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the missed-pair ratchet):
A sweep whose READ was converted to resolved lanes but whose LOOP-BODY guards still compare column ids
is worse than one converted nowhere. The widened read admits renamed-board cards, and every literal
guard below it then mis-classifies exactly those cards.

This is not hypothetical and it is not rare. #2916 found a second lane guard on a re-read row that the
behavioural test caught; a scan of the other converted sweeps then found FIVE more in
`reclaimSelfOwnedBranchConflicts`, and one of them decides whether a backward move needs its
triple-proof — so left literal it would have moved a renamed review card back with the safety gate
silently skipped, a regression INTRODUCED by the conversion.

WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. Those five sit behind `inspectBranchConflict` and a real
`execAsync`, so reaching them means a git fixture rather than a lane test. This asserts the property the
scan found — no literal lane comparison survives inside a converted sweep — which is exactly the defect
class, and nothing more. It makes no claim about behaviour, and the behavioural cases for each sweep
live in `self-healing-query-filter-blindness.test.ts`.

REVERT CHECK, measured: restoring any one of the five (e.g. `if (task.column === "in-review") {` inside
`reclaimSelfOwnedBranchConflicts`) fails this test naming that sweep and that literal.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../self-healing.ts", import.meta.url));

/*
The list is DERIVED, not written down: a sweep counts as converted when its own body calls
`resolveProjectColumnsForRoles`. Written down, this test would be wrong on every branch that converts a
different sweep, and stale the moment one lands — the maintenance burden is what turns a ratchet off.
*/
const LIFECYCLE_IDS = ["todo", "in-progress", "in-review", "done", "triage"];

/**
 * Strips comments before scanning.
 *
 * Load-bearing: these files carry long FNXC notes that QUOTE the old form to explain why it was
 * removed, and an earlier version of this scan reported those as live code. A ratchet that fires on
 * its own documentation gets disabled, not fixed.
 */
function stripComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      out.push("");
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      out.push("");
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) { out.push(""); continue; }
    out.push(line);
  }
  return out;
}

/** The method each line belongs to, by nearest preceding 2-space-indented declaration. */
function owningMethod(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const match = /^ {2}(?:private |public )?(?:async )?([a-zA-Z][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]!);
    if (match) return match[1]!;
  }
  return null;
}

/*
A literal on the FALLBACK arm of a resolved ternary is the correct shape, not a missed pair:

  own.length > 0 ? own.includes(task.column) : task.column === "in-review"

The resolved answer wins whenever it exists; the literal answers only when resolution yielded nothing,
and deleting it would make an unresolvable workflow match no lane at all. Three such lines
(`reconcileDoneTaskIntegrity`, `recoverInterruptedMergingTasks`, `recoverStuckMergeDeadlocks`) are why
this exclusion exists — the first version of this ratchet reported all three as defects.

Deliberately narrow: it only excuses a literal that shares its line with a RESOLVED membership test. A
bare `task.column === "in-review"` on its own line is still an offender, which is the case that matters.
*/
function isResolvedFallbackArm(line: string): boolean {
  return /(?:\.includes|\.has)\(\s*(?:task|t|entry|dep)\.column\s*\)/.test(line);
}

/** Every method whose body resolves project lanes — i.e. whose READ has been converted. */
function convertedSweeps(lines: string[]): string[] {
  const found = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.includes("resolveProjectColumnsForRoles(")) return;
    const owner = owningMethod(lines, index);
    if (owner) found.add(owner);
  });
  return [...found].sort();
}

/*
Documented exceptions, each with the reason recorded at the site too. An entry here is a claim that the
degraded answer is harmless — not that the literal is invisible.
*/
const ALLOWED: ReadonlyArray<{ sweep: string; because: string }> = [
  {
    sweep: "clearStaleBlockedBy",
    because: "one literal in a log-dedup closure defined before the lane prefetch; the degraded answer costs a duplicate log line, not a lifecycle decision",
  },
];

describe("a converted sweep keeps no literal lane comparison in its body", () => {
  const lines = stripComments(readFileSync(SOURCE, "utf8"));
  const pattern = new RegExp(`\\.column\\s*(?:!==|===)\\s*"(${LIFECYCLE_IDS.join("|")})"`);

  for (const sweep of convertedSweeps(lines)) {
    it(`${sweep} compares no column id`, () => {
      const allowance = ALLOWED.find((entry) => entry.sweep === sweep);
      const offenders: string[] = [];
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        if (isResolvedFallbackArm(line)) return;
        if (owningMethod(lines, index) !== sweep) return;
        offenders.push(`${SOURCE.split("/").pop()}:${index + 1} — ${line.trim()}`);
      });
      /* An allowed sweep keeps AT MOST its documented one; a second is still a failure. */
      if (allowance) {
        expect(offenders.length, `${sweep} is allowed one documented literal (${allowance.because}) but has ${offenders.length}:\n${offenders.join("\n")}`).toBeLessThanOrEqual(1);
        return;
      }

      expect(offenders, `${sweep} still compares a lifecycle column id:\n${offenders.join("\n")}`).toEqual([]);
    });
  }

  it("the scan can actually see a literal, and finds converted sweeps at all", () => {
    /*
    Two positive controls, because both halves can fail silently. A broken regex makes every case above
    pass by finding no offenders; a broken `convertedSweeps` makes them pass by iterating nothing at all
    — and an empty `for` loop registers no tests, which reads as green.
    */
    const anyLiteralAnywhere = lines.some((line) => pattern.test(line));
    expect(anyLiteralAnywhere, "the literal scan matched nothing — the regex is broken").toBe(true);

    expect(convertedSweeps(lines).length, "no converted sweep found — the derivation is broken").toBeGreaterThan(0);
  });
});
