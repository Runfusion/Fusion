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
