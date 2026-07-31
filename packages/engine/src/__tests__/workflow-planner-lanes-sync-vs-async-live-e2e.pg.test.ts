/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:05 (E2E evidence — `resolvePlannerLanes` vs its async twin):

`replan-target.ts` exports two functions with identical logic and identical fallbacks, differing only
in HOW they get the task's IR:

  resolvePlannerLanes(store, taskId)                 -> store.resolveTaskWorkflowIrSync(taskId)
  resolvePlannerLanesForTaskAsync(store, taskId)     -> await resolveWorkflowIrForTask(store, taskId)

Under PostgreSQL the sync selection reader answers `undefined` for every task, so the sync twin
resolves the DEFAULT workflow for every card no matter what board it is on. NINE production call
sites use it (two in `executor.ts`, seven in `triage.ts`); one uses the async twin.

That is already argued in the module's own doc comment and proven at the store level in
`core/.../postgres/sync-workflow-ir-is-always-default.pg.test.ts`. What had no executable evidence is
the CONSEQUENCE at this seam, against a real store with a real stored workflow — which is what this
file is. It is a pure differential: both twins, same store, same task, same call.

TWO DISTINCT HARMS, and they are not the same severity.

  1. WRONG LANES, REPORTED AS RIGHT. `resolvedFromWorkflow` exists precisely to tell a caller "these
     came from the workflow, not from the legacy fallback". The sync twin sets it `true` — an IR did
     come back — while handing over the DEFAULT board's ids. A caller branching on that flag is not merely
     given a wrong answer, it is given a wrong answer LABELLED AUTHORITATIVE, which is strictly worse
     than the `resolvedFromWorkflow: false` it would get from an unresolvable store.

  2. AN INVENTED FORWARD LANE. `wip`/`review`/`complete` are deliberately optional: PR #2628's review
     established that a missing role must stay `undefined` so the caller REFUSES, because
     substituting the legacy id makes it `moveTask(..., "in-progress")` into a column the board does
     not declare — rejected, and the card can be left half-moved. The sync twin defeats that contract
     without touching it: it never sees the real board, so it reports the DEFAULT board's forward
     lanes as present. The optionality is intact and unreachable.

WHY A CONTROL ARM. On the post-U11 default shape the two twins AGREE, because the answer the sync twin
always gives happens to be the right one there. That agreement is the reason this survived: every
default-board test passes, and only a renamed board separates them.

Note which shape that is. The sync twin's constant answer is the DEFAULT BUILTIN IR, whose intake and
hold are ONE merged `todo` lane after U11 — NOT the split `todo`/`triage` pair the module's own
`LEGACY_PLANNER_LANES` constant names. That constant is reached only when no IR resolves at all, which
under PostgreSQL is never. So "it falls back to the legacy lanes" is the wrong mental model twice over:
the fallback is unreachable, and the value actually returned is the merged default.

OBSERVED STATE. These are pure exported functions over a live store, so the observation is their
return value against a persisted workflow definition — no spies, and no mock IR anywhere in this
file. Note the contrast with the unit coverage in `planner-lanes-async-resolution.test.ts`, which
must supply a mock `resolveTaskWorkflowIrSync` and therefore cannot see this divergence at all.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { resolvePlannerLanes, resolvePlannerLanesForTaskAsync } from "../replan-target.js";
import { MERGED_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("planner lanes: the sync twin against the async twin, on a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_planner_twins",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** Persist a real workflow definition and a task bound to it.
   *
   *  `createWorkflowDefinition` allocates its OWN id and ignores one passed in, so the task binds to
   *  the id the STORE returned. Binding to the requested id instead silently resolves the default
   *  builtin IR — a renamed-workflow fixture that passes while testing nothing. */
  async function taskOn(
    store: TaskStore,
    v: Vocabulary,
    key: string,
    shape: { mergeOrchestration?: boolean } = {},
  ): Promise<string> {
    const created = await store.createWorkflowDefinition({
      name: `Twins ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`, shape),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `twin probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    return task.id;
  }

  it("CONTROL — on the post-U11 DEFAULT shape the two twins agree, which is why this hid", async () => {
    /*
    MERGED_VOCAB, not DEFAULT_VOCAB. The sync twin's constant answer is the DEFAULT BUILTIN IR, and
    after U11 that board has no `triage` column at all — intake and hold are one merged Planning lane
    with id `todo`. So the shape the twins agree on is the MERGED one; `DEFAULT_VOCAB`, which splits
    intake out as `triage`, already separates them.

    Worth stating because the module's own fallback constant still names the split legacy pair
    (`hold: "todo", intake: "triage"`). That constant is NOT what the sync twin returns here — it is
    only reached when no IR resolves at all. What a caller actually gets is the merged default.
    */
    const store = h.store();
    /* `mergeOrchestration` because `resolveLifecycleColumns().review` is derived from the
       `mergeOrchestration` flag, not from `human-review`. Without the trait the fixture's review
       column resolves to NO review lane, and the twins would differ on `review` for a reason that
       belongs to the fixture rather than to the subject. (That divergence is real and is asserted
       on its own terms in the last case below, where it is the point rather than noise.) */
    const taskId = await taskOn(store, MERGED_VOCAB, "wf-merged-twins", { mergeOrchestration: true });

    const sync = resolvePlannerLanes(store, taskId);
    const async_ = await resolvePlannerLanesForTaskAsync(store, taskId);

    expect(sync).toEqual(async_);
    expect(async_.hold).toBe(MERGED_VOCAB.hold);
    expect(async_.intake).toBe(MERGED_VOCAB.intake);
  });

  it("CHARACTERIZATION — on a RENAMED board the sync twin returns the DEFAULT-WORKFLOW lanes", async () => {
    /*
    The async twin resolves the board the card is actually on. The sync twin answers with the ids of
    a board this task has nothing to do with — and every one of the nine production call sites is on
    the sync side.
    */
    const store = h.store();
    const taskId = await taskOn(store, RENAMED_VOCAB, "wf-renamed-twins", { mergeOrchestration: true });

    const sync = resolvePlannerLanes(store, taskId);
    const async_ = await resolvePlannerLanesForTaskAsync(store, taskId);

    // What the card's own workflow says.
    expect(async_.hold).toBe(RENAMED_VOCAB.hold);
    expect(async_.intake).toBe(RENAMED_VOCAB.intake);
    expect(async_.wip).toBe(RENAMED_VOCAB.wip);
    expect(async_.review).toBe(RENAMED_VOCAB.review);
    expect(async_.complete).toBe(RENAMED_VOCAB.complete);

    /* What the sync twin says instead: the DEFAULT builtin board's ids, none of which this board
       declares. Both lanes read `todo` because that board merged them in U11 — so a caller reading
       `intake` gets not just the wrong id but a lane that is not a dedicated intake at all. */
    expect(sync.hold).toBe("todo");
    expect(sync.intake).toBe("todo");
    expect(sync.hold).not.toBe(async_.hold);
    expect(sync.intake).not.toBe(async_.intake);
  });

  it("CHARACTERIZATION — and it labels those default-workflow lanes `resolvedFromWorkflow: true`", async () => {
    /*
    The sharpest half. `resolvedFromWorkflow: false` would be honest — "no basis to decide, the
    fallback names ARE the answer". `true` tells the caller the opposite of the truth, so a caller
    that correctly checks the flag before trusting the lanes is misled precisely by checking it.

    (Named DEFAULT-WORKFLOW rather than LEGACY throughout, per review: these are the merged builtin
    default's ids, and `LEGACY_PLANNER_LANES` is a different shape that is never reached here. The
    header already made that distinction; the case titles contradicted it.)
    */
    const store = h.store();
    const taskId = await taskOn(store, RENAMED_VOCAB, "wf-renamed-flag");

    expect(resolvePlannerLanes(store, taskId).resolvedFromWorkflow).toBe(true);
  });

  it("CHARACTERIZATION — the forward lanes come back populated from the WRONG board", async () => {
    /*
    `wip`/`review`/`complete` are optional so a caller REFUSES rather than moving a card into a
    column the board does not declare. Here every one is populated — with the default board's ids —
    so a caller that dutifully checks `if (!lanes.wip) return` sails straight through and attempts
    `moveTask(..., "in-progress")` on a board whose WIP column is `building`.

    Asserting the wrong-but-current values deliberately; when the call sites move to the async twin
    these become the RENAMED ids and this test is what says the behaviour moved.
    */
    const store = h.store();
    const taskId = await taskOn(store, RENAMED_VOCAB, "wf-renamed-forward", { mergeOrchestration: true });

    const sync = resolvePlannerLanes(store, taskId);

    expect(sync.wip).toBe("in-progress");
    expect(sync.review).toBe("in-review");
    expect(sync.complete).toBe("done");
    expect(sync.wip).not.toBe(RENAMED_VOCAB.wip);
    /* `intake` is the arm's only DISTINGUISHING field, and it is here on purpose. The three lanes
       above are identical in the merged default IR and in `LEGACY_PLANNER_LANES`, so without this
       the case passes either way — it would prove the lanes are wrong without proving WHY, and a
       mutation replacing the whole body with the legacy constant survives it. `todo` (merged) vs
       `triage` (legacy) is what separates "resolved the wrong board" from "took the fallback". */
    expect(sync.intake).toBe("todo");
  });

  it("CHARACTERIZATION — a board that declares NO review lane is still handed one", async () => {
    /*
    The optional-role contract at its sharpest, and the cleanest statement of harm #2. This board
    carries `human-review` but no merge orchestration, so it declares no review lane in the sense
    `resolveLifecycleColumns` means — and the async twin says so, returning `undefined`, which is the
    answer that makes a caller refuse.

    The sync twin returns `"in-review"`. Not a renamed column, not a stale one: a column this board
    does not contain in any form. The optionality PR #2628's review argued for is fully intact in the
    type and fully unreachable through the twin nine call sites use.
    */
    const store = h.store();
    const taskId = await taskOn(store, RENAMED_VOCAB, "wf-no-review-lane");

    expect((await resolvePlannerLanesForTaskAsync(store, taskId)).review).toBeUndefined();

    const sync = resolvePlannerLanes(store, taskId);
    expect(sync.review).toBe("in-review");
    /* Same reason as the case above: pins that this came from the merged default IR rather than
       from the legacy fallback constant, which also carries `review: "in-review"`. */
    expect(sync.intake).toBe("todo");
  });
});
