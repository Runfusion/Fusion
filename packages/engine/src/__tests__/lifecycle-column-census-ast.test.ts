/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:20 (Phase C convergence — the AST classifier's tests):

WHY A PARSER AT ALL. Three people measured this backlog with three greps and got three different
answers for the role bucket (6, 8, 12). A regex cannot tell a lifecycle-column comparison from an
agent role, a session purpose, a surface name, a step status, or a comment — so no grep-derived
number is authoritative, however careful the pattern.

These cases are the four reintroduction shapes a ratchet must catch (double-quoted, single-quoted,
multiline, deeper-qualified) plus the shapes it must NOT flag. A guard nobody has tried to fool is
a number, not a measurement.

The parser and the text classifier are kept as two independent implementations on purpose: the CLI's
`--compare` asserts the parser is a strict SUPERSET of the regex (measured +6, all real), and fails
if the regex ever finds something the parser misses — which would mean the parser has a blind spot
and its count cannot be the bar.
*/
import { describe, expect, it } from "vitest";

import {
  DELIBERATE_MARKER,
  findComparisons,
  summarize,
} from "../../../../scripts/lib/lifecycle-column-census-ast.mjs";

function census(source: string) {
  return findComparisons("fixture.tsx", source);
}

function totals(source: string) {
  return summarize(census(source)).totals;
}

describe("the parser catches every reintroduction shape", () => {
  it("double-quoted", () => {
    expect(totals(`if (task.column === "triage") return;`).column).toBe(1);
  });

  it("single-quoted", () => {
    expect(totals(`if (task.column === 'triage') return;`).column).toBe(1);
  });

  it("multiline, where the operator and the literal are on different lines", () => {
    // A per-line regex cannot see this at all; it is why the text classifier under-counts by 6.
    const source = ["if (", "  task.column", "  ===", '  "triage"', ") return;"].join("\n");

    expect(totals(source).column).toBe(1);
  });

  it("deeper-qualified receivers", () => {
    const source = [
      `if (ctx.live.task.column === "triage") return;`,
      `if (tasks[i].column === "todo") return;`,
      `if (live?.column === "in-review") return;`,
      `if (String(t.column) === "done") return;`,
    ].join("\n");

    expect(totals(source).column).toBe(4);
  });

  it("literal on the LEFT", () => {
    // `"triage" === task.column` reads oddly but parses identically, and a regex anchored on the
    // receiver misses it entirely.
    expect(totals(`if ("triage" === task.column) return;`).column).toBe(1);
  });

  it("loose equality", () => {
    expect(totals(`if (task.column == "triage") return;`).column).toBe(1);
    expect(totals(`if (task.column != "triage") return;`).column).toBe(1);
  });

  it("inside JSX, which is why the parser uses ScriptKind.TSX", () => {
    const source = [
      `export const Badge = ({ task }: { task: { column: string } }) => (`,
      `  <span className={task.column === "triage" ? "is-planning" : "is-live"} />`,
      `);`,
    ].join("\n");

    expect(totals(source).column).toBe(1);
  });
});

describe("the parser does not flag what a regex mistakes for a guard", () => {
  it("ignores comments entirely — they are not tokens", () => {
    // The text classifier needs a comment stripper for this, and a bug in that stripper let ONE
    // marker launder FOUR live guards. A parse cannot have that class of bug.
    const source = [
      `/* the old filter was \`column === "triage" && ready\` */`,
      `// historical: fromColumn === "todo" meant planning`,
      `const real = task.column === "done";`,
    ].join("\n");

    expect(totals(source)).toEqual({ column: 1, role: 0, status: 0, deliberate: 0 });
  });

  it("classifies agent roles, session purposes and surfaces as role", () => {
    const source = [
      `if (role === "triage") return TRIAGE_PROMPT;`,
      `if (agentType === "triage") return planning;`,
      `if (entry.agent !== "triage") return;`,
      `const usesFallback = sessionPurpose === "triage" || sessionPurpose === "executor";`,
      `return surface === "triage" ? A : B;`,
    ].join("\n");

    const result = totals(source);

    expect(result.column).toBe(0);
    // Five, not six: the `sessionPurpose === "executor"` sibling is not itself a finding, because
    // `executor` is not a column id. It only serves as EVIDENCE that its receiver holds a role —
    // which is the whole mechanism, so it is worth having the count say so.
    expect(result.role).toBe(5);
  });

  it("classifies step, goal and feature statuses as status", () => {
    const source = [
      `const isDone = step.status === "done" || step.status === "skipped";`,
      `if (existing.status === "archived") return;`,
    ].join("\n");

    const result = totals(source);

    expect(result.column).toBe(0);
    expect(result.status).toBe(2);
  });

  it("treats a marked site as deliberate, including a marker above the enclosing FUNCTION", () => {
    // The shape that caught a statement-only lookup: `legacyDependencySatisfied` in
    // hold-release.ts carries the marker above the function while the comparisons are inside it.
    const source = [
      `/* FNXC:Whatever ${DELIBERATE_MARKER}: the legacy half of a dual-accept pair. */`,
      `function legacySatisfied(dep: { column: string }): boolean {`,
      `  return dep.column === "done" || dep.column === "archived";`,
      `}`,
    ].join("\n");

    const result = totals(source);

    expect(result.deliberate).toBe(2);
    expect(result.column).toBe(0);
  });

  it("does NOT let a marker excuse a sibling construct", () => {
    // Ancestor scope, not a line window: a marker excuses what it is attached to and what is
    // inside it, and nothing else. The window version excused whatever was within twelve lines.
    const source = [
      `/* ${DELIBERATE_MARKER}: reason for the function below. */`,
      `function marked(dep: { column: string }) { return dep.column === "done"; }`,
      `function unmarked(dep: { column: string }) { return dep.column === "triage"; }`,
    ].join("\n");

    const result = totals(source);

    expect(result.deliberate).toBe(1);
    expect(result.column).toBe(1);
  });

  it("does not count a value that merely happens to equal a column id", () => {
    // Assignments, object literals and arguments are not comparisons. A census that counted them
    // would report the workflow DEFINITIONS as violations, and the builtin lineage legitimately
    // declares these ids.
    const source = [
      `const target = "triage";`,
      `const columns = [{ id: "triage" }, { id: "todo" }];`,
      `await store.moveTask(id, "todo");`,
    ].join("\n");

    expect(totals(source)).toEqual({ column: 0, role: 0, status: 0, deliberate: 0 });
  });
});

describe("sibling detection uses the enclosing expression, not a line window", () => {
  it("sees a role-only sibling across a long multi-line chain", () => {
    const source = [
      `const usesRoleFallback = purposeOf(x) === "triage"`,
      `  || somethingElse`,
      `  || anotherThing`,
      `  || yetAnother`,
      `  || purposeOf(x) === "merger";`,
    ].join("\n");

    // Six lines apart: outside any reasonable line window, inside one expression.
    expect(totals(source).role).toBe(1);
  });

  it("does NOT borrow a sibling from an adjacent, unrelated expression", () => {
    const source = [
      `const isRole = agentType === "executor";`,
      `const isPlanning = task.column === "triage";`,
    ].join("\n");

    const result = totals(source);

    expect(result.column).toBe(1);
    expect(result.role).toBe(0);
  });
});

/*
FNXC:LifecycleColumnCensus 2026-07-29-20:10 (query-filter category):

A guard is not the only way a legacy column id decides behaviour. `listTasks({ column: "todo" })`
is a SOURCE QUERY — it selects the rows a sweep considers at all — so on a board that renamed or
merged that column it returns nothing, and a sweep whose per-task predicate WAS correctly converted
still does nothing while looking converted. `self-healing.ts:2849` names the pairing in prose and
#2560 had to repair exactly that combination.

The comparison walk cannot see these: a PropertyAssignment is not a BinaryExpression. So they were
invisible to both the census and its ratchet, and the class could grow silently.

These cases pin the three decisions that make the category meaningful: it is counted, it is counted
SEPARATELY from the backlog, and an IR node definition is not mistaken for a query.
*/
describe("query-filter category", () => {
  it("counts a legacy column id used as a source-query filter", () => {
    const result = summarize(census(`await store.listTasks({ column: "todo", slim: true });`));
    expect(result.properties.query).toBe(1);
    expect(result.queryByColumnId).toEqual({ todo: 1 });
  });

  it("keeps queries OUT of the guard backlog, which is the completion bar", () => {
    /* The load-bearing decision. Folding these into `totals.column` would move a number the
       program is actively driving to zero, and would make every fleet PR's before/after
       arithmetic disagree with the bar. */
    const result = summarize(census(`await store.listTasks({ column: "triage" });`));
    expect(result.totals.column).toBe(0);
    expect(result.byColumnId).toEqual({});
    expect(result.byFile).toEqual([]);
    expect(result.properties.query).toBe(1);
  });

  it("does NOT count a workflow IR node definition as a query", () => {
    /* `column:` on a graph node declares WHERE the node lives — the lineage describing itself,
       not a lookup, and not convertible. Told apart structurally (an `id`/`kind` sibling) rather
       than by filename, so a definition written anywhere is classified the same way. */
    const result = summarize(census(`const ir = { nodes: [{ id: "review", kind: "review", column: "in-review" }] };`));
    expect(result.properties.query).toBe(0);
    expect(result.properties.definition).toBe(1);
    expect(result.totals.column).toBe(0);
  });

  it("still counts a comparison in the same file, so the two instruments are independent", () => {
    /* Without this, a bug that routed comparisons into the query bucket would look like a clean
       pass on both numbers. */
    const result = summarize(census(`
      const rows = await store.listTasks({ column: "todo" });
      if (task.column === "todo") { act(); }
    `));
    expect(result.properties.query).toBe(1);
    expect(result.totals.column).toBe(1);
  });

  it("honours a DELIBERATE-LITERAL marker on a query filter", () => {
    const result = summarize(census(`
      /* ${DELIBERATE_MARKER}: reviewed — this lineage genuinely declares todo. */
      const rows = await store.listTasks({ column: "todo" });
    `));
    expect(result.properties.query).toBe(0);
    expect(result.totals.deliberate).toBe(1);
  });

  it("ignores a column property whose value is not a legacy id", () => {
    const result = summarize(census(`await store.listTasks({ column: "backlog" });`));
    expect(result.properties.query).toBe(0);
  });

  it("does not mistake a typed missing-task stand-in for a query", () => {
    const result = summarize(census(`
      evaluate({ linkedTask: linkedTask ?? { column: "todo" } as Pick<Task, "column"> });
    `));
    expect(result.properties.synthetic).toBe(1);
    expect(result.properties.query).toBe(0);
  });

  it("does not let a state marker excuse a nearby executable query", () => {
    const result = summarize(census(`
      const tombstone = db.update(tasks).set({
        /* ${DELIBERATE_MARKER} — STATE MARKER */
        column: "archived",
      });
      await store.listTasks({ column: "todo" });
    `));
    expect(result.totals.deliberate).toBe(1);
    expect(result.properties.query).toBe(1);
  });
});

/*
FNXC:LifecycleColumnCensus 2026-07-29-21:05 (the `outcome` receiver):

`outcome` names a RESULT enum, not a column. The live instance is
`deterministicReconcile.outcome === "archived"` — the verdict of a duplicate reconciliation, which
merely shares a word with a column id.

This is pinned because losing it is not hypothetical: the shipped classifier counted these five
sites, the baseline recorded by the SAME PR did not, and that gap kept `--strict` RED on main from
#2633 until it was restored. A silent one-word regression in a token list took the ratchet offline
without failing anything, which is the same class of defect the ratchet exists to catch.
*/
describe("outcome is a result enum, not a column", () => {
  it("does not count `outcome === \"<column id>\"` as a guard", () => {
    const result = summarize(census(`if (reconcile.outcome === "archived") { return; }`));
    expect(result.totals.column).toBe(0);
    expect(result.totals.role).toBe(1);
  });

  it("still counts a real column comparison in the same file", () => {
    /* Guards the exclusion from being written too broadly — a rule that swallowed the neighbouring
       column guard would look identical on the count above. */
    const result = summarize(census(`
      if (reconcile.outcome === "archived") { return; }
      if (task.column === "archived") { hide(); }
    `));
    expect(result.totals.column).toBe(1);
    expect(result.totals.role).toBe(1);
  });
});

/*
FNXC:LifecycleColumnCensus 2026-07-29-21:50 (state/phase/result enums are not columns):

Four measured sites compared a state, phase, or result enum against a word that happens to be a
column id. The fleet would have been sent to convert them and found nothing to convert.

Classified by the SIBLING vocabulary, never by the receiver's name — and that distinction is load-
bearing rather than stylistic. `state` looks like exactly this class and is NOT: in
`comments-ops.ts` it holds `await getLiveTaskColumn(...)`, a real column. A name-based rule would
have silently deleted a genuine guard from the backlog while appearing to clean it up.
*/
describe("state, phase and result enums are not column guards", () => {
  it.each([
    ["step state", `stepState === "done" ? a : stepState === "active" ? b : c`],
    ["agent state", `agentState === "done" || agentState === "busy" || agentState === "ready"`],
    ["tui phase", `phase === "done" || phase === "pushing" || phase === "confirm"`],
    ["result kind", `kind === "done" || kind === "stopped" || kind === "exhausted"`],
  ])("does not count %s as a guard", (_label, source) => {
    expect(totals(source).column).toBe(0);
  });

  /*
  FNXC:LifecycleColumnCensus 2026-07-30-17:15 (PR #2692 review — greptile):
  THE NAME-BASED EXCLUSIONS NEED A SOURCE WITH NO SIBLING TO LEAN ON. Every case above supplies
  non-column siblings (`busy`, `pushing`, `stopped`), which the SIBLING mechanism already classifies
  on its own — so deleting the entire `type`/`mode`/`kind`/`phase`/`agentState` list left all 38
  tests green. Measured, not suspected.

  A bare comparison isolates the name rule: nothing else in the expression can produce the answer.
  */
  it.each([
    ["type", `if (type === "done") return;`],
    ["mode", `if (mode === "archived") return;`],
    ["kind", `if (kind === "done") return;`],
    ["phase", `if (phase === "done") return;`],
    ["agentState", `if (agentState === "done") return;`],
  ])("excludes a bare `%s` comparison with no sibling to classify it", (_label, source) => {
    expect(totals(source).column).toBe(0);
  });

  it("STILL counts a column held in a variable called `state`", () => {
    /* The case that makes a receiver-name rule wrong. This is the real shape from
       comments-ops.ts, and it must stay in the backlog. */
    const result = summarize(census(`
      const state = await getLiveTaskColumn(db, id, projectId);
      if (state === "archived") throw new Error("read-only");
    `));
    expect(result.totals.column).toBe(1);
  });
});

/*
FNXC:LifecycleColumnCensus 2026-08-01-01:30:

A LEGACY LITERAL IN A FALLBACK BRANCH IS NOT BACKLOG. The converted shape is

    if (flags) return flags.hold === true || flags.countsTowardWip === true;
    return column === "todo" || column === "in-progress";      // reachable only without traits

and that literal is CORRECT — it answers for callers with no resolved column metadata, which is the case
`resolveLifecycleColumns` returns `undefined`-for-the-whole-struct to preserve. Telling a batch worker to
"convert" it means telling them to delete the only answer available when traits are absent.

MEASURED, which is why this is a class and not a preference: a proximity scan for "legacy literal near a
role-resolved call" over the dashboard returned 19 hits and ZERO defects, all this shape. The same scan over
the engine found two real defects (#2670, #2672) — and in BOTH the literal was in a SEPARATE STATEMENT beside
resolved data, not in a fallback branch. That difference is structural, so the parser can see it; proximity
cannot.

Advisory only: `traitFallback` never changes `kind`, so a wrong hint cannot move the bar. Repo-wide it flags
8 of 746 column guards — 8 and not 9 since the #2677 review: the `hold` hint was matching inside `threshold`,
which had marked one live guard as already-converted.
*/
describe("a literal in a trait-fallback branch is flagged as such", () => {
  const fallbacksIn = (source: string) => census(source).filter((f) => (f as { traitFallback?: boolean }).traitFallback).length;

  it("flags the ternary form", () => {
    const source = `export function isHold(flags: F | undefined, columnId: string) {
      return flags ? flags.hold === true : columnId === "todo";
    }`;

    expect(fallbacksIn(source)).toBe(1);
  });

  it("flags the early-return form, which is how most of them are written", () => {
    const source = [
      "function mayEdit(column: string, flags?: F) {",
      "  if (flags) return flags.hold === true || flags.countsTowardWip === true;",
      `  return column === "todo" || column === "in-progress";`,
      "}",
    ].join("\n");

    // Two literals in one return, both in the fallback.
    expect(fallbacksIn(source)).toBe(2);
  });

  it("does NOT flag a literal in a separate statement beside resolved data — the #2670 / #2672 shape", () => {
    /*
    This is the distinction the whole class exists for. Both engine defects looked like this: resolved lane
    data in scope, and a guard next to it still matching a name. Flagging these as fallbacks would have hidden
    exactly the two bugs the scan found.
    */
    const source = [
      "async function park(task: T) {",
      "  const lanes = await resolveLifecycleColumns(ir);",
      `  if (task.column === "done" || task.column === "archived") return false;`,
      "  await move(task.id, lanes.hold);",
      "}",
    ].join("\n");

    expect(fallbacksIn(source)).toBe(0);
  });

  it("does NOT flag a fallback branch whose test is itself a column-name check", () => {
    // `if (column === "todo")` tests a NAME, not resolved data, so its else branch is not a trait fallback —
    // otherwise any if/else over column names would launder itself.
    const source = [
      "function f(column: string) {",
      `  if (column === "todo") return 1;`,
      `  return column === "in-progress" ? 2 : 3;`,
      "}",
    ].join("\n");

    expect(fallbacksIn(source)).toBe(0);
  });

  it("does NOT flag when the trait branch only returns CONDITIONALLY — a return token is not termination", () => {
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-10:05 (PR #2677 review — greptile):
    The detector used to search the branch for the word `return`. Here the branch contains one, but it is
    nested under its own `if`, so with `flags` present control still falls through and the literal below
    IS evaluated. That makes it a live guard, and flagging it as a fallback would quietly remove a real
    guard from the backlog this census is trusted to report.
    */
    const source = [
      "function mayEdit(column: string, flags?: F) {",
      "  if (flags) {",
      "    if (flags.hold === true) return true;",
      "  }",
      `  return column === "todo";`,
      "}",
    ].join("\n");

    expect(fallbacksIn(source)).toBe(0);
  });

  it("still flags a trait branch that terminates on EVERY path", () => {
    /* The paired positive: if/else where both arms return is genuine termination, so the literal below
       really is the no-traits answer. "Not a bare return token" must not become "no early returns". */
    const source = [
      "function mayEdit(column: string, flags?: F) {",
      "  if (flags) {",
      "    if (flags.hold === true) return true;",
      "    else return false;",
      "  }",
      `  return column === "todo";`,
      "}",
    ].join("\n");

    expect(fallbacksIn(source)).toBe(1);
  });

  it("does NOT flag when the trait branch ends in a non-terminating statement after a nested return", () => {
    /* Last-statement-wins: the block's final statement is a call, so the branch falls through. */
    const source = [
      "function mayEdit(column: string, flags?: F) {",
      "  if (flags) {",
      "    if (flags.hold === true) return true;",
      "    log(flags);",
      "  }",
      `  return column === "todo";`,
      "}",
    ].join("\n");

    expect(fallbacksIn(source)).toBe(0);
  });

  it("does NOT treat a hint embedded in a longer identifier as trait data", () => {
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-10:40 (PR #2677 review — coderabbit):
    `hold` is a hint, and it is a substring of `threshold`. A branch testing an unrelated
    threshold was read as testing resolved trait data, which marks the live guard below it as an
    already-converted fallback. `flags` inside `myflags` had the same problem.
    */
    for (const test of ["staleThreshold > 0", "opts.threshold != null", "household.size", "myflags"]) {
      const source = [
        "function f(column: string) {",
        `  if (${test}) return 1;`,
        `  return column === "todo";`,
        "}",
      ].join("\n");

      expect(fallbacksIn(source)).toBe(0);
    }
  });

  it("still sees the genuine trait forms the hints exist for", () => {
    /* The paired positive: tightening the boundary must not stop matching real trait reads. */
    for (const test of ["flags.hold === true", "flags?.hold", "lifecycleRoles.hold", "flags"]) {
      const source = [
        "function f(column: string, flags?: F) {",
        `  if (${test}) return 1;`,
        `  return column === "todo";`,
        "}",
      ].join("\n");

      expect(fallbacksIn(source)).toBe(1);
    }
  });

  it("leaves `kind` alone, so a wrong hint cannot move the bar", () => {
    const source = `const x = flags ? flags.hold === true : columnId === "todo";`;
    const finding = census(source)[0] as { kind: string; traitFallback?: boolean };

    expect(finding.kind).toBe("column");
    expect(finding.traitFallback).toBe(true);
  });
});
