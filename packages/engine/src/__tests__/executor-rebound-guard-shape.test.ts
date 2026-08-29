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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
FNXC:WorkflowLifecycleColumns 2026-08-23-18:35:
The rebound moves this guard covers no longer live in `executor.ts`. The package code-organization
waves (1cf86baa1c "executor pure peels", and the later per-concern peels) moved every one of them
into `src/executor/*.ts`, which left this static check scanning a file with zero matches — a guard
reporting success on an empty set. The scan now covers the whole executor family (`executor.ts` plus
every module under `executor/`), so the invariant follows the code instead of the filename.
*/
describe("no rebound move is guarded by a column literal", () => {
  const engineSrc = join(dirname(fileURLToPath(import.meta.url)), "..");
  const executorDir = join(engineSrc, "executor");
  const sourceFiles = [
    join(engineSrc, "executor.ts"),
    ...readdirSync(executorDir)
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => join(executorDir, entry)),
  ];
  /** Comments blanked in place so prose about the old shape is not read as code. */
  const lines = sourceFiles.flatMap((file) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
      .replace(/\/\/.*$/gm, "")
      .split("\n")
      .map((line) => ({ file, line })),
  );

  it("resolves the rebound column before every guarded rebound move", () => {
    const offenders: string[] = [];

    lines.forEach(({ file, line: rawLine }, index) => {
      const line = rawLine;
      if (!/moveTask\([^)]*reboundColumn/.test(line) && !/reboundColumn,/.test(line)) return;
      // Walk back a few lines to the guard that admits this move, never crossing a file boundary.
      for (let i = Math.max(0, index - 6); i <= index; i += 1) {
        const candidate = lines[i];
        if (!candidate || candidate.file !== file) continue;
        if (/column\s*(?:===|!==)\s*["'](?:todo|triage|in-progress|in-review|done|archived)["']/.test(candidate.line)) {
          offenders.push(`${candidate.file}:${i + 1}: ${candidate.line.trim()}`);
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
    const reboundMoves = lines.filter(({ line }) => /moveTask\([^)]*(?:rebound|Rebound)Column/.test(line));

    expect(reboundMoves.length).toBeGreaterThanOrEqual(8);
  });
});
