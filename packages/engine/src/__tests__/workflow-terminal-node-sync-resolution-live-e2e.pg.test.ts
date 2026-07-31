/*
FNXC:StateMachine 2026-07-30-23:55 (E2E evidence — the terminal-node guard fires on the wrong node)
FNXC:StateMachine 2026-07-31-20:45 (FIXED in PR #2811 — the two cases below now assert the CORRECT behaviour):

Fourth in the inert-sync-resolution series (#2789 scheduler, #2791 planner lanes, #2792 custom
fields). This one does not merely answer with the wrong vocabulary: it makes a SAFETY GUARD fire on a
node that is not terminal and stay silent on the node that is.

`branch-and-pr-entities.ts`'s `isTaskTerminalNodeIdImpl` answers "is this the task's terminal node?"
by looking the id up in `store.resolveTaskWorkflowIrSync(taskId)` — which under PostgreSQL answers
`undefined` for every task and so resolves the DEFAULT workflow IR. It therefore answers about the
DEFAULT board's node graph, never the card's own, and its `catch` fallback (`nodeId === "end"`) is
unreachable because the lookup always succeeds against some IR.

It feeds FN-7641 Signature 2 in `updateTaskImpl`. That contract exists because setting `nodeId` to
the terminal node used to be written verbatim and silently do nothing — the card sat in review with
every step done, unadvanced and unexplained. The fix: a terminal override WITH durable merge proof
finalizes the card; WITHOUT proof it is rejected with an actionable error. Non-terminal overrides are
untouched.

Both halves invert on a board whose terminal node is not called `end`:

  set nodeId to a NON-terminal node that happens to be named `end`
      -> the default IR says `end` is terminal, so a legitimate routing override is REJECTED
  set nodeId to the board's REAL terminal node
      -> the default IR has no such node id, so the guard does not recognise it, the field is
         written verbatim, and the card stays where it was — the exact silent no-op FN-7641 removed

So the guard is not weakened in one direction and strengthened in the other; it is aimed at the wrong
node in both. Restoring the original bug on every custom board is what makes this worth its own file.

TWO GUARDS, NOT ONE — a correction the mutation runs forced, and the reason this file says more than
"the sync resolver is inert". `updateTask` passes through the node-override guard TWICE:

    branch-and-pr-entities.ts:568   validateNodeOverrideChange(task, nodeId, { isTerminalNodeId })
                                    -> the sync-IR resolution described above
    task-update.ts:53               validateNodeOverrideChange(task, nodeId)
                                    -> NO options, so it falls to `defaultIsTerminalNodeId`,
                                       which is the bare literal `nodeId === "end"`

The inner one is an unconverted literal sitting behind a converted call site, and it silently
overrides it: converting the outer guard alone changes NOTHING an operator can see. A column census
cannot find it either — `end` is a node id, not a column. This is the "a guard survives in a branch of
the same function" shape, one function apart.

Consequences, established by mutation rather than by reading (see the table in the PR body):

  `end` REJECTED    over-determined. BOTH guards independently call it terminal, so correcting either
                    one alone leaves the behaviour unchanged. Only correcting both flips it.
  `finish` SILENT   under-determined. BOTH guards must miss it, so correcting EITHER one flips it.

That asymmetry is why the two cases below are kept apart rather than merged into one round trip: they
bind to different failure structures.

FIXTURE. The shared builder cannot express this shape (its terminal node is `end`), so this file
derives from it: one `lifecycleIr`, with node ids shifted so the END node is `finish` and the
non-terminal planning node takes the name `end`. Columns, traits, edges and structure are otherwise
the builder's, so the only variable is which node ids carry which kind.

OBSERVED STATE. Whether `updateTask` throws, and what the re-read row's `nodeId` and `column`
actually are. No spies.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import { resolveWorkflowIrForTask, type TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

/**
 * The shared lifecycle IR with two node ids swapped: the `end`-kind node becomes `finish`, and the
 * non-terminal planning node takes the now-free name `end`. Edges are rewritten with the same map so
 * the graph stays exactly the builder's shape.
 */
function shiftedTerminalIr(id: string) {
  const base = lifecycleIr(RENAMED_VOCAB, id) as unknown as {
    nodes: { id: string }[];
    edges: { from: string; to: string }[];
  };
  const rename = (n: string) => (n === "end" ? "finish" : n === "plan" ? "end" : n);
  base.nodes = base.nodes.map((n) => ({ ...n, id: rename(n.id) }));
  base.edges = base.edges.map((e) => ({ ...e, from: rename(e.from), to: rename(e.to) }));
  return base as never;
}

pgDescribe("terminal-node resolution for a live task", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_terminal_node",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A task on the shifted board, parked in its review column (the guard is a no-op once a card is
   *  already in `done`, and refuses outright while a card is in progress). */
  async function taskOnShiftedBoard(store: TaskStore, key: string): Promise<string> {
    const created = await store.createWorkflowDefinition({
      name: `Terminal ${key}`,
      kind: "workflow",
      ir: shiftedTerminalIr(`custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `terminal probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, RENAMED_VOCAB.review as never, { recoveryRehome: true } as never);
    return task.id;
  }

  it("the board really is shifted: `finish` is the end node and `end` is not (fixture integrity)", async () => {
    /* First, because both characterizations below are claims about which node is terminal and would
       read as defects if the fixture had quietly kept the builder's node ids. */
    const store = h.store();
    const taskId = await taskOnShiftedBoard(store, "wf-integrity");

    const ir = await resolveWorkflowIrForTask(store, taskId);
    const nodes = (ir as { nodes: { id: string; kind: string }[] }).nodes;

    expect(nodes.find((n) => n.id === "finish")?.kind).toBe("end");
    expect(nodes.find((n) => n.id === "end")).toBeDefined();
    expect(nodes.find((n) => n.id === "end")?.kind).not.toBe("end");
  });

  it("a legitimate override to the non-terminal `end` node is WRITTEN", async () => {
    /*
    FIXED. On this board `end` is an ordinary planning node, so per the contract's own words
    ("non-terminal nodeId overrides ... are untouched") the override is simply written. Before the
    fix it was rejected with a merge-proof error about finalizing a card the operator was not
    finalizing, because BOTH guards independently called `end` terminal — the default IR said so, and
    `defaultIsTerminalNodeId` is the literal `"end"`.

    That over-determination is why this case is the one that proves the fix is COMPLETE: it could not
    move until both the outer resolution and the inner literal were corrected. See the mutation
    matrix in PR #2793 for the measurement, and PR #2811 for the fix.
    */
    const store = h.store();
    const taskId = await taskOnShiftedBoard(store, "wf-false-positive");

    await store.updateTask(taskId, { nodeId: "end" } as never);

    store.taskCache.delete(taskId);
    const row = await store.getTask(taskId);
    expect(row?.nodeId).toBe("end");
    expect(row?.column).toBe(RENAMED_VOCAB.review); // a routing change, not a finalize
  });

  it("an override to the REAL terminal node is REFUSED without merge proof", async () => {
    /*
    FIXED, and this is the half that matters more: it was the original FN-7641 bug restored on every
    custom board. `finish` IS this board's `end`-kind node, so the write must either finalize the card
    (with durable merge proof) or be refused. Before the fix neither guard recognised the id, so the
    field was written verbatim with no error and the card sat unadvanced — "no error and no
    advancement", exactly as the contract's comment describes the behaviour it replaced.

    Refusal is the correct outcome here because the fixture has no `mergeDetails.mergeConfirmed`.
    */
    const store = h.store();
    const taskId = await taskOnShiftedBoard(store, "wf-false-negative");

    await expect(store.updateTask(taskId, { nodeId: "finish" } as never))
      .rejects.toThrow(/does not finalize a card by itself|durable merge proof/);

    /* And the field was not written on the way to refusing. */
    store.taskCache.delete(taskId);
    const row = await store.getTask(taskId);
    expect(row?.nodeId).not.toBe("finish");
    expect(row?.column).toBe(RENAMED_VOCAB.review);
  });
});
