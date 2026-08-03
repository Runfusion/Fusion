/*
FNXC:WorkflowLifecycleColumns 2026-07-31-17:44 (a ratchet over the class the census cannot count):

THE CENSUS SCANS COMPARISONS. THIS CLASS IS COLLECTIONS.

`lifecycle-column-census.mjs` counts `===`/`!==` against a column. A legacy-id Set or array consulted
with `.has(task.column)` is a DEFINITION, not a comparison, so no census run has ever pointed at one.
That blind spot has now produced three found-by-hand defects:

  `GITHUB_TRACKING_EDITABLE_COLUMNS`   the operator could not toggle GitHub tracking at all on a
                                       renamed board — no error, the affordance simply absent (#3149)
  `TIME_INDICATOR_COLUMNS`             cards showed the wrong elapsed-time indicator
  `BLOCKER_ESCALATION_COLUMNS`         escalation skipped renamed lanes

#3149 enumerated the population by hand and reported "19 such sites ... this is where the remaining
renamed-board defects actually live". A number in a PR body rots. This is that enumeration as a
ratchet, so the next one cannot appear silently.

WHAT THIS FILE CLAIMS, AND WHAT IT DELIBERATELY DOES NOT. It claims the POPULATION is the recorded
set. It does NOT claim each site is correct — 20 of the 23 are #3149's assessment ("most are already
correct, either no-flags fallbacks or seed-then-add resolved sets"), and I did not re-verify them.
Blessing sites I have not read is how a ledger becomes a list of things someone once glanced at. A
new entry fails this test and a human reads that ONE site; that is the whole mechanism.

MY OWN DETECTOR'S PICK-WORK LIST WAS 100% FALSE POSITIVES, measured, and it is why this file has no
"unresolved candidates" assertion. The heuristic "no role-helper call in the file" flagged three
sites; all three were fine:

  agent-role-policy.ts:32     a documented FLAGGED-NOT-FIXED deferral with the reasoning recorded
  DocumentsView.tsx:88        already converted — flags-first, threaded as an object rather than
                              called, so a scan for resolver CALLS cannot see the conversion
  agent-assignment.ts:118     a `DELIBERATE-LITERAL` fallback behind an injected
                              `countsAsAssignmentLoad` callback, reviewed 2026-07-31-05:40

That is the same failure `--triage`'s pick-work list had before #3194 fixed it, from the same cause:
inferring "unexamined" from the absence of a pattern rather than from evidence. A detector that
cannot tell "not yet looked at" from "looked at and settled" must not be pointed at a work queue. It
can still hold a population steady, which is all this does.

KNOWN REACH LIMITS, stated so this is not mistaken for coverage of the class:
  - Only NAMED collections (`const X = new Set([...])`) consulted as `X.has(col)`/`X.includes(col)`.
    An inline `["todo","done"].includes(col)` is invisible.
  - The argument must mention column/lane, so `.has(c)` with a short name is missed.
  - Collections reached through a property (`CONFIG.columns.has(...)`) are missed.
  A miss here is a site nobody is watching, not a false green on a site that is listed.
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
  "packages/dashboard/app",
  "packages/cli/src",
];

/** Built-in lane ids. A collection holding two or more is about the default board's vocabulary. */
const LEGACY_IDS = ["triage", "todo", "in-progress", "in-review", "done", "archived", "ideas"];

/**
 * The recorded population, as `file :: collectionName`. Line numbers are deliberately excluded —
 * they drift with unrelated edits and would make this ledger fail for reasons that are not about
 * lane vocabulary at all.
 */
const RECORDED_GATING_SITES: ReadonlySet<string> = new Set([
  "packages/core/src/agent-role-policy.ts :: IMPLEMENTATION_TASK_COLUMNS",
  "packages/core/src/column-roles.ts :: LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS",
  "packages/core/src/live-agent-count.ts :: LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS",
  "packages/core/src/task-store/branch-group-ops.ts :: satisfiedColumns",
  "packages/core/src/task-store/update-task-deps.ts :: refineFrom",
  "packages/core/src/workflow-analytics.ts :: LEGACY_ACTIVE_LANES",
  "packages/dashboard/app/components/DocumentsView.tsx :: LEGACY_PRE_IMPLEMENTATION_COLUMNS",
  "packages/dashboard/app/components/TaskCard.tsx :: TIME_INDICATOR_COLUMNS",
  "packages/dashboard/app/components/TaskDetailModal.tsx :: GITHUB_TRACKING_EDITABLE_COLUMNS",
  "packages/dashboard/app/hooks/useSessionFiles.ts :: LEGACY_ACTIVE_COLUMNS",
  "packages/dashboard/app/hooks/useTasks.ts :: PLANNER_ACTIVITY_COLUMN_IDS",
  "packages/dashboard/app/utils/columnRoles.ts :: LEGACY_FIELD_EDITABLE_COLUMN_IDS",
  "packages/dashboard/app/utils/columnRoles.ts :: LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS",
  "packages/engine/src/agent-assignment.ts :: LEGACY_ACTIVE_COLUMNS",
  "packages/engine/src/agent-reflection.ts :: completedColumns",
  "packages/engine/src/ephemeral-worker-manager.ts :: TERMINAL_TASK_COLUMNS",
  "packages/engine/src/executor.ts :: activeColumns",
  "packages/engine/src/merger.ts :: finalizedColumns",
  "packages/engine/src/merger.ts :: sourceTerminal",
  "packages/engine/src/mission-execution-loop.ts :: fixTaskTerminalColumns",
  "packages/engine/src/mission-feature-sync.ts :: LEGACY_PLANNER_COLUMNS",
  "packages/engine/src/triage.ts :: LEGACY_PLANNER_COLUMN_IDS",
  /*
  FNXC:WorkflowEvents 2026-08-03-02:01:
  Wake-on-column handler: when task:updated carries resolved lanes, hold|intake decide membership;
  when lanes are omitted the builtin-board set is the documented fallback (todo|triage). Recorded
  so the ledger does not re-flag a RESOLVED site with a deliberate legacy arm.
  */
  "packages/engine/src/triage.ts :: LEGACY_PLANNER_WAKE_COLUMNS",
  "packages/engine/src/worktree-pool.ts :: managed",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full)) yield full;
  }
}

/*
Comments stripped first, for the reason every scanner in this series has had to learn: several of
these files quote their own collection by name in an FNXC note explaining the bug it caused.
`TaskDetailModal.tsx` and `TaskCard.tsx` both do. Counting prose would make the ledger fire on the
files that document the hazard most carefully.
*/
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Named legacy-id collections consulted against a runtime column value. */
function findGatingSites(): string[] {
  const found = new Set<string>();
  const declPattern =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,120})?=\s*(?:new Set(?:<[^>]*>)?\(\s*)?\[([^\]]{0,400}?)\]/g;

  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      const source = stripComments(readFileSync(file, "utf8"));

      const collections = new Map<string, number>();
      for (const decl of source.matchAll(declPattern)) {
        const hits = LEGACY_IDS.filter((id) => new RegExp(`["'\`]${id}["'\`]`).test(decl[2])).length;
        if (hits >= 2) collections.set(decl[1], hits);
      }
      if (collections.size === 0) continue;

      for (const name of collections.keys()) {
        const usePattern = new RegExp(String.raw`\b${name}\.(?:has|includes)\(([^)]{0,60})\)`, "g");
        for (const use of source.matchAll(usePattern)) {
          /* The argument must look like a live column, not an id or a string constant. */
          if (!/column|lane/i.test(use[1])) continue;
          found.add(`${rel} :: ${name}`);
        }
      }
    }
  }
  return [...found].sort();
}

describe("legacy-id collections that gate a live column are a closed population", () => {
  it("has no unrecorded gating site", () => {
    const unrecorded = findGatingSites().filter((site) => !RECORDED_GATING_SITES.has(site));

    expect(unrecorded, [
      "",
      "A legacy-id collection is gating a live column value, and it is not in the ledger.",
      "",
      "The lifecycle-column census CANNOT see this: it scans `===`/`!==` comparisons, and a Set or",
      "array literal is a definition. Three shipped defects came from exactly this shape, the worst",
      "being #3149 — the operator could not toggle GitHub tracking at all on a renamed board.",
      "",
      "Decide which this is, then record it here:",
      "  - a RESOLVED site keeping the legacy set as a no-flags fallback  -> add it, this is the",
      "    normal shape (`if (!flags) return LEGACY_SET.has(column)`, roles decide otherwise);",
      "  - a DELIBERATE literal (an unconverted-caller default, a STATE marker) -> mark it at the",
      "    site and add it;",
      "  - genuinely unconverted -> convert it with the role helpers before adding it.",
      "",
      "Adding a line here is not the fix. Reading the one site is.",
      "",
    ].join("\n")).toEqual([]);
  });

  /*
  The ledger must not rot into names that no longer exist. A stale entry reads as "someone
  considered this", which is the decay every ledger in this repo has hit — and it is how a ratchet
  quietly stops ratcheting, because the population it compares against is fiction.
  */
  it("has no stale ledger entry", () => {
    const live = new Set(findGatingSites());
    const stale = [...RECORDED_GATING_SITES].filter((site) => !live.has(site)).sort();

    expect(stale, [
      "",
      "A recorded gating site no longer exists — the collection was renamed, converted away, or its",
      "file moved. Delete the line. Population shrinking is the goal; a ledger that keeps ghosts",
      "cannot tell you what is really left.",
      "",
    ].join("\n")).toEqual([]);
  });

  /*
  ANTI-VACUITY. Both cases above are set differences, and both pass trivially against an empty scan —
  a moved directory, a regex that stopped matching, a walker that throws. This pins that the detector
  still finds the three sites whose defects motivated the file.
  */
  it("still finds the collections whose defects motivated this ledger", () => {
    const sites = findGatingSites();

    expect(sites).toContain(
      "packages/dashboard/app/components/TaskDetailModal.tsx :: GITHUB_TRACKING_EDITABLE_COLUMNS",
    );
    expect(sites).toContain("packages/dashboard/app/components/TaskCard.tsx :: TIME_INDICATOR_COLUMNS");
    expect(sites.length).toBeGreaterThan(15);
  });

  /*
  The paired negative for the detector itself: it must key on the COLLECTION shape, not on any
  mention of a legacy id. A file comparing a column directly is the CENSUS's population, and pulling
  those in here would double-count a class that already has a gate.
  */
  it("does not claim plain comparisons — those belong to the census", () => {
    const sites = findGatingSites();

    /* `self-healing.ts` is dense with column comparisons and has no gating collection. */
    expect(sites.filter((s) => s.startsWith("packages/engine/src/self-healing.ts"))).toEqual([]);
  });
});
