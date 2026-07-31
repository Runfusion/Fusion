/*
FNXC:WorkflowLifecycleColumns 2026-07-29-12:20 (census ratchet — the UNCONVERTED surface):

THE NUMBER NOBODY WAS COUNTING.

This program has two censuses already: one for callers of the lifecycle-role resolvers
(the unproven-sites ledger in workflow-lifecycle-live-e2e) and one for reads of the
`workflowColumns` flag (raw-workflow-columns-flag-census). Both count CONVERTED things.
Neither counts what is still keyed to a legacy column id — which is where every defect
this program has found actually lived:

  the pool-id sentinel        `?? "builtin:coding"` vs the counter's sentinel
  the agent-link leak         a terminal column matched against a fixed id set
  the stale-paused badge      `task.column !== "todo"`
  the merge chokepoint throw  the `done`/`archived` pair
  the rebound strand          `?? "todo"`

Each was found by hand, one at a time, by someone who happened to look. This test makes
the size of the remaining surface a fact the suite maintains.

WHAT IT COUNTS, in two shapes:

  COMPARISON  `x.column === "<legacy id>"` / `!==`   — deciding BY name
  FALLBACK    `?? "<legacy id>"`                     — DEFAULTING to a name

Both are lifecycle decisions keyed to a name. It deliberately does NOT count string
literals in general — a column id in a fixture, a log line, or a migration is not a
decision.

THE SECOND SHAPE WAS MISSING FROM THE FIRST CUT OF THIS TEST, and the way that was
found is worth keeping: the census header lists five motivating defects, so the census
was run against its own five examples. It counted two of them. The pool-id sentinel,
the rebound strand and the terminal fallback are all `??` defaults and were invisible
to a comparison-only regex — a census that could not see three of the five bugs it
cites as its reason to exist.

RESIDUAL IMPRECISION, stated rather than tuned away: a couple of counted lines are
display defaults (a column rendered in CLI output). They are left in. The census claims
each site NEEDS A HUMAN JUDGMENT, and a display default passes that judgment in seconds;
chasing them would cost more than the precision buys and would make the pattern too
clever to trust. Agent-id fallbacks are excluded because they are a QUARTER of the
shape, not because false positives are intolerable in principle.

`?? "builtin:coding"` — the pool-id sentinel — is deliberately still NOT counted here.
It defaults a WORKFLOW id, not a column, and it is legitimately correct at most of its
sites (an IR-resolution key needs a resolvable workflow id). It has its own, stronger
guard: scripts/check-capacity-pool-id.mjs, an AST check that bans it only where the
value reaches a capacity counter.

WHAT A HIT IS NOT: a bug. Many are correct — deliberate legacy fallbacks (see
live-agent-count's documented `??` defaults), the legacy-adoption path, or code that is
genuinely about the built-in workflow. The census claims only that each site is a place
where a decision is made by NAME rather than by ROLE, and therefore needs a human
judgment before the vocabulary work can be called finished. Reporting it as a bug count
would be the same overclaiming this program keeps correcting.

WHY A CEILING AND NOT AN EQUALITY — a deliberate departure from the sibling flag census,
which fails in both directions. That one guards a number that only two units can change.
This one guards a number that a dozen concurrent conversion slices move every day, and
an exact-equality assertion would go red on work that is going the RIGHT way. A test
that is red for good reasons gets suppressed, and a suppressed ratchet is worse than
none — the failure mode AGENTS.md's quarantine rule exists to prevent. So: the count may
FALL freely, and may never RISE. When it falls materially, lower the pin in the same PR
that lowered the count; the failure message says so.
*/
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Repo root, derived from this file rather than cwd (vitest chdirs per worker). */
const REPO_ROOT = resolve(__dirname, "../../../..");

/*
FNXC:LegacyColumnCensus 2026-07-30-01:00 (PR #2557 review — third finding, mine):
THE RECEIVER PATTERN WAS THE SECOND BLIND SPOT, and it is the one that stops this
being a ratchet at all.

`\.column === "..."` only sees receivers that END in `.column`. A guard written
against a bare identifier — `taskColumn`, `col`, `toColumn`, `fromColumn`,
`originColumn`, `resumeColumn`, `from`, `c` — was invisible. Verified by probe: a new
`.column === "in-review"` in a dashboard component trips the ceiling, while
`taskColumn === "in-review"` on the very next line does not. A ratchet that a new
violation can walk past by choosing a variable name is not enforcing anything.

This is the same defect that produced three different hand counts of the role
sites (6, 8, then 12) — everyone was matching on the receiver's SPELLING.

So: match ANY receiver, then SUBTRACT the ones that are provably not columns. That
inversion is what makes the number stable, because the exclusion set is small,
enumerable and reviewable, whereas the inclusion set is unbounded.
*/
const LEGACY_COLUMN_COMPARISON =
  /[A-Za-z_$][\w$.?[\]]*\s*(?:===|!==)\s*"(?:todo|triage|in-progress|in-review|done|archived)"/;

/*
FNXC:LegacyColumnCensus 2026-07-30-01:00:
NOT COLUMNS. `"triage"` also names an agent role, a session purpose, an agent-log
lane and an agent surface; `"done"` and friends likewise appear as statuses. Counting
these would be worse than missing them: a ratchet that demands converting
`role === "triage"` to a column trait pushes the next person into a real bug, and can
never reach zero because those lines are correct as written.

Two independent classifiers agreed on exactly this receiver set, which is the
strongest evidence available that it is complete as of today.

FNXC:LegacyColumnCensus 2026-07-30-03:05 (PR #2557 review — greptile, and a real
defect in my own widening): the status exclusion was `\bstatus\b`, which catches
`s.status` (the dot is a word boundary) but NOT a camelCase local. Measured:
`tStatus`, `rStatus`, `sStatus` and `kStatus` account for SEVEN comparisons that were
being counted as column guards. Inverting the match made the exclusion set
load-bearing, so a gap in it now inflates rather than merely annoys — the receiver
suffix is matched instead of the bare word.
*/
const NON_COLUMN_RECEIVER =
  /(?:\brole\b|\bagent\b|agentType|agentId|assignedAgentId|\bsurface\b|sessionPurpose|\bpurpose\b|\blane\b|capability|[A-Za-z_$][\w$.?]*[Ss]tatus|\bstatus\b)\s*(?:===|!==)/;

/** DEFAULTING to a legacy column name when a role does not resolve. */
const LEGACY_COLUMN_FALLBACK = /\?\?\s*"(?:todo|triage|in-progress|in-review|done|archived)"/;

/*
FNXC:WorkflowLifecycleColumns 2026-07-29-14:40:
`"triage"` is BOTH a column id and the synthetic agent id used for triage-authored
audit rows, so `agentId: task.assignedAgentId ?? "triage"` matches the fallback shape
while having nothing to do with columns. Eight such lines exist, all in triage.ts —
roughly a quarter of the fallback count, which is enough to make the number wrong
rather than merely imprecise. A census with known false positives is one people learn
to discount, which is the same end state as not having it.
*/
const AGENT_ID_FALLBACK = /(?:agentId\s*[:=]|assignedAgentId|agent\?\.id)[^"]*\?\?\s*"triage"/;

const LEGACY_COLUMN_DECISION = new RegExp(
  `(?:${LEGACY_COLUMN_COMPARISON.source})|(?:${LEGACY_COLUMN_FALLBACK.source})`,
);

/*
The pinned ceiling. LOWER THIS when a conversion slice reduces the count — in the
same PR.

RAISED 438 -> 755 on 2026-07-31, in two steps, and NEITHER is a regression. Nothing
was converted or reverted; only the measurement changed.

  438 -> 549  the pathspec fix: .tsx files and the dashboard app tree were never
              scanned, hiding 111 lines.
  549 -> 755  the receiver fix: only `.column`-suffixed receivers were matched, so
              206 more lines written against a bare identifier were invisible.
  755 -> 745  LOWERED, and this one is a false-positive removal, not a conversion:
              inverting the match made the exclusion set load-bearing, and its status
              arm (`\bstatus\b`) missed camelCase locals like `tStatus`/`rStatus`.
              Seven status comparisons were being counted as column guards. Widening
              the arm to a suffix match drops them plus three more retired by merges
              since the pin.

Recording the direction and the split explicitly, because a ceiling that jumps is
normally the alarm this file exists to raise. Both jumps mean the OLD number was
wrong, not that the code got worse — and together they say the tracked figure was
missing 42% of the surface it claimed to bound.
*/
const CEILING = 745;

function productionSources(): string[] {
  /*
  FNXC:LegacyColumnCensus 2026-07-30-00:25 (PR #2557 review — greptile):
  THE PATHSPEC WAS THE BUG, and it under-reported in two independent directions.

    .tsx was absent entirely, so every dashboard component — the single largest
    cluster of lifecycle guards in the repo — was invisible to the census.

    A "packages, any package, src" glob misses the dashboard's own tree, which lives
    under `app` rather than `src`: its components, hooks and utils carry dozens of
    comparisons and none were counted.

  This is not hypothetical. I under-counted the triage backlog as 48 when it was 60
  for most of a session on exactly this assumption, and the program's tracked number
  was corrected twice for the same reason. A ceiling measured over a subset is not a
  ratchet: it lets the untracked majority grow freely while reporting green.

  (The literal glob strings are kept out of this comment on purpose — one of them
  contains the block-comment terminator and silently truncates the note.)
  */
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "packages/*/src/**/*.ts", "packages/*/src/*.ts",
      "packages/*/src/**/*.tsx", "packages/*/src/*.tsx",
      "packages/*/app/**/*.ts", "packages/*/app/*.ts",
      "packages/*/app/**/*.tsx", "packages/*/app/*.tsx",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(f));
}

function census(): { total: number; byFile: Map<string, number> } {
  const byFile = new Map<string, number>();
  let total = 0;
  for (const file of productionSources()) {
    let text: string;
    try {
      text = readFileSync(resolve(REPO_ROOT, file), "utf8");
    } catch {
      // FAIL CLOSED: a source we cannot read is a source we did not census.
      byFile.set(`${file} (UNREADABLE)`, Number.NaN);
      continue;
    }
    let n = 0;
    for (const line of text.split("\n")) {
      if (!LEGACY_COLUMN_DECISION.test(line)) continue;
      if (AGENT_ID_FALLBACK.test(line) && !LEGACY_COLUMN_COMPARISON.test(line)) continue;
      /* Receiver is provably not a column — see NON_COLUMN_RECEIVER. */
      if (NON_COLUMN_RECEIVER.test(line) && !LEGACY_COLUMN_FALLBACK.test(line)) continue;
      n += 1;
    }
    if (n > 0) {
      byFile.set(file, n);
      total += n;
    }
  }
  return { total, byFile };
}

describe("legacy column-literal census — the unconverted lifecycle surface", () => {
  it("never grows: no NEW lifecycle decision may be keyed to a legacy column name", () => {
    const { total, byFile } = census();

    const unreadable = [...byFile.keys()].filter((k) => k.endsWith("(UNREADABLE)"));
    expect(unreadable, "a tracked source could not be read, so the census is incomplete").toEqual([]);

    const worst = [...byFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f, n]) => `${n} ${f}`)
      .join("\n    ");

    expect(
      total,
      `The legacy column-literal census ROSE to ${total} (ceiling ${CEILING}).\n\n` +
        "A lifecycle decision was newly keyed to a column NAME rather than a ROLE. That is how\n" +
        "every defect this program has found got in: the guard reads correctly, passes its tests\n" +
        "on the built-in workflow, and is silently inert on a renamed board.\n\n" +
        "Resolve the role instead (resolveLifecycleColumns / resolveCompleteColumn /\n" +
        "resolveReboundTarget / columnHasFlag), or if the literal is genuinely correct, say why\n" +
        "in a comment and raise the ceiling in the same PR.\n\n" +
        `  heaviest files:\n    ${worst}\n`,
    ).toBeLessThanOrEqual(CEILING);
  });

  it("reports when the count has fallen, so the pin can be lowered", () => {
    const { total } = census();
    /*
    Not an equality assertion — see the header. A dozen conversion slices move this
    number concurrently, and a test that goes red on work going the RIGHT way gets
    suppressed. This case documents the current value in its own name instead: when it
    has fallen materially, lower CEILING in the PR that lowered it.
    */
    if (total < CEILING) {
      // eslint-disable-next-line no-console
      console.log(
        `legacy-column-literal census: ${total} (ceiling ${CEILING}) — ${CEILING - total} converted since the pin. Lower CEILING to ${total}.`,
      );
    }
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("sees the defects it cites as its reason to exist", () => {
    /*
    THE CASE THAT CAUGHT THE HOLE. The header lists five motivating defects; a
    comparison-only regex saw two. A census blind to three of its own examples is worse
    than no census — it reports a number that feels like coverage. Pinning the examples
    means the pattern cannot narrow back without this failing.
    */
    const motivating = [
      'if (task.column !== "todo") return;',
      'if (task.column === "done" || task.column === "archived") return false;',
      'return resolveReboundTarget(ir) ?? "todo";',
      'completeColumn: resolveCompleteColumn(ir) ?? "done",',
      'mergeColumn: resolveMergeOrchestrationColumn(ir) ?? "in-review",',
    ];
    for (const line of motivating) {
      expect(LEGACY_COLUMN_DECISION.test(line), `census is blind to: ${line}`).toBe(true);
    }
  });

  it("does not count an agent-id fallback that merely spells a column name", () => {
    /* `"triage"` is both a column id and the synthetic triage agent id. Counting these
       inflated the number by eight, all in triage.ts. */
    const agentLines = [
      'agentId: task.assignedAgentId ?? "triage",',
      'auditContext: { agentId: task.assignedAgentId ?? "triage", runId: x },',
      'agentId: assignedAgent?.id ?? "triage",',
    ];
    for (const line of agentLines) {
      expect(LEGACY_COLUMN_DECISION.test(line), "matches the raw shape").toBe(true);
      expect(AGENT_ID_FALLBACK.test(line), `should be excluded: ${line}`).toBe(true);
    }
    // ...but a genuine column fallback that mentions triage is still counted.
    const columnLine = 'const intake = first("intake") ?? "triage";';
    expect(AGENT_ID_FALLBACK.test(columnLine)).toBe(false);
    expect(LEGACY_COLUMN_DECISION.test(columnLine)).toBe(true);
  });

  it("counts a DECISION, not a mention", () => {
    /* The regex must not fire on a column id appearing in a fixture, a log line, or a
       migration — none of those are lifecycle decisions, and counting them would inflate
       the number into noise nobody acts on. */
    expect(LEGACY_COLUMN_DECISION.test('if (task.column === "todo") return;')).toBe(true);
    expect(LEGACY_COLUMN_DECISION.test('if (live.column !== "in-review") return false;')).toBe(true);
    expect(LEGACY_COLUMN_DECISION.test('log.info(`moved to "done"`);')).toBe(false);
    expect(LEGACY_COLUMN_DECISION.test('const seed = { column: "todo" };')).toBe(false);
    expect(LEGACY_COLUMN_DECISION.test('await store.moveTask(id, "done");')).toBe(false);
  });
});
