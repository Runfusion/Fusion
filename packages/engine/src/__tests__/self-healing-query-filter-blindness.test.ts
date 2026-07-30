/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:25 (batch-engine tail — the query-filter gap, made non-theoretical):

THIS TEST PINS A KNOWN DEFECT. It asserts what the engine does TODAY, which is the wrong thing, and it
exists so the defect stops being invisible. See
`docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md`.

THE DEFECT. `self-healing.ts` makes 49 calls of the shape
`this.store.listTasks({ column: "<literal>", … })`. `listTasks`' option is `column?: ColumnId` — ONE
literal column, applied as a filter in the store. On a workflow whose lanes are renamed, every one of
those queries returns an EMPTY array, so the sweep it feeds does nothing at all. The sweeps are not
mostly-correct-with-some-unconverted-guards; they never execute.

WHY THIS ASSERTS THE QUERY AND NOT THE OUTCOME. The outcome is the same either way (the sweep returns
0), so an outcome assertion cannot distinguish "did nothing because there was nothing to do" from "did
nothing because it asked the wrong question". The QUERY ARGUMENT is where the defect actually lives, and
it is observable without standing up the git evidence path these sweeps run once they have candidates.

WHY THE SUITE CANNOT SEE IT. Measured across `self-healing*.test.ts`: 30 files define a `listTasks` on
their store fake and 17 IGNORE the `column` option, returning every seeded task regardless of what the
sweep asked for. Those fakes are MORE PERMISSIVE than production, so the sweep under test receives rows
the real query would have filtered out. They prove the sweep's logic while saying nothing about whether
the sweep is ever reached — the mirror image of
`store-fake-defects-that-masquerade-as-production-bugs.md`.

WHEN THE QUERY LAYER IS FIXED this test will fail, because the sweeps will stop asking for the bare
legacy literal. That is the intent — it is a ratchet on a known gap, not an endorsement of it. Rewrite
the expectations against the new query shape at that point and delete this note.

The fix is NOT a literal conversion: `column?: ColumnId` takes one id, and resolution is circular at the
query layer (you need a task to know its workflow, and you are querying to find the tasks). It needs a
multi-column query option plus a resolved union across live workflows — a shared-store-API change across
49 call sites, which is a coordinator-level call.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { resolveLifecycleColumns } from "@fusion/core";

vi.mock("../run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { SelfHealingManager } from "../self-healing.js";
import { executingTaskLock } from "../active-session-registry.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

const RENAMED_IR = lifecycleIr(RENAMED_VOCAB, "self-healing-lifecycle", { mergeOrchestration: true });

/**
 * A store fake that HONORS `options.column`, exactly as the real store does.
 *
 * That one line is the whole point of this file: the 17 self-healing fakes that drop the option on the
 * floor are what keep this class invisible.
 */
function productionFaithfulStore(tasks: Task[]) {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  const listTasks = vi.fn(async (options?: { column?: string; limit?: number; offset?: number }) => {
    let all = [...tasksById.values()];
    if (options?.column !== undefined) all = all.filter((entry) => entry.column === options.column);
    const offset = options?.offset ?? 0;
    return all.slice(offset, offset + (options?.limit ?? all.length));
  });
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
    listTasks,
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "self-healing-lifecycle", stepIds: [] })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "self-healing-lifecycle", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "self-healing-lifecycle" ? { ir: RENAMED_IR } : undefined)),
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:50 (the fix landed; this fake had to grow to see it):
    `resolveProjectColumnsForRoles` — the seam the sweeps now use — reads `listWorkflowDefinitions()`,
    the PROJECT's workflows, because a query runs before any task is in hand. Without this method the
    helper degrades to the legacy ids and the sweep still queries only `done`, so this file kept passing
    against the FIXED code and reported nothing. A ratchet whose fake cannot reach the new seam stops
    being a ratchet silently.
    */
    listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
  }) as unknown as TaskStore & EventEmitter;
  return { store, listTasks };
}

function shippedCard(): Task {
  return {
    id: "FN-BLIND",
    title: "landed, but its merge evidence needs reconciling",
    description: "",
    column: RENAMED_VOCAB.complete,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    modifiedFiles: ["packages/engine/src/x.ts"],
    mergeDetails: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

describe("self-healing sweeps are bounded by a hardcoded column QUERY, not by their predicates", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => executingTaskLock._clearForTest());

  it("the fixture's renamed board genuinely resolves a complete lane that is not `done`", async () => {
    /*
    Guard on the guard. If this ever stopped holding, every assertion below would pass vacuously — the
    renamed board would BE the default board and the differential would mean nothing.
    */
    const lifecycle = resolveLifecycleColumns(RENAMED_IR);
    expect(lifecycle?.complete).toBe(RENAMED_VOCAB.complete);
    expect(lifecycle?.complete).not.toBe("done");
  });

  it("the done-integrity sweep now asks for the board's OWN complete lane (was: KNOWN DEFECT)", async () => {
    /*
    `reconcileDoneTaskIntegrity` opens with `listTasks({ column: "done", slim: true })` and then
    re-asserts `task.column === "done"` on the rows it gets back. The census counts that re-assertion;
    converting it would drop a count and change nothing, because the list was already empty.

    The card below HAS landed and HAS modified files with no recorded commit sha — exactly the state the
    sweep exists to repair. It sits in `shipped`, so the store returns no rows and the repair never runs.
    */
    const { store, listTasks } = productionFaithfulStore([shippedCard()]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.reconcileDoneTaskIntegrity();

    /*
    THE ASSERTION THIS FILE WAS BUILT TO FLIP. It used to read `not.toHaveBeenCalledWith(… complete)`
    and passed because the sweep only ever asked for the literal. The sweep now resolves the project's
    complete lanes and queries each, so the renamed lane IS asked for.

    `done` is STILL expected: `resolveProjectColumnsForRoles` unions the legacy ids deliberately, so a
    board mid-rename whose rows are still stored under the old id is not skipped. Over-inclusion costs
    one extra query the caller then filters; under-inclusion is invisible.
    */
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.complete }));
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: "done" }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:05 (#2838 review — greptile P1):

  A CARD WHOSE WORKFLOW CANNOT BE RESOLVED MUST NOT BE MISTAKEN FOR ONE THAT ANSWERED.

  `resolveWorkflowIrForTask` does not throw when a task's selection is unresolvable — it SUBSTITUTES
  the built-in coding IR, whose complete lane is `done`. The candidate filter therefore saw a non-empty
  `columnsWithFlag(ir, "complete")` and treated the built-in vocabulary as this card's own answer, so a
  renamed-lane card was rejected on every sweep and its missing merge evidence stayed unrepaired
  forever. The provenance form separates the two, and only a real selection counts as an answer.

  WHY THE STORE FAKE DROPS ONLY THE SELECTION READERS. That is precisely the production shape being
  modelled: the workflow DEFINITION is fine, the card's link to it is what cannot be read. Deleting the
  definition instead would take a different branch and prove nothing about this one.
  */
  it("a card whose workflow selection cannot be resolved is not judged by the BUILT-IN complete lane", async () => {
    const { store } = productionFaithfulStore([shippedCard()]);
    /* No selection for this card: `resolveWorkflowIrForTaskWithProvenance` reports source "default". */
    (store as unknown as { getTaskWorkflowSelectionAsync: unknown }).getTaskWorkflowSelectionAsync =
      vi.fn(async () => undefined);
    (store as unknown as { getTaskWorkflowSelection: unknown }).getTaskWorkflowSelection = vi.fn(() => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let warned = "";
    try {
      await manager.reconcileDoneTaskIntegrity();
    } finally {
      /* Read BEFORE restoring: `mockRestore` clears the recorded calls, so reading afterwards yields
         an empty string and the assertion fails for a reason that has nothing to do with the code. */
      warned = warn.mock.calls.map((call) => String(call[0])).join("\n");
      warn.mockRestore();
    }

    /*
    The observable claim: the card is REPORTED as unresolvable rather than silently discarded. The
    verdict itself is deliberately unchanged — a sweep that WRITES merge evidence must not guess a lane
    — so asserting "it got repaired" would be asserting the wrong fix. What must not survive is the
    silence, which is what made this unrepairable-forever instead of merely unrepaired.
    */
    expect(warned).toContain("done-task integrity sweep");
    expect(warned).toContain("FN-BLIND");
  });

  it("proves the fake is what hides it: an ignoring `listTasks` hands the sweep rows production would not", async () => {
    /*
    The control, and the reason a green self-healing suite is not evidence that self-healing runs. This
    fake is the shape 17 of the 30 self-healing suites use — it drops `options.column` on the floor, so
    the renamed-board card comes back from a query that asked for `done`.

    Asserted on the RETURNED ROWS rather than on the sweep, so this stays true regardless of what the
    sweep does with them.
    */
    const card = shippedCard();
    /* The 17-fake shape: the option is declared so the call is realistic, and then never read. */
    const permissiveList = vi.fn(async (_options?: { column?: string }) => [card]);

    /* Asked for `done` — exactly what the sweep asks — and got back a card in `shipped`. */
    const rows = await permissiveList({ column: "done" });

    expect(permissiveList).toHaveBeenCalledWith({ column: "done" });
    expect(rows).toHaveLength(1);
    expect(rows[0].column).toBe(RENAMED_VOCAB.complete);
    expect(rows[0].column).not.toBe("done");

    /* The contrast that makes the point: the production-faithful fake, asked the same question,
       returns nothing. Same card, same query, opposite answer — the fake IS the hiding mechanism. */
    const { store } = productionFaithfulStore([card]);
    expect(await store.listTasks({ column: "done" as never })).toHaveLength(0);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:20 (#2838 review — greptile P1):
  THE PROJECT UNION IS FOR THE QUERY, NEVER FOR THE PER-CARD VERDICT.

  Two boards in one project: board A calls its COMPLETE lane `shipped`; board B calls its WIP lane
  `shipped`. The project union therefore contains `shipped`, which is correct for the READ — board A's
  finished cards must be found. Using that same set as the per-card test claims board B's card as
  complete because SOME OTHER workflow calls that column complete, and this sweep WRITES merge evidence
  onto whatever it accepts.

  Widening the read and widening the verdict are different decisions: a missed row is invisible, a wrong
  row is a write.

  REVERT CHECK, measured: re-asserting `completeColumns.has(task.column)` instead of resolving each card
  against its own workflow fails this case — the mid-implementation card is reconciled.
  */
  it("does not claim a card whose OWN workflow calls its column WIP, even when another board calls it complete", async () => {
    const boardB = {
      version: "v2", id: "board-b", name: "board b",
      columns: [
        { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        /* Same id as board A's COMPLETE lane, but here it is WIP. */
        { id: "shipped", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "closed", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "planning" }],
      edges: [],
    } as unknown as WorkflowIr;

    const midImplementation = { ...shippedCard(), id: "FN-WIP" } as Task;
    const tasksById = new Map([[midImplementation.id, midImplementation]]);
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
      listTasks: vi.fn(async (options?: { column?: string }) => {
        const all = [...tasksById.values()];
        return options?.column === undefined ? all : all.filter((t) => t.column === options.column);
      }),
      getTask: vi.fn(async (id: string) => tasksById.get(id)),
      updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
        tasksById.set(id, { ...tasksById.get(id)!, ...patch } as Task);
        return tasksById.get(id)!;
      }),
      /* The PROJECT declares both boards, so `shipped` is legitimately in the union. */
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }, { ir: boardB }]),
      /* But THIS card belongs to board B, where `shipped` is WIP. */
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "board-b", stepIds: [] })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "board-b", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "board-b" ? { ir: boardB } : { ir: RENAMED_IR })),
    }) as unknown as TaskStore & EventEmitter;

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    await manager.reconcileDoneTaskIntegrity();

    /*
    ASSERTS CANDIDACY, not the write. My first version asserted `commitSha` stayed undefined, which is
    true either way here — the write needs a real git repo, so it never happens in this fixture and the
    assertion could not distinguish accepted from rejected. The revert passed and exposed it.

    `reconcileDoneTaskIntegrity` returns BEFORE `getSettings()` when the candidate list is empty
    (`if (candidates.length === 0) return 0;`), so that call is the observable proof that this card was
    NOT accepted as complete.
    */
    expect(store.getSettings).not.toHaveBeenCalled();
    expect((await store.getTask("FN-WIP"))?.mergeDetails?.commitSha).toBeUndefined();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:50 (#2838 review — greptile P1, second round):
  THE GUESSED-WORKFLOW PATH. `resolveWorkflowIrForTask` returns the BUILT-IN IR when a task names no
  workflow, and the built-in complete lane IS `done` — so a naive `columnsWithFlag(ir, "complete")`
  yields `["done"]` for a card we could not resolve, the legacy branch never fires, and the card is
  rejected on every sweep forever.

  Resolution now goes through `...WithProvenance`, so only `source: "selection"` overrules the legacy
  check. A card that DOES name a workflow keeps being judged by it; a card that does not falls back to
  the legacy id rather than to the built-in board's vocabulary wearing a resolved disguise.

  REVERT CHECK, measured: resolving without provenance fails this case — `ownComplete` becomes `["done"]`
  from the built-in default, so the card in `done` with no selection is REJECTED and `getSettings` is
  never reached.
  */
  it("still repairs a legacy `done` card whose workflow selection is missing", async () => {
    const legacyCard = { ...shippedCard(), id: "FN-LEGACY", column: "done" } as Task;
    const tasksById = new Map([[legacyCard.id, legacyCard]]);
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
      listTasks: vi.fn(async (options?: { column?: string }) => {
        const all = [...tasksById.values()];
        return options?.column === undefined ? all : all.filter((t) => t.column === options.column);
      }),
      getTask: vi.fn(async (id: string) => tasksById.get(id)),
      updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
        tasksById.set(id, { ...tasksById.get(id)!, ...patch } as Task);
        return tasksById.get(id)!;
      }),
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
      /* NO selection for this card — the state that makes the resolver guess. */
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
    }) as unknown as TaskStore & EventEmitter;

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    await manager.reconcileDoneTaskIntegrity();

    /* Accepted as a candidate: the sweep reached `getSettings`, which it only does with a non-empty list. */
    expect(store.getSettings).toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:20 (the query-filter class, second sweep):
  `recoverAlreadyMergedReviewTasks` rescues a card whose merge ACTUALLY SUCCEEDED but is parked in review
  with `status: "failed"`. Its read was `listTasks({ column: "in-review" })`, which returns nothing on a
  renamed board — so the rescue never ran and that card stayed stuck permanently.

  Asserts the QUERY, like the done-integrity case above and for the same reason: the outcome is 0 either
  way, so only the question asked distinguishes fixed from broken. The per-card verdict uses the pattern
  already revert-proven for the other sweep.

  REVERT CHECK, measured: restoring `listTasks({ column: "in-review" })` fails this — the board's own
  review lane is never asked for.
  */
  it("the already-merged rescue asks for the board's OWN review lane", async () => {
    const parked = {
      ...shippedCard(),
      id: "FN-STUCK",
      column: RENAMED_VOCAB.review,
      status: "failed",
      mergeRetries: 99,
    } as unknown as Task;
    const { store, listTasks } = productionFaithfulStore([parked]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverAlreadyMergedReviewTasks();

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.review }));
    /* The legacy id is still asked for — the project union keeps mid-rename rows reachable. */
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: "in-review" }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:50 (#2838 review — greptile P1, same class as the
  done-integrity sweep):
  I wrote this sweep before the provenance fix landed on its sibling and reproduced the pre-fix shape
  verbatim: `resolveWorkflowIrForTask` SUBSTITUTES the built-in IR rather than failing, so a card whose
  workflow could not be resolved was measured against the built-in `in-review`, rejected, and rejected
  again on every pass — with nothing recorded.

  The verdict stays conservative (this sweep mutates column AND status). What provenance buys is that the
  unrescued card is REPORTED, which is the whole difference between a known gap and an invisible one.

  REVERT CHECK, measured: resolving without provenance fails this — nothing is warned, because
  `own.length > 0` reads the substituted built-in lane as an answer.
  */
  it("reports an already-merged card whose workflow could not be resolved", async () => {
    const parked = {
      ...shippedCard(),
      id: "FN-UNRESOLVED",
      column: RENAMED_VOCAB.review,
      status: "failed",
      mergeRetries: 99,
    } as unknown as Task;
    const tasksById = new Map([[parked.id, parked]]);
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
      listTasks: vi.fn(async (options?: { column?: string }) => {
        const all = [...tasksById.values()];
        return options?.column === undefined ? all : all.filter((t) => t.column === options.column);
      }),
      getTask: vi.fn(async (id: string) => tasksById.get(id)),
      updateTask: vi.fn(async () => undefined),
      /* The project DOES declare the renamed review lane, so the read finds the card... */
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
      /* ...but THIS card names no workflow, so its own lane vocabulary is unknown. */
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
    }) as unknown as TaskStore & EventEmitter;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let warned = "";
    try {
      await new SelfHealingManager(store, { rootDir: "/repo" }).recoverAlreadyMergedReviewTasks();
      warned = warn.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(warned).toContain("already-merged review rescue");
    expect(warned).toContain("FN-UNRESOLVED");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-19:20 (the query-filter class, third sweep):
  `recoverStuckMergeDeadlocks` reads FOUR lanes: the review lane for its candidates, and intake/hold/wip
  for the DEPENDENTS whose blocked state proves the deadlock. All four were literals, so on a renamed
  board the sweep saw no candidates AND no dependents — doubly blind.

  Its 2026-07-29-17:40 note reasoned the literal `triage`/`todo` pair was a complete union "and the role
  filter below decides which rows count". That held for the default and legacy lineages it considered and
  fails on a renamed board, where the reads return nothing and the filter is handed nothing to decide
  about. Widening the reads restores the property that note relied on; the filter itself is untouched.

  REVERT CHECK, measured: restoring the literal review read fails this — the board's own review lane is
  never asked for.
  */
  it("the merge-deadlock recovery asks for the board's OWN review and dependent lanes", async () => {
    const parked = {
      ...shippedCard(),
      id: "FN-DEADLOCK",
      column: RENAMED_VOCAB.review,
      status: "failed",
      mergeRetries: 99,
      worktree: "/tmp/wt",
    } as unknown as Task;
    const { store, listTasks } = productionFaithfulStore([parked]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverStuckMergeDeadlocks();

    /* Candidates: the board's own review lane, plus the legacy id the union keeps reachable. */
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.review }));
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: "in-review" }));
    /* Dependents: the board's own pre-WIP and WIP lanes, not just `triage`/`todo`/`in-progress`. */
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.hold }));
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.wip }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-19:50 (the query-filter class, fourth sweep):
  `recoverInterruptedMergingTasks` rescues a task interrupted mid-merge — status still `merging`, no live
  session behind it. Its read was the literal review lane, so on a renamed board that task sat in
  `merging` indefinitely.

  Also asserts the LOG, because the old message hardcoded "in in-review" and would have reported a lane
  the sweep did not search. A message that names the wrong board is its own small lie.

  REVERT CHECK, measured: restoring the literal read fails this — the board's own review lane is never
  asked for.
  */
  it("the interrupted-merge recovery asks for the board's OWN review lane and names it", async () => {
    const stuck = {
      ...shippedCard(),
      id: "FN-MERGING",
      column: RENAMED_VOCAB.review,
      status: "merging",
      updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    } as unknown as Task;
    const { store, listTasks } = productionFaithfulStore([stuck]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      globalPause: false,
      enginePaused: false,
      taskStuckTimeoutMs: 60_000,
    } as Settings);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverInterruptedMergingTasks();

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.review }));
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: "in-review" }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-20:20 (the query-filter class, fifth sweep):
  `recoverMergeableReviewTasks` re-enqueues a card that is genuinely ready to merge. Its read was the
  literal review lane, so on a renamed board that card sat in review forever.

  THE INTERESTING PART IS DOWNSTREAM. This sweep's filter calls `getTaskMergeBlocker(t)` — previously
  UNWIRED, taking the legacy `in-review` default, and harmless only because the literal query meant a
  renamed board never reached it. Widening the read makes that guard REACHABLE for the first time, so
  left as-is it would refuse every card on exactly the boards this fix is for: found, then declined.

  Converting a query activates every guard downstream of it. This case asserts the end-to-end outcome —
  the card is enqueued — precisely because a query-only assertion would have passed while the blocker
  silently rejected it.

  REVERT CHECK, measured: dropping `{ reviewColumns }` from the blocker call fails this — the card is
  found by the widened read and then refused.
  */
  it("enqueues a mergeable card on a RENAMED board, past the now-reachable merge blocker", async () => {
    const ready = {
      ...shippedCard(),
      id: "FN-READY",
      column: RENAMED_VOCAB.review,
      status: null,
      worktree: "/tmp/wt",
      steps: [],
      mergeDetails: {},
    } as unknown as Task;
    const { store } = productionFaithfulStore([ready]);
    const enqueueMerge = vi.fn(async () => undefined);
    /* Complete the fake: the recovery loop logs before enqueuing, and an incomplete fake turns a real
       enqueue into a caught error the assertion cannot see. */
    Object.assign(store, {
      enqueueMerge,
      isMergeLaneOwned: vi.fn(async () => false),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    });

    await new SelfHealingManager(store, { rootDir: "/repo", enqueueMerge } as never)
      .recoverMergeableReviewTasks();

    /* Not just "the query asked" — the card survived the blocker and was acted on. */
    expect(enqueueMerge).toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:20 (the query-filter class, sixth sweep — activation check
  run FIRST this time):
  `recoverReviewTasksWithFailedPreMergeSteps` auto-revives a card parked with a FAILED pre-merge review
  step. Its literal read meant that card stayed parked on a renamed board until a human noticed.

  This sweep is the sharpest example of part 5 of the shape. Its filter asks
  `blocker !== "task has failed pre-merge workflow steps"` — an EXACT STRING match. Unwired on a renamed
  board the blocker returns "task is in 'checking', must be in 'in-review'" instead, so widening the query
  alone would have made the sweep find every card and then reject every card.

  Asserts the END-TO-END outcome (the recover callback fires), not the query, precisely because a
  query-only assertion passes while the blocker silently rejects.

  REVERT CHECK, measured (each independently):
    - literal read restored        -> fails, the card is never found
    - { reviewColumns } dropped    -> fails, the card is found and then rejected by the string compare
  */
  it("revives a failed-pre-merge-step card on a RENAMED board, past the now-reachable blocker", async () => {
    const parked = {
      ...shippedCard(),
      id: "FN-FAILEDSTEP",
      column: RENAMED_VOCAB.review,
      status: null,
      worktree: "/tmp/wt",
      steps: [],
      mergeDetails: {},
      workflowStepResults: [
        { phase: "pre-merge", source: "optional-group", status: "failed",
          workflowStepId: "code-review", workflowStepName: "Code Review",
          completedAt: new Date().toISOString() },
      ],
    } as unknown as Task;
    const { store } = productionFaithfulStore([parked]);
    Object.assign(store, { logEntry: vi.fn(async () => undefined) });
    const recoverFailedPreMergeStep = vi.fn(async () => true);

    await new SelfHealingManager(store, { rootDir: "/repo", recoverFailedPreMergeStep } as never)
      .recoverReviewTasksWithFailedPreMergeSteps();

    expect(recoverFailedPreMergeStep).toHaveBeenCalled();
  });
});
