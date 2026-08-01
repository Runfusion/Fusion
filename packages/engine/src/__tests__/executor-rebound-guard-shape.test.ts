// @vitest-environment node

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:55 (PR #2635 review, greptile P2):

"Seven rebound sites remain untested" — fair, and stating it as a coverage note was not an answer.
Seven of the eight sit inside graph-failure / stuck-kill / dependency-gate paths that need a live
graph run to reach, so behavioural coverage for each would cost more scaffolding than the change
itself. What they share is a SHAPE, so the shape is what gets pinned.

This is a static check over `executor.ts`: every guard in front of a rebound move must compare
against a RESOLVED value, never a column literal. It fails on the exact defect the PR fixes — a
`column !== "todo"` check standing in front of a `moveTask(..., reboundColumn)` — at whichever of
the eight sites it is reintroduced, including sites added later that no behavioural test knows about.

It is a static check and is labelled as one: it proves the pattern is absent, not that each path
behaves. `executor-rebound-already-there.test.ts` carries the behavioural proof for the one
reachable site (`parkCompletedBlockedTask`).

It lives in its OWN file because the shared executor test helpers mock `node:fs`, so a suite that
imports them cannot read source off disk — a detail worth writing down, since the failure looks
like a broken path rather than a mocked module.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("no rebound move is guarded by a column literal", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "executor.ts"),
    "utf8",
  );
  /** Comments blanked in place so prose about the old shape is not read as code. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
  const lines = code.split("\n");

  it("resolves the rebound column before every guarded rebound move", () => {
    const offenders: string[] = [];

    lines.forEach((line, index) => {
      if (!/moveTask\([^)]*reboundColumn/.test(line) && !/reboundColumn,/.test(line)) return;
      // Walk back a few lines to the guard that admits this move.
      for (let i = Math.max(0, index - 6); i <= index; i += 1) {
        if (/column\s*(?:===|!==)\s*["'](?:todo|triage|in-progress|in-review|done|archived)["']/.test(lines[i] ?? "")) {
          offenders.push(`${i + 1}: ${(lines[i] ?? "").trim()}`);
        }
      }
    });

    expect(offenders).toEqual([]);
  });

  it("finds the defect when it is reintroduced (the check is not vacuous)", () => {
    // Same detection, run over a fixture carrying the original shape. Without this, a regex that
    // silently stopped matching would report a clean file forever.
    const reintroduced = [
      `    if (task.column !== "todo") {`,
      `      await this.store.moveTask(task.id, reboundColumn, { preserveProgress: true });`,
      `    }`,
    ];
    const offenders: string[] = [];

    reintroduced.forEach((line, index) => {
      if (!/moveTask\([^)]*reboundColumn/.test(line)) return;
      for (let i = Math.max(0, index - 6); i <= index; i += 1) {
        if (/column\s*(?:===|!==)\s*["'](?:todo|triage|in-progress|in-review|done|archived)["']/.test(reintroduced[i] ?? "")) {
          offenders.push(String(i + 1));
        }
      }
    });

    expect(offenders).toEqual(["1"]);
  });

  it("still sees the eight rebound moves it is meant to cover", () => {
    // A guard that reports success on zero matches is worse than no guard.
    const reboundMoves = lines.filter((line) => /moveTask\([^)]*(?:rebound|Rebound)Column/.test(line));

    expect(reboundMoves.length).toBeGreaterThanOrEqual(8);
  });
});
