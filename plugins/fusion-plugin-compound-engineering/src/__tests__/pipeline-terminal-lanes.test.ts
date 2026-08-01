/*
FNXC:WorkflowResolvedColumns 2026-07-31-04:45:
CE PIPELINES STALLED FOREVER ON A RENAMED BOARD.

`isStageTerminalColumn` decides whether a stage's board work is finished; the reconciler advances the
pipeline only when every current-stage task answers true. It was a membership test against the
literal `{in-review, done}`, so on a board whose review and completion lanes are renamed the answer
was false for every task, permanently: the pipeline never advanced a stage, never created its
outbound task, and sat `running`. Nothing errors, which is why it reads as work that has not
finished rather than as a bug.

The cases are DIFFERENTIAL: the same finished task under two vocabularies whose roles are identical
and only the ids differ. `shipped` and `checking` collide with no legacy id, so a surviving literal
cannot pass by luck.

WHAT THIS COVERS AND WHAT IT DOES NOT. It drives the real resolution path — a real `PluginContext`
task store, a registered workflow definition, a real selection read — which is the half that needed
proving. The reconciler's own `every(Boolean)` wiring is a one-line call and is covered by typecheck
only; a full advancement fixture needs pipeline state plus links plus board tasks, which this plugin
has no scaffolding for. Stated rather than implied.
*/

import { beforeAll, afterAll, expect, it } from "vitest";
import { makeHarness, pgDescribe, type TestHarness } from "./_harness.js";
import { isStageTerminalColumn } from "../sync/reconciler.js";
import type { Task } from "@fusion/core";

const RENAME: Record<string, string> = {
  todo: "drafting",
  "in-progress": "building",
  "in-review": "checking",
  done: "shipped",
};

/** The builtin coding lanes with only their ids renamed, as a v2 IR. */
const RENAMED_IR = {
  version: "v2",
  name: "renamed",
  columns: [
    { id: RENAME.todo, name: "Drafting", traits: [{ trait: "intake" }] },
    { id: RENAME["in-progress"], name: "Building", traits: [{ trait: "wip" }] },
    { id: RENAME["in-review"], name: "Checking", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
    { id: RENAME.done, name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: RENAME.todo }, { id: "end", kind: "end", column: RENAME.done }],
  edges: [{ from: "start", to: "end" }],
};

/*
FNXC:WorkflowResolvedColumns 2026-07-31-05:00:
TRAIT IDS ARE KEBAB-CASE; the camelCase names are the resolved FLAGS.

`{ trait: "humanReview" }` resolves to NO flags at all — silently, because an unknown trait is not an
error — so a fixture written that way produces a column with no roles and its assertions read as a
product defect. `complete` is spelled identically in both vocabularies, which is exactly what made
the first run look like "complete works, review is broken" rather than "the fixture is wrong".
*/
const task = (id: string, column: string) => ({ id, column, title: id, description: "t" } as unknown as Task);

pgDescribe("CE stage-terminal detection under a renamed board vocabulary", () => {
  let h: TestHarness;

  beforeAll(async () => { h = await makeHarness(); });
  afterAll(() => { h?.close(); });

  /* Control: with no workflow registered the legacy pair still answers, so an unconverted board and
     a resolution failure are byte-identical to the previous behaviour. */
  it("no resolvable workflow: the legacy pair still decides", async () => {
    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-LEGACY-1", "done"))).toBe(true);
    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-LEGACY-2", "in-review"))).toBe(true);
    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-LEGACY-3", "in-progress"))).toBe(false);
  });

  /* The defect: before the fix every one of these was false, so the pipeline never advanced. */
  it("renamed vocabulary: the renamed complete and review lanes are terminal", async () => {
    h.defineWorkflow("wf-renamed", RENAMED_IR);
    for (const id of ["KB-R1", "KB-R2"]) h.assignTaskWorkflow(id, "wf-renamed");

    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-R1", "shipped"))).toBe(true);
    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-R2", "checking"))).toBe(true);
  });

  /*
  The paired negative: resolving real lanes must not degrade into "every column is terminal", which
  would advance a pipeline whose board work has not started — worse than stalling, because it
  propagates an outbound task for unfinished work.
  */
  it("renamed vocabulary: the renamed WIP and intake lanes are NOT terminal", async () => {
    h.defineWorkflow("wf-renamed", RENAMED_IR);
    for (const id of ["KB-R3", "KB-R4"]) h.assignTaskWorkflow(id, "wf-renamed");

    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-R3", "building"))).toBe(false);
    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-R4", "drafting"))).toBe(false);
  });

  /*
  A board that declares a column named `done` WITHOUT the complete trait. The literal would call it
  terminal; the resolved answer must not. This is the shape that separates a real resolution from a
  legacy fallback that happens to agree.
  */
  it("a declared `done` column with no terminal trait is NOT terminal", async () => {
    h.defineWorkflow("wf-done-not-complete", {
      version: "v2",
      name: "done-is-not-complete",
      columns: [
        { id: "drafting", name: "Drafting", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done pile (not terminal)", traits: [] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "drafting" }, { id: "end", kind: "end", column: "shipped" }],
      edges: [{ from: "start", to: "end" }],
    });
    h.assignTaskWorkflow("KB-R5", "wf-done-not-complete");

    expect(await isStageTerminalColumn(h.ctx.taskStore, task("KB-R5", "done"))).toBe(false);
  });
});
