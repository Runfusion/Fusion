/*
FNXC:WorkflowLifecycleColumns 2026-07-30-14:35 (Phase C convergence — the census's own tests):

A census nobody has tried to fool is a number, not a measurement. This pins every form the
lifecycle-column census must catch, and every form it must NOT count — because the tracked
`=== "triage"` grep it replaces was wrong in three separate ways, and each way cost real work:

  1. it counted only ONE of six legacy column ids (triage was under 4% of the total);
  2. it missed guards whose local was named `from` / `originColumn` rather than `column`;
  3. it counted `role === "triage"` / `agentType === "triage"` — AGENT ROLE comparisons that
     must never be converted, since the planner lane keeps that name.

Each case below is one of those, plus the comment-prose case that inflated two files' counts.
*/
import { describe, expect, it } from "vitest";

import {
  DELIBERATE_MARKER,
  LEGACY_COLUMN_IDS,
  findComparisons,
  receiverOf,
  stripComments,
  summarize,
} from "../../../../scripts/lib/lifecycle-column-census.mjs";

function census(source: string) {
  return findComparisons("fixture.ts", source);
}

function kinds(source: string): string[] {
  return census(source).map((f) => (f as { kind: string }).kind);
}

describe("the census counts a column guard in every shape the codebase actually uses", () => {
  it("counts all six legacy column ids, not just triage", () => {
    // Defect 1: the tracked grep measured `triage` only, which was under 4% of the real total.
    const source = LEGACY_COLUMN_IDS.map((id, i) => `const a${i} = task.column === "${id}";`).join("\n");

    expect(kinds(source)).toEqual(LEGACY_COLUMN_IDS.map(() => "column"));
  });

  it("counts a guard whose local is NOT named `column`", () => {
    // Defect 2: this is verbatim the shape of the three executor.ts guards that were absent
    // from the tracked list while the card they stranded had its work already complete.
    const source = [
      `if ((from === "todo" || from === "triage") && to !== "in-progress") return;`,
      `const promoted = originColumn === "todo" || originColumn === "triage";`,
    ].join("\n");

    expect(kinds(source).every((k) => k === "column")).toBe(true);
    expect(kinds(source)).toHaveLength(5);
  });

  it("counts single-quoted and negated forms", () => {
    const source = [
      `if (task.column !== 'in-review') return;`,
      `const done = t.column === 'done';`,
    ].join("\n");

    expect(kinds(source)).toEqual(["column", "column"]);
  });

  it("counts more than one comparison on the same line", () => {
    const source = `const planner = c === "todo" || c === "triage" || c === "archived";`;

    expect(kinds(source)).toHaveLength(3);
  });
});

describe("the census does NOT count things that are not column guards", () => {
  it("ignores AGENT ROLE comparisons", () => {
    // Defect 3. Converting these silently empties the planner's prompt template, so counting
    // them as backlog actively invites the wrong fix.
    const source = [
      `if (role === "triage") return TRIAGE_PROMPT;`,
      `const lane = agentType === "triage" ? planning : execution;`,
      `if (entry.agent !== "triage") return;`,
    ].join("\n");

    expect(kinds(source)).toEqual(["role", "role", "role"]);
    expect(summarize(census(source)).totals.column).toBe(0);
  });

  it("ignores comment prose describing a past guard", () => {
    // Two of the tracked hits in replan-target.ts were prose about a filter in another file.
    const source = [
      `/* the discovery filter (\`column === "triage" && ready\`) never re-admitted it */`,
      `// historical: fromColumn === "todo" used to mean planning`,
      `const real = task.column === "done";`,
    ].join("\n");

    expect(kinds(source)).toEqual(["column"]);
  });

  it("counts a trailing line comment as prose, not code", () => {
    // `stripComments` needs the multiline flag or a trailing comment survives and is counted.
    const source = `const x = 1; // task.column === "triage" is gone`;

    expect(stripComments(source)).not.toContain("triage");
    expect(kinds(source)).toEqual([]);
  });

  it("classifies a reviewed literal as deliberate when the marker is at the site", () => {
    const source = [
      `/* FNXC:Whatever ${DELIBERATE_MARKER}: the fallback must NOT be workflow-resolved. */`,
      `const target = declared ? resolved : "triage";`,
      `if (task.column === "triage") return legacy;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.deliberate).toBe(1);
    expect(summary.totals.column).toBe(0);
  });

  it("does NOT let a marker elsewhere in the file excuse a distant guard", () => {
    // Otherwise one marker launders a whole file, which is how allowlists rot.
    const source = [
      `/* ${DELIBERATE_MARKER}: reason for the site below. */`,
      `const a = task.column === "triage";`,
      ...Array.from({ length: 20 }, (_, i) => `const filler${i} = ${i};`),
      `const b = task.column === "done";`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.deliberate).toBe(1);
    expect(summary.totals.column).toBe(1);
  });
});

describe("receiver extraction survives real call shapes", () => {
  it("reads through property access, optional chaining, and parentheses", () => {
    expect(receiverOf("if (task.column ")).toBe("column");
    expect(receiverOf("if (live?.column ")).toBe("column");
    expect(receiverOf("if (String(task.status) ")).toBe("status");
    expect(receiverOf("  const x = from ")).toBe("from");
  });
});

describe("the census refuses to report success on nothing", () => {
  it("summarizes an empty finding list as three zeros, never as a pass signal", () => {
    /*
    The CLI additionally exits 1 when its own file list comes back EMPTY, because a guard that
    reports success without checking anything is worse than no guard. That path is a process
    exit and is exercised by running the script; this pins the pure half — an empty census is
    three zeros and carries no verdict of its own.
    */
    expect(summarize([]).totals).toEqual({ column: 0, role: 0, deliberate: 0 });
    expect(summarize([]).byFile).toEqual([]);
  });
});

describe("the summary separates the three classes", () => {
  it("reports column guards, role comparisons and deliberate literals independently", () => {
    // Netting them into one number is what produced a tracked figure that was simultaneously
    // too high and too low.
    const source = [
      `if (task.column === "todo") return;`,
      `if (role === "triage") return;`,
      `/* ${DELIBERATE_MARKER}: reason. */`,
      `if (fallbackColumn === "triage") return;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals).toEqual({ column: 1, role: 1, deliberate: 1 });
    expect(summary.byColumnId).toEqual({ todo: 1 });
  });
});
