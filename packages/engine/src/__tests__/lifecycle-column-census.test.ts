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

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:05 (PR #2633 review, greptile P1):

COMMENT STRIPPING MUST PRESERVE LINE COUNT. Deleting a multi-line block comment outright shifted
every following line, and the consequence was not the harmless over-count I had written down: the
site-local DELIBERATE-LITERAL lookup ran at the wrong offset, so ONE marker in a file laundered
FOUR unrelated live guards in `replan-target.ts` — they were reported as reviewed-and-intentional
when they are neither. Findings also pointed at unrelated source lines, which sends a reader to
the wrong code. Blanking the comment in place fixes both.
*/
describe("stripping a comment must not move the lines after it", () => {
  it("reports the ORIGINAL line number after a multi-line block comment", () => {
    const source = ["/* a", "multi", "line", "comment */", `const a = task.column === "triage";`].join("\n");

    expect(census(source)[0]?.line).toBe(5);
  });

  it("finds a site-local marker across a multi-line comment", () => {
    const source = [
      `/* FNXC:Whatever ${DELIBERATE_MARKER}: reason`,
      "spanning",
      "several",
      "lines */",
      `const a = task.column === "triage";`,
    ].join("\n");

    expect(summarize(census(source)).totals.deliberate).toBe(1);
  });

  it("does NOT let a marker launder guards the shift used to pull into range", () => {
    // The replan-target.ts case, minimized: a marked site near the top, then a genuinely
    // unrelated guard far below. Before the fix the deletion of the intervening comment moved
    // the second guard inside the marker's window and it was scored `deliberate`.
    const source = [
      `/* ${DELIBERATE_MARKER}: this fallback must not be workflow-resolved. */`,
      `const fallback = declared ? resolved : "triage";`,
      "/*",
      ...Array.from({ length: 30 }, (_, i) => ` * filler line ${i}`),
      " */",
      `if (task.column === "in-progress" || task.column === "done") return true;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.column).toBe(2);
    expect(summary.totals.deliberate).toBe(0);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:35 (PR #2633 review follow-up):

A NAME LIST IS GUESSWORK, and mine was already wrong: `skill-resolver.ts` compares
`sessionPurpose` and `tool-availability.ts` compares `surface`, and both scored as column guards
until a human found them by hand. Names are unbounded; the vocabulary is not.

`AgentRole` is `triage | executor | reviewer | merger`, and three of those four are never column
ids. So an expression compared against `"executor"`/`"reviewer"`/`"merger"` nearby is being matched
against ROLES whatever it is called. Structural, not nominal — and it generalises to receivers
nobody has named yet. `triage` belonging to both vocabularies is the whole reason this exists.
*/
describe("a role comparison is recognised by the vocabulary it uses, not only by its name", () => {
  it("classifies an unfamiliar receiver as a role when it is matched against role-only values", () => {
    const source = [
      `const usesRoleFallback = sessionPurpose === "triage"`,
      `  || sessionPurpose === "executor"`,
      `  || sessionPurpose === "reviewer";`,
    ].join("\n");

    expect(summarize(census(source)).totals).toEqual({ column: 0, role: 1, status: 0, deliberate: 0 });
  });

  it("recognises the single-line ternary form too", () => {
    // tool-availability.ts's shape: `surface === "triage" ? A : B` with the union declared above.
    const source = `return surface === "triage" ? TRIAGE_GUIDANCE : EXECUTOR_GUIDANCE;\nif (surface === "executor") return x;`;

    expect(summarize(census(source)).totals.role).toBe(1);
  });

  it("does NOT reclassify a genuine column guard that merely sits near role code", () => {
    // The signal is the RECEIVER being matched against a role-only value — not proximity alone.
    // Otherwise one nearby role check would launder every column guard around it.
    const source = [
      `if (agentType === "executor") return;`,
      `if (task.column === "triage") return;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.column).toBe(1);
    expect(summary.totals.role).toBe(0);
  });

  it("still counts a column guard whose receiver is an unremarkable local", () => {
    // `cli/src/commands/task.ts` compares `col` against the column ids for its board dots —
    // an unfamiliar name, but the vocabulary is columns, so it stays in the backlog.
    const source = [
      `const dot = col === "triage" ? "●" :`,
      `  col === "todo" ? "●" :`,
      `  col === "in-review" ? "●" : "○";`,
    ].join("\n");

    expect(summarize(census(source)).totals.column).toBe(3);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:20 (third colliding vocabulary):

STATUS IS NOT A COLUMN, and this is the largest correction the census has produced: 182 of the 1030
sites it first called column guards compare an ENTITY STATUS. `StepStatus` is
`pending | in-progress | done | skipped`; mission features and goals carry their own
`done`/`archived` statuses. So `step.status === "done"` and `goal.status === "archived"` were
counted as un-migrated lifecycle guards, inflating `done` (105 of 313) and `in-progress` (49 of
201).

Converting one would be worse than leaving it: asking "which column carries the complete trait"
about a STEP's status is a category error, and the step would stop reading as finished.
*/
describe("entity statuses that share a column name are not column guards", () => {
  it("classifies step, goal and feature statuses as status, not backlog", () => {
    const source = [
      `const isDone = step.status === "done" || step.status === "skipped";`,
      `if (existing.status === "archived") return;`,
      `if (feature.status === "done") count += 1;`,
    ].join("\n");

    const summary = summarize(census(source));

    // Three, not four: `skipped` is a StepStatus value but NOT one of the six legacy column ids,
    // so the census never looks at it. Only the `done`/`archived`/`done` comparisons are findings
    // at all — which is itself worth knowing, since it means the status inflation comes entirely
    // from the three names the two vocabularies share.
    expect(summary.totals.status).toBe(3);
    expect(summary.totals.column).toBe(0);
  });

  it("recognises a status by the vocabulary even when the receiver is not named `status`", () => {
    // `pending` and `skipped` are StepStatus members and never column ids, so an expression
    // matched against either is a status whatever it is called — the same structural signal the
    // role classification uses, for the same reason: names are unbounded.
    const source = [
      `const finished = s === "done"`,
      `  || s === "pending"`,
      `  || s === "skipped";`,
    ].join("\n");

    expect(summarize(census(source)).totals.status).toBe(1);
  });

  it("does NOT reclassify a real column guard sitting near status code", () => {
    const source = [
      `if (step.status === "pending") return;`,
      `if (task.column === "done") return;`,
    ].join("\n");

    const summary = summarize(census(source));

    // The column guard stays backlog. The `pending` line is not a finding at all — it compares a
    // value outside the column vocabulary — so a nearby status check cannot launder the guard, and
    // it cannot pad the status count either.
    expect(summary.totals.column).toBe(1);
    expect(summary.totals.status).toBe(0);
  });

  it("keeps a column guard that merely lives in a file full of statuses", () => {
    const source = `if (toColumn === "in-progress" && task.status === "pending") return;`;
    const summary = summarize(census(source));

    // The column half is still backlog; only the status half is excluded.
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
    expect(summarize([]).totals).toEqual({ column: 0, role: 0, status: 0, deliberate: 0 });
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

    expect(summary.totals).toEqual({ column: 1, role: 1, status: 0, deliberate: 1 });
    expect(summary.byColumnId).toEqual({ todo: 1 });
  });
});
