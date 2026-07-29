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

WHAT IT COUNTS: `x.column === "<legacy id>"` / `!==` in production source. That is a
LIFECYCLE DECISION KEYED TO A NAME. It deliberately does NOT count string literals in
general — a column id in a fixture, a log line, or a migration is not a decision.

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

/** A lifecycle decision keyed to a legacy column NAME. */
const LEGACY_COLUMN_DECISION = /\.column\s*(?:===|!==)\s*"(?:todo|triage|in-progress|in-review|done|archived)"/;

/*
The pinned ceiling. Measured 2026-07-29 on main at the U12-part-9 tip.
LOWER THIS when a conversion slice reduces the count — in the same PR.
*/
const CEILING = 417;

function productionSources(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "packages/*/src/**/*.ts", "packages/*/src/*.ts"],
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
    for (const line of text.split("\n")) if (LEGACY_COLUMN_DECISION.test(line)) n += 1;
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
