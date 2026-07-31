/*
FNXC:OverlapScheduling 2026-07-30-03:15 (E2E evidence — a SECOND inert-conversion mechanism, at the call site):

The previous five files in this series (#2789, #2791, #2792, #2793, #2794) all concern one mechanism:
a site resolves the workflow synchronously and silently gets the default board. This file is about a
different one, and neither the lifecycle-column census nor the sync-resolver allow-list can see it.

`shouldHoldActiveFileScopeLease` was converted by turning its two role questions into OPTIONAL
parameters with literal defaults:

    const isWipColumn    = options?.isWipColumn    ?? task.column === "in-progress";
    const isReviewColumn = options?.isReviewColumn ?? task.column === "in-review";

A caller that has resolved the column's traits passes the answer; a caller that has not gets exactly
the pre-conversion behaviour. That shape is a deliberate migration device and the source says so.

But the migration was only half made. Of the four production call sites:

    scheduler.ts:1986   passes { isWipColumn: true }        -> converted
    scheduler.ts:2006   passes { isReviewColumn: true }     -> converted
    self-healing.ts:4525  passes NEITHER                    -> still the literals
    self-healing.ts:5443  passes NEITHER                    -> still the literals

So the same predicate is right on the scheduler's path and wrong on self-healing's, and the harm is
the one the function's own FNXC note describes: on a renamed board both branches fall through, the
predicate returns false for every card, `activeScopes` stays empty, and the dispatch path sees no
overlap — two agents editing the same files, which is what the overlap machinery exists to prevent.
At the self-healing sites the consequence is narrower but the same shape: a stale-lease reconciler
concludes a live blocker holds no lease and proceeds to clear state the scheduler would have honoured.

WHY THIS IS NOT VISIBLE TO THE EXISTING INSTRUMENTS. There is no column literal at the self-healing
call sites — the literal lives inside the callee's default, one function away. A census that counts
`=== "in-progress"` occurrences sees the callee's two (correctly marked DELIBERATE-LITERAL, since for
an unconverted caller they ARE the intended behaviour) and nothing at all at the call sites. The
conversion therefore reads as complete from every angle except running it.

SCOPE, STATED HONESTLY. The differential below is driven end to end: real persisted rows from a live
PostgreSQL store, the real exported predicate, both call shapes. The CALL-SITE fact — that the two
self-healing sites pass neither option — is asserted against source text, not driven through the
self-healing sweep, which would need the full dependency-lease reconcile harness. That is a real limit
and it is why the last case reads the file rather than pretending otherwise. It doubles as the alarm:
when someone converts those call sites, that case fails and points at this file.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { shouldHoldActiveFileScopeLease } from "../scheduler.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("file-scope lease: the converted call site against the unconverted one", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lease_gap",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A real persisted card parked in its workflow's WIP column, with a worktree and no unmet
   *  dependencies — i.e. a card that genuinely holds an active lease. */
  async function wipCard(store: TaskStore, v: Vocabulary, key: string): Promise<Task> {
    const created = await store.createWorkflowDefinition({
      name: `Lease ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `lease probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.updateTask(task.id, { worktree: `/tmp/does-not-need-to-exist/${key}` });
    await store.moveTask(task.id, v.wip as never, { recoveryRehome: true } as never);

    store.taskCache.delete(task.id);
    const row = await store.getTask(task.id);
    if (!row) throw new Error("fixture: card not persisted");
    return row;
  }

  it("CONTROL — on the DEFAULT board the unconverted call shape is CORRECT", async () => {
    /*
    The literal defaults are not a bug in themselves: for a card in `in-progress` they give the right
    answer, which is exactly why the optional-parameter shape was chosen and why the omission at the
    self-healing sites went unnoticed.
    */
    const store = h.store();
    const card = await wipCard(store, DEFAULT_VOCAB, "wf-default-lease");

    expect(card.column).toBe(DEFAULT_VOCAB.wip); // ...which is literally "in-progress"
    expect(shouldHoldActiveFileScopeLease(card, [card])).toBe(true);
  });

  it("CHARACTERIZATION — on a RENAMED board the unconverted call shape says NO LEASE", async () => {
    /*
    Same predicate, same card, no resolved answers supplied — the self-healing call shape. Both
    branches fall through and a card actively holding a worktree is reported as holding no lease.
    */
    const store = h.store();
    const card = await wipCard(store, RENAMED_VOCAB, "wf-renamed-lease");

    expect(card.column).toBe(RENAMED_VOCAB.wip);
    expect(shouldHoldActiveFileScopeLease(card, [card])).toBe(false);
  });

  it("BOUND — the SAME card holds the lease once the resolved answer is passed", async () => {
    /*
    The differential that attributes the failure above to the call shape and nothing else: identical
    card, identical predicate, one extra argument. This is what the two scheduler call sites do and
    the two self-healing call sites do not.
    */
    const store = h.store();
    const card = await wipCard(store, RENAMED_VOCAB, "wf-renamed-resolved");

    expect(shouldHoldActiveFileScopeLease(card, [card], { isWipColumn: true })).toBe(true);
  });

  it("SOURCE-LEVEL — the two self-healing call sites still pass neither option", async () => {
    /*
    NOT driven through the self-healing sweep, deliberately: reaching those sites needs the full
    dependency-lease reconcile harness. Asserted against source text instead, and labelled as such
    rather than dressed up as an end-to-end result.

    Its job is to be an alarm. When those call sites are converted this fails, and whoever converted
    them is pointed at the three cases above, which describe what changes.
    */
    const source = readFileSync(join(__dirname, "..", "self-healing.ts"), "utf8");

    const callSites = source.split("shouldHoldActiveFileScopeLease(").slice(1);
    expect(callSites.length).toBe(2);

    for (const site of callSites) {
      /* The options object literal ends at the first `})` that closes the call. Bounding the window
         keeps a later, unrelated `isWipColumn` in the file from masking an omission here. */
      const optionsWindow = site.slice(0, site.indexOf("})"));
      expect(optionsWindow).not.toContain("isWipColumn");
      expect(optionsWindow).not.toContain("isReviewColumn");
    }
  });
});
