/*
FNXC:WorkflowLifecycleColumns 2026-07-28-15:10 (E2E — closing the live-agent-count ledger entry):

`live-agent-count.ts` classifies a card's column into the four traits the running/
waiting predicates read, and `persistedTopLevelAgentSlotsFromStore` turns that into
THE NUMBER ADMISSION CONTROL COMPARES AGAINST THE CAP
(`computeTopLevelConcurrencyClaimed`). So a mis-classified column is not a display
bug — it is a scheduler bug, and it fails in whichever direction hurts:

  a wip column not recognised as wip   -> the board under-counts and OVER-ADMITS,
                                          running more agents than the operator capped
  a complete column not recognised     -> a finished card counts forever and the
                                          board silently stalls at the cap

Both are the same failure this program keeps finding — silent, no error, no failing
test — and both land on a renamed board only, which is why nothing had caught them.

WHAT IS REAL. A PostgreSQL TaskStore, real persisted workflow definitions, real
tasks moved through the real transition policy, and the real
`persistedTopLevelAgentSlotsFromStore` resolving each card's IR from the store.
Nothing about the counting is reimplemented here — the assertion is the number the
scheduler would actually use.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { Task } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { persistedTopLevelAgentSlotsFromStore } from "../concurrency.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live agent-count E2E: what the cap is actually compared against", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_count_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedWorkflow(v: Vocabulary, key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Agent count ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    return (created as { id: string }).id;
  }

  /** Walk a card to `target` through the REAL transition policy, so the row is one a
   *  real run could produce rather than a hand-written column value. */
  async function seedTaskAt(taskId: string, v: Vocabulary, workflowId: string, target: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `count ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    if (target === v.hold) {
      store.taskCache.delete(taskId);
      return;
    }
    await store.moveTask(taskId, v.wip, { moveSource: "user" } as never);
    if (target !== v.wip) {
      await store.moveTask(taskId, v.review, { moveSource: "user", allowDirectInReviewMove: true } as never);
    }
    if (target === v.complete) {
      await store.moveTask(taskId, v.complete, { moveSource: "engine", skipMergeBlocker: true } as never);
    }
    store.taskCache.delete(taskId);
  }

  /** The number admission control would compare against the cap, computed the way it
   *  computes it: through the store, resolving each card's own workflow. */
  async function claimedSlots(): Promise<number> {
    const store = h.store();
    const tasks = (await store.listTasks({ includeArchived: false })) as Task[];
    return persistedTopLevelAgentSlotsFromStore(store as never, tasks);
  }

  describe.each([
    { label: "RENAMED vocabulary", vocab: RENAMED_VOCAB, key: "renamed" },
    { label: "DEFAULT vocabulary (regression floor)", vocab: DEFAULT_VOCAB, key: "default" },
  ])("$label", ({ vocab, key }) => {
    it("counts a card in the WIP column as a claimed slot", async () => {
      const workflowId = await seedWorkflow(vocab, `${key}-wip`);
      await seedTaskAt(`FN-AC-${key}-1`, vocab, workflowId, vocab.wip);

      expect(await claimedSlots()).toBe(1);
    });

    it("does NOT count a card in the COMPLETE column — a finished card must release its slot", async () => {
      /* The direction that silently stalls a board: if the terminal column is not
         recognised, every completed card keeps consuming capacity forever. */
      const workflowId = await seedWorkflow(vocab, `${key}-complete`);
      await seedTaskAt(`FN-AC-${key}-2`, vocab, workflowId, vocab.complete);

      expect(await claimedSlots()).toBe(0);
    });

    it("does NOT count a COMPLETE card that still carries a live-looking status", async () => {
      /*
      THE CASE THAT ACTUALLY TESTS THE TERMINAL CLASSIFICATION. The plain
      complete-column case above cannot: `isRunningAgentTask` rejects that card at the
      wip check anyway, so it stays at 0 even with the terminal classification keyed
      on the literal `done` (verified by mutation — every other case here stayed green).

      `terminalKind` is checked FIRST and short-circuits, so it only changes the answer
      for a card whose status would otherwise make it count. `status: "planning"`
      returns true immediately after that check. A finished card carrying a stale
      status is exactly the state a crashed or interrupted run leaves behind — and on a
      renamed board it would then consume a slot forever, which is the silent stall
      this file is about.
      */
      const workflowId = await seedWorkflow(vocab, `${key}-terminal`);
      const taskId = `FN-AC-${key}-7`;
      await seedTaskAt(taskId, vocab, workflowId, vocab.complete);
      await h.store().updateTask(taskId, { status: "planning" } as never);
      h.store().taskCache.delete(taskId);
      // Prove the fixture took: without the status this case degrades into the weaker
      // one above and would pass for the wrong reason.
      expect((await h.store().getTask(taskId)).status).toBe("planning");

      expect(await claimedSlots()).toBe(0);
    });

    it("DOES count a card mid-review with an active merge-pipeline status", async () => {
      /*
      The third classification, and the other over-admission direction. A review
      status is deliberately NOT globally live — a stale `fixing` in an intake or wip
      column must not consume capacity — so `isRunningAgentTask` gates it on
      `columnIsReviewOrMerge`. If the review lane is not recognised on a renamed
      board, a genuinely-active reviewer stops counting and admission control lets
      another agent in over the cap.
      */
      const workflowId = await seedWorkflow(vocab, `${key}-review`);
      const taskId = `FN-AC-${key}-8`;
      await seedTaskAt(taskId, vocab, workflowId, vocab.review);
      await h.store().updateTask(taskId, { status: "fixing" } as never);
      h.store().taskCache.delete(taskId);
      expect((await h.store().getTask(taskId)).status).toBe("fixing");

      expect(await claimedSlots()).toBe(1);
    });

    it("does NOT count a card waiting in the HOLD column", async () => {
      const workflowId = await seedWorkflow(vocab, `${key}-hold`);
      await seedTaskAt(`FN-AC-${key}-3`, vocab, workflowId, vocab.hold);

      expect(await claimedSlots()).toBe(0);
    });

    it("counts exactly the WIP cards across a mixed board", async () => {
      /* The number that actually matters: with one card in each lane, admission
         control must see exactly one claimed slot. Over-counting stalls the board;
         under-counting over-admits past the operator's cap. */
      const workflowId = await seedWorkflow(vocab, `${key}-mixed`);
      await seedTaskAt(`FN-AC-${key}-4`, vocab, workflowId, vocab.hold);
      await seedTaskAt(`FN-AC-${key}-5`, vocab, workflowId, vocab.wip);
      await seedTaskAt(`FN-AC-${key}-6`, vocab, workflowId, vocab.complete);

      expect(await claimedSlots()).toBe(1);
    });
  });

  it("counts a RENAMED board identically to the default one — same shape, different ids", async () => {
    /* The differential, run in one process against one store: two boards with the
       same lane occupancy must claim the same number of slots. A classifier keyed on
       legacy ids returns a different number for the renamed board, and the two counts
       diverge here even though every other assertion in this file could still pass. */
    const renamedWf = await seedWorkflow(RENAMED_VOCAB, "diff-renamed");
    await seedTaskAt("FN-AC-D1", RENAMED_VOCAB, renamedWf, RENAMED_VOCAB.wip);
    await seedTaskAt("FN-AC-D2", RENAMED_VOCAB, renamedWf, RENAMED_VOCAB.complete);
    const renamedOnly = await claimedSlots();

    const defaultWf = await seedWorkflow(DEFAULT_VOCAB, "diff-default");
    await seedTaskAt("FN-AC-D3", DEFAULT_VOCAB, defaultWf, DEFAULT_VOCAB.wip);
    await seedTaskAt("FN-AC-D4", DEFAULT_VOCAB, defaultWf, DEFAULT_VOCAB.complete);
    const both = await claimedSlots();

    expect(renamedOnly).toBe(1);
    // The default board added exactly one more claimed slot, not two and not zero.
    expect(both - renamedOnly).toBe(1);
  });
});
