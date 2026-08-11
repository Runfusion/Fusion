/*
FNXC:PlanningClaimSingleWriter 2026-07-28-15:00 (U7 / R4, R12 — workflow-owned lifecycle):

THE RATCHET: the task planning CLAIM — `status: "planning"` — has exactly ONE
writer module, and every write of it goes through the guarded helper.

WHY THIS SPECIFIC INVARIANT. The plan names FN-8504 as U7's acceptance case: a
store-open sweep cleared a live planner's status because two owners wrote planning
lifecycle state. The unit's stated verification is "a grep-level assertion that
planning status literals have one writer module". This is that assertion.

`status: "planning"` is the CLAIM on a card — it means "a planner owns this task
right now". It is also load-bearing well beyond triage: `isUnplannedForExecution`
treats it as dispatch-blocking, rediscovery skips cards carrying it, and two
self-healing sweeps plus two triage sweeps exist solely to clear it when a planner
dies. A second writer does not announce itself; it produces a card that looks
claimed to every reader while nothing is actually planning it.

WHAT THIS DOES NOT ASSERT, so the guard is not mistaken for more than it is:

  - It says nothing about who CLEARS the status. Eleven modules write
    `status: null` for unrelated reasons (merge, execution, mission autopilot), so
    "one clearer" would be false, and asserting it would mean weakening it into
    something that passes — the worst kind of guard.
  - `needs-replan` is deliberately NOT covered. Post-U3 it is the graph's own
    durable replan signal (AGENTS.md), written by the plan-review → plan-replan
    seam AND the stale-spec guards that feed the same loop. Multiple writers there
    are the design, not a defect.
  - Mission `status: "planning"` is a different entity on a different table. The
    scan is scoped so a mission-store write can never satisfy or trip this.

The two self-healing sweeps that READ `status === "planning"` for orphan recovery
are the compensating machinery FN-8504 produced. They are readers plus a
CAS-guarded clear, not claimants, so they do not violate this — and if U7's later
work makes them unreachable, that is a deletion, not a change to this contract.

Cheap by construction (FN-5048): grep-level over production source, no engine boot.
*/
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/**
 * Production source roots, DISCOVERED rather than listed.
 *
 * FNXC:PlanningClaimSingleWriter 2026-07-28-16:20 (PR #2527 review — greptile):
 * This was a hardcoded four-package list, which made a repo-wide claim while
 * scanning a subset: `packages/desktop` and `packages/plugin-sdk` both touch
 * TaskStore and were never looked at, and any package added later would have been
 * silently out of scope forever. A guard whose blind spot grows as the repo grows
 * is not a guard. Enumerating `packages/<name>/src` means new packages are covered
 * the day they appear, with no allowlist to forget to update.
 */
function sourceRoots(base: string = REPO_ROOT): string[] {
  /*
  FNXC:PlanningClaimSingleWriter 2026-07-29-20:30 (PR #2587 review — greptile P2):
  BOTH first-party trees. `packages/` alone left `plugins/<name>/src` unscanned, and
  a first-party plugin can reach the task store — so a plugin writing the planning
  claim sat outside a ratchet whose whole assertion is "production-wide". Same shape
  as the hardcoded four-package list this function already replaced: a guard whose
  blind spot is defined by wherever someone happened to look.
  */
  const roots: string[] = [];
  for (const tree of ["packages", "plugins"]) {
    const dir = join(base, tree);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // A tree absent from this checkout is not a hole.
    }
    for (const name of entries) {
      try {
        if (statSync(join(dir, name, "src")).isDirectory()) roots.push(`${tree}/${name}/src`);
      } catch {
        /* not a source package */
      }
    }
  }
  return roots.sort();
}

/**
 * The single module permitted to claim a task for planning.
 *
 * Adding an entry here is the reviewable act this ratchet exists to force: it
 * means a second owner now writes the claim, which is the FN-8504 shape. If that
 * is genuinely intended, the justification belongs beside the new entry.
 */
const PLANNING_CLAIM_WRITERS = ["packages/engine/src/triage.ts"];

/**
 * Modules permitted to BIND the planning literal to a constant.
 *
 * `replan-target.ts` binds it to EXCLUDE it — `planning` is the transient in-flight
 * claim, deliberately filtered out of the durable planning-stage set — and writes no
 * task status anywhere. It is here because binding the literal is the indirection
 * route around the write patterns, so a NEW entry deserves a look even when the
 * module turns out, like this one, to be a reader.
 */
/* FNXC:PlanningClaimSingleWriter 2026-08-11-17:30: relocated to `execution/` — same stale-path
   drift as NON_TASK_STATUS_MODULES below, and red on main for the same reason. */
const PLANNING_CLAIM_BINDERS = ["packages/engine/src/execution/replan-target.ts"];

/**
 * Mission planning is a different entity with its own `status` column. Excluded by
 * path rather than by pattern, because a pattern loose enough to tell them apart is
 * a pattern loose enough to miss a real task write.
 */
/*
FNXC:PlanningClaimSingleWriter 2026-08-11-17:30:
PATHS, so a MOVE breaks them. Both mission stores were relocated into `missions/` and
`async-stores/` subdirectories, and this list kept naming the old flat paths — so the ratchet
had been failing on main, accusing two mission modules it was written to exclude. A guard that
is red for a reason nobody believes is a guard people stop reading; the drift is the cost of
excluding by path, accepted here because a pattern loose enough to tell mission status from
task status is loose enough to miss a real second writer (see the note above).
*/
const NON_TASK_STATUS_MODULES = [
  "packages/core/src/missions/mission-store.ts",
  "packages/core/src/async-stores/async-mission-store.ts",
];

function sourceFiles(root: string, base: string = REPO_ROOT): string[] {
  const abs = join(base, root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(abs);
  return out;
}

/**
 * Strip comments so an explanatory FNXC note naming the literal is not a hit.
 *
 * FNXC:PlanningClaimSingleWriter 2026-07-30-00:20 (PR #2587 review — CodeRabbit):
 * TRAILING comments count too. This stripped only lines that were ENTIRELY a `//`
 * comment, so `doStuff(); // ... status: "planning" ...` read as executable code and
 * would have failed the ratchet on prose. A ratchet with a known false positive gets
 * disabled by the first person it annoys, which is the same end state as not having
 * one — and this program's whole thesis is that guards must be trustworthy.
 *
 * `//` inside a string literal (a URL) is deliberately NOT protected: the cost of
 * over-stripping is losing the rest of one line from a scan that is only looking for
 * `status: <planning literal>` assignments, whereas the cost of under-stripping is a
 * false accusation. Wrong in the harmless direction, on purpose.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

const executableSource = (file: string): string => stripComments(readFileSync(file, "utf-8"));

/**
 * The planning literal in EVERY spelling JavaScript allows.
 *
 * FNXC:PlanningClaimSingleWriter 2026-07-28-16:20 (PR #2527 review — greptile):
 * The original pattern matched only the exact double-quoted form, so a second
 * writer could evade the whole ratchet by typing a single quote. That is a
 * spelling check wearing a single-writer guarantee's name — the sixth
 * guard-that-cannot-fire on this program, and the third I have written or found.
 */
const PLANNING_LITERAL = String.raw`(?:"planning"|'planning'|\x60planning\x60)`;

/**
 * A WRITE, not a READ. The distinction is load-bearing: several modules
 * legitimately COMPARE against the claim (`t.status === "planning"` in the
 * self-healing orphan sweeps, membership in a status array), and flagging those
 * would force an allowlist so large the guard would mean nothing.
 *
 * Covered write shapes: object-literal property, plain assignment, and a computed
 * `["status"]` key. Reads (`===`, `!==`, `includes`) are excluded by requiring a
 * single `:` or `=` that is not part of a comparison operator.
 */
const CLAIM_WRITE = new RegExp(
  String.raw`(?:\bstatus\s*:\s*|\bstatus\s*=(?!=)\s*|\[\s*["']status["']\s*\]\s*(?::|=(?!=))\s*)` + PLANNING_LITERAL,
);

/**
 * A constant bound to the planning literal. Without this, indirection defeats the
 * write patterns above — `const CLAIM = "planning"; store.updateTask(id, { status: CLAIM })`
 * is a second writer the shape-matching alone cannot see. Binding the literal at all,
 * outside the allowlisted module, is the reviewable event.
 */
const CLAIM_BINDING = new RegExp(
  String.raw`\b(?:const|let|var|readonly)\s+\w+\s*(?::\s*[^=;]+)?=\s*` + PLANNING_LITERAL,
);

/*
FNXC:PlanningClaimSingleWriter 2026-07-28-16:40 (PR #2527 review — greptile):
WRITES and BINDINGS are reported SEPARATELY, with separate allowlists, because
conflating them produces a false accusation. Widening the detector immediately
flagged `replan-target.ts` — which binds the literal ONLY to exclude it from a
status set (`PLANNING_STAGE_STATUSES.filter(s => s !== TRANSIENT_PLANNING_STATUS)`)
and never writes a task status at all. Calling that a second writer would have been
wrong, and the tempting fixes — dropping the binding rule, or allowlisting it as a
"writer" — would have either reopened the indirection hole or made the guard lie.

So: the WRITE list stays at exactly one module, and the BINDING list is its own
contract — a new module binding the claim is reviewable precisely because binding is
the route around the write patterns.
*/

/**
 * Every module under `roots` whose EXECUTABLE source writes the planning claim.
 *
 * Parameterised on `base` so the injection test below can run this exact function
 * over a fixture tree. Re-implementing the scan in the test would prove only that
 * the copy works — which is the failure mode this whole program keeps finding.
 */
function scanFor(
  matches: (source: string) => boolean,
  roots?: readonly string[],
  base: string = REPO_ROOT,
): string[] {
  const hits: string[] = [];
  for (const root of roots ?? sourceRoots(base)) {
    for (const file of sourceFiles(root, base)) {
      const rel = file.slice(base.length + 1);
      if (NON_TASK_STATUS_MODULES.includes(rel)) continue;
      if (matches(executableSource(file))) hits.push(rel);
    }
  }
  return hits.sort();
}

const planningClaimWriters = (roots?: readonly string[], base?: string): string[] =>
  scanFor((src) => CLAIM_WRITE.test(src), roots, base);

const planningClaimBinders = (roots?: readonly string[], base?: string): string[] =>
  scanFor((src) => CLAIM_BINDING.test(src), roots, base);

describe("the planning claim has a single writer (U7 / FN-8504)", () => {
  it("is written by exactly the allowlisted module", () => {
    expect(planningClaimWriters()).toEqual([...PLANNING_CLAIM_WRITERS].sort());
  });

  it("is bound to a constant only by the allowlisted modules", () => {
    // The indirection route: `const CLAIM = "planning"` defeats the write patterns.
    expect(planningClaimBinders()).toEqual([...PLANNING_CLAIM_BINDERS].sort());
  });

  it("writes the claim only through the planning-stage-guarded helper", () => {
    /*
    The claim must never be a bare `store.updateTask`. FN-7977 and FN-8361 are both
    that bug: a write that does not re-check the planning stage under the task lock
    stamps `planning` onto a card the scheduler has already advanced, and the card
    then looks claimed to every reader while nothing is planning it.
    */
    const source = executableSource(join(REPO_ROOT, "packages/engine/src/triage.ts"));
    const claims = [...source.matchAll(/status:\s*"planning"/g)];
    expect(claims).toHaveLength(1);

    /*
    FNXC:PlanningClaimSingleWriter 2026-07-29-20:30 (PR #2587 review — greptile P2):
    Assert CONTAINMENT, not co-location. The original required the helper name and
    the literal to share a physical line, so wrapping the call across lines during
    routine formatting would fail a guard about WHO writes the claim, for reasons of
    whitespace. A ratchet that breaks on formatting gets deleted by the first person
    it annoys — the same end state as not having one.
    */
    const claimIndex = source.search(CLAIM_WRITE);
    const helperIndex = source.lastIndexOf("updatePlanningStateIfStillCurrent(", claimIndex);
    expect(helperIndex).toBeGreaterThan(-1);
    // Nothing may terminate that call between the helper and the claim.
    expect(source.slice(helperIndex, claimIndex)).not.toMatch(/;/);
  });

  /*
  A ratchet that cannot be shown to fail on the defect it names is not a ratchet.
  These run the REAL `planningClaimWriters` over a fixture tree — not a
  re-implementation of it — so a scan that silently stopped looking would be caught.
  */
  describe("the detector itself", () => {
    let fixtureRoot = "";

    const fixture = (relative: string, contents: string): void => {
      const full = join(fixtureRoot, relative);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    };

    afterEach(() => {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    });

    const newFixtureRoot = (): string => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "fusion-claim-ratchet-"));
      return fixtureRoot;
    };

    /*
    FNXC:PlanningClaimSingleWriter 2026-07-28-16:40 (PR #2527 review — greptile):
    EVERY spelling, because the original detector matched only the double-quoted
    form and a second writer could have evaded the entire ratchet by typing a
    single quote. Each row is a form that previously slipped past.
    */
    const EVASIONS: ReadonlyArray<[string, string]> = [
      ["double quotes", 'await store.updateTask(id, { status: "planning" });'],
      ["single quotes", "await store.updateTask(id, { status: 'planning' });"],
      ["template literal", "await store.updateTask(id, { status: `planning` });"],
      ["extra whitespace", 'await store.updateTask(id, { status  :   "planning" });'],
      ["plain assignment", "task.status = 'planning';"],
      ["computed key", `await store.updateTask(id, { ["status"]: 'planning' });`],
    ];

    for (const [label, code] of EVASIONS) {
      it(`FINDS an injected second writer using ${label}`, () => {
        const base = newFixtureRoot();
        fixture("pkg/src/innocent.ts", "export const x = 1;\n");
        fixture("pkg/src/sneaky.ts", `${code}\n`);

        expect(planningClaimWriters(["pkg/src"], base)).toEqual(["pkg/src/sneaky.ts"]);
      });
    }

    it("FINDS the constant-indirection route the write patterns alone cannot see", () => {
      const base = newFixtureRoot();
      fixture(
        "pkg/src/indirect.ts",
        "const CLAIM = 'planning';\nawait store.updateTask(id, { status: CLAIM });\n",
      );

      // Not a WRITE by shape — the write patterns see `status: CLAIM`, not a literal.
      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
      // Caught by the binding contract instead, which is why that exists.
      expect(planningClaimBinders(["pkg/src"], base)).toEqual(["pkg/src/indirect.ts"]);
    });

    it("does NOT flag a module that only COMPARES against the claim", () => {
      // The distinction that keeps the allowlist small enough to mean something:
      // self-healing's orphan sweeps read this literal and must stay unflagged.
      const base = newFixtureRoot();
      fixture(
        "pkg/src/reader.ts",
        "if (t.status === 'planning') return;\nconst S = new Set([\"planning\", \"done\"]);\nif (S.has(t.status)) return;\n",
      );

      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
    });

    it("scans EVERY package under packages/, not a hardcoded subset", () => {
      // The scope hole: a package outside the old four-entry list was never looked
      // at, and a package added later would have been out of scope forever.
      const base = newFixtureRoot();
      fixture("packages/brand-new/src/writer.ts", "task.status = 'planning';\n");

      expect(planningClaimWriters(undefined, base)).toEqual(["packages/brand-new/src/writer.ts"]);
    });

    it("is not fooled by a TRAILING comment that names the literal", () => {
      /*
      PR #2587 review — CodeRabbit. Whole-line `//` stripping left this as code, so
      the ratchet would have accused a file whose only mention of the claim is prose
      at the end of a real statement.
      */
      const base = newFixtureRoot();
      fixture("pkg/src/trailing.ts", 'const x = 1; // beware: status: "planning" is triage-owned\n');

      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
    });

    it("is not fooled by a comment that merely names the literal", () => {
      // Prose describing the claim must survive — every deletion on this program
      // leaves an explanatory tombstone — without being read as a writer.
      const base = newFixtureRoot();
      fixture("pkg/src/documented.ts", '/* FNXC: triage writes status: "planning" here */\nconst x = 1;\n');
      fixture("pkg/src/line-comment.ts", '// status: "planning" is claimed by triage\nconst y = 2;\n');

      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
    });

    it("ignores test files, which legitimately name the claim", () => {
      const base = newFixtureRoot();
      fixture("pkg/src/__tests__/a.test.ts", 'expect(t).toEqual({ status: "planning" });\n');

      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
    });
  });
});
