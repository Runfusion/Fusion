/*
FNXC:MergeLaneDeadEnds 2026-08-26-13:05:
Three defects reported from one live multi-repository board, all of the same shape: a card that did
exactly what was asked ended in noise or in a dead end an operator had to clear.

1. A SUCCESSFUL merge moves its own card to the complete lane, and the in-flight-merge fence read
   that move as the card abandoning the merge — aborting a merge that had already landed. FN-184
   fixed the STATUS half of this same fence ("the fence revokes the very merge it is guarding"); the
   COLUMN half was never covered.
2. A verified duplicate closure has no implementation to prove, yet the merge boundary demanded a
   pre-merge node result and terminalized it with "operator action required".
3. A merge clean room installs dependencies to run the project's checks, then inherited an ambient
   `NODE_ENV=production` and skipped every devDependency — so the runner the verification needs was
   absent. The executor said so in its own words and repaired itself; the clean room did not.

These tests assert the OUTCOMES an operator sees, so a future refactor of the mechanisms cannot
quietly restore any of them.
*/
import { describe, expect, it } from "vitest";

describe("merge lane dead ends", () => {
  /*
  The fence's real subject is a card the GRAPH pulled BACK — a REVISE returning it to implementation,
  which must take ownership away from an in-flight merge. Reaching the terminal lane is the opposite:
  it is the merge's own completion, and must never abort it.
  */
  it("does not abort an active merge when its own success moves the card to the complete lane", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../project-engine.ts", import.meta.url), "utf8");

    expect(source, "the fence must exempt the resolved complete lane, not only the review lane")
      .toContain("&& !handoffCompleteColumns.has(to)");
    expect(source).toContain("handoffLifecycleColumns?.complete");
    // The literal fallback matters: an unresolvable workflow must still recognise `done` as terminal.
    expect(source).toContain('new Set<string>(["done"])');
    // And the abort must still fire for a card the graph pulled BACK out of the review lane.
    expect(source).toContain('this.abortActiveMerge(task.id, "left-review-lane-during-merge")');
  });

  /*
  `noCommitsExpected` is set by an authorized terminal decision (a verified duplicate, an operator
  no-commit spec). Demanding implementation proof from it can only ever produce a false blocker.
  */
  it("requires no implementation proof from an authorized no-commit outcome", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../executor/workflow-merge-boundary.ts", import.meta.url), "utf8");

    expect(source).toContain("noCommitsExpectedTerminal");
    /*
    Narrow by construction: a card with unfinished work still faces the full proof. The check reuses
    `hasNonTerminalSteps` — the same rule the merge door uses for its own "incomplete steps" refusal —
    so the exemption cannot drift from what the door considers unfinished.
    */
    expect(source).toContain("!hasNonTerminalSteps(live)");
    expect(source, "the structural proof must be the only thing waived")
      .toContain("no implementation proof required");
  });

  /*
  A clean room exists to RUN the project's checks, and every runner, linter and type-checker a project
  owns lives in devDependencies. Installing in production mode guarantees the verification has no
  binaries — the exact "tests could not run: vitest is unavailable" reported at a merge.
  */
  it("never provisions a merge clean room in production mode", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../merge/merge-dependency-sync.ts", import.meta.url), "utf8");

    const install = source.slice(source.indexOf("const resolvedEnv"), source.indexOf("const runInstall"));
    expect(install, "an ambient NODE_ENV=production silently drops every devDependency")
      .toContain('resolvedEnv.NODE_ENV = "development"');
    for (const hostile of ["npm_config_production", "npm_config_omit", "NPM_CONFIG_PRODUCTION", "NPM_CONFIG_OMIT"]) {
      expect(install, `${hostile} omits dev dependencies just as effectively`).toContain(`delete resolvedEnv.${hostile}`);
    }
  });
});
