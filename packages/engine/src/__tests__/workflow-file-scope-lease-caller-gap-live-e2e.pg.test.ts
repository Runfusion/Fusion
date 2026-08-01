/*
FNXC:OverlapScheduling 2026-07-31-03:15 (E2E evidence — a SECOND inert-conversion mechanism, at the call site):

The previous five files in this series (#2789, #2791, #2792, #2793, #2794) all concern one mechanism:
a site resolves the workflow synchronously and silently gets the default board. This file is about a
different one, and neither the lifecycle-column census nor the sync-resolver allow-list can see it.

`shouldHoldActiveFileScopeLease` was converted by turning its two role questions into OPTIONAL
parameters with literal defaults:

    const isWipColumn    = options?.isWipColumn    ?? task.column === "in-progress";
    const isReviewColumn = options?.isReviewColumn ?? task.column === "in-review";

A caller that has resolved the column's traits passes the answer; a caller that has not gets exactly
the pre-conversion behaviour. That shape is a deliberate migration device and the source says so.

The migration was only half made. Of the four production call sites, as this file found them:

    scheduler.ts:1986   passes { isWipColumn: true }        -> converted
    scheduler.ts:2006   passes { isReviewColumn: true }     -> converted
    self-healing.ts:4525  passes NEITHER                    -> still the literals
    self-healing.ts:5443  passes NEITHER                    -> still the literals

So the same predicate was right on the scheduler's path and wrong on self-healing's, and the harm is
the one the function's own FNXC note describes: on a renamed board both branches fall through, the
predicate returns false for every card, `activeScopes` stays empty, and the dispatch path sees no
overlap — two agents editing the same files, which is what the overlap machinery exists to prevent.
At the self-healing sites the consequence is narrower but the same shape: a stale-lease reconciler
concludes a live blocker holds no lease and proceeds to clear state the scheduler would have honoured.

FNXC:OverlapScheduling 2026-07-30-23:30 (the alarm fired DOWNWARD — the seam is now 4-of-4):
#2975 converted both self-healing sites, and this file's last case failed on the advance that landed
it. That is the alarm working in the direction it was written for: the source-level case is a counter,
so it fails when someone CLOSES the gap as well as when someone widens it, and whoever closes it is
sent here to update the number deliberately.

Both sites now derive their answers from `resolveProjectColumnsForRoles(...)` sets the sweep had
already resolved a few lines above — trait membership, not a literal — so the conversion is real
rather than a call-shape that merely looks converted. The last case now asserts that FORM, not just
the presence of the two keys: a site that satisfied it by hardcoding `isWipColumn: true` would be the
same defect wearing the converted shape, and would restore exactly the pre-#2975 behaviour on any
board where the blocker is not actually in a wip column.

The three behavioural cases below are UNCHANGED and still meaningful: the optional parameters and
their literal defaults still exist, so the differential they drive is still the live behaviour of the
predicate for any future caller that omits them.

WHY THIS IS NOT VISIBLE TO THE EXISTING INSTRUMENTS. There is no column literal at the self-healing
call sites — the literal lives inside the callee's default, one function away. A census that counts
`=== "in-progress"` occurrences sees the callee's two (correctly marked DELIBERATE-LITERAL, since for
an unconverted caller they ARE the intended behaviour) and nothing at all at the call sites. The
conversion therefore reads as complete from every angle except running it.

SCOPE, STATED HONESTLY. The differential below is driven end to end: real persisted rows from a live
PostgreSQL store, the real exported predicate, both call shapes. The CALL-SITE fact — what the two
self-healing sites pass — is asserted against source text, not driven through the self-healing sweep,
which would need the full dependency-lease reconcile harness. That is a real limit and it is why the
last case reads the file rather than pretending otherwise. It doubles as the alarm, in both
directions: dropping an option fails it, and so does closing the gap.

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

  it("SOURCE-LEVEL — both self-healing call sites now pass both options, RESOLVED not hardcoded", async () => {
    /*
    NOT driven through the self-healing sweep, deliberately: reaching those sites needs the full
    dependency-lease reconcile harness. Asserted against source text instead, and labelled as such
    rather than dressed up as an end-to-end result.

    Updated on purpose when #2975 closed the gap and this case failed — see the header. The value
    check is the part that matters now: presence of the two keys alone would be satisfied by
    `isWipColumn: true`, which is the ORIGINAL defect wearing the converted call shape (it answers
    "yes" for a blocker resting anywhere, not just in a wip column). Requiring the answer to come from
    a resolved set keeps the assertion attached to the property that made the fix a fix.

    The scheduler's own sites DO pass literal `true`, correctly — they have already filtered to a
    role-resolved bucket, so the answer is a fact about the loop rather than about the card. The check
    below is scoped to `self-healing.ts` for exactly that reason.
    */
    const source = readFileSync(join(__dirname, "..", "self-healing.ts"), "utf8");

    const callSites = source.split("shouldHoldActiveFileScopeLease(").slice(1);
    expect(callSites.length).toBe(2);

    for (const site of callSites) {
      /* The options object literal ends at the first `})` that closes the call. Bounding the window
         keeps a later, unrelated `isWipColumn` in the file from reading as this site's argument. */
      const optionsWindow = site.slice(0, site.indexOf("})"));

      /* `<someSet>.has(<card>.column)` — membership in a set the sweep resolved by trait. Written as
         a shape rather than a fixed identifier so renaming the local set does not fail this. */
      expect(optionsWindow).toMatch(/isWipColumn:\s*\w+\.has\(\w+\.column\)/);
      expect(optionsWindow).toMatch(/isReviewColumn:\s*\w+\.has\(\w+\.column\)/);
    }
  });
});
